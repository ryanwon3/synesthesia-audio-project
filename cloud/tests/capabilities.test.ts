import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CONFIG_NAMES: readonly string[] = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "SPOTIFY_CLIENT_ID",
  "SPOTIFY_CLIENT_SECRET",
  "SPOTIFY_ALLOWED_USER_IDS",
  "AI_ENRICHMENT_ENABLED",
  "OPENAI_MODEL",
  "OPENAI_API_KEY",
];
const RUNTIME_KEYS = ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "NODE_ENV"];

const VALID_ENV: Record<string, string> = {
  DATABASE_URL: "postgres://fake_user:fake-db-password@db.example.invalid:6543/fake_db",
  BETTER_AUTH_SECRET: "fake-auth-secret-0123456789abcdef0123456789abcdef",
  BETTER_AUTH_URL: "https://synesthesia.example.invalid",
  SPOTIFY_CLIENT_ID: "fake-spotify-client-id",
  SPOTIFY_CLIENT_SECRET: "fake-spotify-client-secret",
  SPOTIFY_ALLOWED_USER_IDS: "fake-user-a,fake-user-b",
};
const FAKE_OPENAI_KEY = "sk-fake-openai-key-not-real";

const originalEnv = process.env;

function installEnv(vars: Record<string, string>): string[] {
  const reads: string[] = [];
  const target: Record<string, string | undefined> = {};
  for (const key of Object.keys(originalEnv)) {
    if (RUNTIME_KEYS.includes(key) || key.startsWith("VITEST")) target[key] = originalEnv[key];
  }
  Object.assign(target, vars);
  const observe = (key: string | symbol) => {
    if (typeof key === "string" && CONFIG_NAMES.includes(key)) reads.push(key);
  };
  process.env = new Proxy(target, {
    get(t, key, receiver) {
      observe(key);
      return Reflect.get(t, key, receiver);
    },
    has(t, key) {
      observe(key);
      return Reflect.has(t, key);
    },
    getOwnPropertyDescriptor(t, key) {
      observe(key);
      return Reflect.getOwnPropertyDescriptor(t, key);
    },
  }) as NodeJS.ProcessEnv;
  return reads;
}

async function fetchCapabilities(env: Record<string, string>) {
  vi.resetModules();
  installEnv(env);
  const { GET } = await import("../../api/capabilities");
  const response = await GET();
  const text = await response.text();
  return { response, text };
}

function expectSafeResponse(response: Response, text: string) {
  expect(response.status).toBe(200);
  const directives = (response.headers.get("cache-control") ?? "")
    .split(",")
    .map((directive) => directive.trim().toLowerCase());
  expect(directives).toContain("no-store");
  for (const value of [...Object.values(VALID_ENV), FAKE_OPENAI_KEY]) {
    expect(text).not.toContain(value);
  }
}

describe("GET /api/capabilities", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network disabled in tests"));
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("reads no configuration at import and reports everything off when config is missing or invalid", async () => {
    const reads = installEnv(VALID_ENV);
    const capabilities = await import("../../api/capabilities");
    expect(typeof capabilities.GET).toBe("function");
    expect(reads).toEqual([]);

    const invalidEnv = { ...VALID_ENV, DATABASE_URL: "   ", SPOTIFY_ALLOWED_USER_IDS: " , " };
    for (const env of [{}, invalidEnv]) {
      const { response, text } = await fetchCapabilities(env);
      expectSafeResponse(response, text);
      expect(JSON.parse(text)).toStrictEqual({ spotify: false, lyrics: false, ai: false });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps AI off when only an API key is configured", async () => {
    const { response, text } = await fetchCapabilities({
      ...VALID_ENV,
      OPENAI_MODEL: "fake-model",
      OPENAI_API_KEY: FAKE_OPENAI_KEY,
    });

    expectSafeResponse(response, text);
    expect(JSON.parse(text)).toStrictEqual({ spotify: true, lyrics: true, ai: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports AI on only when explicitly enabled with a key, exposing no other fields", async () => {
    const { response, text } = await fetchCapabilities({
      ...VALID_ENV,
      AI_ENRICHMENT_ENABLED: "true",
      OPENAI_MODEL: "fake-model",
      OPENAI_API_KEY: FAKE_OPENAI_KEY,
    });

    expectSafeResponse(response, text);
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["ai", "lyrics", "spotify"]);
    expect(body).toStrictEqual({ spotify: true, lyrics: true, ai: true });
    expect(text).not.toContain("fake-model");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
