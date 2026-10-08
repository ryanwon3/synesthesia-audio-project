import { describe, expect, it } from "vitest";
import { cloudSongStatuses, isCloudSongContext, type CloudSongContextV1, type CloudSongStatus } from "../../../shared/CloudSongContext";
import { toLocalSongContext } from "./CloudContextAdapter";
import { initialSongContext, isSongContextMessage, normalizeSongContext, type SongContextSnapshot, type SpotifyMetadataStatus } from "./SongContext";

// Synthetic DTOs only; adapter unit tests, not end-to-end.
const at = "2026-01-01T00:00:00.000Z";
const id = (c: string): string => `Synth${c.repeat(17)}`;

function dto(status: CloudSongStatus = "playing"): CloudSongContextV1 {
  const base = {
    protocolVersion: 1 as const, status, observedAtUtc: at, capabilities: { lyrics: true, ai: true },
    nextRetryUtc: status === "rateLimited" ? "2026-01-01T00:01:00.000Z" : null,
  };
  if (status !== "playing" && status !== "paused") return { ...base, track: null, trackTags: [], artistTags: [], analysis: null };
  const t = id("A");
  return {
    ...base, analysis: null, trackTags: [{ name: "dreamy", weight: 1 }], artistTags: [{ name: "shoegaze", weight: null }],
    track: {
      spotifyTrackId: t, spotifyUri: `spotify:track:${t}`, isrc: "USSYN2600001", title: "Synthetic title",
      artists: [{ spotifyArtistId: id("R"), name: "Synthetic artist" }],
      album: { spotifyAlbumId: id("L"), name: "Synthetic album", artworkUrl: "https://artwork.example/a.jpg", releaseDate: "2020-05-01", releaseDatePrecision: "day" },
      durationMs: 180_000, explicit: false, progressMs: 1_000, isPlaying: status === "playing", observedAtUtc: at,
    },
  };
}

const expected: Record<CloudSongStatus, SpotifyMetadataStatus> = {
  playing: "playingTrack", paused: "pausedTrack", none: "noPlayback", signedOut: "authenticationRequired",
  forbidden: "forbidden", unavailable: "metadataUnavailable", rateLimited: "rateLimited",
};
const allowed = new Set<string>([...Object.keys(initialSongContext), "lyricsAnalysis", "lyricsSettings"]);

function expectLocal(s: SongContextSnapshot): void {
  expect(isSongContextMessage({ protocolVersion: 1, type: "songContext", payload: s })).toBe(true);
  expect(normalizeSongContext(s)).toEqual(s);
  expect(Object.keys(s).filter((k) => !allowed.has(k))).toEqual([]);
  // Secret-free cloud label, not a filesystem path; no model settings, tokens or colors.
  expect(s.databasePath).toBe("cloud");
  expect(s.lyricsSettings ?? null).toBeNull();
  expect(JSON.stringify(s)).not.toMatch(/#[0-9a-f]{6}|token|secret/i);
}

describe("toLocalSongContext", () => {
  it("maps all seven strictly valid cloud statuses onto legacy enums", () => {
    for (const status of cloudSongStatuses) {
      expect(isCloudSongContext(dto(status)), status).toBe(true);
      const s = toLocalSongContext(dto(status));
      expect(s.metadataStatus, status).toBe(expected[status]);
      expect(s.nextRetryUtc, status).toBe(dto(status).nextRetryUtc);
      if (status !== "playing" && status !== "paused") expect(s.currentTrack, status).toBeNull();
      expectLocal(s);
    }
  });

  it("maps a valid playing DTO into a normalized fresh context without mutating it", () => {
    const input = dto();
    const copy = structuredClone(input);
    const s = toLocalSongContext(input);
    expect(input).toEqual(copy);
    expect(s.currentTrack).toEqual(copy.track);
    expect(s.authenticationStatus).toBe("valid");
    expect(s.stale).toBe(false);
    expect(s.lastFm?.trackTags).toEqual(copy.trackTags);
    expect(s.lastFm?.artistTags).toEqual(copy.artistTags);
    expect(s.lyricsAnalysis?.profile ?? null).toBeNull();
    expect(s.activeProfile).toBeNull();
    expect(toLocalSongContext(dto("paused")).currentTrack?.isPlaying).toBe(false);
  });

  it("signedOut clears cached tracks, profiles and tags without colors", () => {
    const s = toLocalSongContext(dto("signedOut"));
    expect(s.authenticationStatus).not.toBe("valid");
    expect(s.currentTrack).toBeNull();
    expect(s.activeProfile).toBeNull();
    expect(s.profileSource).toBeNull();
    expect([...(s.lastFm?.trackTags ?? []), ...(s.lastFm?.artistTags ?? [])]).toEqual([]);
    expect(s.lyricsAnalysis?.profile ?? null).toBeNull();
    expectLocal(s);
  });

  it("rejects malformed DTOs without echoing tokens, raw lyrics or database paths", () => {
    const v = dto();
    const malformed: unknown[] = [
      null, [], { ...v, protocolVersion: 2 }, { ...v, status: "signedOut" },
      { ...v, accessToken: "syntheticSecretToken" },
      { ...v, databasePath: "/home/synthetic/songs.db" },
      { ...v, track: { ...v.track, lyrics: "synthetic raw lyric line" } },
      { ...v, track: { ...v.track, spotifyUri: "spotify:track:other" } },
    ];
    for (const value of malformed) {
      let thrown: unknown = undefined;
      try { toLocalSongContext(value as never); } catch (error) { thrown = error; }
      expect(thrown, JSON.stringify(value)).toBeDefined();
      expect(String(thrown instanceof Error ? thrown.message : thrown)).not.toMatch(/syntheticSecretToken|raw lyric|songs.db/);
    }
  });
});
