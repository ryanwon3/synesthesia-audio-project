// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudSongContextV1 } from "../../../shared/CloudSongContext";
import { AudioFrameClient } from "../audio/AudioFrameClient";
import { HostedSongContextClient } from "./HostedSongContextClient";
import type { SongContextSnapshot } from "./SongContext";

// Spy only: the hosted client must never construct the local audio client. Not proof of frame independence.
vi.mock("../audio/AudioFrameClient", () => ({ AudioFrameClient: vi.fn() }));

// Synthetic fetch, fake timers and deferred responses; not end-to-end, account or UI coverage.
interface Call { url: string; init: RequestInit; resolve: (response: Response) => void }

const at = "2026-01-01T00:00:00.000Z";
const id = (c: string): string => `Synth${c.repeat(17)}`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let calls: Call[] = [];
let autoAbort = true;
let snaps: SongContextSnapshot[] = [];
let statuses: string[] = [];
let client: HostedSongContextClient;

function dto(c = "A"): CloudSongContextV1 {
  const t = id(c);
  return {
    protocolVersion: 1, status: "playing", observedAtUtc: at, nextRetryUtc: null, analysis: null,
    capabilities: { lyrics: true, ai: true }, trackTags: [{ name: "dreamy", weight: 1 }], artistTags: [{ name: "shoegaze", weight: null }],
    track: {
      spotifyTrackId: t, spotifyUri: `spotify:track:${t}`, isrc: "USSYN2600001", title: "Synthetic title",
      artists: [{ spotifyArtistId: id("R"), name: "Synthetic artist" }],
      album: { spotifyAlbumId: id("L"), name: "Synthetic album", artworkUrl: "https://artwork.example/a.jpg", releaseDate: "2020-05-01", releaseDatePrecision: "day" },
      durationMs: 180_000, explicit: false, progressMs: 1_000, isPlaying: true, observedAtUtc: at,
    },
  };
}

const reply = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const isGet = (call: Call): boolean => (call.init.method ?? "GET").toUpperCase() === "GET";
const last = (): Call => calls[calls.length - 1]!;
async function flush(ms = 0): Promise<void> { await vi.advanceTimersByTimeAsync(ms); }

function expectSameOrigin({ url, init }: Call): void {
  expect(url.startsWith("/") && !url.startsWith("//") && !url.includes("://") && !url.includes("?"), url).toBe(true);
  expect(init.credentials ?? "same-origin").toBe("same-origin");
  expect(new Headers(init.headers).has("authorization")).toBe(false);
}

// Advances in 250ms steps until the next request starts; returns the elapsed delay.
async function nextDelay(): Promise<number> {
  const before = calls.length;
  for (let ms = 250; ms <= 65_000; ms += 250) {
    await flush(250);
    if (calls.length > before) return ms;
  }
  throw new Error("no request within 65s");
}

async function startWith(): Promise<void> {
  client.start();
  await flush();
  expect(calls).toHaveLength(1);
  last().resolve(reply(dto()));
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  autoAbort = true;
  snaps = [];
  statuses = [];
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    calls.push({ url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init: init ?? {}, resolve });
    init?.signal?.addEventListener("abort", () => { if (autoAbort) reject(new DOMException("Aborted", "AbortError")); });
  })));
  client = new HostedSongContextClient();
  client.onSnapshot((s) => { snaps.push(s); });
  client.onStatus((s) => { statuses.push(s); });
});

afterEach(() => {
  client.stop();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("HostedSongContextClient", () => {
  it("allows the server's bounded 20s pipeline to finish, never overlaps polls, and aborts after 25s", async () => {
    await startWith();
    expectSameOrigin(calls[0]!);
    expect(snaps.at(-1)?.currentTrack).toEqual(dto().track);
    expect(snaps.at(-1)?.stale).toBe(false);
    expect(statuses).toContain("connected");
    const delay = await nextDelay();
    expect(delay).toBeGreaterThanOrEqual(4_750);
    expect(delay).toBeLessThanOrEqual(5_250);
    const pending = last();
    await flush(24_000);
    expect(calls).toHaveLength(2);
    expect(pending.init.signal?.aborted ?? false).toBe(false);
    await flush(1_250);
    expect(pending.init.signal?.aborted).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("stop aborts the in-flight poll and ignores its late result", async () => {
    autoAbort = false;
    client.start();
    await flush();
    const inflight = last();
    client.stop();
    expect(inflight.init.signal?.aborted).toBe(true);
    const seen = snaps.length;
    inflight.resolve(reply(dto()));
    await flush(120_000);
    expect(snaps.slice(seen)).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(statuses.at(-1)).toBe("disconnected");
  });

  it("ignores an expired generation's result after a restart", async () => {
    autoAbort = false;
    client.start();
    await flush();
    const old = last();
    client.stop();
    client.start();
    await flush();
    expect(calls).toHaveLength(2);
    last().resolve(reply(dto("B")));
    await flush();
    old.resolve(reply(dto("A")));
    await flush();
    expect(snaps.at(-1)?.currentTrack?.spotifyTrackId).toBe(id("B"));
    expect(snaps.some((s) => s.currentTrack?.spotifyTrackId === id("A"))).toBe(false);
  });

  it("401 marks authentication required and stale, and the poll status disconnected", async () => {
    await startWith();
    await nextDelay();
    last().resolve(reply({ error: "unauthorized" }, 401));
    await flush();
    expect(snaps.at(-1)?.metadataStatus).toBe("authenticationRequired");
    expect(snaps.at(-1)?.stale).toBe(true);
    expect(statuses.at(-1)).toBe("disconnected");
    expect(AudioFrameClient).not.toHaveBeenCalled();
  });

  it("backs off exponentially up to 60s after failures and returns to 5s after success", async () => {
    await startWith();
    await nextDelay();
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      last().resolve(reply("", 503));
      await flush();
      delays.push(await nextDelay());
    }
    delays.forEach((delay, i) => {
      expect(delay).toBeLessThanOrEqual(60_000);
      if (i > 0) expect(delay).toBeGreaterThanOrEqual(delays[i - 1]!);
    });
    expect(delays[6]).toBeGreaterThanOrEqual(30_000);
    last().resolve(reply(dto()));
    await flush();
    const recovered = await nextDelay();
    expect(recovered).toBeGreaterThanOrEqual(4_750);
    expect(recovered).toBeLessThanOrEqual(5_250);
  });

  it("respects a positive Retry-After and emits no snapshot for invalid bodies", async () => {
    await startWith();
    const seen = snaps.length;
    await nextDelay();
    last().resolve(reply("not json", 429, { "retry-after": "30" }));
    await flush();
    const wait = await nextDelay();
    expect(wait).toBeGreaterThanOrEqual(30_000);
    expect(wait).toBeLessThanOrEqual(60_000);
    last().resolve(reply("{"));
    await flush();
    await nextDelay();
    last().resolve(reply({ ...dto(), accessToken: "syntheticSecretToken" }));
    await flush();
    expect(snaps.slice(seen)).toEqual([]);
  });

  it("posts same-origin enrichment with only trackId and a random UUID requestId, then repolls", async () => {
    await startWith();
    const requestIds: unknown[] = [];
    for (let i = 0; i < 2; i++) {
      const before = calls.length;
      const done = client.requestAnalysis(id("A"));
      void done.catch(() => {});
      await flush();
      const post = calls.slice(before).find((call) => call.init.method?.toUpperCase() === "POST");
      expect(post, "enrichment POST").toBeDefined();
      expectSameOrigin(post!);
      expect(post!.init.credentials).toBe("same-origin");
      expect(new Headers(post!.init.headers).get("content-type")).toContain("application/json");
      const body = JSON.parse(String(post!.init.body)) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["requestId", "trackId"]);
      expect(body["trackId"]).toBe(id("A"));
      expect(body["requestId"]).toMatch(uuid);
      requestIds.push(body["requestId"]);
      post!.resolve(new Response(null, { status: 202 }));
      await flush();
      const repoll = calls.slice(calls.indexOf(post!) + 1).find(isGet);
      expect(repoll, "repoll after enrichment").toBeDefined();
      expectSameOrigin(repoll!);
      repoll!.resolve(reply(dto()));
      await flush();
      await expect(done).resolves.toBeUndefined();
    }
    expect(new Set(requestIds).size).toBe(2);
  });
  it("discards unread enrichment response bodies on success and after a late aborted response", async () => {
    await startWith();
    const cancel = vi.fn();
    const done = client.requestAnalysis(id("A"));
    const post = last();
    post.resolve(new Response(new ReadableStream({ cancel }), { status: 202 }));
    await flush(); await done;
    expect(cancel).toHaveBeenCalledOnce();
    // The success force-poll must be resolved before the second request.
    last().resolve(reply(dto())); await flush();
    autoAbort = false;
    const lateCancel = vi.fn();
    const late = client.requestAnalysis(id("A"));
    const rejected = late.then(() => null, error => error as Error);
    const pending = last(); client.stop();
    pending.resolve(new Response(new ReadableStream({ cancel: lateCancel }), { status: 202 }));
    await flush(); expect(await rejected).toBeInstanceOf(Error);
    expect(lateCancel).toHaveBeenCalledOnce();
  });

  it("a snapshot listener calling stop() suppresses later listeners for the same old batch", async () => {
    const probe = vi.fn();
    client.onSnapshot(() => { client.stop(); });
    client.onSnapshot(probe);
    client.start();
    await flush();
    last().resolve(reply(dto()));
    await flush();
    expect(snaps).toHaveLength(1);
    expect(probe).toHaveBeenCalledTimes(0);
    expect(statuses.at(-1)).toBe("disconnected");
  });

  it("a status listener calling stop() on connected never lets a later listener see the old connected", async () => {
    const probe: string[] = [];
    let stops = 0;
    client.onStatus((s) => { if (s === "connected" && stops++ === 0) client.stop(); });
    client.onStatus((s) => { probe.push(s); });
    client.start();
    await flush();
    last().resolve(reply(dto()));
    await flush(60_000);
    expect(stops).toBe(1);
    expect(calls).toHaveLength(1);
    expect(probe.filter((s) => s === "connected")).toEqual([]);
    expect(probe.every((s) => s === "connecting" || s === "disconnected")).toBe(true);
    expect(statuses.at(-1)).toBe("disconnected");
  });

  it("cancels an oversized (>262144 UTF-8 bytes) unterminated body immediately, before the 5s timeout", async () => {
    await startWith();
    await nextDelay();
    expect(calls).toHaveLength(2);
    const seen = snaps.length;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(262_145)); },
      cancel,
    });
    last().resolve(new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
    await flush(0);
    expect(cancel).toHaveBeenCalled();
    expect(snaps.slice(seen)).toEqual([]);
    expect(statuses.at(-1)).toBe("disconnected");
    expect(calls).toHaveLength(2);
  });
});
