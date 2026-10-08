import { describe, expect, it } from "vitest";
import { isCloudSongContext } from "../../shared/CloudSongContext";

// Hand-derived synthetic fixture: no real songs, artists, IDs, URLs, or credentials.
const at = "2026-01-01T00:00:00.000Z";
const traits = {
  mood: "dreamy", energy: 0.4, tension: 0.2, softness: 0.8, imagery: "water",
  bassEffect: "ripples", midEffect: "clouds", trebleEffect: "sparks",
};
const sections = (count: number, span = 10_000) =>
  Array.from({ length: count }, (_, i) => ({ startMs: i * span, endMs: (i + 1) * span, traits: { ...traits } }));

const playing = {
  protocolVersion: 1,
  status: "playing",
  observedAtUtc: at,
  nextRetryUtc: null,
  track: {
    spotifyTrackId: "SynthTrack0001",
    spotifyUri: "spotify:track:SynthTrack0001",
    isrc: "ZZSYN0000001",
    title: "Synthetic Song",
    artists: [{ spotifyArtistId: "SynthArtist01", name: "Synthetic Artist" }],
    album: {
      spotifyAlbumId: "SynthAlbum01",
      name: "Synthetic Album",
      artworkUrl: "https://images.example.test/synthetic.jpg",
      releaseDate: "2020-05-17",
      releaseDatePrecision: "day",
    },
    durationMs: 200_000,
    explicit: false,
    progressMs: 50_000,
    isPlaying: true,
    observedAtUtc: at,
  },
  trackTags: [{ name: "dreamy", weight: 0.9 }, { name: "synthetic", weight: null }],
  artistTags: [{ name: "placeholder", weight: 0.3 }],
  analysis: { wholeSong: { ...traits }, sections: sections(2, 60_000) },
  capabilities: { lyrics: true, ai: false },
};

type Mutation = readonly [name: string, mutate: (draft: any) => void];
const draft = (): any => structuredClone(playing);
const idle = (status: string) => (d: any) =>
  Object.assign(d, { status, track: null, analysis: null, trackTags: [], artistTags: [] });
const idleStatuses = ["none", "signedOut", "forbidden", "unavailable", "rateLimited"] as const;

function check(expected: boolean, table: readonly Mutation[]) {
  for (const [name, mutate] of table) {
    const d = draft();
    mutate(d);
    expect(isCloudSongContext(d), name).toBe(expected);
  }
}

describe("isCloudSongContext", () => {
  it("accepts full playing, paused, null idle contexts, and legacy nullable fields", () => {
    expect(isCloudSongContext(playing)).toBe(true);
    check(true, [
      ["paused with isPlaying=false", d => { d.status = "paused"; d.track.isPlaying = false; }],
      ...idleStatuses.map(s => [`${s} with null track/analysis and empty tags`, idle(s)] as const),
      ["rateLimited with retry time", d => { idle("rateLimited")(d); d.nextRetryUtc = "2026-01-01T00:05:00.000Z"; }],
      ["legacy nullable track fields", d => Object.assign(d.track, {
        spotifyUri: null, isrc: null, title: null, album: null, explicit: null, progressMs: null,
      })],
      ["nullable artist and album fields", d => {
        d.track.artists[0] = { spotifyArtistId: null, name: null };
        Object.assign(d.track.album, {
          spotifyAlbumId: null, name: null, artworkUrl: null, releaseDate: null, releaseDatePrecision: null,
        });
      }],
      ["unknown duration with section-free analysis", d => {
        d.track.durationMs = null; d.track.progressMs = 120_000; d.analysis.sections = [];
      }],
      ["null analysis with track", d => { d.analysis = null; }],
      ["year precision", d => Object.assign(d.track.album, { releaseDate: "2020", releaseDatePrecision: "year" })],
      ["month precision", d => Object.assign(d.track.album, { releaseDate: "2020-05", releaseDatePrecision: "month" })],
      ["upper boundary sizes", d => {
        d.track.spotifyTrackId = "A".repeat(128);
        d.track.spotifyUri = `spotify:track:${"A".repeat(128)}`;
        d.track.durationMs = 86_400_000;
        d.track.progressMs = 86_400_000;
        d.track.title = "t".repeat(256);
        d.track.artists = Array.from({ length: 16 }, (_, i) => ({ spotifyArtistId: `SynthArtist${i}`, name: `Synthetic Artist ${i}` }));
        d.trackTags = Array.from({ length: 32 }, (_, i) => ({ name: `tag ${i}`, weight: 0 }));
      }],
      ["trait bounds 0 and 1", d => Object.assign(d.analysis.wholeSong, { energy: 0, tension: 1, softness: 0 })],
      ...["none", "water", "air", "light", "earth", "fire"].map(v =>
        [`known imagery ${v}`, (d: any) => { d.analysis.wholeSong.imagery = v; }] as const),
    ]);
  });

  it("rejects malformed shapes: missing keys, partial track, nested artist/album, records for arrays", () => {
    for (const root of [null, undefined, [], "playing", 1]) expect(isCloudSongContext(root)).toBe(false);
    check(false, [
      ...Object.keys(playing).map(k => [`missing top-level ${k}`, (d: any) => { delete d[k]; }] as const),
      ...Object.keys(playing.track).map(k => [`partial track missing ${k}`, (d: any) => { delete d.track[k]; }] as const),
      ...Object.keys(playing.track.album).map(k => [`album missing ${k}`, (d: any) => { delete d.track.album[k]; }] as const),
      ...Object.keys(traits).map(k => [`trait missing ${k}`, (d: any) => { delete d.analysis.wholeSong[k]; }] as const),
      ["artist missing name", d => { delete d.track.artists[0].name; }],
      ["artist missing id", d => { delete d.track.artists[0].spotifyArtistId; }],
      ["artist as bare string", d => { d.track.artists = ["Synthetic Artist"]; }],
      ["artists as index record", d => { d.track.artists = { 0: d.track.artists[0] }; }],
      ["album as array", d => { d.track.album = [d.track.album]; }],
      ["trackTags as record", d => { d.trackTags = { dreamy: 0.9 }; }],
      ["tag missing weight", d => { delete d.artistTags[0].weight; }],
      ["tag weight as string", d => { d.trackTags[0].weight = "0.9"; }],
      ["capabilities missing ai", d => { delete d.capabilities.ai; }],
      ["capabilities non-boolean", d => { d.capabilities.lyrics = "yes"; }],
      ["analysis missing sections", d => { delete d.analysis.sections; }],
      ["sections as record", d => { d.analysis.sections = { 0: d.analysis.sections[0] }; }],
      ["section missing traits", d => { delete d.analysis.sections[0].traits; }],
      ["null track ID", d => { d.track.spotifyTrackId = null; }],
      ["null isPlaying", d => { d.track.isPlaying = null; }],
    ]);
  });

  it("rejects non-finite, out-of-range, oversize, and badly formatted values", () => {
    const long = (n: number) => "x".repeat(n);
    check(false, [
      ...(["energy", "tension", "softness"] as const).flatMap(k => [-0.01, 1.01, NaN, Infinity].map(v =>
        [`wholeSong ${k}=${v}`, (d: any) => { d.analysis.wholeSong[k] = v; }] as const)),
      ["section trait out of range", d => { d.analysis.sections[1].traits.energy = 2; }],
      ["negative progress", d => { d.track.progressMs = -1; }],
      ["progress beyond known duration", d => { d.track.progressMs = 200_001; }],
      ["NaN progress", d => { d.track.progressMs = NaN; }],
      ["fractional duration", d => { d.track.durationMs = 1.5; }],
      ["duration over 24h", d => { d.track.durationMs = 86_400_001; }],
      ["negative duration", d => { d.track.durationMs = -1; }],
      ["NaN tag weight", d => { d.trackTags[0].weight = NaN; }],
      ["Infinity tag weight", d => { d.artistTags[0].weight = Infinity; }],
      ["oversize track ID", d => { d.track.spotifyTrackId = "A".repeat(129); d.track.spotifyUri = null; }],
      ["non-alphanumeric track ID", d => { d.track.spotifyTrackId = "Synth-Track_01"; d.track.spotifyUri = null; }],
      ["empty track ID", d => { d.track.spotifyTrackId = ""; d.track.spotifyUri = null; }],
      ["oversize title", d => { d.track.title = long(257); }],
      ["oversize artist name", d => { d.track.artists[0].name = long(257); }],
      ["oversize album name", d => { d.track.album.name = long(257); }],
      ["oversize tag name", d => { d.trackTags[0].name = long(257); }],
      ["17 artists", d => { d.track.artists = Array.from({ length: 17 }, () => ({ ...playing.track.artists[0] })); }],
      ["33 track tags", d => { d.trackTags = Array.from({ length: 33 }, (_, i) => ({ name: `tag ${i}`, weight: null })); }],
      ["33 artist tags", d => { d.artistTags = Array.from({ length: 33 }, (_, i) => ({ name: `tag ${i}`, weight: null })); }],
      ["non-HTTPS artwork", d => { d.track.album.artworkUrl = "http://images.example.test/synthetic.jpg"; }],
      ["artwork with credentials", d => { d.track.album.artworkUrl = "https://user:pass@images.example.test/a.jpg"; }],
      ["oversize artwork URL", d => { d.track.album.artworkUrl = `https://images.example.test/${long(2048)}`; }],
      ["artwork not a URL", d => { d.track.album.artworkUrl = "not a url"; }],
      ["URI with mismatched ID", d => { d.track.spotifyUri = "spotify:track:OtherSynth01"; }],
      ["URI of wrong type", d => { d.track.spotifyUri = "spotify:album:SynthTrack0001"; }],
      ["oversize ISRC", d => { d.track.isrc = "Z".repeat(33); }],
      ["release month 13", d => { d.track.album.releaseDate = "2020-13-01"; }],
      ["release day 32", d => { d.track.album.releaseDate = "2020-05-32"; }],
      ["malformed release date", d => { d.track.album.releaseDate = "20-5-17"; }],
      ["unknown release precision", d => { d.track.album.releaseDatePrecision = "week"; }],
      ["NUL in title", d => { d.track.title = "Synthetic\u0000Song"; }],
      ["newline in tag", d => { d.trackTags[0].name = "dream\npop"; }],
      ["BEL in artist", d => { d.track.artists[0].name = "Synthetic\u0007Artist"; }],
      ["protocolVersion 2", d => { d.protocolVersion = 2; }],
      ["protocolVersion string", d => { d.protocolVersion = "1"; }],
    ]);
  });

  it("rejects unknown mood/effect/imagery and extra credential, reserved, or raw lyrics keys", () => {
    const placeholder = "synthetic-placeholder";
    check(false, [
      ["unknown mood", d => { d.analysis.wholeSong.mood = "euphoric"; }],
      ["legacy free-form imagery", d => { d.analysis.wholeSong.imagery = "smoke"; }],
      ["unknown section imagery", d => { d.analysis.sections[0].traits.imagery = "neon"; }],
      ...(["bassEffect", "midEffect", "trebleEffect"] as const).map(k =>
        [`unknown ${k}`, (d: any) => { d.analysis.wholeSong[k] = "lasers"; }] as const),
      ["legacy status vocabulary", d => { d.status = "playingTrack"; }],
      ...["accessToken", "refreshToken", "clientSecret", "apiKey"].map(k =>
        [`top-level ${k}`, (d: any) => { d[k] = placeholder; }] as const),
      ["credential on track", d => { d.track.accessToken = placeholder; }],
      ["reserved at top level", d => { d.reserved = {}; }],
      ["reserved on track", d => { d.track.reserved = { personalOverrides: null }; }],
      ["raw lyrics at top level", d => { d.lyrics = "synthetic line"; }],
      ["raw lyrics in analysis", d => { d.analysis.rawLyrics = "synthetic line"; }],
      ["lyrics in section", d => { d.analysis.sections[0].lyrics = "synthetic line"; }],
      ["extra trait key", d => { d.analysis.wholeSong.colors = ["#000000"]; }],
      ["extra section key", d => { d.analysis.sections[0].label = "verse"; }],
      ["extra artist key", d => { d.track.artists[0].uri = "spotify:artist:SynthArtist01"; }],
      ["extra album key", d => { d.track.album.label = "Synthetic Label"; }],
      ["extra tag key", d => { d.trackTags[0].url = "https://tags.example.test/x"; }],
      ["extra capability", d => { d.capabilities.admin = true; }],
    ]);
  });

  it("bounds analysis sections: 16 allowed, 17 rejected, sorted, non-overlapping, within duration", () => {
    check(true, [
      ["16 sections", d => { d.analysis.sections = sections(16); }],
      ["sections ending exactly at duration", d => { d.analysis.sections = sections(2, 100_000); }],
    ]);
    check(false, [
      ["17 sections", d => { d.analysis.sections = sections(17); }],
      ["overlapping sections", d => { d.analysis.sections[1].startMs = 59_999; }],
      ["unsorted sections", d => { d.analysis.sections.reverse(); }],
      ["negative start", d => { d.analysis.sections[0].startMs = -1; }],
      ["zero-length section", d => { d.analysis.sections[0].endMs = 0; }],
      ["section beyond track duration", d => { d.analysis.sections = sections(2, 100_001); }],
      ["sections with unknown duration", d => { d.track.durationMs = null; }],
      ["non-finite section end", d => { d.analysis.sections[1].endMs = Infinity; }],
      ["analysis without track", d => { idle("none")(d); d.analysis = structuredClone(playing.analysis); }],
    ]);
  });

  it("rejects invalid UTC/retry timestamps and status/track inconsistencies", () => {
    check(false, [
      ...["2026-01-01T00:00:00.000", "2026-01-01T02:00:00.000+02:00", "not a date", "2026-13-01T00:00:00.000Z", ""]
        .map(v => [`observedAtUtc ${JSON.stringify(v)}`, (d: any) => { d.observedAtUtc = v; }] as const),
      ["observedAtUtc as number", d => { d.observedAtUtc = Date.parse(at); }],
      ["invalid track observedAtUtc", d => { d.track.observedAtUtc = "yesterday"; }],
      ["nextRetryUtc free text", d => { d.nextRetryUtc = "soon"; }],
      ["nextRetryUtc impossible month", d => { d.nextRetryUtc = "2026-13-01T00:00:00.000Z"; }],
      ["nextRetryUtc as number", d => { d.nextRetryUtc = 60_000; }],
      ["unknown status", d => { d.status = "buffering"; }],
      ["playing with isPlaying=false", d => { d.track.isPlaying = false; }],
      ["paused with isPlaying=true", d => { d.status = "paused"; }],
      ["playing without track", d => { d.track = null; d.analysis = null; }],
      ["paused without track", d => { d.status = "paused"; d.track = null; d.analysis = null; }],
      ...idleStatuses.flatMap(s => [
        [`${s} with track`, (d: any) => { idle(s)(d); d.track = structuredClone(playing.track); d.track.isPlaying = false; }],
        [`${s} with analysis`, (d: any) => { d.status = s; d.track = null; d.trackTags = []; d.artistTags = []; }],
        [`${s} with track tags`, (d: any) => { idle(s)(d); d.trackTags = [{ name: "dreamy", weight: null }]; }],
        [`${s} with artist tags`, (d: any) => { idle(s)(d); d.artistTags = [{ name: "dreamy", weight: null }]; }],
      ] as const),
    ]);
  });
});
