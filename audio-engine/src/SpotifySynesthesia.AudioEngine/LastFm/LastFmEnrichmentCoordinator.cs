using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using SpotifySynesthesia.AudioEngine.Profiles;

namespace SpotifySynesthesia.AudioEngine.LastFm;

public interface ILastFmEnrichmentCoordinator : IAsyncDisposable
{
    event Action<LastFmCoordinatorUpdate>? StateChanged;

    bool IsConfigured { get; }

    LastFmContextState CurrentState { get; }

    Task InitializeAsync(CancellationToken cancellationToken = default);

    void Activate(SongProfile? profile);

    Task ConfigureApiKeyAsync(string? apiKey, CancellationToken cancellationToken = default);
}

public sealed class LastFmEnrichmentCoordinator : ILastFmEnrichmentCoordinator
{
    private readonly object _gate = new();
    private readonly LastFmEnrichmentService _service;
    private readonly ISongProfileRepository _repository;
    private readonly ILastFmApiKeyStore _apiKeyStore;
    private readonly LastFmOptions _options;
    private readonly TimeProvider _timeProvider;
    private readonly SemaphoreSlim _concurrency;
    private readonly ConcurrentDictionary<EnrichmentKey, Task> _inFlight = new();
    private readonly ConcurrentDictionary<EnrichmentKey, Task> _cooldownRetries = new();
    private readonly ConcurrentDictionary<Guid, Task> _backgroundTasks = new();
    private readonly CancellationTokenSource _shutdown = new();

    private CancellationTokenSource _credentialCancellation = new();
    private string? _apiKey;
    private string? _activeTrackId;
    private SongProfile? _activeProfile;
    private LastFmContextState _state = LastFmContextState.NotConfigured;
    private DateTimeOffset? _rateLimitUntilUtc;
    private int _credentialVersion;
    private bool _credentialsInvalid;
    private bool _initialized;
    private bool _disposed;

    public LastFmEnrichmentCoordinator(
        LastFmEnrichmentService service,
        ISongProfileRepository repository,
        ILastFmApiKeyStore apiKeyStore,
        LastFmOptions? options = null,
        TimeProvider? timeProvider = null)
    {
        _service = service ?? throw new ArgumentNullException(nameof(service));
        _repository = repository ?? throw new ArgumentNullException(nameof(repository));
        _apiKeyStore = apiKeyStore ?? throw new ArgumentNullException(nameof(apiKeyStore));
        _options = options ?? new LastFmOptions();
        _options.Validate();
        _timeProvider = timeProvider ?? TimeProvider.System;
        _concurrency = new SemaphoreSlim(
            _options.MaximumConcurrentEnrichments,
            _options.MaximumConcurrentEnrichments);
    }

    public event Action<LastFmCoordinatorUpdate>? StateChanged;

    public bool IsConfigured
    {
        get
        {
            lock (_gate)
            {
                return _apiKey is not null;
            }
        }
    }

    public LastFmContextState CurrentState
    {
        get
        {
            lock (_gate)
            {
                return _state;
            }
        }
    }

    public async Task InitializeAsync(CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (_initialized)
        {
            return;
        }

        string? apiKey = await _apiKeyStore.LoadAsync(cancellationToken).ConfigureAwait(false);
        lock (_gate)
        {
            _apiKey = LastFmApiKeyValidator.IsValid(apiKey) ? apiKey : null;
            _state = _apiKey is null ? LastFmContextState.NotConfigured : LastFmContextState.NotAttempted;
            _initialized = true;
        }

        PublishCurrentState();
    }

    public void Activate(SongProfile? profile)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        string? apiKey;
        int credentialVersion;
        CancellationToken credentialToken;
        TimeSpan? cooldownDelay = null;
        LastFmCoordinatorUpdate? immediateUpdate;
        lock (_gate)
        {
            _activeProfile = profile;
            _activeTrackId = profile?.Identity.SpotifyTrackId;
            apiKey = _apiKey;
            credentialVersion = _credentialVersion;
            credentialToken = _credentialCancellation.Token;
            immediateUpdate = CreateActivationUpdateLocked(profile, apiKey);
            if (immediateUpdate is null && _rateLimitUntilUtc is { } rateLimitUntil)
            {
                DateTimeOffset now = _timeProvider.GetUtcNow();
                if (rateLimitUntil > now)
                {
                    cooldownDelay = rateLimitUntil - now;
                    _state = CreateFailureState(
                        LastFmStatus.RateLimited,
                        LastFmErrorCategory.RateLimit,
                        cooldownDelay);
                    immediateUpdate = new LastFmCoordinatorUpdate(
                        profile!.Identity.SpotifyTrackId,
                        null,
                        _state);
                }
                else
                {
                    _rateLimitUntilUtc = null;
                }
            }
        }

        if (immediateUpdate is not null)
        {
            StateChanged?.Invoke(immediateUpdate);
            if (cooldownDelay is not null)
            {
                QueueCooldownRetry(
                    profile!,
                    cooldownDelay.Value,
                    new CredentialLease(apiKey!, credentialVersion, credentialToken),
                    allowRateLimitRetry: true);
            }

            return;
        }

        PublishCurrentState();
        QueueEnrichment(
            profile!,
            allowRateLimitRetry: true,
            new CredentialLease(apiKey!, credentialVersion, credentialToken));
    }

    public async Task ConfigureApiKeyAsync(string? apiKey, CancellationToken cancellationToken = default)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        string? normalized = string.IsNullOrWhiteSpace(apiKey) ? null : LastFmApiKeyValidator.Normalize(apiKey);
        if (normalized is null)
        {
            await _apiKeyStore.ClearAsync(cancellationToken).ConfigureAwait(false);
        }
        else
        {
            await _apiKeyStore.SaveAsync(normalized, cancellationToken).ConfigureAwait(false);
        }

        CancellationTokenSource priorCancellation;
        SongProfile? activeProfile;
        lock (_gate)
        {
            priorCancellation = _credentialCancellation;
            _credentialCancellation = new CancellationTokenSource();
            _credentialVersion++;
            _apiKey = normalized;
            _credentialsInvalid = false;
            _rateLimitUntilUtc = null;
            _state = normalized is null ? LastFmContextState.NotConfigured : LastFmContextState.NotAttempted;
            activeProfile = _activeProfile;
        }

        priorCancellation.Cancel();
        priorCancellation.Dispose();
        PublishCurrentState();
        Activate(activeProfile);
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _shutdown.Cancel();
        _credentialCancellation.Cancel();
        Task[] tasks = _inFlight.Values
            .Concat(_cooldownRetries.Values)
            .Concat(_backgroundTasks.Values)
            .Distinct()
            .ToArray();
        try
        {
            await Task.WhenAll(tasks).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
        }

        _credentialCancellation.Dispose();
        _shutdown.Dispose();
        _concurrency.Dispose();
        GC.SuppressFinalize(this);
    }

    private LastFmCoordinatorUpdate? CreateActivationUpdateLocked(SongProfile? profile, string? apiKey)
    {
        if (profile is null)
        {
            _state = apiKey is null ? LastFmContextState.NotConfigured : LastFmContextState.NotAttempted;
            return new LastFmCoordinatorUpdate(null, null, _state);
        }

        IReadOnlyList<LastFmLookupCandidate> candidates = LastFmMatcher.CreateCandidates(profile.Identity);
        if (candidates.Count == 0)
        {
            _state = LastFmContextState.NotConfigured with
            {
                Status = LastFmStatus.InsufficientIdentity,
                ErrorCategory = LastFmErrorCategory.InsufficientIdentity,
            };
            return new LastFmCoordinatorUpdate(profile.Identity.SpotifyTrackId, null, _state);
        }

        LastFmEnrichment? cached = SongProfileMetadata.GetLastFm(profile);
        if (cached is not null && IsCacheValid(cached, candidates[0]))
        {
            _state = LastFmContextState.FromEnrichment(cached, LastFmCacheSource.Cached);
            return new LastFmCoordinatorUpdate(profile.Identity.SpotifyTrackId, profile, _state);
        }

        if (apiKey is null)
        {
            _state = LastFmContextState.NotConfigured;
            return new LastFmCoordinatorUpdate(profile.Identity.SpotifyTrackId, null, _state);
        }

        if (_credentialsInvalid)
        {
            _state = LastFmContextState.NotConfigured with
            {
                Status = LastFmStatus.InvalidCredentials,
                ErrorCategory = LastFmErrorCategory.InvalidApiKey,
            };
            return new LastFmCoordinatorUpdate(profile.Identity.SpotifyTrackId, null, _state);
        }

        _state = LastFmContextState.NotConfigured with { Status = LastFmStatus.Fetching };
        return null;
    }

    private bool IsCacheValid(LastFmEnrichment enrichment, LastFmLookupCandidate primary)
    {
        if (!string.Equals(enrichment.Source, LastFmEnrichment.ProviderSource, StringComparison.Ordinal) ||
            enrichment.SchemaVersion != LastFmEnrichment.CurrentSchemaVersion ||
            !string.Equals(
                enrichment.LookupArtist,
                LastFmMatcher.NormalizeLookupText(primary.Artist),
                StringComparison.Ordinal) ||
            !string.Equals(
                enrichment.LookupTrack,
                LastFmMatcher.NormalizeLookupText(primary.Track),
                StringComparison.Ordinal))
        {
            return false;
        }

        return enrichment.Status switch
        {
            LastFmStatus.Succeeded => true,
            LastFmStatus.NoMatch => _timeProvider.GetUtcNow() - enrichment.RetrievedAtUtc <
                _options.NegativeCacheDuration,
            _ => false,
        };
    }

    private void QueueEnrichment(
        SongProfile profile,
        bool allowRateLimitRetry,
        CredentialLease credential)
    {
        EnrichmentKey key = new(profile.Identity.SpotifyTrackId, credential.Version);
        Task task = _inFlight.GetOrAdd(
            key,
            _ => RunEnrichmentAsync(
                profile,
                allowRateLimitRetry,
                credential));
        _ = task.ContinueWith(
            completedTask =>
            {
                _inFlight.TryRemove(key, out Task? _);
            },
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);
        TrackBackgroundTask(task);
    }

    private async Task RunEnrichmentAsync(
        SongProfile profile,
        bool allowRateLimitRetry,
        CredentialLease credential)
    {
        using CancellationTokenSource linked = CancellationTokenSource.CreateLinkedTokenSource(
            _shutdown.Token,
            credential.CancellationToken);
        try
        {
            await _concurrency.WaitAsync(linked.Token).ConfigureAwait(false);
            try
            {
                LastFmEnrichmentResult result = await _service
                    .EnrichAsync(credential.ApiKey, profile, linked.Token)
                    .ConfigureAwait(false);
                await ApplyResultAsync(
                    profile,
                    result,
                    allowRateLimitRetry,
                    credential,
                    linked.Token).ConfigureAwait(false);
            }
            finally
            {
                _concurrency.Release();
            }
        }
        catch (OperationCanceledException) when (linked.IsCancellationRequested)
        {
        }
    }

    private async Task ApplyResultAsync(
        SongProfile requestedProfile,
        LastFmEnrichmentResult result,
        bool allowRateLimitRetry,
        CredentialLease credential,
        CancellationToken cancellationToken)
    {
        SongProfile? persisted = null;
        LastFmContextState state;
        if (result.Enrichment is not null)
        {
            try
            {
                persisted = await _repository.UpdateLastFmEnrichmentAsync(
                    requestedProfile.Identity.SpotifyTrackId,
                    result.Enrichment,
                    cancellationToken).ConfigureAwait(false);
                state = LastFmContextState.FromEnrichment(result.Enrichment, LastFmCacheSource.Fetched);
            }
            catch (Exception exception) when (
                exception is SqliteException or IOException or InvalidOperationException or JsonException)
            {
                state = CreateFailureState(LastFmStatus.Error, LastFmErrorCategory.Persistence, null);
            }
        }
        else
        {
            TimeSpan? retryDelay = result.Status == LastFmStatus.RateLimited
                ? result.RetryAfter ?? _options.DefaultRateLimitCooldown
                : null;
            DateTimeOffset? retryAt = null;
            if (retryDelay is not null)
            {
                lock (_gate)
                {
                    if (_credentialVersion == credential.Version)
                    {
                        DateTimeOffset candidate = _timeProvider.GetUtcNow().Add(retryDelay.Value);
                        if (_rateLimitUntilUtc is null || candidate > _rateLimitUntilUtc)
                        {
                            _rateLimitUntilUtc = candidate;
                        }

                        retryAt = _rateLimitUntilUtc;
                    }
                }
            }

            state = CreateFailureState(result.Status, result.ErrorCategory, retryDelay) with
            {
                NextRetryUtc = retryAt,
            };
            if (result.Status == LastFmStatus.InvalidCredentials)
            {
                lock (_gate)
                {
                    if (_credentialVersion == credential.Version)
                    {
                        _credentialsInvalid = true;
                    }
                }
            }

            if (retryDelay is not null && allowRateLimitRetry)
            {
                QueueCooldownRetry(
                    requestedProfile,
                    retryDelay.Value,
                    credential,
                    allowRateLimitRetry: false);
            }
        }

        LastFmCoordinatorUpdate? update = null;
        lock (_gate)
        {
            if (_credentialVersion == credential.Version &&
                string.Equals(_activeTrackId, requestedProfile.Identity.SpotifyTrackId, StringComparison.Ordinal))
            {
                _state = state;
                if (persisted is not null)
                {
                    _activeProfile = persisted;
                }

                update = new LastFmCoordinatorUpdate(
                    requestedProfile.Identity.SpotifyTrackId,
                    persisted,
                    state);
            }
        }

        if (update is not null)
        {
            StateChanged?.Invoke(update);
        }
    }

    private void QueueCooldownRetry(
        SongProfile profile,
        TimeSpan delay,
        CredentialLease credential,
        bool allowRateLimitRetry)
    {
        EnrichmentKey key = new(profile.Identity.SpotifyTrackId, credential.Version);
        Task task = _cooldownRetries.GetOrAdd(
            key,
            _ => ScheduleRateLimitRetryAsync(profile, delay, credential, allowRateLimitRetry));
        _ = task.ContinueWith(
            completedTask =>
            {
                _cooldownRetries.TryRemove(key, out Task? _);
            },
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);
        TrackBackgroundTask(task);
    }

    private async Task ScheduleRateLimitRetryAsync(
        SongProfile profile,
        TimeSpan delay,
        CredentialLease credential,
        bool allowRateLimitRetry)
    {
        using CancellationTokenSource linked = CancellationTokenSource.CreateLinkedTokenSource(
            _shutdown.Token,
            credential.CancellationToken);
        try
        {
            await Task.Delay(delay, _timeProvider, linked.Token).ConfigureAwait(false);
            while (true)
            {
                TimeSpan? remaining;
                lock (_gate)
                {
                    if (_credentialVersion != credential.Version ||
                        !string.Equals(_activeTrackId, profile.Identity.SpotifyTrackId, StringComparison.Ordinal))
                    {
                        return;
                    }

                    DateTimeOffset now = _timeProvider.GetUtcNow();
                    remaining = _rateLimitUntilUtc is { } rateLimitUntil && rateLimitUntil > now
                        ? rateLimitUntil - now
                        : null;
                    if (remaining is null)
                    {
                        _rateLimitUntilUtc = null;
                        _state = LastFmContextState.NotConfigured with { Status = LastFmStatus.Fetching };
                        break;
                    }
                }

                await Task.Delay(remaining.Value, _timeProvider, linked.Token).ConfigureAwait(false);
            }

            PublishCurrentState();
            QueueEnrichment(profile, allowRateLimitRetry, credential);
        }
        catch (OperationCanceledException) when (linked.IsCancellationRequested)
        {
        }
    }

    private LastFmContextState CreateFailureState(
        LastFmStatus status,
        LastFmErrorCategory? errorCategory,
        TimeSpan? retryDelay) => LastFmContextState.NotConfigured with
        {
            Status = status,
            ErrorCategory = errorCategory,
            NextRetryUtc = retryDelay is null ? null : _timeProvider.GetUtcNow().Add(retryDelay.Value),
        };

    private void PublishCurrentState()
    {
        LastFmCoordinatorUpdate update;
        lock (_gate)
        {
            update = new LastFmCoordinatorUpdate(_activeTrackId, null, _state);
        }

        StateChanged?.Invoke(update);
    }

    private void TrackBackgroundTask(Task task)
    {
        Guid id = Guid.NewGuid();
        _backgroundTasks[id] = task;
        _ = task.ContinueWith(
            completedTask =>
            {
                _ = completedTask.Exception;
                _backgroundTasks.TryRemove(id, out Task? _);
            },
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);
    }

    private sealed record CredentialLease(
        string ApiKey,
        int Version,
        CancellationToken CancellationToken);

    private readonly record struct EnrichmentKey(string SpotifyTrackId, int CredentialVersion);
}
