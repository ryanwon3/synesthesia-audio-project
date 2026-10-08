import * as THREE from "three";
import type { SpatialVisualState } from "../../mappings/SpatialVisualState";
import vertexShader from "../../shaders/spatial-waves.vert.glsl?raw";
import fragmentShader from "../../shaders/spatial-waves.frag.glsl?raw";
import type { SceneSnapshot } from "./SceneDynamics";

export class BronzeWaveLayer {
  public readonly object = new THREE.Group();
  private readonly geometry = new THREE.PlaneGeometry(12, 0.75, 64, 8);
  private readonly materials: THREE.ShaderMaterial[] = [];
  public constructor(count: number) {
    for (let index = 0; index < count; index++) {
      const material = new THREE.ShaderMaterial({ vertexShader, fragmentShader,
        transparent: true, depthWrite: false, side: THREE.DoubleSide,
        uniforms: { uTime: { value: index * 2.7 }, uEnergy: { value: 0 },
          uScale: { value: 0.5 }, uSoftness: { value: 0.6 }, uDistortion: { value: 0 },
          uHaze: { value: 0.2 }, uColor: { value: new THREE.Color() } } });
      this.materials.push(material);
      const wave = new THREE.Mesh(this.geometry, material);
      wave.position.set(0, (index - 1) * 0.7, -1.5 - index * 2.1);
      wave.renderOrder = 1; // Black-fogged translucent environment behind the tiles/impacts.
      this.object.add(wave);
    }
  }
  public update(_snapshot: SceneSnapshot, state: SpatialVisualState, elapsed = 0, motionScale = 1): void {
    for (let index = 0; index < this.materials.length; index++) {
      const uniforms = this.materials[index].uniforms;
      uniforms.uTime.value = elapsed + index * 2.7;
      uniforms.uEnergy.value = state.waves.energy;
      uniforms.uScale.value = state.waves.scale;
      uniforms.uSoftness.value = state.waves.softness;
      uniforms.uDistortion.value = (state.waves.distortion ?? 0) * motionScale;
      uniforms.uHaze.value = state.haze ?? 0.2;
      (uniforms.uColor.value as THREE.Color).setRGB(...state.waves.color);
      this.object.children[index].position.z = -1.5 - index * (1 + state.depth * 2);
    }
  }
  public dispose(): void {
    this.geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.object.clear();
  }
}
