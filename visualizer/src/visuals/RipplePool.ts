export class RipplePool {
  public readonly rings = Array.from({ length: 8 }, () => ({ x: 0, y: 0, age: 10, strength: 0 }));
  private armed = true;
  private cooldown = 0;
  private cursor = 0;
  public update(attack: number, energy: number, balance: number, delta: number): void {
    for (const ring of this.rings) ring.age += delta;
    this.cooldown = Math.max(0, this.cooldown - delta);
    if (attack < 0.05) this.armed = true;
    if (attack > 0.12 && energy > 0.01 && this.armed && this.cooldown === 0) {
      const ring = this.rings[this.cursor];
      ring.x = (balance - 0.5) * 0.45 + Math.sin(this.cursor * 2.4) * 0.12;
      ring.y = Math.cos(this.cursor * 1.7) * 0.12;
      ring.age = 0; ring.strength = Math.min(1, attack * 1.5);
      this.cursor = (this.cursor + 1) % this.rings.length;
      this.armed = false; this.cooldown = 0.24;
    }
  }
  public clear(): void {
    for (const ring of this.rings) { ring.x = ring.y = ring.strength = 0; ring.age = 10; }
    this.armed = true; this.cooldown = 0; this.cursor = 0;
  }
}
