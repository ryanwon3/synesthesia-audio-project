using System.Collections.Concurrent;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Channels;
using SpotifySynesthesia.AudioEngine.Analysis;
using SpotifySynesthesia.AudioEngine.Spotify;

namespace SpotifySynesthesia.AudioEngine.Server;

public sealed class AudioFrameWebSocketServer : IAsyncDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter() },
    };

    private readonly AudioFrameWebSocketServerOptions _options;
    private readonly ConcurrentDictionary<Guid, ClientSession> _clients = new();
    private readonly ConcurrentDictionary<Guid, SongContextClientSession> _songContextClients = new();
    private readonly SemaphoreSlim _lifecycleGate = new(initialCount: 1, maxCount: 1);

    private HttpListener? _listener;
    private CancellationTokenSource? _serverCancellation;
    private Task? _acceptTask;
    private SongContextSnapshot? _latestSongContext;
    private Func<SongContextCommand, CancellationToken, Task>? _songContextCommandHandler;
    private Func<SpotifyAuthorizationCallback, CancellationToken, Task<SpotifyAuthorizationCallbackResult>>?
        _spotifyCallbackHandler;
    private long _framesPublished;
    private bool _disposed;

    public AudioFrameWebSocketServer(AudioFrameWebSocketServerOptions? options = null)
    {
        _options = options ?? new AudioFrameWebSocketServerOptions();
    }

    public AudioFrameWebSocketServerOptions Options => _options;

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

        foreach (SongContextClientSession client in _songContextClients.Values)
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
        foreach (ClientSession client in _clients.Values)
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
                _ = HandleContextAsync(context, cancellationToken);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (HttpListenerException) when (cancellationToken.IsCancellationRequested || !listener.IsListening)
        {
        }
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

            if (string.Equals(path, SongContextProtocol.Path, StringComparison.Ordinal) &&
                context.Request.IsWebSocketRequest)
            {
                await HandleSongContextClientAsync(context, cancellationToken).ConfigureAwait(false);
                return;
            }

            if (await TryWriteStaticResponseAsync(context, cancellationToken).ConfigureAwait(false))
            {
                return;
            }

            if (!string.Equals(path, _options.Path, StringComparison.Ordinal) || !context.Request.IsWebSocketRequest)
            {
                context.Response.StatusCode = (int)HttpStatusCode.NotFound;
                context.Response.Close();
                return;
            }

            HttpListenerWebSocketContext webSocketContext = await context
                .AcceptWebSocketAsync(subProtocol: null)
                .ConfigureAwait(false);
            Guid clientId = Guid.NewGuid();
            ClientSession client = new(webSocketContext.WebSocket, JsonOptions);
            _clients[clientId] = client;

            try
            {
                await client.RunAsync(cancellationToken).ConfigureAwait(false);
            }
            finally
            {
                _clients.TryRemove(clientId, out _);
                await client.DisposeAsync().ConfigureAwait(false);
            }
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

    private async Task HandleSongContextClientAsync(
        HttpListenerContext context,
        CancellationToken cancellationToken)
    {
        if (!IsAllowedSongContextOrigin(context.Request.Headers["Origin"]))
        {
            context.Response.StatusCode = (int)HttpStatusCode.Forbidden;
            context.Response.Close();
            return;
        }

        HttpListenerWebSocketContext webSocketContext = await context
            .AcceptWebSocketAsync(subProtocol: null)
            .ConfigureAwait(false);
        Guid clientId = Guid.NewGuid();
        SongContextClientSession client = new(
            webSocketContext.WebSocket,
            command => HandleSongContextCommandAsync(command, cancellationToken));
        _songContextClients[clientId] = client;
        SongContextSnapshot? latest = Volatile.Read(ref _latestSongContext);
        if (latest is not null)
        {
            client.TryPublish(latest);
        }

        try
        {
            await client.RunAsync(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            _songContextClients.TryRemove(clientId, out _);
            await client.DisposeAsync().ConfigureAwait(false);
        }
    }

    private bool IsAllowedSongContextOrigin(string? origin)
    {
        if (string.IsNullOrWhiteSpace(origin))
        {
            return true;
        }

        return Uri.TryCreate(origin, UriKind.Absolute, out Uri? uri) &&
            string.Equals(uri.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase) &&
            string.Equals(uri.Host, "127.0.0.1", StringComparison.Ordinal) &&
            uri.Port == _options.Port;
    }

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

        serverCancellation?.Cancel();
        listener.Stop();

        foreach (ClientSession client in _clients.Values)
        {
            client.RequestStop();
        }

        foreach (SongContextClientSession client in _songContextClients.Values)
        {
            client.RequestStop();
        }

        if (acceptTask is not null)
        {
            await acceptTask.WaitAsync(cancellationToken).ConfigureAwait(false);
        }

        ClientSession[] remainingClients = _clients.Values.ToArray();
        foreach (ClientSession client in remainingClients)
        {
            await client.DisposeAsync().ConfigureAwait(false);
        }

        SongContextClientSession[] remainingSongClients = _songContextClients.Values.ToArray();
        foreach (SongContextClientSession client in remainingSongClients)
        {
            await client.DisposeAsync().ConfigureAwait(false);
        }

        _clients.Clear();
        _songContextClients.Clear();
        listener.Close();
        serverCancellation?.Dispose();
        _listener = null;
        _serverCancellation = null;
        _acceptTask = null;
    }

    private sealed class SongContextClientSession : IAsyncDisposable
    {
        private const int MaximumCommandBytes = 8 * 1024;
        private readonly WebSocket _webSocket;
        private readonly Func<SongContextCommand, Task> _commandHandler;
        private readonly Channel<SongContextSnapshot> _snapshots = Channel.CreateBounded<SongContextSnapshot>(
            new BoundedChannelOptions(capacity: 1)
            {
                FullMode = BoundedChannelFullMode.DropOldest,
                SingleReader = true,
                SingleWriter = false,
            });
        private readonly CancellationTokenSource _sessionCancellation = new();
        private int _disposed;

        public SongContextClientSession(WebSocket webSocket, Func<SongContextCommand, Task> commandHandler)
        {
            _webSocket = webSocket;
            _commandHandler = commandHandler;
        }

        public bool TryPublish(SongContextSnapshot snapshot) => _snapshots.Writer.TryWrite(snapshot);

        public void RequestStop()
        {
            _snapshots.Writer.TryComplete();
            try
            {
                _sessionCancellation.Cancel();
            }
            catch (ObjectDisposedException)
            {
                // A disconnected client can finish disposal while server shutdown
                // is iterating the concurrent session collection. Stop is idempotent.
            }
        }

        public async Task RunAsync(CancellationToken serverCancellation)
        {
            using CancellationTokenSource linkedCancellation =
                CancellationTokenSource.CreateLinkedTokenSource(serverCancellation, _sessionCancellation.Token);
            Task sendTask = SendLoopAsync(linkedCancellation.Token);
            Task receiveTask = ReceiveLoopAsync(linkedCancellation.Token);
            await Task.WhenAny(sendTask, receiveTask).ConfigureAwait(false);
            linkedCancellation.Cancel();

            try
            {
                await Task.WhenAll(sendTask, receiveTask).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (linkedCancellation.IsCancellationRequested)
            {
            }
            catch (WebSocketException)
            {
            }
        }

        public async ValueTask DisposeAsync()
        {
            if (Interlocked.Exchange(ref _disposed, 1) != 0)
            {
                return;
            }

            RequestStop();
            if (_webSocket.State is WebSocketState.Open or WebSocketState.CloseReceived)
            {
                try
                {
                    await _webSocket.CloseOutputAsync(
                        WebSocketCloseStatus.NormalClosure,
                        "Server stopped",
                        CancellationToken.None).ConfigureAwait(false);
                }
                catch (WebSocketException)
                {
                }
            }

            _webSocket.Dispose();
            _sessionCancellation.Dispose();
        }

        private async Task SendLoopAsync(CancellationToken cancellationToken)
        {
            await foreach (SongContextSnapshot first in _snapshots.Reader
                .ReadAllAsync(cancellationToken)
                .ConfigureAwait(false))
            {
                SongContextSnapshot latest = first;
                while (_snapshots.Reader.TryRead(out SongContextSnapshot? newer))
                {
                    latest = newer;
                }

                byte[] payload = JsonSerializer.SerializeToUtf8Bytes(
                    SongContextMessage.Create(latest),
                    SongContextJson.Options);
                await _webSocket.SendAsync(
                    payload,
                    WebSocketMessageType.Text,
                    endOfMessage: true,
                    cancellationToken).ConfigureAwait(false);
            }
        }

        private async Task ReceiveLoopAsync(CancellationToken cancellationToken)
        {
            byte[] buffer = new byte[2048];
            while (!cancellationToken.IsCancellationRequested && _webSocket.State == WebSocketState.Open)
            {
                using MemoryStream message = new();
                WebSocketReceiveResult result;
                do
                {
                    result = await _webSocket.ReceiveAsync(buffer, cancellationToken).ConfigureAwait(false);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        return;
                    }

                    if (message.Length + result.Count > MaximumCommandBytes)
                    {
                        await _webSocket.CloseOutputAsync(
                            WebSocketCloseStatus.MessageTooBig,
                            "Command is too large",
                            cancellationToken).ConfigureAwait(false);
                        return;
                    }

                    message.Write(buffer, 0, result.Count);
                }
                while (!result.EndOfMessage);

                if (result.MessageType != WebSocketMessageType.Text)
                {
                    continue;
                }

                try
                {
                    SongContextCommand? command = JsonSerializer.Deserialize<SongContextCommand>(
                        message.GetBuffer().AsSpan(0, checked((int)message.Length)),
                        SongContextJson.Options);
                    if (command is not null)
                    {
                        await _commandHandler(command).ConfigureAwait(false);
                    }
                }
                catch (JsonException)
                {
                    // Ignore malformed local commands and keep the diagnostics connection alive.
                }
            }
        }
    }

    private sealed class ClientSession : IAsyncDisposable
    {
        private readonly WebSocket _webSocket;
        private readonly JsonSerializerOptions _jsonOptions;
        private readonly Channel<AudioFrame> _frames = Channel.CreateBounded<AudioFrame>(
            new BoundedChannelOptions(capacity: 2)
            {
                FullMode = BoundedChannelFullMode.DropOldest,
                SingleReader = true,
                SingleWriter = false,
            });
        private readonly CancellationTokenSource _sessionCancellation = new();
        private int _disposed;

        public ClientSession(WebSocket webSocket, JsonSerializerOptions jsonOptions)
        {
            _webSocket = webSocket;
            _jsonOptions = jsonOptions;
        }

        public bool TryPublish(AudioFrame frame) => _frames.Writer.TryWrite(frame);

        public void RequestStop()
        {
            _frames.Writer.TryComplete();
            try
            {
                _sessionCancellation.Cancel();
            }
            catch (ObjectDisposedException)
            {
                // A disconnected client can finish disposal while server shutdown
                // is iterating the concurrent session collection. Stop is idempotent.
            }
        }

        public async Task RunAsync(CancellationToken serverCancellation)
        {
            using CancellationTokenSource linkedCancellation =
                CancellationTokenSource.CreateLinkedTokenSource(serverCancellation, _sessionCancellation.Token);
            Task sendTask = SendLoopAsync(linkedCancellation.Token);
            Task receiveTask = ReceiveLoopAsync(linkedCancellation.Token);
            await Task.WhenAny(sendTask, receiveTask).ConfigureAwait(false);
            linkedCancellation.Cancel();

            try
            {
                await Task.WhenAll(sendTask, receiveTask).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (linkedCancellation.IsCancellationRequested)
            {
            }
            catch (WebSocketException)
            {
            }
        }

        public async ValueTask DisposeAsync()
        {
            if (Interlocked.Exchange(ref _disposed, 1) != 0)
            {
                return;
            }

            RequestStop();

            if (_webSocket.State is WebSocketState.Open or WebSocketState.CloseReceived)
            {
                try
                {
                    await _webSocket
                        .CloseOutputAsync(
                            WebSocketCloseStatus.NormalClosure,
                            "Server stopped",
                            CancellationToken.None)
                        .ConfigureAwait(false);
                }
                catch (WebSocketException)
                {
                }
            }

            _webSocket.Dispose();
            _sessionCancellation.Dispose();
        }

        private async Task SendLoopAsync(CancellationToken cancellationToken)
        {
            await foreach (AudioFrame firstFrame in _frames.Reader.ReadAllAsync(cancellationToken).ConfigureAwait(false))
            {
                AudioFrame latestFrame = firstFrame;
                while (_frames.Reader.TryRead(out AudioFrame? newerFrame))
                {
                    latestFrame = newerFrame;
                }

                byte[] payload = JsonSerializer.SerializeToUtf8Bytes(
                    AudioFrameMessage.Create(latestFrame),
                    _jsonOptions);
                await _webSocket
                    .SendAsync(payload, WebSocketMessageType.Text, endOfMessage: true, cancellationToken)
                    .ConfigureAwait(false);
            }
        }

        private async Task ReceiveLoopAsync(CancellationToken cancellationToken)
        {
            byte[] buffer = new byte[256];

            while (!cancellationToken.IsCancellationRequested && _webSocket.State == WebSocketState.Open)
            {
                WebSocketReceiveResult result = await _webSocket
                    .ReceiveAsync(buffer, cancellationToken)
                    .ConfigureAwait(false);

                if (result.MessageType == WebSocketMessageType.Close)
                {
                    return;
                }
            }
        }
    }
}
