import * as THREE from "three";
import type { SpatialVisualState } from "../../mappings/SpatialVisualState";
import vertexShader from "../../shaders/spatial-glass.vert.glsl?raw";
import fragmentShader from "../../shaders/spatial-glass.frag.glsl?raw";
import type { SceneSnapshot } from "./SceneDynamics";

export class GlassLayer {
  public readonly object: THREE.InstancedMesh;
  private readonly geometry = new THREE.PlaneGeometry(0.48, 0.58);
  private readonly material = new THREE.ShaderMaterial({ vertexShader, fragmentShader,
    transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
    uniforms: { uColor: { value: new THREE.Color() }, uOpacity: { value: 0.3 },
      uShimmer: { value: 0 }, uHaze: { value: 0.2 } } });
  private readonly transform = new THREE.Object3D();
  private readonly order: Uint16Array;
  private readonly ages: THREE.InstancedBufferAttribute;
  public constructor(capacity: number) {
    this.order = new Uint16Array(capacity);
    this.ages = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute("aAge", this.ages);
    this.object = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    this.object.count = 0; this.object.frustumCulled = false;
    this.object.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.object.renderOrder = 2;
  }
  public update(snapshot: SceneSnapshot, state: SpatialVisualState, motionScale = 1): void {
    this.object.count = snapshot.glassCount;
    // Stable camera faces -Z. Insertion sort bounded instances far-to-near;
    // Three.js does not independently depth-sort transparent instances.
    for (let index = 0; index < snapshot.glassCount; index++) {
      let target = index;
      while (target > 0 && snapshot.glassPositions[this.order[target - 1] * 3 + 2] > snapshot.glassPositions[index * 3 + 2]) {
        this.order[target] = this.order[target - 1]; target--;
      }
      this.order[target] = index;
    }
    for (let index = 0; index < snapshot.glassCount; index++) {
      const source = this.order[index];
      const offset = source * 3;
      const age = snapshot.glassAges[source];
      this.transform.position.set(snapshot.glassPositions[offset], snapshot.glassPositions[offset + 1], snapshot.glassPositions[offset + 2]);
      this.transform.scale.set(snapshot.glassScales[offset], snapshot.glassScales[offset + 1], 1);
      this.transform.rotation.set(Math.sin(source * 1.7) * 0.12, Math.sin(source * 2.3) * 0.2, Math.sin(source + age * 2) * 0.16);
      this.transform.updateMatrix();
      this.object.setMatrixAt(index, this.transform.matrix);
      this.ages.setX(index, age);
    }
    this.object.instanceMatrix.needsUpdate = this.ages.needsUpdate = true;
    (this.material.uniforms.uColor.value as THREE.Color).setRGB(...state.glass.color);
    this.material.uniforms.uOpacity.value = state.glass.opacity;
    this.material.uniforms.uShimmer.value = (state.glass.shimmer ?? 0) * motionScale;
    this.material.uniforms.uHaze.value = state.haze ?? 0.2;
  }
  public dispose(): void { this.object.dispose(); this.geometry.dispose(); this.material.dispose(); }
}
