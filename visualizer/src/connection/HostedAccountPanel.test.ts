// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { HostedAccountPanel } from "./HostedAccountPanel";
import { CloudAccountClient } from "./CloudAccountClient";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); document.body.innerHTML = ""; });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const controls = () => { const root = document.createElement("nav"); document.body.append(root); return root; };
const flush = () => vi.advanceTimersByTimeAsync(1);

it("keeps configuration absence usable offline without polling or asking for keys", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async () => json({ spotify: false, lyrics: false, ai: false }));
  vi.stubGlobal("fetch", fetch);
  const root = controls();
  const panel = new HostedAccountPanel(root, { onSnapshot: vi.fn(), onStatus: vi.fn() });
  panel.start(); await flush();
  expect(fetch.mock.calls).toHaveLength(1);
  expect(root.querySelector<HTMLButtonElement>("[data-cloud-connect]")?.disabled).toBe(true);
  expect(root.textContent).not.toMatch(/client id|api key/i);
  expect(root.textContent).toMatch(/not configured/i);
  panel.dispose();
});

it("connects through the validated account client, then clears metadata before a failed disconnect without touching palettes", async () => {
  vi.useFakeTimers();
  const seen = vi.fn(); const status = vi.fn(); const navigate = vi.fn();
  const fetch = vi.fn(async (path: string) => {
    if (path === "/api/capabilities") return json({ spotify: true, lyrics: true, ai: false });
    if (path === "/api/auth/get-session") return json({ signedIn: true });
    if (path === "/api/song-context") return json({ protocolVersion: 1, status: "none", observedAtUtc: new Date().toISOString(),
      nextRetryUtc: null, track: null, trackTags: [], artistTags: [], analysis: null, capabilities: { lyrics: true, ai: false } });
    return json({ error: "synthetic-provider-secret" }, 503);
  });
  vi.stubGlobal("fetch", fetch);
  const storage = vi.spyOn(Storage.prototype, "setItem");
  const root = controls(); const panel = new HostedAccountPanel(root, { onSnapshot: seen, onStatus: status }, new CloudAccountClient(navigate));
  panel.start(); await flush();
  expect(fetch.mock.calls.some(([path]) => path === "/api/song-context")).toBe(true);
  expect(root.querySelector<HTMLButtonElement>("[data-cloud-disconnect]")?.hidden).toBe(false);
  const count = seen.mock.calls.length;
  root.querySelector<HTMLButtonElement>("[data-cloud-disconnect]")!.click();
  expect(seen.mock.calls.length).toBeGreaterThan(count);
  expect(seen.mock.lastCall![0].currentTrack).toBeNull();
  await flush();
  expect(root.textContent).not.toContain("synthetic-provider-secret");
  expect(root.textContent).toMatch(/could not/i);
  expect(storage).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
  panel.dispose(); storage.mockRestore();
});

it("disposal drops delayed initialization and never starts a context poll", async () => {
  vi.useFakeTimers();
  let complete!: (response: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>(resolve => { complete = resolve; }));
  vi.stubGlobal("fetch", fetch);
  const root = controls(); const panel = new HostedAccountPanel(root, { onSnapshot: vi.fn(), onStatus: vi.fn() });
  panel.start(); panel.dispose(); complete(json({ spotify: true, lyrics: true, ai: false })); await flush();
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("restores account controls when a previously signed-out poll becomes authenticated in another tab", async () => {
  vi.useFakeTimers(); let polls = 0;
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    if (path === "/api/capabilities") return json({ spotify: true, lyrics: true, ai: false });
    if (path === "/api/auth/get-session") return json({ signedIn: true });
    if (++polls === 1) return json({ error: "signedOut" }, 401);
    return json({ protocolVersion: 1, status: "none", observedAtUtc: new Date().toISOString(), nextRetryUtc: null,
      track: null, trackTags: [], artistTags: [], analysis: null, capabilities: { lyrics: true, ai: false } });
  }));
  const root = controls(); const panel = new HostedAccountPanel(root, { onSnapshot: vi.fn(), onStatus: vi.fn() });
  panel.start(); await flush();
  expect(root.querySelector<HTMLButtonElement>("[data-cloud-disconnect]")!.hidden).toBe(true);
  await vi.advanceTimersByTimeAsync(5001);
  expect(root.querySelector<HTMLButtonElement>("[data-cloud-disconnect]")!.hidden).toBe(false);
  expect(root.querySelector<HTMLButtonElement>("[data-cloud-connect]")!.hidden).toBe(true);
  panel.dispose();
});
