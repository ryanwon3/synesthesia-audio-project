using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json;
using SpotifySynesthesia.AudioEngine.LastFm;
using SpotifySynesthesia.AudioEngine.Profiles;
using SpotifySynesthesia.AudioEngine.Spotify;

namespace SpotifySynesthesia.AudioEngine.Tests;

public sealed class LastFmEnrichmentCoordinatorTests
{
    [Fact]
    public async Task UsesValidCachedEnrichmentWithoutCallingTheProvider()
    {
        SongProfile profile = CreateProfile("A", "Song A");
        LastFmEnrichment cached = CreateEnrichment("artist", "song a", Utc("2026-08-12T12:00:00Z"));
        profile = WithEnrichment(profile, cached);
        ControlledLastFmApiClient api = new();
        MemorySongProfileRepository repository = new(profile);
        await using LastFmEnrichmentCoordinator coordinator = CreateCoordinator(api, repository);
        await coordinator.InitializeAsync(TestContext.Current.CancellationToken);

        coordinator.Activate(profile);

        Assert.Equal(LastFmStatus.Succeeded, coordinator.CurrentState.Status);
        Assert.Equal(LastFmCacheSource.Cached, coordinator.CurrentState.CacheSource);
        Assert.Equal(0, api.TrackInfoCallCount);
    }

    [Fact]
    public async Task DeduplicatesRequestsAndNeverPublishesLateSongAOverSongB()
    {
        SongProfile songA = CreateProfile("A", "Song A");
        SongProfile songB = CreateProfile("B", "Song B");
        ControlledLastFmApiClient api = new();
        MemorySongProfileRepository repository = new(songA, songB);
        await using LastFmEnrichmentCoordinator coordinator = CreateCoordinator(api, repository);
        List<LastFmCoordinatorUpdate> updates = [];
        coordinator.StateChanged += updates.Add;
        await coordinator.InitializeAsync(TestContext.Current.CancellationToken);

        coordinator.Activate(songA);
        coordinator.Activate(songA);
        await api.WaitUntilStartedAsync("Song A", TestContext.Current.CancellationToken);
        coordinator.Activate(songB);
        await api.WaitUntilStartedAsync("Song B", TestContext.Current.CancellationToken);
        api.Complete("Song A");
        await repository.WaitUntilPersistedAsync("A", TestContext.Current.CancellationToken);

        Assert.Equal(1, api.GetCallCount("Song A"));
        Assert.Equal(LastFmStatus.Fetching, coordinator.CurrentState.Status);
        Assert.DoesNotContain(updates, update =>
            update.SpotifyTrackId == "A" && update.State.Status == LastFmStatus.Succeeded);

        api.Complete("Song B");
        await repository.WaitUntilPersistedAsync("B", TestContext.Current.CancellationToken);
        await WaitUntilAsync(
            () => coordinator.CurrentState.Status == LastFmStatus.Succeeded,
            TestContext.Current.CancellationToken);

        Assert.Equal("Song B", coordinator.CurrentState.MatchedTrack);
        Assert.Equal(LastFmCacheSource.Fetched, coordinator.CurrentState.CacheSource);
    }

    [Fact]
    public async Task InvalidCredentialsStopFurtherRequestsUntilTheKeyChanges()
    {
        SongProfile profile = CreateProfile("A", "Song A");
        InvalidCredentialLastFmApiClient api = new();
        MemorySongProfileRepository repository = new(profile);
        MemoryLastFmApiKeyStore keyStore = new("test-key");
        await using LastFmEnrichmentCoordinator coordinator = CreateCoordinator(api, repository, keyStore);
        await coordinator.InitializeAsync(TestContext.Current.CancellationToken);

        coordinator.Activate(profile);
        await WaitUntilAsync(
            () => coordinator.CurrentState.Status == LastFmStatus.InvalidCredentials,
            TestContext.Current.CancellationToken);
        coordinator.Activate(profile);

        Assert.Equal(1, api.CallCount);
        await coordinator.ConfigureApiKeyAsync("replacement-key", TestContext.Current.CancellationToken);
        await WaitUntilAsync(() => api.CallCount == 2, TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task HonorsRetryAfterAndRequeuesTheStillActiveProfileOnce()
    {
        SongProfile profile = CreateProfile("A", "Song A");
        RateLimitThenSuccessLastFmApiClient api = new(TimeSpan.FromMilliseconds(100));
        MemorySongProfileRepository repository = new(profile);
        await using LastFmEnrichmentCoordinator coordinator = CreateCoordinator(api, repository);
        await coordinator.InitializeAsync(TestContext.Current.CancellationToken);

        coordinator.Activate(profile);
        await WaitUntilAsync(
            () => coordinator.CurrentState.Status == LastFmStatus.RateLimited,
            TestContext.Current.CancellationToken);

        Assert.NotNull(coordinator.CurrentState.NextRetryUtc);
        await Task.Delay(25, TestContext.Current.CancellationToken);
        Assert.Equal(1, api.CallCount);
        await WaitUntilAsync(
            () => coordinator.CurrentState.Status == LastFmStatus.Succeeded,
            TestContext.Current.CancellationToken);

        Assert.Equal(2, api.CallCount);
        Assert.Equal(LastFmCacheSource.Fetched, coordinator.CurrentState.CacheSource);
    }

    [Fact]
    public async Task RateLimitCooldownAppliesAcrossProfiles()
    {
        SongProfile songA = CreateProfile("A", "Song A");
        SongProfile songB = CreateProfile("B", "Song B");
        RateLimitThenSuccessLastFmApiClient api = new(TimeSpan.FromMilliseconds(100));
        MemorySongProfileRepository repository = new(songA, songB);
        await using LastFmEnrichmentCoordinator coordinator = CreateCoordinator(api, repository);
        await coordinator.InitializeAsync(TestContext.Current.CancellationToken);

        coordinator.Activate(songA);
        await WaitUntilAsync(
            () => coordinator.CurrentState.Status == LastFmStatus.RateLimited,
            TestContext.Current.CancellationToken);
        coordinator.Activate(songB);
        await Task.Delay(25, TestContext.Current.CancellationToken);

        Assert.Equal(1, api.CallCount);
        Assert.Equal(LastFmStatus.RateLimited, coordinator.CurrentState.Status);
        await WaitUntilAsync(
            () => coordinator.CurrentState.Status == LastFmStatus.Succeeded,
            TestContext.Current.CancellationToken);

        Assert.Equal(["Song A", "Song B"], api.RequestedTracks);
    }

    [Fact]
    public async Task ReplacingCredentialsCancelsOutstandingWorkAndStartsFreshWork()
    {
        SongProfile profile = CreateProfile("A", "Song A");
        CancellationAwareLastFmApiClient api = new();
        MemorySongProfileRepository repository = new(profile);
        await using LastFmEnrichmentCoordinator coordinator = CreateCoordinator(api, repository);
        await coordinator.InitializeAsync(TestContext.Current.CancellationToken);
        coordinator.Activate(profile);
        await api.FirstRequestStarted.Task.WaitAsync(TestContext.Current.CancellationToken);

        await coordinator.ConfigureApiKeyAsync("replacement-key", TestContext.Current.CancellationToken);
        await api.FirstRequestCancelled.Task.WaitAsync(TestContext.Current.CancellationToken);
        await WaitUntilAsync(
            () => coordinator.CurrentState.Status == LastFmStatus.NoMatch,
            TestContext.Current.CancellationToken);

        Assert.Equal(2, api.CallCount);
    }

    [Fact]
    public async Task ShutdownCancelsOutstandingProviderWork()
    {
        SongProfile profile = CreateProfile("A", "Song A");
        CancellationAwareLastFmApiClient api = new();
        MemorySongProfileRepository repository = new(profile);
        LastFmEnrichmentCoordinator coordinator = CreateCoordinator(api, repository);
        await coordinator.InitializeAsync(TestContext.Current.CancellationToken);
        coordinator.Activate(profile);
        await api.FirstRequestStarted.Task.WaitAsync(TestContext.Current.CancellationToken);

        await coordinator.DisposeAsync();

        await api.FirstRequestCancelled.Task.WaitAsync(TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task LimitsProviderWorkToTwoConcurrentProfiles()
    {
        SongProfile songA = CreateProfile("A", "Song A");
        SongProfile songB = CreateProfile("B", "Song B");
        SongProfile songC = CreateProfile("C", "Song C");
        ControlledLastFmApiClient api = new();
        MemorySongProfileRepository repository = new(songA, songB, songC);
        await using LastFmEnrichmentCoordinator coordinator = CreateCoordinator(api, repository);
        await coordinator.InitializeAsync(TestContext.Current.CancellationToken);

        coordinator.Activate(songA);
        await api.WaitUntilStartedAsync("Song A", TestContext.Current.CancellationToken);
        coordinator.Activate(songB);
        await api.WaitUntilStartedAsync("Song B", TestContext.Current.CancellationToken);
        coordinator.Activate(songC);
        await Task.Delay(25, TestContext.Current.CancellationToken);

        Assert.False(api.HasStarted("Song C"));
        api.Complete("Song A");
        await api.WaitUntilStartedAsync("Song C", TestContext.Current.CancellationToken);
        api.Complete("Song B");
        api.Complete("Song C");
        await repository.WaitUntilPersistedAsync("C", TestContext.Current.CancellationToken);
    }

    [Theory]
    [InlineData(29, 0)]
    [InlineData(31, 1)]
    public async Task NoMatchCacheExpiresAfterThirtyDays(int ageDays, int expectedCalls)
    {
        DateTimeOffset now = Utc("2026-08-19T12:00:00Z");
        SongProfile profile = CreateProfile("A", "Song A");
        LastFmEnrichment noMatch = CreateEnrichment("artist", "song a", now.AddDays(-ageDays)) with
        {
            Status = LastFmStatus.NoMatch,
            TrackTags = [],
            ArtistTags = [],
            MatchedTrack = null,
            MatchedArtist = null,
            MatchQuality = null,
        };
        profile = WithEnrichment(profile, noMatch);
        CountingNoMatchLastFmApiClient api = new();
        MemorySongProfileRepository repository = new(profile);
        await using LastFmEnrichmentCoordinator coordinator = CreateCoordinator(
            api,
            repository,
            timeProvider: new FixedTimeProvider(now));
        await coordinator.InitializeAsync(TestContext.Current.CancellationToken);

        coordinator.Activate(profile);
        await WaitUntilAsync(
            () => api.CallCount == expectedCalls || coordinator.CurrentState.Status == LastFmStatus.NoMatch,
            TestContext.Current.CancellationToken);

        Assert.Equal(expectedCalls, api.CallCount);
    }

    [Theory]
    [InlineData("other artist", "song a", LastFmEnrichment.CurrentSchemaVersion)]
    [InlineData("artist", "other song", LastFmEnrichment.CurrentSchemaVersion)]
    [InlineData("artist", "song a", 1)]
    [InlineData("artist", "song a", 0)]
    public async Task RefetchesWhenLookupFingerprintOrSchemaChanges(
        string lookupArtist,
        string lookupTrack,
        int schemaVersion)
    {
        SongProfile profile = CreateProfile("A", "Song A");
        profile = WithEnrichment(
            profile,
            CreateEnrichment(lookupArtist, lookupTrack, Utc("2026-08-12T12:00:00Z")) with
            {
                SchemaVersion = schemaVersion,
            });
        CountingNoMatchLastFmApiClient api = new();
        MemorySongProfileRepository repository = new(profile);
        await using LastFmEnrichmentCoordinator coordinator = CreateCoordinator(api, repository);
        await coordinator.InitializeAsync(TestContext.Current.CancellationToken);

        coordinator.Activate(profile);
        await WaitUntilAsync(
            () => api.CallCount == 1 && coordinator.CurrentState.Status == LastFmStatus.NoMatch,
            TestContext.Current.CancellationToken);

        Assert.Equal(LastFmStatus.NoMatch, coordinator.CurrentState.Status);
    }

    [Fact]
    public async Task TransientFailureRetriesWhenTheProfileIsActivatedAgain()
    {
        SongProfile profile = CreateProfile("A", "Song A");
        UnavailableThenSuccessLastFmApiClient api = new();
        MemorySongProfileRepository repository = new(profile);
        await using LastFmEnrichmentCoordinator coordinator = CreateCoordinator(api, repository);
        await coordinator.InitializeAsync(TestContext.Current.CancellationToken);

        coordinator.Activate(profile);
        await WaitUntilAsync(
            () => coordinator.CurrentState.Status == LastFmStatus.Unavailable,
            TestContext.Current.CancellationToken);
        coordinator.Activate(profile);
        await WaitUntilAsync(
            () => coordinator.CurrentState.Status == LastFmStatus.Succeeded,
            TestContext.Current.CancellationToken);

        Assert.Equal(2, api.CallCount);
    }

    private static LastFmEnrichmentCoordinator CreateCoordinator(
        ILastFmApiClient api,
        MemorySongProfileRepository repository,
        MemoryLastFmApiKeyStore? keyStore = null,
        TimeProvider? timeProvider = null)
    {
        LastFmOptions options = new()
        {
            RequestTimeout = TimeSpan.FromSeconds(2),
            DefaultRateLimitCooldown = TimeSpan.FromMilliseconds(20),
        };
        return new LastFmEnrichmentCoordinator(
            new LastFmEnrichmentService(api, new LastFmTagNormalizer(options), options, timeProvider),
            repository,
            keyStore ?? new MemoryLastFmApiKeyStore("test-key"),
            options,
            timeProvider);
    }

    private static SongProfile CreateProfile(string id, string title) => new(
        new SongProfileIdentity(
            id,
            $"spotify:track:{id}",
            null,
            title,
            [new SpotifyArtistIdentity("artist-id", "Artist")],
            null,
            180_000,
            false),
        new ReservedSongProfileData(null, null, null, null, null),
        new SongProfileCacheMetadata(Utc("2026-08-12T12:00:00Z"), Utc("2026-08-12T12:00:00Z"), 2));

    private static LastFmEnrichment CreateEnrichment(
        string lookupArtist,
        string lookupTrack,
        DateTimeOffset retrievedAt) => new(
            LastFmEnrichment.ProviderSource,
            LastFmStatus.Succeeded,
            [new LastFmTag("dreamy", 1)],
            [new LastFmTag("dream pop", 1)],
            "Song A",
            "Artist",
            null,
            null,
            LastFmMatchQuality.Exact,
            lookupArtist,
            lookupTrack,
            retrievedAt,
            LastFmEnrichment.CurrentSchemaVersion);

    private static SongProfile WithEnrichment(SongProfile profile, LastFmEnrichment enrichment) => profile with
    {
        Reserved = profile.Reserved with
        {
            Metadata = SongProfileMetadata.MergeLastFm(profile.Reserved.Metadata, enrichment),
        },
    };

    private static async Task WaitUntilAsync(Func<bool> condition, CancellationToken cancellationToken)
    {
        while (!condition())
        {
            await Task.Delay(10, cancellationToken);
        }
    }

    private static DateTimeOffset Utc(string value) => DateTimeOffset.Parse(value, CultureInfo.InvariantCulture);

    private sealed class ControlledLastFmApiClient : ILastFmApiClient
    {
        private readonly ConcurrentDictionary<string, TaskCompletionSource> _started = new(StringComparer.Ordinal);
        private readonly ConcurrentDictionary<string, TaskCompletionSource> _completions = new(StringComparer.Ordinal);
        private readonly ConcurrentDictionary<string, int> _calls = new(StringComparer.Ordinal);

        public int TrackInfoCallCount => _calls.Values.Sum();

        public int GetCallCount(string track) => _calls.GetValueOrDefault(track);

        public bool HasStarted(string track) => _started.TryGetValue(track, out TaskCompletionSource? started) &&
            started.Task.IsCompleted;

        public async Task<LastFmApiResult<LastFmTrackInfo>> GetTrackInfoAsync(
            string apiKey,
            string artist,
            string track,
            TimeSpan requestTimeout,
            CancellationToken cancellationToken = default)
        {
            _calls.AddOrUpdate(track, 1, (_, count) => count + 1);
            _started.GetOrAdd(track, _ => new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously))
                .TrySetResult();
            await _completions
                .GetOrAdd(track, _ => new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously))
                .Task.WaitAsync(cancellationToken);
            return new LastFmApiResult<LastFmTrackInfo>(
                LastFmApiResultKind.Success,
                new LastFmTrackInfo(track, artist, null, null, 180_000, false));
        }

        public Task<LastFmApiResult<IReadOnlyList<LastFmProviderTag>>> GetTrackTopTagsAsync(
            string apiKey,
            LastFmTrackInfo track,
            TimeSpan requestTimeout,
            CancellationToken cancellationToken = default) => Task.FromResult(
                new LastFmApiResult<IReadOnlyList<LastFmProviderTag>>(
                    LastFmApiResultKind.Success,
                    [new LastFmProviderTag("dreamy", 100, 0)]));

        public Task<LastFmApiResult<IReadOnlyList<LastFmProviderTag>>> GetArtistTopTagsAsync(
            string apiKey,
            LastFmTrackInfo track,
            TimeSpan requestTimeout,
            CancellationToken cancellationToken = default) => Task.FromResult(
                new LastFmApiResult<IReadOnlyList<LastFmProviderTag>>(
                    LastFmApiResultKind.Success,
                    [new LastFmProviderTag("dream pop", 50, 0)]));

        public Task WaitUntilStartedAsync(string track, CancellationToken cancellationToken) => _started
            .GetOrAdd(track, _ => new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously))
            .Task.WaitAsync(cancellationToken);

        public void Complete(string track) => _completions
            .GetOrAdd(track, _ => new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously))
            .TrySetResult();
    }

    private sealed class RateLimitThenSuccessLastFmApiClient(TimeSpan retryAfter) : ILastFmApiClient
    {
        private int _callCount;
        private readonly ConcurrentQueue<string> _requestedTracks = new();

        public int CallCount => Volatile.Read(ref _callCount);

        public string[] RequestedTracks => _requestedTracks.ToArray();

        public Task<LastFmApiResult<LastFmTrackInfo>> GetTrackInfoAsync(
            string apiKey,
            string artist,
            string track,
            TimeSpan requestTimeout,
            CancellationToken cancellationToken = default)
        {
            _requestedTracks.Enqueue(track);
            int call = Interlocked.Increment(ref _callCount);
            return Task.FromResult(call == 1
                ? new LastFmApiResult<LastFmTrackInfo>(
                    LastFmApiResultKind.RateLimited,
                    ErrorCategory: LastFmErrorCategory.RateLimit,
                    RetryAfter: retryAfter)
                : new LastFmApiResult<LastFmTrackInfo>(
                    LastFmApiResultKind.Success,
                    new LastFmTrackInfo(track, artist, null, null, 180_000, false)));
        }

        public Task<LastFmApiResult<IReadOnlyList<LastFmProviderTag>>> GetTrackTopTagsAsync(
            string apiKey,
            LastFmTrackInfo track,
            TimeSpan requestTimeout,
            CancellationToken cancellationToken = default) => SuccessfulTags();

        public Task<LastFmApiResult<IReadOnlyList<LastFmProviderTag>>> GetArtistTopTagsAsync(
            string apiKey,
            LastFmTrackInfo track,
            TimeSpan requestTimeout,
            CancellationToken cancellationToken = default) => SuccessfulTags();

        private static Task<LastFmApiResult<IReadOnlyList<LastFmProviderTag>>> SuccessfulTags() =>
            Task.FromResult(new LastFmApiResult<IReadOnlyList<LastFmProviderTag>>(
                LastFmApiResultKind.Success,
                [new LastFmProviderTag("dreamy", 100, 0)]));
    }

    private sealed class CancellationAwareLastFmApiClient : ILastFmApiClient
    {
        private int _callCount;

        public TaskCompletionSource FirstRequestStarted { get; } = new(
            TaskCreationOptions.RunContinuationsAsynchronously);

        public TaskCompletionSource FirstRequestCancelled { get; } = new(
            TaskCreationOptions.RunContinuationsAsynchronously);

        public int CallCount => Volatile.Read(ref _callCount);

        public async Task<LastFmApiResult<LastFmTrackInfo>> GetTrackInfoAsync(
            string apiKey,
            string artist,
            string track,
            TimeSpan requestTimeout,
            CancellationToken cancellationToken = default)
        {
            Interlocked.Increment(ref _callCount);
            if (string.Equals(apiKey, "test-key", StringComparison.Ordinal))
            {
                FirstRequestStarted.TrySetResult();
                try
                {
                    await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    FirstRequestCancelled.TrySetResult();
                    throw;
                }
            }

            return new LastFmApiResult<LastFmTrackInfo>(
                LastFmApiResultKind.NoMatch,
                ErrorCategory: LastFmErrorCategory.NoMatch);
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

    private sealed class InvalidCredentialLastFmApiClient : ILastFmApiClient
    {
        public int CallCount { get; private set; }

        public Task<LastFmApiResult<LastFmTrackInfo>> GetTrackInfoAsync(
            string apiKey,
            string artist,
            string track,
            TimeSpan requestTimeout,
            CancellationToken cancellationToken = default)
        {
            CallCount++;
            return Task.FromResult(new LastFmApiResult<LastFmTrackInfo>(
                LastFmApiResultKind.InvalidCredentials,
                ErrorCategory: LastFmErrorCategory.InvalidApiKey));
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

    private sealed class CountingNoMatchLastFmApiClient : ILastFmApiClient
    {
        public int CallCount { get; private set; }

        public Task<LastFmApiResult<LastFmTrackInfo>> GetTrackInfoAsync(
            string apiKey,
            string artist,
            string track,
            TimeSpan requestTimeout,
            CancellationToken cancellationToken = default)
        {
            CallCount++;
            return Task.FromResult(new LastFmApiResult<LastFmTrackInfo>(
                LastFmApiResultKind.NoMatch,
                ErrorCategory: LastFmErrorCategory.NoMatch));
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

    private sealed class UnavailableThenSuccessLastFmApiClient : ILastFmApiClient
    {
        private int _callCount;

        public int CallCount => Volatile.Read(ref _callCount);

        public Task<LastFmApiResult<LastFmTrackInfo>> GetTrackInfoAsync(
            string apiKey,
            string artist,
            string track,
            TimeSpan requestTimeout,
            CancellationToken cancellationToken = default)
        {
            int call = Interlocked.Increment(ref _callCount);
            return Task.FromResult(call == 1
                ? new LastFmApiResult<LastFmTrackInfo>(
                    LastFmApiResultKind.Unavailable,
                    ErrorCategory: LastFmErrorCategory.Network)
                : new LastFmApiResult<LastFmTrackInfo>(
                    LastFmApiResultKind.Success,
                    new LastFmTrackInfo(track, artist, null, null, 180_000, false)));
        }

        public Task<LastFmApiResult<IReadOnlyList<LastFmProviderTag>>> GetTrackTopTagsAsync(
            string apiKey,
            LastFmTrackInfo track,
            TimeSpan requestTimeout,
            CancellationToken cancellationToken = default) => SuccessfulTags();

        public Task<LastFmApiResult<IReadOnlyList<LastFmProviderTag>>> GetArtistTopTagsAsync(
            string apiKey,
            LastFmTrackInfo track,
            TimeSpan requestTimeout,
            CancellationToken cancellationToken = default) => SuccessfulTags();

        private static Task<LastFmApiResult<IReadOnlyList<LastFmProviderTag>>> SuccessfulTags() =>
            Task.FromResult(new LastFmApiResult<IReadOnlyList<LastFmProviderTag>>(
                LastFmApiResultKind.Success,
                [new LastFmProviderTag("dreamy", 100, 0)]));
    }

    private sealed class MemorySongProfileRepository(params SongProfile[] profiles) : ISongProfileRepository
    {
        private readonly ConcurrentDictionary<string, SongProfile> _profiles = new(
            profiles.ToDictionary(profile => profile.Identity.SpotifyTrackId, StringComparer.Ordinal),
            StringComparer.Ordinal);
        private readonly ConcurrentDictionary<string, TaskCompletionSource> _persisted = new(StringComparer.Ordinal);

        public string DatabasePath => "memory.db";

        public Task InitializeAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;

        public Task<SongProfileLoadResult> GetOrCreateAndRefreshIdentityAsync(
            CurrentTrack track,
            CancellationToken cancellationToken = default) => throw new NotSupportedException();

        public Task<SongProfile> UpdateLastFmEnrichmentAsync(
            string spotifyTrackId,
            LastFmEnrichment enrichment,
            CancellationToken cancellationToken = default)
        {
            SongProfile updated = _profiles.AddOrUpdate(
                spotifyTrackId,
                _ => throw new InvalidOperationException(),
                (_, profile) => WithEnrichment(profile, enrichment));
            _persisted.GetOrAdd(
                spotifyTrackId,
                _ => new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously)).TrySetResult();
            return Task.FromResult(updated);
        }

        public Task WaitUntilPersistedAsync(string trackId, CancellationToken cancellationToken) => _persisted
            .GetOrAdd(trackId, _ => new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously))
            .Task.WaitAsync(cancellationToken);
    }

    private sealed class MemoryLastFmApiKeyStore(string? apiKey) : ILastFmApiKeyStore
    {
        private string? _apiKey = apiKey;

        public Task<string?> LoadAsync(CancellationToken cancellationToken = default) => Task.FromResult(_apiKey);

        public Task SaveAsync(string value, CancellationToken cancellationToken = default)
        {
            _apiKey = value;
            return Task.CompletedTask;
        }

        public Task ClearAsync(CancellationToken cancellationToken = default)
        {
            _apiKey = null;
            return Task.CompletedTask;
        }
    }

    private sealed class FixedTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => utcNow;
    }
}
