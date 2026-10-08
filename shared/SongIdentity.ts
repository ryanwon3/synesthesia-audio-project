export interface SpotifyArtistIdentity {
  spotifyArtistId: string | null;
  name: string | null;
}

export interface SpotifyAlbumIdentity {
  spotifyAlbumId: string | null;
  name: string | null;
  artworkUrl: string | null;
  releaseDate: string | null;
  releaseDatePrecision: string | null;
}

export interface CurrentTrack {
  spotifyTrackId: string;
  spotifyUri: string | null;
  isrc: string | null;
  title: string | null;
  artists: SpotifyArtistIdentity[];
  album: SpotifyAlbumIdentity | null;
  durationMs: number | null;
  explicit: boolean | null;
  progressMs: number | null;
  isPlaying: boolean;
  observedAtUtc: string;
}
