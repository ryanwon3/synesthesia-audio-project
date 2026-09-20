import { pitchClasses, type AudioFrame, type PitchClass } from "../audio/AudioFrame";
import type { SynesthesiaProfile } from "../profiles/SynesthesiaProfile";
import { calmVisualState, type RgbColor, type VisualState } from "./VisualState";
import type { SongContextSnapshot } from "../song/SongContext";
import { effects, songTraits } from "../song/SongVisualProfile";
import { moodPitchColors } from "./MoodPalette";

const chromaKeys = [
  "c",
  "cSharp",
  "d",
  "dSharp",
  "e",
  "f",
  "fSharp",
  "g",
  "gSharp",
  "a",
  "aSharp",
  "b",
] as const;

export class VisualContextEngine {
  private current: VisualState = structuredClone(calmVisualState);
  private palettes: RgbColor[][] | null = null;
  private paletteMood = "";
  private targetPalettes: RgbColor[][] = [];
  private contextEnergy = 0.5;
  private contextTension = 0.3;

  public get state(): VisualState {
    return this.current;
  }

  public update(frame: AudioFrame, profile: SynesthesiaProfile, deltaSeconds: number, song?: SongContextSnapshot): VisualState {
    const colors = selectColors(frame, profile);
    const response = profile.response;
    const traits = songTraits(song);
    const influence = profile.layers?.moodInfluence ?? 0.8;
    const semanticFactor = 1 - Math.exp(-Math.max(0, deltaSeconds) / 1);
    this.contextEnergy += (traits.energy - this.contextEnergy) * semanticFactor;
    this.contextTension += (traits.tension - this.contextTension) * semanticFactor;
    if (this.paletteMood !== traits.mood) {
      this.paletteMood = traits.mood;
      this.targetPalettes = [0, 1, 2].map(layer => moodPitchColors(traits.mood, layer));
    }
    this.palettes ??= this.targetPalettes;
    this.palettes = this.palettes.map((palette, layer) => palette.map((color, pitch) =>
      color.map((v, c) => v + (this.targetPalettes[layer][pitch][c] - v) * semanticFactor) as unknown as RgbColor));
    const bands = [frame.bass, frame.mid, frame.treble];
    const energies = [frame.bassEnergy, frame.midEnergy, frame.trebleEnergy];
    const strengths = [profile.layers?.bass ?? 1, profile.layers?.mid ?? 1, profile.layers?.treble ?? 1];
    const families = [traits.bassEffect, traits.midEffect, traits.trebleEffect];
    const defaults = ["ripples", "ribbons", "sparks"];
    const layers = this.current.layers.map((prior, index) => {
      const band = bands[index];
      const colorFrame = band ? { ...frame, chroma: band.chroma, chromaConfidence: band.chromaConfidence } : frame;
      let color = band && band.chromaConfidence < 0.15 ? prior.color : selectColors(colorFrame, profile).primary;
      if (profile.colorMode === "mood") {
        const weights = chromaKeys.map(key => finite01(colorFrame.chroma[key]));
        const total = weights.reduce((a, b) => a + b, 0);
        const palette = this.palettes![index];
        color = colorFrame.chromaConfidence < 0.15 || total < 0.001 ? palette[5] :
          [0, 1, 2].map(c => weights.reduce((sum, w, pitch) => sum + palette[pitch][c] * w / total, 0)) as unknown as RgbColor;
      }
      const audioFactor = 1 - Math.exp(-Math.max(0, deltaSeconds) / 0.09);
      const weights = effects.map(effect => {
        const preferred = families[index];
        // Two families at most: a band anchor plus a contextual texture.
        return (effect === defaults[index] ? 1 - influence * 0.65 : 0) + (effect === preferred ? influence * 0.65 : 0);
      });
      return {
        color: prior.color.map((v, i) => v + (color[i] - v) * audioFactor) as unknown as RgbColor,
        energy: prior.energy + (clamp01(energies[index] * 3) * strengths[index] - prior.energy) * audioFactor,
        attack: clamp01((band?.attack ?? frame.onsetStrength * energies[index]) * strengths[index] * response.transientImpulse),
        softness: prior.softness + (clamp01(0.5 + (traits.softness - 0.5 +
          (traits.imagery === "air" ? 0.08 : traits.imagery === "fire" ? -0.1 : 0)) * influence) - prior.softness) * semanticFactor,
        effects: prior.effects.map((v, i) => v + (weights[i] - v) * semanticFactor) as [number, number, number, number, number],
      };
    }) as VisualState["layers"];
    const target: VisualState = {
      layers,
      primaryColor: colors.primary,
      secondaryColor: colors.secondary,
      accentColor: colors.accent,
      brightness: clamp01(0.08 + frame.rms * 4.4),
      saturation: clamp01(0.5 + frame.chromaConfidence * 0.42),
      fluidity: clamp01(0.25 + response.movement * 0.45 + frame.midEnergy * 0.3 + this.contextEnergy * influence * 0.2),
      sharpness: clamp01(response.sharpness * 0.55 + frame.spectralCentroid * 0.6 + this.contextTension * influence * 0.15),
      density: clamp01(0.18 + response.midStructure * 0.3 + frame.midEnergy * 0.7),
      depth: clamp01(response.depth * 0.8 + frame.stereoWidth * 0.3),
      persistence: clamp01(0.68 + response.persistence * 0.29),
      turbulence: clamp01(frame.spectralFlux * 0.72 + frame.bassEnergy * response.bassDeformation * 0.48),
      scale: clamp01(0.24 + frame.rms * 1.6 + frame.bassEnergy * response.bassDeformation * 0.7),
      particleDensity: clamp01(0.04 + frame.trebleEnergy * response.trebleParticles * 1.7),
      impulseStrength: clamp01(frame.onsetStrength * response.transientImpulse),
      spacing: clamp01(0.38 + (1 - response.midStructure) * 0.34),
      structuralOrder: clamp01(0.24 + response.midStructure * 0.62 - frame.spectralFlux * 0.18),
      stereoBalance: clamp01(frame.stereoBalance),
      stereoWidth: clamp01(frame.stereoWidth),
    };

    const smoothingSeconds = 0.025 + response.smoothing * 0.2;
    const factor = 1 - Math.exp(-Math.max(deltaSeconds, 0) / smoothingSeconds);
    this.current = interpolateState(this.current, target, factor);
    return this.current;
  }
}

function selectColors(
  frame: AudioFrame,
  profile: SynesthesiaProfile,
): { primary: RgbColor; secondary: RgbColor; accent: RgbColor } {
  const weights = chromaKeys.map((key, index) => ({
    pitch: pitchClasses[index],
    weight: finite01(frame.chroma[key]),
  }));
  const ordered = [...weights].sort((left, right) => right.weight - left.weight);
  const total = weights.reduce((sum, item) => sum + item.weight, 0);

  if (total < 0.0001) {
    return {
      primary: hexToRgb(profile.pitchColors.C),
      secondary: hexToRgb(profile.pitchColors.G),
      accent: hexToRgb(profile.pitchColors.A),
    };
  }

  const weighted: [number, number, number] = [0, 0, 0];
  for (const item of weights) {
    const color = hexToRgb(profile.pitchColors[item.pitch]);
    weighted[0] += color[0] * item.weight / total;
    weighted[1] += color[1] * item.weight / total;
    weighted[2] += color[2] * item.weight / total;
  }

  return {
    primary: weighted,
    secondary: hexToRgb(profile.pitchColors[ordered[1]?.pitch ?? ordered[0].pitch]),
    accent: hexToRgb(profile.pitchColors[ordered[2]?.pitch ?? offsetPitch(ordered[0].pitch, 7)]),
  };
}

function offsetPitch(pitch: PitchClass, offset: number): PitchClass {
  const index = pitchClasses.indexOf(pitch);
  return pitchClasses[(index + offset) % pitchClasses.length];
}

function interpolateState(current: VisualState, target: VisualState, factor: number): VisualState {
  const lerp = (from: number, to: number) => from + (to - from) * factor;
  const lerpColor = (from: RgbColor, to: RgbColor): RgbColor => [
    lerp(from[0], to[0]),
    lerp(from[1], to[1]),
    lerp(from[2], to[2]),
  ];

  return {
    layers: target.layers,
    primaryColor: lerpColor(current.primaryColor, target.primaryColor),
    secondaryColor: lerpColor(current.secondaryColor, target.secondaryColor),
    accentColor: lerpColor(current.accentColor, target.accentColor),
    brightness: lerp(current.brightness, target.brightness),
    saturation: lerp(current.saturation, target.saturation),
    fluidity: lerp(current.fluidity, target.fluidity),
    sharpness: lerp(current.sharpness, target.sharpness),
    density: lerp(current.density, target.density),
    depth: lerp(current.depth, target.depth),
    persistence: lerp(current.persistence, target.persistence),
    turbulence: lerp(current.turbulence, target.turbulence),
    scale: lerp(current.scale, target.scale),
    particleDensity: lerp(current.particleDensity, target.particleDensity),
    impulseStrength: lerp(current.impulseStrength, target.impulseStrength),
    spacing: lerp(current.spacing, target.spacing),
    structuralOrder: lerp(current.structuralOrder, target.structuralOrder),
    stereoBalance: lerp(current.stereoBalance, target.stereoBalance),
    stereoWidth: lerp(current.stereoWidth, target.stereoWidth),
  };
}

function hexToRgb(hex: string): RgbColor {
  const value = Number.parseInt(hex.slice(1), 16);
  return [
    ((value >> 16) & 0xff) / 255,
    ((value >> 8) & 0xff) / 255,
    (value & 0xff) / 255,
  ];
}

function finite01(value: number): number {
  return Number.isFinite(value) ? clamp01(value) : 0;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
