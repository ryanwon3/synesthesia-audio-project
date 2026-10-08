import { describe, expect, it } from "vitest";
import { exportProfile, parseProfileImport, readProfileFile } from "./ProfileTransfer";
import { isSynesthesiaProfile, type SynesthesiaResponse } from "./SynesthesiaProfile";
import { testProfile } from "./profile.test-fixtures";

const responseKeys: (keyof SynesthesiaResponse)[] = [
  "bassDeformation", "midStructure", "trebleParticles", "transientImpulse",
  "persistence", "movement", "sharpness", "softness", "depth", "smoothing",
  "attackMs", "releaseMs",
];

describe("profile transfer and validation", () => {
  it("RoundTripsEveryPitchAndResponseValue without changing color case or optional values", () => {
    const profile = testProfile();
    expect(parseProfileImport(exportProfile(profile))).toEqual({ ok: true, profile });
  });
  it("preserves legacy profiles without adding optional settings", () => {
    const profile = testProfile();
    delete profile.layers;
    delete profile.colorMode;
    expect(parseProfileImport(exportProfile(profile))).toEqual({ ok: true, profile });
  });
  it("validates the same stable snapshot that it exports", () => {
    const profile = testProfile();
    let reads = 0;
    Object.defineProperty(profile.response, "movement", {
      enumerable: true, get: () => ++reads === 1 ? 0.5 : NaN,
    });
    const result = parseProfileImport(exportProfile(profile));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.profile.response.movement).toBe(0.5);
  });
  it.each(responseKeys)("RejectsPartialOrNonFiniteProfile: missing required response %s", (key) => {
    const profile = testProfile();
    delete (profile.response as Partial<SynesthesiaResponse>)[key];
    expect(isSynesthesiaProfile(profile)).toBe(false);
    expect(parseProfileImport(JSON.stringify(profile)).ok).toBe(false);
  });
  it.each([NaN, Infinity, -Infinity, -0.01, 1.01])("rejects invalid response weight %s", (value) => {
    const profile = testProfile();
    profile.response.movement = value;
    expect(isSynesthesiaProfile(profile)).toBe(false);
    expect(() => exportProfile(profile)).toThrow();
  });
  it.each([
    ["attackMs", 9], ["attackMs", 301], ["releaseMs", 99], ["releaseMs", 1501],
  ] as const)("rejects %s outside its UI range (%s)", (key, value) => {
    const profile = testProfile();
    profile.response[key] = value;
    expect(isSynesthesiaProfile(profile)).toBe(false);
  });
  it("accepts every exact response boundary", () => {
    const low = testProfile();
    const high = testProfile();
    for (const key of responseKeys) {
      low.response[key] = key === "attackMs" ? 10 : key === "releaseMs" ? 100 : 0;
      high.response[key] = key === "attackMs" ? 300 : key === "releaseMs" ? 1500 : 1;
    }
    expect(parseProfileImport(JSON.stringify(low))).toEqual({ ok: true, profile: low });
    expect(parseProfileImport(JSON.stringify(high))).toEqual({ ok: true, profile: high });
  });
  it.each([null, [], {}, { bass: 1 }, { moodInfluence: 0, bass: 1, mid: 1, treble: 2 }])(
    "rejects invalid optional layer settings %j", (layers) => {
      expect(isSynesthesiaProfile({ ...testProfile(), layers })).toBe(false);
    });
  it.each(["unknown", null, 1])("rejects invalid optional color mode %s", (colorMode) => {
    expect(isSynesthesiaProfile({ ...testProfile(), colorMode })).toBe(false);
  });
  it.each([
    { name: "" }, { name: "x".repeat(129) }, { schemaVersion: 2 }, { unknown: "unbounded extension" },
  ])("rejects invalid or unsupported profile fields %j", (change) => {
    expect(isSynesthesiaProfile({ ...testProfile(), ...change })).toBe(false);
  });
  it("rejects missing/extra pitch colors and malformed colors", () => {
    const profile = testProfile();
    expect(isSynesthesiaProfile({ ...profile, pitchColors: { ...profile.pitchColors, B: "red" } })).toBe(false);
    expect(isSynesthesiaProfile({ ...profile, pitchColors: { ...profile.pitchColors, extra: "#ffffff" } })).toBe(false);
    delete (profile.pitchColors as Partial<typeof profile.pitchColors>).B;
    expect(isSynesthesiaProfile(profile)).toBe(false);
  });
  it("accepts exactly 64 KiB of UTF8 text but rejects one byte more", () => {
    const json = JSON.stringify(testProfile());
    const exact = " ".repeat(65_536 - json.length) + json;
    expect(parseProfileImport(exact).ok).toBe(true);
    expect(parseProfileImport(" " + exact).ok).toBe(false);
  });
  it("measures UTF8 bytes rather than character count", () => {
    const profile = { ...testProfile(), name: "é".repeat(100) };
    const json = JSON.stringify(profile);
    const text = " ".repeat(65_536 - json.length) + json;
    const result = parseProfileImport(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/64 KiB/);
  });
  it.each(["", "{", "null", "[]", '{"schemaVersion":1}'])("reports malformed import without throwing (%s)", (text) => {
    expect(parseProfileImport(text).ok).toBe(false);
  });
  it("rejects an oversized file before reading it", async () => {
    let wasRead = false;
    const file = { size: 65_537, text: async () => { wasRead = true; return JSON.stringify(testProfile()); } } as File;
    const result = await readProfileFile(file);
    expect(result.ok).toBe(false);
    expect(wasRead).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/64 KiB/);
  });
  it("reads and validates a selected file", async () => {
    const file = new File([JSON.stringify(testProfile())], "synthetic.json", { type: "application/json" });
    expect(await readProfileFile(file)).toEqual({ ok: true, profile: testProfile() });
  });
  it("handles file read failure without echoing the file or error", async () => {
    const file = new File(["unreadable synthetic input"], "synthetic.json");
    file.text = async () => { throw new Error("private local path"); };
    const result = await readProfileFile(file);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).not.toContain("private local path");
  });
});
