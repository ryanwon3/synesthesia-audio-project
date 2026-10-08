import type { LastFmTag } from "../../shared/CloudSongContext";
import type { CurrentTrack } from "../../shared/SongIdentity";
import { readCloudConfig } from "./config";
import { record } from "./http";
import { ProviderFailure, providerJson } from "./provider-http";

export function normalizeLookupText(value: string): string {
  return value.normalize("NFKC").replace(/[‘’]/g, "'").replace(/[‐‑‒–—]/g, "-").replace(/\s+/gu, " ").trim().toLowerCase();
}
export function lookupTitles(title: string): string[] {
  const clean = title.trim();
  let alternate = clean.replace(/\s*[([]\s*(?:feat(?:uring)?|ft)\.?\s+.+[)\]]\s*$/i, "")
    .replace(/\s+(?:feat(?:uring)?|ft)\.?\s+.+$/i, "");
  const suffix = /^(.*?)(?:\s*[([]([^\])]+)[)\]]|\s+-\s+(.+))\s*$/.exec(alternate);
  if (suffix && /remaster(?:ed)?|explicit|clean|radio edit|single version|album version/i.test(normalizeLookupText(suffix[2] ?? suffix[3] ?? ""))) alternate = suffix[1]!.trimEnd();
  return alternate && alternate !== clean ? [clean, alternate] : [clean];
}
export function normalizeTags(value: unknown): LastFmTag[] {
  const list: unknown[] = Array.isArray(value) ? value : record(value) ? [value] : [];
  const tags = new Map<string, { count: number | null; rank: number }>();
  list.slice(0, 200).forEach((tag, rank) => {
    if (!record(tag) || typeof tag.name !== "string" || /[\u0000-\u001f\u007f-\u009f]/u.test(tag.name)) return;
    const name = tag.name.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
    if (!name || name.length > 80) return;
    const raw = typeof tag.count === "number" ? tag.count : typeof tag.count === "string" && /^\d+$/.test(tag.count) ? Number(tag.count) : NaN;
    const count = Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
    const prior = tags.get(name);
    tags.set(name, { count: prior ? Math.max(prior.count ?? 0, count ?? 0) || null : count, rank: Math.min(prior?.rank ?? rank, rank) });
  });
  const maximum = Math.max(0, ...[...tags.values()].map(tag => tag.count ?? 0));
  return [...tags].map(([name, tag]) => ({ name, weight: tag.count && maximum ? Math.round(tag.count / maximum * 100) / 100 : null, rank: tag.rank }))
    .filter(tag => tag.weight === null || tag.weight >= 0.1)
    .sort((a, b) => (b.weight ?? -1) - (a.weight ?? -1) || (a.weight === null ? a.rank - b.rank : a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, 20).map(({ name, weight }) => ({ name, weight }));
}
async function lookup(key: string, method: string, values: Record<string, string>, signal: AbortSignal): Promise<Record<string, unknown>> {
  const url = new URL("https://ws.audioscrobbler.com/2.0/");
  url.search = new URLSearchParams({ api_key: key, format: "json", method, ...values }).toString();
  const response = await providerJson(url, signal, 100000);
  if (!record(response)) throw new ProviderFailure(502);
  if (response.error !== undefined) {
    const code = Number(response.error);
    // 6/7 (not found / invalid resource) mean no match. Never surface the raw provider error.
    if (code === 6 || code === 7) return {};
    throw new ProviderFailure(code === 29 ? 429 : 502, code === 29 ? 60 : null);
  }
  return response;
}
export async function getTags(track: CurrentTrack, signal: AbortSignal): Promise<{ trackTags: LastFmTag[]; artistTags: LastFmTag[] }> {
  const config = readCloudConfig(process.env);
  const artist = track.artists.find(value => value.name?.trim())?.name;
  if (!config.ok || !config.config.lastFmApiKey || !track.title || !artist) return { trackTags: [], artistTags: [] };
  const key = config.config.lastFmApiKey;
  for (const title of lookupTitles(track.title)) {
    const info = await lookup(key, "track.getInfo", { artist, track: title, autocorrect: "1" }, signal);
    if (!record(info.track) || typeof info.track.name !== "string" || !record(info.track.artist) || typeof info.track.artist.name !== "string") continue;
    const duration = Number(info.track.duration);
    if (track.durationMs && Number.isFinite(duration) && duration > 0 && Math.abs(track.durationMs - duration) > Math.max(30000, track.durationMs * 0.2)) continue;
    const matches = normalizeLookupText(info.track.name) === normalizeLookupText(title) && normalizeLookupText(info.track.artist.name) === normalizeLookupText(artist);
    // Accept a corrected identity only when track["@attr"].corrected is exactly the string "1".
    const attr = info.track["@attr"];
    const corrected = record(attr) && attr.corrected === "1";
    if (!matches && !corrected) continue;
    const canonical = { artist: info.track.artist.name, track: info.track.name, autocorrect: "1" };
    const [trackResult, artistResult] = await Promise.all([
      lookup(key, "track.getTopTags", canonical, signal), lookup(key, "artist.getTopTags", { artist: canonical.artist, autocorrect: "1" }, signal),
    ]);
    return { trackTags: normalizeTags(record(trackResult.toptags) ? trackResult.toptags.tag : null),
      artistTags: normalizeTags(record(artistResult.toptags) ? artistResult.toptags.tag : null) };
  }
  return { trackTags: [], artistTags: [] };
}
