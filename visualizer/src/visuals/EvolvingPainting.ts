import * as THREE from "three";
import vertexShader from "../shaders/painting.vert.glsl?raw";
import fragmentShader from "../shaders/painting.frag.glsl?raw";
import displayFragmentShader from "../shaders/display.frag.glsl?raw";
import type { VisualState } from "../mappings/VisualState";
import { RipplePool } from "./RipplePool";
import { normalizeLayerPreview, reducedMotionTimeScale, type LayerPreview, type RenderOptions, type VisualRenderer } from "./VisualRenderer";

// Approximate nearest-band preview: bass→rain, mid→waves, treble→glass. Not stem separation.
const previewBands: Record<Exclude<LayerPreview, "all">, number> = { rain: 0, waves: 1, glass: 2 };

export class EvolvingPainting implements VisualRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly feedbackScene = new THREE.Scene();
  private readonly displayScene = new THREE.Scene();
  private readonly feedbackMaterial: THREE.ShaderMaterial;
  private readonly displayMaterial: THREE.ShaderMaterial;
  private readonly geometry = new THREE.PlaneGeometry(2, 2);
  private readTarget: THREE.WebGLRenderTarget;
  private writeTarget: THREE.WebGLRenderTarget;
  private readonly resolution = new THREE.Vector2(1, 1);
  private elapsed = 0;
  private readonly ripples = new RipplePool();
  private preview: LayerPreview = "all";
  private reducedMotion: boolean;
  private disposed = false;

  // Options stay optional so existing single-argument construction keeps working.
  public constructor(private readonly canvas: HTMLCanvasElement, options?: Pick<RenderOptions, "reducedMotion">) {
    this.reducedMotion = options?.reducedMotion === true;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x060708, 1);

    this.readTarget = this.createRenderTarget(1, 1);
    this.writeTarget = this.createRenderTarget(1, 1);
    this.feedbackMaterial = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uPrevious: { value: this.readTarget.texture },
        uResolution: { value: this.resolution },
        uTime: { value: 0 },
        uDelta: { value: 1 / 60 },
        uPrimary: { value: new THREE.Color() },
        uSecondary: { value: new THREE.Color() },
        uAccent: { value: new THREE.Color() },
        uDynamics: { value: new THREE.Vector4() },
        uMaterial: { value: new THREE.Vector4() },
        uSpace: { value: new THREE.Vector4() },
        uLayerColors: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
        uLayerDynamics: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
        uLayerEffects: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
        uFragments: { value: new THREE.Vector3() },
        uRipples: { value: Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, 10, 0)) },
        uRippleMotionScale: { value: 1 },
      },
    });
    this.displayMaterial = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader: displayFragmentShader,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uPainting: { value: this.writeTarget.texture },
        uTime: { value: 0 },
        uResolution: { value: this.resolution },
      },
    });

    this.feedbackScene.add(new THREE.Mesh(this.geometry, this.feedbackMaterial));
    this.displayScene.add(new THREE.Mesh(this.geometry, this.displayMaterial));
    this.resize();
  }

  public resize(): void {
    if (this.disposed) return;
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    const pixelRatio = Math.min(window.devicePixelRatio, 1.75);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.renderer.getDrawingBufferSize(this.resolution);
    this.readTarget.setSize(this.resolution.x, this.resolution.y);
    this.writeTarget.setSize(this.resolution.x, this.resolution.y);
    this.clearTarget(this.readTarget);
    this.clearTarget(this.writeTarget);
  }

  public render(state: VisualState, deltaSeconds: number): void {
    if (this.disposed) return;
    const delta = Math.min(Math.max(deltaSeconds, 1 / 240), 0.1);
    // Shader clock only moves forward; reduced motion slows it rather than rewinding.
    const motionDelta = this.reducedMotion ? delta * reducedMotionTimeScale : delta;
    this.elapsed += motionDelta;
    this.setUniforms(state, delta);

    this.feedbackMaterial.uniforms.uPrevious.value = this.readTarget.texture;
    this.renderer.setRenderTarget(this.writeTarget);
    this.renderer.render(this.feedbackScene, this.camera);

    this.displayMaterial.uniforms.uPainting.value = this.writeTarget.texture;
    this.displayMaterial.uniforms.uTime.value = this.elapsed;
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.displayScene, this.camera);

    [this.readTarget, this.writeTarget] = [this.writeTarget, this.readTarget];
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.geometry.dispose();
    this.feedbackMaterial.dispose();
    this.displayMaterial.dispose();
    this.readTarget.dispose();
    this.writeTarget.dispose();
    this.renderer.dispose();
  }

  public setLayerPreview(layer: LayerPreview): void {
    if (this.disposed) return;
    const next = normalizeLayerPreview(layer);
    if (next === this.preview) return;
    this.preview = next;
    // Hidden bands (and bass ripples under a non-bass solo) must not linger in feedback.
    this.resetTrails();
  }

  public setReducedMotion(enabled: boolean): void {
    if (this.disposed) return;
    const next = enabled === true;
    if (next === this.reducedMotion) return;
    this.reducedMotion = next;
    // Old fast trails are wiped; elapsed is kept so shader time never jumps backwards.
    this.resetTrails();
  }

  public clear(): void {
    if (this.disposed) return;
    this.elapsed = 0;
    this.resetTrails();
  }

  private setUniforms(state: VisualState, delta: number): void {
    const uniforms = this.feedbackMaterial.uniforms;
    uniforms.uTime.value = this.elapsed;
    uniforms.uDelta.value = delta;
    // Hidden bass seeds no ripples. Ripples age in wall-clock time; reduced motion slows only expansion.
    const bassVisible = this.bandVisible(0);
    this.ripples.update(bassVisible ? state.layers[0].attack : 0, bassVisible ? state.layers[0].energy : 0, state.stereoBalance, delta);
    uniforms.uRippleMotionScale.value = this.reducedMotion ? reducedMotionTimeScale : 1;
    this.ripples.rings.forEach((ring, index) => {
      (uniforms.uRipples.value[index] as THREE.Vector4).set(ring.x, ring.y, ring.age, this.calm(ring.strength, 0.6));
    });
    const fragments = uniforms.uFragments.value as THREE.Vector3;
    state.layers.forEach((layer, index) => {
      const on = this.bandVisible(index);
      (uniforms.uLayerColors.value[index] as THREE.Vector3).set(...layer.color);
      (uniforms.uLayerDynamics.value[index] as THREE.Vector3).set(
        on ? layer.energy : 0, on ? this.calm(layer.attack, 0.6) : 0, on ? layer.softness : 0);
      (uniforms.uLayerEffects.value[index] as THREE.Vector4).set(
        on ? layer.effects[0] : 0, on ? layer.effects[1] : 0, on ? layer.effects[2] : 0, on ? layer.effects[3] : 0);
      fragments.setComponent(index, on ? layer.effects[4] : 0);
    });
    (uniforms.uPrimary.value as THREE.Color).setRGB(...state.primaryColor);
    (uniforms.uSecondary.value as THREE.Color).setRGB(...state.secondaryColor);
    (uniforms.uAccent.value as THREE.Color).setRGB(...state.accentColor);
    (uniforms.uDynamics.value as THREE.Vector4).set(
      state.brightness,
      this.calm(state.turbulence, 0.5),
      this.calm(state.impulseStrength, 0.5),
      state.scale,
    );
    (uniforms.uMaterial.value as THREE.Vector4).set(
      this.calm(state.persistence, 0.8),
      state.sharpness,
      this.calm(state.density, 0.8),
      this.calm(state.particleDensity, 0.5),
    );
    (uniforms.uSpace.value as THREE.Vector4).set(
      this.calm(state.fluidity, 0.6),
      state.depth,
      state.stereoBalance,
      state.stereoWidth,
    );
  }

  private createRenderTarget(width: number, height: number): THREE.WebGLRenderTarget {
    return new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      // Floating-point feedback prevents 8-bit rounding from freezing dim trails at high refresh rates.
      type: this.renderer.extensions.has("EXT_color_buffer_float") ? THREE.HalfFloatType : THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
    });
  }

  private clearTarget(target: THREE.WebGLRenderTarget): void {
    this.renderer.setRenderTarget(target);
    this.renderer.clear();
    this.renderer.setRenderTarget(null);
  }

  private bandVisible(index: number): boolean {
    return this.preview === "all" || previewBands[this.preview] === index;
  }

  // Reduced motion damps a value; normal mode passes it through unchanged.
  private calm(value: number, factor: number): number {
    return this.reducedMotion ? value * factor : value;
  }

  private resetTrails(): void {
    this.ripples.clear();
    this.clearTarget(this.readTarget);
    this.clearTarget(this.writeTarget);
  }
}
