using SpotifySynesthesia.AudioEngine.Profiles;

namespace SpotifySynesthesia.AudioEngine.LastFm;

public enum LastFmStatus
{
    NotConfigured,
    NotAttempted,
    InsufficientIdentity,
    Fetching,
    Succeeded,
    NoMatch,
    Unavailable,
    RateLimited,
    InvalidCredentials,
    Error,
}

public enum LastFmCacheSource
{
    None,
    Cached,
    Fetched,
}

public enum LastFmMatchQuality
{
    Exact,
    Normalized,
    ProviderCorrected,
}

public enum LastFmErrorCategory
{
    InsufficientIdentity,
    InvalidApiKey,
    SuspendedApiKey,
    RateLimit,
    NoMatch,
    Timeout,
    Network,
    ServiceOffline,
    ServerError,
    MalformedResponse,
    UnexpectedResponse,
    Persistence,
}

public sealed record LastFmTag(string Name, double? Weight);

public sealed record LastFmEnrichment(
    string Source,
    LastFmStatus Status,
    IReadOnlyList<LastFmTag> TrackTags,
    IReadOnlyList<LastFmTag> ArtistTags,
    string? MatchedTrack,
    string? MatchedArtist,
    string? TrackMusicBrainzId,
    string? ArtistMusicBrainzId,
    LastFmMatchQuality? MatchQuality,
    string LookupArtist,
    string LookupTrack,
    DateTimeOffset RetrievedAtUtc,
    int SchemaVersion)
{
    public const string ProviderSource = "last.fm";
    // Refresh results obtained with the unreliable MBID tag lookup.
    public const int CurrentSchemaVersion = 2;
}

public sealed record LastFmContextState(
    LastFmStatus Status,
    LastFmCacheSource CacheSource,
    IReadOnlyList<LastFmTag> TrackTags,
    IReadOnlyList<LastFmTag> ArtistTags,
    string? MatchedTrack,
    string? MatchedArtist,
    string? TrackMusicBrainzId,
    string? ArtistMusicBrainzId,
    LastFmMatchQuality? MatchQuality,
    DateTimeOffset? RetrievedAtUtc,
    LastFmErrorCategory? ErrorCategory,
    DateTimeOffset? NextRetryUtc)
{
    public static LastFmContextState NotConfigured { get; } = new(
        LastFmStatus.NotConfigured,
        LastFmCacheSource.None,
        [],
        [],
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null);

    public static LastFmContextState NotAttempted { get; } = NotConfigured with
    {
        Status = LastFmStatus.NotAttempted,
    };

    public static LastFmContextState FromEnrichment(
        LastFmEnrichment enrichment,
        LastFmCacheSource cacheSource) => new(
            enrichment.Status,
            cacheSource,
            enrichment.TrackTags,
            enrichment.ArtistTags,
            enrichment.MatchedTrack,
            enrichment.MatchedArtist,
            enrichment.TrackMusicBrainzId,
            enrichment.ArtistMusicBrainzId,
            enrichment.MatchQuality,
            enrichment.RetrievedAtUtc,
            null,
            null);
}

public enum LastFmApiResultKind
{
    Success,
    NoMatch,
    Unavailable,
    RateLimited,
    InvalidCredentials,
    Error,
}

public sealed record LastFmApiResult<T>(
    LastFmApiResultKind Kind,
    T? Value = default,
    LastFmErrorCategory? ErrorCategory = null,
    TimeSpan? RetryAfter = null);

public sealed record LastFmTrackInfo(
    string TrackName,
    string ArtistName,
    string? TrackMusicBrainzId,
    string? ArtistMusicBrainzId,
    long? DurationMs,
    bool Autocorrected);

public sealed record LastFmProviderTag(string? Name, long? Count, int Rank);

public sealed record LastFmLookupCandidate(string Artist, string Track);

public sealed record LastFmEnrichmentResult(
    LastFmStatus Status,
    LastFmEnrichment? Enrichment = null,
    LastFmErrorCategory? ErrorCategory = null,
    TimeSpan? RetryAfter = null);

public sealed record LastFmCoordinatorUpdate(
    string? SpotifyTrackId,
    SongProfile? Profile,
    LastFmContextState State);
