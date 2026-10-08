import { isCloudSongContext, type CloudSongContextV1 } from "../../shared/CloudSongContext";
import type { CurrentTrack } from "../../shared/SongIdentity";
import { record } from "./http";
import { ProviderFailure, providerJson } from "./provider-http";

export async function readCurrentPlayback(token: string, signal: AbortSignal): Promise<CurrentTrack | null> {
  const value = await providerJson("https://api.spotify.com/v1/me/player/currently-playing", signal, 100000,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (value === null) return null;
  if (!record(value)) throw new ProviderFailure(502);
  const item = value.item;
  if (!record(item) || value.currently_playing_type !== "track" || item.type !== "track" || item.is_local === true) return null;
  const album = record(item.album) ? item.album : null;
  const artists = Array.isArray(item.artists) ? item.artists : [];
  const images = album && Array.isArray(album.images) ? album.images : [];
  const firstImage = images[0];
  const ids = record(item.external_ids) ? item.external_ids : {};
  const track = {
    spotifyTrackId: item.id,
    spotifyUri: item.uri ?? null,
    isrc: ids.isrc ?? null,
    title: item.name ?? null,
    artists: artists.map(artist => record(artist) ? { spotifyArtistId: artist.id ?? null, name: artist.name ?? null } : null),
    album: album ? { spotifyAlbumId: album.id ?? null, name: album.name ?? null,
      artworkUrl: record(firstImage) ? firstImage.url ?? null : null,
      releaseDate: album.release_date ?? null, releaseDatePrecision: album.release_date_precision ?? null } : null,
    durationMs: item.duration_ms ?? null,
    explicit: item.explicit ?? null,
    progressMs: value.progress_ms ?? null,
    isPlaying: value.is_playing,
    observedAtUtc: new Date().toISOString(),
  };
  const envelope: unknown = { protocolVersion: 1, status: track.isPlaying ? "playing" : "paused", observedAtUtc: track.observedAtUtc,
    nextRetryUtc: null, track, trackTags: [], artistTags: [], analysis: null, capabilities: { lyrics: false, ai: false } };
  if (!isCloudSongContext(envelope)) throw new ProviderFailure(502);
  return (envelope as CloudSongContextV1).track;
}
