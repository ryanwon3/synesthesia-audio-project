import { describe, expect, it } from "vitest";
import { silentAudioFrame, type AudioFrame } from "../audio/AudioFrame";
import { defaultSpatialPreferences, resolveSpatialTheme } from "../profiles/SpatialProfile";
import { testProfile } from "../profiles/profile.test-fixtures";
import { calmVisualState, type VisualState } from "./VisualState";
import { SpatialContextEngine, spatialTriggerDefaults } from "./SpatialContextEngine";

const prefs = defaultSpatialPreferences();
const theme = resolveSpatialTheme(testProfile(), null, null);
const mapped: VisualState = { ...structuredClone(calmVisualState), layers: [
  { ...calmVisualState.layers[0], color: [0.8, 0.1, 0.2] },
  { ...calmVisualState.layers[1], color: [0.2, 0.7, 0.3] },
  { ...calmVisualState.layers[2], color: [0.1, 0.3, 0.9] },
] };
const band = (attack: number, key: "c" | "e" = "c", confidence = 1) => ({
  attack, chromaConfidence: confidence, chroma: { ...silentAudioFrame.chroma, [key]: 1 },
});
const frame = (values: Partial<AudioFrame> = {}): AudioFrame => ({
  ...structuredClone(silentAudioFrame), rms: 0.2, sequence: 1, ...values,
});
function bounded(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 && value <= 1;
  if (typeof value === "string") return true;
  return value !== null && typeof value === "object" && Object.values(value).every(bounded);
}

describe("distinct feature-driven spatial cues", () => {
  it("treble drives glass-edge shimmer and tags modulate texture without swapping cue families", () => {
    const electronic = { ...mapped, atmosphere: { warmth: 0.3, haze: 0.1, shimmer: 0.9, distortion: 0.9 } };
    const ambient = { ...mapped, atmosphere: { warmth: 0.5, haze: 0.9, shimmer: 0.2, distortion: 0.1 } };
    const bright = frame({ midEnergy: 0.6, trebleEnergy: 0.7 });
    const sharp = new SpatialContextEngine().update(bright, electronic, prefs, theme, 0.1);
    const soft = new SpatialContextEngine().update(bright, ambient, prefs, theme, 0.1);
    expect(sharp.glass.shimmer).toBeGreaterThan(soft.glass.shimmer!);
    expect(sharp.waves.distortion).toBeGreaterThan(soft.waves.distortion!);
    expect(soft.haze).toBeGreaterThan(sharp.haze!);
    expect(sharp.rain.impulse).toBe(0);
    expect(sharp.glass.impulse).toBe(0);
    const silence = new SpatialContextEngine().update(silentAudioFrame, electronic, prefs, theme, 0.1);
    expect(silence.glass.shimmer).toBe(0);
    expect(silence.waves.distortion).toBe(0);
  });
  it("bassAttackDrivesRainNotWaves", () => {
    const state = new SpatialContextEngine().update(frame({ bassEnergy: 0.8, bass: band(0.9) }), mapped, prefs, theme, 0.1);
    expect(state.rain.impulse).toBeGreaterThan(0.4);
    expect(state.rain.energy).toBeGreaterThan(0);
    expect(state.waves.energy).toBe(0);
    expect(state.glass.impulse).toBe(0);
  });
  it("legacy bass fallback uses onset multiplied by low energy", () => {
    const state = new SpatialContextEngine().update(frame({ bassEnergy: 0.8, onsetStrength: 0.8 }), mapped, prefs, theme, 0.1);
    expect(state.rain.impulse).toBeGreaterThan(0.3);
    const treble = new SpatialContextEngine().update(frame({ trebleEnergy: 1, onsetStrength: 1 }), mapped, prefs, theme, 0.1);
    expect(treble.rain.impulse).toBe(0);
    expect(treble.glass.impulse).toBe(0);
  });
  it("sustainedMidEnergyDrivesWaves without requiring attacks", () => {
    const engine = new SpatialContextEngine();
    let state = engine.update(frame({ midEnergy: 0.6 }), mapped, prefs, theme, 0.1);
    for (let i = 0; i < 10; i++) state = engine.update(frame({ midEnergy: 0.6 }), mapped, prefs, theme, 0.1);
    expect(state.waves.energy).toBeGreaterThan(0.2);
    expect(state.rain.impulse).toBe(0);
    expect(state.glass.impulse).toBe(0);
  });
  it("harmonicChangeDrivesGlassApproximation, not treble energy", () => {
    const engine = new SpatialContextEngine();
    const initial = engine.update(frame({ midEnergy: 0.7, mid: band(0) }), mapped, prefs, theme, 0.1);
    expect(initial.glass.impulse).toBe(0);
    const changed = engine.update(frame({ sequence: 2, midEnergy: 0.7, mid: band(0, "e") }), mapped, prefs, theme, 0.1);
    expect(changed.glass.impulse).toBeGreaterThan(0.2);
    expect(changed.rain.impulse).toBe(0);
    expect(new SpatialContextEngine().update(frame({ trebleEnergy: 1, treble: band(1) }), mapped, prefs, theme, 0.1).glass.impulse).toBe(0);
  });
  it("confident mid attacks can initiate glass without false instrument detection", () => {
    expect(new SpatialContextEngine().update(frame({ midEnergy: 0.6, mid: band(0.8) }), mapped, prefs, theme, 0.1).glass.impulse).toBeGreaterThan(0);
  });
  it("lowConfidenceDoesNotEmitGlass, including large harmonic changes", () => {
    const engine = new SpatialContextEngine();
    engine.update(frame({ midEnergy: 1, mid: band(0) }), mapped, prefs, theme, 0.1);
    expect(engine.update(frame({ sequence: 2, midEnergy: 1, mid: band(1, "e", 0.1) }), mapped, prefs, theme, 0.1).glass.impulse).toBe(0);
  });
  it("global harmonic fallback remains confidence-gated and requires mids", () => {
    const engine = new SpatialContextEngine();
    engine.update(frame({ midEnergy: 1, chromaConfidence: 1, chroma: band(0).chroma }), mapped, prefs, theme, 0.1);
    expect(engine.update(frame({ sequence: 2, midEnergy: 1, chromaConfidence: 1, chroma: band(0, "e").chroma }), mapped, prefs, theme, 0.1).glass.impulse).toBeGreaterThan(0);
  });
  it("contextCannotExchangeFamilies or create impulses from silence", () => {
    const semantic = structuredClone(mapped);
    semantic.layers.forEach(layer => { layer.energy = 1; layer.attack = 1; layer.effects = [0, 0, 0, 0, 1]; });
    semantic.impulseStrength = 1;
    const state = new SpatialContextEngine().update(frame({ bassEnergy: 0.6, bass: band(1) }), semantic, prefs, theme, 0.1);
    expect(state.rain.impulse).toBeGreaterThan(0);
    expect(state.glass.impulse).toBe(0);
    expect(state.waves.energy).toBe(0);
    const quiet = new SpatialContextEngine().update(silentAudioFrame, semantic, prefs, theme, 0.1);
    expect([quiet.waves.energy, quiet.rain.energy, quiet.rain.impulse, quiet.glass.energy, quiet.glass.impulse]).toEqual([0, 0, 0, 0, 0]);
  });
  it("silenceAndStaleInputDecay and reestablish a harmonic baseline", () => {
    const engine = new SpatialContextEngine();
    engine.update(frame({ midEnergy: 0.7, mid: band(0) }), mapped, prefs, theme, 0.1);
    let state;
    for (let i = 0; i < 100; i++) state = engine.update(silentAudioFrame, mapped, prefs, theme, 0.1);
    expect(state!.waves.energy).toBeLessThan(0.0001);
    expect(state!.rain.impulse).toBe(0);
    expect(state!.glass.impulse).toBe(0);
    expect(engine.update(frame({ sequence: 2, midEnergy: 0.7, mid: band(0, "e") }), mapped, prefs, theme, 0.1).glass.impulse).toBe(0);
  });
  it("sustainedAttackDoesNotRetriggerEveryFrame or on duplicated render frames", () => {
    const engine = new SpatialContextEngine();
    const hit = frame({ bassEnergy: 1, midEnergy: 1, bass: band(1), mid: band(1) });
    expect(engine.update(hit, mapped, prefs, theme, 0.1).rain.impulse).toBeGreaterThan(0);
    for (let i = 0; i < 30; i++) {
      const state = engine.update({ ...hit, sequence: i + 2 }, mapped, prefs, theme, 0.1);
      expect([state.rain.impulse, state.glass.impulse]).toEqual([0, 0]);
    }
    const duplicateEngine = new SpatialContextEngine();
    duplicateEngine.update(hit, mapped, prefs, theme, 0.1);
    expect(duplicateEngine.update(hit, mapped, prefs, theme, 0.1).rain.impulse).toBe(0);
  });
  it("rain rearms after a low attack and respects the refractory period", () => {
    const engine = new SpatialContextEngine();
    engine.update(frame({ bassEnergy: 1, bass: band(1) }), mapped, prefs, theme, 0.01);
    engine.update(frame({ sequence: 2, bassEnergy: 1, bass: band(0) }), mapped, prefs, theme, 0.01);
    expect(engine.update(frame({ sequence: 3, bassEnergy: 1, bass: band(1) }), mapped, prefs, theme, 0.01).rain.impulse).toBe(0);
    engine.update(frame({ sequence: 4, bassEnergy: 1, bass: band(0) }), mapped, prefs, theme, 0.1);
    expect(engine.update(frame({ sequence: 5, bassEnergy: 1, bass: band(1) }), mapped, prefs, theme, 0.1).rain.impulse).toBeGreaterThan(0);
  });
  it("a sub-threshold rising attack does not consume the armed rain or glass edge", () => {
    const engine = new SpatialContextEngine();
    engine.update(frame({ bassEnergy: 1, midEnergy: 1, bass: band(0), mid: band(0) }), mapped, prefs, theme, 0.1);
    engine.update(frame({ sequence: 2, bassEnergy: 1, midEnergy: 1, bass: band(0.15), mid: band(0.15) }), mapped, prefs, theme, 0.1);
    const hit = engine.update(frame({ sequence: 3, bassEnergy: 1, midEnergy: 1, bass: band(0.8), mid: band(0.8) }), mapped, prefs, theme, 0.1);
    expect(hit.rain.impulse).toBeGreaterThan(0);
    expect(hit.glass.impulse).toBeGreaterThan(0);
  });
  it("glass harmonic changes inside refractory period cannot emit a catch-up burst", () => {
    const engine = new SpatialContextEngine();
    engine.update(frame({ midEnergy: 1, mid: band(0) }), mapped, prefs, theme, 0.01);
    expect(engine.update(frame({ sequence: 2, midEnergy: 1, mid: band(0, "e") }), mapped, prefs, theme, 0.01).glass.impulse).toBeGreaterThan(0);
    expect(engine.update(frame({ sequence: 3, midEnergy: 1, mid: band(0) }), mapped, prefs, theme, 0.01).glass.impulse).toBe(0);
    expect(engine.update(frame({ sequence: 3, midEnergy: 1, mid: band(0) }), mapped, prefs, theme, 0.1).glass.impulse).toBe(0);
  });
  it("explicitBronzeOnlyOverridesWaveColor", () => {
    const state = new SpatialContextEngine().update(frame({ midEnergy: 1 }), mapped, prefs,
      resolveSpatialTheme(testProfile(), null, "bronze-rain-glass"), 0.1);
    expect(state.waves.color).toEqual([184 / 255, 134 / 255, 84 / 255]);
    expect(state.rain.color).toEqual(mapped.layers[0].color);
    expect(state.glass.color).toEqual(mapped.layers[2].color);
    expect(new SpatialContextEngine().update(frame(), mapped, prefs, theme, 0.1).waves.color).toEqual(mapped.layers[1].color);
  });
  it.each([NaN, Infinity, -0.1, 1.1])("rejectsNonFiniteControls or out-of-range preferences %s", value => {
    expect(() => new SpatialContextEngine().update(frame(), mapped, { ...prefs, depth: value }, theme, 0.1)).toThrow(/spatial preferences/i);
  });
  it.each([NaN, Infinity, -3, 10000])("bad delta and malformed feature/color inputs stay bounded %s", delta => {
    const invalid = structuredClone(mapped);
    invalid.layers[0].color = [NaN, Infinity, -1];
    invalid.layers[1].softness = NaN;
    const state = new SpatialContextEngine().update(frame({ rms: NaN, bassEnergy: Infinity, midEnergy: NaN,
      stereoBalance: NaN, stereoWidth: Infinity }), invalid, prefs, theme, delta);
    expect(bounded(state)).toBe(true);
  });
  it("a source reset or sequence restart establishes baseline without a stale burst", () => {
    const engine = new SpatialContextEngine();
    const hit = frame({ sequence: 9, bassEnergy: 1, midEnergy: 1, bass: band(1), mid: band(1) });
    engine.update(hit, mapped, prefs, theme, 0.1);
    engine.reset();
    expect(engine.update(hit, mapped, prefs, theme, 0.1).rain.impulse).toBe(0);
    expect(engine.update({ ...hit, sequence: 1 }, mapped, prefs, theme, 0.1).glass.impulse).toBe(0);
  });
  it("zero family strengths disable those cues without mutating preference data", () => {
    const disabled = { ...prefs, waveStrength: 0, rainStrength: 0, glassStrength: 0 };
    const original = structuredClone(disabled);
    const state = new SpatialContextEngine().update(frame({ bassEnergy: 1, midEnergy: 1, bass: band(1), mid: band(1) }), mapped, disabled, theme, 0.1);
    expect([state.waves.energy, state.rain.energy, state.rain.impulse, state.glass.energy, state.glass.impulse]).toEqual([0, 0, 0, 0, 0]);
    expect(disabled).toEqual(original);
  });
  it("starting trigger values are explicit configuration, not DSP promises", () => {
    expect(spatialTriggerDefaults).toEqual({ confidenceGate: 0.2, chromaChangeThreshold: 0.25,
      rainMinimumImpulse: 0.2, rainRefractorySeconds: 0.12, glassRefractorySeconds: 0.16 });
  });
});
