import { describe, expect, it } from "vitest";
import { silentAudioFrame } from "../audio/AudioFrame";
import { defaultSynesthesiaProfile } from "../profiles/SynesthesiaProfile";
import { VisualContextEngine } from "./VisualContextEngine";

describe("VisualContextEngine", () => {
  it("keeps all normalized visual values finite and bounded", () => {
    const engine = new VisualContextEngine();
    const profile = defaultSynesthesiaProfile();
    const frame = {
      ...silentAudioFrame,
      rms: 0.9,
      bassEnergy: 0.8,
      midEnergy: 0.7,
      trebleEnergy: 0.6,
      spectralCentroid: 0.9,
      spectralFlux: 0.8,
      onsetStrength: 1,
      stereoBalance: 0.75,
      stereoWidth: 0.5,
      chroma: { ...silentAudioFrame.chroma, a: 1 },
      dominantPitchClass: "A" as const,
      chromaConfidence: 1,
    };

    const state = engine.update(frame, profile, 1);
    const numbers = Object.entries(state).filter(([key]) => key !== "layers").flatMap(([, value]) => typeof value === "number" ? [value] : [...value] as number[]);
    expect(numbers.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true);
  });

  it("derives dominant color from the personal pitch mapping", () => {
    const engine = new VisualContextEngine();
    const profile = defaultSynesthesiaProfile();
    profile.pitchColors.A = "#ff0000";
    const frame = {
      ...silentAudioFrame,
      chroma: { ...silentAudioFrame.chroma, a: 1 },
      dominantPitchClass: "A" as const,
      chromaConfidence: 1,
    };

    const state = engine.update(frame, profile, 10);
    expect(state.primaryColor[0]).toBeGreaterThan(0.99);
    expect(state.primaryColor[1]).toBeLessThan(0.01);
    expect(state.primaryColor[2]).toBeLessThan(0.01);
  });
});
