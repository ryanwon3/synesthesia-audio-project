import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { PostgresEnrichmentRepository } from "../src/enrichment-repository";
import type { CurrentTrack } from "../../shared/SongIdentity";
import type { SongVisualProfile } from "../../shared/SongTraits";
const KEY = "a".repeat(64); const HASH = "b".repeat(64);
const OWNER = "dd3b2d07-d319-4257-9f10-04cb249bfa16";
const track: CurrentTrack = { spotifyTrackId: "syntheticTrack", spotifyUri: null, isrc: null,
  title: "Synthetic", artists: [], album: null, durationMs: 180000, explicit: false,
  progressMs: 1000, isPlaying: true, observedAtUtc: "2026-10-08T20:00:00.000Z" };
const profile: SongVisualProfile = { wholeSong: { mood: "calm", energy: 0.2, tension: 0.1, softness: 0.9,
  imagery: "air", bassEffect: "ripples", midEffect: "clouds", trebleEffect: "sparks" }, sections: [] };
function fixture(rows: Record<string, unknown>[]) {
  const query = vi.fn(async (_sql: string, _parameters: unknown[]) => ({ rows, rowCount: rows.length }));
  return { query, repo: new PostgresEnrichmentRepository({ query } as unknown as Pool, { model: "synthetic-model", promptVersion: 1 }) };
}
// External query doubles do not prove PostgreSQL locks or lease atomicity.
it("looks up one exact cache key without an eager connection", async () => {
  const { repo, query } = fixture([{ profile }]); expect(query).not.toHaveBeenCalled();
  expect(await repo.read(KEY)).toEqual(profile); expect(query.mock.calls[0]?.[1]).toEqual([KEY]);
});
it("publishes only when the database returns this cache key and parameterizes owner and bounded profile", async () => {
  const { repo, query } = fixture([{ cache_key: KEY }]);
  expect(await repo.finish(KEY, OWNER, track, HASH, profile)).toBe(true);
  const parameters = query.mock.calls[0]?.[1];
  expect(parameters?.slice(0, 6)).toEqual([KEY, OWNER, track.spotifyTrackId, "synthetic-model", 1, HASH]);
  expect(JSON.parse(parameters?.[6] as string)).toEqual(profile);
  expect(await fixture([]).repo.finish(KEY, OWNER, track, HASH, profile)).toBe(false);
});
it("rejects unbounded profiles or cache identity before touching the database", async () => {
  const { repo, query } = fixture([]);
  for (const [key, value] of [["invalid-key", profile], [KEY, { ...profile, providerToken: "synthetic-secret" } as SongVisualProfile]] as const) {
    expect(await repo.finish(key, OWNER, track, HASH, value)).toBe(false);
  }
  expect(query).not.toHaveBeenCalled();
});
it("redacts transport failures", async () => {
  const { repo, query } = fixture([]); query.mockRejectedValue(new Error("synthetic-secret host"));
  await expect(repo.read(KEY)).rejects.toThrow("Analysis cache unavailable");
});
