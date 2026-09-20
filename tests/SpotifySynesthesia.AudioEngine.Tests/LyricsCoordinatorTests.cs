using System.Text.Json;
using Microsoft.Data.Sqlite;
using SpotifySynesthesia.AudioEngine.Database;
using SpotifySynesthesia.AudioEngine.Lyrics;
using SpotifySynesthesia.AudioEngine.OpenAi;
using SpotifySynesthesia.AudioEngine.Profiles;
using SpotifySynesthesia.AudioEngine.Spotify;

namespace SpotifySynesthesia.AudioEngine.Tests;

public sealed class LyricsCoordinatorTests
{
    [Fact]
    public async Task AuthenticationFailureHaltsFurtherPaidRequestsAcrossSongs()
    {
        var provider = new Provider(); var analyzer = new Analyzer { Error = new EnrichmentException("API key rejected") };
        await using var coordinator = Create(provider, analyzer, new Cache());
        coordinator.Observe(Track(), Profile(), null, false);
        await coordinator.InitializeAsync(true, TestContext.Current.CancellationToken);
        await WaitAsync(() => coordinator.State.Error == "API key rejected");
        coordinator.Observe(Track() with { SpotifyTrackId = "other" }, Profile() with { Identity = LyricsAnalysisTests.Identity with { SpotifyTrackId = "other" } }, null, false);
        await WaitAsync(() => coordinator.State.Status.Contains("paused", StringComparison.Ordinal));
        Assert.Equal(1, analyzer.Calls);
    }
    [Fact]
    public async Task TransientProviderErrorsHaveBoundedRetries()
    {
        var provider = new Provider { Error = new EnrichmentException("Lyrics service unavailable", true, TimeSpan.FromMilliseconds(5)) };
        var analyzer = new Analyzer();
        await using var coordinator = Create(provider, analyzer, new Cache());
        coordinator.Observe(Track(), Profile(), null, false);
        await coordinator.InitializeAsync(true, TestContext.Current.CancellationToken);
        await WaitAsync(() => coordinator.State.Error is not null);
        Assert.Equal(3, provider.Calls); Assert.Equal(0, analyzer.Calls);
    }
    [Fact]
    public async Task CachedReplayDoesNotCallEitherProviderEvenWithoutAKey()
    {
        var provider = new Provider(); var analyzer = new Analyzer(); var cache = new Cache();
        cache.Entry = Entry();
        await using var coordinator = Create(provider, analyzer, cache);
        coordinator.Observe(Track(), Profile(), null, false);
        await coordinator.InitializeAsync(false, TestContext.Current.CancellationToken);
        await WaitAsync(() => coordinator.State.Cached);
        Assert.Equal(0, provider.Calls); Assert.Equal(0, analyzer.Calls);
        Assert.NotNull(coordinator.State.Profile);
    }
    [Fact]
    public async Task AnalyzesOnceAndReusesResultOnReplay()
    {
        var provider = new Provider(); var analyzer = new Analyzer(); var cache = new Cache();
        await using var coordinator = Create(provider, analyzer, cache);
        coordinator.Observe(Track(), Profile(), null, false);
        await coordinator.InitializeAsync(true, TestContext.Current.CancellationToken);
        await WaitAsync(() => coordinator.State.Status == "Ready");
        coordinator.Observe(null, null, null, false);
        coordinator.Observe(Track(), Profile(), null, false);
        // Returning to an attempted track must load its cached state, not leave it at Waiting.
        await WaitAsync(() => coordinator.State.Status == "Ready");
        Assert.Equal(1, provider.Calls); Assert.Equal(1, analyzer.Calls);
    }
    [Fact]
    public async Task PausedTrackNeverStartsPaidAnalysis()
    {
        var provider = new Provider(); var analyzer = new Analyzer();
        await using var coordinator = Create(provider, analyzer, new Cache());
        coordinator.Observe(Track() with { IsPlaying = false }, Profile(), null, false);
        await coordinator.InitializeAsync(true, TestContext.Current.CancellationToken);
        await WaitAsync(() => coordinator.State.Status.Contains("10 seconds", StringComparison.Ordinal));
        Assert.Equal(0, provider.Calls); Assert.Equal(0, analyzer.Calls);
    }
    [Fact]
    public async Task SkippingSongCannotPublishItsLateAnalysis()
    {
        var provider = new Provider(); var analyzer = new Analyzer { Hold = true };
        await using var coordinator = Create(provider, analyzer, new Cache());
        coordinator.Observe(Track(), Profile(), null, false);
        await coordinator.InitializeAsync(true, TestContext.Current.CancellationToken);
        await WaitAsync(() => analyzer.Calls == 1);
        coordinator.Observe(null, null, null, false);
        analyzer.Completion.TrySetResult(new(LyricsAnalysisTests.Traits, []));
        await WaitAsync(() => analyzer.Finished);
        Assert.Equal("Waiting for song", coordinator.State.Status);
        Assert.Null(coordinator.State.Profile);
    }
    [Fact]
    public async Task LyricsTableDoesNotOverwritePersonalOrLastFmColumns()
    {
        string path = Path.Combine(Path.GetTempPath(), $"synesthesia-lyrics-{Guid.NewGuid():N}.db");
        try
        {
            var repository = new SqliteSongProfileRepository(path);
            await repository.InitializeAsync(TestContext.Current.CancellationToken);
            await repository.GetOrCreateAndRefreshIdentityAsync(Track(), TestContext.Current.CancellationToken);
            using (var connection = new SqliteConnection($"Data Source={path}"))
            {
                await connection.OpenAsync(TestContext.Current.CancellationToken);
                using var command = connection.CreateCommand();
                command.CommandText = "UPDATE song_profiles SET personal_overrides_json='{\"warmth\":0.4}', metadata_json='{\"lastFmFixture\":true}'";
                await command.ExecuteNonQueryAsync(TestContext.Current.CancellationToken);
            }
            var cache = new SqliteLyricsCache(path);
            await cache.SaveAsync("fixture", Entry(), TestContext.Current.CancellationToken);
            Assert.NotNull(await cache.GetAsync("fixture", "gpt-5-mini", TestContext.Current.CancellationToken));
            Assert.Null(await cache.GetAsync("fixture", "gpt-5", TestContext.Current.CancellationToken));
            var result = await repository.GetOrCreateAndRefreshIdentityAsync(Track(), TestContext.Current.CancellationToken);
            Assert.True(result.Profile.Reserved.Metadata!.Value.GetProperty("lastFmFixture").GetBoolean());
            Assert.Equal(0.4, result.Profile.Reserved.PersonalOverrides!.Value.GetProperty("warmth").GetDouble());
            await cache.SaveAsync("fixture", Entry() with { PromptVersion = -1 }, TestContext.Current.CancellationToken);
            Assert.Null(await cache.GetAsync("fixture", "gpt-5-mini", TestContext.Current.CancellationToken));
        }
        finally
        {
            SqliteConnection.ClearAllPools();
            foreach (string suffix in new[] { "", "-wal", "-shm" }) File.Delete(path + suffix);
        }
    }
    private static LyricAnalysisCache Entry()
    {
        var lyrics = new LyricsDocument("fixture", "1", false, [new("Original fixture", 1000)]);
        return new(SqliteLyricsCache.Key("fixture", lyrics.Hash, "gpt-5-mini"), "gpt-5-mini", 1, 1,
            lyrics, new(LyricsAnalysisTests.Traits, []), DateTimeOffset.UtcNow);
    }
    private static CurrentTrack Track() => new("fixture", null, null, "Test song", [new(null, "Test artist")],
        new(null, "Test album", null, null, null), 60000, false, 0, true, DateTimeOffset.UtcNow);
    private static SongProfile Profile() => new(LyricsAnalysisTests.Identity, new(null, null, null, null, null), new(DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, 2));
    private static LyricsAnalysisCoordinator Create(Provider provider, Analyzer analyzer, Cache cache) =>
        new(provider, analyzer, cache, new Keys(), dwell: TimeSpan.Zero,
            settingsPath: Path.Combine(Path.GetTempPath(), $"unused-lyrics-settings-{Guid.NewGuid():N}.json"));
    private static async Task WaitAsync(Func<bool> condition)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(5));
        while (!condition()) await Task.Delay(20, timeout.Token);
    }
    private sealed class Provider : ILyricsProvider
    {
        public int Calls;
        public EnrichmentException? Error;
        public Task<LyricsDocument?> GetAsync(SongProfileIdentity identity, CancellationToken cancellationToken)
        { Interlocked.Increment(ref Calls); if (Error is not null) throw Error; return Task.FromResult<LyricsDocument?>(Entry().Lyrics); }
    }
    private sealed class Analyzer : ILyricsAnalyzer
    {
        public int Calls;
        public bool Hold, Finished;
        public EnrichmentException? Error;
        public TaskCompletionSource<SongVisualProfile> Completion { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public async Task<SongVisualProfile> AnalyzeAsync(string apiKey, string model, SongProfileIdentity identity, LyricsDocument lyrics,
            IReadOnlyList<string> tags, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref Calls);
            if (Error is not null) throw Error;
            var result = Hold ? await Completion.Task : new(LyricsAnalysisTests.Traits, []);
            Finished = true; return result;
        }
    }
    private sealed class Cache : ILyricsCache
    {
        public LyricAnalysisCache? Entry;
        public Task<LyricAnalysisCache?> GetAsync(string trackId, string model, CancellationToken cancellationToken) => Task.FromResult(Entry);
        public Task SaveAsync(string trackId, LyricAnalysisCache entry, CancellationToken cancellationToken) { Entry = entry; return Task.CompletedTask; }
    }
    private sealed class Keys : IOpenAiApiKeyStore
    {
        public Task<string?> LoadAsync(CancellationToken cancellationToken = default) => Task.FromResult<string?>("fixture-key");
        public Task SaveAsync(string apiKey, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task ClearAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
    }
}
