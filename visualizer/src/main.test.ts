// @vitest-environment happy-dom
/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import indexHtml from "../index.html?raw";
import { silentAudioFrame, type AudioFrame } from "./audio/AudioFrame";
import type { AudioFrameClientStatus } from "./audio/AudioFrameClient";
import type { SpatialVisualState } from "./mappings/SpatialVisualState";
import { ProfileStore } from "./profiles/ProfileStore";
import { defaultSpatialPreferences } from "./profiles/SpatialProfile";
import type { SynesthesiaProfile } from "./profiles/SynesthesiaProfile";
import { testProfile } from "./profiles/profile.test-fixtures";
import { initialSongContext, type SongContextSnapshot } from "./song/SongContext";
import type { SongContextConnectionState } from "./song/SongContextClient";
import { previewFrame } from "./verification/PreviewFixtures";
import type { LayerPreview, RenderOptions, VisualRenderer } from "./visuals/VisualRenderer";

interface RecordedRender {
  delta: number;
  json: string;
}

interface RecordedRenderer extends VisualRenderer {
  readonly mode: unknown;
  readonly options: Partial<RenderOptions> | undefined;
  readonly renders: RecordedRender[];
  readonly layerPreviews: LayerPreview[];
  readonly reducedMotion: boolean[];
  clears: number;
  disposed: boolean;
}

// Transport and renderer boundaries only; mapping, profiles, calibration UI and RenderLoop stay real.
const h = vi.hoisted(() => {
  const harness = {
    clock: 1000,
    hidden: false,
    nextHandle: 0,
    frames: new Map<number, FrameRequestCallback>(),
    renderers: [] as RecordedRenderer[],
    audioClients: [] as FakeAudioFrameClient[],
    songClients: [] as FakeSongContextClient[],
  };

  class FakeAudioFrameClient {
    private readonly frameListeners = new Set<(frame: AudioFrame) => void>();
    private readonly statusListeners = new Set<(status: AudioFrameClientStatus) => void>();
    private status: AudioFrameClientStatus = { state: "disconnected", messagesPerSecond: 0, lastReceiveAt: 0 };
    public constructor(..._args: unknown[]) { harness.audioClients.push(this); }
    public get currentStatus(): AudioFrameClientStatus { return { ...this.status }; }
    public onFrame(listener: (frame: AudioFrame) => void): () => void {
      this.frameListeners.add(listener);
      return () => { this.frameListeners.delete(listener); };
    }
    public onStatus(listener: (status: AudioFrameClientStatus) => void): () => void {
      this.statusListeners.add(listener);
      listener(this.currentStatus);
      return () => { this.statusListeners.delete(listener); };
    }
    public start(): void {}
    public stop(): void { this.emitStatus({ state: "disconnected", messagesPerSecond: 0, lastReceiveAt: 0 }); }
    public emitFrame(frame: AudioFrame): void {
      for (const listener of [...this.frameListeners]) listener(structuredClone(frame));
    }
    public emitStatus(status: AudioFrameClientStatus): void {
      this.status = { ...status };
      for (const listener of [...this.statusListeners]) listener(this.currentStatus);
    }
  }

  class FakeSongContextClient {
    private readonly snapshotListeners = new Set<(snapshot: SongContextSnapshot) => void>();
    private readonly statusListeners = new Set<(status: SongContextConnectionState) => void>();
    public constructor(..._args: unknown[]) { harness.songClients.push(this); }
    public onSnapshot(listener: (snapshot: SongContextSnapshot) => void): () => void {
      this.snapshotListeners.add(listener);
      return () => { this.snapshotListeners.delete(listener); };
    }
    public onStatus(listener: (status: SongContextConnectionState) => void): () => void {
      this.statusListeners.add(listener);
      return () => { this.statusListeners.delete(listener); };
    }
    public start(): void {}
    public stop(): void { for (const listener of [...this.statusListeners]) listener("disconnected"); }
    public configureAndConnect(): boolean { return false; }
    public emitSnapshot(snapshot: SongContextSnapshot): void {
      for (const listener of [...this.snapshotListeners]) listener(structuredClone(snapshot));
    }
    public emitStatus(status: SongContextConnectionState): void {
      for (const listener of [...this.statusListeners]) listener(status);
    }
  }

  function createRenderer(_canvas: HTMLCanvasElement, mode: unknown, options?: Partial<RenderOptions>): VisualRenderer {
    const renderer: RecordedRenderer = {
      mode, options, renders: [], layerPreviews: [], reducedMotion: [], clears: 0, disposed: false,
      render: (state, delta) => { renderer.renders.push({ delta, json: JSON.stringify(state) }); },
      resize: () => {},
      clear: () => { renderer.clears += 1; },
      setReducedMotion: (enabled) => { renderer.reducedMotion.push(enabled); },
      setLayerPreview: (layer) => { renderer.layerPreviews.push(layer); },
      dispose: () => { renderer.disposed = true; },
    };
    harness.renderers.push(renderer);
    return renderer;
  }

  return { harness, FakeAudioFrameClient, FakeSongContextClient, createRenderer };
});

vi.mock("./audio/AudioFrameClient", () => ({ AudioFrameClient: h.FakeAudioFrameClient }));
vi.mock("./song/SongContextClient", () => ({ SongContextClient: h.FakeSongContextClient }));
vi.mock("./visuals/RendererFactory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./visuals/RendererFactory")>()),
  createVisualRenderer: h.createRenderer,
}));

type MediaListener = (event: { matches: boolean; media: string }) => void;

class FakeMediaQuery {
  private readonly listeners = new Set<MediaListener>();
  public onchange: MediaListener | null = null;
  public constructor(public readonly media: string, public matches: boolean) {}
  public addEventListener(_type: string, listener: MediaListener): void { this.listeners.add(listener); }
  public removeEventListener(_type: string, listener: MediaListener): void { this.listeners.delete(listener); }
  public addListener(listener: MediaListener): void { this.listeners.add(listener); }
  public removeListener(listener: MediaListener): void { this.listeners.delete(listener); }
  public dispatchEvent(): boolean { return true; }
  public set(matches: boolean): void {
    this.matches = matches;
    const event = { matches, media: this.media };
    for (const listener of [...this.listeners]) listener(event);
    this.onchange?.(event);
  }
}

let motionQuery: FakeMediaQuery;

beforeEach(() => {
  Object.assign(h.harness, { clock: 1000, hidden: false, nextHandle: 0 });
  h.harness.frames.clear();
  h.harness.renderers.length = 0;
  h.harness.audioClients.length = 0;
  h.harness.songClients.length = 0;
  window.localStorage.clear();
  motionQuery = new FakeMediaQuery("(prefers-reduced-motion: reduce)", false);

  const requestFrame = (callback: FrameRequestCallback): number => {
    const handle = ++h.harness.nextHandle;
    h.harness.frames.set(handle, callback);
    return handle;
  };
  const cancelFrame = (handle: number): void => { h.harness.frames.delete(handle); };
  const matchMedia = (query: string) => (query.includes("prefers-reduced-motion")
    ? motionQuery
    : new FakeMediaQuery(query, false)) as unknown as MediaQueryList;
  // External hosted HTTP boundary stays synthetic in composition tests.
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ spotify: false, lyrics: false, ai: false }))));
  for (const target of new Set<object>([window, globalThis])) {
    Object.assign(target, { requestAnimationFrame: requestFrame, cancelAnimationFrame: cancelFrame, matchMedia });
  }
  for (const clock of new Set<Performance>([performance, window.performance])) {
    vi.spyOn(clock, "now").mockImplementation(() => h.harness.clock);
  }
  Object.defineProperty(document, "hidden", { configurable: true, get: () => h.harness.hidden });
  Object.defineProperty(document, "visibilityState", {
    configurable: true, get: () => (h.harness.hidden ? "hidden" : "visible"),
  });
});

afterEach(() => {
  // Module-level listeners from a previous main instance cannot be removed; unload makes them inert.
  window.dispatchEvent(new Event("beforeunload"));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("main composition", () => {
  it("keeps painting at startup and forwards explicit calibration choices to the active renderer", async () => {
    await boot({ ...testProfile(), spatial: { ...defaultSpatialPreferences(), mode: "spatial" as const } });
    expect(runFrames(3)).toBeGreaterThan(0);
    // Pending the acceptance gate, a stored spatial request does not switch the startup renderer.
    expect(h.harness.renderers.map((renderer) => renderer.mode)).toEqual(["painting"]);
    expect(active().renders.length).toBeGreaterThan(0);

    // Only an explicit calibration choice requests the experimental renderer.
    choose(selectByLabel("Renderer mode"), "painting");
    choose(selectByLabel("Renderer mode"), "spatial");
    await settle();
    runFrames(2);
    const spatial = active();
    expect(spatial.mode).toBe("spatial");
    expect(spatial.renders.length).toBeGreaterThan(0);
    expect(h.harness.renderers.slice(0, -1).every((renderer) => renderer.disposed)).toBe(true);

    const previewStart = spatial.layerPreviews.length;
    for (const label of ["Preview waves", "Preview rain", "Preview glass", "Preview all"]) clickButton(label);
    await settle();
    expect(active()).toBe(spatial);
    expect(spatial.layerPreviews.slice(previewStart)).toEqual(["waves", "rain", "glass", "all"]);

    // Session theme reaches rendered state without touching storage or personal pitch colors.
    runFrames(1);
    expect(active().renders.at(-1)!.json).not.toContain("bronze-rain-glass");
    const storageBefore = storageSnapshot();
    const pitchInputsBefore = pitchInputValues();
    choose(selectByLabel("Spatial theme"), "bronze-rain-glass");
    await settle();
    runFrames(1);
    expect(active().renders.at(-1)!.json).toContain("bronze-rain-glass");
    expect(storageSnapshot()).toEqual(storageBefore);
    expect(JSON.stringify(storageSnapshot())).not.toContain("bronze");
    expect(pitchInputValues()).toEqual(pitchInputsBefore);
    expect(lower(new ProfileStore(window.localStorage).load().profile.pitchColors)).toEqual(lower(testProfile().pitchColors));

    // OS preference applies while Motion follows the system; explicit choices override it.
    expect(effectiveReducedMotion(active())).toBe(false);
    motionQuery.set(true);
    await settle();
    expect(effectiveReducedMotion(active())).toBe(true);
    motionQuery.set(false);
    await settle();
    expect(effectiveReducedMotion(active())).toBe(false);

    choose(motionSelect(), "reduce");
    await settle();
    expect(effectiveReducedMotion(active())).toBe(true);
    choose(motionSelect(), "full");
    motionQuery.set(true);
    await settle();
    expect(effectiveReducedMotion(active())).toBe(false);
    choose(motionSelect(), "system");
    await settle();
    expect(effectiveReducedMotion(active())).toBe(true);
  });

  it("pauses hidden rendering, resumes quietly, clears on source loss, and disposes on unload", async () => {
    const { update, resetSpatialHistory, audio } = await boot(testProfile());
    const renderer = active();
    const lastMappedFrame = (): AudioFrame => update.mock.calls.at(-1)![0];

    audio.emitStatus({ state: "connected", messagesPerSecond: 30, lastReceiveAt: h.harness.clock });
    audio.emitFrame(previewFrame("bass", 0.05));
    runFrames(2);
    expect(lastMappedFrame().bassEnergy).toBeGreaterThan(0);

    // Hidden: every pending callback is cancelled and late deliveries are inert.
    const stale = pendingCallbacks();
    expect(stale.length).toBeGreaterThan(0);
    const rendersBeforeHide = renderer.renders.length;
    setHidden(true);
    await settle();
    expect(h.harness.frames.size).toBe(0);
    h.harness.clock += 50;
    for (const callback of stale) callback(h.harness.clock);
    expect(renderer.renders.length).toBe(rendersBeforeHide);
    expect(h.harness.frames.size).toBe(0);
    expect(runFrames(5)).toBe(0);

    // Visible: one fresh callback at zero delta; the cached loud frame stays quiet, with no catch-up burst.
    setHidden(false);
    await settle();
    expect(h.harness.frames.size).toBe(1);
    expect(runFrames(1)).toBe(1);
    expect(renderer.renders.slice(rendersBeforeHide).map((render) => render.delta)).toEqual([0]);
    expect(quiet(lastMappedFrame())).toEqual(quiet(silentAudioFrame));
    expect(runFrames(3)).toBe(3);
    expect(renderer.renders.length).toBe(rendersBeforeHide + 4);
    expect(quiet(lastMappedFrame())).toEqual(quiet(silentAudioFrame));

    audio.emitFrame(previewFrame("bass", 1.55));
    runFrames(1);
    expect(lastMappedFrame().bassEnergy).toBeGreaterThan(0);

    // Source loss clears mapping history and renderer trails but keeps the renderer and palette.
    const clearsBefore = renderer.clears;
    const resetsBefore = resetSpatialHistory.mock.calls.length;
    audio.emitStatus({ state: "disconnected", messagesPerSecond: 0, lastReceiveAt: 0 });
    await settle();
    runFrames(1);
    expect(renderer.clears).toBeGreaterThan(clearsBefore);
    expect(resetSpatialHistory.mock.calls.length).toBeGreaterThan(resetsBefore);
    expect(quiet(lastMappedFrame())).toEqual(quiet(silentAudioFrame));
    expect(h.harness.renderers).toHaveLength(1);
    expect(renderer.disposed).toBe(false);
    expect(lower(new ProfileStore(window.localStorage).load().profile.pitchColors)).toEqual(lower(testProfile().pitchColors));

    // Unload disposes loop and renderer; stale callbacks stay inert.
    const pendingAtUnload = pendingCallbacks();
    const rendersAtUnload = renderer.renders.length;
    window.dispatchEvent(new Event("beforeunload"));
    expect(renderer.disposed).toBe(true);
    expect(h.harness.frames.size).toBe(0);
    for (const callback of pendingAtUnload) callback(h.harness.clock + 16);
    expect(renderer.renders.length).toBe(rendersAtUnload);
    expect(h.harness.frames.size).toBe(0);
  });

  it("clears song-scoped history only when the current track identity changes", async () => {
    const { update, resetSpatialHistory, audio } = await boot(testProfile());
    const renderer = active();
    const song = h.harness.songClients.at(-1);
    expect(song, "song context client constructed").toBeDefined();
    const lastMappedFrame = (): AudioFrame => update.mock.calls.at(-1)![0];

    audio.emitStatus({ state: "connected", messagesPerSecond: 30, lastReceiveAt: h.harness.clock });
    song!.emitSnapshot(songSnapshot("syntheticTrackA", 1000));
    await settle();
    audio.emitFrame(previewFrame("bass", 0.05));
    runFrames(1);
    expect(lastMappedFrame().bassEnergy).toBeGreaterThan(0);
    const pitchBefore = pitchInputValues();
    const clearsBefore = renderer.clears;
    const resetsBefore = resetSpatialHistory.mock.calls.length;

    // A progress refresh of the same track keeps trails and the cached frame.
    song!.emitSnapshot(songSnapshot("syntheticTrackA", 4000));
    await settle();
    runFrames(1);
    expect(renderer.clears).toBe(clearsBefore);
    expect(resetSpatialHistory.mock.calls.length).toBe(resetsBefore);
    expect(lastMappedFrame().bassEnergy).toBeGreaterThan(0);

    // A different track clears mapping and trails but keeps the renderer and palette.
    song!.emitSnapshot(songSnapshot("syntheticTrackB", 0));
    await settle();
    runFrames(1);
    expect(renderer.clears).toBeGreaterThan(clearsBefore);
    expect(resetSpatialHistory.mock.calls.length).toBeGreaterThan(resetsBefore);
    expect(quiet(lastMappedFrame())).toEqual(quiet(silentAudioFrame));
    expect(h.harness.renderers).toHaveLength(1);
    expect(renderer.disposed).toBe(false);
    expect(pitchInputValues()).toEqual(pitchBefore);
    expect(lower(new ProfileStore(window.localStorage).load().profile.pitchColors)).toEqual(lower(testProfile().pitchColors));
  });

  it("applies a valid session bronze tint, clears trails without dropping the live frame, and ignores invalid or personal tints", async () => {
    const { update, resetSpatialHistory, audio } = await boot({ ...testProfile(), spatial: defaultSpatialPreferences() });
    const renderer = active();
    const lastMappedFrame = (): AudioFrame => update.mock.calls.at(-1)![0];
    const tint = [161 / 255, 178 / 255, 195 / 255];
    const storageBefore = storageSnapshot();

    audio.emitStatus({ state: "connected", messagesPerSecond: 30, lastReceiveAt: h.harness.clock });
    audio.emitFrame(previewFrame("bass", 0.05));
    runFrames(1);
    expect(lastMappedFrame().bassEnergy).toBeGreaterThan(0);
    const clearsBefore = renderer.clears;
    const resetsBefore = resetSpatialHistory.mock.calls.length;

    // A valid tint reaches rendered waves and clears history, but the cached live frame keeps mapping.
    dispatchSpatialTheme({ theme: "bronze-rain-glass", waveColor: "#a1b2c3" });
    await settle();
    runFrames(1);
    expect(renderedSpatial().themeId).toBe("bronze-rain-glass");
    expect(renderedSpatial().waves.color).toEqual(tint);
    expect(renderer.clears).toBeGreaterThan(clearsBefore);
    expect(resetSpatialHistory.mock.calls.length).toBeGreaterThan(resetsBefore);
    expect(lastMappedFrame().bassEnergy).toBeGreaterThan(0);

    // An invalid tint changes nothing: same rendered tint, no extra clears.
    const clearsAfterTint = renderer.clears;
    const resetsAfterTint = resetSpatialHistory.mock.calls.length;
    dispatchSpatialTheme({ theme: "bronze-rain-glass", waveColor: "#zzzzzz" });
    await settle();
    runFrames(1);
    expect(renderedSpatial().waves.color).toEqual(tint);
    expect(renderer.clears).toBe(clearsAfterTint);
    expect(resetSpatialHistory.mock.calls.length).toBe(resetsAfterTint);

    // Personal ignores any supplied tint.
    dispatchSpatialTheme({ theme: "personal", waveColor: "#a1b2c3" });
    await settle();
    runFrames(1);
    expect(renderedSpatial().themeId).toBe("personal");
    expect(renderedSpatial().waves.color).not.toEqual(tint);

    // Session tint is never persisted and never becomes a pitch color.
    expect(storageSnapshot()).toEqual(storageBefore);
    expect(JSON.stringify(storageSnapshot()).toLowerCase()).not.toContain("a1b2c3");
    expect(lower(new ProfileStore(window.localStorage).load().profile.pitchColors)).toEqual(lower(testProfile().pitchColors));
  });

  it("marks cached song metadata stale on disconnect and restores a saved song theme only from a fresh snapshot", async () => {
    const bronze = [0xb8 / 255, 0x86 / 255, 0x54 / 255];
    const override = {
      match: { spotifyTrackId: "syntheticTrackA", title: "Synthetic song syntheticTrackA", artist: "Synthetic artist" },
      themeId: "bronze-rain-glass" as const, waveColor: "#b88654",
    };
    const { update, audio } = await boot({
      ...testProfile(), spatial: { ...defaultSpatialPreferences(), songOverrides: [override] },
    });
    const renderer = active();
    const song = h.harness.songClients.at(-1);
    expect(song, "song context client constructed").toBeDefined();
    const lastMappedFrame = (): AudioFrame => update.mock.calls.at(-1)![0];
    const lastMappedSong = (): SongContextSnapshot | undefined => update.mock.calls.at(-1)![3];

    audio.emitStatus({ state: "connected", messagesPerSecond: 30, lastReceiveAt: h.harness.clock });
    song!.emitStatus("connected");
    song!.emitSnapshot({ ...songSnapshot("syntheticTrackA", 1000), stale: false });
    await settle();
    audio.emitFrame(previewFrame("bass", 0.05));
    runFrames(2);
    expect(lastMappedSong()?.stale).toBe(false);
    expect(renderedSpatial().themeId).toBe("bronze-rain-glass");
    expect(renderedSpatial().waves.color).toEqual(bronze);
    expect(lastMappedFrame().bassEnergy).toBeGreaterThan(0);
    const storageBefore = storageSnapshot();
    const pitchBefore = pitchInputValues();
    const clearsBefore = renderer.clears;

    // Metadata loss marks the cached snapshot stale and drops song-scoped trails, but live audio keeps mapping.
    song!.emitStatus("disconnected");
    await settle();
    const rendersBeforeLoss = renderer.renders.length;
    runFrames(1);
    expect(renderer.renders.length).toBeGreaterThan(rendersBeforeLoss);
    expect(lastMappedSong()?.stale).toBe(true);
    expect(renderedSpatial().themeId).toBe("personal");
    expect(renderedSpatial().waves.color).not.toEqual(bronze);
    expect(renderer.clears).toBeGreaterThan(clearsBefore);
    expect(lastMappedFrame().bassEnergy).toBeGreaterThan(0);
    expect(active()).toBe(renderer);
    expect(renderer.disposed).toBe(false);

    // Reconnecting alone does not vouch for the cached snapshot.
    song!.emitStatus("connected");
    await settle();
    runFrames(1);
    expect(lastMappedSong()?.stale).toBe(true);
    expect(renderedSpatial().themeId).toBe("personal");
    expect(lastMappedFrame().bassEnergy).toBeGreaterThan(0);

    // Only a fresh snapshot of the same track restores the saved association.
    song!.emitSnapshot({ ...songSnapshot("syntheticTrackA", 5000), stale: false });
    await settle();
    runFrames(1);
    expect(lastMappedSong()?.stale).toBe(false);
    expect(renderedSpatial().themeId).toBe("bronze-rain-glass");
    expect(renderedSpatial().waves.color).toEqual(bronze);
    expect(lastMappedFrame().bassEnergy).toBeGreaterThan(0);
    expect(h.harness.renderers).toHaveLength(1);
    expect(renderer.disposed).toBe(false);

    // Lifecycle changes never write storage or personal pitch colors.
    expect(storageSnapshot()).toEqual(storageBefore);
    expect(pitchInputValues()).toEqual(pitchBefore);
    expect(lower(new ProfileStore(window.localStorage).load().profile.pitchColors)).toEqual(lower(testProfile().pitchColors));
  });

  it("hosts only the public notice and synthetic preview while legacy Spotify and key setup stay unavailable", async () => {
    vi.stubEnv("MODE", "hosted");
    const configure = vi.spyOn(h.FakeSongContextClient.prototype, "configureAndConnect");
    await boot({ ...testProfile(), spatial: { ...defaultSpatialPreferences(), mode: "spatial" as const } });
    const storageBefore = storageSnapshot();
    const pitchBefore = pitchInputValues();
    const spotifyButton = document.getElementById("spotify-connect") as HTMLButtonElement;
    const spotifyDialog = document.getElementById("spotify-dialog") as HTMLDialogElement;
    const spotifyStatus = document.getElementById("spotify-form-status")!;

    // Legacy Spotify setup stays unavailable even through programmatic click and submit events.
    expect(spotifyButton.hidden || spotifyButton.disabled).toBe(true);
    spotifyButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await settle();
    expect(spotifyDialog.hasAttribute("open")).toBe(false);
    (document.getElementById("spotify-client-id") as HTMLInputElement).value = "synthetic-client-id";
    document.getElementById("spotify-form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(configure).not.toHaveBeenCalled();
    expect(spotifyDialog.hasAttribute("open")).toBe(false);
    expect(spotifyStatus.textContent ?? "").toBe("");

    // Optional cloud enrichment is deferred: no visible, enabled Last.fm/OpenAI key setup.
    document.getElementById("debug-toggle")!.click();
    runFrames(2);
    const keySetup = [...document.querySelectorAll<HTMLButtonElement>("#debug-overlay button")]
      .filter((button) => /last\.?fm|openai|api key|client id/i.test(`${button.textContent ?? ""} ${button.getAttribute("aria-label") ?? ""}`));
    for (const button of keySetup) expect(button.disabled || button.closest("[hidden]") !== null, button.textContent ?? "").toBe(true);

    const notice = document.getElementById("hosted-notice");
    expect(notice, "hosted notice").not.toBeNull();
    expect(notice!.hidden).toBe(false);
    for (const phrase of [/uncalibrated/i, /public template/i, /personal profile/i, /local/i, /cloud/i, /\bAI\b/]) {
      expect(notice!.textContent).toMatch(phrase);
    }
    const preview = previewButton();
    expect(preview.hidden || preview.disabled).toBe(false);
    expect(preview.textContent?.trim()).toBe("Start synthetic preview");
    expect(preview.getAttribute("aria-pressed")).toBe("false");

    expect(storageSnapshot()).toEqual(storageBefore);
    expect(pitchInputValues()).toEqual(pitchBefore);
  });
  it("offers session-only mood colors while preserving stored personal pitch colors", async () => {
    const { audio } = await boot(testProfile());
    const storageBefore = storageSnapshot();
    const pitchBefore = pitchInputValues();
    const selector = document.querySelector<HTMLSelectElement>('select[aria-label="Color palette"]');
    expect(selector).not.toBeNull();
    expect(selector!.value).toBe("personal");
    audio.emitFrame({ ...previewFrame("mids", 0.05), chromaConfidence: 1, chroma: { ...silentAudioFrame.chroma, c: 1 } });
    runFrames(10);
    const original = JSON.parse(active().renders.at(-1)!.json).layers.map((layer: { color: number[] }) => layer.color);
    choose(selector!, "mood"); runFrames(10);
    expect(JSON.parse(active().renders.at(-1)!.json).layers.map((layer: { color: number[] }) => layer.color)).not.toEqual(original);
    expect(storageSnapshot()).toEqual(storageBefore);
    expect(pitchInputValues()).toEqual(pitchBefore);
    expect(new ProfileStore(window.localStorage).load().profile.pitchColors).toEqual(testProfile().pitchColors);
  });

  it("runs a session-only synthetic spatial preview that stops cleanly, yields to live frames, and never resumes when hidden", async () => {
    vi.stubEnv("MODE", "hosted");
    const { update, resetSpatialHistory, audio } = await boot({ ...testProfile(), spatial: defaultSpatialPreferences() });
    const lastMappedFrame = (): AudioFrame => update.mock.calls.at(-1)![0];
    const label = document.getElementById("connection-label")!;
    const liveLabel = label.textContent;
    const storageBefore = storageSnapshot();
    const pitchBefore = pitchInputValues();
    const preview = previewButton();

    // Start: explicit spatial renderer, session bronze theme, cleared history, synthetic mix frames on the existing loop only.
    const resetsBefore = resetSpatialHistory.mock.calls.length;
    preview.click();
    await settle();
    expect(preview.getAttribute("aria-pressed")).toBe("true");
    expect(preview.textContent?.trim()).toBe("Stop synthetic preview");
    expect(label.textContent).toMatch(/Synthetic preview/);
    expect(label.textContent).toMatch(/not live audio/i);
    expect(resetSpatialHistory.mock.calls.length).toBeGreaterThan(resetsBefore);
    expect(h.harness.frames.size).toBe(1);
    expect(runFrames(3)).toBe(3);
    expect(active().mode).toBe("spatial");
    expect(lastMappedFrame().bassEnergy).toBeGreaterThan(0);
    expect(lastMappedFrame().midEnergy).toBeGreaterThan(0);
    expect(lastMappedFrame().trebleEnergy).toBeGreaterThan(0);
    expect(renderedSpatial().themeId).toBe("bronze-rain-glass");

    // Stop: quiet baseline and the original label.
    preview.click();
    await settle();
    expect(preview.getAttribute("aria-pressed")).toBe("false");
    expect(preview.textContent?.trim()).toBe("Start synthetic preview");
    expect(label.textContent).toBe(liveLabel);
    runFrames(2);
    expect(quiet(lastMappedFrame())).toEqual(quiet(silentAudioFrame));

    // A valid live frame stops the preview first and is itself adopted, not dropped.
    preview.click();
    await settle();
    runFrames(1);
    expect(lastMappedFrame().midEnergy).toBeGreaterThan(0);
    audio.emitFrame(previewFrame("bass", 0.05));
    expect(preview.getAttribute("aria-pressed")).toBe("false");
    expect(label.textContent).toBe(liveLabel);
    runFrames(1);
    expect(lastMappedFrame().bassEnergy).toBeGreaterThan(0);
    expect(lastMappedFrame().midEnergy).toBe(0);
    expect(lastMappedFrame().trebleEnergy).toBe(0);

    // Hiding the page disables the preview; becoming visible never resumes fake audio.
    preview.click();
    await settle();
    runFrames(1);
    expect(lastMappedFrame().midEnergy).toBeGreaterThan(0);
    setHidden(true);
    await settle();
    expect(preview.getAttribute("aria-pressed")).toBe("false");
    expect(h.harness.frames.size).toBe(0);
    expect(runFrames(3)).toBe(0);
    setHidden(false);
    await settle();
    expect(runFrames(2)).toBe(2);
    expect(preview.getAttribute("aria-pressed")).toBe("false");
    expect(quiet(lastMappedFrame())).toEqual(quiet(silentAudioFrame));

    // Session-only: no storage or personal palette writes.
    expect(storageSnapshot()).toEqual(storageBefore);
    expect(pitchInputValues()).toEqual(pitchBefore);
    expect(lower(new ProfileStore(window.localStorage).load().profile.pitchColors)).toEqual(lower(testProfile().pitchColors));
  });
});

async function boot(profile: SynesthesiaProfile) {
  expect(new ProfileStore(window.localStorage).replace(profile).ok).toBe(true);
  const parsed = new DOMParser().parseFromString(indexHtml, "text/html");
  parsed.querySelectorAll("script").forEach((script) => script.remove());
  document.body.innerHTML = parsed.body.innerHTML;

  vi.resetModules();
  // Passthrough observers on the real mapping instance main will import.
  const { VisualContextEngine } = await import("./mappings/VisualContextEngine");
  const update = vi.spyOn(VisualContextEngine.prototype, "update");
  const resetSpatialHistory = vi.spyOn(VisualContextEngine.prototype, "resetSpatialHistory");
  await import("./main");
  await settle();
  const audio = h.harness.audioClients.at(-1);
  expect(audio, "audio client constructed").toBeDefined();
  return { update, resetSpatialHistory, audio: audio! };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// Runs only callbacks queued before each step, skipping any cancelled mid-batch.
function runFrames(count: number, stepMs = 16): number {
  let ran = 0;
  for (let i = 0; i < count; i++) {
    h.harness.clock += stepMs;
    for (const handle of [...h.harness.frames.keys()]) {
      const callback = h.harness.frames.get(handle);
      if (callback === undefined) continue;
      h.harness.frames.delete(handle);
      callback(h.harness.clock);
      ran++;
    }
  }
  return ran;
}

function pendingCallbacks(): FrameRequestCallback[] {
  return [...h.harness.frames.values()];
}

function setHidden(hidden: boolean): void {
  h.harness.hidden = hidden;
  document.dispatchEvent(new Event("visibilitychange"));
}

function active(): RecordedRenderer {
  const renderer = h.harness.renderers.at(-1);
  expect(renderer, "renderer created").toBeDefined();
  return renderer!;
}

function effectiveReducedMotion(renderer: RecordedRenderer): boolean {
  return renderer.reducedMotion.at(-1) ?? Boolean(renderer.options?.reducedMotion);
}

function panel(): HTMLElement {
  return document.getElementById("calibration-panel")!;
}

function selectByLabel(label: string): HTMLSelectElement {
  const select = panel().querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  expect(select, label).not.toBeNull();
  return select!;
}

function motionSelect(): HTMLSelectElement {
  const select = [...document.querySelectorAll("select")].find((candidate) =>
    [...candidate.options].map((option) => option.value).sort().join() === "full,reduce,system");
  expect(select, "Motion preference select with system|reduce|full options").toBeDefined();
  return select!;
}

function choose(select: HTMLSelectElement, value: string): void {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function clickButton(label: string): void {
  const button = [...panel().querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  expect(button, label).toBeDefined();
  button!.click();
}

function pitchInputValues(): string[] {
  return [...panel().querySelectorAll<HTMLInputElement>('input[type="color"]')].map((input) => input.value.toLowerCase());
}

function storageSnapshot(): Record<string, string | null> {
  const entries: Record<string, string | null> = {};
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i)!;
    entries[key] = window.localStorage.getItem(key);
  }
  return entries;
}

function lower(colors: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(colors).map(([key, value]) => [key, value.toLowerCase()]));
}

function quiet(frame: AudioFrame) {
  const { rms, bassEnergy, midEnergy, trebleEnergy, onsetStrength } = frame;
  return { rms, bassEnergy, midEnergy, trebleEnergy, onsetStrength };
}

function dispatchSpatialTheme(detail: Record<string, unknown>): void {
  panel().dispatchEvent(new CustomEvent("spatial-theme-change", { bubbles: true, detail }));
}

function renderedSpatial(): SpatialVisualState {
  const state = JSON.parse(active().renders.at(-1)!.json) as { spatial?: SpatialVisualState };
  expect(state.spatial, "spatial state rendered").toBeDefined();
  return state.spatial!;
}

// Synthetic metadata only; no real track IDs, titles or lyrics.
function songSnapshot(spotifyTrackId: string, progressMs: number): SongContextSnapshot {
  return {
    ...initialSongContext, metadataStatus: "playingTrack", authenticationStatus: "valid", spotifyConfigured: true,
    sqliteStatus: "ready", lastSuccessfulUpdateUtc: "2026-01-01T00:00:00.000Z",
    currentTrack: {
      spotifyTrackId, spotifyUri: null, isrc: null, title: `Synthetic song ${spotifyTrackId}`,
      artists: [{ spotifyArtistId: null, name: "Synthetic artist" }], album: null, durationMs: 180000,
      explicit: null, progressMs, isPlaying: true, observedAtUtc: "2026-01-01T00:00:00.000Z",
    },
  };
}

function previewButton(): HTMLButtonElement {
  const button = document.getElementById("synthetic-preview");
  expect(button, "hosted synthetic preview button").not.toBeNull();
  return button as HTMLButtonElement;
}
