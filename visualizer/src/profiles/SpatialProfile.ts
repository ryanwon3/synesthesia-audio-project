import type { RgbColor } from "../mappings/VisualState";
import type { CurrentTrack } from "../song/SongContext";
import type { SynesthesiaProfile } from "./SynesthesiaProfile";

export type SpatialThemeId = "personal" | "bronze-rain-glass";
export interface SongThemeOverride {
  match: { spotifyTrackId: string | null; title: string; artist: string };
  themeId: "bronze-rain-glass";
  waveColor: string;
}
export interface SpatialPreferences {
  schemaVersion: 1;
  mode: "painting" | "spatial";
  waveStrength: number;
  rainStrength: number;
  glassStrength: number;
  fallSpeed: number;
  waveScale: number;
  rainPersistence: number;
  depth: number;
  songOverrides: SongThemeOverride[];
}
export interface ResolvedSpatialTheme {
  id: SpatialThemeId;
  background: RgbColor;
  waveColorOverride: RgbColor | null;
}

// Starting suggestion for the bronze wave tint, and the fallback for any invalid tint.
export const defaultBronzeWaveColor = "#b88654";
export const maxSongOverrides = 32;
export function isSpatialWaveColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

export function defaultSpatialPreferences(): SpatialPreferences {
  return { schemaVersion: 1, mode: "painting", waveStrength: 0.5, rainStrength: 0.65,
    glassStrength: 0.65, fallSpeed: 0.4, waveScale: 0.5, rainPersistence: 0.45,
    depth: 0.6, songOverrides: [] };
}

const controls = ["waveStrength", "rainStrength", "glassStrength", "fallSpeed", "waveScale", "rainPersistence", "depth"] as const;
export function isSpatialPreferences(value: unknown): value is SpatialPreferences {
  return hasShape(value, ["schemaVersion", "mode", ...controls, "songOverrides"]) &&
    value.schemaVersion === 1 && (value.mode === "painting" || value.mode === "spatial") &&
    controls.every(key => typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 1) &&
    Array.isArray(value.songOverrides) && value.songOverrides.length <= maxSongOverrides && value.songOverrides.every(isSongThemeOverride);
}
// A session tint only colors the manual bronze theme; saved song themes keep their own wave color.
export function resolveSpatialTheme(profile: SynesthesiaProfile, track: CurrentTrack | null,
  manualTheme: SpatialThemeId | null, manualWaveColor: string | null = null): ResolvedSpatialTheme {
  const personal: ResolvedSpatialTheme = { id: "personal", background: [0.02, 0.025, 0.03], waveColorOverride: null };
  if (manualTheme === "personal") return personal;
  if (manualTheme === "bronze-rain-glass") {
    return bronze(isSpatialWaveColor(manualWaveColor) ? manualWaveColor : defaultBronzeWaveColor);
  }
  if (!track || !isSpatialPreferences(profile.spatial)) return personal;
  const overrides = profile.spatial.songOverrides;
  // An ID-bearing override never falls back to display names for another recording.
  const exact = overrides.find(item => item.match.spotifyTrackId !== null && item.match.spotifyTrackId === track.spotifyTrackId);
  if (exact) return bronze(exact.waveColor);
  const title = normalizedName(track.title);
  const artists = Array.isArray(track.artists) ? track.artists : [];
  const byName = overrides.find(item => item.match.spotifyTrackId === null && title !== "" &&
    normalizedName(item.match.title) === title && artists.some(artist =>
      artist !== null && normalizedName(artist.name) === normalizedName(item.match.artist)));
  return byName ? bronze(byName.waveColor) : personal;
}
// Replaces every entry for the same association at the first one's position; null when a new entry
// would exceed the limit. Never evicts.
export function withSongOverride(overrides: readonly SongThemeOverride[], entry: SongThemeOverride): SongThemeOverride[] | null {
  const first = overrides.findIndex(item => sameAssociation(item.match, entry.match));
  if (first < 0) return overrides.length < maxSongOverrides ? [...overrides, structuredClone(entry)] : null;
  const next = overrides.filter(item => !sameAssociation(item.match, entry.match));
  next.splice(first, 0, structuredClone(entry));
  return next;
}
// ID-bearing entries match by ID only; name-only entries match other name-only entries by normalized names.
function sameAssociation(left: SongThemeOverride["match"], right: SongThemeOverride["match"]): boolean {
  if (left.spotifyTrackId !== null || right.spotifyTrackId !== null) return left.spotifyTrackId === right.spotifyTrackId;
  return normalizedName(left.title) === normalizedName(right.title) && normalizedName(left.artist) === normalizedName(right.artist);
}
function bronze(hex: string): ResolvedSpatialTheme {
  const value = Number.parseInt(hex.slice(1), 16);
  return { id: "bronze-rain-glass", background: [0, 0, 0],
    waveColorOverride: [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255] };
}
function normalizedName(value: string | null): string {
  return typeof value === "string" ? value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase() : "";
}
export function isSongThemeOverride(value: unknown): value is SongThemeOverride {
  if (!hasShape(value, ["match", "themeId", "waveColor"]) || value.themeId !== "bronze-rain-glass" ||
      !isSpatialWaveColor(value.waveColor)) return false;
  const match = value.match;
  return hasShape(match, ["spotifyTrackId", "title", "artist"]) &&
    (match.spotifyTrackId === null || typeof match.spotifyTrackId === "string" && /^[a-z0-9]{1,128}$/i.test(match.spotifyTrackId)) &&
    boundedName(match.title, 256) && boundedName(match.artist, 128);
}
function boundedName(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}
function hasShape(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && keys.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => keys.includes(key));
}
