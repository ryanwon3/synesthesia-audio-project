// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanionClient, type CompanionStatus } from "./CompanionClient";
import { attachCompanionBootstrap, type CompanionWebViewBridge } from "./CompanionBootstrap";

// Explicit non-usable fixtures shaped like v1 credentials (22-char code, 43-char token).
const FAKE_CODE = "fake_code".padEnd(22, "0");
const FAKE_TOKEN_A = "fake_token_A".padEnd(43, "0");
const FAKE_TOKEN_B = "fake_token_B".padEnd(43, "0");
const PORT = 8765;
const TRUSTED_ROOT = `http://127.0.0.1:${PORT}/`;
const AT_30 = "2026-10-08T00:30:00+00:00";
const AT_55 = "2026-10-08T00:55:00+00:00";
const MINUTE = 60_000;
const ready = { protocolVersion: 1, type: "companionBootstrapReady" };
const asB = { token: FAKE_TOKEN_B };

type BridgeListener = (event: { data: unknown }) => void;

class FakeBridge implements CompanionWebViewBridge {
  public readonly calls: string[] = [];
  public readonly added: BridgeListener[] = [];
  public readonly removed: BridgeListener[] = [];
  public readonly posted: unknown[] = [];
  public failOn: "add" | "post" | null = null;
  public onPost: ((bridge: FakeBridge) => void) | null = null;
  private readonly listeners = new Set<BridgeListener>();

  public get listenerCount(): number {
    return this.listeners.size;
  }

  public addEventListener(type: "message", listener: BridgeListener): void {
    this.calls.push(`add:${type}`);
    if (this.failOn === "add") {
      throw new Error(`native add failed ${FAKE_TOKEN_B}`);
    }
    this.added.push(listener);
    this.listeners.add(listener);
  }

  public removeEventListener(type: "message", listener: BridgeListener): void {
    this.calls.push(`remove:${type}`);
    this.removed.push(listener);
    this.listeners.delete(listener);
  }

  public postMessage(message: unknown): void {
    this.calls.push("post");
    if (this.failOn === "post") {
      throw new Error(`native post failed ${FAKE_TOKEN_B}`);
    }
    this.posted.push(message);
    this.onPost?.(this);
  }

  public emit(data: unknown): void {
    for (const listener of [...this.listeners]) {
      listener({ data });
    }
  }
}

// Records renewal URLs only; never opens a real socket.
class FakeWebSocket extends EventTarget {
  public static readonly urls: string[] = [];

  public constructor(url: string) {
    super();
    FakeWebSocket.urls.push(url);
  }

  public send(): void {}

  public close(): void {}
}

const clients: CompanionClient[] = [];

function newClient(port = PORT): CompanionClient {
  const client = new CompanionClient(port);
  clients.push(client);
  return client;
}

function watch(client: CompanionClient): CompanionStatus[] {
  const statuses: CompanionStatus[] = [];
  client.onStatus((status) => statuses.push(status));
  return statuses;
}

function bootstrap(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 1, type: "companionBootstrap", token: FAKE_TOKEN_A, expiresAtUtc: AT_30, port: PORT,
    ...overrides,
  };
}

function without(key: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const copy = bootstrap(overrides);
  delete copy[key];
  return copy;
}

function quietConsole(): () => number {
  const spies = [
    vi.spyOn(console, "debug").mockImplementation(() => {}),
    vi.spyOn(console, "error").mockImplementation(() => {}),
    vi.spyOn(console, "info").mockImplementation(() => {}),
    vi.spyOn(console, "log").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
  ];
  return () => spies.reduce((total, spy) => total + spy.mock.calls.length, 0);
}

beforeEach(() => {
  FakeWebSocket.urls.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-08T00:00:00Z"));
  vi.stubGlobal("WebSocket", FakeWebSocket);
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  for (const client of clients.splice(0)) {
    client.invalidate();
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("attachCompanionBootstrap", () => {
  it("TrustedRootBootstrap registers the bridge listener before requesting the handshake", () => {
    const client = newClient();
    const statuses = watch(client);
    const bridge = new FakeBridge();
    bridge.emit(bootstrap());
    expect(client.credential(), "no bootstrap before the bridge listener is registered").toBeNull();

    attachCompanionBootstrap(client, bridge, TRUSTED_ROOT, PORT);
    expect(bridge.calls, "listener first, then exactly one ready request").toEqual(["add:message", "post"]);
    expect(bridge.posted).toEqual([ready]);
    expect(bridge.listenerCount).toBe(1);
    expect(client.credential(), "ready alone must not create a credential").toBeNull();

    bridge.emit(bootstrap());
    expect(client.credential()).toBe(FAKE_TOKEN_A);
    expect(statuses.at(-1)).toBe("paired");
    expect(bridge.posted, "credential fields are never echoed back").toEqual([ready]);
  });

  it("ReadyOrdering accepts a native reply delivered synchronously during postMessage", () => {
    const client = newClient();
    const bridge = new FakeBridge();
    bridge.onPost = (host) => host.emit(bootstrap());
    attachCompanionBootstrap(client, bridge, TRUSTED_ROOT, PORT);
    expect(client.credential(), "a reply during the ready request must not be lost").toBe(FAKE_TOKEN_A);
  });

  it("TrustedIndexCustomPort adopts, renews through loopback, and stays memory-only", async () => {
    const port = 9123;
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const client = newClient(port);
    const bridge = new FakeBridge();
    attachCompanionBootstrap(client, bridge, `http://127.0.0.1:${port}/index.html`, port);
    expect(bridge.calls).toEqual(["add:message", "post"]);

    bridge.emit(bootstrap());
    expect(client.credential(), "payload port must equal the expected custom port").toBeNull();
    bridge.emit(bootstrap({ port }));
    expect(client.credential()).toBe(FAKE_TOKEN_A);

    await vi.advanceTimersByTimeAsync(25 * MINUTE);
    expect(FakeWebSocket.urls, "renewal stays on the loopback companion port").toEqual([`ws://127.0.0.1:${port}/pair`]);
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it("RejectsUntrustedSources even when a bridge object is present", () => {
    const sources = [
      "http://127.0.0.1:8765",
      "http://127.0.0.1:8765/?ws=1",
      "http://127.0.0.1:8765/#x",
      "http://127.0.0.1:8765/index.html?x=1",
      "http://127.0.0.1:8765/index.html#",
      "http://user@127.0.0.1:8765/",
      "http://127.0.0.1:8765@evil.example/",
      "http://127.0.0.1.evil.example:8765/",
      "http://localhost:8765/",
      "https://127.0.0.1:8765/",
      "https://localhost:8765/",
      "http://127.0.0.1:8766/",
      "http://127.0.0.1:08765/",
      "http://127.0.0.1:8765/other.html",
      "http://127.0.0.1:8765/index.html/",
      "http://127.0.0.1:8765//",
      "http://127.0.0.1:8765/INDEX.HTML",
      "HTTP://127.0.0.1:8765/",
      " http://127.0.0.1:8765/",
      "http://[::1]:8765/",
      "https://synesthesia.example/",
      "file:///C:/app/index.html",
      "about:blank",
      "",
    ];
    for (const source of sources) {
      const client = newClient();
      const bridge = new FakeBridge();
      bridge.onPost = (host) => host.emit(bootstrap());
      const cleanup = attachCompanionBootstrap(client, bridge, source, PORT);
      bridge.emit(bootstrap());
      expect(bridge.calls, `no listener or ready for ${JSON.stringify(source)}`).toEqual([]);
      expect(client.credential(), JSON.stringify(source)).toBeNull();
      expect(() => cleanup()).not.toThrow();
    }
  });

  it("RejectsInvalidExpectedPorts", () => {
    for (const port of [0, 80, 1023, 65536, 8765.5, Number.NaN, -8765]) {
      const client = newClient();
      const bridge = new FakeBridge();
      let cleanup = () => {};
      expect(() => {
        cleanup = attachCompanionBootstrap(client, bridge, `http://127.0.0.1:${port}/`, port);
      }).not.toThrow();
      bridge.emit(bootstrap({ port }));
      expect(bridge.calls, `no listener or ready for port ${port}`).toEqual([]);
      expect(client.credential()).toBeNull();
      expect(() => cleanup()).not.toThrow();
    }
  });

  it("AbsentBridge never falls back to window globals", () => {
    const addListener = vi.spyOn(window, "addEventListener");
    const spoof = new FakeBridge();
    Reflect.set(window, "chrome", { webview: spoof });
    try {
      const client = newClient();
      let cleanup = () => {};
      expect(() => {
        cleanup = attachCompanionBootstrap(client, undefined, TRUSTED_ROOT, PORT);
      }).not.toThrow();
      spoof.emit(bootstrap());
      expect(spoof.calls, "global webview objects are never consulted").toEqual([]);
      expect(client.credential()).toBeNull();
      expect(addListener.mock.calls.some(([type]) => String(type) === "message")).toBe(false);
      expect(() => cleanup()).not.toThrow();
    } finally {
      Reflect.deleteProperty(window, "chrome");
    }
  });

  it("MalformedBootstrapCannotChangeExistingValidCredential", () => {
    const consoleCalls = quietConsole();
    const client = newClient();
    const statuses = watch(client);
    const bridge = new FakeBridge();
    attachCompanionBootstrap(client, bridge, TRUSTED_ROOT, PORT);
    bridge.emit(bootstrap());
    expect(client.credential(), "valid bootstrap should be adopted").toBe(FAKE_TOKEN_A);

    const malformed: Array<[string, unknown]> = [
      ["null", null],
      ["undefined", undefined],
      ["number", 1],
      ["JSON string", JSON.stringify(bootstrap(asB))],
      ["array", [bootstrap(asB)]],
      ["wrong version", bootstrap({ ...asB, protocolVersion: 2 })],
      ["string version", bootstrap({ ...asB, protocolVersion: "1" })],
      ["missing version", without("protocolVersion", asB)],
      ["ready type", bootstrap({ ...asB, type: "companionBootstrapReady" })],
      ["paired type", bootstrap({ ...asB, type: "paired" })],
      ["wrong port", bootstrap({ ...asB, port: 8766 })],
      ["string port", bootstrap({ ...asB, port: "8765" })],
      ["missing port", without("port", asB)],
      ["pairing-code-shaped token", bootstrap({ token: FAKE_CODE })],
      ["short token", bootstrap({ token: FAKE_TOKEN_B.slice(1) })],
      ["non-base64url token", bootstrap({ token: `${FAKE_TOKEN_B.slice(1)}+` })],
      ["missing token", without("token")],
      ["expired lease", bootstrap({ ...asB, expiresAtUtc: "2026-10-07T23:59:00+00:00" })],
      ["lease ending now", bootstrap({ ...asB, expiresAtUtc: "2026-10-08T00:00:00+00:00" })],
      ["lease beyond 8 hours", bootstrap({ ...asB, expiresAtUtc: "2026-10-08T08:00:01+00:00" })],
      ["unparseable expiry", bootstrap({ ...asB, expiresAtUtc: "not-a-date" })],
      ["missing expiry", without("expiresAtUtc", asB)],
    ];
    for (const [label, data] of malformed) {
      bridge.emit(data);
      expect(client.credential(), label).toBe(FAKE_TOKEN_A);
    }
    expect(statuses, "malformed data must never invalidate the good credential").toEqual(["unpaired", "paired"]);
    bridge.emit(bootstrap({ ...asB, expiresAtUtc: AT_55, port: 8766 }));
    expect(client.credential()).toBe(FAKE_TOKEN_A);
    expect(bridge.posted, "no fields are echoed to the host").toEqual([ready]);
    expect(consoleCalls(), "nothing is logged").toBe(0);
  });

  it("CleanupIgnoresStaleCallback", () => {
    const client = newClient();
    const bridge = new FakeBridge();
    const cleanup = attachCompanionBootstrap(client, bridge, TRUSTED_ROOT, PORT);
    expect(bridge.added).toHaveLength(1);
    const [listener] = bridge.added;
    bridge.emit(bootstrap());
    expect(client.credential()).toBe(FAKE_TOKEN_A);

    cleanup();
    expect(bridge.removed, "cleanup removes the registered bridge listener").toEqual([listener]);
    expect(bridge.listenerCount).toBe(0);
    listener({ data: bootstrap({ ...asB, expiresAtUtc: AT_55 }) });
    expect(client.credential(), "a late native callback must not replace the credential").toBe(FAKE_TOKEN_A);
    listener({ data: null });
    expect(client.credential(), "a late malformed callback must not invalidate").toBe(FAKE_TOKEN_A);
    expect(() => cleanup()).not.toThrow();
    expect(bridge.posted).toEqual([ready]);
  });

  it("NoGenericWindowMessageOrStorageListeners", () => {
    const windowAdd = vi.spyOn(window, "addEventListener");
    const documentAdd = vi.spyOn(document, "addEventListener");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const client = newClient();
    const bridge = new FakeBridge();
    const cleanup = attachCompanionBootstrap(client, bridge, TRUSTED_ROOT, PORT);
    bridge.emit(bootstrap());
    expect(client.credential()).toBe(FAKE_TOKEN_A);
    cleanup();

    const types = [...windowAdd.mock.calls, ...documentAdd.mock.calls].map(([type]) => String(type));
    expect(types.filter((type) => type === "message" || type === "storage")).toEqual([]);
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });

  it("RegistrationFailureFailsClosed without surfacing the native error", () => {
    const consoleCalls = quietConsole();
    const client = newClient();
    const bridge = new FakeBridge();
    bridge.failOn = "add";
    let cleanup = () => {};
    expect(() => {
      cleanup = attachCompanionBootstrap(client, bridge, TRUSTED_ROOT, PORT);
    }).not.toThrow();
    expect(bridge.calls[0], "a trusted source attempts bridge registration").toBe("add:message");
    expect(bridge.calls, "no ready request without a listener").not.toContain("post");
    bridge.emit(bootstrap());
    expect(client.credential()).toBeNull();
    expect(() => cleanup()).not.toThrow();
    expect(consoleCalls(), "native error text is never logged").toBe(0);
  });

  it("ReadyPostFailureFailsClosed and removes the listener", () => {
    const consoleCalls = quietConsole();
    const client = newClient();
    const bridge = new FakeBridge();
    bridge.failOn = "post";
    let cleanup = () => {};
    expect(() => {
      cleanup = attachCompanionBootstrap(client, bridge, TRUSTED_ROOT, PORT);
    }).not.toThrow();
    expect(bridge.added).toHaveLength(1);
    expect(bridge.calls.slice(0, 2)).toEqual(["add:message", "post"]);
    expect(bridge.removed, "a failed ready request removes the listener").toEqual(bridge.added);
    expect(bridge.listenerCount).toBe(0);
    const [listener] = bridge.added;
    listener({ data: bootstrap() });
    expect(client.credential(), "an inactive listener ignores late replies").toBeNull();
    expect(() => cleanup()).not.toThrow();
    expect(consoleCalls(), "native error text is never logged").toBe(0);
  });
});
