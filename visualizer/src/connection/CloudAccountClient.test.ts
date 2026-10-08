// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudAccountClient } from "./CloudAccountClient";

// Synthetic fetch, fake timers and in-memory streams only: no server, account, profile or real navigation.
interface Call { url: string; init: RequestInit; resolve: (r: Response) => void; reject: (e: unknown) => void }
interface Seen { state: "pending" | "fulfilled" | "rejected"; value?: unknown; error?: unknown }

const AUTH = "https://accounts.spotify.com/authorize?response_type=code&client_id=synthClient&state=synthState";
// Pinned better-auth 1.7.7 sign-in returns {url, redirect: !disableRedirect} and sets Location only when redirecting.
// cloud/src/auth-policy.ts always forwards disableRedirect: true, so the real success body is {url, redirect: false};
// the client must navigate the validated URL itself while fetch keeps redirect: "error".
const OK = { url: AUTH, redirect: false } as const;
const SECRET = "SynthSecretToken";
const ops = ["connect", "signOut", "disconnect", "signedIn"] as const;
const enc = new TextEncoder();
let calls: Call[] = [];
let autoAbort = true;
let navigate = vi.fn();
let client: CloudAccountClient;
let storage: { mock: { calls: unknown[] } }[] = [];

const json = (body: unknown, status = 200): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const stream = (source: UnderlyingDefaultSource<Uint8Array>): Response =>
  new Response(new ReadableStream<Uint8Array>(source), { status: 200, headers: { "content-type": "application/json" } });
const last = (): Call => calls[calls.length - 1]!;
const flush = (ms = 0): Promise<unknown> => vi.advanceTimersByTimeAsync(ms);

// Observer attached synchronously so rejections are never unhandled.
function observe(promise: Promise<unknown>): Seen {
  const seen: Seen = { state: "pending" };
  promise.then((value) => { seen.state = "fulfilled"; seen.value = value; }, (error) => { seen.state = "rejected"; seen.error = error; });
  return seen;
}

// Settled and never true; strict requires rejection. Errors are fixed text without response, URL or token contents.
function expectFailed(s: Seen, strict = true): void {
  expect(s.state).not.toBe("pending");
  if (strict) expect(s.state).toBe("rejected");
  expect(s.value).not.toBe(true);
  if (s.state !== "rejected") return;
  expect(s.error).toBeInstanceOf(Error);
  expect((s.error as Error).message).not.toMatch(/synth|secret|token|spotify\.com|evil|alert/i);
}

function expectRequest({ url, init }: Call, path: string, method: "GET" | "POST", body?: unknown): void {
  expect(url).toBe(path);
  expect(init.method).toBe(method);
  expect(init.credentials).toBe("same-origin");
  expect(init.cache).toBe("no-store");
  expect(init.redirect).toBe("error");
  expect(typeof init.signal?.addEventListener).toBe("function");
  const headers = new Headers(init.headers);
  expect(headers.has("authorization")).toBe(false);
  if (method === "GET") { expect(init.body ?? null).toBeNull(); return; }
  expect(headers.get("content-type")).toContain("application/json");
  expect(JSON.parse(String(init.body))).toStrictEqual(body);
}

// Call last in a test: restores spies before reading the synthetic palette back.
function expectNoStorage(): void {
  for (const spy of storage) expect(spy.mock.calls).toEqual([]);
  vi.restoreAllMocks();
  expect(localStorage.getItem("synesthesia.palettes")).toBe("synthPalette");
}

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  autoAbort = true;
  localStorage.setItem("synesthesia.palettes", "synthPalette");
  storage = (["getItem", "setItem", "removeItem", "clear", "key"] as const).map((m) => vi.spyOn(Storage.prototype, m as "getItem"));
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    calls.push({ url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init: init ?? {}, resolve, reject });
    init?.signal?.addEventListener("abort", () => { if (autoAbort) reject(new DOMException("Aborted", "AbortError")); });
  })));
  navigate = vi.fn();
  client = new CloudAccountClient(navigate);
});

afterEach(() => {
  client.stop();
  vi.restoreAllMocks();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("CloudAccountClient", () => {
  it("reads only exact capability booleans from the bounded same-origin endpoint", async () => {
    const seen = observe(client.capabilities());
    await flush();
    expectRequest(last(), "/api/capabilities", "GET");
    last().resolve(json({ spotify: true, lyrics: true, ai: false }));
    await flush();
    expect(seen.value).toEqual({ spotify: true, lyrics: true, ai: false });
    const unsafe = observe(client.capabilities());
    await flush();
    last().resolve(json({ spotify: true, lyrics: true, ai: false, apiKey: SECRET }));
    await flush();
    expectFailed(unsafe);
    expectNoStorage();
  });
  it("connect posts the exact social sign-in body and navigates once itself on the non-redirect {url, redirect: false} reply", async () => {
    const s = observe(client.connect());
    await flush();
    expect(calls).toHaveLength(1);
    expectRequest(last(), "/api/auth/sign-in/social", "POST", { provider: "spotify", callbackURL: "/", errorCallbackURL: "/" });
    expect(navigate).not.toHaveBeenCalled();
    last().resolve(json(OK));
    await flush();
    expect(s.state).toBe("fulfilled");
    expect(s.value).toBeUndefined();
    expect(navigate.mock.calls).toEqual([[AUTH]]);
    expectNoStorage();
  });

  it.each([["signOut", "/api/auth/sign-out"], ["disconnect", "/api/disconnect"]] as const)(
    "%s posts {} to %s, never navigates and leaves local palettes/storage untouched", async (op, path) => {
      const s = observe(client[op]());
      await flush();
      expect(calls).toHaveLength(1);
      expectRequest(last(), path, "POST", {});
      last().resolve(json({ success: true }));
      await flush();
      expect(s.state).toBe("fulfilled");
      expect(navigate).not.toHaveBeenCalled();
      expectNoStorage();
    });

  it("signedIn GETs the session endpoint and returns only the exact boolean", async () => {
    for (const signedIn of [true, false]) {
      const s = observe(client.signedIn());
      await flush();
      expectRequest(last(), "/api/auth/get-session", "GET");
      last().resolve(json({ signedIn }));
      await flush();
      expect(s.state).toBe("fulfilled");
      expect(s.value).toBe(signedIn);
    }
    expectNoStorage();
  });

  it.each([
    { signedIn: true, token: SECRET }, { signedIn: true, session: { token: SECRET } }, { signedIn: true, user: { id: SECRET } },
    { signedIn: "true" }, { session: {} }, [true], null, "{\"signedIn\":true",
  ])("signedIn fails closed on %j", async (body) => {
    const s = observe(client.signedIn());
    await flush();
    last().resolve(json(body));
    await flush();
    expectFailed(s, false);
  });

  // Every URL case carries the real redirect: false, so rejection proves URL validation, not flag validation.
  it("connect rejects foreign, malformed, oversized or wrong-shape responses with one fixed error and no navigation", async () => {
    const f = false;
    const bad: unknown[] = [
      { url: AUTH.replace("https:", "http:"), redirect: f }, { url: "https://evil.example/authorize?synth", redirect: f },
      { url: "https://accounts.spotify.com.evil.example/authorize", redirect: f },
      { url: "https://synth:secret@accounts.spotify.com/authorize", redirect: f },
      { url: "https://accounts.spotify.com:8443/authorize", redirect: f }, { url: `${AUTH}#synth`, redirect: f },
      { url: "https://accounts.spotify.com/authorize/../logout", redirect: f }, { url: "//evil.example/authorize", redirect: f },
      { url: "/authorize", redirect: f }, { url: "javascript:alert('synth')", redirect: f }, { url: "not a url synth", redirect: f },
      { url: `${AUTH}&pad=${"a".repeat(4096)}`, redirect: f }, { redirect: f }, { url: 42, redirect: f },
      // Flag cases: true is never what the pinned wrapper returns; missing or string flags stay rejected.
      { url: AUTH, redirect: true }, { url: AUTH }, { url: AUTH, redirect: "false" }, { url: AUTH, redirect: "true" },
      // Exact keys: a valid pair plus a token must still reject so no token is ever accepted publicly.
      { ...OK, token: SECRET },
    ];
    const messages = new Set<string>();
    for (const body of bad) {
      const s = observe(client.connect());
      await flush();
      last().resolve(json(body));
      await flush();
      expectFailed(s);
      messages.add((s.error as Error).message);
    }
    expect(navigate).not.toHaveBeenCalled();
    expect(messages.size).toBe(1);
  });

  // Non-2xx bodies are never trusted, whatever booleans they carry.
  it.each(ops)("%s maps HTTP errors (any payload flags) and redirect/transport faults to a redacted error", async (op) => {
    const failures = [json({ error: SECRET, token: SECRET }, 403), json(SECRET, 500), json({ url: AUTH, redirect: true, signedIn: true }, 401),
      json({ ...OK, signedIn: false }, 401), json(OK, 500), json({ signedIn: true }, 503), json({ signedIn: false }, 502)];
    for (const response of failures) {
      const s = observe(client[op]());
      await flush();
      last().resolve(response);
      await flush();
      expectFailed(s, op !== "signedIn");
    }
    const s = observe(client[op]());
    await flush();
    last().reject(new TypeError(`redirect to https://evil.example/${SECRET}`));
    await flush();
    expectFailed(s, op !== "signedIn");
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each(["connect", "signedIn"] as const)("%s cancels a >8192-byte unterminated body immediately, before the deadline", async (op) => {
    const cancel = vi.fn();
    const s = observe(client[op]());
    await flush();
    last().resolve(stream({ start(c) { c.enqueue(enc.encode(" ".repeat(4096))); c.enqueue(enc.encode(" ".repeat(4097))); }, cancel }));
    await flush(0);
    expect(cancel).toHaveBeenCalled();
    expectFailed(s, op === "connect");
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each(ops)("%s settles by the 5s deadline when fetch ignores abort", async (op) => {
    autoAbort = false;
    const s = observe(client[op]());
    await flush();
    const call = last();
    await flush(4_900);
    expect(s.state).toBe("pending");
    await flush(200);
    expect(call.init.signal?.aborted).toBe(true);
    expectFailed(s, op !== "signedIn");
    call.resolve(json(OK));
    await flush();
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each(["connect", "signedIn"] as const)("%s settles by the deadline when the body never ends", async (op) => {
    const s = observe(client[op]());
    await flush();
    last().resolve(stream({ start(c) { c.enqueue(enc.encode("{")); } }));
    await flush(5_100);
    expectFailed(s, op === "connect");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("stop aborts every outstanding request, late results never navigate, and a new generation works", async () => {
    autoAbort = false;
    const pending = ops.map((op) => observe(client[op]()));
    await flush();
    const old = [...calls];
    expect(old).toHaveLength(4);
    client.stop();
    for (const call of old) expect(call.init.signal?.aborted).toBe(true);
    await flush();
    pending.forEach((s, i) => expectFailed(s, i < 3));
    old[0]!.resolve(json(OK));
    old[3]!.resolve(json({ signedIn: true }));
    await flush(10_000);
    expect(navigate).not.toHaveBeenCalled();
    expect(pending[3]!.value).not.toBe(true);
    const fresh = observe(client.connect());
    await flush();
    expect(last().init.signal?.aborted).toBe(false);
    last().resolve(json(OK));
    await flush();
    expect(fresh.state).toBe("fulfilled");
    expect(navigate.mock.calls).toEqual([[AUTH]]);
  });

  it("stop during the connect body read prevents navigation even if the body later completes", async () => {
    let push!: ReadableStreamDefaultController<Uint8Array>;
    const s = observe(client.connect());
    await flush();
    last().resolve(stream({ start(c) { push = c; } }));
    await flush();
    client.stop();
    try { push.enqueue(enc.encode(JSON.stringify(OK))); push.close(); } catch { /* cancelled */ }
    await flush(10_000);
    expectFailed(s);
    expect(navigate).not.toHaveBeenCalled();
  });
});
