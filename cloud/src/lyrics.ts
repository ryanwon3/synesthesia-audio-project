import { createHash } from "node:crypto";
import type { CurrentTrack } from "../../shared/SongIdentity";
import { record } from "./http";
import { ProviderFailure, providerJson } from "./provider-http";
export interface LyricLine { text: string; startMs: number | null }
export interface LyricsInput { timed: boolean; lines: LyricLine[] }
export function parseLines(synced: string | null, plain: string | null, durationMs: number): LyricsInput {
  const lines: LyricLine[] = [];
  if (synced) {
    const offset = Number(/\[offset:([+-]?\d+)\]/i.exec(synced)?.[1] ?? 0);
    for (const raw of synced.split("\n")) {
      const text = raw.replace(/\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]/g, "").trim();
      for (const stamp of raw.matchAll(/\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]/g)) {
        const startMs = Math.trunc((Number(stamp[1]) * 60 + Number(stamp[2])) * 1000) + offset;
        if (Number.isSafeInteger(startMs) && startMs >= 0 && startMs < durationMs) lines.push({ text, startMs });
      }
    }
  }
  if (lines.some(line => line.text.length)) {
    const unique = new Set<string>();
    return { timed: true, lines: lines.sort((a, b) => a.startMs! - b.startMs!).filter(line => {
      const key = JSON.stringify(line); if (unique.has(key)) return false; unique.add(key); return true;
    }).slice(0, 600) };
  }
  return { timed: false, lines: (plain ?? "").split("\n").map(text => text.trim()).filter(Boolean).slice(0, 600).map(text => ({ text, startMs: null })) };
}
const normalize = (value: string): string => value.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
export async function getMatchedLyrics(track: CurrentTrack, signal: AbortSignal): Promise<{ text: string; source: string; hash: string } | null> {
  const artist = track.artists[0]?.name;
  if (!track.title || !artist || !track.durationMs) return null;
  const url = new URL("https://lrclib.net/api/get");
  url.search = new URLSearchParams({ track_name: track.title, artist_name: artist, album_name: track.album?.name ?? "", duration: String(Math.floor(track.durationMs / 1000)) }).toString();
  let value: unknown;
  try { value = await providerJson(url, signal, 100000, { headers: { "User-Agent": "SpotifySynesthesia/1.0" } }); }
  catch (error) { if (error instanceof ProviderFailure && error.status === 404) return null; throw error; }
  if (!record(value) || typeof value.trackName !== "string" || typeof value.artistName !== "string" || typeof value.duration !== "number" ||
    !Number.isFinite(value.duration) || normalize(value.trackName) !== normalize(track.title) || normalize(value.artistName) !== normalize(artist) ||
    Math.abs(value.duration * 1000 - track.durationMs) > 2000) return null;
  if (track.album?.name && typeof value.albumName === "string" && value.albumName.trim() && normalize(value.albumName) !== normalize(track.album.name)) return null;
  const document = parseLines(typeof value.syncedLyrics === "string" ? value.syncedLyrics : null, typeof value.plainLyrics === "string" ? value.plainLyrics : null, track.durationMs);
  if (!document.lines.some(line => line.text.length)) return null;
  // Internal structured input only; this document is never cached or returned to the browser.
  const text = JSON.stringify(document);
  return { text, source: "LRCLIB", hash: createHash("sha256").update(text).digest("hex") };
}
