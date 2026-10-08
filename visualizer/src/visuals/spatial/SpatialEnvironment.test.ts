import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { calmVisualState } from "../../mappings/VisualState";
import { quietSpatialState } from "../../mappings/SpatialVisualState";
import { SpatialEnvironment } from "./SpatialEnvironment";

const calls = vi.hoisted(() => ({ dispose: vi.fn(), render: vi.fn(), size: vi.fn(), ratio: vi.fn(), clear: vi.fn() }));
vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();
  class Renderer {
    public outputColorSpace: unknown;
    public setPixelRatio = calls.ratio;
    public setSize = calls.size;
    public setClearColor = calls.clear;
    public render = calls.render;
    public dispose = calls.dispose;
  }
  return { ...actual, WebGLRenderer: Renderer };
});
const canvas = (): HTMLCanvasElement => Object.assign(new EventTarget(), { clientWidth: 1000, clientHeight: 600 }) as HTMLCanvasElement;
const options = () => ({ reducedMotion: false, onFailure: vi.fn() });

describe("spatial GPU-owner lifecycle with a controlled transport", () => {
  beforeEach(() => { vi.clearAllMocks(); calls.size.mockReset(); vi.stubGlobal("window", { devicePixelRatio: 3 }); });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it("creates actual depth geometry behind a 45-degree perspective camera and capped DPR", () => {
    const env = new SpatialEnvironment(canvas(), options());
    env.render({ ...calmVisualState, spatial: quietSpatialState }, 0.1);
    expect(calls.ratio).toHaveBeenCalledWith(1.5);
    const [scene, camera] = calls.render.mock.lastCall!;
    expect(scene).toBeInstanceOf(THREE.Scene);
    expect(camera).toBeInstanceOf(THREE.PerspectiveCamera);
    expect(camera.fov).toBe(45);
    const meshes: THREE.Mesh[] = [];
    scene.traverse((object: THREE.Object3D) => { if (object instanceof THREE.Mesh) meshes.push(object); });
    expect(meshes).toHaveLength(6); // Three wave surfaces, two rain forms, one tile pool.
    env.dispose();
  });
  it("low quality is explicitly capped at DPR one", () => {
    const env = new SpatialEnvironment(canvas(), options(), "low");
    expect(calls.ratio).toHaveBeenCalledWith(1);
    env.dispose();
  });
  it("routes bounded wave texture, haze and treble shimmer to materials, with gentler reduced-motion shimmer", () => {
    const env = new SpatialEnvironment(canvas(), options());
    const spatial = { ...structuredClone(quietSpatialState), haze: 0.9,
      waves: { ...quietSpatialState.waves, energy: 0.6, distortion: 0.8 },
      glass: { ...quietSpatialState.glass, shimmer: 0.8 } };
    env.render({ ...calmVisualState, spatial }, 0.1);
    const scene = calls.render.mock.lastCall![0] as THREE.Scene;
    const materials: THREE.ShaderMaterial[] = [];
    scene.traverse(object => { if (object instanceof THREE.Mesh && object.material instanceof THREE.ShaderMaterial) materials.push(object.material); });
    expect(materials.filter(material => material.uniforms.uDistortion?.value === 0.8)).toHaveLength(3);
    const glass = materials.find(material => material.uniforms.uShimmer)!;
    expect(glass.uniforms.uShimmer.value).toBe(0.8);
    expect((scene.fog as THREE.FogExp2).density).toBeGreaterThan(0.04);
    env.setReducedMotion(true);
    env.render({ ...calmVisualState, spatial }, 0.1);
    expect(glass.uniforms.uShimmer.value).toBeLessThan(0.8);
    env.dispose();
  });
  it("rolls back partial resource creation when initial resize fails", () => {
    const geometry = vi.spyOn(THREE.BufferGeometry.prototype, "dispose");
    const material = vi.spyOn(THREE.Material.prototype, "dispose");
    calls.size.mockImplementation(() => { throw new Error("controlled resize failure"); });
    expect(() => new SpatialEnvironment(canvas(), options())).toThrow();
    expect(calls.dispose).toHaveBeenCalledOnce();
    expect(geometry.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(material.mock.calls.length).toBeGreaterThanOrEqual(6);
  });
  it("context loss pauses rendering; restoration resizes and resumes without old trails", () => {
    const surface = canvas();
    const env = new SpatialEnvironment(surface, options());
    env.render(calmVisualState, 0.1);
    const count = calls.render.mock.calls.length;
    const loss = new Event("webglcontextlost", { cancelable: true });
    surface.dispatchEvent(loss);
    expect(loss.defaultPrevented).toBe(true);
    env.render(calmVisualState, 0.1);
    expect(calls.render.mock.calls.length).toBe(count);
    surface.dispatchEvent(new Event("webglcontextrestored"));
    env.render(calmVisualState, 0.1);
    expect(calls.render.mock.calls.length).toBe(count + 1);
    env.dispose();
  });
  it("disposes once and removes listeners; post-disposal operations are inert", () => {
    const surface = canvas();
    const env = new SpatialEnvironment(surface, options());
    env.dispose();
    env.dispose();
    env.resize();
    env.render(calmVisualState, 0.1);
    surface.dispatchEvent(new Event("webglcontextrestored"));
    expect(calls.dispose).toHaveBeenCalledOnce();
    expect(calls.render).not.toHaveBeenCalled();
  });
});
