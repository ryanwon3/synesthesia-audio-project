using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text.Json;
using SpotifySynesthesia.AudioEngine.Analysis;
using SpotifySynesthesia.AudioEngine.Server;
using SpotifySynesthesia.AudioEngine.Spotify;

namespace SpotifySynesthesia.AudioEngine.Tests;

public sealed class AudioFrameWebSocketServerTests
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() },
    };

    private const string HostedOrigin = "https://app.example";
    private const string OtherHostedOrigin = "https://other.example";
    private static readonly string[] HostedOrigins = [HostedOrigin, OtherHostedOrigin];
    private static readonly string[] SocketPaths =
        [AudioFrameProtocol.DefaultPath, SongContextProtocol.Path, CompanionConnectionProtocol.PairingPath];
    private static readonly SongContextCommand ConfigureCommand =
        new(SongContextProtocol.CurrentVersion, SongContextProtocol.ConfigureAndConnectCommand, "client-id");

    [Fact]
    public async Task StreamsTypedFramesAndAcceptsAReconnect()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        AudioFrameWebSocketServerOptions options = new(
            GetAvailablePort(),
            nativeDiagnosticPolicy: NativeDiagnosticPolicy.AllowUnauthenticatedLoopbackDiagnostics);
        await using AudioFrameWebSocketServer server = new(options);
        await server.StartAsync(cancellationToken);

        using ClientWebSocket firstClient = new();
        await firstClient.ConnectAsync(options.WebSocketUri, cancellationToken);
        await WaitUntilAsync(() => server.ConnectedClientCount == 1, cancellationToken);

        server.Publish(CreateFrame(sequence: 11));
        AudioFrameMessage firstMessage = await ReceiveMessageAsync(firstClient, cancellationToken);

        Assert.Equal(AudioFrameProtocol.CurrentVersion, firstMessage.ProtocolVersion);
        Assert.Equal(AudioFrameProtocol.AudioFrameMessageType, firstMessage.Type);
        Assert.Equal(11, firstMessage.Payload.Sequence);
        Assert.Equal(PitchClass.A, firstMessage.Payload.DominantPitchClass);

        await firstClient.CloseAsync(WebSocketCloseStatus.NormalClosure, "test", cancellationToken);
        await WaitUntilAsync(() => server.ConnectedClientCount == 0, cancellationToken);

        using ClientWebSocket secondClient = new();
        await secondClient.ConnectAsync(options.WebSocketUri, cancellationToken);
        await WaitUntilAsync(() => server.ConnectedClientCount == 1, cancellationToken);

        server.Publish(CreateFrame(sequence: 12));
        AudioFrameMessage secondMessage = await ReceiveMessageAsync(secondClient, cancellationToken);

        Assert.Equal(12, secondMessage.Payload.Sequence);
        Assert.Equal(2, server.FramesPublished);
    }

    [Fact]
    public async Task PublishesWithoutClientsAndReportsHealth()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        AudioFrameWebSocketServerOptions options = new(GetAvailablePort());
        await using AudioFrameWebSocketServer server = new(options);
        await server.StartAsync(cancellationToken);

        server.Publish(CreateFrame(sequence: 1));

        using HttpClient client = new();
        using HttpResponseMessage response = await client.GetAsync(options.HealthUri, cancellationToken);
        string json = await response.Content.ReadAsStringAsync(cancellationToken);
        AudioServerHealth? health = JsonSerializer.Deserialize<AudioServerHealth>(
            json,
            JsonOptions);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.NotNull(health);
        Assert.Equal(AudioFrameProtocol.CurrentVersion, health.ProtocolVersion);
        Assert.Equal(0, health.ConnectedClients);
        Assert.Equal(1, health.FramesPublished);
        Assert.Equal("running", health.State);
    }

    [Fact]
    public async Task StopClosesListenerAndClientsCleanly()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        AudioFrameWebSocketServerOptions options = new(
            GetAvailablePort(),
            nativeDiagnosticPolicy: NativeDiagnosticPolicy.AllowUnauthenticatedLoopbackDiagnostics);
        await using AudioFrameWebSocketServer server = new(options);
        await server.StartAsync(cancellationToken);
        using ClientWebSocket client = new();
        await client.ConnectAsync(options.WebSocketUri, cancellationToken);
        await WaitUntilAsync(() => server.ConnectedClientCount == 1, cancellationToken);

        await server.StopAsync(cancellationToken);

        Assert.False(server.IsRunning);
        Assert.Equal(0, server.ConnectedClientCount);
    }

    [Fact]
    public async Task ServesVisualizerFilesWithoutAllowingPathsOutsideItsRoot()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        string contentRoot = Path.Combine(Path.GetTempPath(), $"synesthesia-static-{Guid.NewGuid():N}");
        Directory.CreateDirectory(contentRoot);
        await File.WriteAllTextAsync(Path.Combine(contentRoot, "index.html"), "<main>painting</main>", cancellationToken);

        try
        {
            AudioFrameWebSocketServerOptions options = new(GetAvailablePort(), staticContentPath: contentRoot);
            await using AudioFrameWebSocketServer server = new(options);
            await server.StartAsync(cancellationToken);
            using HttpClient client = new();

            string html = await client.GetStringAsync(options.HttpPrefix, cancellationToken);
            using HttpResponseMessage traversal = await client.GetAsync(
                new Uri(options.HttpPrefix + "%2e%2e/secret.txt"),
                cancellationToken);

            Assert.Equal("<main>painting</main>", html);
            Assert.Equal(HttpStatusCode.NotFound, traversal.StatusCode);
        }
        finally
        {
            Directory.Delete(contentRoot, recursive: true);
        }
    }

    public static TheoryData<string, string?, NativeDiagnosticPolicy> ForeignOriginCases()
    {
        TheoryData<string, string?, NativeDiagnosticPolicy> cases = new();
        foreach (string path in SocketPaths)
        {
            cases.Add(path, "https://elsewhere.example", NativeDiagnosticPolicy.RequireAuthentication);
            cases.Add(path, "https://app.example.evil.test", NativeDiagnosticPolicy.RequireAuthentication);
            cases.Add(path, null, NativeDiagnosticPolicy.RequireAuthentication);
            cases.Add(path, "https://elsewhere.example", NativeDiagnosticPolicy.AllowUnauthenticatedLoopbackDiagnostics);
        }

        return cases;
    }

    [Theory]
    [InlineData(AudioFrameProtocol.DefaultPath, true)]
    [InlineData(AudioFrameProtocol.DefaultPath, false)]
    [InlineData(SongContextProtocol.Path, true)]
    [InlineData(SongContextProtocol.Path, false)]
    public async Task PublishesNothingBeforeAuthentication(string path, bool useHostedOrigin)
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        AudioFrameWebSocketServerOptions options = CreateSecureOptions();
        await using AudioFrameWebSocketServer server = new(options);
        await server.StartAsync(cancellationToken);
        PairingChallenge challenge = server.Sessions.CreatePairingChallenge();
        Assert.True(server.Sessions.TryPair(challenge.Code, HostedOrigin, out CompanionCredential? paired));
        CompanionCredential local = server.Sessions.CreateLocalCredential(BundledOrigin(options));
        Assert.True(server.Sessions.TryAuthenticate(paired!.Token, HostedOrigin, out _));
        Assert.True(server.Sessions.TryAuthenticate(local.Token, BundledOrigin(options), out _));
        server.PublishSongContext(CreateSnapshot());

        using ClientWebSocket probe = await ConnectAsync(
            options,
            path,
            useHostedOrigin ? HostedOrigin : BundledOrigin(options),
            cancellationToken);
        await Task.Delay(TimeSpan.FromMilliseconds(100), cancellationToken);
        server.Publish(CreateFrame(sequence: 31));
        server.PublishSongContext(CreateSnapshot());

        // Cancelling the quiet-window receive aborts this probe socket by design; it is never reused.
        using CancellationTokenSource quiet = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        quiet.CancelAfter(TimeSpan.FromMilliseconds(300));
        byte[] buffer = new byte[16 * 1024];
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => probe.ReceiveAsync(buffer, quiet.Token));
        Assert.Equal(0, server.ConnectedClientCount);
        Assert.Equal(0, server.ConnectedSongContextClientCount);
    }

    [Theory]
    [MemberData(nameof(ForeignOriginCases))]
    public async Task RejectsForeignOriginOnBothStreams(string path, string? origin, NativeDiagnosticPolicy policy)
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        AudioFrameWebSocketServerOptions options = new(
            GetAvailablePort(),
            allowedBrowserOrigins: HostedOrigins,
            nativeDiagnosticPolicy: policy);
        await using AudioFrameWebSocketServer server = new(options);
        await server.StartAsync(cancellationToken);
        using ClientWebSocket client = new();
        if (origin is not null)
        {
            client.Options.SetRequestHeader("Origin", origin);
        }

        await Assert.ThrowsAsync<WebSocketException>(() => client.ConnectAsync(
            new Uri($"ws://127.0.0.1:{options.Port}{path}"),
            cancellationToken));
        Assert.Equal(0, server.ConnectedClientCount);
        Assert.Equal(0, server.ConnectedSongContextClientCount);
    }

    [Theory]
    [InlineData(AudioFrameProtocol.DefaultPath)]
    [InlineData(SongContextProtocol.Path)]
    public async Task AuthenticatesBeforePublishingAndAcceptingCommands(string path)
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        AudioFrameWebSocketServerOptions options = CreateSecureOptions();
        string origin = BundledOrigin(options);
        TaskCompletionSource<SongContextCommand> receivedCommand = new(
            TaskCreationOptions.RunContinuationsAsynchronously);
        await using AudioFrameWebSocketServer server = new(options);
        server.ConfigureSongContextHandlers(
            (command, _) =>
            {
                receivedCommand.TrySetResult(command);
                return Task.CompletedTask;
            },
            (_, _) => Task.FromResult(new SpotifyAuthorizationCallbackResult(true, "ok")));
        await server.StartAsync(cancellationToken);
        CompanionCredential credential = server.Sessions.CreateLocalCredential(origin);
        server.PublishSongContext(CreateSnapshot());
        bool isAudio = string.Equals(path, AudioFrameProtocol.DefaultPath, StringComparison.Ordinal);

        if (!isAudio)
        {
            using ClientWebSocket unauthenticated = await ConnectAsync(options, path, origin, cancellationToken);
            await SendJsonAsync(unauthenticated, ConfigureCommand, cancellationToken);
            await Task.Delay(TimeSpan.FromMilliseconds(300), cancellationToken);
            Assert.False(receivedCommand.Task.IsCompleted, "An unauthenticated command reached the handler.");
            unauthenticated.Abort();
        }

        using ClientWebSocket client = await ConnectAsync(options, path, origin, cancellationToken);
        await AuthenticateAsync(client, credential.Token, () => server.Publish(CreateFrame(sequence: 1)), cancellationToken);
        if (isAudio)
        {
            await WaitUntilAsync(() => server.ConnectedClientCount == 1, cancellationToken);
            server.Publish(CreateFrame(sequence: 21));
            using JsonDocument frame = await ReceiveJsonAsync(client, cancellationToken);
            Assert.Equal(AudioFrameProtocol.AudioFrameMessageType, ReadType(frame));
            Assert.Equal(21, frame.RootElement.GetProperty("payload").GetProperty("sequence").GetInt64());
        }
        else
        {
            using JsonDocument snapshot = await ReceiveJsonAsync(client, cancellationToken);
            Assert.Equal(SongContextProtocol.MessageType, ReadType(snapshot));
            await SendJsonAsync(client, ConfigureCommand, cancellationToken);
            SongContextCommand command = await receivedCommand.Task.WaitAsync(TimeSpan.FromSeconds(5), cancellationToken);
            Assert.Equal("client-id", command.ClientId);
        }

        using ClientWebSocket rejected = await ConnectAsync(options, path, origin, cancellationToken);
        await SendJsonAsync(rejected, Authenticate("not-a-valid-credential"), cancellationToken);
        await ExpectAuthenticationCloseAsync(rejected, cancellationToken);
    }

    [Fact]
    public async Task TimesOutInitialAuthentication()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        AudioFrameWebSocketServerOptions options = CreateSecureOptions();
        await using AudioFrameWebSocketServer server = new(options);
        await server.StartAsync(cancellationToken);

        using ClientWebSocket audio = await ConnectAsync(
            options, AudioFrameProtocol.DefaultPath, BundledOrigin(options), cancellationToken);
        using ClientWebSocket context = await ConnectAsync(
            options, SongContextProtocol.Path, BundledOrigin(options), cancellationToken);

        await Task.WhenAll(
            ExpectAuthenticationCloseAsync(audio, cancellationToken),
            ExpectAuthenticationCloseAsync(context, cancellationToken));
        await WaitUntilAsync(
            () => server.ConnectedClientCount == 0 && server.ConnectedSongContextClientCount == 0,
            cancellationToken);
    }

    [Theory]
    [InlineData("binary")]
    [InlineData("fragmented")]
    public async Task RejectsOversizedFragmentedOrBinaryAuthentication(string shape)
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        AudioFrameWebSocketServerOptions options = CreateSecureOptions();
        await using AudioFrameWebSocketServer server = new(options);
        await server.StartAsync(cancellationToken);
        CompanionCredential credential = server.Sessions.CreateLocalCredential(BundledOrigin(options));
        byte[] request = JsonSerializer.SerializeToUtf8Bytes(Authenticate(credential.Token), JsonOptions);

        using ClientWebSocket client = await ConnectAsync(
            options, AudioFrameProtocol.DefaultPath, BundledOrigin(options), cancellationToken);
        if (string.Equals(shape, "fragmented", StringComparison.Ordinal))
        {
            // A valid credential padded past the 1024-byte limit, split into two 600-byte fragments.
            byte[] padded = new byte[1200];
            Array.Fill(padded, (byte)' ');
            request.CopyTo(padded, padded.Length - request.Length);
            await client.SendAsync(padded.AsMemory(0, 600), WebSocketMessageType.Text, endOfMessage: false, cancellationToken);
            await client.SendAsync(padded.AsMemory(600), WebSocketMessageType.Text, endOfMessage: true, cancellationToken);
        }
        else
        {
            await client.SendAsync(request, WebSocketMessageType.Binary, endOfMessage: true, cancellationToken);
        }

        Assert.Equal(0, server.ConnectedClientCount);
        await ExpectAuthenticationCloseAsync(client, cancellationToken);
        Assert.Equal(0, server.ConnectedClientCount);
    }

    [Fact]
    public async Task RevocationClosesExistingSockets()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        AudioFrameWebSocketServerOptions options = CreateSecureOptions();
        string origin = BundledOrigin(options);
        await using AudioFrameWebSocketServer server = new(options);
        await server.StartAsync(cancellationToken);
        CompanionCredential credential = server.Sessions.CreateLocalCredential(origin);
        server.PublishSongContext(CreateSnapshot());

        using ClientWebSocket audio = await ConnectAsync(options, AudioFrameProtocol.DefaultPath, origin, cancellationToken);
        using ClientWebSocket context = await ConnectAsync(options, SongContextProtocol.Path, origin, cancellationToken);
        await AuthenticateAsync(audio, credential.Token, () => server.Publish(CreateFrame(sequence: 1)), cancellationToken);
        await AuthenticateAsync(context, credential.Token, static () => { }, cancellationToken);
        using (JsonDocument replay = await ReceiveJsonAsync(context, cancellationToken))
        {
            Assert.Equal(SongContextProtocol.MessageType, ReadType(replay));
        }

        await WaitUntilAsync(() => server.ConnectedClientCount == 1, cancellationToken);
        server.Publish(CreateFrame(sequence: 21));
        using (JsonDocument frame = await ReceiveJsonAsync(audio, cancellationToken))
        {
            Assert.Equal(AudioFrameProtocol.AudioFrameMessageType, ReadType(frame));
        }

        server.Sessions.RevokeAll();
        server.Publish(CreateFrame(sequence: 22));
        server.PublishSongContext(CreateSnapshot());
        await Task.WhenAll(
            ExpectAuthenticationCloseAsync(audio, cancellationToken),
            ExpectAuthenticationCloseAsync(context, cancellationToken));
        await WaitUntilAsync(
            () => server.ConnectedClientCount == 0 && server.ConnectedSongContextClientCount == 0,
            cancellationToken);

        using ClientWebSocket reused = await ConnectAsync(options, AudioFrameProtocol.DefaultPath, origin, cancellationToken);
        await SendJsonAsync(reused, Authenticate(credential.Token), cancellationToken);
        await ExpectAuthenticationCloseAsync(reused, cancellationToken);
    }

    [Fact]
    public async Task PairingCodeWorksOnceAndNeverTrustsBodyOrigin()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        AudioFrameWebSocketServerOptions options = CreateSecureOptions();
        await using AudioFrameWebSocketServer server = new(options);
        await server.StartAsync(cancellationToken);
        PairingChallenge challenge = server.Sessions.CreatePairingChallenge();

        using (ClientWebSocket pairing = await ConnectAsync(
            options, CompanionConnectionProtocol.PairingPath, HostedOrigin, cancellationToken))
        {
            // The body claims a different allowed origin; only the validated upgrade header may bind the credential.
            await SendJsonAsync(pairing, PairRequest(challenge.Code, OtherHostedOrigin), cancellationToken);
            using JsonDocument paired = await ReceiveJsonAsync(pairing, cancellationToken);
            Assert.Equal(CompanionConnectionProtocol.PairedMessageType, ReadType(paired));
            Assert.True(paired.RootElement.TryGetProperty("expiresAtUtc", out _));
            string? token = paired.RootElement.GetProperty("token").GetString();
            Assert.False(string.IsNullOrEmpty(token));
            Assert.True(server.Sessions.TryAuthenticate(token!, HostedOrigin, out _));
            Assert.False(server.Sessions.TryAuthenticate(token!, OtherHostedOrigin, out _));
        }

        using (ClientWebSocket replay = await ConnectAsync(
            options, CompanionConnectionProtocol.PairingPath, HostedOrigin, cancellationToken))
        {
            await SendJsonAsync(replay, PairRequest(challenge.Code, HostedOrigin), cancellationToken);
            await ExpectAuthenticationCloseAsync(replay, cancellationToken);
        }

        PairingChallenge fresh = server.Sessions.CreatePairingChallenge();
        using ClientWebSocket foreign = new();
        foreign.Options.SetRequestHeader("Origin", "https://elsewhere.example");
        await Assert.ThrowsAsync<WebSocketException>(() => foreign.ConnectAsync(options.PairingUri, cancellationToken));
        Assert.True(server.Sessions.TryPair(fresh.Code, HostedOrigin, out _));
    }

    private static async Task<AudioFrameMessage> ReceiveMessageAsync(
        ClientWebSocket client,
        CancellationToken cancellationToken)
    {
        byte[] buffer = new byte[16 * 1024];
        WebSocketReceiveResult result = await client.ReceiveAsync(buffer, cancellationToken);
        Assert.Equal(WebSocketMessageType.Text, result.MessageType);
        Assert.True(result.EndOfMessage);

        AudioFrameMessage? message = JsonSerializer.Deserialize<AudioFrameMessage>(
            buffer.AsSpan(0, result.Count),
            JsonOptions);
        return Assert.IsType<AudioFrameMessage>(message);
    }

    private static AudioFrameWebSocketServerOptions CreateSecureOptions() =>
        new(GetAvailablePort(), allowedBrowserOrigins: HostedOrigins);

    private static string BundledOrigin(AudioFrameWebSocketServerOptions options) => $"http://127.0.0.1:{options.Port}";

    [Fact]
    public async Task DisconnectWithPriorTokenAfterLostRenewalReplyRevokesFamily()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        AudioFrameWebSocketServerOptions options = CreateSecureOptions();
        await using AudioFrameWebSocketServer server = new(options);
        await server.StartAsync(cancellationToken);
        CompanionCredential original = PairHosted(server);
        CompanionCredential other = PairHosted(server);
        server.PublishSongContext(CreateSnapshot());

        using ClientWebSocket audio = await ConnectAsync(options, AudioFrameProtocol.DefaultPath, HostedOrigin, cancellationToken);
        using ClientWebSocket context = await ConnectAsync(options, SongContextProtocol.Path, HostedOrigin, cancellationToken);
        await AuthenticateAsync(audio, original.Token, () => server.Publish(CreateFrame(sequence: 1)), cancellationToken);
        await AuthenticateAsync(context, original.Token, static () => { }, cancellationToken);
        using (JsonDocument replay = await ReceiveJsonAsync(context, cancellationToken))
        {
            Assert.Equal(SongContextProtocol.MessageType, ReadType(replay));
        }

        await WaitUntilAsync(
            () => server.ConnectedClientCount == 1 && server.ConnectedSongContextClientCount == 1,
            cancellationToken);

        // The companion has rotated; a browser that lost this reply still holds only the original token.
        string rotated;
        using (JsonDocument renewed = await PairingExchangeAsync(
            options, TokenRequest(CompanionConnectionProtocol.RenewMessageType, original.Token), cancellationToken))
        {
            Assert.Equal(CompanionConnectionProtocol.RenewedMessageType, ReadType(renewed));
            rotated = renewed.RootElement.GetProperty("token").GetString()!;
            Assert.NotEqual(original.Token, rotated);
        }

        using (JsonDocument disconnected = await PairingExchangeAsync(
            options, TokenRequest(CompanionConnectionProtocol.DisconnectMessageType, original.Token), cancellationToken))
        {
            Assert.Equal(CompanionConnectionProtocol.DisconnectedMessageType, ReadType(disconnected));
        }

        await Task.WhenAll(
            ExpectAuthenticationCloseAsync(audio, cancellationToken),
            ExpectAuthenticationCloseAsync(context, cancellationToken));
        await WaitUntilAsync(
            () => server.ConnectedClientCount == 0 && server.ConnectedSongContextClientCount == 0,
            cancellationToken);
        Assert.False(server.Sessions.TryGetSessionLease(original.SessionId, out _));
        Assert.False(server.Sessions.TryAuthenticate(rotated, HostedOrigin, out _));

        using ClientWebSocket survivor = await ConnectAsync(options, AudioFrameProtocol.DefaultPath, HostedOrigin, cancellationToken);
        await AuthenticateAsync(survivor, other.Token, static () => { }, cancellationToken);
        await WaitUntilAsync(() => server.ConnectedClientCount == 1, cancellationToken);
        server.Publish(CreateFrame(sequence: 41));
        using JsonDocument frame = await ReceiveJsonAsync(survivor, cancellationToken);
        Assert.Equal(AudioFrameProtocol.AudioFrameMessageType, ReadType(frame));
    }

    private static CompanionConnectionRequest TokenRequest(string type, string token) => new()
    {
        ProtocolVersion = CompanionConnectionProtocol.CurrentVersion,
        Type = type,
        Token = token,
    };

    private static CompanionCredential PairHosted(AudioFrameWebSocketServer server)
    {
        PairingChallenge challenge = server.Sessions.CreatePairingChallenge();
        Assert.True(server.Sessions.TryPair(challenge.Code, HostedOrigin, out CompanionCredential? credential));
        Assert.NotNull(credential);
        return credential;
    }

    private static async Task<JsonDocument> PairingExchangeAsync(
        AudioFrameWebSocketServerOptions options,
        CompanionConnectionRequest request,
        CancellationToken cancellationToken)
    {
        using ClientWebSocket pairing = await ConnectAsync(
            options, CompanionConnectionProtocol.PairingPath, HostedOrigin, cancellationToken);
        await SendJsonAsync(pairing, request, cancellationToken);
        return await ReceiveJsonAsync(pairing, cancellationToken);
    }

    private static CompanionConnectionRequest Authenticate(string token) => new()
    {
        ProtocolVersion = CompanionConnectionProtocol.CurrentVersion,
        Type = CompanionConnectionProtocol.AuthenticateMessageType,
        Token = token,
    };

    private static object PairRequest(string code, string claimedOrigin) => new
    {
        protocolVersion = CompanionConnectionProtocol.CurrentVersion,
        type = CompanionConnectionProtocol.PairMessageType,
        code,
        origin = claimedOrigin,
    };

    private static async Task<ClientWebSocket> ConnectAsync(
        AudioFrameWebSocketServerOptions options,
        string path,
        string origin,
        CancellationToken cancellationToken)
    {
        ClientWebSocket socket = new();
        socket.Options.SetRequestHeader("Origin", origin);
        try
        {
            await socket.ConnectAsync(new Uri($"ws://127.0.0.1:{options.Port}{path}"), cancellationToken);
            return socket;
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    private static async Task SendJsonAsync<T>(ClientWebSocket socket, T message, CancellationToken cancellationToken)
    {
        byte[] payload = JsonSerializer.SerializeToUtf8Bytes(message, JsonOptions);
        await socket.SendAsync(payload, WebSocketMessageType.Text, endOfMessage: true, cancellationToken);
    }

    private static async Task AuthenticateAsync(
        ClientWebSocket socket,
        string token,
        Action publishProbe,
        CancellationToken cancellationToken)
    {
        // Publish before sending authentication so the probe is unambiguously pre-authentication.
        publishProbe();
        await SendJsonAsync(socket, Authenticate(token), cancellationToken);
        using JsonDocument acknowledgement = await ReceiveJsonAsync(socket, cancellationToken);
        JsonElement root = acknowledgement.RootElement;
        Assert.Equal(CompanionConnectionProtocol.AuthenticatedMessageType, ReadType(acknowledgement));
        Assert.True(
            root.TryGetProperty("expiresAtUtc", out JsonElement expiresAtUtc) &&
                expiresAtUtc.ValueKind == JsonValueKind.String,
            "The acknowledgement must carry an expiry.");
        Assert.False(root.TryGetProperty("token", out _), "The acknowledgement must not echo a credential.");
        Assert.False(root.TryGetProperty("sessionId", out _), "The acknowledgement must not expose a session id.");
        Assert.False(root.GetRawText().Contains(token, StringComparison.Ordinal), "The acknowledgement echoed a credential.");
    }

    private static async Task<JsonDocument> ReceiveJsonAsync(ClientWebSocket socket, CancellationToken cancellationToken)
    {
        using CancellationTokenSource timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(5));
        byte[] buffer = new byte[16 * 1024];
        int count = 0;
        WebSocketReceiveResult result;
        do
        {
            Assert.True(count < buffer.Length, "Message exceeded the 16 KiB test buffer.");
            result = await socket.ReceiveAsync(
                new ArraySegment<byte>(buffer, count, buffer.Length - count),
                timeout.Token);
            Assert.True(
                result.MessageType == WebSocketMessageType.Text,
                $"Expected a text message but received {result.MessageType} ({result.CloseStatus}).");
            count += result.Count;
        }
        while (!result.EndOfMessage);

        return JsonDocument.Parse(buffer.AsMemory(0, count));
    }

    private static async Task ExpectAuthenticationCloseAsync(ClientWebSocket socket, CancellationToken cancellationToken)
    {
        // Safety bound above the 5-second protocol deadline; expiry here is a genuine deadline failure.
        using CancellationTokenSource safety = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        safety.CancelAfter(TimeSpan.FromSeconds(8));
        byte[] buffer = new byte[16 * 1024];
        while (true)
        {
            WebSocketReceiveResult result = await socket.ReceiveAsync(buffer, safety.Token);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                int status = result.CloseStatus is { } closeStatus ? (int)closeStatus : -1;
                Assert.Equal(CompanionConnectionProtocol.AuthenticationCloseCode, status);
                return;
            }

            Assert.True(
                result.MessageType == WebSocketMessageType.Text && result.EndOfMessage,
                "Only a single generic failure message may precede the authentication close.");
            using JsonDocument message = JsonDocument.Parse(buffer.AsMemory(0, result.Count));
            Assert.Equal(CompanionConnectionProtocol.AuthenticationFailedMessageType, ReadType(message));
        }
    }

    private static string? ReadType(JsonDocument document) =>
        document.RootElement.TryGetProperty("type", out JsonElement type) ? type.GetString() : null;

    private static SongContextSnapshot CreateSnapshot() => new(
        SpotifyMetadataStatus.PlayingTrack,
        SpotifyAuthenticationStatus.Valid,
        AuthenticationDetail: null,
        SpotifyConfigured: true,
        AuthorizationGrantedAtUtc: null,
        RefreshCredentialExpiresAtUtc: null,
        CurrentTrack: null,
        Stale: false,
        LastSuccessfulUpdateUtc: null,
        NextRetryUtc: null,
        ActiveProfile: null,
        ProfileSource: null,
        SqliteStatus.Ready,
        DatabasePath: "test.db",
        CurrentPollingIntervalMilliseconds: null);

    private static async Task WaitUntilAsync(Func<bool> condition, CancellationToken cancellationToken)
    {
        using CancellationTokenSource timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(5));

        while (!condition())
        {
            await Task.Delay(TimeSpan.FromMilliseconds(20), timeout.Token);
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

    private static AudioFrame CreateFrame(long sequence) => new(
        Sequence: sequence,
        TimestampUnixMilliseconds: 1,
        CaptureTimestamp: 2,
        DspCompletedTimestamp: 3,
        Rms: 0.1d,
        BassEnergy: 0.2d,
        MidEnergy: 0.3d,
        TrebleEnergy: 0.4d,
        SpectralCentroid: 0.5d,
        SpectralFlux: 0.6d,
        OnsetStrength: 0.7d,
        StereoBalance: 0.5d,
        StereoWidth: 0.1d,
        Chroma: new ChromaVector(0d, 0d, 0d, 0d, 0d, 0d, 0d, 0d, 0d, 1d, 0d, 0d),
        DominantPitchClass: PitchClass.A,
        ChromaConfidence: 1d);
}
