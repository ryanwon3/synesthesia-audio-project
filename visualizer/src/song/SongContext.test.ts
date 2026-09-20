import { describe, expect, it } from "vitest";
import {
  extrapolateProgressMs,
  initialSongContext,
  isSongContextMessage,
  normalizeSongContext,
  type SongContextSnapshot,
} from "./SongContext";

describe("song context", () => {
  it("extrapolates only active, fresh playback and clamps to duration", () => {
    const snapshot = withTrack({ progressMs: 9_000, durationMs: 10_000, isPlaying: true });

    expect(extrapolateProgressMs(snapshot, Date.parse("2026-08-12T12:00:02Z"))).toBe(10_000);
    expect(extrapolateProgressMs({ ...snapshot, stale: true }, Date.parse("2026-08-12T12:00:02Z"))).toBe(9_000);
    expect(extrapolateProgressMs(withTrack({ progressMs: 4_000, isPlaying: false }), Date.parse("2026-08-12T12:00:02Z"))).toBe(4_000);
  });

  it("accepts the protocol-v1 snapshot envelope", () => {
    expect(isSongContextMessage({
      protocolVersion: 1,
      type: "songContext",
      payload: initialSongContext,
    })).toBe(true);
    expect(isSongContextMessage({ protocolVersion: 1, type: "audioFrame", payload: {} })).toBe(false);
  });

  it("accepts additive Last.fm state and normalizes legacy v1 snapshots", () => {
    const legacyPayload = { ...initialSongContext } as Record<string, unknown>;
    delete legacyPayload.lastFm;
    delete legacyPayload.openAiConfigured;
    const legacyMessage = {
      protocolVersion: 1,
      type: "songContext",
      payload: legacyPayload,
    };
    const enriched = {
      ...initialSongContext,
      lastFm: {
        status: "succeeded" as const,
        cacheSource: "cached" as const,
        trackTags: [{ name: "dreamy", weight: 1 }],
        artistTags: [{ name: "dream pop", weight: null }],
        matchedTrack: "Title",
        matchedArtist: "Artist",
        trackMusicBrainzId: null,
        artistMusicBrainzId: null,
        matchQuality: "normalized" as const,
        retrievedAtUtc: "2026-08-12T12:00:00Z",
        errorCategory: null,
        nextRetryUtc: null,
      },
    };

    expect(isSongContextMessage(legacyMessage)).toBe(true);
    expect(normalizeSongContext(legacyPayload as unknown as SongContextSnapshot).lastFm).toBeNull();
    expect(normalizeSongContext(legacyPayload as unknown as SongContextSnapshot).openAiConfigured).toBe(false);
    expect(isSongContextMessage({ protocolVersion: 1, type: "songContext", payload: enriched })).toBe(true);
    expect(isSongContextMessage({
      protocolVersion: 1,
      type: "songContext",
      payload: { ...enriched, lastFm: { ...enriched.lastFm, status: "unknown" } },
    })).toBe(false);
  });

  it("accepts every Last.fm enum value and rejects malformed nullable fields", () => {
    const statuses = [
      "notConfigured", "notAttempted", "insufficientIdentity", "fetching", "succeeded",
      "noMatch", "unavailable", "rateLimited", "invalidCredentials", "error",
    ] as const;
    const cacheSources = ["none", "cached", "fetched"] as const;
    const matchQualities = ["exact", "normalized", "providerCorrected"] as const;
    const errorCategories = [
      "insufficientIdentity", "invalidApiKey", "suspendedApiKey", "rateLimit", "noMatch",
      "timeout", "network", "serviceOffline", "serverError", "malformedResponse",
      "unexpectedResponse", "persistence",
    ] as const;
    const baseLastFm = {
      status: "succeeded" as const,
      cacheSource: "fetched" as const,
      trackTags: [{ name: "dreamy", weight: 1 }],
      artistTags: [{ name: "ambient", weight: null }],
      matchedTrack: null,
      matchedArtist: null,
      trackMusicBrainzId: null,
      artistMusicBrainzId: null,
      matchQuality: null,
      retrievedAtUtc: null,
      errorCategory: null,
      nextRetryUtc: null,
    };
    const messageFor = (lastFm: Record<string, unknown>) => ({
      protocolVersion: 1,
      type: "songContext",
      payload: { ...initialSongContext, lastFm },
    });

    statuses.forEach((status) => expect(isSongContextMessage(messageFor({ ...baseLastFm, status }))).toBe(true));
    cacheSources.forEach((cacheSource) => expect(isSongContextMessage(messageFor({ ...baseLastFm, cacheSource }))).toBe(true));
    matchQualities.forEach((matchQuality) => expect(isSongContextMessage(messageFor({ ...baseLastFm, matchQuality }))).toBe(true));
    errorCategories.forEach((errorCategory) => expect(isSongContextMessage(messageFor({ ...baseLastFm, errorCategory }))).toBe(true));

    expect(isSongContextMessage(messageFor({ ...baseLastFm, matchedTrack: 42 }))).toBe(false);
    expect(isSongContextMessage(messageFor({ ...baseLastFm, matchQuality: "fuzzy" }))).toBe(false);
    expect(isSongContextMessage(messageFor({ ...baseLastFm, errorCategory: "rawException" }))).toBe(false);
    expect(isSongContextMessage(messageFor({ ...baseLastFm, trackTags: [{ name: "bad", weight: 2 }] }))).toBe(false);
  });
});

function withTrack(
  overrides: Partial<NonNullable<SongContextSnapshot["currentTrack"]>>,
): SongContextSnapshot {
  return {
    ...initialSongContext,
    metadataStatus: "playingTrack",
    authenticationStatus: "valid",
    currentTrack: {
      spotifyTrackId: "track-id",
      spotifyUri: "spotify:track:track-id",
      isrc: null,
      title: "Title",
      artists: [],
      album: null,
      durationMs: 10_000,
      explicit: false,
      progressMs: 1_000,
      isPlaying: true,
      observedAtUtc: "2026-08-12T12:00:00Z",
      ...overrides,
    },
  };
}
