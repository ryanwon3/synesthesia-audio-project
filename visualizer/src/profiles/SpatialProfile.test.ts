import { describe, expect, it } from "vitest";
import type { CurrentTrack } from "../song/SongContext";
import { ProfileStore } from "./ProfileStore";
import { exportProfile, fitsProfileSize, parseProfileImport } from "./ProfileTransfer";
import { ACTIVE_KEY, BACKUP_KEY, testProfile, TestStorage } from "./profile.test-fixtures";
import { defaultSpatialPreferences, isSpatialPreferences, resolveSpatialTheme, type SongThemeOverride } from "./SpatialProfile";
import { isSynesthesiaProfile } from "./SynesthesiaProfile";

const track = (id = "syntheticTrackA", title = "back to friends", artist = "sombr"): CurrentTrack => ({
  spotifyTrackId: id, title, artists: [{ spotifyArtistId: null, name: artist }],
  spotifyUri: null, isrc: null, album: null, durationMs: null, explicit: null,
  progressMs: null, isPlaying: true, observedAtUtc: "2026-10-08T00:00:00Z",
});
const override = (id: string | null, color = "#b88654"): SongThemeOverride => ({
  match: { spotifyTrackId: id, title: "back to friends", artist: "sombr" },
  themeId: "bronze-rain-glass", waveColor: color,
});
const spatialProfile = () => ({ ...testProfile(), spatial: defaultSpatialPreferences() });

describe("spatial profile ownership", () => {
  it("legacyProfileRetainsAllValues", () => {
    const legacy = testProfile();
    expect(parseProfileImport(exportProfile(legacy))).toEqual({ ok: true, profile: legacy });
    expect(Object.hasOwn(legacy, "spatial")).toBe(false);
    expect(defaultSpatialPreferences().mode).toBe("painting");
    expect(defaultSpatialPreferences().songOverrides).toEqual([]);
  });
  it("round trips every optional setting and local override through the existing store", () => {
    const profile = spatialProfile();
    profile.spatial.songOverrides.push(override(null));
    profile.spatial.waveStrength = 0.23;
    const storage = new TestStorage();
    const store = new ProfileStore(storage);
    expect(store.replace(profile)).toEqual({ ok: true, profile });
    expect(store.load()).toEqual({ profile, warning: null });
    expect(parseProfileImport(exportProfile(profile))).toEqual({ ok: true, profile });
  });
  it("themeDoesNotMutatePitchColors or install an association", () => {
    const profile = testProfile();
    const original = structuredClone(profile);
    expect(resolveSpatialTheme(profile, track(), "bronze-rain-glass")).toEqual({
      id: "bronze-rain-glass", background: [0, 0, 0], waveColorOverride: [184 / 255, 134 / 255, 84 / 255],
    });
    expect(profile).toEqual(original);
    expect(resolveSpatialTheme(profile, track(), null).id).toBe("personal");
  });
  it("exactSongOverrideWins by ID before an earlier title fallback", () => {
    const profile = spatialProfile();
    profile.spatial.songOverrides = [override(null, "#112233"), override("syntheticTrackA", "#445566")];
    expect(resolveSpatialTheme(profile, track(), null).waveColorOverride).toEqual([68 / 255, 85 / 255, 102 / 255]);
  });
  it("ID match survives changed display spelling but never guesses IDs from names", () => {
    const profile = spatialProfile();
    profile.spatial.songOverrides = [override("syntheticTrackA")];
    expect(resolveSpatialTheme(profile, track("syntheticTrackA", "Other display", "Other display"), null).id).toBe("bronze-rain-glass");
    expect(resolveSpatialTheme(profile, track("syntheticTrackB"), null).id).toBe("personal");
  });
  it("normalizes exact title and a credited artist only for ID-less overrides", () => {
    const profile = spatialProfile();
    profile.spatial.songOverrides = [override(null)];
    expect(resolveSpatialTheme(profile, track("syntheticTrackA", "  BACK  TO FRIENDS  ", " SOMBR "), null).id).toBe("bronze-rain-glass");
    expect(resolveSpatialTheme(profile, track("syntheticTrackA", "back to friends (live)", "sombr"), null).id).toBe("personal");
    expect(resolveSpatialTheme(profile, track("syntheticTrackA", "back to friends", "other artist"), null).id).toBe("personal");
  });
  it("unknownSongDoesNotInheritOverride and manual personal wins over saved theme", () => {
    const profile = spatialProfile();
    profile.spatial.songOverrides = [override(null)];
    expect(resolveSpatialTheme(profile, track("other", "Other song"), null).id).toBe("personal");
    expect(resolveSpatialTheme(profile, null, null).id).toBe("personal");
    expect(resolveSpatialTheme(profile, track(), "personal").waveColorOverride).toBeNull();
  });
  it("manual bronze applies only a valid session tint and never outranks personal or saved overrides", () => {
    const profile = spatialProfile();
    profile.spatial.songOverrides = [override("syntheticTrackA", "#445566")];
    const original = structuredClone(profile);
    expect(resolveSpatialTheme(profile, track(), "bronze-rain-glass", "#a1b2c3")).toEqual({
      id: "bronze-rain-glass", background: [0, 0, 0], waveColorOverride: [161 / 255, 178 / 255, 195 / 255],
    });
    for (const invalid of ["a1b2c3", "#a1b2c", "#a1b2c3d4", "#zzzzzz", null]) {
      expect(resolveSpatialTheme(profile, track(), "bronze-rain-glass", invalid).waveColorOverride)
        .toEqual([184 / 255, 134 / 255, 84 / 255]);
    }
    expect(resolveSpatialTheme(profile, track(), "personal", "#a1b2c3")).toMatchObject({ id: "personal", waveColorOverride: null });
    // Without a manual theme the saved song override still wins over any supplied tint.
    expect(resolveSpatialTheme(profile, track(), null, "#a1b2c3").waveColorOverride).toEqual([68 / 255, 85 / 255, 102 / 255]);
    expect(profile).toEqual(original);
  });
  it("invalidSpatialImportPreservesBackup and active bytes", () => {
    const storage = new TestStorage();
    storage.setItem(ACTIVE_KEY, JSON.stringify(testProfile()));
    storage.setItem(BACKUP_KEY, "earlier original");
    const profile = spatialProfile();
    profile.spatial.depth = NaN;
    expect(new ProfileStore(storage).replace(profile).ok).toBe(false);
    expect(storage.getItem(ACTIVE_KEY)).toBe(JSON.stringify(testProfile()));
    expect(storage.getItem(BACKUP_KEY)).toBe("earlier original");
  });
  it("accepts full finite bounded preferences, including endpoints", () => {
    const prefs = defaultSpatialPreferences();
    prefs.waveStrength = 0;
    prefs.depth = 1;
    expect(isSpatialPreferences(prefs)).toBe(true);
    expect(isSynesthesiaProfile(spatialProfile())).toBe(true);
  });
  it.each(["waveStrength", "rainStrength", "glassStrength", "fallSpeed", "waveScale", "rainPersistence", "depth"] as const)(
    "rejects missing, nonfinite, and out-of-range %s", key => {
      for (const value of [undefined, null, NaN, Infinity, -0.01, 1.01, "0.5"]) {
        expect(isSpatialPreferences({ ...defaultSpatialPreferences(), [key]: value })).toBe(false);
      }
    });
  it.each([
    { schemaVersion: 2 }, { mode: "other" }, { songOverrides: Array(33).fill(override(null)) },
    { songOverrides: [ { ...override(null), themeId: "generated" } ] },
    { songOverrides: [ { ...override(null), waveColor: "bronze" } ] },
    { songOverrides: [ { ...override(null), match: { ...override(null).match, title: "x".repeat(257) } } ] },
    { songOverrides: [ { ...override(null), match: { ...override(null).match, artist: "x".repeat(129) } } ] },
    { songOverrides: [ { ...override(null), match: { ...override(null).match, spotifyTrackId: "x".repeat(129) } } ] },
    { songOverrides: [ { ...override(null), match: { ...override(null).match, spotifyTrackId: " " } } ] },
    { songOverrides: [ { ...override(null), match: { ...override(null).match, title: " " } } ] },
    { unexpected: true }, { songOverrides: [{ ...override(null), unexpected: true }] },
    { songOverrides: [{ ...override(null), match: { ...override(null).match, unexpected: true } }] },
  ])("rejects malformed/unknown/bounded theme structure %#", malformed => {
    expect(isSpatialPreferences({ ...defaultSpatialPreferences(), ...malformed })).toBe(false);
  });
  it("invalid optional preferences cannot select a theme even when passed directly", () => {
    const profile = spatialProfile();
    profile.spatial.songOverrides = [override(null, "not a color")];
    expect(resolveSpatialTheme(profile, track(), null)).toEqual(resolveSpatialTheme(testProfile(), track(), null));
  });
  it("returns independent default arrays", () => {
    defaultSpatialPreferences().songOverrides.push(override(null));
    expect(defaultSpatialPreferences().songOverrides).toEqual([]);
  });
  it("rejects canonical output over 64 KiB even when its compact input fits", () => {
    const profile = spatialProfile();
    profile.spatial.songOverrides = Array.from({ length: 32 }, () => ({
      ...override(null), match: { spotifyTrackId: null, title: "\0".repeat(256), artist: "\0".repeat(40) + "x".repeat(88) },
    }));
    const compact = JSON.stringify(profile);
    const canonical = JSON.stringify(profile, null, 2) + "\n";
    expect(isSynesthesiaProfile(profile)).toBe(true);
    expect(fitsProfileSize(compact)).toBe(true);
    expect(fitsProfileSize(canonical)).toBe(false);
    expect(() => exportProfile(profile)).toThrow(/64 KiB/i);
    expect(parseProfileImport(compact)).toEqual({ ok: false, message: expect.stringMatching(/64 KiB/i) });
  });
  it("oversized canonical serialization cannot replace active or backup bytes", () => {
    const storage = new TestStorage();
    const saved = JSON.stringify(testProfile());
    storage.setItem(ACTIVE_KEY, saved);
    storage.setItem(BACKUP_KEY, "prior saved original");
    const profile = spatialProfile();
    profile.spatial.songOverrides = Array.from({ length: 32 }, () => ({
      ...override(null), match: { spotifyTrackId: null, title: "\0".repeat(256), artist: "\0".repeat(40) + "x".repeat(88) },
    }));
    expect(new ProfileStore(storage).replace(profile).ok).toBe(false);
    expect(storage.getItem(ACTIVE_KEY)).toBe(saved);
    expect(storage.getItem(BACKUP_KEY)).toBe("prior saved original");
    expect(new ProfileStore(storage).load()).toEqual({ profile: testProfile(), warning: null });
  });
});
