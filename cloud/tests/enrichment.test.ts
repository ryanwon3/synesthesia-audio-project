import { afterEach, expect, it, vi } from "vitest";
import { AuthFailure } from "../src/auth";
import { createEnrichmentService, type EnrichmentDependencies } from "../src/enrichment";
import type { CloudSongContextV1 } from "../../shared/CloudSongContext";
import type { SongVisualProfile } from "../../shared/SongTraits";

const NOW = "2026-10-08T20:00:00.000Z";
const REQUEST = { trackId: "syntheticTrack", requestId: "436761ca-46f5-4286-805b-eb73d8a50a51" };
const profile: SongVisualProfile = { wholeSong: { mood: "calm", energy: 0.2, tension: 0.1, softness: 0.9,
  imagery: "air", bassEffect: "ripples", midEffect: "clouds", trebleEffect: "sparks" }, sections: [] };
const context: CloudSongContextV1 = { protocolVersion: 1, status: "playing", observedAtUtc: NOW, nextRetryUtc: null,
  capabilities: { lyrics: true, ai: true }, trackTags: [], artistTags: [], analysis: null,
  track: { spotifyTrackId: REQUEST.trackId, spotifyUri: `spotify:track:${REQUEST.trackId}`, isrc: null,
    title: "Synthetic song", artists: [{ spotifyArtistId: null, name: "Synthetic artist" }], album: null,
    durationMs: 180000, explicit: false, progressMs: 1000, isPlaying: true, observedAtUtc: NOW } };
function fixture() {
  const deps = { enabled: true as boolean, model: "synthetic-model", promptVersion: 1,
    requireUser: vi.fn(async () => ({ userId: "synthetic-user" })), allowEnrichment: vi.fn(async () => true),
    getSongContext: vi.fn(async () => structuredClone(context)),
    getLyrics: vi.fn(async () => ({ text: '{"timed":false,"lines":[{"text":"Synthetic lyric","startMs":null}]}',
      source: "Synthetic", hash: "a".repeat(64) })),
    analyze: vi.fn(async () => profile), reserve: vi.fn(async () => ({ status: "reserved" as const,
      owner: "2765da96-515a-4b68-a7e2-6e7287b8b2b6" })),
    repository: { read: vi.fn(async (): Promise<unknown> => null), finish: vi.fn(async () => true) },
    now: () => new Date(NOW),
  } satisfies EnrichmentDependencies;
  return { deps, service: createEnrichmentService(deps), signal: new AbortController().signal };
}
afterEach(() => vi.useRealTimers());

it("never starts authentication, providers or reservations when paid enrichment is disabled", async () => {
  const { deps, signal } = fixture(); deps.enabled = false;
  expect(await createEnrichmentService(deps).requestEnrichment(new Headers(), REQUEST, signal)).toEqual({ status: "disabled" });
  expect(deps.requireUser).not.toHaveBeenCalled(); expect(deps.analyze).not.toHaveBeenCalled(); expect(deps.reserve).not.toHaveBeenCalled();
});
it("uses only the authenticated current song, commits a reservation before analysis and caches validated traits only", async () => {
  const { deps, service, signal } = fixture();
  expect(await service.requestEnrichment(new Headers(), REQUEST, signal)).toEqual({ status: "ready" });
  expect(deps.reserve).toHaveBeenCalledWith("synthetic-user", REQUEST.trackId, REQUEST.requestId, expect.stringMatching(/^[a-f0-9]{64}$/));
  expect(deps.reserve.mock.invocationCallOrder[0]).toBeLessThan(deps.analyze.mock.invocationCallOrder[0]!);
  expect(deps.repository.finish).toHaveBeenCalledWith(expect.any(String), expect.any(String), context.track, "a".repeat(64), profile);
  expect(deps.requireUser).toHaveBeenCalledTimes(3);
});
it("rejects caller prompts, identities, invalid UUIDs and another song before providers or spending", async () => {
  const { deps, service, signal } = fixture();
  for (const request of [{ ...REQUEST, prompt: "synthetic prompt" }, { ...REQUEST, userId: "another-user" },
    { ...REQUEST, requestId: "not-a-uuid" }, { ...REQUEST, trackId: "anotherTrack" }]) {
    await expect(service.requestEnrichment(new Headers(), request, signal)).rejects.toThrow();
  }
  expect(deps.getLyrics).not.toHaveBeenCalled(); expect(deps.analyze).not.toHaveBeenCalled(); expect(deps.reserve).not.toHaveBeenCalled();
});
it("reuses validated cached analysis without a reservation or paid request", async () => {
  const { deps, service, signal } = fixture(); deps.repository.read.mockResolvedValue(profile);
  expect(await service.requestEnrichment(new Headers(), REQUEST, signal)).toEqual({ status: "ready" });
  expect(deps.reserve).not.toHaveBeenCalled(); expect(deps.analyze).not.toHaveBeenCalled();
});
it("does not analyze when request rate or daily budget is exhausted, or another owner has a lease", async () => {
  const { deps, service, signal } = fixture(); deps.allowEnrichment.mockResolvedValue(false);
  expect(await service.requestEnrichment(new Headers(), REQUEST, signal)).toEqual({ status: "limited" });
  expect(deps.getLyrics).not.toHaveBeenCalled();
  deps.allowEnrichment.mockResolvedValue(true);
  for (const status of ["limited", "pending", "duplicate", "cached"] as const) {
    deps.reserve.mockResolvedValue({ status, owner: null } as never);
    expect((await service.requestEnrichment(new Headers(), REQUEST, signal)).status).toBe(status === "limited" ? "limited" : "pending");
  }
  expect(deps.analyze).not.toHaveBeenCalled();
});
it("does not write if identity changes or analysis contains an extra secret field", async () => {
  const { deps, service, signal } = fixture();
  deps.requireUser.mockResolvedValueOnce({ userId: "synthetic-user" }).mockResolvedValue({ userId: "different-user" });
  await expect(service.requestEnrichment(new Headers(), REQUEST, signal)).rejects.toBeInstanceOf(AuthFailure);
  expect(deps.analyze).not.toHaveBeenCalled();
  deps.requireUser.mockResolvedValue({ userId: "synthetic-user" });
  deps.analyze.mockResolvedValue({ ...profile, providerToken: "synthetic-secret" } as SongVisualProfile);
  await expect(service.requestEnrichment(new Headers(), REQUEST, signal)).rejects.toThrow("Enrichment unavailable");
  expect(deps.repository.finish).not.toHaveBeenCalled();
});
it("an aborted or timed-out provider cannot start a later cache write", async () => {
  vi.useFakeTimers(); const { deps, service } = fixture(); const controller = new AbortController();
  let complete!: (value: SongVisualProfile) => void;
  deps.analyze.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const work = service.requestEnrichment(new Headers(), REQUEST, controller.signal);
  const outcome = work.then(() => null, error => error as Error);
  await vi.advanceTimersByTimeAsync(1);
  expect(deps.analyze).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(20000); complete(profile);
  expect((await outcome)?.message).toBe("Enrichment unavailable");
  await vi.advanceTimersByTimeAsync(1);
  expect(deps.repository.finish).not.toHaveBeenCalled();
});
