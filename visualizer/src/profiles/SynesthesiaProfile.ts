import defaultProfileJson from "../../../profiles/synesthesia.json";
import { pitchClasses, type PitchClass } from "../audio/AudioFrame";

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
}

const storageKey = "spotify-synesthesia.profile.v1";

export function defaultSynesthesiaProfile(): SynesthesiaProfile {
  return structuredClone(defaultProfileJson) as SynesthesiaProfile;
}

export function loadSynesthesiaProfile(): SynesthesiaProfile {
  const fallback = defaultSynesthesiaProfile();

  try {
    const stored = localStorage.getItem(storageKey);
    if (!stored) {
      return fallback;
    }

    const candidate: unknown = JSON.parse(stored);
    return isSynesthesiaProfile(candidate) ? candidate : fallback;
  } catch {
    return fallback;
  }
}

export function saveSynesthesiaProfile(profile: SynesthesiaProfile): void {
  localStorage.setItem(storageKey, JSON.stringify(profile));
}

export function resetSynesthesiaProfile(): SynesthesiaProfile {
  localStorage.removeItem(storageKey);
  return defaultSynesthesiaProfile();
}

export function isSynesthesiaProfile(value: unknown): value is SynesthesiaProfile {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<SynesthesiaProfile>;
  if (candidate.schemaVersion !== 1 ||
      typeof candidate.name !== "string" ||
      !candidate.pitchColors ||
      !candidate.response) {
    return false;
  }

  const colorsValid = pitchClasses.every((pitch) => isHexColor(candidate.pitchColors?.[pitch]));
  if (candidate.colorMode !== undefined && candidate.colorMode !== "personal" && candidate.colorMode !== "mood") return false;
  if (candidate.layers && ![candidate.layers.moodInfluence, candidate.layers.bass, candidate.layers.mid, candidate.layers.treble]
      .every(item => Number.isFinite(item) && item >= 0 && item <= 1)) return false;
  const responseValues = Object.values(candidate.response);
  return colorsValid && responseValues.every((item) => typeof item === "number" && Number.isFinite(item));
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}
