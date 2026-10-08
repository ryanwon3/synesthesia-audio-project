import type { SpatialVisualState } from "../../mappings/SpatialVisualState";

// Form geometry. Reduced motion slows velocity and caps wall-clock life; it does not slow the clock.
const top = 3.2;
const rainFall = 5.2;
const glassFall = 7;
const impactBurst = 4;
const reduced = { travel: 0.35, burst: 0.5, density: 0.5, rainLifetime: 1.4, glassLifetime: 2.4 } as const;

export interface SceneSnapshot {
  rainCount: number;
  glassCount: number;
  rainPositions: Float32Array;
  rainScales: Float32Array;
  rainAges: Float32Array;
  glassPositions: Float32Array;
  glassScales: Float32Array;
  glassAges: Float32Array;
}
export class SceneDynamics {
  private readonly snapshot: SceneSnapshot;
  private readonly rain: ParticlePool;
  private readonly glass: ParticlePool;
  private reducedMotion = false;
  public constructor(options: { maxRain: number; maxGlass: number }, private readonly random: () => number = Math.random) {
    for (const capacity of [options.maxRain, options.maxGlass]) {
      if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 512) throw new Error("Invalid spatial pool capacity (1–512 required).");
    }
    this.rain = new ParticlePool(options.maxRain);
    this.glass = new ParticlePool(options.maxGlass);
    this.snapshot = { rainCount: 0, glassCount: 0,
      rainPositions: this.rain.positions, rainScales: this.rain.scales, rainAges: this.rain.ages,
      glassPositions: this.glass.positions, glassScales: this.glass.scales, glassAges: this.glass.ages };
  }
  public clear(): void {
    this.rain.clear();
    this.glass.clear();
    this.snapshot.rainCount = this.snapshot.glassCount = 0;
  }
  /** A changed preference retires obsolete forms in place; buffers are reused. */
  public setReducedMotion(enabled: boolean): void {
    const next = enabled === true;
    if (next === this.reducedMotion) return;
    this.reducedMotion = next;
    this.clear();
  }
  public update(state: SpatialVisualState, deltaSeconds: number): SceneSnapshot {
    const delta = Number.isFinite(deltaSeconds) ? Math.min(0.1, Math.max(0, deltaSeconds)) : 0;
    if (delta === 0) return this.snapshot;
    this.rain.advance(delta, true);
    this.glass.advance(delta, false);
    this.emit(this.rain, state, unit(state.rain.impulse), unit(state.rain.energy), true);
    this.emit(this.glass, state, unit(state.glass.impulse), unit(state.glass.energy), false);
    this.snapshot.rainCount = this.rain.count;
    this.snapshot.glassCount = this.glass.count;
    return this.snapshot;
  }
  private emit(pool: ParticlePool, state: SpatialVisualState, impulse: number, energy: number, rain: boolean): void {
    if (impulse === 0 || energy === 0) return;
    const calm = this.reducedMotion;
    const count = Math.ceil(impulse * (rain ? 6 : 5) * (calm ? reduced.density : 1));
    for (let i = 0; i < count; i++) {
      const spread = 3 + unit(state.stereoWidth) * 2;
      const x = (unit(this.random()) * 2 - 1) * spread + (unit(state.stereoBalance) * 2 - 1) * 1.5;
      const z = -unit(this.random()) * (2 + unit(state.depth) * 8);
      const size = (0.6 + unit(this.random()) * 0.8) * (0.5 + energy * 0.5);
      const natural = rain ? 1.1 + unit(state.rain.persistence) * 2.5 : 2.2 + (1 - unit(state.glass.fallSpeed)) * 3.8;
      if (!calm) { pool.spawn(x, z, size, natural, top, rain ? rainFall : glassFall, impactBurst, rain); continue; }
      // Slower velocity at equal wall time, but a capped life so trails stay shorter.
      const lifetime = Math.min(natural, rain ? reduced.rainLifetime : reduced.glassLifetime);
      const travel = (rain ? rainFall : glassFall) * reduced.travel * (lifetime / natural);
      // Reduced rain starts lower so its shorter fall still lands (and splashes) on the floor.
      pool.spawn(x, z, size, lifetime, rain ? top - rainFall + travel : top, travel, impactBurst * reduced.burst, rain);
    }
  }
}

// Packed fixed arrays: retirement swaps the last live slot into the hole.
class ParticlePool {
  public count = 0;
  public readonly positions: Float32Array;
  public readonly scales: Float32Array;
  public readonly ages: Float32Array;
  private readonly seconds: Float32Array;
  private readonly lifetimes: Float32Array;
  private readonly sizes: Float32Array;
  private readonly origins: Float32Array;
  private readonly travels: Float32Array;
  private readonly bursts: Float32Array;
  private replacement = 0;
  public constructor(private readonly capacity: number) {
    this.positions = new Float32Array(capacity * 3);
    this.scales = new Float32Array(capacity * 3);
    this.ages = new Float32Array(capacity);
    this.seconds = new Float32Array(capacity);
    this.lifetimes = new Float32Array(capacity);
    this.sizes = new Float32Array(capacity);
    this.origins = new Float32Array(capacity);
    this.travels = new Float32Array(capacity);
    this.bursts = new Float32Array(capacity);
  }
  public clear(): void {
    this.count = this.replacement = 0;
    this.positions.fill(0); this.scales.fill(0); this.ages.fill(0);
    this.seconds.fill(0); this.lifetimes.fill(0); this.sizes.fill(0);
    this.origins.fill(0); this.travels.fill(0); this.bursts.fill(0);
  }
  public spawn(x: number, z: number, size: number, lifetime: number, origin: number, travel: number, burst: number, rain: boolean): void {
    const index = this.count < this.capacity ? this.count++ : this.replacement++ % this.capacity;
    this.seconds[index] = this.ages[index] = 0;
    this.lifetimes[index] = lifetime;
    this.sizes[index] = size;
    this.origins[index] = origin;
    this.travels[index] = travel;
    this.bursts[index] = burst;
    this.positions[index * 3] = x;
    this.positions[index * 3 + 1] = origin;
    this.positions[index * 3 + 2] = z;
    this.shape(index, rain);
  }
  public advance(delta: number, rain: boolean): void {
    for (let index = 0; index < this.count;) {
      this.seconds[index] += delta;
      if (this.seconds[index] >= this.lifetimes[index]) {
        const last = --this.count;
        this.positions.copyWithin(index * 3, last * 3, last * 3 + 3);
        this.scales.copyWithin(index * 3, last * 3, last * 3 + 3);
        this.ages[index] = this.ages[last];
        this.seconds[index] = this.seconds[last];
        this.lifetimes[index] = this.lifetimes[last];
        this.sizes[index] = this.sizes[last];
        this.origins[index] = this.origins[last];
        this.travels[index] = this.travels[last];
        this.bursts[index] = this.bursts[last];
        continue;
      }
      this.ages[index] = this.seconds[index] / this.lifetimes[index];
      this.shape(index, rain);
      index++;
    }
  }
  private shape(index: number, rain: boolean): void {
    const age = this.ages[index];
    const size = this.sizes[index];
    const impact = rain && age >= 0.55;
    const fall = rain ? Math.min(age / 0.55, 1) : age;
    this.positions[index * 3 + 1] = this.origins[index] - fall * this.travels[index];
    const extent = impact ? (0.2 + (age - 0.55) * this.bursts[index]) * size : size;
    this.scales[index * 3] = extent;
    this.scales[index * 3 + 1] = impact ? extent * 0.4 : size * (rain ? 2.2 : 1);
    this.scales[index * 3 + 2] = extent;
  }
}
function unit(value: number): number { return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0; }
