using SpotifySynesthesia.AudioEngine.Spotify;
using SpotifySynesthesia.AudioEngine.LastFm;

namespace SpotifySynesthesia.AudioEngine.Profiles;

public enum SongProfileSource
{
    New,
    Cached,
}

public sealed record SongProfileIdentity(
    string SpotifyTrackId,
    string? SpotifyUri,
    string? Isrc,
    string? Title,
    IReadOnlyList<SpotifyArtistIdentity> Artists,
    SpotifyAlbumIdentity? Album,
    long? DurationMs,
    bool? Explicit);

public sealed record SongProfileCacheMetadata(
    DateTimeOffset CreatedAtUtc,
    DateTimeOffset UpdatedAtUtc,
    int SongProfileSchemaVersion);

public sealed record SongProfile(
    SongProfileIdentity Identity,
    ReservedSongProfileData Reserved,
    SongProfileCacheMetadata CacheMetadata);

public sealed record SongProfileLoadResult(SongProfile Profile, SongProfileSource Source);

public interface ISongProfileRepository
{
    string DatabasePath { get; }

    Task InitializeAsync(CancellationToken cancellationToken = default);

    Task<SongProfileLoadResult> GetOrCreateAndRefreshIdentityAsync(
        CurrentTrack track,
        CancellationToken cancellationToken = default);

    Task<SongProfile> UpdateLastFmEnrichmentAsync(
        string spotifyTrackId,
        LastFmEnrichment enrichment,
        CancellationToken cancellationToken = default);
}
