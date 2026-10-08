import * as THREE from "three";
import type { VisualState } from "../../mappings/VisualState";
import { quietSpatialState } from "../../mappings/SpatialVisualState";
import { normalizeLayerPreview, reducedMotionTimeScale, type LayerPreview, type RenderOptions, type VisualRenderer } from "../VisualRenderer";
import { BronzeWaveLayer } from "./BronzeWaveLayer";
import { GlassLayer } from "./GlassLayer";
import { RainLayer } from "./RainLayer";
import { SceneDynamics } from "./SceneDynamics";
import { spatialQuality } from "./SpatialQuality";

export class SpatialEnvironment implements VisualRenderer {
  private renderer: THREE.WebGLRenderer | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(45, 1, 0.1, 50);
  private readonly background = new THREE.Color();
  private readonly dynamics: SceneDynamics;
  private waves: BronzeWaveLayer | null = null;
  private rain: RainLayer | null = null;
  private glass: GlassLayer | null = null;
  private elapsed = 0;
  private disposed = false;
  private lost = false;
  private reducedMotion: boolean;
  private readonly limits: (typeof spatialQuality)["normal" | "low"];
  private readonly onLost = (event: Event): void => { event.preventDefault(); this.lost = true; this.clear(); };
  private readonly onRestored = (): void => {
    if (this.disposed) return;
    try { this.lost = false; this.clear(); this.resize(); }
    catch { this.lost = true; this.options.onFailure("WebGL restoration failed. Reload the page; your profile is unchanged."); }
  };
  public constructor(private readonly canvas: HTMLCanvasElement, private readonly options: RenderOptions, quality: "normal" | "low" = "normal") {
    this.limits = spatialQuality[quality];
    this.dynamics = new SceneDynamics(this.limits);
    this.reducedMotion = options.reducedMotion === true;
    this.dynamics.setReducedMotion(this.reducedMotion);
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: "high-performance" });
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.scene.background = this.background;
      this.scene.fog = new THREE.FogExp2(0x000000, 0.04);
      this.camera.position.set(0, 0, 8);
      this.camera.lookAt(0, 0, -3);
      this.waves = new BronzeWaveLayer(this.limits.waves);
      this.scene.add(this.waves.object);
      this.rain = new RainLayer(this.limits.maxRain);
      this.scene.add(this.rain.object);
      this.glass = new GlassLayer(this.limits.maxGlass);
      this.scene.add(this.glass.object);
      this.resize();
      this.canvas.addEventListener("webglcontextlost", this.onLost);
      this.canvas.addEventListener("webglcontextrestored", this.onRestored);
    } catch {
      // Constructor owns partial rollback: the factory cannot dispose an object
      // which was never returned. Do not force context loss before fallback.
      this.dispose();
      throw new Error("Spatial WebGL setup failed.");
    }
  }
  public render(state: VisualState, deltaSeconds: number): void {
    if (this.disposed || this.lost || !this.renderer) return;
    const spatial = state.spatial ?? quietSpatialState;
    const delta = Number.isFinite(deltaSeconds) ? Math.min(0.1, Math.max(0, deltaSeconds)) : 0;
    // Slower, never rewound, shader clock; the camera stays fixed in both modes.
    this.elapsed = (this.elapsed + (this.reducedMotion ? delta * reducedMotionTimeScale : delta)) % 10000;
    const snapshot = this.dynamics.update(spatial, delta);
    this.background.setRGB(...spatial.background);
    const haze = Number.isFinite(spatial.haze) ? Math.min(1, Math.max(0, spatial.haze!)) : 0.2;
    (this.scene.fog as THREE.FogExp2).density = 0.025 + haze * 0.04;
    const motionScale = this.reducedMotion ? 0.25 : 1;
    this.waves?.update(snapshot, spatial, this.elapsed, motionScale);
    this.rain?.update(snapshot, spatial);
    this.glass?.update(snapshot, spatial, motionScale);
    this.renderer.render(this.scene, this.camera);
  }
  public resize(): void {
    if (this.disposed || !this.renderer) return;
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    const dpr = Number.isFinite(window.devicePixelRatio) ? Math.max(1, window.devicePixelRatio) : 1;
    this.renderer.setPixelRatio(Math.min(dpr, this.limits.pixelRatio));
    this.renderer.setSize(width, height, false);
  }
  // Controls are CPU-only: safe after dispose or context loss.
  public setLayerPreview(layer: LayerPreview): void {
    if (this.disposed) return;
    // Solo is visibility only; mapped state and simulation stay untouched.
    const solo = normalizeLayerPreview(layer);
    if (this.waves) this.waves.object.visible = solo === "all" || solo === "waves";
    if (this.rain) this.rain.object.visible = solo === "all" || solo === "rain";
    if (this.glass) this.glass.object.visible = solo === "all" || solo === "glass";
  }
  public setReducedMotion(enabled: boolean): void {
    if (this.disposed) return;
    this.reducedMotion = enabled === true;
    this.dynamics.setReducedMotion(this.reducedMotion);
  }
  public clear(): void { this.dynamics.clear(); this.elapsed = 0; }
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener("webglcontextlost", this.onLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onRestored);
    this.waves?.dispose(); this.rain?.dispose(); this.glass?.dispose();
    this.scene.clear(); this.dynamics.clear();
    this.renderer?.dispose(); this.renderer = null;
  }
}
