using System.Text.Json;
using Microsoft.Data.Sqlite;
using SpotifySynesthesia.AudioEngine.Infrastructure;
using SpotifySynesthesia.AudioEngine.LastFm;
using SpotifySynesthesia.AudioEngine.OpenAi;
using SpotifySynesthesia.AudioEngine.Profiles;
using SpotifySynesthesia.AudioEngine.Spotify;

namespace SpotifySynesthesia.AudioEngine.Lyrics;

public sealed class LyricsAnalysisCoordinator : IAsyncDisposable
{
    private readonly object _sync = new();
    private readonly ILyricsProvider _provider;
    private readonly ILyricsAnalyzer _analyzer;
    private readonly ILyricsCache _cache;
    private readonly IOpenAiApiKeyStore _keys;
    private readonly TimeProvider _clock;
    private readonly TimeSpan _dwell;
    private readonly CancellationTokenSource _shutdown = new();
    private readonly SemaphoreSlim _serial = new(1, 1);
    private readonly HashSet<string> _attempted = [];
    private CancellationTokenSource? _activeJob;
    private readonly List<Task> _jobs = [];
    private SongProfileIdentity? _identity;
    private string[] _tags = [];
    private DateTimeOffset? _playingSince;
    private bool _configured, _halted, _force;
    private bool _cacheChecked;
    private string? _activeId;
    private string? _jobKey;
    private Task? _loop;
    private readonly string _settingsPath;

    public LyricsAnalysisCoordinator(ILyricsProvider provider, ILyricsAnalyzer analyzer, ILyricsCache cache,
        IOpenAiApiKeyStore keys, TimeProvider? clock = null, TimeSpan? dwell = null, string? settingsPath = null)
    {
        _provider = provider; _analyzer = analyzer; _cache = cache; _keys = keys;
        _clock = clock ?? TimeProvider.System; _dwell = dwell ?? TimeSpan.FromSeconds(10);
        _settingsPath = settingsPath ?? Path.Combine(Path.GetDirectoryName(LocalAppPaths.SettingsPath)!, "lyrics-settings.json");
    }
    public event Action? StateChanged;
    public LyricsAnalysisState State { get; private set; } = new("Waiting for song");
    public LyricsAnalysisSettings Settings { get; private set; } = new();

    public async Task InitializeAsync(bool configured, CancellationToken token)
    {
        try
        {
            if (File.Exists(_settingsPath))
            {
                var loaded = JsonSerializer.Deserialize<LyricsAnalysisSettings>(await File.ReadAllTextAsync(_settingsPath, token).ConfigureAwait(false));
                if (loaded is not null && IsModelAllowed(loaded.Model)) Settings = loaded;
            }
        }
        catch (Exception error) when (error is IOException or JsonException or UnauthorizedAccessException) { }
        _configured = configured;
        _loop = Task.Run(() => RunAsync(_shutdown.Token), CancellationToken.None);
    }

    public void Observe(CurrentTrack? track, SongProfile? profile, LastFmContextState? tags, bool stale)
    {
        lock (_sync)
        {
            string? id = track?.SpotifyTrackId;
            bool changed = id != _activeId;
            if (changed)
            {
                _activeJob?.Cancel(); _activeJob = null; _jobKey = null;
                _activeId = id; _playingSince = null; _force = false; _cacheChecked = false;
                State = new(id is null ? "Waiting for song" : "Waiting for playback");
            }
            _identity = profile?.Identity;
            _tags = (tags?.TrackTags ?? []).Concat(tags?.ArtistTags ?? []).Select(t => t.Name)
                .Where(IsRecognizedTag).Distinct(StringComparer.OrdinalIgnoreCase).Take(16).ToArray();
            if (track?.IsPlaying != true || stale) _playingSince = null;
            else _playingSince ??= _clock.GetUtcNow();
        }
    }

    public async Task ConfigureAsync(LyricsAnalysisSettings settings, CancellationToken token)
    {
        if (!IsModelAllowed(settings.Model)) throw new ArgumentException("Select a supported analysis model.", nameof(settings));
        await AtomicFile.WriteAllBytesAsync(_settingsPath, JsonSerializer.SerializeToUtf8Bytes(settings), token).ConfigureAwait(false);
        lock (_sync)
        {
            Settings = settings; _halted = false; _activeJob?.Cancel(); _activeJob = null; _jobKey = null;
            _playingSince = null; _cacheChecked = false; State = new(settings.Automatic ? "Waiting for playback" : "Automatic analysis off");
        }
        StateChanged?.Invoke();
    }
    public void CredentialsChanged(bool configured)
    {
        lock (_sync)
        {
            _configured = configured; _halted = false; _attempted.Clear(); _cacheChecked = false;
            _activeJob?.Cancel(); _activeJob = null; _jobKey = null;
        }
    }
    public void Reanalyze()
    {
        lock (_sync) { if (_jobKey is null) { _force = true; _halted = false; } }
    }
    public static bool IsModelAllowed(string model) => model is "gpt-5-mini" or "gpt-5";
    private static bool IsRecognizedTag(string tag) => tag.Length <= 40 &&
        tag.ToLowerInvariant().Split([' ', '-']).Any(word => word is "sad" or "melancholic" or "dreamy" or "ethereal" or
            "happy" or "joyful" or "uplifting" or "aggressive" or "dark" or "calm" or "ambient" or "pop" or "rock" or
            "metal" or "electronic" or "jazz" or "classical" or "acoustic" or "folk" or "soul");

    private async Task RunAsync(CancellationToken token)
    {
        try
        {
            while (!token.IsCancellationRequested)
            {
                lock (_sync)
                {
                    _jobs.RemoveAll(task => task.IsCompleted);
                    if (_identity is { } identity && identity.SpotifyTrackId == _activeId && _jobKey is null)
                    {
                        string key = identity.SpotifyTrackId + ":" + Settings.Model;
                        // Check cache immediately, even without a key or when automation is off.
                        bool ready = _force || _playingSince.HasValue && _clock.GetUtcNow() - _playingSince.Value >= _dwell;
                        bool canAnalyze = _configured && !_halted && Settings.Automatic && ready && !_attempted.Contains(key);
                        if (!_cacheChecked || canAnalyze || _force)
                        {
                            bool paid = canAnalyze || _configured && _force;
                            _activeJob = CancellationTokenSource.CreateLinkedTokenSource(token);
                            var job = _activeJob;
                            _jobKey = key;
                            bool force = _force; _force = false;
                            _jobs.Add(Task.Run(() => ProcessAsync(identity, Settings.Model, key, paid, force, _tags, job), CancellationToken.None));
                        }
                    }
                }
                await Task.Delay(TimeSpan.FromSeconds(1), _clock, token).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
    }

    private async Task ProcessAsync(SongProfileIdentity identity, string model, string key, bool paid, bool force,
        string[] tags, CancellationTokenSource job)
    {
        CancellationToken token = job.Token;
        bool entered = false;
        try
        {
            await _serial.WaitAsync(token).ConfigureAwait(false); entered = true;
            LyricAnalysisCache? cached = await _cache.GetAsync(identity.SpotifyTrackId, model, token).ConfigureAwait(false);
            lock (_sync) { if (ReferenceEquals(_activeJob, job)) _cacheChecked = true; }
            if (cached is not null && !force)
            {
                SetState(new("Ready", cached.Lyrics.Source, cached.Lyrics.Timed, true, Profile: cached.Visual), job);
                lock (_sync) _attempted.Add(key);
                return;
            }
            if (!paid)
            {
                SetState(new(!_configured ? "Add an OpenAI key" : _halted ? "Analysis paused; check API settings" :
                    !Settings.Automatic ? "Automatic analysis off" : _attempted.Contains(key) ? "No cached analysis — reanalyze to retry" :
                    "Waiting for 10 seconds of playback"), job);
                return;
            }
            // Mark before the paid request: failed/ambiguous requests never silently spend again on replay.
            lock (_sync) _attempted.Add(key);
            SetState(new("Finding lyrics"), job);
            LyricsDocument? lyrics = await RetryAsync(() => _provider.GetAsync(identity, token), token).ConfigureAwait(false);
            if (lyrics is null || lyrics.Instrumental || lyrics.Lines.Count == 0)
            {
                SetState(new(lyrics?.Instrumental == true ? "Instrumental — using tags" : "No matching lyrics — using tags", lyrics?.Source), job);
                return;
            }
            string? apiKey = await _keys.LoadAsync(token).ConfigureAwait(false);
            if (apiKey is null) { SetState(new("Add an OpenAI key"), job); return; }
            SetState(new("Analyzing lyrics", lyrics.Source, lyrics.Timed), job);
            SongVisualProfile visual = await RetryAsync(() => _analyzer.AnalyzeAsync(apiKey, model, identity, lyrics, tags, token), token).ConfigureAwait(false);
            var entry = new LyricAnalysisCache(SqliteLyricsCache.Key(identity.SpotifyTrackId, lyrics.Hash, model), model,
                OpenAiLyricsAnalyzer.PromptVersion, OpenAiLyricsAnalyzer.SchemaVersion, lyrics, visual, _clock.GetUtcNow());
            await _cache.SaveAsync(identity.SpotifyTrackId, entry, token).ConfigureAwait(false);
            SetState(new("Ready", lyrics.Source, lyrics.Timed, Profile: visual), job);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        catch (Exception error) when (error is EnrichmentException or HttpRequestException or OperationCanceledException or
            JsonException or InvalidOperationException or KeyNotFoundException or FormatException or IOException or SqliteException or UnauthorizedAccessException)
        {
            string category = error is EnrichmentException known ? known.Category :
                error is JsonException or InvalidOperationException or KeyNotFoundException or FormatException ? "Invalid enrichment response" : "Enrichment unavailable";
            lock (_sync)
            {
                _attempted.Add(key);
                if (category is "API key rejected" or "API quota exhausted") _halted = true;
            }
            SetState(new("Using audio and tags", Error: category), job);
        }
        finally
        {
            if (entered) _serial.Release();
            lock (_sync) { if (ReferenceEquals(_activeJob, job)) { _activeJob = null; _jobKey = null; } }
            job.Dispose();
        }
    }
    private static async Task<T> RetryAsync<T>(Func<Task<T>> operation, CancellationToken token)
    {
        for (int attempt = 0; ; attempt++)
        {
            try { return await operation().ConfigureAwait(false); }
            catch (EnrichmentException error) when (error.Retryable && attempt < 2)
            {
                TimeSpan delay = error.RetryAfter ?? TimeSpan.FromSeconds(2 << attempt);
                // Do not retry early when the provider asks for a longer cooling-off period.
                if (delay > TimeSpan.FromMinutes(2)) throw;
                await Task.Delay(delay > TimeSpan.Zero ? delay : TimeSpan.FromSeconds(1), token).ConfigureAwait(false);
            }
        }
    }
    private void SetState(LyricsAnalysisState state, CancellationTokenSource job)
    {
        lock (_sync) { if (!ReferenceEquals(_activeJob, job) || job.IsCancellationRequested) return; State = state; }
        StateChanged?.Invoke();
    }
    public async ValueTask DisposeAsync()
    {
        await _shutdown.CancelAsync().ConfigureAwait(false);
        if (_loop is not null) await _loop.ConfigureAwait(false);
        await Task.WhenAll(_jobs).ConfigureAwait(false);
        _shutdown.Dispose(); _serial.Dispose();
    }
}
