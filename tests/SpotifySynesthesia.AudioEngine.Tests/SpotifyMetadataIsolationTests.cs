using System.Net;
using System.Net.Sockets;
using SpotifySynesthesia.AudioEngine.Analysis;
using SpotifySynesthesia.AudioEngine.LastFm;
using SpotifySynesthesia.AudioEngine.Profiles;
using SpotifySynesthesia.AudioEngine.Server;
using SpotifySynesthesia.AudioEngine.Spotify;

namespace SpotifySynesthesia.AudioEngine.Tests;

public sealed class SpotifyMetadataIsolationTests
{
    [Fact]
    public async Task MetadataFailureDoesNotInterruptAudioPublishing()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        AudioFrameWebSocketServerOptions serverOptions = new(GetAvailablePort());
        await using AudioFrameWebSocketServer server = new(serverOptions);
        await server.StartAsync(cancellationToken);
        FailingPlaybackClient playback = new();
        SpotifyPollingOptions polling = new()
        {
            PlayingInterval = TimeSpan.FromMilliseconds(10),
            PausedInterval = TimeSpan.FromMilliseconds(10),
            EmptyInterval = TimeSpan.FromMilliseconds(10),
            RequestTimeout = TimeSpan.FromMilliseconds(10),
            InitialBackoff = TimeSpan.FromMilliseconds(10),
            MaximumBackoff = TimeSpan.FromMilliseconds(20),
        };
        await using SpotifyMetadataRuntime metadata = new(
            server,
            new ValidAuthorizationService(),
            playback,
            new TestSongProfileRepository(),
            polling);
        await metadata.InitializeAsync(cancellationToken);
        await playback.Called.Task.WaitAsync(cancellationToken);

        server.Publish(CreateAudioFrame());

        Assert.Equal(1, server.FramesPublished);
        Assert.True(server.IsRunning);
        Assert.Equal(SpotifyMetadataStatus.MetadataUnavailable, metadata.CurrentSnapshot.MetadataStatus);
    }

    [Fact]
    public async Task BlockedLastFmWorkDoesNotDelaySpotifyPollingOrAudioPublishing()
    {
        CancellationToken cancellationToken = TestContext.Current.CancellationToken;
        AudioFrameWebSocketServerOptions serverOptions = new(GetAvailablePort());
        await using AudioFrameWebSocketServer server = new(serverOptions);
        await server.StartAsync(cancellationToken);
        CurrentTrack track = new(
            "track-id",
            "spotify:track:track-id",
            null,
            "Song",
            [new SpotifyArtistIdentity("artist-id", "Artist")],
            null,
            180_000,
            false,
            1_000,
            true,
            DateTimeOffset.UtcNow);
        CountingTrackPlaybackClient playback = new(track);
        TrackSongProfileRepository repository = new(track);
        BlockingLastFmApiClient lastFmApi = new();
        LastFmOptions lastFmOptions = new() { RequestTimeout = TimeSpan.FromSeconds(30) };
        LastFmEnrichmentCoordinator lastFm = new(
            new LastFmEnrichmentService(
                lastFmApi,
                new LastFmTagNormalizer(lastFmOptions),
                lastFmOptions),
            repository,
            new ConfiguredLastFmApiKeyStore(),
            lastFmOptions);
        SpotifyPollingOptions polling = new()
        {
            PlayingInterval = TimeSpan.FromMilliseconds(10),
            PausedInterval = TimeSpan.FromMilliseconds(10),
            EmptyInterval = TimeSpan.FromMilliseconds(10),
            RequestTimeout = TimeSpan.FromMilliseconds(10),
            InitialBackoff = TimeSpan.FromMilliseconds(10),
            MaximumBackoff = TimeSpan.FromMilliseconds(20),
        };
        await using SpotifyMetadataRuntime metadata = new(
            server,
            new ValidAuthorizationService(),
            playback,
            repository,
            polling,
            lastFm: lastFm);
        await metadata.InitializeAsync(cancellationToken);
        await lastFmApi.Started.Task.WaitAsync(cancellationToken);
        await WaitUntilAsync(() => playback.CallCount >= 3, cancellationToken);

        server.Publish(CreateAudioFrame());

        Assert.Equal(1, server.FramesPublished);
        Assert.True(server.IsRunning);
        Assert.Equal(LastFmStatus.Fetching, metadata.CurrentSnapshot.LastFm?.Status);
    }

    private static AudioFrame CreateAudioFrame() => new(
        1,
        1,
        2,
        3,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0.5,
        0,
        new ChromaVector(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
        null,
        0);

    private static int GetAvailablePort()
    {
        using TcpListener listener = new(IPAddress.Loopback, 0);
        listener.Start();
        int port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    private static async Task WaitUntilAsync(Func<bool> condition, CancellationToken cancellationToken)
    {
        while (!condition())
        {
            await Task.Delay(5, cancellationToken);
        }
    }
}

internal sealed class CountingTrackPlaybackClient(CurrentTrack track) : ISpotifyCurrentPlaybackClient
{
    private int _callCount;

    public int CallCount => Volatile.Read(ref _callCount);

    public Task<SpotifyPlaybackResult> GetCurrentPlaybackAsync(
        string accessToken,
        TimeSpan requestTimeout,
        CancellationToken cancellationToken = default)
    {
        Interlocked.Increment(ref _callCount);
        return Task.FromResult(new SpotifyPlaybackResult(SpotifyPlaybackResultKind.Track, track));
    }
}

internal sealed class BlockingLastFmApiClient : ILastFmApiClient
{
    public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public async Task<LastFmApiResult<LastFmTrackInfo>> GetTrackInfoAsync(
        string apiKey,
        string artist,
        string track,
        TimeSpan requestTimeout,
        CancellationToken cancellationToken = default)
    {
        Started.TrySetResult();
        await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
        throw new InvalidOperationException("The blocking request should be cancelled during shutdown.");
    }

    public Task<LastFmApiResult<IReadOnlyList<LastFmProviderTag>>> GetTrackTopTagsAsync(
        string apiKey,
        LastFmTrackInfo track,
        TimeSpan requestTimeout,
        CancellationToken cancellationToken = default) => throw new InvalidOperationException();

    public Task<LastFmApiResult<IReadOnlyList<LastFmProviderTag>>> GetArtistTopTagsAsync(
        string apiKey,
        LastFmTrackInfo track,
        TimeSpan requestTimeout,
        CancellationToken cancellationToken = default) => throw new InvalidOperationException();
}

internal sealed class ConfiguredLastFmApiKeyStore : ILastFmApiKeyStore
{
    public Task<string?> LoadAsync(CancellationToken cancellationToken = default) =>
        Task.FromResult<string?>("test-key");

    public Task SaveAsync(string apiKey, CancellationToken cancellationToken = default) => Task.CompletedTask;

    public Task ClearAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
}

internal sealed class TrackSongProfileRepository(CurrentTrack track) : ISongProfileRepository
{
    private readonly SongProfile _profile = new(
        new SongProfileIdentity(
            track.SpotifyTrackId,
            track.SpotifyUri,
            track.Isrc,
            track.Title,
            track.Artists,
            track.Album,
            track.DurationMs,
            track.Explicit),
        new ReservedSongProfileData(null, null, null, null, null),
        new SongProfileCacheMetadata(DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, 2));

    public string DatabasePath => "test.db";

    public Task InitializeAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;

    public Task<SongProfileLoadResult> GetOrCreateAndRefreshIdentityAsync(
        CurrentTrack currentTrack,
        CancellationToken cancellationToken = default) => Task.FromResult(
            new SongProfileLoadResult(_profile, SongProfileSource.New));

    public Task<SongProfile> UpdateLastFmEnrichmentAsync(
        string spotifyTrackId,
        LastFmEnrichment enrichment,
        CancellationToken cancellationToken = default) => throw new InvalidOperationException();
}

internal sealed class FailingPlaybackClient : ISpotifyCurrentPlaybackClient
{
    public TaskCompletionSource Called { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public Task<SpotifyPlaybackResult> GetCurrentPlaybackAsync(
        string accessToken,
        TimeSpan requestTimeout,
        CancellationToken cancellationToken = default)
    {
        Called.TrySetResult();
        return Task.FromResult(new SpotifyPlaybackResult(SpotifyPlaybackResultKind.Unavailable));
    }
}

internal sealed class ValidAuthorizationService : ISpotifyAuthorizationService
{
    public event Action? StateChanged;

    public SpotifyAuthenticationStatus Status => SpotifyAuthenticationStatus.Valid;

    public string? StatusDetail => "Valid";

    public bool IsConfigured => true;

    public string? ClientId => "client-id";

    public DateTimeOffset? AuthorizationGrantedAtUtc => DateTimeOffset.UtcNow;

    public DateTimeOffset? RefreshCredentialExpiresAtUtc => DateTimeOffset.UtcNow.AddMonths(6);

    public Task InitializeAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;

    public Task ConfigureAndAuthorizeAsync(string? clientId, CancellationToken cancellationToken = default)
    {
        StateChanged?.Invoke();
        return Task.CompletedTask;
    }

    public Task<string?> GetAccessTokenAsync(
        bool forceRefresh = false,
        CancellationToken cancellationToken = default) => Task.FromResult<string?>("token");

    public Task<SpotifyAuthorizationCallbackResult> HandleCallbackAsync(
        SpotifyAuthorizationCallback callback,
        CancellationToken cancellationToken = default) =>
        Task.FromResult(new SpotifyAuthorizationCallbackResult(true, "ok"));
}

internal sealed class TestSongProfileRepository : ISongProfileRepository
{
    public string DatabasePath => "test.db";

    public Task InitializeAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;

    public Task<SongProfileLoadResult> GetOrCreateAndRefreshIdentityAsync(
        CurrentTrack track,
        CancellationToken cancellationToken = default) => throw new InvalidOperationException("No track is expected.");

    public Task<SongProfile> UpdateLastFmEnrichmentAsync(
        string spotifyTrackId,
        LastFmEnrichment enrichment,
        CancellationToken cancellationToken = default) => throw new InvalidOperationException("No track is expected.");
}
