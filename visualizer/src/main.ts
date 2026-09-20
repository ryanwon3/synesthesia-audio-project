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
import { VisualContextEngine } from "./mappings/VisualContextEngine";
import type { VisualState } from "./mappings/VisualState";
import { loadSynesthesiaProfile, type SynesthesiaProfile } from "./profiles/SynesthesiaProfile";
import { SongContextClient, type SongContextConnectionState } from "./song/SongContextClient";
import { initialSongContext, type SongContextSnapshot } from "./song/SongContext";
import { CalibrationPanel } from "./ui/CalibrationPanel";
import { DebugOverlay } from "./ui/DebugOverlay";
import { EvolvingPainting } from "./visuals/EvolvingPainting";

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
const webglError = requiredElement<HTMLElement>("webgl-error");

let profile: SynesthesiaProfile = loadSynesthesiaProfile();
let latestFrame: AudioFrame = silentAudioFrame;
let visualState: VisualState;
let connection: AudioFrameClientStatus = {
  state: "disconnected",
  messagesPerSecond: 0,
  lastReceiveAt: 0,
};
let lastFrameAt = 0;
let calibrationOpen = false;
let animationFrame = 0;
let painting: EvolvingPainting;
let songContext: SongContextSnapshot = initialSongContext;
let songConnection: SongContextConnectionState = "disconnected";

const contextEngine = new VisualContextEngine();
visualState = contextEngine.update(latestFrame, profile, 1);
const debugOverlay = new DebugOverlay(debugElement, requestLastFmSetup, requestOpenAiSetup, () => {
  const host = (window as Window & { chrome?: { webview?: { postMessage(message: unknown): void } } }).chrome?.webview;
  host?.postMessage({ protocolVersion: 1, type: "reanalyzeLyrics" });
});
const calibrationPanel = new CalibrationPanel(
  calibrationElement,
  profile,
  (updatedProfile) => {
    profile = updatedProfile;
    visualState = contextEngine.update(latestFrame, profile, 0.5, songContext);
    window.queueMicrotask(refreshIcons);
  },
  () => setCalibrationOpen(false),
);

const socketUrl = new URLSearchParams(window.location.search).get("ws") ??
  "ws://127.0.0.1:8765/audio";
const audioClient = new AudioFrameClient(socketUrl);
const songSocketUrl = new URLSearchParams(window.location.search).get("songWs") ??
  "ws://127.0.0.1:8765/song-context";
const songClient = new SongContextClient(songSocketUrl);
audioClient.onFrame((frame) => {
  const now = performance.now();
  latestFrame = frame;
  lastFrameAt = now;
});
audioClient.onStatus((status) => {
  connection = status;
  connectionStatus.dataset.state = status.state;
  connectionLabel.textContent = status.state === "connected"
    ? status.lastReceiveAt > 0 ? "Audio live" : "Waiting for Spotify"
    : status.state === "connecting"
      ? "Connecting"
      : "Backend offline";
});
songClient.onSnapshot((snapshot) => {
  songContext = snapshot;
  updateSpotifyButton();
});
songClient.onStatus((status) => {
  songConnection = status;
  updateSpotifyButton();
});

calibrationToggle.addEventListener("click", () => setCalibrationOpen(!calibrationOpen));
debugToggle.addEventListener("click", () => debugOverlay.toggle());
fullscreenToggle.addEventListener("click", () => void toggleFullscreen());
spotifyConnect.addEventListener("click", handleSpotifyConnect);
spotifyForm.addEventListener("submit", handleSpotifySubmit);
spotifyDialog.querySelector<HTMLElement>("[data-close-dialog]")?.addEventListener("click", () => spotifyDialog.close());
document.addEventListener("fullscreenchange", updateFullscreenIcon);
window.addEventListener("resize", () => painting?.resize());
window.addEventListener("keydown", (event) => {
  if (event.key.toLowerCase() === "d" && !isTextInput(event.target)) {
    debugOverlay.toggle();
  }

  if (event.key === "Escape" && calibrationOpen) {
    setCalibrationOpen(false);
  }
});
window.addEventListener("beforeunload", () => {
  window.cancelAnimationFrame(animationFrame);
  audioClient.stop();
  songClient.stop();
  painting?.dispose();
});

try {
  painting = new EvolvingPainting(canvas);
  startRenderLoop();
  audioClient.start();
  songClient.start();
} catch (error) {
  console.error(error);
  webglError.hidden = false;
  connectionStatus.hidden = true;
}

refreshIcons();
updateSpotifyButton();

function startRenderLoop(): void {
  let prior = performance.now();
  let fpsWindowStart = prior;
  let renderedFrames = 0;
  let fps = 0;
  let lastDebugUpdate = 0;

  const render = (timestamp: number) => {
    const delta = Math.min((timestamp - prior) / 1000, 0.1);
    prior = timestamp;

    visualState = contextEngine.update(lastFrameAt === 0 || timestamp - lastFrameAt > 500 ? silentAudioFrame : latestFrame,
      profile, delta, songContext);

    painting.render(visualState, delta);
    renderedFrames += 1;
    if (timestamp - fpsWindowStart >= 1000) {
      fps = renderedFrames * 1000 / (timestamp - fpsWindowStart);
      renderedFrames = 0;
      fpsWindowStart = timestamp;
    }

    if (timestamp - lastDebugUpdate >= 250) {
      debugOverlay.update(latestFrame, visualState, connection, fps, songContext);
      lastDebugUpdate = timestamp;
    }

    animationFrame = window.requestAnimationFrame(render);
  };

  animationFrame = window.requestAnimationFrame(render);
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

function handleSpotifyConnect(): void {
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
  spotifyConnect.disabled = status === "authorizing";
  spotifyConnect.title = songConnection !== "connected"
    ? "Spotify metadata offline"
    : status === "valid"
      ? "Spotify connected"
      : status === "reauthorizationRequired"
        ? "Reconnect Spotify"
        : "Connect Spotify";
  spotifyConnect.setAttribute("aria-label", spotifyConnect.title);
}

function requestLastFmSetup(): void {
  const host = (window as Window & {
    chrome?: { webview?: { postMessage(message: unknown): void } };
  }).chrome?.webview;
  host?.postMessage({ protocolVersion: 1, type: "openLastFmSetup" });
}

function requestOpenAiSetup(): void {
  const host = (window as Window & {
    chrome?: { webview?: { postMessage(message: unknown): void } };
  }).chrome?.webview;
  host?.postMessage({ protocolVersion: 1, type: "openOpenAiSetup" });
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
