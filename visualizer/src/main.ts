/// <reference types="vite/client" />
import {
  Bug,
  Link,
  Maximize,
  Minimize,
  RotateCcw,
  SlidersHorizontal,
  X,
  createIcons,
} from "lucide";
import "./styles.css";
import { AudioFrameClient, type AudioFrameClientStatus } from "./audio/AudioFrameClient";
import { silentAudioFrame, type AudioFrame } from "./audio/AudioFrame";
import { attachCompanionBootstrap, type CompanionWebViewBridge } from "./connection/CompanionBootstrap";
import { CompanionClient, type CompanionStatus } from "./connection/CompanionClient";
import { CompanionPanel } from "./connection/CompanionPanel";
import { HostedAccountPanel } from "./connection/HostedAccountPanel";
import { isCompanionPort } from "./connection/CompanionProtocol";
import { VisualContextEngine } from "./mappings/VisualContextEngine";
import type { VisualState } from "./mappings/VisualState";
import { ProfileStore } from "./profiles/ProfileStore";
import { isSpatialWaveColor, type SpatialThemeId } from "./profiles/SpatialProfile";
import type { SynesthesiaProfile } from "./profiles/SynesthesiaProfile";
import { SongContextClient, type SongContextConnectionState } from "./song/SongContextClient";
import { initialSongContext, type CurrentTrack, type SongContextSnapshot } from "./song/SongContext";
import { CalibrationPanel, type MotionPreference } from "./ui/CalibrationPanel";
import { DebugOverlay } from "./ui/DebugOverlay";
import { createVisualRenderer, type RendererMode } from "./visuals/RendererFactory";
import { RenderLoop, type FrameScheduler } from "./visuals/RenderLoop";
import { previewFrame } from "./verification/PreviewFixtures";
import { normalizeLayerPreview, type LayerPreview, type RenderOptions, type VisualRenderer } from "./visuals/VisualRenderer";

const canvas = requiredElement<HTMLCanvasElement>("painting");
const connectionStatus = requiredElement<HTMLElement>("connection-status");
const connectionLabel = requiredElement<HTMLElement>("connection-label");
const calibrationElement = requiredElement<HTMLElement>("calibration-panel");
const debugElement = requiredElement<HTMLElement>("debug-overlay");
const calibrationToggle = requiredElement<HTMLButtonElement>("calibration-toggle");
const debugToggle = requiredElement<HTMLButtonElement>("debug-toggle");
const fullscreenToggle = requiredElement<HTMLButtonElement>("fullscreen-toggle");
const spotifyConnect = requiredElement<HTMLButtonElement>("spotify-connect");
const spotifyDialog = requiredElement<HTMLDialogElement>("spotify-dialog");
const spotifyForm = requiredElement<HTMLFormElement>("spotify-form");
const spotifyClientId = requiredElement<HTMLInputElement>("spotify-client-id");
const spotifyFormStatus = requiredElement<HTMLElement>("spotify-form-status");
const companionConnect = requiredElement<HTMLButtonElement>("companion-connect");
const companionDialog = requiredElement<HTMLDialogElement>("companion-dialog");
const webglError = requiredElement<HTMLElement>("webgl-error");
// Public hosted pilot only; the native build never takes these branches.
const hosted = import.meta.env.MODE === "hosted";
const previewBronzeTint = "#b88654";
const syntheticPreviewButton = hosted ? setupHostedMode() : null;

const profileStore = browserProfileStore();
const loadedProfile = profileStore.load();
let profile: SynesthesiaProfile = loadedProfile.profile;
let sessionColorMode: "personal" | "mood" | null = null;
const paletteChooser = setupPaletteChooser();
let latestFrame: AudioFrame = silentAudioFrame;
let visualState: VisualState;
let connection: AudioFrameClientStatus = {
  state: "disconnected",
  messagesPerSecond: 0,
  lastReceiveAt: 0,
};
let lastFrameAt = 0;
let calibrationOpen = false;
let painting: VisualRenderer | null = null;
let activeRenderer: RendererMode | null = null;
let rendererGeneration = 0;
let renderLoop: RenderLoop | null = null;
let disposed = false;
let songContext: SongContextSnapshot = initialSongContext;
let songConnection: SongContextConnectionState = "disconnected";
let companionStatus: CompanionStatus = "unpaired";
// Session-only presentation state; none of it is written to the profile or storage.
let sessionTheme: SpatialThemeId | null = null;
let sessionWaveColor: string | null = null;
let layerPreview: LayerPreview = "all";
let motionPreference: MotionPreference = "system";
let songIdentity: string | null = null;
let fpsWindowStart: number | null = null;
let renderedFrames = 0;
let fps = 0;
let lastDebugUpdate = Number.NEGATIVE_INFINITY;
// Session-only synthetic preview: never persisted, never reported as live audio.
let previewActive = false;
let previewStartedAt: number | null = null;
let previewSavedTheme: SpatialThemeId | null = null;
let previewSavedWaveColor: string | null = null;

const frameScheduler: FrameScheduler = {
  requestFrame: (callback) => window.requestAnimationFrame(callback),
  cancelFrame: (handle) => window.cancelAnimationFrame(handle),
};
const reducedMotionQuery = typeof window.matchMedia === "function"
  ? window.matchMedia("(prefers-reduced-motion: reduce)")
  : null;
// The OS preference only applies while Motion follows the system.
const detachReducedMotion = reducedMotionQuery === null
  ? () => {}
  : watchMediaQuery(reducedMotionQuery, () => { if (motionPreference === "system") applyReducedMotion(); });

const contextEngine = new VisualContextEngine();
visualState = contextEngine.update(latestFrame, effectiveProfile(), 1);
const debugOverlay = new DebugOverlay(debugElement, requestLastFmSetup, requestOpenAiSetup, () => {
  if (hosted) return;
  const host = (window as Window & { chrome?: { webview?: { postMessage(message: unknown): void } } }).chrome?.webview;
  host?.postMessage({ protocolVersion: 1, type: "reanalyzeLyrics" });
});
const calibrationPanel = new CalibrationPanel(
  calibrationElement,
  profile,
  (updatedProfile) => {
    profile = updatedProfile;
    sessionColorMode = null;
    paletteChooser.value = profile.colorMode ?? "personal";
    window.queueMicrotask(refreshIcons);
  },
  () => setCalibrationOpen(false),
  profileStore,
  loadedProfile.warning,
);
// Do not silently hide fallback/storage warnings behind a closed calibration panel.
if (loadedProfile.warning !== null) setCalibrationOpen(true);

const webViewBridge = (window as Window & { chrome?: { webview?: CompanionWebViewBridge } }).chrome?.webview;
const companionPort = resolveCompanionPort();
const companion = new CompanionClient(companionPort);
const getCredential = (): string | null => companion.credential();
const requireAuthentication = (): void => {
  companion.invalidate();
  stopStreams();
};
const audioClient = new AudioFrameClient(`ws://127.0.0.1:${companionPort}/audio`, getCredential, requireAuthentication);
const songClient = new SongContextClient(
  `ws://127.0.0.1:${companionPort}/song-context`, getCredential, requireAuthentication);
const companionPanel = new CompanionPanel(companionDialog, companion);
audioClient.onFrame((frame) => {
  // Frames delivered while hidden are dropped so nothing replays at resume.
  if (disposed || document.hidden) return;
  // Valid live audio ends the synthetic preview first and is then adopted, not dropped.
  if (previewActive) stopSyntheticPreview();
  latestFrame = frame;
  lastFrameAt = performance.now();
});
audioClient.onStatus((status) => {
  const lost = connection.state === "connected" && status.state !== "connected";
  connection = status;
  if (lost) clearVisualHistory();
  updateConnectionLabel();
});
function adoptSongSnapshot(snapshot: SongContextSnapshot): void {
  if (disposed) return;
  songContext = snapshot;
  const identity = trackIdentity(snapshot.currentTrack);
  if (identity !== songIdentity) {
    songIdentity = identity;
    clearVisualHistory();
  }
  syncSavableTrack();
  updateSpotifyButton();
}
function adoptSongStatus(status: SongContextConnectionState): void {
  if (disposed) return;
  songConnection = status;
  if (status !== "connected" && !songContext.stale) {
    // Metadata freshness is independent of the local audio connection. Reconnecting
    // alone cannot restore it; only a validated snapshot can do that.
    songContext = { ...songContext, stale: true };
    clearSpatialHistory();
  }
  syncSavableTrack();
  updateSpotifyButton();
}
songClient.onSnapshot(snapshot => { if (!hosted) adoptSongSnapshot(snapshot); });
songClient.onStatus(status => { if (!hosted) adoptSongStatus(status); });
const hostedAccount = hosted ? new HostedAccountPanel(requiredElement<HTMLElement>("hosted-account"), {
  onSnapshot: adoptSongSnapshot, onStatus: adoptSongStatus,
}) : null;
// Registered after every binding it touches: onStatus invokes the listener immediately.
companion.onStatus((status) => {
  companionStatus = status;
  if (status === "paired") {
    audioClient.start();
    if (!hosted) songClient.start();
  } else {
    stopStreams();
  }

  companionPanel.setStatus(status);
  updateConnectionLabel();
});
const detachBootstrap = attachCompanionBootstrap(companion, webViewBridge, window.location.href, companionPort);

calibrationToggle.addEventListener("click", () => setCalibrationOpen(!calibrationOpen));
debugToggle.addEventListener("click", () => { if (!hosted) debugOverlay.toggle(); });
fullscreenToggle.addEventListener("click", () => void toggleFullscreen());
spotifyConnect.addEventListener("click", handleSpotifyConnect);
spotifyForm.addEventListener("submit", handleSpotifySubmit);
spotifyDialog.querySelector<HTMLElement>("[data-close-dialog]")?.addEventListener("click", () => spotifyDialog.close());
companionConnect.addEventListener("click", () => companionPanel.open());
syntheticPreviewButton?.addEventListener("click", () => {
  if (disposed) return;
  if (previewActive) stopSyntheticPreview();
  else startSyntheticPreview();
});
calibrationElement.addEventListener("spatial-mode-change", (event) => {
  const mode = eventDetail(event).mode;
  if (mode === "painting" || mode === "spatial") requestRenderer(mode);
});
calibrationElement.addEventListener("spatial-preview", (event) => previewLayer(normalizeLayerPreview(eventDetail(event).layer)));
calibrationElement.addEventListener("spatial-theme-change", (event) => {
  if (disposed) return;
  const detail = eventDetail(event);
  const theme = detail.theme;
  if (theme !== "personal" && theme !== "bronze-rain-glass") return;
  // A tint is only meaningful with bronze: personal ignores any supplied tint, and a bronze event without one keeps the current session tint.
  if (theme === "bronze-rain-glass") {
    const tint = detail.waveColor;
    if (tint !== undefined && !isSpatialWaveColor(tint)) return;
    if (typeof tint === "string") sessionWaveColor = tint.toLowerCase();
  }
  sessionTheme = theme;
  clearSpatialHistory();
});
calibrationElement.addEventListener("spatial-motion-change", (event) => {
  const motion = eventDetail(event).motion;
  if (motion !== "system" && motion !== "reduce" && motion !== "full") return;
  motionPreference = motion;
  applyReducedMotion();
});
document.addEventListener("visibilitychange", syncVisibility);
document.addEventListener("fullscreenchange", updateFullscreenIcon);
window.addEventListener("resize", () => painting?.resize());
window.addEventListener("keydown", (event) => {
  if (!hosted && event.key.toLowerCase() === "d" && !isTextInput(event.target)) {
    debugOverlay.toggle();
  }

  if (event.key === "Escape" && calibrationOpen) {
    setCalibrationOpen(false);
  }
});
window.addEventListener("beforeunload", shutdown);

// Keep the verified painting at startup until spatial playback acceptance; only an explicit Renderer mode choice switches.
installRenderer("painting");
if (activeRenderer === "painting" && profile.spatial?.mode === "spatial") {
  calibrationPanel.setRendererStatus("painting", "Your saved renderer is Spatial. Painting stays active at startup until the experimental spatial renderer passes visual review; choose Spatial to preview it for this session.");
}

refreshIcons();
updateSpotifyButton();
hostedAccount?.start();

interface CreatedRenderer {
  renderer: VisualRenderer;
  fallbackMessage: string | null;
}

function requestRenderer(mode: RendererMode): void {
  if (disposed) return;
  if (mode === activeRenderer && renderLoop !== null) {
    calibrationPanel.setRendererStatus(mode, null);
    return;
  }
  installRenderer(mode);
}

// Disposes the current renderer before its canvas is reused, then drives the replacement with a fresh loop.
function installRenderer(requested: RendererMode): void {
  if (disposed) return;
  releaseRenderer();
  let created: CreatedRenderer;
  try {
    created = createRendererFor(requested);
  } catch (error) {
    showRendererFailure(error instanceof Error ? error.message : "WebGL rendering is unavailable. Your profile is unchanged.");
    return;
  }

  const renderer = created.renderer;
  painting = renderer;
  // The factory substitutes the painting when the 3D scene cannot start; report what actually runs.
  activeRenderer = requested === "spatial" && created.fallbackMessage !== null ? "painting" : requested;
  if (!webglError.hidden) {
    webglError.hidden = true;
    connectionStatus.hidden = false;
  }
  renderer.setLayerPreview(layerPreview);
  calibrationPanel.setRendererStatus(activeRenderer, created.fallbackMessage === null
    ? null
    : `${created.fallbackMessage} Your saved colors and spatial settings are unchanged.`);

  resetFrameMetrics();
  const loop = new RenderLoop(frameScheduler, renderFrame, resumeQuietly,
    () => failRenderer("Rendering stopped after an unexpected error."));
  renderLoop = loop;
  // Hidden is applied before start so a hidden page schedules nothing.
  loop.setHidden(document.hidden);
  loop.start();
}

// Failures during construction describe the factory fallback; later ones come from the live renderer.
function createRendererFor(mode: RendererMode): CreatedRenderer {
  const generation = ++rendererGeneration;
  let constructing = true;
  const failures: string[] = [];
  const options: RenderOptions = {
    reducedMotion: reducedMotionEnabled(),
    onFailure: (message) => {
      if (constructing) failures.push(message);
      else if (generation === rendererGeneration) failRenderer(message);
    },
  };
  try {
    return { renderer: createVisualRenderer(canvas, mode, options), fallbackMessage: failures.at(-1) ?? null };
  } finally {
    constructing = false;
  }
}

function releaseRenderer(): void {
  renderLoop?.dispose();
  renderLoop = null;
  rendererGeneration++;
  const previous = painting;
  painting = null;
  activeRenderer = null;
  try {
    previous?.dispose();
  } catch {
    // Disposal is best effort; the canvas is reused by the next renderer.
  }
}

// Stops the loop without retrying; only an explicit renderer choice starts a new one.
function failRenderer(message: string): void {
  if (disposed) return;
  renderLoop?.dispose();
  renderLoop = null;
  showRendererFailure(message);
}

function showRendererFailure(message: string): void {
  webglError.hidden = false;
  connectionStatus.hidden = true;
  calibrationPanel.setRendererStatus(activeRenderer, `${message} Rendering is stopped; choose a renderer to try again.`);
}

function renderFrame(timestamp: number, delta: number): void {
  const renderer = painting;
  if (disposed || renderer === null) return;
  // A frame older than 500 ms maps as silence rather than frozen loudness.
  const fresh = lastFrameAt !== 0 && timestamp - lastFrameAt <= 500;
  let source: AudioFrame = fresh ? latestFrame : silentAudioFrame;
  if (previewActive) {
    // Synthetic time derives from this loop's timestamps, relative to the first preview frame.
    const startedAt = previewStartedAt ?? timestamp;
    previewStartedAt = startedAt;
    source = previewFrame("mix", (timestamp - startedAt) / 1000);
  }
  visualState = contextEngine.update(source, effectiveProfile(), delta, songContext,
    sessionTheme, sessionWaveColor);
  renderer.render(visualState, delta);
  recordFrameMetrics(timestamp);
}

function recordFrameMetrics(timestamp: number): void {
  fpsWindowStart ??= timestamp;
  renderedFrames += 1;
  if (timestamp - fpsWindowStart >= 1000) {
    fps = renderedFrames * 1000 / (timestamp - fpsWindowStart);
    renderedFrames = 0;
    fpsWindowStart = timestamp;
  }

  if (!hosted && timestamp - lastDebugUpdate >= 250) {
    debugOverlay.update(latestFrame, visualState, connection, fps, songContext);
    lastDebugUpdate = timestamp;
  }
}

// Paused time never counts toward the frame rate.
function resetFrameMetrics(): void {
  fpsWindowStart = null;
  renderedFrames = 0;
  fps = 0;
  lastDebugUpdate = Number.NEGATIVE_INFINITY;
}

// Resume starts from a quiet baseline: cached loud frames and old trails never replay.
function resumeQuietly(): void {
  clearVisualHistory();
  resetFrameMetrics();
}

// Drops the cached frame, spatial mapping history and renderer trails across a source, track or visibility boundary.
function clearVisualHistory(): void {
  latestFrame = silentAudioFrame;
  lastFrameAt = 0;
  clearSpatialHistory();
}

// A theme or tint switch restarts spatial mapping and trails without dropping the live audio frame.
function clearSpatialHistory(): void {
  contextEngine.resetSpatialHistory();
  clearRendererTrails();
}

function clearRendererTrails(): void {
  if (disposed || painting === null) return;
  try {
    painting.clear();
  } catch {
    failRenderer("The renderer could not reset its trails.");
  }
}

function previewLayer(layer: LayerPreview): void {
  if (disposed) return;
  layerPreview = layer;
  painting?.setLayerPreview(layer);
  // Trails drawn by now-hidden layers would otherwise linger in a solo preview.
  clearRendererTrails();
}

function reducedMotionEnabled(): boolean {
  return motionPreference === "reduce" || (motionPreference === "system" && (reducedMotionQuery?.matches ?? false));
}

function applyReducedMotion(): void {
  if (disposed) return;
  painting?.setReducedMotion(reducedMotionEnabled());
}

function syncVisibility(): void {
  if (disposed) return;
  // Hiding ends the synthetic preview, so becoming visible resumes quietly instead of replaying it.
  if (document.hidden) stopSyntheticPreview();
  renderLoop?.setHidden(document.hidden);
}

// Terminal: disposed is set first so no callback, media change or fallback can restart rendering.
function shutdown(): void {
  if (disposed) return;
  disposed = true;
  previewActive = false;
  previewStartedAt = null;
  if (syntheticPreviewButton !== null) {
    syntheticPreviewButton.disabled = true;
    syntheticPreviewButton.setAttribute("aria-pressed", "false");
  }
  renderLoop?.dispose();
  renderLoop = null;
  calibrationPanel.dispose();
  hostedAccount?.dispose();
  detachReducedMotion();
  document.removeEventListener("visibilitychange", syncVisibility);
  // Local invalidation only: the desktop replaces its session on the next load and hosted leases expire.
  detachBootstrap();
  companion.invalidate();
  audioClient.stop();
  songClient.stop();
  releaseRenderer();
}

function browserProfileStore(): ProfileStore {
  try { return new ProfileStore(window.localStorage); }
  catch { return new ProfileStore(null); }
}

function setCalibrationOpen(open: boolean): void {
  calibrationOpen = open;
  calibrationElement.classList.toggle("is-open", open);
  calibrationElement.setAttribute("aria-hidden", String(!open));
  calibrationToggle.setAttribute("aria-expanded", String(open));
  if (open) {
    debugOverlay.setVisible(false);
    calibrationPanel.setProfile(profile);
    window.queueMicrotask(refreshIcons);
  }
}

async function toggleFullscreen(): Promise<void> {
  if (document.fullscreenElement) {
    await document.exitFullscreen();
  } else {
    await document.documentElement.requestFullscreen();
  }
}

function updateFullscreenIcon(): void {
  const fullscreen = Boolean(document.fullscreenElement);
  fullscreenToggle.title = fullscreen ? "Exit fullscreen" : "Fullscreen";
  fullscreenToggle.setAttribute("aria-label", fullscreen ? "Exit fullscreen" : "Toggle fullscreen");
  fullscreenToggle.innerHTML = `<i data-lucide="${fullscreen ? "minimize" : "maximize"}" aria-hidden="true"></i>`;
  refreshIcons();
}

function refreshIcons(): void {
  createIcons({
    icons: { Bug, Link, Maximize, Minimize, RotateCcw, SlidersHorizontal, X },
    attrs: { "stroke-width": 1.8 },
  });
}

function handleSpotifyConnect(event?: Event): void {
  event?.preventDefault();
  if (hosted) return;
  if (songContext.spotifyConfigured && songContext.authenticationStatus !== "valid") {
    if (!songClient.configureAndConnect()) {
      openSpotifyDialog("Spotify metadata is offline.");
    }
    return;
  }

  openSpotifyDialog(songContext.authenticationStatus === "valid" ? "Enter a new client ID to change Spotify apps." : "");
}

function handleSpotifySubmit(event: SubmitEvent): void {
  event.preventDefault();
  if (hosted) return;
  const clientId = spotifyClientId.value.trim();
  if (!clientId) {
    spotifyFormStatus.textContent = "A client ID is required.";
    return;
  }

  if (!songClient.configureAndConnect(clientId)) {
    spotifyFormStatus.textContent = "Spotify metadata is offline.";
    return;
  }

  spotifyClientId.value = "";
  spotifyDialog.close();
}

function openSpotifyDialog(status: string): void {
  if (hosted) return;
  spotifyFormStatus.textContent = status;
  spotifyDialog.showModal();
  window.queueMicrotask(() => {
    refreshIcons();
    spotifyClientId.focus();
  });
}

function updateSpotifyButton(): void {
  const status = songContext.authenticationStatus;
  spotifyConnect.dataset.state = status;
  spotifyConnect.disabled = hosted || status === "authorizing";
  spotifyConnect.title = songConnection !== "connected"
    ? "Spotify metadata offline"
    : status === "valid"
      ? "Spotify connected"
      : status === "reauthorizationRequired"
        ? "Reconnect Spotify"
        : "Connect Spotify";
  spotifyConnect.setAttribute("aria-label", spotifyConnect.title);
}

// Drops the stream state so no frame, song metadata or trail outlives the credential.
function stopStreams(): void {
  audioClient.stop();
  songClient.stop();
  if (!hosted) {
    songContext = initialSongContext;
    songIdentity = null;
  }
  clearVisualHistory();
  syncSavableTrack();
  updateSpotifyButton();
}

function updateConnectionLabel(): void {
  const paired = companionStatus === "paired";
  connectionStatus.dataset.state = paired ? connection.state : companionStatus === "pairing" ? "connecting" : "disconnected";
  connectionLabel.textContent = companionStatus === "pairing"
    ? "Pairing"
    : companionStatus === "unavailable"
      ? "Companion unavailable"
      : !paired
        ? "Connect Windows companion"
        : connection.state === "connected"
          ? connection.lastReceiveAt > 0 ? "Audio live" : "Waiting for Spotify"
          : connection.state === "connecting" ? "Connecting" : "Companion offline";
  companionConnect.dataset.state = companionStatus;
  companionConnect.textContent = paired ? "Windows companion" : "Connect Windows companion";
  if (previewActive) {
    connectionStatus.dataset.state = "preview";
    connectionLabel.textContent = "Synthetic preview - not live audio";
  }
}

// Only the exact bundled document inside the WebView2 host uses its serving
// port; every other page uses the default companion port.
function resolveCompanionPort(): number {
  const port = Number(window.location.port);
  const root = `http://127.0.0.1:${port}/`;
  const href = window.location.href;
  return webViewBridge !== undefined && isCompanionPort(port) && (href === root || href === `${root}index.html`)
    ? port
    : 8765;
}

function requestLastFmSetup(): void {
  if (hosted) return;
  const host = (window as Window & {
    chrome?: { webview?: { postMessage(message: unknown): void } };
  }).chrome?.webview;
  host?.postMessage({ protocolVersion: 1, type: "openLastFmSetup" });
}

function requestOpenAiSetup(): void {
  if (hosted) return;
  const host = (window as Window & {
    chrome?: { webview?: { postMessage(message: unknown): void } };
  }).chrome?.webview;
  host?.postMessage({ protocolVersion: 1, type: "openOpenAiSetup" });
}

// Public pilot only: hides legacy Spotify, diagnostics and key setup, then adds the notice and an explicit preview toggle.
function setupHostedMode(): HTMLButtonElement {
  document.body.classList.add("is-hosted");
  for (const element of [spotifyConnect, spotifyDialog, spotifyForm, debugToggle, debugElement]) element.hidden = true;
  spotifyConnect.disabled = true;
  spotifyClientId.disabled = true;
  debugToggle.disabled = true;
  debugElement.setAttribute("aria-hidden", "true");
  if (spotifyDialog.open) spotifyDialog.close();

  const notice = document.createElement("p");
  notice.id = "hosted-notice";
  notice.className = "hosted-notice";
  notice.setAttribute("role", "note");
  const lead = document.createElement("strong");
  lead.textContent = "Uncalibrated public template.";
  notice.append(lead, " Import your personal profile locally in Calibration, or try Mood colors for this session. Cloud song tags require Spotify sign-in and configured hosting. AI analysis is optional and never automatic. Audio stays on this computer.");
  const account = document.createElement("span");
  account.id = "hosted-account";
  account.className = "hosted-account";
  calibrationElement.before(notice);
  notice.append(account);

  const button = document.createElement("button");
  button.id = "synthetic-preview";
  button.className = "text-button";
  button.type = "button";
  button.textContent = "Start synthetic preview";
  button.setAttribute("aria-pressed", "false");
  companionConnect.after(button);
  return button;
}

function effectiveProfile(): SynesthesiaProfile {
  return sessionColorMode === null ? profile : { ...profile, colorMode: sessionColorMode };
}

function setupPaletteChooser(): HTMLSelectElement {
  const selector = document.createElement("select");
  selector.className = "palette-chooser";
  selector.setAttribute("aria-label", "Color palette");
  selector.title = "Session-only color mode; your saved personal pitch colors stay unchanged";
  for (const [value, text] of [["personal", "Personal colors"], ["mood", "Mood colors"]]) {
    const option = document.createElement("option"); option.value = value; option.textContent = text;
    selector.append(option);
  }
  selector.value = profile.colorMode ?? "personal";
  selector.addEventListener("change", () => {
    if (disposed || (selector.value !== "personal" && selector.value !== "mood")) return;
    sessionColorMode = selector.value;
  });
  fullscreenToggle.before(selector);
  return selector;
}

// Explicit and session-only: selects the spatial renderer and a bronze session theme, saving the prior session theme.
function startSyntheticPreview(): void {
  if (!hosted || disposed || previewActive || document.hidden) return;
  requestRenderer("spatial");
  // A renderer that could not start shows its own error; never claim a preview that cannot draw.
  if (disposed || renderLoop === null || painting === null) return;
  previewSavedTheme = sessionTheme;
  previewSavedWaveColor = sessionWaveColor;
  sessionTheme = "bronze-rain-glass";
  sessionWaveColor = previewBronzeTint;
  previewActive = true;
  previewStartedAt = null;
  clearVisualHistory();
  updatePreviewControls();
  updateConnectionLabel();
}

// Restores the prior session theme and a quiet baseline; idempotent.
function stopSyntheticPreview(): void {
  if (!previewActive) return;
  previewActive = false;
  previewStartedAt = null;
  sessionTheme = previewSavedTheme;
  sessionWaveColor = previewSavedWaveColor;
  previewSavedTheme = null;
  previewSavedWaveColor = null;
  clearVisualHistory();
  updatePreviewControls();
  updateConnectionLabel();
}

function updatePreviewControls(): void {
  if (syntheticPreviewButton === null) return;
  syntheticPreviewButton.textContent = previewActive ? "Stop synthetic preview" : "Start synthetic preview";
  syntheticPreviewButton.setAttribute("aria-pressed", String(previewActive));
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing required element #${id}.`);
  }

  return element as T;
}

function isTextInput(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

function eventDetail(event: Event): Record<string, unknown> {
  const detail: unknown = (event as CustomEvent<unknown>).detail;
  return typeof detail === "object" && detail !== null ? detail as Record<string, unknown> : {};
}

// Only live, non-stale metadata from an authenticated, connected source may name a song to save.
function syncSavableTrack(): void {
  const trustworthy = songConnection === "connected" && !songContext.stale && songContext.authenticationStatus === "valid";
  calibrationPanel.setCurrentTrack(trustworthy ? songContext.currentTrack : null);
}

// Spotify ID when present; otherwise normalized title and artists, so progress refreshes of one track compare equal.
function trackIdentity(track: CurrentTrack | null): string | null {
  if (track === null) return null;
  const id = typeof track.spotifyTrackId === "string" ? track.spotifyTrackId.trim() : "";
  if (id !== "") return `id:${id}`;
  const title = normalizedName(track.title);
  const artists = Array.isArray(track.artists)
    ? track.artists.map((artist) => normalizedName(artist?.name)).filter(Boolean).sort().join("|")
    : "";
  return title === "" && artists === "" ? null : `name:${title}\u0000${artists}`;
}

function normalizedName(value: unknown): string {
  return typeof value === "string" ? value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase() : "";
}

// Older WebViews only expose the deprecated listener pair.
function watchMediaQuery(query: MediaQueryList, listener: () => void): () => void {
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }
  query.addListener(listener);
  return () => query.removeListener(listener);
}
