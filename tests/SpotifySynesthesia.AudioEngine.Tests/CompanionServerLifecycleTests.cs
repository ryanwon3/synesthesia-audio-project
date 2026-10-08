using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using SpotifySynesthesia.AudioEngine.Server;
using SpotifySynesthesia.AudioEngine.Spotify;

namespace SpotifySynesthesia.AudioEngine.Tests;

// Post-review regression guards for admission, shutdown, restart, and idle expiry on a real loopback listener.
public sealed class CompanionServerLifecycleTests
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    // Mirrors AudioFrameWebSocketServer.MaxAdmittedWebSockets.
    private const int AdmissionLimit = 32;
    private const string HostedOrigin = "https://app.example";
    private static readonly string[] HostedOrigins = [HostedOrigin];
    private static readonly string[] SocketPaths =
        [AudioFrameProtocol.DefaultPath, SongContextProtocol.Path, CompanionConnectionProtocol.PairingPath];
    private static readonly TimeSpan ConnectBudget = TimeSpan.FromSeconds(3);
    private static readonly TimeSpan ReplacementWindow = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan StopBudget = TimeSpan.FromSeconds(4.5);
    private static readonly TimeSpan ObservationWindow = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan LeaseDuration = TimeSpan.FromMinutes(30);
    private static readonly DateTimeOffset Start = new(2026, 10, 8, 0, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task Admission32PendingThen33rdIs429AndAbortFreesSlot()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        AudioFrameWebSocketServerOptions options = CreateSecureOptions();
        string origin = BundledOrigin(options);
        List<ClientWebSocket> sockets = new(AdmissionLimit + 1);
        await using AudioFrameWebSocketServer server = new(options);
        await server.StartAsync(cancellationToken);
        try
        {
            // Every server-side authentication deadline starts at an accept that follows this mark.
            long started = Stopwatch.GetTimestamp();
            Task<ClientWebSocket>[] connects = new Task<ClientWebSocket>[AdmissionLimit];
            for (int index = 0; index < AdmissionLimit; index++)
            {
                connects[index] = ConnectAsync(
                    options, SocketPaths[index % SocketPaths.Length], origin, cancellationToken);
            }

            try
            {
                await Task.WhenAll(connects);
            }
            finally
            {
                foreach (Task<ClientWebSocket> connect in connects)
                {
                    if (connect.IsCompletedSuccessfully)
                    {
                        sockets.Add(await connect);
                    }
                }
            }

            TimeSpan admitted = Stopwatch.GetElapsedTime(started);
            Assert.True(admitted <= ConnectBudget, $"Admitting {AdmissionLimit} pending sockets took {admitted}.");
            Assert.Equal(0, server.ConnectedClientCount);
            Assert.Equal(0, server.ConnectedSongContextClientCount);

            using (ClientWebSocket overflow = CreateClient(origin))
            using (CancellationTokenSource deadline = Deadline(ConnectBudget, cancellationToken))
            {
                await Assert.ThrowsAsync<WebSocketException>(
                    () => overflow.ConnectAsync(SocketUri(options, AudioFrameProtocol.DefaultPath), deadline.Token));
                Assert.Equal(HttpStatusCode.TooManyRequests, overflow.HttpStatusCode);
            }

            sockets[0].Abort();
            sockets.Add(await ConnectReplacementAsync(options, origin, cancellationToken));
            TimeSpan replaced = Stopwatch.GetElapsedTime(started);
            Assert.True(
                replaced < CompanionConnectionProtocol.InitialAuthenticationTimeout,
                $"The replacement was admitted after {replaced}; an authentication deadline, not the abort, may have freed the slot.");
        }
        finally
        {
            AbortAndDispose(sockets);
            await server.StopAsync(cancellationToken);
        }
    }

    [Fact]
    public async Task StopWithPendingAuthReleasesPortAndInvalidatesOldCredentialsAndChallenge()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        AudioFrameWebSocketServerOptions options = CreateSecureOptions();
        string bundled = BundledOrigin(options);
        List<ClientWebSocket> sockets = new(3);
        await using AudioFrameWebSocketServer server = new(options);
        await server.StartAsync(cancellationToken);
        try
        {
            CompanionCredential local = server.Sessions.CreateLocalCredential(bundled);
            PairingChallenge used = server.Sessions.CreatePairingChallenge();
            Assert.True(server.Sessions.TryPair(used.Code, HostedOrigin, out CompanionCredential? hosted));
            Assert.NotNull(hosted);
            PairingChallenge pending = server.Sessions.CreatePairingChallenge();

            // Admitted on every path but never authenticated, so stop must fail them rather than wait on the peer.
            sockets.Add(await ConnectAsync(options, AudioFrameProtocol.DefaultPath, bundled, cancellationToken));
            sockets.Add(await ConnectAsync(options, SongContextProtocol.Path, HostedOrigin, cancellationToken));
            sockets.Add(await ConnectAsync(
                options, CompanionConnectionProtocol.PairingPath, HostedOrigin, cancellationToken));

            long stopping = Stopwatch.GetTimestamp();
            await server.StopAsync(cancellationToken);
            TimeSpan stopped = Stopwatch.GetElapsedTime(stopping);
            Assert.True(stopped < StopBudget, $"Stop with pending authentication took {stopped}.");
            Assert.False(server.IsRunning);
            Assert.Equal(0, server.ConnectedClientCount);
            Assert.Equal(0, server.ConnectedSongContextClientCount);
            AbortAndDispose(sockets);

            Assert.False(server.Sessions.TryAuthenticate(local.Token, bundled, out _));
            Assert.False(server.Sessions.TryAuthenticate(hosted.Token, HostedOrigin, out _));
            Assert.False(server.Sessions.TryGetSessionLease(local.SessionId, out _));
            Assert.False(server.Sessions.TryGetSessionLease(hosted.SessionId, out _));
            Assert.False(server.Sessions.TryPair(pending.Code, HostedOrigin, out CompanionCredential? stale));
            Assert.Null(stale);

            // The same instance binds the same port again, so the listener prefix was released.
            await server.StartAsync(cancellationToken);
            Assert.True(server.IsRunning);
            await ExpectRouteRejectsAsync(
                options,
                AudioFrameProtocol.DefaultPath,
                bundled,
                Request(CompanionConnectionProtocol.AuthenticateMessageType, token: local.Token),
                local.Token,
                cancellationToken);
            await ExpectRouteRejectsAsync(
                options,
                SongContextProtocol.Path,
                HostedOrigin,
                Request(CompanionConnectionProtocol.AuthenticateMessageType, token: hosted.Token),
                hosted.Token,
                cancellationToken);
            await ExpectRouteRejectsAsync(
                options,
                CompanionConnectionProtocol.PairingPath,
                HostedOrigin,
                Request(CompanionConnectionProtocol.PairMessageType, code: pending.Code),
                pending.Code,
                cancellationToken);
            Assert.Equal(0, server.ConnectedClientCount);
            Assert.Equal(0, server.ConnectedSongContextClientCount);
        }
        finally
        {
            AbortAndDispose(sockets);
            await server.StopAsync(cancellationToken);
        }
    }

    [Fact]
    public async Task IdleExpiryClosesBothStreams()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        AudioFrameWebSocketServerOptions options = CreateSecureOptions();
        string bundled = BundledOrigin(options);
        ManualTimeProvider time = new();
        CompanionSessionManager sessions = new(options.OriginPolicy, time);
        List<ClientWebSocket> sockets = new(2);
        await using AudioFrameWebSocketServer server = new(options, sessions);
        await server.StartAsync(cancellationToken);
        try
        {
            CompanionCredential credential = sessions.CreateLocalCredential(bundled);
            Assert.Equal(Start + LeaseDuration, credential.ExpiresAtUtc);
            ClientWebSocket audio = await ConnectAsync(options, AudioFrameProtocol.DefaultPath, bundled, cancellationToken);
            sockets.Add(audio);
            ClientWebSocket context = await ConnectAsync(options, SongContextProtocol.Path, bundled, cancellationToken);
            sockets.Add(context);
            await AuthenticateAsync(audio, credential, cancellationToken);
            await AuthenticateAsync(context, credential, cancellationToken);
            await WaitUntilAsync(
                () => server.ConnectedClientCount == 1 && server.ConnectedSongContextClientCount == 1,
                cancellationToken);

            // Nothing is ever published, so only the idle lease watch can observe the expiry.
            time.Advance(LeaseDuration);
            await Task.WhenAll(
                ExpectAuthenticationCloseAsync(audio, allowFailureNotice: false, credential.Token, cancellationToken),
                ExpectAuthenticationCloseAsync(context, allowFailureNotice: false, credential.Token, cancellationToken));
            await WaitUntilAsync(
                () => server.ConnectedClientCount == 0 && server.ConnectedSongContextClientCount == 0,
                cancellationToken);
            Assert.False(sessions.TryGetSessionLease(credential.SessionId, out _));
        }
        finally
        {
            AbortAndDispose(sockets);
            await server.StopAsync(cancellationToken);
        }
    }

    private static AudioFrameWebSocketServerOptions CreateSecureOptions() =>
        new(GetAvailablePort(), allowedBrowserOrigins: HostedOrigins);

    private static string BundledOrigin(AudioFrameWebSocketServerOptions options) => $"http://127.0.0.1:{options.Port}";

    private static Uri SocketUri(AudioFrameWebSocketServerOptions options, string path) =>
        new($"ws://127.0.0.1:{options.Port}{path}");

    private static CancellationTokenSource Deadline(TimeSpan within, CancellationToken cancellationToken)
    {
        CancellationTokenSource deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(within);
        return deadline;
    }

    private static ClientWebSocket CreateClient(string origin)
    {
        ClientWebSocket socket = new();
        socket.Options.SetRequestHeader("Origin", origin);
        socket.Options.CollectHttpResponseDetails = true;
        return socket;
    }

    private static async Task<ClientWebSocket> ConnectAsync(
        AudioFrameWebSocketServerOptions options,
        string path,
        string origin,
        CancellationToken cancellationToken)
    {
        ClientWebSocket socket = CreateClient(origin);
        using CancellationTokenSource deadline = Deadline(ConnectBudget, cancellationToken);
        try
        {
            await socket.ConnectAsync(SocketUri(options, path), deadline.Token);
            return socket;
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    // Retries only while the server still answers 429; any other outcome fails the test.
    private static async Task<ClientWebSocket> ConnectReplacementAsync(
        AudioFrameWebSocketServerOptions options,
        string origin,
        CancellationToken cancellationToken)
    {
        using CancellationTokenSource window = Deadline(ReplacementWindow, cancellationToken);
        while (true)
        {
            ClientWebSocket candidate = CreateClient(origin);
            try
            {
                await candidate.ConnectAsync(SocketUri(options, AudioFrameProtocol.DefaultPath), window.Token);
                return candidate;
            }
            catch (WebSocketException) when (candidate.HttpStatusCode == HttpStatusCode.TooManyRequests)
            {
                candidate.Dispose();
            }
            catch
            {
                candidate.Dispose();
                throw;
            }

            await Task.Delay(TimeSpan.FromMilliseconds(25), window.Token);
        }
    }

    private static void AbortAndDispose(List<ClientWebSocket> sockets)
    {
        foreach (ClientWebSocket socket in sockets)
        {
            socket.Abort();
            socket.Dispose();
        }

        sockets.Clear();
    }

    private static CompanionConnectionRequest Request(string type, string? token = null, string? code = null) => new()
    {
        ProtocolVersion = CompanionConnectionProtocol.CurrentVersion,
        Type = type,
        Token = token,
        Code = code,
    };

    private static async Task SendJsonAsync<T>(ClientWebSocket socket, T message, CancellationToken cancellationToken)
    {
        byte[] payload = JsonSerializer.SerializeToUtf8Bytes(message, JsonOptions);
        await socket.SendAsync(payload, WebSocketMessageType.Text, endOfMessage: true, cancellationToken);
    }

    private static async Task<JsonDocument> ReceiveJsonAsync(ClientWebSocket socket, CancellationToken cancellationToken)
    {
        using CancellationTokenSource deadline = Deadline(ObservationWindow, cancellationToken);
        byte[] buffer = new byte[4 * 1024];
        WebSocketReceiveResult result = await socket.ReceiveAsync(buffer, deadline.Token);
        Assert.True(
            result.MessageType == WebSocketMessageType.Text && result.EndOfMessage,
            $"Expected one complete text message but received {result.MessageType} ({result.CloseStatus}).");
        return JsonDocument.Parse(buffer.AsMemory(0, result.Count));
    }

    private static async Task AuthenticateAsync(
        ClientWebSocket socket,
        CompanionCredential credential,
        CancellationToken cancellationToken)
    {
        await SendJsonAsync(
            socket,
            Request(CompanionConnectionProtocol.AuthenticateMessageType, token: credential.Token),
            cancellationToken);
        using JsonDocument acknowledgement = await ReceiveJsonAsync(socket, cancellationToken);
        JsonElement root = acknowledgement.RootElement;
        Assert.Equal(CompanionConnectionProtocol.AuthenticatedMessageType, ReadType(acknowledgement));
        Assert.Equal(credential.ExpiresAtUtc, root.GetProperty("expiresAtUtc").GetDateTimeOffset());
        Assert.False(root.TryGetProperty("token", out _), "The acknowledgement must not echo a credential.");
    }

    private static async Task ExpectRouteRejectsAsync(
        AudioFrameWebSocketServerOptions options,
        string path,
        string origin,
        CompanionConnectionRequest request,
        string secret,
        CancellationToken cancellationToken)
    {
        using ClientWebSocket socket = await ConnectAsync(options, path, origin, cancellationToken);
        await SendJsonAsync(socket, request, cancellationToken);
        await ExpectAuthenticationCloseAsync(socket, allowFailureNotice: true, secret, cancellationToken);
    }

    private static async Task ExpectAuthenticationCloseAsync(
        ClientWebSocket socket,
        bool allowFailureNotice,
        string secret,
        CancellationToken cancellationToken)
    {
        using CancellationTokenSource deadline = Deadline(ObservationWindow, cancellationToken);
        bool noticeAllowed = allowFailureNotice;
        byte[] buffer = new byte[4 * 1024];
        while (true)
        {
            WebSocketReceiveResult result = await socket.ReceiveAsync(buffer, deadline.Token);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                int status = result.CloseStatus is { } closeStatus ? (int)closeStatus : -1;
                Assert.Equal(CompanionConnectionProtocol.AuthenticationCloseCode, status);
                try
                {
                    // Completing the handshake lets the server release the socket before its close timeout.
                    await socket.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, null, deadline.Token);
                }
                catch (WebSocketException)
                {
                    // The server may already have torn the transport down; the close code is what is under test.
                }

                return;
            }

            Assert.True(
                noticeAllowed && result.MessageType == WebSocketMessageType.Text && result.EndOfMessage,
                "Only a single generic failure notice may precede the authentication close.");
            string text = Encoding.UTF8.GetString(buffer, 0, result.Count);
            Assert.DoesNotContain(secret, text, StringComparison.Ordinal);
            using JsonDocument notice = JsonDocument.Parse(text);
            Assert.Equal(CompanionConnectionProtocol.AuthenticationFailedMessageType, ReadType(notice));
            noticeAllowed = false;
        }
    }

    private static string? ReadType(JsonDocument document) =>
        document.RootElement.TryGetProperty("type", out JsonElement type) ? type.GetString() : null;

    private static async Task WaitUntilAsync(Func<bool> condition, CancellationToken cancellationToken)
    {
        using CancellationTokenSource deadline = Deadline(ObservationWindow, cancellationToken);
        while (!condition())
        {
            await Task.Delay(TimeSpan.FromMilliseconds(20), deadline.Token);
        }
    }

    private static int GetAvailablePort()
    {
        using TcpListener listener = new(IPAddress.Loopback, port: 0);
        listener.Start();
        int port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    // Read by server lease checks on pool threads while the test advances it.
    private sealed class ManualTimeProvider : TimeProvider
    {
        private long _utcTicks = Start.UtcTicks;

        public override DateTimeOffset GetUtcNow() => new(Interlocked.Read(ref _utcTicks), TimeSpan.Zero);

        public void Advance(TimeSpan delta) => Interlocked.Add(ref _utcTicks, delta.Ticks);
    }
}
