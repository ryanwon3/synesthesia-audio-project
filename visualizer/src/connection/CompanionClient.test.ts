// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { silentAudioFrame, type AudioFrameMessage } from "../audio/AudioFrame";
import { AudioFrameClient } from "../audio/AudioFrameClient";
import { initialSongContext, type SongContextMessage } from "../song/SongContext";
import { SongContextClient } from "../song/SongContextClient";
import { CompanionClient, type CompanionStatus } from "./CompanionClient";

// Explicit non-usable fixtures shaped like v1 credentials (22-char code, 43-char token).
const FAKE_CODE = "fake_code".padEnd(22, "0");
const FAKE_TOKEN_A = "fake_token_A".padEnd(43, "0");
const FAKE_TOKEN_B = "fake_token_B".padEnd(43, "0");
const ENDPOINT = "ws://127.0.0.1:8765";
const PAIR_URL = `${ENDPOINT}/pair`;
const AT_30 = "2026-10-08T00:30:00+00:00";
const AT_55 = "2026-10-08T00:55:00+00:00";
const MINUTE = 60_000;
const authenticated = { protocolVersion: 1, type: "authenticated", expiresAtUtc: AT_30 };
const audioMessage: AudioFrameMessage = {
  protocolVersion: 1, type: "audioFrame", payload: { ...silentAudioFrame, sequence: 7, rms: 0.25 },
};
const songMessage: SongContextMessage = {
  protocolVersion: 1, type: "songContext", payload: { ...initialSongContext, sqliteStatus: "ready" },
};

function closeEvent(code: number): Event {
  if (typeof CloseEvent === "function") {
    return new CloseEvent("close", { code, wasClean: code === 1000 });
  }
  return Object.assign(new Event("close"), { code, wasClean: code === 1000 });
}

class FakeWebSocket extends EventTarget {
  public static readonly CONNECTING = 0;
  public static readonly OPEN = 1;
  public static readonly CLOSING = 2;
  public static readonly CLOSED = 3;
  public static readonly instances: FakeWebSocket[] = [];
  public readyState = FakeWebSocket.CONNECTING;
  public readonly sent: string[] = [];

  public constructor(public readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }

  public send(data: string): void {
    if (this.readyState === FakeWebSocket.CONNECTING) {
      throw new Error("FakeWebSocket.send before open");
    }
    if (this.readyState === FakeWebSocket.OPEN) {
      this.sent.push(data);
    }
  }

  public open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  public receive(message: object | string): void {
    const data = typeof message === "string" ? message : JSON.stringify(message);
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  public close(code = 1000): void {
    if (this.readyState === FakeWebSocket.CLOSED) {
      return;
    }
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(closeEvent(code));
  }

  public fail(): void {
    this.dispatchEvent(new Event("error"));
  }
}

function latestSocket(): FakeWebSocket {
  expect(FakeWebSocket.instances.length, "expected the client to open a socket").toBeGreaterThan(0);
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

function sentMessages(socket: FakeWebSocket): unknown[] {
  return socket.sent.map((data) => JSON.parse(data) as unknown);
}

function replyAndClose(socket: FakeWebSocket, message: object): void {
  socket.receive(message);
  socket.close(1000);
}

function settle(promise: Promise<void>): Promise<unknown> {
  return promise.then(() => "resolved", (error: unknown) => error);
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function watch(client: CompanionClient): CompanionStatus[] {
  const statuses: CompanionStatus[] = [];
  client.onStatus((status) => statuses.push(status));
  return statuses;
}

async function completePair(client: CompanionClient, token: string, expiresAtUtc: string): Promise<void> {
  const outcome = settle(client.pair(FAKE_CODE));
  const socket = latestSocket();
  socket.open();
  replyAndClose(socket, { protocolVersion: 1, type: "paired", token, expiresAtUtc });
  await flush();
  expect(await outcome, "pairing should resolve").toBe("resolved");
}

interface ChannelCase {
  name: string;
  path: string;
  payloadMessage: object;
  expectedPayload: unknown;
  create(getCredential: () => string | null, onAuthenticationRequired: () => void): {
    start(): void; stop(): void; states: string[]; payloads: unknown[];
  };
}

const channelCases: ChannelCase[] = [
  {
    name: "audio", path: "/audio", payloadMessage: audioMessage, expectedPayload: audioMessage.payload,
    create: (getCredential, onAuthenticationRequired) => {
      const client = new AudioFrameClient(`${ENDPOINT}/audio`, getCredential, onAuthenticationRequired);
      const states: string[] = [];
      const payloads: unknown[] = [];
      client.onStatus((status) => states.push(status.state));
      client.onFrame((frame) => payloads.push(frame));
      return { start: () => client.start(), stop: () => client.stop(), states, payloads };
    },
  },
  {
    name: "song context", path: "/song-context", payloadMessage: songMessage, expectedPayload: songMessage.payload,
    create: (getCredential, onAuthenticationRequired) => {
      const client = new SongContextClient(`${ENDPOINT}/song-context`, getCredential, onAuthenticationRequired);
      const states: string[] = [];
      const payloads: unknown[] = [];
      client.onStatus((status) => states.push(status));
      client.onSnapshot((snapshot) => payloads.push(snapshot));
      return { start: () => client.start(), stop: () => client.stop(), states, payloads };
    },
  },
];

beforeEach(() => {
  FakeWebSocket.instances.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-08T00:00:00Z"));
  vi.stubGlobal("WebSocket", FakeWebSocket);
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FakeWebSocket.instances.length = 0;
});

it("SecondBootstrapRestartsBothStreamsAndIgnoresOldRevocation", () => {
  const companion = new CompanionClient();
  const statuses = watch(companion);
  const authenticationRequired = vi.fn(() => companion.invalidate());
  const channels = channelCases.map((channel) =>
    channel.create(() => companion.credential(), authenticationRequired));
  const unsubscribe = companion.onStatus((status) => {
    for (const channel of channels) {
      if (status === "paired") {
        channel.start();
      } else {
        channel.stop();
      }
    }
  });

  try {
    companion.acceptBootstrap(FAKE_TOKEN_A, AT_30);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const originalSockets = [...FakeWebSocket.instances];
    for (const socket of originalSockets) {
      socket.open();
      expect(sentMessages(socket)).toEqual([
        { protocolVersion: 1, type: "authenticate", token: FAKE_TOKEN_A },
      ]);
      socket.receive(authenticated);
    }

    companion.acceptBootstrap(FAKE_TOKEN_B, AT_55);
    expect(statuses).toEqual(["unpaired", "paired", "unpaired", "paired"]);
    expect(FakeWebSocket.instances).toHaveLength(4);
    const replacementSockets = FakeWebSocket.instances.slice(2);
    for (const socket of replacementSockets) {
      socket.open();
      expect(sentMessages(socket)).toEqual([
        { protocolVersion: 1, type: "authenticate", token: FAKE_TOKEN_B },
      ]);
      socket.receive({ ...authenticated, expiresAtUtc: AT_55 });
    }

    for (const [index, socket] of originalSockets.entries()) {
      expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
      socket.dispatchEvent(closeEvent(4401));
      socket.receive(channelCases[index].payloadMessage);
    }
    expect(authenticationRequired).not.toHaveBeenCalled();
    expect(companion.credential()).toBe(FAKE_TOKEN_B);
    for (const [index, socket] of replacementSockets.entries()) {
      expect(channels[index].payloads).toHaveLength(0);
      socket.receive(channelCases[index].payloadMessage);
      expect(channels[index].payloads).toEqual([channelCases[index].expectedPayload]);
    }
    expect(FakeWebSocket.instances).toHaveLength(4);
  } finally {
    unsubscribe();
    for (const channel of channels) {
      channel.stop();
    }
    companion.invalidate();
  }
  expect(vi.getTimerCount()).toBe(0);
});

it("fixture drives window timers with the fake clock", async () => {
  const callback = vi.fn();
  window.setTimeout(callback, 1000);
  await vi.advanceTimersByTimeAsync(1000);
  expect(callback).toHaveBeenCalledOnce();
});

describe.each(channelCases)("$name channel", (channel) => {
  const authenticate = { protocolVersion: 1, type: "authenticate", token: FAKE_TOKEN_A };

  it("AuthenticatesBeforeReportingConnected", () => {
    const subject = channel.create(() => FAKE_TOKEN_A, vi.fn());
    subject.start();
    const socket = latestSocket();
    expect(socket.url).toBe(`${ENDPOINT}${channel.path}`);
    socket.open();
    expect(sentMessages(socket)).toEqual([authenticate]);
    expect(subject.states).not.toContain("connected");
    expect(subject.states.at(-1)).toBe("connecting");
    socket.receive(channel.payloadMessage);
    expect(subject.payloads, "payload before acknowledgement must be ignored").toHaveLength(0);
    socket.receive(authenticated);
    expect(subject.states.at(-1)).toBe("connected");
    socket.receive(channel.payloadMessage);
    expect(subject.payloads).toEqual([channel.expectedPayload]);
  });

  it("IgnoresOldSocketMessages", async () => {
    const subject = channel.create(() => FAKE_TOKEN_A, vi.fn());
    subject.start();
    const old = latestSocket();
    old.open();
    old.receive(authenticated);
    subject.stop();
    subject.start();
    expect(FakeWebSocket.instances).toHaveLength(2);
    const fresh = latestSocket();
    fresh.open();
    expect(sentMessages(fresh)).toEqual([authenticate]);
    fresh.receive(authenticated);
    const stateCount = subject.states.length;
    old.receive(authenticated);
    old.receive(channel.payloadMessage);
    old.dispatchEvent(closeEvent(1006));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(subject.payloads, "stale socket payload must be ignored").toHaveLength(0);
    expect(subject.states).toHaveLength(stateCount);
    expect(FakeWebSocket.instances).toHaveLength(2);
    fresh.receive(channel.payloadMessage);
    expect(subject.payloads).toEqual([channel.expectedPayload]);
  });

  it.each(["close4401", "authenticationFailed"] as const)("RequiresPairingAfterRevocation via %s", async (trigger) => {
    const onAuthenticationRequired = vi.fn();
    const subject = channel.create(() => FAKE_TOKEN_A, onAuthenticationRequired);
    subject.start();
    const socket = latestSocket();
    socket.open();
    socket.receive(authenticated);
    if (trigger === "close4401") {
      socket.close(4401);
    } else {
      socket.receive({ protocolVersion: 1, type: "authenticationFailed" });
    }
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(onAuthenticationRequired).toHaveBeenCalledOnce();
    expect(FakeWebSocket.instances, "auth failure must not reconnect with the old credential").toHaveLength(1);
    expect(subject.states.at(-1)).toBe("disconnected");
  });

  it("RequiresPairingAfterRevocation keeps ordinary drops on a re-authenticating retry", async () => {
    const onAuthenticationRequired = vi.fn();
    const subject = channel.create(() => FAKE_TOKEN_A, onAuthenticationRequired);
    subject.start();
    const socket = latestSocket();
    socket.open();
    socket.receive(authenticated);
    socket.close(1006);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onAuthenticationRequired).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances.length).toBeGreaterThan(1);
    const retry = latestSocket();
    retry.open();
    expect(sentMessages(retry)).toEqual([authenticate]);
    expect(subject.states.at(-1)).toBe("connecting");
  });
});

describe("CompanionClient", () => {
  it("RenewsWithoutStoringToken", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const client = new CompanionClient();
    const statuses = watch(client);
    expect(statuses).toEqual(["unpaired"]);
    const outcome = settle(client.pair(FAKE_CODE));
    expect(statuses.at(-1)).toBe("pairing");
    const pairSocket = latestSocket();
    expect(pairSocket.url).toBe(PAIR_URL);
    pairSocket.open();
    expect(sentMessages(pairSocket)).toEqual([{ protocolVersion: 1, type: "pair", code: FAKE_CODE }]);
    replyAndClose(pairSocket, { protocolVersion: 1, type: "paired", token: FAKE_TOKEN_A, expiresAtUtc: AT_30 });
    expect(await outcome).toBe("resolved");
    expect(client.credential()).toBe(FAKE_TOKEN_A);
    expect(statuses.at(-1)).toBe("paired");

    await vi.advanceTimersByTimeAsync(25 * MINUTE);
    expect(FakeWebSocket.instances, "renewal should open at 25 minutes").toHaveLength(2);
    const renewSocket = latestSocket();
    expect(renewSocket.url).toBe(PAIR_URL);
    renewSocket.open();
    expect(sentMessages(renewSocket)).toEqual([{ protocolVersion: 1, type: "renew", token: FAKE_TOKEN_A }]);
    replyAndClose(renewSocket, { protocolVersion: 1, type: "renewed", token: FAKE_TOKEN_B, expiresAtUtc: AT_55 });
    await flush();
    expect(client.credential()).toBe(FAKE_TOKEN_B);
    expect(statuses.at(-1)).toBe("paired");
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length + sessionStorage.length).toBe(0);
    const urls = FakeWebSocket.instances.map((socket) => socket.url);
    expect(urls.some((url) => [FAKE_CODE, FAKE_TOKEN_A, FAKE_TOKEN_B].some((secret) => url.includes(secret))),
      "credentials must never appear in socket URLs").toBe(false);
  });

  it("PairingDeadlineAndFailureAreBounded after 5 seconds without a reply", async () => {
    const client = new CompanionClient();
    const statuses = watch(client);
    const outcome = settle(client.pair(FAKE_CODE));
    latestSocket().open();
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await outcome;
    expect(result).toBeInstanceOf(Error);
    expect(String((result as Error).message).includes(FAKE_CODE), "error must not echo the code").toBe(false);
    expect(statuses.at(-1)).toBe("unavailable");
    expect(client.credential()).toBeNull();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(FakeWebSocket.instances, "no automatic pairing loop").toHaveLength(1);
  });

  it.each([
    ["authenticationFailed", "unpaired"],
    ["close4401", "unpaired"],
    ["unreachable", "unavailable"],
  ] as const)("PairingDeadlineAndFailureAreBounded on %s", async (failure, expected) => {
    const client = new CompanionClient();
    const statuses = watch(client);
    const outcome = settle(client.pair(FAKE_CODE));
    const socket = latestSocket();
    if (failure === "unreachable") {
      socket.fail();
      socket.close(1006);
    } else {
      socket.open();
      if (failure === "authenticationFailed") {
        replyAndClose(socket, { protocolVersion: 1, type: "authenticationFailed" });
      } else {
        socket.close(4401);
      }
    }
    await flush();
    expect(await outcome).toBeInstanceOf(Error);
    expect(statuses.at(-1)).toBe(expected);
    expect(client.credential()).toBeNull();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("DisconnectAndStaleRepliesCannotRestoreCredential", async () => {
    const client = new CompanionClient();
    const statuses = watch(client);
    await completePair(client, FAKE_TOKEN_A, AT_30);
    const pairSocket = FakeWebSocket.instances[0];
    await vi.advanceTimersByTimeAsync(25 * MINUTE);
    expect(FakeWebSocket.instances).toHaveLength(2);
    const renewSocket = latestSocket();
    renewSocket.open();

    client.disconnect();
    expect(client.credential()).toBeNull();
    expect(statuses.at(-1)).toBe("unpaired");
    expect(FakeWebSocket.instances, "disconnect should notify the companion").toHaveLength(3);
    const disconnectSocket = latestSocket();
    expect(disconnectSocket.url).toBe(PAIR_URL);
    disconnectSocket.open();
    expect(sentMessages(disconnectSocket)).toEqual([{ protocolVersion: 1, type: "disconnect", token: FAKE_TOKEN_A }]);
    replyAndClose(disconnectSocket, { protocolVersion: 1, type: "disconnected" });

    renewSocket.receive({ protocolVersion: 1, type: "renewed", token: FAKE_TOKEN_B, expiresAtUtc: AT_55 });
    pairSocket.receive({ protocolVersion: 1, type: "paired", token: FAKE_TOKEN_B, expiresAtUtc: AT_55 });
    await flush();
    expect(client.credential(), "late replies must not restore a credential").toBeNull();
    expect(statuses.at(-1)).toBe("unpaired");
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(FakeWebSocket.instances).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("BootstrapRemainsMemoryOnly", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const addListener = vi.spyOn(window, "addEventListener");
    const client = new CompanionClient();
    const statuses = watch(client);
    client.acceptBootstrap(FAKE_TOKEN_A, AT_30);
    expect(client.credential()).toBe(FAKE_TOKEN_A);
    expect(statuses.at(-1)).toBe("paired");
    expect(FakeWebSocket.instances).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(25 * MINUTE);
    expect(FakeWebSocket.instances, "bootstrap credential should renew").toHaveLength(1);
    const renewSocket = latestSocket();
    expect(renewSocket.url).toBe(PAIR_URL);
    renewSocket.open();
    expect(sentMessages(renewSocket)).toEqual([{ protocolVersion: 1, type: "renew", token: FAKE_TOKEN_A }]);

    client.invalidate();
    expect(client.credential()).toBeNull();
    expect(statuses.at(-1)).toBe("unpaired");
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(setItem).not.toHaveBeenCalled();
    expect(addListener.mock.calls.some(([type]) => type === "message"), "no window message listener").toBe(false);
  });

  it.each([
    ["expired", FAKE_TOKEN_A, "2026-10-07T23:59:00+00:00"],
    ["short token", FAKE_TOKEN_A.slice(1), AT_30],
    ["non-base64url token", `${FAKE_TOKEN_A.slice(1)}+`, AT_30],
    ["unparseable expiry", FAKE_TOKEN_A, "not-a-date"],
  ])("BootstrapRemainsMemoryOnly rejects %s", async (_label, token, expiresAtUtc) => {
    const client = new CompanionClient();
    const statuses = watch(client);
    client.acceptBootstrap(token, expiresAtUtc);
    expect(client.credential()).toBeNull();
    expect(statuses.at(-1)).toBe("unpaired");
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(FakeWebSocket.instances).toHaveLength(0);
    client.acceptBootstrap(FAKE_TOKEN_B, "2026-10-08T01:00:00+00:00");
    expect(client.credential(), "a rejected bootstrap must not block a valid one").toBe(FAKE_TOKEN_B);
  });

  it.each([0, -1, 1023, 65536, 8765.5, Number.NaN])("InvalidPortOrRemoteCredentialUrlNotUsed rejects port %s", (port) => {
    expect(() => new CompanionClient(port)).toThrow(RangeError);
  });

  it("InvalidPortOrRemoteCredentialUrlNotUsed rejects a URL in place of a port", () => {
    expect(() => new CompanionClient("ws://remote.example:8765" as unknown as number)).toThrow(RangeError);
    expect(() => new CompanionClient(1024)).not.toThrow();
    expect(() => new CompanionClient(65535)).not.toThrow();
  });

  it("InvalidPortOrRemoteCredentialUrlNotUsed pairs only through loopback on a custom port", async () => {
    const client = new CompanionClient(9123);
    const outcome = settle(client.pair(FAKE_CODE));
    expect(FakeWebSocket.instances.map((socket) => socket.url)).toEqual(["ws://127.0.0.1:9123/pair"]);
    latestSocket().open();
    replyAndClose(latestSocket(), { protocolVersion: 1, type: "authenticationFailed" });
    await flush();
    expect(await outcome).toBeInstanceOf(Error);
  });
});
