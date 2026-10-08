import { silentAudioFrame, type AudioFrame } from "../audio/AudioFrame";
import type { SynesthesiaProfile } from "../profiles/SynesthesiaProfile";
import { defaultSpatialPreferences } from "../profiles/SpatialProfile";

export type PreviewCase = "silence" | "bass" | "mids" | "harmonic" | "treble" | "mix" | "stereo" | "malformed" | "stale" | "song-switch";
export function previewFrame(scenario: PreviewCase, seconds: number): AudioFrame {
  const t = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  if (scenario === "silence" || scenario === "stale") return structuredClone(silentAudioFrame);
  if (scenario === "malformed") return { ...structuredClone(silentAudioFrame), sequence: 1, rms: NaN, midEnergy: Infinity, onsetStrength: NaN };
  const all = scenario === "mix" || scenario === "stereo" || scenario === "song-switch";
  const pulse = t % 1.5 < 0.12 ? 0.95 : 0;
  const bass = scenario === "bass" || all ? 0.42 + pulse * 0.35 : 0;
  const mid = scenario === "mids" || scenario === "harmonic" || all ? 0.6 : 0;
  const treble = scenario === "treble" || all ? 0.45 : 0;
  const harmonic = scenario === "harmonic" || all;
  const chroma = { ...silentAudioFrame.chroma, [harmonic && Math.floor(t / 1.2) % 2 ? "e" : "c"]: 1 };
  return { ...silentAudioFrame, sequence: Math.floor(t * 30) + 1, rms: 0.2,
    bassEnergy: bass, midEnergy: mid, trebleEnergy: treble, chroma, chromaConfidence: 0.8,
    onsetStrength: pulse, spectralCentroid: treble, stereoBalance: scenario === "stereo" ? 0.5 + Math.sin(t) * 0.45 : 0.5,
    stereoWidth: scenario === "stereo" ? 1 : 0.35,
    bass: { chroma, chromaConfidence: 0.8, attack: bass > 0 ? pulse : 0 },
    mid: { chroma, chromaConfidence: 0.8, attack: 0 },
    treble: { chroma, chromaConfidence: 0.8, attack: treble > 0 ? pulse : 0 } };
}

// Public synthetic palette: never read localStorage or import the private bundled profile.
export function previewProfile(): SynesthesiaProfile {
  return { schemaVersion: 1, name: "Synthetic visual verification",
    pitchColors: { C: "#567f96", CSharp: "#627cbb", D: "#7895bd", DSharp: "#7a6ca8",
      E: "#a7b8d1", F: "#668e82", FSharp: "#6b999a", G: "#699bbd", GSharp: "#7b8abb",
      A: "#98aaca", ASharp: "#b5bdca", B: "#768da3" },
    response: { bassDeformation: 0.5, midStructure: 0.5, trebleParticles: 0.5, transientImpulse: 0.6,
      persistence: 0.6, movement: 0.4, sharpness: 0.4, softness: 0.6, depth: 0.6, smoothing: 0.3,
      attackMs: 100, releaseMs: 600 }, colorMode: "personal", spatial: defaultSpatialPreferences() };
}
