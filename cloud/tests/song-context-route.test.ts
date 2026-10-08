import { beforeEach, expect, it, vi } from "vitest";
import type { CloudSongContextV1 } from "../../shared/CloudSongContext";
import { handleSongContext } from "../src/song-context-route";

const ORIGIN = "https://synesthesia.example.test";
const context: CloudSongContextV1 = { protocolVersion: 1, status: "none",
  observedAtUtc: "2026-10-08T20:00:00.000Z", nextRetryUtc: null, track: null,
  trackTags: [], artistTags: [], analysis: null, capabilities: { lyrics: true, ai: false } };
const getSongContext = vi.fn(async () => context);
const service = () => ({ getSongContext });
beforeEach(() => {
  getSongContext.mockReset().mockResolvedValue(context);
  for (const [key, value] of Object.entries({ DATABASE_URL: "postgres://fake:fake@db.example.test/fake",
    BETTER_AUTH_SECRET: "synthetic-secret-0123456789abcdefghij", BETTER_AUTH_URL: ORIGIN,
    SPOTIFY_CLIENT_ID: "synthetic-id", SPOTIFY_CLIENT_SECRET: "synthetic-secret",
    SPOTIFY_ALLOWED_USER_IDS: "synthetic-user", AI_ENRICHMENT_ENABLED: "false" })) vi.stubEnv(key, value);
});

it("serves the context with private headers and forwards only headers and cancellation", async () => {
  const request = new Request(`${ORIGIN}/api/song-context`, { headers: { cookie: "synthetic-session" } });
  const response = await handleSongContext(request, service);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await response.json()).toEqual(context);
  expect(getSongContext).toHaveBeenCalledWith(request.headers, request.signal);
});

it("rejects foreign origins, cross-site reads, queries and non-GET before invoking the service", async () => {
  for (const request of [new Request("https://foreign.example.test/api/song-context"),
    new Request(`${ORIGIN}/api/song-context`, { headers: { origin: "https://foreign.example.test" } }),
    new Request(`${ORIGIN}/api/song-context`, { headers: { "sec-fetch-site": "cross-site" } }),
    new Request(`${ORIGIN}/api/song-context?userId=other`),
    new Request(`${ORIGIN}/api/song-context`, { method: "POST" })]) {
    expect((await handleSongContext(request, service)).status).toBeGreaterThanOrEqual(400);
  }
  expect(getSongContext).not.toHaveBeenCalled();
});

it("does not construct the service when configuration is incomplete", async () => {
  vi.stubEnv("DATABASE_URL", "");
  const factory = vi.fn(service);
  expect((await handleSongContext(new Request(`${ORIGIN}/api/song-context`), factory)).status).toBe(503);
  expect(factory).not.toHaveBeenCalled();
});

it("redacts exceptions and rejects extra secret fields instead of serializing them", async () => {
  for (const bad of [() => Promise.reject(new Error("synthetic-provider-token")),
    async () => ({ ...context, providerToken: "synthetic-provider-token" })]) {
    getSongContext.mockImplementation(bad);
    const response = await handleSongContext(new Request(`${ORIGIN}/api/song-context`), service);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("synthetic-provider-token");
  }
});

it("maps signed-out, forbidden and provider cooldown states without disguising failure as success", async () => {
  for (const [status, code] of [["signedOut", 401], ["forbidden", 403], ["rateLimited", 429], ["unavailable", 503]] as const) {
    getSongContext.mockResolvedValue({ ...context, status,
      nextRetryUtc: status === "rateLimited" ? new Date(Date.now() + 60000).toISOString() : null });
    const response = await handleSongContext(new Request(`${ORIGIN}/api/song-context`), service);
    expect(response.status).toBe(code);
    if (code === 429) expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
  }
});
