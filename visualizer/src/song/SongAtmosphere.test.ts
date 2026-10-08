import { expect, it } from "vitest";
import { initialSongContext, type SongContextSnapshot } from "./SongContext";
import { neutralAtmosphere, tagAtmosphere } from "./SongAtmosphere";

const tagged = (name: string, artist = false): SongContextSnapshot => ({ ...initialSongContext, stale: false,
  lastFm: { status: "succeeded", cacheSource: "fetched", trackTags: artist ? [] : [{ name, weight: 1 }],
    artistTags: artist ? [{ name, weight: 1 }] : [], matchedTrack: null, matchedArtist: null,
    trackMusicBrainzId: null, artistMusicBrainzId: null, matchQuality: null, retrievedAtUtc: null,
    errorCategory: null, nextRetryUtc: null } });

it("distinguishes warm acoustic, hazy ambient and crisp electronic textures without returning colors", () => {
  expect(tagAtmosphere(tagged("acoustic")).warmth).toBeGreaterThan(neutralAtmosphere.warmth);
  expect(tagAtmosphere(tagged("ambient")).haze).toBeGreaterThan(neutralAtmosphere.haze);
  expect(tagAtmosphere(tagged("synthwave")).shimmer).toBeGreaterThan(neutralAtmosphere.shimmer);
  expect(tagAtmosphere(tagged("industrial")).distortion).toBeGreaterThan(neutralAtmosphere.distortion);
  expect(Object.keys(tagAtmosphere(tagged("acoustic"))).sort()).toEqual(["distortion", "haze", "shimmer", "warmth"]);
});
it("uses track tags more strongly than artist tags, bounded and independent of tag order", () => {
  const track = tagAtmosphere(tagged("ambient"));
  const artist = tagAtmosphere(tagged("ambient", true));
  expect(track.haze).toBeGreaterThan(artist.haze);
  const song = tagged("dream pop");
  song.lastFm!.trackTags.push({ name: "electronic", weight: 0.8 });
  const before = tagAtmosphere(song);
  song.lastFm!.trackTags.reverse();
  expect(tagAtmosphere(song)).toEqual(before);
  expect(Object.values(before).every(n => n >= 0 && n <= 1 && Number.isFinite(n))).toBe(true);
});
it("ignores stale, unknown and malformed tag weights and does not mutate the snapshot", () => {
  expect(tagAtmosphere({ ...tagged("ambient"), stale: true })).toEqual(neutralAtmosphere);
  expect(tagAtmosphere(tagged("a user comment that is not a genre"))).toEqual(neutralAtmosphere);
  const song = tagged("ambient"); song.lastFm!.trackTags[0].weight = NaN;
  const before = structuredClone(song);
  expect(tagAtmosphere(song)).toEqual(neutralAtmosphere);
  expect(song).toEqual(before);
});
