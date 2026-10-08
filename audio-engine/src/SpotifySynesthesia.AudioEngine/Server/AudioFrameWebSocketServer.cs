using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Channels;
using SpotifySynesthesia.AudioEngine.Analysis;
using SpotifySynesthesia.AudioEngine.Spotify;

namespace SpotifySynesthesia.AudioEngine.Server;

public sealed class AudioFrameWebSocketServer : IAsyncDisposable
{
    private const int MaxAdmittedWebSockets = 32;
    private const string AuthenticationCloseDescription = "Authentication failed";
    private const WebSocketCloseStatus AuthenticationCloseStatus =
        (WebSocketCloseStatus)CompanionConnectionProtocol.AuthenticationCloseCode;

    private static readonly TimeSpan CloseTimeout = TimeSpan.FromSeconds(1);
    private static readonly TimeSpan SendTimeout = TimeSpan.FromSeconds(1);
    private static readonly TimeSpan ShutdownTimeout = TimeSpan.FromSeconds(3);
    private static readonly TimeSpan LeaseCheckInterval = TimeSpan.FromMilliseconds(250);

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter() },
    };

    // Connection-protocol numbers must be real JSON numbers; the web default would also accept quoted numbers.
    private static readonly JsonSerializerOptions ConnectionJsonOptions = new(JsonSerializerDefaults.Web)
    {
        NumberHandling = JsonNumberHandling.Strict,
    };

    private readonly AudioFrameWebSocketServerOptions _options;
    private readonly CompanionSessionManager _sessions;
    private readonly ConcurrentDictionary<Guid, StreamClient<AudioFrame>> _clients = new();
    private readonly ConcurrentDictionary<Guid, StreamClient<SongContextSnapshot>> _songContextClients = new();
    private readonly ConcurrentDictionary<Task, byte> _handlers = new();
    private readonly ConcurrentDictionary<WebSocket, byte> _openSockets = new();
    private readonly SemaphoreSlim _lifecycleGate = new(initialCount: 1, maxCount: 1);

    private HttpListener? _listener;
    private CancellationTokenSource? _serverCancellation;
    private Task? _acceptTask;
    private SongContextSnapshot? _latestSongContext;
    private Func<SongContextCommand, CancellationToken, Task>? _songContextCommandHandler;
    private Func<SpotifyAuthorizationCallback, CancellationToken, Task<SpotifyAuthorizationCallbackResult>>?
        _spotifyCallbackHandler;
    private long _framesPublished;
    private int _admittedSockets;
    private bool _disposed;

    public AudioFrameWebSocketServer(
        AudioFrameWebSocketServerOptions? options = null,
        CompanionSessionManager? sessions = null)
    {
        _options = options ?? new AudioFrameWebSocketServerOptions();
        _sessions = sessions ?? new(_options.OriginPolicy);
    }

    public AudioFrameWebSocketServerOptions Options => _options;

    public CompanionSessionManager Sessions => _sessions;

    public bool IsRunning => _listener?.IsListening == true;

    public int ConnectedClientCount => _clients.Count;

    public int ConnectedSongContextClientCount => _songContextClients.Count;

    public long FramesPublished => Interlocked.Read(ref _framesPublished);

    public bool IsSpotifyCallbackAvailable => IsRunning && Volatile.Read(ref _spotifyCallbackHandler) is not null;

    public void ConfigureSongContextHandlers(
        Func<SongContextCommand, CancellationToken, Task> commandHandler,
        Func<SpotifyAuthorizationCallback, CancellationToken, Task<SpotifyAuthorizationCallbackResult>>
            spotifyCallbackHandler)
    {
        ArgumentNullException.ThrowIfNull(commandHandler);
        ArgumentNullException.ThrowIfNull(spotifyCallbackHandler);
        Volatile.Write(ref _songContextCommandHandler, commandHandler);
        Volatile.Write(ref _spotifyCallbackHandler, spotifyCallbackHandler);
    }

    public void ClearSongContextHandlers()
    {
        Volatile.Write(ref _songContextCommandHandler, null);
        Volatile.Write(ref _spotifyCallbackHandler, null);
    }

    public void PublishSongContext(SongContextSnapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(snapshot);
        Volatile.Write(ref _latestSongContext, snapshot);
        if (!IsRunning)
        {
            return;
        }

        foreach (StreamClient<SongContextSnapshot> client in _songContextClients.Values)
        {
            client.TryPublish(snapshot);
        }
    }

    public async Task StartAsync(CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);

        await _lifecycleGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (IsRunning)
            {
                return;
            }

            HttpListener listener = new();
            listener.Prefixes.Add(_options.HttpPrefix);

            try
            {
                listener.Start();
            }
            catch
            {
                listener.Close();
                throw;
            }

            _listener = listener;
            _serverCancellation = new CancellationTokenSource();
            _acceptTask = AcceptLoopAsync(listener, _serverCancellation.Token);
        }
        finally
        {
            _lifecycleGate.Release();
        }
    }

    public void Publish(AudioFrame frame)
    {
        ArgumentNullException.ThrowIfNull(frame);

        if (!IsRunning)
        {
            return;
        }

        Interlocked.Increment(ref _framesPublished);
        foreach (StreamClient<AudioFrame> client in _clients.Values)
        {
            client.TryPublish(frame);
        }
    }

    public async Task StopAsync(CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);

        await _lifecycleGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await StopCoreAsync(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            _lifecycleGate.Release();
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return;
        }

        await _lifecycleGate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (_disposed)
            {
                return;
            }

            await StopCoreAsync(CancellationToken.None).ConfigureAwait(false);
            _disposed = true;
        }
        finally
        {
            _lifecycleGate.Release();
        }

        GC.SuppressFinalize(this);
    }

    private async Task AcceptLoopAsync(HttpListener listener, CancellationToken cancellationToken)
    {
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                HttpListenerContext context = await listener
                    .GetContextAsync()
                    .WaitAsync(cancellationToken)
                    .ConfigureAwait(false);
                TrackHandler(HandleContextAsync(context, cancellationToken));
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (HttpListenerException) when (cancellationToken.IsCancellationRequested || !listener.IsListening)
        {
        }
    }

    private void TrackHandler(Task handler)
    {
        // Stop waits on every in-flight request, including sockets that are still pending authentication.
        _handlers.TryAdd(handler, 0);
        _ = handler.ContinueWith(
            static (completed, state) => ((ConcurrentDictionary<Task, byte>)state!).TryRemove(completed, out _),
            _handlers,
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);
    }

    private async Task HandleContextAsync(HttpListenerContext context, CancellationToken cancellationToken)
    {
        try
        {
            string path = context.Request.Url?.AbsolutePath.TrimEnd('/') ?? string.Empty;

            if (string.Equals(path, "/health", StringComparison.OrdinalIgnoreCase))
            {
                await WriteHealthResponseAsync(context.Response, cancellationToken).ConfigureAwait(false);
                return;
            }

            if (string.Equals(path, "/spotify/callback", StringComparison.Ordinal))
            {
                await HandleSpotifyCallbackAsync(context, cancellationToken).ConfigureAwait(false);
                return;
            }

            if (context.Request.IsWebSocketRequest && TryGetSocketEndpoint(path, out SocketEndpoint endpoint))
            {
                await HandleWebSocketRequestAsync(context, endpoint, cancellationToken).ConfigureAwait(false);
                return;
            }

            if (await TryWriteStaticResponseAsync(context, cancellationToken).ConfigureAwait(false))
            {
                return;
            }

            context.Response.StatusCode = (int)HttpStatusCode.NotFound;
            context.Response.Close();
        }
        catch (Exception exception) when (
            exception is HttpListenerException or WebSocketException or OperationCanceledException or
                ObjectDisposedException or InvalidOperationException)
        {
            context.Response.Abort();
        }
    }

    private async Task HandleSpotifyCallbackAsync(
        HttpListenerContext context,
        CancellationToken cancellationToken)
    {
        Func<SpotifyAuthorizationCallback, CancellationToken, Task<SpotifyAuthorizationCallbackResult>>? handler =
            Volatile.Read(ref _spotifyCallbackHandler);
        if (handler is null || !string.Equals(context.Request.HttpMethod, "GET", StringComparison.Ordinal))
        {
            context.Response.StatusCode = (int)HttpStatusCode.ServiceUnavailable;
            context.Response.Close();
            return;
        }

        SpotifyAuthorizationCallback callback = new(
            context.Request.QueryString["code"],
            context.Request.QueryString["state"],
            context.Request.QueryString["error"],
            context.Request.QueryString["error_description"]);
        SpotifyAuthorizationCallbackResult result = await handler(callback, cancellationToken).ConfigureAwait(false);
        string safeMessage = WebUtility.HtmlEncode(result.Message);
        string html = $"""
            <!doctype html><html lang="en"><head><meta charset="utf-8"><title>Spotify Synesthesia</title></head>
            <body style="font-family:Segoe UI,sans-serif;background:#111;color:#eee;padding:3rem">
            <h1>{(result.Success ? "Spotify connected" : "Spotify connection failed")}</h1><p>{safeMessage}</p></body></html>
            """;
        byte[] payload = Encoding.UTF8.GetBytes(html);
        context.Response.StatusCode = result.Success ? (int)HttpStatusCode.OK : (int)HttpStatusCode.BadRequest;
        context.Response.ContentType = "text/html; charset=utf-8";
        context.Response.ContentLength64 = payload.Length;
        await context.Response.OutputStream.WriteAsync(payload, cancellationToken).ConfigureAwait(false);
        context.Response.Close();
    }

    private bool TryGetSocketEndpoint(string path, out SocketEndpoint endpoint)
    {
        if (string.Equals(path, SongContextProtocol.Path, StringComparison.Ordinal))
        {
            endpoint = SocketEndpoint.SongContext;
            return true;
        }

        if (string.Equals(path, CompanionConnectionProtocol.PairingPath, StringComparison.Ordinal))
        {
            endpoint = SocketEndpoint.Pairing;
            return true;
        }

        endpoint = SocketEndpoint.Audio;
        return string.Equals(path, _options.Path, StringComparison.Ordinal);
    }

    private async Task HandleWebSocketRequestAsync(
        HttpListenerContext context,
        SocketEndpoint endpoint,
        CancellationToken cancellationToken)
    {
        // Denied upgrades are refused before any socket, session, or rate-limit state is allocated.
        if (!TryAuthorizeUpgrade(context.Request, endpoint, out string? origin))
        {
            RejectUpgrade(context.Response, HttpStatusCode.Forbidden);
            return;
        }

        if (Interlocked.Increment(ref _admittedSockets) > MaxAdmittedWebSockets)
        {
            Interlocked.Decrement(ref _admittedSockets);
            RejectUpgrade(context.Response, HttpStatusCode.TooManyRequests);
            return;
        }

        WebSocket? socket = null;
        try
        {
            HttpListenerWebSocketContext webSocketContext = await context
                .AcceptWebSocketAsync(subProtocol: null)
                .ConfigureAwait(false);
            long acceptedTimestamp = Stopwatch.GetTimestamp();
            socket = webSocketContext.WebSocket;
            _openSockets[socket] = 0;

            if (origin is null)
            {
                await RunStreamAsync(socket, endpoint, sessionId: null, cancellationToken).ConfigureAwait(false);
            }
            else if (endpoint == SocketEndpoint.Pairing)
            {
                await HandlePairingAsync(socket, origin, acceptedTimestamp, cancellationToken).ConfigureAwait(false);
            }
            else
            {
                await RunAuthenticatedStreamAsync(socket, endpoint, origin, acceptedTimestamp, cancellationToken)
                    .ConfigureAwait(false);
            }
        }
        finally
        {
            if (socket is not null)
            {
                _openSockets.TryRemove(socket, out _);
                socket.Dispose();
            }

            Interlocked.Decrement(ref _admittedSockets);
        }
    }

    // The origin comes only from the upgrade header. A null origin means an admitted native diagnostic client.
    private bool TryAuthorizeUpgrade(HttpListenerRequest request, SocketEndpoint endpoint, out string? origin)
    {
        origin = null;
        if (!string.IsNullOrEmpty(request.Url?.Query))
        {
            return false;
        }

        if (request.Headers["Origin"] is null)
        {
            return endpoint != SocketEndpoint.Pairing &&
                _options.NativeDiagnostics == NativeDiagnosticPolicy.AllowUnauthenticatedLoopbackDiagnostics &&
                IsLoopbackPeer(request.RemoteEndPoint);
        }

        string[]? origins = request.Headers.GetValues("Origin");
        if (origins is not [string single] || !_options.OriginPolicy.IsAllowed(single))
        {
            return false;
        }

        origin = single;
        return true;
    }

    private static bool IsLoopbackPeer(IPEndPoint? remote)
    {
        if (remote is null)
        {
            return false;
        }

        IPAddress address = remote.Address.IsIPv4MappedToIPv6 ? remote.Address.MapToIPv4() : remote.Address;
        return IPAddress.IsLoopback(address);
    }

    private static void RejectUpgrade(HttpListenerResponse response, HttpStatusCode status)
    {
        response.StatusCode = (int)status;
        response.Close();
    }

    private async Task HandlePairingAsync(
        WebSocket socket,
        string origin,
        long acceptedTimestamp,
        CancellationToken cancellationToken)
    {
        (CompanionConnectionRequest? request, Task pendingRead) = await ReceiveInitialRequestAsync(
            socket,
            acceptedTimestamp,
            cancellationToken).ConfigureAwait(false);
        CompanionConnectionResponse? response = request is null || cancellationToken.IsCancellationRequested
            ? null
            : ExecutePairingRequest(request, origin);
        if (response is null)
        {
            await FailAuthenticationAsync(socket, pendingRead).ConfigureAwait(false);
            return;
        }

        if (await SendControlAsync(socket, response).ConfigureAwait(false))
        {
            await CloseOutputBoundedAsync(socket, WebSocketCloseStatus.NormalClosure, "Done").ConfigureAwait(false);
            await AwaitPeerCloseAsync(socket, pendingRead).ConfigureAwait(false);
        }
    }

    private CompanionConnectionResponse? ExecutePairingRequest(CompanionConnectionRequest request, string origin) =>
        request switch
        {
            { Type: CompanionConnectionProtocol.PairMessageType, Code: { } code, Token: null } =>
                _sessions.TryPair(code, origin, out CompanionCredential? paired) && paired is not null
                    ? CreateCredentialResponse(CompanionConnectionProtocol.PairedMessageType, paired)
                    : null,
            { Type: CompanionConnectionProtocol.RenewMessageType, Code: null, Token: { } token } =>
                _sessions.Renew(token, origin) is { } renewed
                    ? CreateCredentialResponse(CompanionConnectionProtocol.RenewedMessageType, renewed)
                    : null,
            { Type: CompanionConnectionProtocol.DisconnectMessageType, Code: null, Token: { } token } =>
                _sessions.Revoke(token, origin)
                    ? new CompanionConnectionResponse { Type = CompanionConnectionProtocol.DisconnectedMessageType }
                    : null,
            _ => null,
        };

    private static CompanionConnectionResponse CreateCredentialResponse(string type, CompanionCredential credential) =>
        new()
        {
            Type = type,
            Token = credential.Token,
            ExpiresAtUtc = credential.ExpiresAtUtc,
        };

    private async Task RunAuthenticatedStreamAsync(
        WebSocket socket,
        SocketEndpoint endpoint,
        string origin,
        long acceptedTimestamp,
        CancellationToken cancellationToken)
    {
        (CompanionConnectionRequest? request, Task pendingRead) = await ReceiveInitialRequestAsync(
            socket,
            acceptedTimestamp,
            cancellationToken).ConfigureAwait(false);
        if (request is not { Type: CompanionConnectionProtocol.AuthenticateMessageType, Code: null, Token: { } token } ||
            !_sessions.TryAuthenticate(token, origin, out Guid sessionId) ||
            !_sessions.TryGetSessionLease(sessionId, out DateTimeOffset expiresAtUtc) ||
            cancellationToken.IsCancellationRequested)
        {
            await FailAuthenticationAsync(socket, pendingRead).ConfigureAwait(false);
            return;
        }

        // The acknowledgement carries only the expiry and is sent before registration, so it precedes any payload.
        CompanionConnectionResponse acknowledgement = new()
        {
            Type = CompanionConnectionProtocol.AuthenticatedMessageType,
            ExpiresAtUtc = expiresAtUtc,
        };
        if (await SendControlAsync(socket, acknowledgement).ConfigureAwait(false))
        {
            await RunStreamAsync(socket, endpoint, sessionId, cancellationToken).ConfigureAwait(false);
        }
    }

    private Task RunStreamAsync(
        WebSocket socket,
        SocketEndpoint endpoint,
        Guid? sessionId,
        CancellationToken cancellationToken) =>
        endpoint == SocketEndpoint.Audio
            ? RunAudioClientAsync(socket, sessionId, cancellationToken)
            : RunSongContextClientAsync(socket, sessionId, cancellationToken);

    private async Task RunAudioClientAsync(WebSocket socket, Guid? sessionId, CancellationToken cancellationToken)
    {
        using StreamClient<AudioFrame> client = new(
            socket,
            capacity: 2,
            SerializeAudioFrame,
            commandHandler: null,
            sessionId,
            _sessions);
        await RunRegisteredAsync(_clients, client, static () => null, cancellationToken).ConfigureAwait(false);
    }

    private async Task RunSongContextClientAsync(WebSocket socket, Guid? sessionId, CancellationToken cancellationToken)
    {
        using StreamClient<SongContextSnapshot> client = new(
            socket,
            capacity: 1,
            SerializeSongContext,
            command => HandleSongContextCommandAsync(command, cancellationToken),
            sessionId,
            _sessions);
        await RunRegisteredAsync(
            _songContextClients,
            client,
            () => Volatile.Read(ref _latestSongContext),
            cancellationToken).ConfigureAwait(false);
    }

    private static async Task RunRegisteredAsync<T>(
        ConcurrentDictionary<Guid, StreamClient<T>> registry,
        StreamClient<T> client,
        Func<T?> readReplay,
        CancellationToken cancellationToken)
        where T : class
    {
        Guid clientId = Guid.NewGuid();
        registry[clientId] = client;
        try
        {
            // Read the replay only after registering so a concurrent publication is never lost.
            if (readReplay() is { } replay)
            {
                client.TryPublish(replay);
            }

            await client.RunAsync(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            registry.TryRemove(clientId, out _);
        }
    }

    private static byte[] SerializeAudioFrame(AudioFrame frame) =>
        JsonSerializer.SerializeToUtf8Bytes(AudioFrameMessage.Create(frame), JsonOptions);

    private static byte[] SerializeSongContext(SongContextSnapshot snapshot) =>
        JsonSerializer.SerializeToUtf8Bytes(SongContextMessage.Create(snapshot), SongContextJson.Options);

    // The deadline races the read instead of cancelling it, because a cancelled receive aborts the socket
    // and would prevent the 4401 close from being sent.
    private static async Task<(CompanionConnectionRequest? Request, Task PendingRead)> ReceiveInitialRequestAsync(
        WebSocket socket,
        long acceptedTimestamp,
        CancellationToken cancellationToken)
    {
        byte[] buffer = new byte[CompanionConnectionProtocol.MaxInitialMessageBytes + 1];
        Task<int> read = ReadInitialMessageAsync(socket, buffer);
        int count = -1;
        TimeSpan remaining =
            CompanionConnectionProtocol.InitialAuthenticationTimeout - Stopwatch.GetElapsedTime(acceptedTimestamp);
        if (remaining > TimeSpan.Zero)
        {
            try
            {
                count = await read.WaitAsync(remaining, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception exception) when (exception is TimeoutException or OperationCanceledException)
            {
            }
        }

        if (count <= 0)
        {
            return (null, read);
        }

        try
        {
            return (ParseRequest(buffer.AsSpan(0, count)), read);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(buffer);
        }
    }

    // Returns the byte count of one complete text message within the limit, or -1 for any other outcome.
    private static async Task<int> ReadInitialMessageAsync(WebSocket socket, byte[] buffer)
    {
        int count = 0;
        try
        {
            while (true)
            {
                ValueWebSocketReceiveResult result = await socket
                    .ReceiveAsync(buffer.AsMemory(count), CancellationToken.None)
                    .ConfigureAwait(false);
                count += result.Count;
                if (result.MessageType != WebSocketMessageType.Text ||
                    count > CompanionConnectionProtocol.MaxInitialMessageBytes)
                {
                    return -1;
                }

                if (result.EndOfMessage)
                {
                    return count;
                }
            }
        }
        catch (Exception exception) when (IsSocketTermination(exception))
        {
            return -1;
        }
    }

    private static CompanionConnectionRequest? ParseRequest(ReadOnlySpan<byte> utf8)
    {
        try
        {
            CompanionConnectionRequest? request =
                JsonSerializer.Deserialize<CompanionConnectionRequest>(utf8, ConnectionJsonOptions);
            return request is { ProtocolVersion: CompanionConnectionProtocol.CurrentVersion } ? request : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static async Task FailAuthenticationAsync(WebSocket socket, Task pendingRead)
    {
        // Deliberately generic: no reason, request echo, or secret is ever returned to the peer.
        await SendControlAsync(
            socket,
            new CompanionConnectionResponse { Type = CompanionConnectionProtocol.AuthenticationFailedMessageType })
            .ConfigureAwait(false);
        await CloseOutputBoundedAsync(socket, AuthenticationCloseStatus, AuthenticationCloseDescription)
            .ConfigureAwait(false);
        await AwaitPeerCloseAsync(socket, pendingRead).ConfigureAwait(false);
    }

    private static async Task<bool> SendControlAsync(WebSocket socket, CompanionConnectionResponse response)
    {
        if (socket.State is not (WebSocketState.Open or WebSocketState.CloseReceived))
        {
            return false;
        }

        byte[] payload = JsonSerializer.SerializeToUtf8Bytes(response, ConnectionJsonOptions);
        using CancellationTokenSource timeout = new(CloseTimeout);
        try
        {
            await socket.SendAsync(payload, WebSocketMessageType.Text, endOfMessage: true, timeout.Token)
                .ConfigureAwait(false);
            return true;
        }
        catch (Exception exception) when (IsSocketTermination(exception))
        {
            socket.Abort();
            return false;
        }
        finally
        {
            CryptographicOperations.ZeroMemory(payload);
        }
    }

    private static async Task CloseOutputBoundedAsync(
        WebSocket socket,
        WebSocketCloseStatus status,
        string description)
    {
        if (socket.State is not (WebSocketState.Open or WebSocketState.CloseReceived))
        {
            return;
        }

        using CancellationTokenSource timeout = new(CloseTimeout);
        try
        {
            await socket.CloseOutputAsync(status, description, timeout.Token).ConfigureAwait(false);
        }
        catch (Exception exception) when (IsSocketTermination(exception))
        {
            socket.Abort();
        }
    }

    // Drains briefly until the peer acknowledges the close so unread input does not turn the close into a reset.
    private static async Task AwaitPeerCloseAsync(WebSocket socket, Task pendingRead)
    {
        using CancellationTokenSource timeout = new(CloseTimeout);
        try
        {
            await pendingRead.WaitAsync(timeout.Token).ConfigureAwait(false);
            byte[] discard = new byte[256];
            while (socket.State == WebSocketState.CloseSent)
            {
                _ = await socket.ReceiveAsync(discard.AsMemory(), timeout.Token).ConfigureAwait(false);
            }
        }
        catch (Exception exception) when (IsSocketTermination(exception))
        {
            socket.Abort();
        }
    }

    private static string DescribeClose(WebSocketCloseStatus status) => status switch
    {
        AuthenticationCloseStatus => AuthenticationCloseDescription,
        WebSocketCloseStatus.MessageTooBig => "Command is too large",
        _ => "Connection closed",
    };

    private static bool IsSocketTermination(Exception exception) =>
        exception is WebSocketException or OperationCanceledException or ObjectDisposedException or
            TimeoutException or HttpListenerException;

    private async Task HandleSongContextCommandAsync(
        SongContextCommand command,
        CancellationToken cancellationToken)
    {
        if (!command.IsValid)
        {
            return;
        }

        Func<SongContextCommand, CancellationToken, Task>? handler = Volatile.Read(ref _songContextCommandHandler);
        if (handler is not null)
        {
            await handler(command, cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task WriteHealthResponseAsync(
        HttpListenerResponse response,
        CancellationToken cancellationToken)
    {
        AudioServerHealth health = new(
            AudioFrameProtocol.CurrentVersion,
            ConnectedClientCount,
            FramesPublished,
            IsRunning ? "running" : "stopped");
        byte[] payload = JsonSerializer.SerializeToUtf8Bytes(health, JsonOptions);

        response.StatusCode = (int)HttpStatusCode.OK;
        response.ContentType = "application/json; charset=utf-8";
        response.ContentEncoding = Encoding.UTF8;
        response.ContentLength64 = payload.Length;
        await response.OutputStream.WriteAsync(payload, cancellationToken).ConfigureAwait(false);
        response.Close();
    }

    private async Task<bool> TryWriteStaticResponseAsync(
        HttpListenerContext context,
        CancellationToken cancellationToken)
    {
        string? contentRoot = _options.StaticContentPath;
        if (contentRoot is null || context.Request.HttpMethod is not ("GET" or "HEAD"))
        {
            return false;
        }

        string requestPath = context.Request.Url?.AbsolutePath ?? "/";
        string relativePath = requestPath == "/"
            ? "index.html"
            : Uri.UnescapeDataString(requestPath.TrimStart('/')).Replace('/', Path.DirectorySeparatorChar);
        string root = Path.GetFullPath(contentRoot);
        string candidate = Path.GetFullPath(Path.Combine(root, relativePath));
        string rootPrefix = root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;

        if (!candidate.StartsWith(rootPrefix, StringComparison.OrdinalIgnoreCase) || !File.Exists(candidate))
        {
            return false;
        }

        FileInfo file = new(candidate);
        HttpListenerResponse response = context.Response;
        response.StatusCode = (int)HttpStatusCode.OK;
        response.ContentType = GetContentType(file.Extension);
        response.ContentLength64 = file.Length;
        response.Headers[HttpResponseHeader.CacheControl] = file.Name.Equals("index.html", StringComparison.OrdinalIgnoreCase)
            ? "no-cache"
            : "public, max-age=31536000, immutable";

        if (context.Request.HttpMethod == "GET")
        {
            await using FileStream input = file.OpenRead();
            await input.CopyToAsync(response.OutputStream, cancellationToken).ConfigureAwait(false);
        }

        response.Close();
        return true;
    }

    private static string GetContentType(string extension) => extension.ToLowerInvariant() switch
    {
        ".html" => "text/html; charset=utf-8",
        ".js" => "text/javascript; charset=utf-8",
        ".css" => "text/css; charset=utf-8",
        ".json" => "application/json; charset=utf-8",
        ".png" => "image/png",
        ".jpg" or ".jpeg" => "image/jpeg",
        ".webp" => "image/webp",
        ".svg" => "image/svg+xml",
        ".woff" => "font/woff",
        ".woff2" => "font/woff2",
        _ => "application/octet-stream",
    };

    private async Task StopCoreAsync(CancellationToken cancellationToken)
    {
        HttpListener? listener = _listener;
        CancellationTokenSource? serverCancellation = _serverCancellation;
        Task? acceptTask = _acceptTask;

        if (listener is null)
        {
            return;
        }

        // Cancelling first asks live streams to close and fails pending authentication; a restart revokes every session.
        serverCancellation?.Cancel();
        _sessions.RevokeAll();
        listener.Stop();

        try
        {
            if (acceptTask is not null)
            {
                await acceptTask.WaitAsync(cancellationToken).ConfigureAwait(false);
            }

            await WaitForHandlersAsync(ShutdownTimeout, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            // Anything still open after the graceful window is aborted so an unresponsive peer cannot hold Stop.
            AbortOpenSockets();
            await WaitForHandlersAsync(CloseTimeout, CancellationToken.None).ConfigureAwait(false);
            _clients.Clear();
            _songContextClients.Clear();
            listener.Close();
            serverCancellation?.Dispose();
            _listener = null;
            _serverCancellation = null;
            _acceptTask = null;
        }
    }

    private async Task WaitForHandlersAsync(TimeSpan timeout, CancellationToken cancellationToken)
    {
        Task[] handlers = [.. _handlers.Keys];
        if (handlers.Length > 0)
        {
            // WhenAny never rethrows, so a slow or faulted handler cannot leave teardown half done.
            await Task.WhenAny(Task.WhenAll(handlers), Task.Delay(timeout, cancellationToken)).ConfigureAwait(false);
        }

        cancellationToken.ThrowIfCancellationRequested();
    }

    private void AbortOpenSockets()
    {
        foreach (StreamClient<AudioFrame> client in _clients.Values)
        {
            client.Abort();
        }

        foreach (StreamClient<SongContextSnapshot> client in _songContextClients.Values)
        {
            client.Abort();
        }

        foreach (WebSocket socket in _openSockets.Keys)
        {
            try
            {
                socket.Abort();
            }
            catch (ObjectDisposedException)
            {
                // The owning handler finished disposal while shutdown was iterating.
            }
        }
    }

    private enum SocketEndpoint
    {
        Audio,
        SongContext,
        Pairing,
    }

    // The send loop is the only writer after admission: lease loss, peer close, and shutdown all complete the
    // channel, and the close frame is sent only after the send loop has stopped. Each payload send has its own
    // deadline; a peer that stops reading has its transport aborted rather than holding the writer and its admission.
    internal sealed class StreamClient<T> : IDisposable
        where T : class
    {
        private const int MaximumCommandBytes = 8 * 1024;
        private readonly WebSocket _webSocket;
        private readonly Func<T, byte[]> _serialize;
        private readonly Func<SongContextCommand, Task>? _commandHandler;
        private readonly Guid? _sessionId;
        private readonly CompanionSessionManager _sessions;
        private readonly Channel<T> _messages;
        private readonly CancellationTokenSource _abort = new();
        private int _closeStatus;

        public StreamClient(
            WebSocket webSocket,
            int capacity,
            Func<T, byte[]> serialize,
            Func<SongContextCommand, Task>? commandHandler,
            Guid? sessionId,
            CompanionSessionManager sessions)
        {
            _webSocket = webSocket;
            _serialize = serialize;
            _commandHandler = commandHandler;
            _sessionId = sessionId;
            _sessions = sessions;
            _messages = Channel.CreateBounded<T>(
                new BoundedChannelOptions(capacity)
                {
                    FullMode = BoundedChannelFullMode.DropOldest,
                    SingleReader = true,
                    SingleWriter = false,
                });
        }

        // Called by capture and context publishers: a channel write only, never a lease check or I/O.
        public bool TryPublish(T message) => _messages.Writer.TryWrite(message);

        public void RequestStop() => Finish(WebSocketCloseStatus.NormalClosure);

        public void Abort()
        {
            RequestStop();
            try
            {
                _abort.Cancel();
            }
            catch (ObjectDisposedException)
            {
                // A disconnected client can finish disposal while server shutdown is iterating.
            }
        }

        public async Task RunAsync(CancellationToken serverCancellation)
        {
            // Registering on an already cancelled token runs immediately, so a late registration cannot outlive Stop.
            using CancellationTokenRegistration stopRegistration = serverCancellation.UnsafeRegister(
                static state => ((StreamClient<T>)state!).RequestStop(),
                this);
            CancellationToken abort = _abort.Token;
            Task receiveTask = ReceiveLoopAsync(abort);
            Task watchTask = _sessionId is null ? Task.CompletedTask : WatchLeaseAsync(abort);
            try
            {
                await SendLoopAsync(abort).ConfigureAwait(false);
                Finish(WebSocketCloseStatus.NormalClosure);
                WebSocketCloseStatus status = (WebSocketCloseStatus)Volatile.Read(ref _closeStatus);
                await CloseOutputBoundedAsync(_webSocket, status, DescribeClose(status)).ConfigureAwait(false);
                await Task.WhenAny(receiveTask, Task.Delay(CloseTimeout, abort)).ConfigureAwait(false);
            }
            finally
            {
                Finish(WebSocketCloseStatus.NormalClosure);
                _abort.Cancel();
                await receiveTask.ConfigureAwait(false);
                await watchTask.ConfigureAwait(false);
            }
        }

        public void Dispose()
        {
            _webSocket.Dispose();
            _abort.Dispose();
        }

        private void Finish(WebSocketCloseStatus status)
        {
            Interlocked.CompareExchange(ref _closeStatus, (int)status, 0);
            _messages.Writer.TryComplete();
        }

        private bool HasLease() =>
            _sessionId is not { } sessionId || _sessions.TryGetSessionLease(sessionId, out _);

        private async Task SendLoopAsync(CancellationToken cancellationToken)
        {
            ChannelReader<T> reader = _messages.Reader;
            try
            {
                while (await reader.WaitToReadAsync(cancellationToken).ConfigureAwait(false))
                {
                    T? latest = null;
                    while (reader.TryRead(out T? newer))
                    {
                        latest = newer;
                    }

                    // Close, revocation, and expiry win over queued publications, which are dropped rather than sent.
                    if (latest is null || Volatile.Read(ref _closeStatus) != 0)
                    {
                        continue;
                    }

                    if (!HasLease())
                    {
                        Finish(AuthenticationCloseStatus);
                        return;
                    }

                    byte[] payload = _serialize(latest);
                    using CancellationTokenSource deadline =
                        CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                    deadline.CancelAfter(SendTimeout);
                    try
                    {
                        await _webSocket
                            .SendAsync(payload, WebSocketMessageType.Text, endOfMessage: true, deadline.Token)
                            .ConfigureAwait(false);
                    }
                    catch (Exception exception) when (
                        deadline.IsCancellationRequested &&
                        !cancellationToken.IsCancellationRequested &&
                        IsSocketTermination(exception))
                    {
                        // A missed deadline ends the transport, not the session; the stalled peer could not read a close.
                        _webSocket.Abort();
                        return;
                    }
                }
            }
            catch (Exception exception) when (IsSocketTermination(exception))
            {
            }
        }

        private async Task ReceiveLoopAsync(CancellationToken cancellationToken)
        {
            byte[] buffer = new byte[2048];
            using MemoryStream message = new();
            try
            {
                // Keep reading after a close is sent so the peer's close reply is observed rather than reset.
                while (_webSocket.State is WebSocketState.Open or WebSocketState.CloseSent)
                {
                    message.SetLength(0);
                    ValueWebSocketReceiveResult result;
                    do
                    {
                        result = await _webSocket.ReceiveAsync(buffer.AsMemory(), cancellationToken).ConfigureAwait(false);
                        if (result.MessageType == WebSocketMessageType.Close)
                        {
                            return;
                        }

                        if (_commandHandler is not null)
                        {
                            if (message.Length + result.Count > MaximumCommandBytes)
                            {
                                Finish(WebSocketCloseStatus.MessageTooBig);
                                return;
                            }

                            message.Write(buffer, 0, result.Count);
                        }
                    }
                    while (!result.EndOfMessage);

                    if (_commandHandler is { } handler && result.MessageType == WebSocketMessageType.Text)
                    {
                        await DispatchCommandAsync(handler, message).ConfigureAwait(false);
                    }
                }
            }
            catch (Exception exception) when (IsSocketTermination(exception))
            {
            }
            finally
            {
                Finish(WebSocketCloseStatus.NormalClosure);
            }
        }

        private async Task DispatchCommandAsync(Func<SongContextCommand, Task> handler, MemoryStream message)
        {
            // Commands after a close, revocation, or expiry never reach the handler.
            if (Volatile.Read(ref _closeStatus) != 0)
            {
                return;
            }

            if (!HasLease())
            {
                Finish(AuthenticationCloseStatus);
                return;
            }

            try
            {
                SongContextCommand? command = JsonSerializer.Deserialize<SongContextCommand>(
                    message.GetBuffer().AsSpan(0, checked((int)message.Length)),
                    SongContextJson.Options);
                if (command is not null)
                {
                    await handler(command).ConfigureAwait(false);
                }
            }
            catch (JsonException)
            {
                // Ignore malformed local commands and keep the connection alive.
            }
        }

        private async Task WatchLeaseAsync(CancellationToken cancellationToken)
        {
            using PeriodicTimer timer = new(LeaseCheckInterval);
            try
            {
                // Idle sockets have no publication to trigger the send-side check, so revocation is polled too.
                while (Volatile.Read(ref _closeStatus) == 0 &&
                    await timer.WaitForNextTickAsync(cancellationToken).ConfigureAwait(false))
                {
                    if (!HasLease())
                    {
                        Finish(AuthenticationCloseStatus);
                    }
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
            }
        }
    }
}
