import { describe, expect, it, vi } from "vitest";
import { pitchClasses } from "../audio/AudioFrame";
import type { SynesthesiaProfile } from "./SynesthesiaProfile";
import { publicDefaultProfile } from "./PublicDefaultProfile";

// Sentinel: fails if the factory's module graph loads the private profile. Contents are never read.
vi.mock("../../../profiles/synesthesia.json", () => {
  throw new Error("Private profile JSON must not be imported");
});

const weights = ["bassDeformation", "midStructure", "trebleParticles", "transientImpulse",
  "persistence", "movement", "sharpness", "softness", "depth", "smoothing"] as const;

describe("publicDefaultProfile", () => {
  it("returns a neutral, visibly uncalibrated template", () => {
    const profile: SynesthesiaProfile = publicDefaultProfile();
    expect(Object.keys(profile).sort()).toEqual(
      ["colorMode", "name", "pitchColors", "response", "schemaVersion"]);
    expect(profile.schemaVersion).toBe(1);
    expect(profile.name).toBe("Uncalibrated public template");
    expect(profile.colorMode).toBe("personal");
    expect(Object.keys(profile.pitchColors).sort()).toEqual([...pitchClasses].sort());
    for (const pitch of pitchClasses) expect(profile.pitchColors[pitch]).toBe("#808080");
    expect(Object.keys(profile.response).sort()).toEqual(
      [...weights, "attackMs", "releaseMs"].sort());
    for (const key of weights) expect(profile.response[key]).toBe(0.5);
    expect(profile.response.attackMs).toBe(40);
    expect(profile.response.releaseMs).toBe(300);
  });

  it("returns an independent deep copy on each call", () => {
    const first = publicDefaultProfile();
    first.name = "Mutated";
    first.pitchColors.C = "#ff0000";
    first.response.depth = 1;
    first.response.attackMs = 200;
    const fresh = publicDefaultProfile();
    expect(fresh).not.toBe(first);
    expect(fresh.pitchColors).not.toBe(first.pitchColors);
    expect(fresh.response).not.toBe(first.response);
    expect(fresh.name).toBe("Uncalibrated public template");
    expect(fresh.pitchColors.C).toBe("#808080");
    expect(fresh.response.depth).toBe(0.5);
    expect(fresh.response.attackMs).toBe(40);
  });
});
