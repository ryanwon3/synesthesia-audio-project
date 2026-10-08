import { VisualContextEngine } from "../mappings/VisualContextEngine";
import type { SpatialThemeId } from "../profiles/SpatialProfile";
import { initialSongContext } from "../song/SongContext";
import { createVisualRenderer, type RendererMode } from "../visuals/RendererFactory";
import { RenderLoop } from "../visuals/RenderLoop";
import type { RenderOptions, VisualRenderer } from "../visuals/VisualRenderer";
import { SpatialEnvironment } from "../visuals/spatial/SpatialEnvironment";
import { EvolvingPainting } from "../visuals/EvolvingPainting";
import { previewFrame, previewProfile, type PreviewCase } from "./PreviewFixtures";

// Development entry only; no sockets, services, saved settings or private palette.
const canvas = document.querySelector<HTMLCanvasElement>("#preview")!;
const status = document.querySelector<HTMLOutputElement>("#status")!;
const renderMode = document.querySelector<HTMLSelectElement>("#renderer")!;
const quality = document.querySelector<HTMLSelectElement>("#quality")!;
const preset = document.querySelector<HTMLSelectElement>("#preset")!;
const colors = document.querySelector<HTMLSelectElement>("#mode")!;
const engine = new VisualContextEngine();
const profile = previewProfile();
profile.spatial!.songOverrides = [{ match: { spotifyTrackId: "syntheticTrackA", title: "Fixture A", artist: "Fixture artist" },
  themeId: "bronze-rain-glass", waveColor: "#b88654" }];
let renderer: VisualRenderer | null = null;
let loop: RenderLoop | null = null;
let generation = 0;
let activeMode: RendererMode | null = null;
let warning: string | null = null;
let metrics = "";
let scenario: PreviewCase = "mix";
let frames = 0;
let start = performance.now();
let origin = start;
let disposed = false;

document.querySelectorAll<HTMLButtonElement>("[data-case]").forEach(button => button.addEventListener("click", () => {
  if (disposed) return;
  scenario = button.dataset.case as PreviewCase;
  origin = performance.now(); engine.resetSpatialHistory();
  changeRenderer(); // Remove trails when changing controlled fixtures.
}));
colors.addEventListener("change", () => { if (!disposed) profile.colorMode = colors.value as "personal" | "mood"; });
renderMode.addEventListener("change", changeRenderer);
quality.addEventListener("change", changeRenderer);
window.addEventListener("resize", () => { if (!disposed) renderer?.resize(); });
document.addEventListener("visibilitychange", () => {
  if (!disposed) loop?.setHidden(document.hidden);
});
window.addEventListener("beforeunload", () => {
  if (disposed) return;
  disposed = true;
  releaseRenderer();
});

function changeRenderer(): void {
  if (disposed) return;
  releaseRenderer();
  warning = null;
  metrics = "";
  const token = ++generation;
  let constructing = true;
  const options: RenderOptions = {
    reducedMotion: false,
    onFailure: message => {
      if (disposed || token !== generation) return;
      warning = message;
      if (!constructing) {
        loop?.dispose();
        loop = null;
      }
      updateStatus();
    },
  };
  const selectedQuality = quality.value === "low" ? "low" : "normal";
  class PreviewSpatial extends SpatialEnvironment {
    public constructor(surface: HTMLCanvasElement, renderOptions: typeof options) { super(surface, renderOptions, selectedQuality); }
  }
  const requested: RendererMode = renderMode.value === "painting" ? "painting" : "spatial";
  try {
    renderer = createVisualRenderer(canvas, requested, options, { painting: EvolvingPainting, spatial: PreviewSpatial });
    activeMode = requested === "spatial" && warning !== null ? "painting" : requested;
    renderMode.value = activeMode;
  } catch {
    activeMode = null;
    warning ??= "WebGL rendering is unavailable.";
    updateStatus();
    return;
  } finally {
    constructing = false;
  }
  engine.resetSpatialHistory();
  start = performance.now();
  frames = 0;
  loop = new RenderLoop({ requestFrame: callback => requestAnimationFrame(callback), cancelFrame: handle => cancelAnimationFrame(handle) },
    render, () => {
      engine.resetSpatialHistory();
      renderer?.clear();
      start = performance.now();
      frames = 0;
    }, () => options.onFailure("Rendering stopped after an unexpected error."));
  loop.setHidden(document.hidden);
  loop.start();
  updateStatus();
}
function releaseRenderer(): void {
  generation++;
  loop?.dispose();
  loop = null;
  const previous = renderer;
  renderer = null;
  activeMode = null;
  previous?.dispose();
}
function updateStatus(): void {
  if (disposed) return;
  status.textContent = [warning, activeMode ?? "stopped", metrics].filter(Boolean).join(" · ");
}
function render(now: number, delta: number): void {
  if (disposed || document.hidden || renderer === null) return;
  const seconds = (now - origin) / 1000;
  const frame = previewFrame(scenario, seconds);
  const song = scenario === "song-switch" ? { ...initialSongContext, currentTrack: {
    spotifyTrackId: Math.floor(seconds / 5) % 2 === 0 ? "syntheticTrackA" : "syntheticTrackB",
    title: "Fixture", artists: [{ spotifyArtistId: null, name: "Fixture artist" }], spotifyUri: null,
    isrc: null, album: null, durationMs: null, explicit: null, progressMs: null, isPlaying: true, observedAtUtc: "2026-10-08T00:00:00Z",
  } } : initialSongContext;
  const theme: SpatialThemeId | null = scenario === "song-switch" ? null : preset.value as SpatialThemeId;
  const state = engine.update(frame, profile, delta, song, theme);
  renderer.render(state, delta);
  frames++;
  if (now - start > 1000) {
    metrics = `${scenario} · ${state.spatial?.themeId} · ${(frames * 1000 / (now - start)).toFixed(1)} FPS (prototype only) · ${innerWidth} × ${innerHeight}`;
    updateStatus();
    frames = 0; start = now;
  }
}
changeRenderer();
