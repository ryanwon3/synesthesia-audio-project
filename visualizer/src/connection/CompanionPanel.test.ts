// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanionClient } from "./CompanionClient";
import { CompanionPanel } from "./CompanionPanel";

// Explicit non-usable fixtures shaped like v1 secrets (22-char code, 43-char token).
const FAKE_CODE = "fake_code_A".padEnd(22, "0");
const OTHER_CODE = "fake_code_B".padEnd(22, "0");
const FAKE_TOKEN = "fake_token_A".padEnd(43, "0");
const PAIR_URL = "ws://127.0.0.1:8765/pair";
const AT_30 = "2026-10-08T00:30:00+00:00";
const MINUTE = 60_000;
const INVALID_CODE_TEXT = "Enter the 22-character code from the Windows app.";
const FAILURE_TEXT =
  "Couldn't connect. Open the Windows app and copy a new code; use the built-in offline visualizer if access is denied.";
const DISCONNECTED_TEXT = "Disconnected. Open the Windows app and copy a new code to reconnect.";
const pairedReply = { protocolVersion: 1, type: "paired", token: FAKE_TOKEN, expiresAtUtc: AT_30 };

// Mirrors the companion dialog markup in index.html, without icons.
const DIALOG_HTML = `
  <dialog id="companion-dialog" class="spotify-dialog">
    <form method="dialog">
      <header>
        <button class="icon-button" type="button" data-close-dialog aria-label="Close companion setup">x</button>
      </header>
      <p class="companion-state" data-companion-status aria-live="polite">Not connected</p>
      <label for="companion-code">Pairing code</label>
      <input id="companion-code" data-companion-code type="text" maxlength="22" autocomplete="off" required />
      <p class="form-status" data-companion-message aria-live="polite"></p>
      <footer>
        <button class="command-button" type="button" data-companion-disconnect>Disconnect</button>
        <button class="command-button" type="submit" data-companion-submit>Connect</button>
      </footer>
    </form>
  </dialog>`;

class FakeWebSocket extends EventTarget {
  public static readonly instances: FakeWebSocket[] = [];
  public readonly sent: string[] = [];
  private closed = false;

  public constructor(public readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }

  public send(data: string): void {
    this.sent.push(data);
  }

  public open(): void {
    this.dispatchEvent(new Event("open"));
  }

  public receive(message: object): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }

  public close(code = 1000): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.dispatchEvent(Object.assign(new Event("close"), { code, wasClean: code === 1000 }));
  }

  public fail(): void {
    this.dispatchEvent(new Event("error"));
  }
}

// Pure DOM stand-in for the modal API; it makes no claim about real browser dialog behavior.
function shimDialog(dialog: HTMLDialogElement): void {
  Object.defineProperty(dialog, "open", { configurable: true, get: () => dialog.hasAttribute("open") });
  dialog.showModal = () => dialog.setAttribute("open", "");
  dialog.close = () => {
    if (dialog.hasAttribute("open")) {
      dialog.removeAttribute("open");
      dialog.dispatchEvent(new Event("close"));
    }
  };
}

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) {
    throw new Error(`Missing fixture element ${selector}.`);
  }
  return element;
}

let mounted: CompanionClient | null = null;

function mountPanel() {
  document.body.innerHTML = DIALOG_HTML;
  const dialog = query<HTMLDialogElement>("#companion-dialog");
  shimDialog(dialog);
  const client = new CompanionClient();
  mounted = client;
  const pair = vi.spyOn(client, "pair");
  const panel = new CompanionPanel(dialog, client);
  client.onStatus((status) => panel.setStatus(status));
  return {
    dialog,
    client,
    panel,
    pair,
    form: query<HTMLFormElement>("#companion-dialog form"),
    input: query<HTMLInputElement>("[data-companion-code]"),
    status: query<HTMLElement>("[data-companion-status]"),
    message: query<HTMLElement>("[data-companion-message]"),
    submitButton: query<HTMLButtonElement>("[data-companion-submit]"),
    disconnectButton: query<HTMLButtonElement>("[data-companion-disconnect]"),
  };
}

type Mounted = ReturnType<typeof mountPanel>;

// Dispatches submit directly, as script or Enter would, so a disabled button alone cannot hide a missing guard.
function submitCode(ui: Mounted, code: string): void {
  ui.input.value = code;
  ui.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

function latestSocket(): FakeWebSocket {
  expect(FakeWebSocket.instances.length, "expected the client to open a socket").toBeGreaterThan(0);
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

function sentMessages(socket: FakeWebSocket): unknown[] {
  return socket.sent.map((data) => JSON.parse(data) as unknown);
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function pairPanel(ui: Mounted): Promise<void> {
  ui.panel.open();
  submitCode(ui, FAKE_CODE);
  const socket = latestSocket();
  socket.open();
  socket.receive(pairedReply);
  await flush();
  expect(ui.client.credential()).toBe(FAKE_TOKEN);
  expect(ui.dialog.open).toBe(false);
}

beforeEach(() => {
  FakeWebSocket.instances.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-08T00:00:00Z"));
  vi.stubGlobal("WebSocket", FakeWebSocket);
  localStorage.clear();
  sessionStorage.clear();
  vi.spyOn(Storage.prototype, "setItem");
});

afterEach(() => {
  mounted?.invalidate();
  mounted = null;
  const pendingTimers = vi.getTimerCount();
  const storedEntries = localStorage.length + sessionStorage.length;
  const setItemCalls = vi.mocked(Storage.prototype.setItem).mock.calls.length;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  FakeWebSocket.instances.length = 0;
  localStorage.clear();
  sessionStorage.clear();
  expect(pendingTimers, "invalidate must leave no companion timers").toBe(0);
  expect(storedEntries, "nothing may be persisted").toBe(0);
  expect(setItemCalls, "storage must never be written").toBe(0);
});

describe("CompanionPanel", () => {
  it("submits a valid code with a fixed pair message, keeps failures generic, and closes only on a valid reply", async () => {
    const ui = mountPanel();
    ui.panel.open();
    expect(ui.dialog.open).toBe(true);

    submitCode(ui, FAKE_CODE);
    expect(ui.input.value, "the code must leave the input on submit").toBe("");
    expect(ui.pair).toHaveBeenCalledTimes(1);
    expect(ui.pair).toHaveBeenLastCalledWith(FAKE_CODE);
    const rejected = latestSocket();
    rejected.open();
    expect(sentMessages(rejected)).toEqual([{ protocolVersion: 1, type: "pair", code: FAKE_CODE }]);
    rejected.receive({ protocolVersion: 1, type: "authenticationFailed" });
    await flush();
    expect(ui.dialog.open, "a failed attempt keeps the dialog open").toBe(true);
    expect(ui.message.textContent).toBe(FAILURE_TEXT);
    expect(ui.message.textContent).not.toContain(FAKE_CODE);
    expect(ui.status.textContent).toBe("Not connected");

    submitCode(ui, FAKE_CODE);
    expect(ui.input.value).toBe("");
    expect(ui.pair).toHaveBeenCalledTimes(2);
    const accepted = latestSocket();
    accepted.open();
    expect(sentMessages(accepted)).toEqual([{ protocolVersion: 1, type: "pair", code: FAKE_CODE }]);
    expect(ui.dialog.open, "the dialog waits for the reply").toBe(true);
    accepted.receive(pairedReply);
    await flush();
    expect(ui.dialog.open).toBe(false);
    expect(ui.client.credential()).toBe(FAKE_TOKEN);
    expect(ui.status.textContent).toBe("Connected to the Windows companion");
    expect(FakeWebSocket.instances.map((socket) => socket.url)).toEqual([PAIR_URL, PAIR_URL]);
  });

  it("does not start an overlapping pair while one is pending", async () => {
    const ui = mountPanel();
    ui.panel.open();
    submitCode(ui, FAKE_CODE);
    expect(ui.status.textContent).toBe("Connecting…");
    expect(ui.submitButton.disabled).toBe(true);
    const pending = latestSocket();
    pending.open();

    submitCode(ui, OTHER_CODE);
    expect(ui.pair, "a pending pair must not be replaced by a second submit").toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
    pending.receive(pairedReply);
    await flush();
    expect(ui.client.credential()).toBe(FAKE_TOKEN);
    expect(ui.dialog.open).toBe(false);
    expect(sentMessages(pending)).toEqual([{ protocolVersion: 1, type: "pair", code: FAKE_CODE }]);
  });

  it("requires an explicit disconnect before a paired panel can start a new pair", async () => {
    const ui = mountPanel();
    await pairPanel(ui);
    ui.panel.open();
    expect(ui.status.textContent).toBe("Connected to the Windows companion");
    expect(ui.submitButton.disabled, "a paired panel must not offer a new pair").toBe(true);
    expect(ui.disconnectButton.disabled).toBe(false);

    submitCode(ui, OTHER_CODE);
    expect(ui.pair, "a paired panel must ignore a scripted submit").toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(ui.client.credential()).toBe(FAKE_TOKEN);
    expect(ui.status.textContent).toBe("Connected to the Windows companion");

    ui.disconnectButton.click();
    const revoke = latestSocket();
    revoke.open();
    revoke.receive({ protocolVersion: 1, type: "disconnected" });
    await flush();
    expect(ui.submitButton.disabled).toBe(false);
    submitCode(ui, OTHER_CODE);
    expect(ui.pair).toHaveBeenCalledTimes(2);
    expect(ui.pair).toHaveBeenLastCalledWith(OTHER_CODE);
  });

  it("reports the fixed 22-character instruction for an invalid code without calling pair", async () => {
    const ui = mountPanel();
    ui.panel.open();
    submitCode(ui, FAKE_CODE);
    latestSocket().fail();
    await flush();
    expect(ui.status.textContent).toBe("Windows companion unavailable");
    expect(ui.pair).toHaveBeenCalledTimes(1);

    const invalid = "not-a-code";
    submitCode(ui, invalid);
    await flush();
    expect(ui.message.textContent).toBe(INVALID_CODE_TEXT);
    expect(ui.message.textContent).not.toContain(invalid);
    expect(ui.pair, "an invalid code must not reach the client").toHaveBeenCalledTimes(1);
    expect(ui.status.textContent, "an invalid code must not reset the existing state").toBe(
      "Windows companion unavailable",
    );
    expect(ui.dialog.dataset.state).toBe("unavailable");
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("disconnect clears the credential, revokes once, and disables itself", async () => {
    const ui = mountPanel();
    await pairPanel(ui);
    ui.panel.open();
    expect(ui.disconnectButton.disabled).toBe(false);

    ui.disconnectButton.click();
    expect(ui.client.credential()).toBeNull();
    expect(ui.disconnectButton.disabled).toBe(true);
    expect(ui.status.textContent).toBe("Not connected");
    expect(ui.dialog.dataset.state).toBe("unpaired");
    expect(ui.message.textContent).toBe(DISCONNECTED_TEXT);
    const revoke = latestSocket();
    expect(revoke.url).toBe(PAIR_URL);
    revoke.open();
    expect(sentMessages(revoke)).toEqual([{ protocolVersion: 1, type: "disconnect", token: FAKE_TOKEN }]);
    revoke.receive({ protocolVersion: 1, type: "disconnected" });
    await flush();
    expect(ui.client.credential()).toBeNull();
    expect(ui.pair).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(FakeWebSocket.instances, "no renewal after disconnect").toHaveLength(2);
  });
});
