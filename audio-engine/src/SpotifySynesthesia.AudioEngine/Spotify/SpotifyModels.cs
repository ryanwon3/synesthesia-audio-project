using System.Text.Json;

namespace SpotifySynesthesia.AudioEngine.Spotify;

public enum SpotifyMetadataStatus
{
    NotConfigured,
    AuthenticationRequired,
    PlayingTrack,
    PausedTrack,
    NoPlayback,
    UnsupportedContent,
    MetadataUnavailable,
    RateLimited,
    Forbidden,
}

public enum SpotifyAuthenticationStatus
{
    NotConfigured,
    AuthorizationRequired,
    Authorizing,
    Valid,
    ReauthorizationRequired,
    Failed,
}

public sealed record SpotifyArtistIdentity(string? SpotifyArtistId, string? Name);

public sealed record SpotifyAlbumIdentity(
    string? SpotifyAlbumId,
    string? Name,
    string? ArtworkUrl,
    string? ReleaseDate,
    string? ReleaseDatePrecision);

public sealed record CurrentTrack(
    string SpotifyTrackId,
    string? SpotifyUri,
    string? Isrc,
    string? Title,
    IReadOnlyList<SpotifyArtistIdentity> Artists,
    SpotifyAlbumIdentity? Album,
    long? DurationMs,
    bool? Explicit,
    long? ProgressMs,
    bool IsPlaying,
    DateTimeOffset ObservedAtUtc);

public enum SpotifyPlaybackResultKind
{
    Track,
    NoPlayback,
    UnsupportedContent,
    Unauthorized,
    Forbidden,
    RateLimited,
    Unavailable,
}

public sealed record SpotifyPlaybackResult(
    SpotifyPlaybackResultKind Kind,
    CurrentTrack? Track = null,
    TimeSpan? RetryAfter = null)
{
    public static SpotifyPlaybackResult Playing(CurrentTrack track) => new(SpotifyPlaybackResultKind.Track, track);
}

public sealed record SpotifyPlaybackState(
    SpotifyMetadataStatus MetadataStatus,
    CurrentTrack? CurrentTrack,
    bool Stale,
    DateTimeOffset? LastSuccessfulUpdateUtc,
    DateTimeOffset? NextRetryUtc);

public sealed record SpotifyStoredAuthorization(
    string RefreshToken,
    DateTimeOffset AuthorizationGrantedAtUtc,
    DateTimeOffset RefreshCredentialExpiresAtUtc,
    string Scope);

internal sealed record SpotifyAccessToken(
    string Value,
    DateTimeOffset ExpiresAtUtc);

public sealed record SpotifyAuthorizationCallback(
    string? Code,
    string? State,
    string? Error,
    string? ErrorDescription);

public sealed record SpotifyAuthorizationCallbackResult(bool Success, string Message);

public sealed record SpotifyClientSettings(string ClientId);

public sealed record ReservedSongProfileData(
    JsonElement? Metadata,
    JsonElement? MusicalAnalysis,
    JsonElement? LyricAnalysis,
    JsonElement? SemanticAnalysis,
    JsonElement? PersonalOverrides);
