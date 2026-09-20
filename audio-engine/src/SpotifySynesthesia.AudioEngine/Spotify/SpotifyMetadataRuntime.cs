using Microsoft.Data.Sqlite;
using SpotifySynesthesia.AudioEngine.Database;
using SpotifySynesthesia.AudioEngine.LastFm;
using SpotifySynesthesia.AudioEngine.OpenAi;
using SpotifySynesthesia.AudioEngine.Profiles;
using SpotifySynesthesia.AudioEngine.Server;

namespace SpotifySynesthesia.AudioEngine.Spotify;

public sealed class SpotifyMetadataRuntime : IAsyncDisposable
{
    private readonly AudioFrameWebSocketServer _server;
    private readonly ISpotifyAuthorizationService _authorization;
    private readonly ISpotifyCurrentPlaybackClient _playbackClient;
    private readonly ISongProfileRepository _repository;
    private readonly SpotifyPollingOptions _options;
    private readonly TimeProvider _timeProvider;
    private readonly SpotifyPlaybackTracker _tracker = new();
    private readonly CancellationTokenSource _shutdown = new();
    private readonly SemaphoreSlim _wakeSignal = new(initialCount: 0, maxCount: 1);
    private readonly IReadOnlyList<IDisposable> _ownedResources;
    private readonly ILastFmEnrichmentCoordinator? _lastFm;
    private readonly IOpenAiApiKeyStore _openAiApiKeyStore;

    private Task? _runTask;
    private SongProfile? _activeProfile;
    private SongProfile? _lastStableProfile;
    private SongProfileSource? _profileSource;
    private SongProfileSource? _lastStableProfileSource;
    private SqliteStatus _sqliteStatus = SqliteStatus.Initializing;
    private TimeSpan? _currentPollingInterval;
    private bool _initialized;
    private bool _disposed;
    private LastFmContextState? _lastFmState;
    private bool _openAiConfigured;
    private Lyrics.LyricsAnalysisCoordinator? _lyrics;
    public Lyrics.LyricsAnalysisSettings LyricsSettings => _lyrics?.Settings ?? new();
    public Task ConfigureLyricsAsync(Lyrics.LyricsAnalysisSettings settings, CancellationToken token = default) =>
        _lyrics?.ConfigureAsync(settings, token) ?? Task.CompletedTask;
    public void ReanalyzeLyrics() => _lyrics?.Reanalyze();

    public SpotifyMetadataRuntime(
        AudioFrameWebSocketServer server,
        ISpotifyAuthorizationService authorization,
        ISpotifyCurrentPlaybackClient playbackClient,
        ISongProfileRepository repository,
        SpotifyPollingOptions? options = null,
        TimeProvider? timeProvider = null,
        IReadOnlyList<IDisposable>? ownedResources = null,
        ILastFmEnrichmentCoordinator? lastFm = null,
        IOpenAiApiKeyStore? openAiApiKeyStore = null)
    {
        _server = server ?? throw new ArgumentNullException(nameof(server));
        _authorization = authorization ?? throw new ArgumentNullException(nameof(authorization));
        _playbackClient = playbackClient ?? throw new ArgumentNullException(nameof(playbackClient));
        _repository = repository ?? throw new ArgumentNullException(nameof(repository));
        _options = options ?? new SpotifyPollingOptions();
        _options.Validate();
        _timeProvider = timeProvider ?? TimeProvider.System;
        _ownedResources = ownedResources ?? [];
        _lastFm = lastFm;
        _lastFmState = lastFm?.CurrentState;
        _openAiApiKeyStore = openAiApiKeyStore ?? NullOpenAiApiKeyStore.Instance;
    }

    public event Action<CurrentTrack>? TrackChanged;

    public event Action<SongProfile?>? SongProfileChanged;

    public SongContextSnapshot CurrentSnapshot => CreateSnapshot();

    public bool IsLastFmConfigured => _lastFm?.IsConfigured == true;

    public bool IsOpenAiConfigured => _openAiConfigured;

    public static SpotifyMetadataRuntime CreateDefault(AudioFrameWebSocketServer server)
    {
        HttpClient authorizationClient = new();
        HttpClient playbackClient = new();
        HttpClient lastFmClient = new();
        SqliteSongProfileRepository repository = new();
        LastFmOptions lastFmOptions = new();
        LastFmEnrichmentCoordinator lastFm = new(
            new LastFmEnrichmentService(
                new LastFmApiClient(lastFmClient),
                new LastFmTagNormalizer(lastFmOptions),
                lastFmOptions),
            repository,
            new DpapiLastFmApiKeyStore(),
            lastFmOptions);
        SpotifyAuthorizationService authorization = new(
            authorizationClient,
            new SpotifySettingsStore(),
            new DpapiSpotifyAuthorizationStore(),
            new SystemSpotifyBrowserLauncher(),
            () => server.IsSpotifyCallbackAvailable);
        HttpClient lyricsClient = new() { Timeout = TimeSpan.FromSeconds(20), MaxResponseContentBufferSize = 200_000 };
        HttpClient aiClient = new() { Timeout = TimeSpan.FromSeconds(100), MaxResponseContentBufferSize = 300_000 };
        DpapiOpenAiApiKeyStore openAiKeys = new();
        var runtime = new SpotifyMetadataRuntime(
            server,
            authorization,
            new SpotifyCurrentPlaybackClient(playbackClient),
            repository,
            ownedResources: [authorization, authorizationClient, playbackClient, lastFmClient, lyricsClient, aiClient],
            lastFm: lastFm,
            openAiApiKeyStore: openAiKeys);
        runtime._lyrics = new(new Lyrics.LrcLibLyricsProvider(lyricsClient), new Lyrics.OpenAiLyricsAnalyzer(aiClient),
            new Lyrics.SqliteLyricsCache(repository.DatabasePath), openAiKeys);
        return runtime;
    }

    public async Task InitializeAsync(CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (_initialized)
        {
            return;
        }

        _server.ConfigureSongContextHandlers(HandleSongContextCommandAsync, HandleAuthorizationCallbackAsync);
        _authorization.StateChanged += HandleAuthorizationStateChanged;
        if (_lastFm is not null)
        {
            _lastFm.StateChanged += HandleLastFmStateChanged;
        }

        try
        {
            await _repository.InitializeAsync(cancellationToken).ConfigureAwait(false);
            _sqliteStatus = SqliteStatus.Ready;
        }
        catch (Exception exception) when (exception is SqliteException or IOException or UnauthorizedAccessException)
        {
            _sqliteStatus = SqliteStatus.Error;
        }

        if (_lastFm is not null)
        {
            await _lastFm.InitializeAsync(cancellationToken).ConfigureAwait(false);
            _lastFmState = _lastFm.CurrentState;
        }

        try { _openAiConfigured = await _openAiApiKeyStore.LoadAsync(cancellationToken).ConfigureAwait(false) is not null; }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { _openAiConfigured = false; }
        if (_lyrics is not null)
        {
            _lyrics.StateChanged += PublishSnapshot;
            await _lyrics.InitializeAsync(_openAiConfigured, cancellationToken).ConfigureAwait(false);
        }

        await _authorization.InitializeAsync(cancellationToken).ConfigureAwait(false);
        _initialized = true;
        PublishSnapshot();
        _runTask = RunAsync(_shutdown.Token);
        Wake();
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _shutdown.Cancel();
        Wake();
        if (_runTask is not null)
        {
            try
            {
                await _runTask.ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (_shutdown.IsCancellationRequested)
            {
            }
        }

        _authorization.StateChanged -= HandleAuthorizationStateChanged;
        if (_lastFm is not null)
        {
            _lastFm.StateChanged -= HandleLastFmStateChanged;
            await _lastFm.DisposeAsync().ConfigureAwait(false);
        }

        _server.ClearSongContextHandlers();
        if (_lyrics is not null)
        {
            _lyrics.StateChanged -= PublishSnapshot;
            await _lyrics.DisposeAsync().ConfigureAwait(false);
        }
        foreach (IDisposable resource in _ownedResources)
        {
            resource.Dispose();
        }

        _wakeSignal.Dispose();
        _shutdown.Dispose();
        GC.SuppressFinalize(this);
    }

    public Task ConfigureLastFmApiKeyAsync(
        string? apiKey,
        CancellationToken cancellationToken = default) => _lastFm is null
            ? Task.CompletedTask
            : _lastFm.ConfigureApiKeyAsync(apiKey, cancellationToken);

    public async Task ConfigureOpenAiApiKeyAsync(
        string? apiKey,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(apiKey))
        {
            await _openAiApiKeyStore.ClearAsync(cancellationToken).ConfigureAwait(false);
            _openAiConfigured = false;
        }
        else
        {
            await _openAiApiKeyStore.SaveAsync(
                OpenAiApiKeyValidator.Normalize(apiKey),
                cancellationToken).ConfigureAwait(false);
            _openAiConfigured = true;
        }

        _lyrics?.CredentialsChanged(_openAiConfigured);
        PublishSnapshot();
    }

    private async Task RunAsync(CancellationToken cancellationToken)
    {
        int consecutiveFailures = 0;
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                string? accessToken = await _authorization
                    .GetAccessTokenAsync(cancellationToken: cancellationToken)
                    .ConfigureAwait(false);
                if (accessToken is null)
                {
                    if (_authorization.Status == SpotifyAuthenticationStatus.Valid)
                    {
                        consecutiveFailures += 1;
                        TimeSpan retryDelay = _options.GetBackoff(consecutiveFailures);
                        _tracker.Apply(
                            new SpotifyPlaybackResult(SpotifyPlaybackResultKind.Unavailable),
                            _timeProvider.GetUtcNow(),
                            _timeProvider.GetUtcNow().Add(retryDelay));
                        _currentPollingInterval = retryDelay;
                        PublishSnapshot();
                        await WaitForWakeOrDelayAsync(retryDelay, cancellationToken).ConfigureAwait(false);
                    }
                    else
                    {
                        _currentPollingInterval = null;
                        PublishSnapshot();
                        await WaitForWakeOrDelayAsync(TimeSpan.FromMinutes(5), cancellationToken).ConfigureAwait(false);
                    }

                    continue;
                }

                SpotifyPlaybackResult result = await _playbackClient
                    .GetCurrentPlaybackAsync(accessToken, _options.RequestTimeout, cancellationToken)
                    .ConfigureAwait(false);
                if (result.Kind == SpotifyPlaybackResultKind.Unauthorized)
                {
                    string? refreshedToken = await _authorization
                        .GetAccessTokenAsync(forceRefresh: true, cancellationToken)
                        .ConfigureAwait(false);
                    result = refreshedToken is null
                        ? new SpotifyPlaybackResult(
                            _authorization.Status == SpotifyAuthenticationStatus.Valid
                                ? SpotifyPlaybackResultKind.Unavailable
                                : SpotifyPlaybackResultKind.Unauthorized)
                        : await _playbackClient
                            .GetCurrentPlaybackAsync(refreshedToken, _options.RequestTimeout, cancellationToken)
                            .ConfigureAwait(false);
                }

                TimeSpan delay;
                DateTimeOffset? nextRetryUtc = null;
                if (result.Kind is SpotifyPlaybackResultKind.Unavailable or SpotifyPlaybackResultKind.RateLimited)
                {
                    consecutiveFailures += 1;
                    delay = result.RetryAfter ?? _options.GetBackoff(consecutiveFailures);
                    nextRetryUtc = _timeProvider.GetUtcNow().Add(delay);
                }
                else
                {
                    consecutiveFailures = 0;
                    delay = GetIntervalForResult(result);
                }

                bool changed = _tracker.Apply(result, _timeProvider.GetUtcNow(), nextRetryUtc);
                await UpdateActiveProfileAsync(result, changed, cancellationToken).ConfigureAwait(false);
                _currentPollingInterval = delay;
                PublishSnapshot();
                await WaitForWakeOrDelayAsync(delay, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception exception) when (
                exception is HttpRequestException or IOException or InvalidOperationException)
            {
                consecutiveFailures += 1;
                TimeSpan delay = _options.GetBackoff(consecutiveFailures);
                DateTimeOffset nextRetryUtc = _timeProvider.GetUtcNow().Add(delay);
                _tracker.Apply(
                    new SpotifyPlaybackResult(SpotifyPlaybackResultKind.Unavailable),
                    _timeProvider.GetUtcNow(),
                    nextRetryUtc);
                _currentPollingInterval = delay;
                PublishSnapshot();
                await WaitForWakeOrDelayAsync(delay, cancellationToken).ConfigureAwait(false);
            }
        }
    }

    private async Task UpdateActiveProfileAsync(
        SpotifyPlaybackResult result,
        bool changed,
        CancellationToken cancellationToken)
    {
        CurrentTrack? track = result.Track;
        if (result.Kind != SpotifyPlaybackResultKind.Track || track is null)
        {
            if (result.Kind is SpotifyPlaybackResultKind.NoPlayback or SpotifyPlaybackResultKind.UnsupportedContent)
            {
                SetActiveProfile(profile: null, source: null);
            }

            return;
        }

        if (!changed && string.Equals(
            _lastStableProfile?.Identity.SpotifyTrackId,
            track.SpotifyTrackId,
            StringComparison.Ordinal))
        {
            SetActiveProfile(_lastStableProfile, _lastStableProfileSource);
            return;
        }

        if (!changed)
        {
            return;
        }

        TrackChanged?.Invoke(track);
        if (_sqliteStatus != SqliteStatus.Ready)
        {
            SetActiveProfile(profile: null, source: null);
            return;
        }

        try
        {
            SongProfileLoadResult loaded = await _repository
                .GetOrCreateAndRefreshIdentityAsync(track, cancellationToken)
                .ConfigureAwait(false);
            if (!string.Equals(_tracker.LastStableTrackId, track.SpotifyTrackId, StringComparison.Ordinal))
            {
                return;
            }

            _lastStableProfile = loaded.Profile;
            _lastStableProfileSource = loaded.Source;
            SetActiveProfile(loaded.Profile, loaded.Source);
        }
        catch (Exception exception) when (exception is SqliteException or IOException or InvalidOperationException)
        {
            _sqliteStatus = SqliteStatus.Error;
            SetActiveProfile(profile: null, source: null);
        }
    }

    private async Task HandleSongContextCommandAsync(
        SongContextCommand command,
        CancellationToken cancellationToken)
    {
        string? priorClientId = _authorization.ClientId;
        await _authorization
            .ConfigureAndAuthorizeAsync(command.ClientId, cancellationToken)
            .ConfigureAwait(false);
        if (!string.IsNullOrWhiteSpace(command.ClientId) &&
            !string.Equals(priorClientId, _authorization.ClientId, StringComparison.Ordinal))
        {
            _tracker.Reset();
            _lastStableProfile = null;
            _lastStableProfileSource = null;
            SetActiveProfile(profile: null, source: null);
        }

        PublishSnapshot();
        Wake();
    }

    private async Task<SpotifyAuthorizationCallbackResult> HandleAuthorizationCallbackAsync(
        SpotifyAuthorizationCallback callback,
        CancellationToken cancellationToken)
    {
        SpotifyAuthorizationCallbackResult result = await _authorization
            .HandleCallbackAsync(callback, cancellationToken)
            .ConfigureAwait(false);
        PublishSnapshot();
        Wake();
        return result;
    }

    private void HandleAuthorizationStateChanged()
    {
        PublishSnapshot();
        Wake();
    }

    private void HandleLastFmStateChanged(LastFmCoordinatorUpdate update)
    {
        string? activeTrackId = _activeProfile?.Identity.SpotifyTrackId;
        if (!string.Equals(activeTrackId, update.SpotifyTrackId, StringComparison.Ordinal))
        {
            return;
        }

        _lastFmState = update.State;
        if (update.Profile is not null)
        {
            _activeProfile = update.Profile;
            if (string.Equals(
                _lastStableProfile?.Identity.SpotifyTrackId,
                update.Profile.Identity.SpotifyTrackId,
                StringComparison.Ordinal))
            {
                _lastStableProfile = update.Profile;
            }

            SongProfileChanged?.Invoke(update.Profile);
        }

        PublishSnapshot();
    }

    private void SetActiveProfile(SongProfile? profile, SongProfileSource? source)
    {
        if (Equals(_activeProfile, profile) && _profileSource == source)
        {
            return;
        }

        _activeProfile = profile;
        _profileSource = source;
        SongProfileChanged?.Invoke(profile);
        _lastFm?.Activate(profile);
    }

    private TimeSpan GetIntervalForResult(SpotifyPlaybackResult result) => result.Kind switch
    {
        SpotifyPlaybackResultKind.Track when result.Track?.IsPlaying == true => _options.PlayingInterval,
        SpotifyPlaybackResultKind.Track => _options.PausedInterval,
        _ => _options.EmptyInterval,
    };

    private SongContextSnapshot CreateSnapshot()
    {
        SpotifyMetadataStatus metadataStatus = _authorization.Status switch
        {
            SpotifyAuthenticationStatus.NotConfigured => SpotifyMetadataStatus.NotConfigured,
            SpotifyAuthenticationStatus.Valid => _tracker.State.MetadataStatus,
            _ => SpotifyMetadataStatus.AuthenticationRequired,
        };
        SpotifyPlaybackState playback = _tracker.State;
        return new SongContextSnapshot(
            metadataStatus,
            _authorization.Status,
            _authorization.StatusDetail,
            _authorization.IsConfigured,
            _authorization.AuthorizationGrantedAtUtc,
            _authorization.RefreshCredentialExpiresAtUtc,
            playback.CurrentTrack,
            playback.Stale,
            playback.LastSuccessfulUpdateUtc,
            playback.NextRetryUtc,
            _activeProfile,
            _profileSource,
            _sqliteStatus,
            _repository.DatabasePath,
            _currentPollingInterval?.TotalMilliseconds,
            _lastFmState,
            _openAiConfigured,
            _lyrics?.State,
            _lyrics?.Settings);
    }

    private void PublishSnapshot()
    {
        _lyrics?.Observe(_tracker.State.CurrentTrack, _activeProfile, _lastFmState, _tracker.State.Stale);
        _server.PublishSongContext(CreateSnapshot());
    }

    private void Wake()
    {
        try
        {
            _wakeSignal.Release();
        }
        catch (SemaphoreFullException)
        {
        }
    }

    private async Task WaitForWakeOrDelayAsync(TimeSpan delay, CancellationToken cancellationToken)
    {
        using CancellationTokenSource waitCancellation =
            CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        Task delayTask = Task.Delay(delay, _timeProvider, waitCancellation.Token);
        Task signalTask = _wakeSignal.WaitAsync(waitCancellation.Token);
        await Task.WhenAny(delayTask, signalTask).ConfigureAwait(false);
        await waitCancellation.CancelAsync().ConfigureAwait(false);
        try
        {
            await Task.WhenAll(delayTask, signalTask).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (waitCancellation.IsCancellationRequested)
        {
        }

        cancellationToken.ThrowIfCancellationRequested();
    }
}
