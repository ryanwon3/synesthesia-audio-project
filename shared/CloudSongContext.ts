import type { CurrentTrack, SpotifyAlbumIdentity, SpotifyArtistIdentity } from "./SongIdentity";
import { effects, hostedImageries, moods, type MoodTraits, type SongVisualProfile } from "./SongTraits";

export const cloudSongStatuses = [
  "playing",
  "paused",
  "none",
  "signedOut",
  "forbidden",
  "unavailable",
  "rateLimited",
] as const;
export type CloudSongStatus = typeof cloudSongStatuses[number];

export interface LastFmTag {
  name: string;
  weight: number | null;
}

export interface CloudSongCapabilities {
  lyrics: boolean;
  ai: boolean;
}

export interface CloudSongContextV1 {
  protocolVersion: 1;
  status: CloudSongStatus;
  observedAtUtc: string;
  nextRetryUtc: string | null;
  track: CurrentTrack | null;
  trackTags: LastFmTag[];
  artistTags: LastFmTag[];
  analysis: SongVisualProfile | null;
  capabilities: CloudSongCapabilities;
}

const maxDurationMs = 86_400_000;
const maxTextLength = 256;
const maxArtworkUrlLength = 2048;
const maxArtists = 16;
const maxTags = 32;
const maxSections = 16;

const idPattern = /^[A-Za-z0-9]{1,128}$/;
const isrcPattern = /^[A-Za-z0-9-]{1,32}$/;
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/;
const urlForbiddenCharacters = /[\s\u0000-\u001f\u007f-\u009f]/;
const timestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{3})?Z$/;
const releaseDatePattern = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;
const releaseDatePrecisions = ["year", "month", "day"] as const;

const contextKeys: readonly (keyof CloudSongContextV1)[] = [
  "protocolVersion", "status", "observedAtUtc", "nextRetryUtc", "track",
  "trackTags", "artistTags", "analysis", "capabilities",
];
const trackKeys: readonly (keyof CurrentTrack)[] = [
  "spotifyTrackId", "spotifyUri", "isrc", "title", "artists", "album",
  "durationMs", "explicit", "progressMs", "isPlaying", "observedAtUtc",
];
const artistKeys: readonly (keyof SpotifyArtistIdentity)[] = ["spotifyArtistId", "name"];
const albumKeys: readonly (keyof SpotifyAlbumIdentity)[] = [
  "spotifyAlbumId", "name", "artworkUrl", "releaseDate", "releaseDatePrecision",
];
const traitKeys: readonly (keyof MoodTraits)[] = [
  "mood", "energy", "tension", "softness", "imagery", "bassEffect", "midEffect", "trebleEffect",
];

type Fields = Record<string, unknown>;
type Section = SongVisualProfile["sections"][number];

export function isCloudSongContext(value: unknown): value is CloudSongContextV1 {
  if (!hasExactKeys(value, contextKeys)) return false;
  const { status, track, analysis, trackTags, artistTags } = value;
  if (value.protocolVersion !== 1 ||
    !oneOf(cloudSongStatuses, status) ||
    !isUtcTimestamp(value.observedAtUtc) ||
    !(value.nextRetryUtc === null || isUtcTimestamp(value.nextRetryUtc)) ||
    !isBoundedArray(trackTags, maxTags, isTag) ||
    !isBoundedArray(artistTags, maxTags, isTag) ||
    !isCapabilities(value.capabilities)) {
    return false;
  }

  if (status === "playing" || status === "paused") {
    return isTrack(track) &&
      track.isPlaying === (status === "playing") &&
      (analysis === null || isAnalysis(analysis, track.durationMs));
  }

  return track === null && analysis === null && trackTags.length === 0 && artistTags.length === 0;
}

function isTrack(value: unknown): value is CurrentTrack {
  if (!hasExactKeys(value, trackKeys)) return false;
  const { spotifyTrackId, durationMs, progressMs } = value;
  if (typeof spotifyTrackId !== "string" || !idPattern.test(spotifyTrackId)) return false;
  if (!(durationMs === null || isMs(durationMs))) return false;

  return (value.spotifyUri === null || value.spotifyUri === `spotify:track:${spotifyTrackId}`) &&
    (value.isrc === null || (typeof value.isrc === "string" && isrcPattern.test(value.isrc))) &&
    isNullableText(value.title) &&
    isBoundedArray(value.artists, maxArtists, isArtist) &&
    (value.album === null || isAlbum(value.album)) &&
    (progressMs === null || (isMs(progressMs) && progressMs <= (durationMs ?? maxDurationMs))) &&
    (value.explicit === null || typeof value.explicit === "boolean") &&
    typeof value.isPlaying === "boolean" &&
    isUtcTimestamp(value.observedAtUtc);
}

function isArtist(value: unknown): value is SpotifyArtistIdentity {
  return hasExactKeys(value, artistKeys) && isNullableId(value.spotifyArtistId) && isNullableText(value.name);
}

function isAlbum(value: unknown): value is SpotifyAlbumIdentity {
  return hasExactKeys(value, albumKeys) &&
    isNullableId(value.spotifyAlbumId) &&
    isNullableText(value.name) &&
    (value.artworkUrl === null || isArtworkUrl(value.artworkUrl)) &&
    isReleaseDate(value.releaseDate, value.releaseDatePrecision);
}

function isTag(value: unknown): value is LastFmTag {
  return hasExactKeys(value, ["name", "weight"]) && isText(value.name) && (value.weight === null || isUnit(value.weight));
}

function isCapabilities(value: unknown): value is CloudSongCapabilities {
  return hasExactKeys(value, ["lyrics", "ai"]) && typeof value.lyrics === "boolean" && typeof value.ai === "boolean";
}

function isAnalysis(value: unknown, durationMs: number | null): value is SongVisualProfile {
  if (!hasExactKeys(value, ["wholeSong", "sections"]) || !isHostedTraits(value.wholeSong)) return false;
  const sections = value.sections;
  if (!isBoundedArray(sections, maxSections, isSection)) return false;
  if (durationMs === null) return sections.length === 0;

  let previousEndMs = 0;
  for (const { startMs, endMs } of sections) {
    if (startMs < previousEndMs || endMs > durationMs) return false;
    previousEndMs = endMs;
  }
  return true;
}

function isSection(value: unknown): value is Section {
  if (!hasExactKeys(value, ["startMs", "endMs", "traits"])) return false;
  const { startMs, endMs } = value;
  return isMs(startMs) && isMs(endMs) && endMs > startMs && isHostedTraits(value.traits);
}

function isHostedTraits(value: unknown): value is MoodTraits {
  return hasExactKeys(value, traitKeys) &&
    oneOf(moods, value.mood) &&
    isUnit(value.energy) &&
    isUnit(value.tension) &&
    isUnit(value.softness) &&
    oneOf(hostedImageries, value.imagery) &&
    oneOf(effects, value.bassEffect) &&
    oneOf(effects, value.midEffect) &&
    oneOf(effects, value.trebleEffect);
}

function isArtworkUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > maxArtworkUrlLength || urlForbiddenCharacters.test(value)) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname !== "" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function isReleaseDate(date: unknown, precision: unknown): boolean {
  if (precision !== null && !oneOf(releaseDatePrecisions, precision)) return false;
  if (date === null) return true;
  const match = typeof date === "string" ? releaseDatePattern.exec(date) : null;
  if (!match) return false;

  const month = match[2];
  const day = match[3];
  const actual = day !== undefined ? "day" : month !== undefined ? "month" : "year";
  return (precision === null || precision === actual) &&
    isCalendarDate(Number(match[1]), month !== undefined ? Number(month) : 1, day !== undefined ? Number(day) : 1);
}

function isUtcTimestamp(value: unknown): value is string {
  const match = typeof value === "string" ? timestampPattern.exec(value) : null;
  return match !== null &&
    isCalendarDate(Number(match[1]), Number(match[2]), Number(match[3])) &&
    Number(match[4]) <= 23 &&
    Number(match[5]) <= 59 &&
    Number(match[6]) <= 59;
}

function isCalendarDate(year: number, month: number, day: number): boolean {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return month >= 1 && month <= 12 && day >= 1 && day <= days;
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Fields {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.keys(value).length === keys.length &&
    keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function isBoundedArray<T>(value: unknown, max: number, item: (value: unknown) => value is T): value is T[] {
  // Spread turns sparse holes into undefined so they fail the item guard.
  return Array.isArray(value) && value.length <= max && [...value].every(entry => item(entry));
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxTextLength && !controlCharacters.test(value);
}

function isNullableText(value: unknown): value is string | null {
  return value === null || isText(value);
}

function isNullableId(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && idPattern.test(value));
}

function isMs(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maxDurationMs;
}

function isUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
