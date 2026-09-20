using SpotifySynesthesia.AudioEngine.Profiles;

namespace SpotifySynesthesia.AudioEngine.LastFm;

public sealed class LastFmEnrichmentService
{
    private readonly ILastFmApiClient _client;
    private readonly LastFmTagNormalizer _tagNormalizer;
    private readonly LastFmOptions _options;
    private readonly TimeProvider _timeProvider;

    public LastFmEnrichmentService(
        ILastFmApiClient client,
        LastFmTagNormalizer tagNormalizer,
        LastFmOptions? options = null,
        TimeProvider? timeProvider = null)
    {
        _client = client ?? throw new ArgumentNullException(nameof(client));
        _tagNormalizer = tagNormalizer ?? throw new ArgumentNullException(nameof(tagNormalizer));
        _options = options ?? new LastFmOptions();
        _options.Validate();
        _timeProvider = timeProvider ?? TimeProvider.System;
    }

    public async Task<LastFmEnrichmentResult> EnrichAsync(
        string apiKey,
        SongProfile profile,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(profile);
        IReadOnlyList<LastFmLookupCandidate> candidates = LastFmMatcher.CreateCandidates(profile.Identity);
        if (candidates.Count == 0)
        {
            return new LastFmEnrichmentResult(
                LastFmStatus.InsufficientIdentity,
                ErrorCategory: LastFmErrorCategory.InsufficientIdentity);
        }

        LastFmLookupCandidate primary = candidates[0];
        LastFmTrackInfo? matched = null;
        LastFmMatchQuality? matchQuality = null;
        foreach (LastFmLookupCandidate candidate in candidates)
        {
            LastFmApiResult<LastFmTrackInfo> info = await _client
                .GetTrackInfoAsync(apiKey, candidate.Artist, candidate.Track, _options.RequestTimeout, cancellationToken)
                .ConfigureAwait(false);
            if (info.Kind == LastFmApiResultKind.NoMatch)
            {
                continue;
            }

            if (info.Kind != LastFmApiResultKind.Success || info.Value is null)
            {
                return MapFailure(info.Kind, info.ErrorCategory, info.RetryAfter);
            }

            LastFmMatchQuality? quality = LastFmMatcher.ValidateMatch(
                candidate,
                info.Value,
                profile.Identity.DurationMs);
            if (quality is null)
            {
                continue;
            }

            matched = info.Value;
            matchQuality = quality;
            break;
        }

        DateTimeOffset now = _timeProvider.GetUtcNow();
        string lookupArtist = LastFmMatcher.NormalizeLookupText(primary.Artist);
        string lookupTrack = LastFmMatcher.NormalizeLookupText(primary.Track);
        if (matched is null)
        {
            LastFmEnrichment noMatch = new(
                LastFmEnrichment.ProviderSource,
                LastFmStatus.NoMatch,
                [],
                [],
                null,
                null,
                null,
                null,
                null,
                lookupArtist,
                lookupTrack,
                now,
                LastFmEnrichment.CurrentSchemaVersion);
            return new LastFmEnrichmentResult(LastFmStatus.NoMatch, noMatch);
        }

        Task<LastFmApiResult<IReadOnlyList<LastFmProviderTag>>> trackTagsTask = _client.GetTrackTopTagsAsync(
            apiKey,
            matched,
            _options.RequestTimeout,
            cancellationToken);
        Task<LastFmApiResult<IReadOnlyList<LastFmProviderTag>>> artistTagsTask = _client.GetArtistTopTagsAsync(
            apiKey,
            matched,
            _options.RequestTimeout,
            cancellationToken);
        await Task.WhenAll(trackTagsTask, artistTagsTask).ConfigureAwait(false);
        LastFmApiResult<IReadOnlyList<LastFmProviderTag>> trackTags = await trackTagsTask.ConfigureAwait(false);
        LastFmApiResult<IReadOnlyList<LastFmProviderTag>> artistTags = await artistTagsTask.ConfigureAwait(false);
        LastFmEnrichmentResult? failure = MapTagFailure(trackTags, artistTags);
        if (failure is not null)
        {
            return failure;
        }

        LastFmEnrichment enrichment = new(
            LastFmEnrichment.ProviderSource,
            LastFmStatus.Succeeded,
            _tagNormalizer.Normalize(trackTags.Value ?? []),
            _tagNormalizer.Normalize(artistTags.Value ?? []),
            matched.TrackName,
            matched.ArtistName,
            matched.TrackMusicBrainzId,
            matched.ArtistMusicBrainzId,
            matchQuality,
            lookupArtist,
            lookupTrack,
            now,
            LastFmEnrichment.CurrentSchemaVersion);
        return new LastFmEnrichmentResult(LastFmStatus.Succeeded, enrichment);
    }

    private static LastFmEnrichmentResult? MapTagFailure(
        LastFmApiResult<IReadOnlyList<LastFmProviderTag>> trackTags,
        LastFmApiResult<IReadOnlyList<LastFmProviderTag>> artistTags)
    {
        LastFmApiResult<IReadOnlyList<LastFmProviderTag>>? failure =
            new[] { trackTags, artistTags }.FirstOrDefault(result =>
                result.Kind is not LastFmApiResultKind.Success and not LastFmApiResultKind.NoMatch);
        return failure is null ? null : MapFailure(failure.Kind, failure.ErrorCategory, failure.RetryAfter);
    }

    private static LastFmEnrichmentResult MapFailure(
        LastFmApiResultKind kind,
        LastFmErrorCategory? errorCategory,
        TimeSpan? retryAfter) => kind switch
        {
            LastFmApiResultKind.InvalidCredentials => new(
                LastFmStatus.InvalidCredentials,
                ErrorCategory: errorCategory,
                RetryAfter: retryAfter),
            LastFmApiResultKind.RateLimited => new(
                LastFmStatus.RateLimited,
                ErrorCategory: errorCategory,
                RetryAfter: retryAfter),
            LastFmApiResultKind.Unavailable => new(
                LastFmStatus.Unavailable,
                ErrorCategory: errorCategory,
                RetryAfter: retryAfter),
            LastFmApiResultKind.NoMatch => new(LastFmStatus.NoMatch, ErrorCategory: errorCategory),
            _ => new(LastFmStatus.Error, ErrorCategory: errorCategory),
        };
}
