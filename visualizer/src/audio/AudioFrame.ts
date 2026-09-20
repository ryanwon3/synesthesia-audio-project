export const pitchClasses = [
  "C",
  "CSharp",
  "D",
  "DSharp",
  "E",
  "F",
  "FSharp",
  "G",
  "GSharp",
  "A",
  "ASharp",
  "B",
] as const;

export type PitchClass = (typeof pitchClasses)[number];

export type ChromaVector = Record<Uncapitalize<PitchClass>, number>;
export interface AudioBandFrame { chroma: ChromaVector; chromaConfidence: number; attack: number }

export interface AudioFrame {
  sequence: number;
  timestampUnixMilliseconds: number;
  captureTimestamp: number;
  dspCompletedTimestamp: number;
  rms: number;
  bassEnergy: number;
  midEnergy: number;
  trebleEnergy: number;
  spectralCentroid: number;
  spectralFlux: number;
  onsetStrength: number;
  stereoBalance: number;
  stereoWidth: number;
  chroma: ChromaVector;
  dominantPitchClass: PitchClass | null;
  chromaConfidence: number;
  bass?: AudioBandFrame;
  mid?: AudioBandFrame;
  treble?: AudioBandFrame;
}

export interface AudioFrameMessage {
  protocolVersion: 1;
  type: "audioFrame";
  payload: AudioFrame;
}

export const silentAudioFrame: AudioFrame = {
  sequence: 0,
  timestampUnixMilliseconds: 0,
  captureTimestamp: 0,
  dspCompletedTimestamp: 0,
  rms: 0,
  bassEnergy: 0,
  midEnergy: 0,
  trebleEnergy: 0,
  spectralCentroid: 0,
  spectralFlux: 0,
  onsetStrength: 0,
  stereoBalance: 0.5,
  stereoWidth: 0,
  chroma: {
    c: 0,
    cSharp: 0,
    d: 0,
    dSharp: 0,
    e: 0,
    f: 0,
    fSharp: 0,
    g: 0,
    gSharp: 0,
    a: 0,
    aSharp: 0,
    b: 0,
  },
  dominantPitchClass: null,
  chromaConfidence: 0,
};

export function isAudioFrameMessage(value: unknown): value is AudioFrameMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const message = value as Partial<AudioFrameMessage>;
  return message.protocolVersion === 1 &&
    message.type === "audioFrame" &&
    typeof message.payload?.sequence === "number" &&
    typeof message.payload.rms === "number" &&
    isChroma(message.payload.chroma) &&
    [message.payload.bass, message.payload.mid, message.payload.treble].every(band => band == null ||
      isChroma(band.chroma) && unit(band.chromaConfidence) && unit(band.attack));
}

function unit(value: unknown): boolean { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1; }
function isChroma(value: unknown): value is ChromaVector {
  return value !== null && typeof value === "object" && pitchClasses.every(pitch =>
    unit((value as Record<string, unknown>)[pitch.charAt(0).toLowerCase() + pitch.slice(1)]));
}
