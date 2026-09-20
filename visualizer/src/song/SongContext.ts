import type { LyricsAnalysisState } from "./SongVisualProfile";

export type SpotifyMetadataStatus =
  | "notConfigured"
  | "authenticationRequired"
  | "playingTrack"
  | "pausedTrack"
  | "noPlayback"
  | "unsupportedContent"
  | "metadataUnavailable"
  | "rateLimited"
  | "forbidden";

export type SpotifyAuthenticationStatus =
  | "notConfigured"
  | "authorizationRequired"
  | "authorizing"
  | "valid"
  | "reauthorizationRequired"
  | "failed";

export type LastFmStatus =
  | "notConfigured"
  | "notAttempted"
  | "insufficientIdentity"
  | "fetching"
  | "succeeded"
  | "noMatch"
  | "unavailable"
  | "rateLimited"
  | "invalidCredentials"
  | "error";

export type LastFmCacheSource = "none" | "cached" | "fetched";

export type LastFmMatchQuality = "exact" | "normalized" | "providerCorrected";

export type LastFmErrorCategory =
  | "insufficientIdentity"
  | "invalidApiKey"
  | "suspendedApiKey"
  | "rateLimit"
  | "noMatch"
  | "timeout"
  | "network"
  | "serviceOffline"
  | "serverError"
  | "malformedResponse"
  | "unexpectedResponse"
  | "persistence";

export interface LastFmTag {
  name: string;
  weight: number | null;
}

export interface LastFmContextState {
  status: LastFmStatus;
  cacheSource: LastFmCacheSource;
  trackTags: LastFmTag[];
  artistTags: LastFmTag[];
  matchedTrack: string | null;
  matchedArtist: string | null;
  trackMusicBrainzId: string | null;
  artistMusicBrainzId: string | null;
  matchQuality: LastFmMatchQuality | null;
  retrievedAtUtc: string | null;
  errorCategory: LastFmErrorCategory | null;
  nextRetryUtc: string | null;
}

export interface SpotifyArtistIdentity {
  spotifyArtistId: string | null;
  name: string | null;
}

export interface SpotifyAlbumIdentity {
  spotifyAlbumId: string | null;
  name: string | null;
  artworkUrl: string | null;
  releaseDate: string | null;
  releaseDatePrecision: string | null;
}

export interface CurrentTrack {
  spotifyTrackId: string;
  spotifyUri: string | null;
  isrc: string | null;
  title: string | null;
  artists: SpotifyArtistIdentity[];
  album: SpotifyAlbumIdentity | null;
  durationMs: number | null;
  explicit: boolean | null;
  progressMs: number | null;
  isPlaying: boolean;
  observedAtUtc: string;
}

export interface SongProfile {
  identity: {
    spotifyTrackId: string;
    spotifyUri: string | null;
    isrc: string | null;
    title: string | null;
    artists: SpotifyArtistIdentity[];
    album: SpotifyAlbumIdentity | null;
    durationMs: number | null;
    explicit: boolean | null;
  };
  reserved: Record<string, unknown>;
  cacheMetadata: {
    createdAtUtc: string;
    updatedAtUtc: string;
    songProfileSchemaVersion: number;
  };
}

export interface SongContextSnapshot {
  metadataStatus: SpotifyMetadataStatus;
  authenticationStatus: SpotifyAuthenticationStatus;
  authenticationDetail: string | null;
  spotifyConfigured: boolean;
  authorizationGrantedAtUtc: string | null;
  refreshCredentialExpiresAtUtc: string | null;
  currentTrack: CurrentTrack | null;
  stale: boolean;
  lastSuccessfulUpdateUtc: string | null;
  nextRetryUtc: string | null;
  activeProfile: SongProfile | null;
  profileSource: "new" | "cached" | null;
  sqliteStatus: "initializing" | "ready" | "error";
  databasePath: string;
  currentPollingIntervalMilliseconds: number | null;
  lastFm: LastFmContextState | null;
  openAiConfigured: boolean;
  lyricsAnalysis?: LyricsAnalysisState | null;
  lyricsSettings?: { automatic: boolean; model: string } | null;
}

export interface SongContextMessage {
  protocolVersion: 1;
  type: "songContext";
  payload: SongContextSnapshot;
}

export const initialSongContext: SongContextSnapshot = {
  metadataStatus: "notConfigured",
  authenticationStatus: "notConfigured",
  authenticationDetail: null,
  spotifyConfigured: false,
  authorizationGrantedAtUtc: null,
  refreshCredentialExpiresAtUtc: null,
  currentTrack: null,
  stale: false,
  lastSuccessfulUpdateUtc: null,
  nextRetryUtc: null,
  activeProfile: null,
  profileSource: null,
  sqliteStatus: "initializing",
  databasePath: "-",
  currentPollingIntervalMilliseconds: null,
  lastFm: null,
  openAiConfigured: false,
};

const metadataStatuses: readonly SpotifyMetadataStatus[] = [
  "notConfigured",
  "authenticationRequired",
  "playingTrack",
  "pausedTrack",
  "noPlayback",
  "unsupportedContent",
  "metadataUnavailable",
  "rateLimited",
  "forbidden",
];

const authenticationStatuses: readonly SpotifyAuthenticationStatus[] = [
  "notConfigured",
  "authorizationRequired",
  "authorizing",
  "valid",
  "reauthorizationRequired",
  "failed",
];

const lastFmStatuses: readonly LastFmStatus[] = [
  "notConfigured",
  "notAttempted",
  "insufficientIdentity",
  "fetching",
  "succeeded",
  "noMatch",
  "unavailable",
  "rateLimited",
  "invalidCredentials",
  "error",
];

const lastFmCacheSources: readonly LastFmCacheSource[] = ["none", "cached", "fetched"];

const lastFmMatchQualities: readonly LastFmMatchQuality[] = [
  "exact",
  "normalized",
  "providerCorrected",
];

const lastFmErrorCategories: readonly LastFmErrorCategory[] = [
  "insufficientIdentity",
  "invalidApiKey",
  "suspendedApiKey",
  "rateLimit",
  "noMatch",
  "timeout",
  "network",
  "serviceOffline",
  "serverError",
  "malformedResponse",
  "unexpectedResponse",
  "persistence",
];

export function isSongContextMessage(value: unknown): value is SongContextMessage {
  if (!isObject(value) || value.protocolVersion !== 1 || value.type !== "songContext") {
    return false;
  }

  const payload = value.payload;
  return isObject(payload) &&
    metadataStatuses.includes(payload.metadataStatus as SpotifyMetadataStatus) &&
    authenticationStatuses.includes(payload.authenticationStatus as SpotifyAuthenticationStatus) &&
    typeof payload.spotifyConfigured === "boolean" &&
    (payload.openAiConfigured === undefined || typeof payload.openAiConfigured === "boolean") &&
    typeof payload.stale === "boolean" &&
    typeof payload.databasePath === "string" &&
    isLastFmState(payload.lastFm);
}

export function normalizeSongContext(snapshot: SongContextSnapshot): SongContextSnapshot {
  return {
    ...snapshot,
    lastFm: snapshot.lastFm ?? null,
    openAiConfigured: snapshot.openAiConfigured ?? false,
  };
}

export function extrapolateProgressMs(
  snapshot: SongContextSnapshot,
  nowUtcMilliseconds = Date.now(),
): number | null {
  const track = snapshot.currentTrack;
  if (!track || track.progressMs === null) {
    return null;
  }

  const duration = track.durationMs ?? Number.MAX_SAFE_INTEGER;
  let progress = track.progressMs;
  if (track.isPlaying && !snapshot.stale) {
    const observedAt = Date.parse(track.observedAtUtc);
    if (Number.isFinite(observedAt)) {
      progress += Math.max(0, nowUtcMilliseconds - observedAt);
    }
  }

  return Math.min(Math.max(0, progress), Math.max(0, duration));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isLastFmState(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }

  return isObject(value) &&
    lastFmStatuses.includes(value.status as LastFmStatus) &&
    lastFmCacheSources.includes(value.cacheSource as LastFmCacheSource) &&
    Array.isArray(value.trackTags) && value.trackTags.every(isLastFmTag) &&
    Array.isArray(value.artistTags) && value.artistTags.every(isLastFmTag) &&
    isNullableString(value.matchedTrack) &&
    isNullableString(value.matchedArtist) &&
    isNullableString(value.trackMusicBrainzId) &&
    isNullableString(value.artistMusicBrainzId) &&
    (value.matchQuality === null ||
      lastFmMatchQualities.includes(value.matchQuality as LastFmMatchQuality)) &&
    isNullableString(value.retrievedAtUtc) &&
    (value.errorCategory === null ||
      lastFmErrorCategories.includes(value.errorCategory as LastFmErrorCategory)) &&
    isNullableString(value.nextRetryUtc);
}

function isLastFmTag(value: unknown): value is LastFmTag {
  if (!isObject(value) || typeof value.name !== "string") {
    return false;
  }

  return value.weight === null ||
    (typeof value.weight === "number" && Number.isFinite(value.weight) && value.weight >= 0 && value.weight <= 1);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}
