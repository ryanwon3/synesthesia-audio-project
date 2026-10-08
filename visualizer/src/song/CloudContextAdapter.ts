import { isCloudSongContext, type CloudSongContextV1, type CloudSongStatus } from "../../../shared/CloudSongContext";
import {
  initialSongContext, normalizeSongContext,
  type SongContextSnapshot, type SpotifyAuthenticationStatus, type SpotifyMetadataStatus,
} from "./SongContext";

// Pure mapping of a strictly validated hosted DTO onto the legacy local snapshot shape.
// No files, secrets, models or colors. activeProfile stays null: personal overrides are owned elsewhere.
const metadataByStatus: Record<CloudSongStatus, SpotifyMetadataStatus> = {
  playing: "playingTrack", paused: "pausedTrack", none: "noPlayback", signedOut: "authenticationRequired",
  forbidden: "forbidden", unavailable: "metadataUnavailable", rateLimited: "rateLimited",
};
const authByStatus: Record<CloudSongStatus, SpotifyAuthenticationStatus> = {
  playing: "valid", paused: "valid", none: "valid", signedOut: "authorizationRequired",
  forbidden: "failed", unavailable: "valid", rateLimited: "valid",
};

export function toLocalSongContext(dto: CloudSongContextV1): SongContextSnapshot {
  const input: unknown = dto;
  // Generic message: never echo DTO content (tokens, lyrics, paths).
  if (!isCloudSongContext(input)) throw new Error("Invalid hosted song context");
  // Deep copy of plain validated JSON so callers' input is never shared or mutated.
  const v = JSON.parse(JSON.stringify(input)) as CloudSongContextV1;
  const hasTrack = v.status === "playing" || v.status === "paused";
  const fresh = hasTrack || v.status === "none";
  const tagged = v.trackTags.length + v.artistTags.length > 0;
  return normalizeSongContext({
    ...initialSongContext,
    metadataStatus: metadataByStatus[v.status],
    authenticationStatus: authByStatus[v.status],
    authenticationDetail: null,
    spotifyConfigured: true,
    authorizationGrantedAtUtc: null,
    refreshCredentialExpiresAtUtc: null,
    currentTrack: hasTrack ? v.track : null,
    stale: v.status === "unavailable" || v.status === "rateLimited",
    lastSuccessfulUpdateUtc: fresh ? v.observedAtUtc : null,
    nextRetryUtc: v.nextRetryUtc,
    activeProfile: null,
    profileSource: null,
    sqliteStatus: "ready",
    databasePath: "cloud",
    currentPollingIntervalMilliseconds: null,
    lastFm: hasTrack
      ? {
        status: tagged ? "succeeded" : "noMatch", cacheSource: tagged ? "fetched" : "none",
        trackTags: v.trackTags, artistTags: v.artistTags,
        matchedTrack: null, matchedArtist: null, trackMusicBrainzId: null, artistMusicBrainzId: null,
        matchQuality: null, retrievedAtUtc: null, errorCategory: null, nextRetryUtc: null,
      }
      : null,
    openAiConfigured: v.capabilities.ai,
    lyricsAnalysis: hasTrack && v.analysis
      ? { status: "ready", source: "cloud", timed: v.analysis.sections.length > 0, cached: true, error: null, profile: v.analysis }
      : null,
  });
}
