import { silentAudioFrame } from "../audio/AudioFrame";
import { VisualContextEngine } from "../mappings/VisualContextEngine";
import { defaultSynesthesiaProfile } from "../profiles/SynesthesiaProfile";
import { initialSongContext } from "../song/SongContext";
import { EvolvingPainting } from "../visuals/EvolvingPainting";

// Development-only visual fixture. Not an input to the production bundle.
const painting = new EvolvingPainting(document.querySelector<HTMLCanvasElement>("#preview")!);
const engine = new VisualContextEngine(), profile = defaultSynesthesiaProfile(); profile.colorMode = "mood";
let scenario = "sad", frames = 0, start = performance.now(), prior = start;
document.querySelectorAll<HTMLButtonElement>("[data-case]").forEach(button => button.addEventListener("click", () => { scenario = button.dataset.case!; }));
document.querySelector<HTMLSelectElement>("#mode")!.addEventListener("change", event => {
  profile.colorMode = (event.target as HTMLSelectElement).value as "personal" | "mood";
});
window.addEventListener("resize", () => painting.resize());
function render(now: number): void {
  const t = now / 1000, pulse = t % 1.5 < 0.08 ? 0.95 : 0;
  const bass = scenario === "sad" ? 0.32 + pulse * 0.4 : 0;
  const mid = scenario === "dreamy" ? 0.4 : 0;
  const treble = scenario === "tense" ? 0.4 : 0;
  const chroma = { ...silentAudioFrame.chroma, a: Math.sin(t * 0.4) * 0.5 + 0.5, c: 0.5 - Math.sin(t * 0.4) * 0.5 };
  const frame = { ...silentAudioFrame, rms: bass + mid + treble, bassEnergy: bass, midEnergy: mid, trebleEnergy: treble, chroma,
    chromaConfidence: 0.8, onsetStrength: pulse, spectralCentroid: treble * 2,
    bass: { chroma, chromaConfidence: 0.8, attack: bass > 0 ? pulse : 0 },
    mid: { chroma, chromaConfidence: 0.8, attack: 0 }, treble: { chroma, chromaConfidence: 0.8, attack: treble > 0 ? pulse : 0 } };
  const song: typeof initialSongContext = { ...initialSongContext, lastFm: { status: "succeeded", cacheSource: "cached",
    trackTags: [{ name: scenario, weight: 1 }], artistTags: [], matchedTrack: null, matchedArtist: null,
    trackMusicBrainzId: null, artistMusicBrainzId: null, matchQuality: null, retrievedAtUtc: null, errorCategory: null, nextRetryUtc: null } };
  const delta = Math.min(0.1, (now - prior) / 1000); prior = now;
  const state = engine.update(frame, profile, delta, song); painting.render(state, delta);
  frames++;
  if (now - start > 1000) {
    document.querySelector("#status")!.textContent = `${scenario} · ${(frames * 1000 / (now - start)).toFixed(1)} FPS · ${innerWidth} × ${innerHeight} · bass ${state.layers[0].energy.toFixed(2)} / mid ${state.layers[1].energy.toFixed(2)} / treble ${state.layers[2].energy.toFixed(2)}`;
    frames = 0; start = now;
  }
  requestAnimationFrame(render);
}
requestAnimationFrame(render);
