import { describe, it, expect } from "vitest";
import { initialSongContext } from "./SongContext";
import { neutralTraits, songTraits, tagTraits, isVisualProfile } from "./SongVisualProfile";
import { RipplePool } from "../visuals/RipplePool";
import { silentAudioFrame } from "../audio/AudioFrame";
import { defaultSynesthesiaProfile } from "../profiles/SynesthesiaProfile";
import { VisualContextEngine } from "../mappings/VisualContextEngine";
import { moodPitchColors } from "../mappings/MoodPalette";

describe("Song-aware layers", () => {
  it("maps every sad-palette pitch to a distinct blue/purple shade without changing personal colors", () => {
    const palette = moodPitchColors("sad", 2);
    expect(palette.every(([r, g, b]) => b > r && b > g)).toBe(true);
    expect(new Set(palette.map(color => color.join(","))).size).toBe(12);
    const profile = defaultSynesthesiaProfile(), original = structuredClone(profile.pitchColors);
    profile.colorMode = "mood";
    new VisualContextEngine().update(silentAudioFrame, profile, 10);
    expect(profile.pitchColors).toEqual(original);
  });
  it("gives personal visual overrides precedence over generated analysis", () => {
    const song = structuredClone(initialSongContext);
    song.activeProfile = { reserved: { personalOverrides: { visualProfile: { wholeSong: { ...neutralTraits, mood: "joyful" }, sections: [] } } } } as unknown as typeof song.activeProfile;
    song.lyricsAnalysis = { status: "Ready", source: "fixture", timed: false, cached: false, error: null,
      profile: { wholeSong: { ...neutralTraits, mood: "sad" }, sections: [] } };
    expect(songTraits(song).mood).toBe("joyful");
  });
  it("keeps sustained bass from repeatedly creating ripples", () => {
    const pool = new RipplePool();
    for (let i = 0; i < 120; i++) pool.update(0.9, 0.7, 0.5, 1 / 60);
    expect(pool.rings.filter(r => r.strength > 0)).toHaveLength(1);
    pool.update(0, 0.7, 0.5, 0.3); pool.update(0.9, 0.7, 0.5, 0.02);
    expect(pool.rings.filter(r => r.strength > 0)).toHaveLength(2);
  });
  it("does not produce bass ripples for treble-only energy", () => {
    const pool = new RipplePool(); pool.update(0.9, 0, 0.5, 1);
    expect(pool.rings.every(r => r.strength === 0)).toBe(true);
    const engine = new VisualContextEngine();
    const state = engine.update({ ...silentAudioFrame, trebleEnergy: 0.8,
      bass: { chroma: silentAudioFrame.chroma, chromaConfidence: 0, attack: 0 },
      treble: { chroma: silentAudioFrame.chroma, chromaConfidence: 0, attack: 1 } }, defaultSynesthesiaProfile(), 1);
    expect(state.layers[0].energy).toBe(0); expect(state.layers[0].attack).toBe(0);
    expect(state.layers[2].energy).toBeGreaterThan(0.9);
  });
  it("keeps silence quiet and allows individual layers to be hidden", () => {
    const engine = new VisualContextEngine(), profile = defaultSynesthesiaProfile();
    profile.layers = { bass: 0, mid: 1, treble: 1, moodInfluence: 0.8 };
    expect(engine.update({ ...silentAudioFrame, bassEnergy: 1 }, profile, 5).layers[0].energy).toBe(0);
    expect(engine.update(silentAudioFrame, profile, 5).layers.every(l => l.energy < 0.001)).toBe(true);
  });
  it("treats sad pop as sad but does not assume that all pop is sad", () => {
    const song = structuredClone(initialSongContext);
    song.lastFm = { trackTags: [{ name: "sad pop", weight: 1 }], artistTags: [{ name: "happy", weight: 1 }] } as typeof song.lastFm;
    expect(tagTraits(song).mood).toBe("sad");
    song.lastFm!.trackTags = [{ name: "pop", weight: 1 }]; song.lastFm!.artistTags = [{ name: "my top songs", weight: 1 }];
    expect(tagTraits(song).mood).toBe("neutral");
  });
  it("follows real section timestamps, seeks, pauses, replay and gaps", () => {
    const song = structuredClone(initialSongContext);
    song.currentTrack = { spotifyTrackId: "a", progressMs: 5000, durationMs: 60000, isPlaying: true,
      observedAtUtc: new Date(0).toISOString() } as typeof song.currentTrack;
    song.lyricsAnalysis = { profile: { wholeSong: neutralTraits,
      sections: [{ startMs: 10000, endMs: 20000, traits: { ...neutralTraits, mood: "sad" } }] } } as typeof song.lyricsAnalysis;
    expect(songTraits(song, 6000).mood).toBe("sad");
    song.currentTrack!.isPlaying = false; expect(songTraits(song, 6000).mood).toBe("neutral");
    song.currentTrack!.progressMs = 12000; expect(songTraits(song, 90000).mood).toBe("sad");
    song.currentTrack!.progressMs = 0; expect(songTraits(song, 90000).mood).toBe("neutral");
    song.currentTrack!.progressMs = 25000; expect(songTraits(song, 90000).mood).toBe("neutral");
  });
  it("rejects malformed AI profiles", () => {
    expect(isVisualProfile({ wholeSong: { ...neutralTraits, energy: NaN }, sections: [] })).toBe(false);
    expect(isVisualProfile({ wholeSong: { ...neutralTraits, bassEffect: "executeCode" }, sections: [] })).toBe(false);
  });
});
