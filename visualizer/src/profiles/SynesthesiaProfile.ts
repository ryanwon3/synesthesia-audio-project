import defaultProfileJson from "../../../profiles/synesthesia.json";
import { pitchClasses, type PitchClass } from "../audio/AudioFrame";
import { isSpatialPreferences, type SpatialPreferences } from "./SpatialProfile";

export interface SynesthesiaResponse {
  bassDeformation: number;
  midStructure: number;
  trebleParticles: number;
  transientImpulse: number;
  persistence: number;
  movement: number;
  sharpness: number;
  softness: number;
  depth: number;
  smoothing: number;
  attackMs: number;
  releaseMs: number;
}

export interface SynesthesiaProfile {
  schemaVersion: 1;
  name: string;
  pitchColors: Record<PitchClass, string>;
  response: SynesthesiaResponse;
  layers?: { moodInfluence: number; bass: number; mid: number; treble: number };
  colorMode?: "personal" | "mood";
  spatial?: SpatialPreferences;
}

export function defaultSynesthesiaProfile(): SynesthesiaProfile {
  return structuredClone(defaultProfileJson) as SynesthesiaProfile;
}

export function isSynesthesiaProfile(value: unknown): value is SynesthesiaProfile {
  if (!hasShape(value, ["schemaVersion", "name", "pitchColors", "response"], ["layers", "colorMode", "spatial"])) return false;
  if (value.schemaVersion !== 1 || typeof value.name !== "string" ||
      value.name.trim().length === 0 || value.name.length > 128) return false;
  const colors = value.pitchColors;
  if (!hasShape(colors, pitchClasses) ||
      !pitchClasses.every((pitch) => isHexColor(colors[pitch]))) return false;

  const weights = ["bassDeformation", "midStructure", "trebleParticles", "transientImpulse",
    "persistence", "movement", "sharpness", "softness", "depth", "smoothing"] as const;
  const response = value.response;
  if (!hasShape(response, [...weights, "attackMs", "releaseMs"]) ||
      !weights.every((key) => inRange(response[key], 0, 1)) ||
      !inRange(response.attackMs, 10, 300) || !inRange(response.releaseMs, 100, 1500)) return false;

  if (Object.hasOwn(value, "colorMode") && value.colorMode !== "personal" && value.colorMode !== "mood") return false;
  if (Object.hasOwn(value, "spatial") && !isSpatialPreferences(value.spatial)) return false;
  if (Object.hasOwn(value, "layers")) {
    const layers = value.layers;
    const keys = ["moodInfluence", "bass", "mid", "treble"] as const;
    if (!hasShape(layers, keys) || !keys.every((key) => inRange(layers[key], 0, 1))) return false;
  }
  return true;
}

function hasShape(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function inRange(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}
