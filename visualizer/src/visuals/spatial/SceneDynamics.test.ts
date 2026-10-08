import { describe, expect, it } from "vitest";
import { quietSpatialState } from "../../mappings/SpatialVisualState";
import { SceneDynamics } from "./SceneDynamics";
import { spatialQuality } from "./SpatialQuality";

function random(): () => number {
  let seed = 19;
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}
const active = { ...quietSpatialState,
  waves: { ...quietSpatialState.waves, energy: 0.6 },
  rain: { ...quietSpatialState.rain, energy: 1, impulse: 1 },
  glass: { ...quietSpatialState.glass, energy: 1, impulse: 1 },
};
describe("pooled spatial simulation", () => {
  it("poolCountsNeverExceedCapacity under active saturation", () => {
    const dynamics = new SceneDynamics({ maxRain: 8, maxGlass: 11 }, random());
    let snapshot = dynamics.update(active, 1 / 60);
    expect(snapshot.rainCount).toBeGreaterThan(0);
    expect(snapshot.glassCount).toBeGreaterThan(0);
    for (let i = 0; i < 1000; i++) {
      snapshot = dynamics.update(active, 1 / 60);
      expect(snapshot.rainCount).toBeLessThanOrEqual(8);
      expect(snapshot.glassCount).toBeLessThanOrEqual(11);
    }
  });
  it("silenceRetiresEveryParticle rather than spawning from residual energy", () => {
    const dynamics = new SceneDynamics({ maxRain: 8, maxGlass: 11 }, random());
    expect(dynamics.update(active, 0.1).glassCount).toBeGreaterThan(0);
    let snapshot = dynamics.update(quietSpatialState, 0.1);
    for (let i = 0; i < 150; i++) snapshot = dynamics.update(quietSpatialState, 0.1);
    expect([snapshot.rainCount, snapshot.glassCount]).toEqual([0, 0]);
  });
  it("clearRemovesPreviousSongTrails without replacing buffers", () => {
    const dynamics = new SceneDynamics({ maxRain: 8, maxGlass: 11 }, random());
    const old = dynamics.update(active, 0.1);
    expect(old.rainCount).toBeGreaterThan(0);
    const rain = old.rainPositions;
    dynamics.clear();
    const cleared = dynamics.update(quietSpatialState, 0.1);
    expect(cleared.rainPositions).toBe(rain);
    expect([cleared.rainCount, cleared.glassCount]).toEqual([0, 0]);
    expect([...cleared.rainPositions, ...cleared.glassPositions].every(v => v === 0)).toBe(true);
  });
  it.each([NaN, Infinity, -100, 0, 10000])("hugeOrNegativeDeltaStaysFinite %s", delta => {
    const dynamics = new SceneDynamics({ maxRain: 8, maxGlass: 11 }, () => NaN);
    const snapshot = dynamics.update(active, delta);
    expect([...snapshot.rainPositions, ...snapshot.glassPositions, ...snapshot.rainAges, ...snapshot.glassAges].every(Number.isFinite)).toBe(true);
    if (!Number.isFinite(delta) || delta <= 0) expect([snapshot.rainCount, snapshot.glassCount]).toEqual([0, 0]);
  });
  it("noAllocationGrowthOverTenMinutes: snapshot and every output buffer are reused", () => {
    const dynamics = new SceneDynamics(spatialQuality.normal, random());
    const first = dynamics.update(active, 1 / 60);
    const refs = [first.rainPositions, first.rainScales, first.rainAges, first.glassPositions, first.glassScales, first.glassAges];
    let last = first;
    for (let i = 0; i < 36000; i++) last = dynamics.update(i % 20 === 0 ? active : quietSpatialState, 1 / 60);
    expect(last).toBe(first);
    expect([last.rainPositions, last.rainScales, last.rainAges, last.glassPositions, last.glassScales, last.glassAges]).toEqual(refs);
    refs.forEach((ref, i) => expect([last.rainPositions, last.rainScales, last.rainAges, last.glassPositions, last.glassScales, last.glassAges][i]).toBe(ref));
    expect(last.rainCount).toBeLessThanOrEqual(96);
    expect(last.glassCount).toBeLessThanOrEqual(128);
    expect(last.glassCount).toBeGreaterThan(0);
  });
  it("seeded updates are deterministic and depth/stereo affect placement", () => {
    const a = new SceneDynamics({ maxRain: 8, maxGlass: 11 }, random()).update(active, 0.1);
    const b = new SceneDynamics({ maxRain: 8, maxGlass: 11 }, random()).update(active, 0.1);
    expect(a).toEqual(b);
    const shifted = new SceneDynamics({ maxRain: 8, maxGlass: 11 }, random()).update({ ...active, stereoBalance: 1, stereoWidth: 1, depth: 1 }, 0.1);
    expect(shifted.rainPositions[0]).not.toEqual(a.rainPositions[0]);
    expect(shifted.glassPositions[2]).not.toEqual(a.glassPositions[2]);
  });
  it.each([0, -1, 1.5, NaN, Infinity, 513])("rejects invalid capacity before allocating %s", capacity => {
    expect(() => new SceneDynamics({ maxRain: capacity, maxGlass: 11 })).toThrow(/capacity/i);
    expect(() => new SceneDynamics({ maxRain: 8, maxGlass: capacity })).toThrow(/capacity/i);
  });
  it("standard/low quality budgets are explicit and immutable", () => {
    expect(spatialQuality.normal).toEqual({ maxRain: 96, maxGlass: 128, waves: 3, pixelRatio: 1.5 });
    expect(spatialQuality.low).toEqual({ maxRain: 48, maxGlass: 64, waves: 3, pixelRatio: 1 });
    expect(Object.isFrozen(spatialQuality.normal)).toBe(true);
  });
});
