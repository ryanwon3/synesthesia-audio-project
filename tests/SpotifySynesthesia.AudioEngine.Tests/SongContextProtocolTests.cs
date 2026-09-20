using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using SpotifySynesthesia.AudioEngine.Analysis;
using SpotifySynesthesia.AudioEngine.LastFm;
using SpotifySynesthesia.AudioEngine.Server;
using SpotifySynesthesia.AudioEngine.Spotify;

namespace SpotifySynesthesia.AudioEngine.Tests;

public sealed class SongContextProtocolTests
{
    [Fact]
    public async Task ReplaysLatestSnapshotAcceptsTypedCommandAndLeavesAudioPublishingIndependent()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        AudioFrameWebSocketServerOptions options = new(GetAvailablePort());
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
        server.PublishSongContext(CreateSnapshot());

        using ClientWebSocket client = new();
        await client.ConnectAsync(
            new Uri($"ws://127.0.0.1:{options.Port}{SongContextProtocol.Path}"),
            cancellationToken);
        SongContextMessage message = await ReceiveAsync(client, cancellationToken);
        Assert.Equal(SpotifyMetadataStatus.PlayingTrack, message.Payload.MetadataStatus);
        Assert.Equal("track-id", message.Payload.CurrentTrack?.SpotifyTrackId);

        byte[] commandPayload = JsonSerializer.SerializeToUtf8Bytes(
            new SongContextCommand(1, SongContextProtocol.ConfigureAndConnectCommand, "client-id"),
            SongContextJson.Options);
        await client.SendAsync(commandPayload, WebSocketMessageType.Text, true, cancellationToken);
        SongContextCommand command = await receivedCommand.Task.WaitAsync(cancellationToken);
        Assert.Equal("client-id", command.ClientId);

        server.Publish(CreateAudioFrame());
        Assert.Equal(1, server.FramesPublished);
    }

    [Fact]
    public void SerializedContextNeverContainsOAuthMaterial()
    {
        string json = JsonSerializer.Serialize(
            SongContextMessage.Create(CreateSnapshot()),
            SongContextJson.Options);

        Assert.Contains("\"metadataStatus\":\"playingTrack\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain("access-token", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("refresh-token", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("pkce", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("authorizationCode", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("dummy-lastfm-key", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("dummy-openai-key", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("api_key", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("ws.audioscrobbler.com", json, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("\"lastFm\":", json, StringComparison.Ordinal);
        Assert.Contains("\"trackMusicBrainzId\":null", json, StringComparison.Ordinal);
        Assert.Contains("\"artistMusicBrainzId\":null", json, StringComparison.Ordinal);
        Assert.Contains("\"errorCategory\":null", json, StringComparison.Ordinal);
        Assert.Contains("\"nextRetryUtc\":null", json, StringComparison.Ordinal);
        Assert.Contains("\"openAiConfigured\":true", json, StringComparison.Ordinal);
    }

    [Fact]
    public void SerializesEveryLastFmEnumAsCamelCase()
    {
        Assert.Equal(
            ["notConfigured", "notAttempted", "insufficientIdentity", "fetching", "succeeded", "noMatch", "unavailable", "rateLimited", "invalidCredentials", "error"],
            SerializeEnumValues<LastFmStatus>());
        Assert.Equal(["none", "cached", "fetched"], SerializeEnumValues<LastFmCacheSource>());
        Assert.Equal(["exact", "normalized", "providerCorrected"], SerializeEnumValues<LastFmMatchQuality>());
        Assert.Equal(
            ["insufficientIdentity", "invalidApiKey", "suspendedApiKey", "rateLimit", "noMatch", "timeout", "network", "serviceOffline", "serverError", "malformedResponse", "unexpectedResponse", "persistence"],
            SerializeEnumValues<LastFmErrorCategory>());
    }

    [Fact]
    public void DeserializesLegacyProtocolV1SnapshotWithoutLastFm()
    {
        JsonNode root = JsonNode.Parse(JsonSerializer.Serialize(
            SongContextMessage.Create(CreateSnapshot()),
            SongContextJson.Options))!;
        root["payload"]!.AsObject().Remove("lastFm");

        SongContextMessage? message = root.Deserialize<SongContextMessage>(SongContextJson.Options);

        Assert.NotNull(message);
        Assert.Equal(1, message.ProtocolVersion);
        Assert.Null(message.Payload.LastFm);
    }

    [Fact]
    public async Task ReconnectedClientReceivesTheLatestLastFmSnapshot()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        AudioFrameWebSocketServerOptions options = new(GetAvailablePort());
        await using AudioFrameWebSocketServer server = new(options);
        await server.StartAsync(cancellationToken);
        server.PublishSongContext(CreateSnapshot());

        using (ClientWebSocket first = new())
        {
            await first.ConnectAsync(new Uri($"ws://127.0.0.1:{options.Port}{SongContextProtocol.Path}"), cancellationToken);
            Assert.Equal(LastFmStatus.Succeeded, (await ReceiveAsync(first, cancellationToken)).Payload.LastFm?.Status);
        }

        SongContextSnapshot latest = CreateSnapshot() with
        {
            LastFm = LastFmContextState.NotConfigured with
            {
                Status = LastFmStatus.RateLimited,
                ErrorCategory = LastFmErrorCategory.RateLimit,
                NextRetryUtc = Utc("2026-08-12T12:01:00Z"),
            },
        };
        server.PublishSongContext(latest);

        using ClientWebSocket reconnected = new();
        await reconnected.ConnectAsync(
            new Uri($"ws://127.0.0.1:{options.Port}{SongContextProtocol.Path}"),
            cancellationToken);
        SongContextMessage replay = await ReceiveAsync(reconnected, cancellationToken);

        Assert.Equal(LastFmStatus.RateLimited, replay.Payload.LastFm?.Status);
        Assert.Equal(Utc("2026-08-12T12:01:00Z"), replay.Payload.LastFm?.NextRetryUtc);
    }

    [Fact]
    public async Task RejectsExternallyOriginatedSongContextSockets()
    {
        AudioFrameWebSocketServerOptions options = new(GetAvailablePort());
        await using AudioFrameWebSocketServer server = new(options);
        server.ConfigureSongContextHandlers(
            (_, _) => Task.CompletedTask,
            (_, _) => Task.FromResult(new SpotifyAuthorizationCallbackResult(true, "ok")));
        await server.StartAsync(TestContext.Current.CancellationToken);
        using ClientWebSocket client = new();
        client.Options.SetRequestHeader("Origin", "http://example.test");

        await Assert.ThrowsAsync<WebSocketException>(() => client.ConnectAsync(
            new Uri($"ws://127.0.0.1:{options.Port}{SongContextProtocol.Path}"),
            TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task CallbackRoutePassesOnlyParsedCallbackFields()
    {
        AudioFrameWebSocketServerOptions options = new(GetAvailablePort());
        SpotifyAuthorizationCallback? received = null;
        await using AudioFrameWebSocketServer server = new(options);
        server.ConfigureSongContextHandlers(
            (_, _) => Task.CompletedTask,
            (callback, _) =>
            {
                received = callback;
                return Task.FromResult(new SpotifyAuthorizationCallbackResult(true, "connected"));
            });
        await server.StartAsync(TestContext.Current.CancellationToken);
        using HttpClient client = new();

        using HttpResponseMessage response = await client.GetAsync(
            new Uri(options.HttpPrefix + "spotify/callback?code=abc&state=xyz"),
            TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("abc", received?.Code);
        Assert.Equal("xyz", received?.State);
    }

    private static async Task<SongContextMessage> ReceiveAsync(
        ClientWebSocket client,
        CancellationToken cancellationToken)
    {
        byte[] buffer = new byte[32 * 1024];
        WebSocketReceiveResult result = await client.ReceiveAsync(buffer, cancellationToken);
        Assert.True(result.EndOfMessage);
        SongContextMessage? message = JsonSerializer.Deserialize<SongContextMessage>(
            buffer.AsSpan(0, result.Count),
            SongContextJson.Options);
        return Assert.IsType<SongContextMessage>(message);
    }

    private static SongContextSnapshot CreateSnapshot()
    {
        CurrentTrack track = new(
            "track-id",
            "spotify:track:track-id",
            "ISRC",
            "Title",
            [new SpotifyArtistIdentity("artist-id", "Artist")],
            new SpotifyAlbumIdentity("album-id", "Album", null, "2026", "year"),
            100_000,
            false,
            10_000,
            true,
            Utc("2026-08-12T12:00:00Z"));
        return new SongContextSnapshot(
            SpotifyMetadataStatus.PlayingTrack,
            SpotifyAuthenticationStatus.Valid,
            "Spotify authorization is valid.",
            SpotifyConfigured: true,
            Utc("2026-08-12T11:00:00Z"),
            Utc("2027-02-12T11:00:00Z"),
            track,
            Stale: false,
            Utc("2026-08-12T12:00:00Z"),
            NextRetryUtc: null,
            ActiveProfile: null,
            ProfileSource: null,
            SqliteStatus.Ready,
            "C:\\data\\song-profiles.db",
            5000,
            new LastFmContextState(
                LastFmStatus.Succeeded,
                LastFmCacheSource.Cached,
                [new LastFmTag("dreamy", 1)],
                [new LastFmTag("dream pop", 0.8)],
                "Title",
                "Artist",
                null,
                null,
                LastFmMatchQuality.Exact,
                Utc("2026-08-12T12:00:00Z"),
                null,
                null),
            OpenAiConfigured: true);
    }

    private static AudioFrame CreateAudioFrame() => new(
        Sequence: 1,
        TimestampUnixMilliseconds: 1,
        CaptureTimestamp: 2,
        DspCompletedTimestamp: 3,
        Rms: 0,
        BassEnergy: 0,
        MidEnergy: 0,
        TrebleEnergy: 0,
        SpectralCentroid: 0,
        SpectralFlux: 0,
        OnsetStrength: 0,
        StereoBalance: 0.5,
        StereoWidth: 0,
        Chroma: new ChromaVector(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
        DominantPitchClass: null,
        ChromaConfidence: 0);

    private static int GetAvailablePort()
    {
        using TcpListener listener = new(IPAddress.Loopback, 0);
        listener.Start();
        int port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    private static DateTimeOffset Utc(string value) => DateTimeOffset.Parse(value, CultureInfo.InvariantCulture);

    private static string[] SerializeEnumValues<T>() where T : struct, Enum => Enum.GetValues<T>()
        .Select(value => JsonSerializer.Deserialize<string>(
            JsonSerializer.Serialize(value, SongContextJson.Options),
            SongContextJson.Options)!)
        .ToArray();
}
