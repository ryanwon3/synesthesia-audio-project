import * as THREE from "three";
import vertexShader from "../shaders/painting.vert.glsl?raw";
import fragmentShader from "../shaders/painting.frag.glsl?raw";
import displayFragmentShader from "../shaders/display.frag.glsl?raw";
import type { VisualState } from "../mappings/VisualState";
import { RipplePool } from "./RipplePool";

export class EvolvingPainting {
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

  public constructor(private readonly canvas: HTMLCanvasElement) {
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
    const delta = Math.min(Math.max(deltaSeconds, 1 / 240), 0.1);
    this.elapsed += delta;
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
    this.geometry.dispose();
    this.feedbackMaterial.dispose();
    this.displayMaterial.dispose();
    this.readTarget.dispose();
    this.writeTarget.dispose();
    this.renderer.dispose();
  }

  private setUniforms(state: VisualState, delta: number): void {
    const uniforms = this.feedbackMaterial.uniforms;
    uniforms.uTime.value = this.elapsed;
    uniforms.uDelta.value = delta;
    this.ripples.update(state.layers[0].attack, state.layers[0].energy, state.stereoBalance, delta);
    this.ripples.rings.forEach((ring, index) => {
      (uniforms.uRipples.value[index] as THREE.Vector4).set(ring.x, ring.y, ring.age, ring.strength);
    });
    state.layers.forEach((layer, index) => {
      (uniforms.uLayerColors.value[index] as THREE.Vector3).set(...layer.color);
      (uniforms.uLayerDynamics.value[index] as THREE.Vector3).set(layer.energy, layer.attack, layer.softness);
      (uniforms.uLayerEffects.value[index] as THREE.Vector4).set(layer.effects[0], layer.effects[1], layer.effects[2], layer.effects[3]);
    });
    (uniforms.uFragments.value as THREE.Vector3).set(...state.layers.map(layer => layer.effects[4]) as [number, number, number]);
    (uniforms.uPrimary.value as THREE.Color).setRGB(...state.primaryColor);
    (uniforms.uSecondary.value as THREE.Color).setRGB(...state.secondaryColor);
    (uniforms.uAccent.value as THREE.Color).setRGB(...state.accentColor);
    (uniforms.uDynamics.value as THREE.Vector4).set(
      state.brightness,
      state.turbulence,
      state.impulseStrength,
      state.scale,
    );
    (uniforms.uMaterial.value as THREE.Vector4).set(
      state.persistence,
      state.sharpness,
      state.density,
      state.particleDensity,
    );
    (uniforms.uSpace.value as THREE.Vector4).set(
      state.fluidity,
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
}
