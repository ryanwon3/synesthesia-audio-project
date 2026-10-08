import { describe, expect, it } from "vitest";
import { previewFrame, type PreviewCase } from "./PreviewFixtures";

describe("development-only causal preview fixtures", () => {
  it("bass pulse contains low energy/attack and no mids or treble", () => {
    const frame = previewFrame("bass", 3.01);
    expect(frame.bassEnergy).toBeGreaterThan(0);
    expect(frame.bass?.attack).toBeGreaterThan(0);
    expect([frame.midEnergy, frame.trebleEnergy]).toEqual([0, 0]);
    expect(previewFrame("bass", 3.5).bass?.attack).toBe(0);
  });
  it("sustained mids have energy but no attack", () => {
    expect(previewFrame("mids", 3.5).midEnergy).toBeGreaterThan(0);
    expect(previewFrame("mids", 3.5).mid?.attack).toBe(0);
  });
  it("harmonic changes switch confident mid chroma without treble", () => {
    expect(previewFrame("harmonic", 0.5).mid?.chroma).not.toEqual(previewFrame("harmonic", 1.5).mid?.chroma);
    expect(previewFrame("harmonic", 0.5).mid?.chromaConfidence).toBeGreaterThanOrEqual(0.2);
    expect(previewFrame("harmonic", 0.5).trebleEnergy).toBe(0);
  });
  it("treble-only input does not pretend to be melody", () => {
    const frame = previewFrame("treble", 3.01);
    expect(frame.trebleEnergy).toBeGreaterThan(0);
    expect([frame.bassEnergy, frame.midEnergy]).toEqual([0, 0]);
  });
  it("mix and stereo have active features and stable normalized identities", () => {
    const frame = previewFrame("mix", 3.01);
    expect(frame.sequence).toBeGreaterThan(0);
    expect([frame.bassEnergy, frame.midEnergy, frame.trebleEnergy].every(value => value > 0)).toBe(true);
    expect(previewFrame("stereo", 0.5).stereoBalance).not.toBe(previewFrame("stereo", 1.5).stereoBalance);
  });
  it.each(["silence", "stale"] as PreviewCase[])("%s feeds the same silence path as production's stale-frame boundary", scenario => {
    expect(previewFrame(scenario, 3).rms).toBe(0);
    expect(previewFrame(scenario, 3).onsetStrength).toBe(0);
  });
  it("malformed fixture exercises nonfinite input explicitly", () => {
    expect(Number.isFinite(previewFrame("malformed", 3).rms)).toBe(false);
  });
});
