import * as THREE from "three";
import type { SpatialVisualState } from "../../mappings/SpatialVisualState";
import type { SceneSnapshot } from "./SceneDynamics";

export class RainLayer {
  public readonly object = new THREE.Group();
  private readonly dropGeometry = new THREE.SphereGeometry(0.095, 8, 6);
  private readonly ringGeometry = new THREE.RingGeometry(0.22, 0.29, 20);
  private readonly dropMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false });
  private readonly ringMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.75, depthWrite: false, side: THREE.DoubleSide });
  private readonly drops: THREE.InstancedMesh;
  private readonly rings: THREE.InstancedMesh;
  private readonly transform = new THREE.Object3D();
  private readonly color = new THREE.Color();
  public constructor(capacity: number) {
    this.drops = new THREE.InstancedMesh(this.dropGeometry, this.dropMaterial, capacity);
    this.rings = new THREE.InstancedMesh(this.ringGeometry, this.ringMaterial, capacity);
    for (const mesh of [this.drops, this.rings]) {
      mesh.count = 0; mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // Preallocate the instance-color buffer before render-time updates.
      for (let index = 0; index < capacity; index++) mesh.setColorAt(index, this.color);
      mesh.renderOrder = 3;
      this.object.add(mesh);
    }
  }
  public update(snapshot: SceneSnapshot, state: SpatialVisualState): void {
    this.drops.count = this.rings.count = snapshot.rainCount;
    for (let index = 0; index < snapshot.rainCount; index++) {
      const offset = index * 3;
      const age = snapshot.rainAges[index];
      const impact = age >= 0.55;
      this.transform.position.set(snapshot.rainPositions[offset], snapshot.rainPositions[offset + 1], snapshot.rainPositions[offset + 2]);
      this.transform.rotation.set(0, 0, 0);
      this.transform.scale.set(snapshot.rainScales[offset], snapshot.rainScales[offset + 1], snapshot.rainScales[offset + 2]);
      if (impact) this.transform.scale.set(0, 0, 0);
      this.transform.updateMatrix();
      this.drops.setMatrixAt(index, this.transform.matrix);
      this.transform.scale.set(impact ? snapshot.rainScales[offset] : 0, impact ? snapshot.rainScales[offset + 1] : 0, 1);
      this.transform.updateMatrix();
      this.rings.setMatrixAt(index, this.transform.matrix);
      this.color.setRGB(...state.rain.color).lerp(newColorWhite, 0.25).multiplyScalar(impact ? Math.max(0, (1 - age) / 0.45) : 1);
      this.drops.setColorAt(index, this.color);
      this.rings.setColorAt(index, this.color);
    }
    this.drops.instanceMatrix.needsUpdate = this.rings.instanceMatrix.needsUpdate = true;
    if (this.drops.instanceColor) this.drops.instanceColor.needsUpdate = true;
    if (this.rings.instanceColor) this.rings.instanceColor.needsUpdate = true;
  }
  public dispose(): void {
    this.drops.dispose(); this.rings.dispose();
    this.dropGeometry.dispose(); this.ringGeometry.dispose();
    this.dropMaterial.dispose(); this.ringMaterial.dispose();
    this.object.clear();
  }
}
const newColorWhite = new THREE.Color(0.7, 0.8, 0.9);
