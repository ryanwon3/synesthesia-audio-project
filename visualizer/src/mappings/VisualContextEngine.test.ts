import { describe, expect, it } from "vitest";
import { silentAudioFrame } from "../audio/AudioFrame";
import { defaultSynesthesiaProfile } from "../profiles/SynesthesiaProfile";
import { VisualContextEngine } from "./VisualContextEngine";
import { testProfile } from "../profiles/profile.test-fixtures";
import { initialSongContext } from "../song/SongContext";

describe("VisualContextEngine", () => {
  it("restores personal-only remembered band colors after Mood mode when chroma confidence stays low", () => {
    const engine = new VisualContextEngine(); const profile = testProfile();
    const frame = { ...silentAudioFrame, rms: 0.2, midEnergy: 0.6, chromaConfidence: 1,
      chroma: { ...silentAudioFrame.chroma, c: 1 },
      mid: { attack: 0, chromaConfidence: 1, chroma: { ...silentAudioFrame.chroma, e: 1 } } };
    const original = structuredClone(engine.update(frame, profile, 10).layers[1].color);
    const low = { ...frame, mid: { ...frame.mid, chromaConfidence: 0 } };
    engine.update(low, { ...profile, colorMode: "mood" }, 10);
    const restored = engine.update(low, profile, 10).layers[1].color;
    restored.forEach((channel, index) => expect(channel).toBeCloseTo(original[index], 6));
  });
  it("smoothly applies tag atmosphere without changing personal pitch colors or creating sound from silence", () => {
    const profile = testProfile();
    const original = structuredClone(profile);
    const song = { ...initialSongContext, stale: false, lastFm: {
      status: "succeeded" as const, cacheSource: "fetched" as const,
      trackTags: [{ name: "synthwave", weight: 1 }], artistTags: [],
      matchedTrack: null, matchedArtist: null, trackMusicBrainzId: null, artistMusicBrainzId: null,
      matchQuality: null, retrievedAtUtc: null, errorCategory: null, nextRetryUtc: null } };
    const engine = new VisualContextEngine();
    const first = engine.update(silentAudioFrame, profile, 0.01, song);
    const initial = first.atmosphere?.shimmer ?? 0;
    const later = engine.update(silentAudioFrame, profile, 3, song);
    expect(initial).toBeGreaterThan(0.35);
    expect(later.atmosphere!.shimmer).toBeGreaterThan(initial);
    expect(later.spatial!.glass.impulse).toBe(0);
    expect(later.spatial!.rain.impulse).toBe(0);
    expect(profile).toEqual(original);
    const personal = new VisualContextEngine().update({ ...silentAudioFrame,
      chromaConfidence: 1, chroma: { ...silentAudioFrame.chroma, c: 1 } }, profile, 10, song);
    const untagged = new VisualContextEngine().update({ ...silentAudioFrame,
      chromaConfidence: 1, chroma: { ...silentAudioFrame.chroma, c: 1 } }, profile, 10);
    expect(personal.layers.map(layer => layer.color)).toEqual(untagged.layers.map(layer => layer.color));
  });
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
    const readNumbers = (value: unknown): number[] => typeof value === "number" ? [value] :
      value !== null && typeof value === "object" ? Object.values(value).flatMap(readNumbers) : [];
    const numbers = readNumbers(state);
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

  it("integrates normalized spatial cues without changing legacy profile values", () => {
    const profile = testProfile();
    const before = structuredClone(profile);
    const state = new VisualContextEngine().update({ ...silentAudioFrame, sequence: 1, rms: 0.2, midEnergy: 0.7 }, profile, 0.1);
    expect(state.spatial?.waves.energy).toBeGreaterThan(0);
    expect(state.spatial?.themeId).toBe("personal");
    expect(profile).toEqual(before);
  });
  it("manual bronze selection changes only the spatial wave tint", () => {
    const engine = new VisualContextEngine();
    const state = engine.update({ ...silentAudioFrame, sequence: 1, rms: 0.2, midEnergy: 0.7 }, testProfile(), 0.1,
      initialSongContext, "bronze-rain-glass");
    expect(state.spatial?.waves.color).toEqual([184 / 255, 134 / 255, 84 / 255]);
    expect(state.spatial?.rain.color).toEqual(state.layers[0].color);
    expect(state.spatial?.glass.color).toEqual(state.layers[2].color);
  });
  it("explicit stream reset drops spatial trigger history before resuming capture", () => {
    const engine = new VisualContextEngine();
    const frame = { ...silentAudioFrame, sequence: 1, rms: 0.2, bassEnergy: 1,
      bass: { attack: 1, chroma: silentAudioFrame.chroma, chromaConfidence: 0 } };
    expect(engine.update(frame, testProfile(), 0.1).spatial?.rain.impulse).toBeGreaterThan(0);
    engine.resetSpatialHistory();
    expect(engine.update({ ...frame, sequence: 2 }, testProfile(), 0.1).spatial?.rain.impulse).toBe(0);
  });
  it("nonfinite source values and delta cannot poison either renderer's normalized state", () => {
    const engine = new VisualContextEngine();
    const frame = { ...silentAudioFrame, sequence: 1, rms: NaN, midEnergy: Infinity,
      bassEnergy: NaN, trebleEnergy: -2, spectralCentroid: NaN, spectralFlux: Infinity,
      onsetStrength: NaN, stereoBalance: NaN, stereoWidth: Infinity };
    const readNumbers = (value: unknown): number[] => typeof value === "number" ? [value] :
      value !== null && typeof value === "object" ? Object.values(value).flatMap(readNumbers) : [];
    for (const delta of [NaN, Infinity, -1, 0.1]) {
      const state = engine.update(frame, testProfile(), delta);
      expect(readNumbers(state).every(value => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true);
    }
  });
});
