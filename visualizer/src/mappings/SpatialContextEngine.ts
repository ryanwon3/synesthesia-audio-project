import { pitchClasses, type AudioFrame, type ChromaVector } from "../audio/AudioFrame";
import { isSpatialPreferences, type ResolvedSpatialTheme, type SpatialPreferences } from "../profiles/SpatialProfile";
import type { SpatialVisualState } from "./SpatialVisualState";
import type { RgbColor, VisualState } from "./VisualState";
import { neutralAtmosphere } from "../song/SongAtmosphere";

export const spatialTriggerDefaults = Object.freeze({ confidenceGate: 0.2, chromaChangeThreshold: 0.25,
  rainMinimumImpulse: 0.2, rainRefractorySeconds: 0.12, glassRefractorySeconds: 0.16 });

export class SpatialContextEngine {
  private waveEnergy = 0;
  private lastSequence: number | null = null;
  private previousChroma: number[] | null = null;
  private rainArmed = true;
  private glassArmed = true;
  private rainCooldown = 0;
  private glassCooldown = 0;
  private suppressNext = false;

  public reset(): void {
    this.waveEnergy = 0;
    this.lastSequence = null;
    this.previousChroma = null;
    this.rainArmed = true;
    this.glassArmed = true;
    this.rainCooldown = 0;
    this.glassCooldown = 0;
    this.suppressNext = true;
  }
  public update(frame: AudioFrame, mapped: VisualState, preferences: SpatialPreferences,
    theme: ResolvedSpatialTheme, deltaSeconds: number): SpatialVisualState {
    if (!isSpatialPreferences(preferences)) throw new Error("Invalid spatial preferences; preserve the previous profile.");
    const delta = Number.isFinite(deltaSeconds) ? Math.min(0.1, Math.max(0, deltaSeconds)) : 0;
    this.rainCooldown = Math.max(0, this.rainCooldown - delta);
    this.glassCooldown = Math.max(0, this.glassCooldown - delta);
    const audible = unit(frame.rms) > 0.0001 && Number.isSafeInteger(frame.sequence) && frame.sequence >= 0;
    const low = audible ? unit(frame.bassEnergy) : 0;
    const mid = audible ? unit(frame.midEnergy) : 0;
    const targetWave = Math.sqrt(mid) * preferences.waveStrength;
    this.waveEnergy += (targetWave - this.waveEnergy) * (1 - Math.exp(-delta / (targetWave > this.waveEnergy ? 0.16 : 0.3)));
    if (preferences.waveStrength === 0) this.waveEnergy = 0;
    let rainImpulse = 0;
    let glassImpulse = 0;

    if (!audible) {
      this.lastSequence = null;
      this.previousChroma = null;
      this.rainArmed = this.glassArmed = true;
      this.rainCooldown = this.glassCooldown = 0;
      this.suppressNext = true;
    } else if (frame.sequence !== this.lastSequence) {
      if (this.lastSequence !== null && frame.sequence < this.lastSequence) {
        this.previousChroma = null;
        this.rainArmed = this.glassArmed = true;
        this.rainCooldown = this.glassCooldown = 0;
        this.suppressNext = true;
      }
      this.lastSequence = frame.sequence;
      const bassAttack = frame.bass ? unit(frame.bass.attack) : unit(frame.onsetStrength) * low;
      const midAttack = frame.mid ? unit(frame.mid.attack) : unit(frame.onsetStrength) * mid;
      const confidence = unit(frame.mid?.chromaConfidence ?? frame.chromaConfidence);
      const chroma = normalizedChroma(frame.mid?.chroma ?? frame.chroma);
      const harmonic = mid > 0.0001 && confidence >= spatialTriggerDefaults.confidenceGate && chroma !== null;
      const change = harmonic && this.previousChroma && chroma
        ? chroma.reduce((sum, value, index) => sum + Math.abs(value - this.previousChroma![index]), 0) : 0;
      // Update the baseline even during refractory periods: no deferred catch-up notes.
      this.previousChroma = harmonic ? chroma : null;
      const rainEdge = bassAttack >= spatialTriggerDefaults.rainMinimumImpulse && this.rainArmed;
      const glassEdge = midAttack >= 0.2 && this.glassArmed;
      if (bassAttack < spatialTriggerDefaults.rainMinimumImpulse * 0.5) this.rainArmed = true;
      else if (bassAttack >= spatialTriggerDefaults.rainMinimumImpulse) this.rainArmed = false;
      if (midAttack < 0.1) this.glassArmed = true;
      else if (midAttack >= 0.2) this.glassArmed = false;
      if (!this.suppressNext) {
        if (low > 0 && rainEdge && this.rainCooldown === 0) {
          rainImpulse = bassAttack * preferences.rainStrength;
          this.rainCooldown = spatialTriggerDefaults.rainRefractorySeconds;
        }
        if (harmonic && (glassEdge || change >= spatialTriggerDefaults.chromaChangeThreshold) && this.glassCooldown === 0) {
          glassImpulse = Math.max(glassEdge ? midAttack : 0, change / 2) * preferences.glassStrength;
          this.glassCooldown = spatialTriggerDefaults.glassRefractorySeconds;
        }
      }
      this.suppressNext = false;
    }

    const atmosphere = mapped.atmosphere ?? neutralAtmosphere;
    const high = audible ? Math.sqrt(unit(frame.trebleEnergy) * Math.min(1, preferences.glassStrength)) : 0;
    return {
      themeId: theme.id, background: color(theme.background),
      haze: unit(atmosphere.haze),
      waves: { energy: unit(this.waveEnergy), softness: unit(mapped.layers[1].softness * 0.8 + unit(atmosphere.warmth) * 0.2),
        distortion: unit(atmosphere.distortion) * Math.sqrt(mid),
        scale: preferences.waveScale, color: color(theme.waveColorOverride ?? mapped.layers[1].color) },
      rain: { energy: Math.sqrt(low) * preferences.rainStrength, impulse: unit(rainImpulse),
        persistence: unit(preferences.rainPersistence * 0.85 + unit(mapped.persistence) * 0.15), color: color(mapped.layers[0].color) },
      glass: { energy: Math.sqrt(mid) * preferences.glassStrength, impulse: unit(glassImpulse),
        fallSpeed: preferences.fallSpeed, opacity: unit(0.25 + Math.sqrt(mid) * 0.35),
        shimmer: high * unit(atmosphere.shimmer), color: color(mapped.layers[2].color) },
      depth: preferences.depth, stereoBalance: unit(frame.stereoBalance, 0.5), stereoWidth: unit(frame.stereoWidth),
    };
  }
}

function unit(value: number, fallback = 0): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
}
function color(value: RgbColor): RgbColor { return [unit(value[0]), unit(value[1]), unit(value[2])]; }
function normalizedChroma(chroma: ChromaVector): number[] | null {
  const values = pitchClasses.map(pitch => unit(chroma[(pitch.charAt(0).toLowerCase() + pitch.slice(1)) as keyof ChromaVector]));
  const total = values.reduce((sum, value) => sum + value, 0);
  return total > 0.0001 ? values.map(value => value / total) : null;
}
