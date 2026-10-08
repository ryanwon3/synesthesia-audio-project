import { expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { PostgresContextRepository } from "../src/context-repository";
import type { CloudSongContextV1 } from "../../shared/CloudSongContext";

const USER = "synthetic-user-a";
const OWNER = "a426c7a4-2a10-4cb5-a4a6-7a49091a0ed1";
const NOW = new Date("2026-10-08T20:00:00.000Z");
const context: CloudSongContextV1 = {
  protocolVersion: 1, status: "playing", observedAtUtc: NOW.toISOString(), nextRetryUtc: null,
  track: { spotifyTrackId: "track0001", spotifyUri: "spotify:track:track0001", isrc: null,
    title: "Synthetic Song", artists: [{ spotifyArtistId: "artist0001", name: "Synthetic Artist" }],
    album: null, durationMs: 180000, explicit: false, progressMs: 1000, isPlaying: true,
    observedAtUtc: NOW.toISOString() },
  trackTags: [], artistTags: [], analysis: null, capabilities: { lyrics: false, ai: false },
};
const track = context.track!;
const tags = { trackTags: [{ name: "synthwave", weight: 1 }], artistTags: [] };

// Only the external pg query boundary is doubled. These checks prove parameter
// scoping/redaction/serialization, NOT actual SQL locking or database atomicity.
function database(rows: Record<string, unknown>[]) {
  const query = vi.fn(async (_sql: string, _parameters: unknown[]) =>
    ({ rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] }));
  const pool = { query } as unknown as Pool;
  return { query, repo: new PostgresContextRepository(pool, { model: "synthetic-model", promptVersion: 1 }) };
}

it("reads only the authenticated user's saved context without eager database work", async () => {
  const { query, repo } = database([{ context }]);
  expect(query).not.toHaveBeenCalled();
  expect(await repo.readContext(USER)).toEqual(context);
  expect(query.mock.calls[0]?.[1]).toEqual([USER]);
});

it("recognizes a poll claim only when PostgreSQL returns this exact owner", async () => {
  const yes = database([{ poll_owner: OWNER }]);
  expect(await yes.repo.claimPoll(USER, OWNER, NOW)).toBe(true);
  expect(yes.query.mock.calls[0]?.[1]).toEqual([USER, OWNER, NOW]);
  expect(await database([]).repo.claimPoll(USER, OWNER, NOW)).toBe(false);
  expect(await database([{ poll_owner: "foreign-owner" }]).repo.claimPoll(USER, OWNER, NOW)).toBe(false);
});

it("finishes with user and owner parameters and only validated context JSON", async () => {
  const { repo, query } = database([{ user_id: USER }]);
  expect(await repo.finishPoll(USER, OWNER, context, null)).toBe(true);
  const parameters = query.mock.calls[0]?.[1];
  expect(parameters?.slice(0, 2)).toEqual([USER, OWNER]);
  expect(JSON.parse(parameters?.[2] as string)).toEqual(context);
  expect(parameters?.slice(3)).toEqual([NOW, null]);
  expect(await database([]).repo.finishPoll(USER, OWNER, context, null)).toBe(false);
});

it("rejects malformed context and mismatched retry before any database write", async () => {
  const { repo, query } = database([{ user_id: USER }]);
  const unsafe = { ...context, providerToken: "synthetic-secret" } as CloudSongContextV1;
  expect(await repo.finishPoll(USER, OWNER, unsafe, null)).toBe(false);
  expect(await repo.finishPoll(USER, OWNER, context, new Date(NOW.getTime() + 1000))).toBe(false);
  expect(query).not.toHaveBeenCalled();
});

it("reads cached tags and does not cache playback progress as song identity", async () => {
  const { repo, query } = database([{ tags }]);
  expect(await repo.readTags(track)).toEqual(tags);
  await repo.readTags({ ...track, progressMs: 99000, observedAtUtc: "2026-10-08T20:01:00.000Z" });
  expect(query.mock.calls[0]?.[1]).toEqual(query.mock.calls[1]?.[1]);
});

it("stores bounded normalized tags, rejecting secret fields and false negative classification", async () => {
  const { repo, query } = database([]);
  await repo.saveTags(track, tags, false);
  const parameters = query.mock.calls[0]?.[1];
  expect(typeof parameters?.[0]).toBe("string");
  expect(JSON.parse(parameters?.[1] as string)).toEqual(tags);
  expect(Number(parameters?.[2])).toBeGreaterThan(0);
  query.mockClear();
  await expect(repo.saveTags(track, { ...tags, providerToken: "synthetic-secret" } as typeof tags, false))
    .rejects.toThrow("Context cache unavailable");
  await expect(repo.saveTags(track, { trackTags: [], artistTags: [] }, false))
    .rejects.toThrow("Context cache unavailable");
  expect(query).not.toHaveBeenCalled();
});

it("reads analysis only for this Spotify track, configured model and prompt version", async () => {
  const profile = { wholeSong: { mood: "calm" }, sections: [] };
  const { repo, query } = database([{ profile }]);
  expect(await repo.readAnalysis(track)).toEqual(profile);
  expect(query.mock.calls[0]?.[1]).toEqual(["track0001", "synthetic-model", 1]);
});

it("redacts database errors instead of exposing server details", async () => {
  const { repo, query } = database([]);
  query.mockRejectedValue(new Error("synthetic-secret and database host"));
  await expect(repo.readContext(USER)).rejects.toThrow("Context cache unavailable");
});
it("persists provider cooldown separately from a 30-day negative lookup and bounds invalid retry durations", async () => {
  const { repo, query } = database([]);
  await repo.deferTags(track, 90);
  const parameters = query.mock.calls[0]?.[1];
  expect(JSON.parse(parameters?.[1] as string)).toEqual({ trackTags: [], artistTags: [] });
  expect(parameters?.[2]).toBe(90);
  await repo.deferTags(track, Infinity);
  expect(query.mock.calls[1]?.[1]?.[2]).toBe(60);
  await repo.deferTags(track, 999999);
  expect(query.mock.calls[2]?.[1]?.[2]).toBe(86400);
});
it("checks the shared Last.fm cooldown rather than allowing a new song or user to bypass it", async () => {
  const yes = database([{ provider: "lastfm" }]);
  expect(await yes.repo.lastFmCoolingDown()).toBe(true);
  expect(await database([]).repo.lastFmCoolingDown()).toBe(false);
  expect(yes.query.mock.calls[0]?.[1]).toEqual([]);
});
