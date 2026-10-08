import type { SynesthesiaProfile } from "./SynesthesiaProfile";

export function publicDefaultProfile(): SynesthesiaProfile {
  return {
    schemaVersion: 1,
    name: "Uncalibrated public template",
    colorMode: "personal",
    pitchColors: {
      C: "#808080",
      CSharp: "#808080",
      D: "#808080",
      DSharp: "#808080",
      E: "#808080",
      F: "#808080",
      FSharp: "#808080",
      G: "#808080",
      GSharp: "#808080",
      A: "#808080",
      ASharp: "#808080",
      B: "#808080",
    },
    response: {
      bassDeformation: 0.5,
      midStructure: 0.5,
      trebleParticles: 0.5,
      transientImpulse: 0.5,
      persistence: 0.5,
      movement: 0.5,
      sharpness: 0.5,
      softness: 0.5,
      depth: 0.5,
      smoothing: 0.5,
      attackMs: 40,
      releaseMs: 300,
    },
  };
}
