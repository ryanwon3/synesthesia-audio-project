import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { calmVisualState, type VisualState } from "../mappings/VisualState";
import { quietSpatialState, type SpatialVisualState } from "../mappings/SpatialVisualState";
import { EvolvingPainting } from "./EvolvingPainting";
import { SceneDynamics } from "./spatial/SceneDynamics";
import { SpatialEnvironment } from "./spatial/SpatialEnvironment";
import type { RenderOptions, VisualRenderer } from "./VisualRenderer";

// Controlled WebGL transport: real Three scenes/materials/instances, no GPU appearance.
const calls = vi.hoisted(() => ({ render: vi.fn(), dispose: vi.fn(), wipe: vi.fn(), target: vi.fn(), size: vi.fn() }));
vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();
  class Renderer {
    public outputColorSpace: unknown;
    public extensions = { has: (): boolean => false };
    public setPixelRatio = (): void => undefined;
    public setClearColor = (): void => undefined;
    public setSize = calls.size;
    public getDrawingBufferSize = (out: { set(x: number, y: number): unknown }): unknown => out.set(64, 36);
    public setRenderTarget = calls.target;
    public clear = calls.wipe;
    public render = calls.render;
    public dispose = calls.dispose;
  }
  return { ...actual, WebGLRenderer: Renderer };
});

type Control = "setLayerPreview" | "setReducedMotion" | "clear";
type PaintingCtor = new (canvas: HTMLCanvasElement, options: RenderOptions) => VisualRenderer;
const canvas = (): HTMLCanvasElement => Object.assign(new EventTarget(), { clientWidth: 640, clientHeight: 360 }) as HTMLCanvasElement;
const options = (reducedMotion = false): RenderOptions => ({ reducedMotion, onFailure: vi.fn() });
const painting = (reducedMotion = false): VisualRenderer => new (EvolvingPainting as unknown as PaintingCtor)(canvas(), options(reducedMotion));
// Guarded lookup keeps RED a missing-method assertion rather than a type/import error.
const control = (target: object, name: Control) => {
  const method: unknown = Reflect.get(target, name);
  expect(method, `${target.constructor.name}.${name}()`).toBeTypeOf("function");
  return (...args: unknown[]): unknown => (method as (...values: unknown[]) => unknown).apply(target, args);
};
const frozen = <T>(value: T): T => {
  if (value && typeof value === "object") { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
};
const bandLayer = (energy: number): VisualState["layers"][number] => ({ color: [0.5, 0.4, 0.3], energy, attack: 0.5,
  softness: 0.4, effects: [1, 0.2, 0.3, 0.4, 0.7] });
const banded = (): VisualState => structuredClone({ ...calmVisualState,
  layers: [bandLayer(0.6), bandLayer(0.5), bandLayer(0.4)] });
const busy = (): SpatialVisualState => structuredClone({ ...quietSpatialState,
  waves: { ...quietSpatialState.waves, energy: 0.7 },
  rain: { ...quietSpatialState.rain, energy: 1, impulse: 1 },
  glass: { ...quietSpatialState.glass, energy: 1, impulse: 1 } });
const uniformsWith = (name: string): Record<string, THREE.IUniform> => {
  for (const [scene] of [...calls.render.mock.calls].reverse()) {
    const material = ((scene as THREE.Scene).children[0] as THREE.Mesh).material as THREE.ShaderMaterial | undefined;
    if (material?.uniforms && name in material.uniforms) return material.uniforms;
  }
  throw new Error(`No rendered material exposes ${name}.`);
};
const ripplesOf = (): THREE.Vector4[] => uniformsWith("uRipples").uRipples.value as THREE.Vector4[];
const spatialLayers = () => {
  const [scene, camera] = calls.render.mock.lastCall! as [THREE.Scene, THREE.PerspectiveCamera];
  const groups = scene.children.filter((child) => child instanceof THREE.Group);
  const rain = groups.find((group) => group.children.some((child) => child instanceof THREE.InstancedMesh))!;
  const waves = groups.find((group) => group !== rain)!;
  const glass = scene.children.find((child) => child instanceof THREE.InstancedMesh) as THREE.InstancedMesh;
  return { waves, rain, glass, camera };
};
const waveUniforms = () => ((spatialLayers().waves.children[0] as THREE.Mesh).material as THREE.ShaderMaterial).uniforms;
const seeded = (): (() => number) => { let seed = 7; return () => (seed = (seed * 16807) % 2147483647) / 2147483647; };

describe("renderer layer preview, reduced motion and reset controls", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("window", { devicePixelRatio: 1 }); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("spatial solo changes object visibility only and leaves normalized state unmutated", () => {
    const env = new SpatialEnvironment(canvas(), options());
    const state = frozen({ ...banded(), spatial: busy() });
    const before = structuredClone(state);
    const preview = control(env, "setLayerPreview");
    const cases = [["waves", [true, false, false]], ["rain", [false, true, false]],
      ["glass", [false, false, true]], ["all", [true, true, true]]] as const;
    for (const [layer, expected] of cases) {
      preview(layer);
      env.render(state, 0.05);
      const { waves, rain, glass } = spatialLayers();
      expect([waves.visible, rain.visible, glass.visible], layer).toEqual(expected);
    }
    expect(state).toEqual(before);
    env.dispose();
  });

  it.each([["waves", 1], ["rain", 0], ["glass", 2]] as const)(
    "legacy %s solo is an approximate nearest-band filter keeping band %i only",
    (layer, kept) => {
      const env = painting();
      const state = frozen(banded());
      const before = structuredClone(state);
      env.render(state, 0.05);
      expect(ripplesOf().some((ring) => ring.w > 0)).toBe(true);
      control(env, "setLayerPreview")(layer);
      env.render(state, 0.05);
      const uniforms = uniformsWith("uLayerDynamics");
      const only = (values: number[]): number[] => values.map((value, index) => (index === kept ? value : 0));
      expect((uniforms.uLayerDynamics.value as THREE.Vector3[]).map((band) => band.x)).toEqual(only([0.6, 0.5, 0.4]));
      expect((uniforms.uFragments.value as THREE.Vector3).toArray()).toEqual(only([0.7, 0.7, 0.7]));
      // Old bass-driven ripples must not linger under a non-bass solo.
      if (kept !== 0) expect(ripplesOf().every((ring) => ring.w === 0)).toBe(true);
      expect(state).toEqual(before);
      env.dispose();
    },
  );

  it("reducedMotion is honoured initially by both renderers and later via the setter", () => {
    const state = { ...banded(), spatial: busy() };
    const run = (env: VisualRenderer): void => { for (let frame = 0; frame < 5; frame++) env.render(state, 0.1); };
    const slowStep = (env: VisualRenderer, uniforms: Record<string, THREE.IUniform>): void => {
      control(env, "setReducedMotion")(true);
      const start = uniforms.uTime.value as number;
      env.render(state, 0.1);
      const step = (uniforms.uTime.value as number) - start;
      expect(step).toBeGreaterThanOrEqual(0);
      expect(step).toBeLessThan(0.1);
    };
    const art = painting(false);
    run(art);
    const artUniforms = uniformsWith("uLayerDynamics");
    const stillArt = painting(true);
    run(stillArt);
    expect(uniformsWith("uLayerDynamics").uTime.value).toBeLessThan(artUniforms.uTime.value as number);
    slowStep(art, artUniforms);
    const env = new SpatialEnvironment(canvas(), options(false));
    run(env);
    const envWaves = waveUniforms();
    const stillEnv = new SpatialEnvironment(canvas(), options(true));
    run(stillEnv);
    expect(waveUniforms().uTime.value).toBeLessThan(envWaves.uTime.value as number);
    const { camera } = spatialLayers();
    const pose = camera.position.clone();
    run(stillEnv);
    expect(camera.position.equals(pose)).toBe(true); // No orbit or drift.
    slowStep(env, envWaves);
    for (const target of [art, stillArt, env, stillEnv]) target.dispose();
  });

  it("reduced-motion painting ripples age at wall-clock rate while ring expansion is scaled separately", () => {
    const quiet = structuredClone(calmVisualState);
    const still = painting(true);
    still.render(banded(), 0.1); // One bass impulse.
    expect(ripplesOf().some((ring) => ring.w > 0)).toBe(true);
    for (let frame = 0; frame < 20; frame++) still.render(quiet, 0.1);
    const ages = ripplesOf().filter((ring) => ring.w > 0).map((ring) => ring.z);
    expect(ages.length).toBeGreaterThan(0);
    const age = Math.max(...ages);
    // 2.1s of wall time since the impulse; a 0.35x motion clock would leave ~0.74s of age.
    expect(age).toBeGreaterThanOrEqual(1.9);
    expect(age).toBeLessThanOrEqual(2.1 + 1e-6);
    const reducedScale = uniformsWith("uRippleMotionScale").uRippleMotionScale.value as number;
    expect(Number.isFinite(reducedScale)).toBe(true);
    expect(reducedScale).toBeGreaterThan(0);
    expect(reducedScale).toBeLessThan(1);
    const art = painting(false);
    art.render(banded(), 0.1);
    const normalScale = uniformsWith("uRippleMotionScale").uRippleMotionScale.value as number;
    expect(normalScale).toBe(1);
    expect(reducedScale).toBeLessThan(normalScale);
    for (const target of [still, art]) target.dispose();
  });

  it("SceneDynamics reduced motion slows glass fall at equal wall time and still retires forms", () => {
    const make = (reduced: boolean): SceneDynamics => {
      const dynamics = new SceneDynamics({ maxRain: 32, maxGlass: 32 }, seeded());
      control(dynamics, "setReducedMotion")(reduced);
      return dynamics;
    };
    const [normal, reduced] = [make(false), make(true)];
    const quiet = structuredClone(quietSpatialState);
    const fast = normal.update(busy(), 0.1);
    const slow = reduced.update(busy(), 0.1);
    const buffer = slow.glassPositions;
    for (let frame = 0; frame < 4; frame++) { normal.update(quiet, 0.1); reduced.update(quiet, 0.1); }
    expect(fast.glassCount).toBeGreaterThan(0);
    expect(slow.glassCount).toBeGreaterThan(0);
    expect(Number.isFinite(slow.glassPositions[1])).toBe(true);
    expect(slow.glassPositions[1]).toBeGreaterThan(fast.glassPositions[1]); // Same seed, less fall.
    for (let frame = 0; frame < 600; frame++) reduced.update(quiet, 0.1);
    expect(reduced.update(quiet, 0.1)).toBe(slow);
    expect([slow.rainCount, slow.glassCount]).toEqual([0, 0]);
    expect(slow.glassPositions).toBe(buffer); // Reused fixed buffers.
  });

  it("clear drops residual forms; dispose is idempotent and blocks later render/control effects", () => {
    const env = new SpatialEnvironment(canvas(), options());
    env.render({ ...banded(), spatial: busy() }, 0.1);
    expect(spatialLayers().glass.count).toBeGreaterThan(0);
    control(env, "clear")();
    env.render(banded(), 0.1);
    const { rain, glass } = spatialLayers();
    expect([glass.count, ...rain.children.map((mesh) => (mesh as THREE.InstancedMesh).count)]).toEqual([0, 0, 0]);
    const art = painting();
    art.render(banded(), 0.05);
    expect(ripplesOf().some((ring) => ring.w > 0)).toBe(true);
    const wipes = calls.wipe.mock.calls.length;
    control(art, "clear")();
    expect(calls.wipe.mock.calls.length).toBeGreaterThan(wipes); // Feedback targets reset.
    art.render(structuredClone(calmVisualState), 0.05);
    expect(ripplesOf().every((ring) => ring.w === 0)).toBe(true);
    vi.clearAllMocks();
    const args: Record<Control, unknown[]> = { setLayerPreview: ["rain"], setReducedMotion: [true], clear: [] };
    for (const target of [env, art]) {
      target.dispose();
      target.dispose();
      for (const name of Object.keys(args) as Control[]) expect(() => control(target, name)(...args[name])).not.toThrow();
      target.resize();
      target.render(banded(), 0.1);
    }
    expect(calls.dispose).toHaveBeenCalledTimes(2);
    for (const effect of [calls.render, calls.size, calls.target, calls.wipe]) expect(effect).not.toHaveBeenCalled();
  });
});
