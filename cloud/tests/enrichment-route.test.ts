import { beforeEach, expect, it, vi } from "vitest";
import { handleEnrichment } from "../src/enrichment-route";
import { AuthFailure } from "../src/auth";
const ORIGIN = "https://synesthesia.example.test";
const input = { trackId: "syntheticTrack", requestId: "436761ca-46f5-4286-805b-eb73d8a50a51" };
const requestEnrichment = vi.fn(async () => ({ status: "ready" as "ready" | "pending" | "disabled" | "limited" }));
const factory = vi.fn(() => ({ requestEnrichment }));
const request = (body: unknown = input, headers: Record<string, string> = {}) => new Request(`${ORIGIN}/api/enrichment`,
  { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
beforeEach(() => {
  requestEnrichment.mockReset().mockResolvedValue({ status: "ready" }); factory.mockClear();
  for (const [key, value] of Object.entries({ DATABASE_URL: "postgres://fake:fake@db.example.test/fake",
    BETTER_AUTH_SECRET: "synthetic-secret-0123456789abcdefghij", BETTER_AUTH_URL: ORIGIN,
    SPOTIFY_CLIENT_ID: "synthetic-id", SPOTIFY_CLIENT_SECRET: "synthetic-secret",
    SPOTIFY_ALLOWED_USER_IDS: "synthetic-user", AI_ENRICHMENT_ENABLED: "false" })) vi.stubEnv(key, value);
});
it("forwards only the small validated request, private headers and cancellation", async () => {
  const req = request(); const response = await handleEnrichment(req, factory);
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ status: "ready" });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(requestEnrichment).toHaveBeenCalledWith(req.headers, input, req.signal);
});
it("rejects foreign/missing origin, GET, prompt fields and oversized JSON before constructing a service", async () => {
  for (const req of [request(input, { origin: "https://foreign.example.test" }), request(input, { origin: "" }),
    new Request(`${ORIGIN}/api/enrichment`), request({ ...input, prompt: "synthetic" }), request({ ...input, requestId: "invalid" }),
    request({ arbitrary: "x".repeat(1025) })]) {
    expect((await handleEnrichment(req, factory)).status).toBeGreaterThanOrEqual(400);
  }
  expect(factory).not.toHaveBeenCalled();
});
it("does not construct an integration when required configuration is missing", async () => {
  vi.stubEnv("DATABASE_URL", "");
  expect((await handleEnrichment(request(), factory)).status).toBe(503); expect(factory).not.toHaveBeenCalled();
});
it("maps pending/disabled/limited states and retains Retry-After", async () => {
  for (const [status, code] of [["pending", 202], ["disabled", 503], ["limited", 429]] as const) {
    requestEnrichment.mockResolvedValue({ status });
    const response = await handleEnrichment(request(), factory); expect(response.status).toBe(code);
    if (code === 429) expect(response.headers.get("retry-after")).toBe("60");
  }
});
it("redacts errors and never serializes extra fields from a dependency result", async () => {
  requestEnrichment.mockRejectedValueOnce(new AuthFailure(401));
  expect((await handleEnrichment(request(), factory)).status).toBe(401);
  requestEnrichment.mockResolvedValue({ status: "ready", token: "synthetic-secret" } as never);
  const response = await handleEnrichment(request(), factory);
  expect(response.status).toBe(503); expect(await response.text()).not.toContain("synthetic-secret");
});
