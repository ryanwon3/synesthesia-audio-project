import { afterEach, expect, it, vi } from 'vitest';
import { AuthFailure } from '../src/auth';
import { ProviderFailure } from '../src/provider-http';
import { createSongContextService } from '../src/song-context';
import { isCloudSongContext, type CloudSongContextV1, type CloudSongStatus, type LastFmTag } from '../../shared/CloudSongContext';
import type { CurrentTrack } from '../../shared/SongIdentity';
import { effects, hostedImageries, moods, type MoodTraits, type SongVisualProfile } from '../../shared/SongTraits';

type Tags = { trackTags: LastFmTag[]; artistTags: LastFmTag[] };
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const at = (ms: number) => new Date(NOW + ms).toISOString();
const HEADERS = new Headers({ cookie: 'session=synthetic' });
const USER = 'user-a';
const SECRET = 'synthetic-secret-value';
const CAPS = { lyrics: false, ai: false };
const TAGS: Tags = { trackTags: [{ name: 'synthwave', weight: 1 }], artistTags: [{ name: 'electronic', weight: null }] };
const EMPTY: Tags = { trackTags: [], artistTags: [] };
const sameTrack = () => expect.objectContaining({ spotifyTrackId: 'trk0001' });

const track = (isPlaying = true): CurrentTrack => ({
  spotifyTrackId: 'trk0001', spotifyUri: 'spotify:track:trk0001', isrc: 'ZZ0000000001', title: 'Synthetic Title',
  artists: [{ spotifyArtistId: 'art0001', name: 'Synthetic Artist' }],
  album: { spotifyAlbumId: 'alb0001', name: 'Synthetic Album', artworkUrl: 'https://example.invalid/cover.jpg', releaseDate: '2020-01-02', releaseDatePrecision: 'day' },
  durationMs: 200_000, explicit: false, progressMs: 1_000, isPlaying, observedAtUtc: at(0),
});
const traits = (over: Partial<MoodTraits> = {}): MoodTraits => ({
  mood: 'calm', energy: 0.5, tension: 0.25, softness: 0.75, imagery: 'water',
  bassEffect: 'ripples', midEffect: 'ribbons', trebleEffect: 'sparks', ...over,
});
const ctx = (over: Partial<CloudSongContextV1> = {}): CloudSongContextV1 => ({
  protocolVersion: 1, status: 'playing', observedAtUtc: at(0), nextRetryUtc: null, track: track(),
  trackTags: [], artistTags: [], analysis: null, capabilities: CAPS, ...over,
});
const cleared = (status: CloudSongStatus, over: Partial<CloudSongContextV1> = {}) => ctx({ status, track: null, ...over });

function makeDeps() {
  return {
    capabilities: CAPS,
    now: () => new Date(NOW),
    requireUser: vi.fn(async (_headers: Headers): Promise<{ userId: string }> => ({ userId: USER })),
    getSpotifyToken: vi.fn(async (_headers: Headers, _userId: string) => 'synthetic-token'),
    readCurrentPlayback: vi.fn(async (_token: string, _signal: AbortSignal): Promise<CurrentTrack | null> => track()),
    getTags: vi.fn(async (_track: CurrentTrack, _signal: AbortSignal): Promise<Tags> => TAGS),
    allowContext: vi.fn(async (_userId: string) => true),
    repository: {
      readContext: vi.fn(async (_userId: string): Promise<CloudSongContextV1 | null> => null),
      claimPoll: vi.fn(async (_userId: string, _owner: string, _now: Date) => true),
      finishPoll: vi.fn(async (_u: string, _o: string, _c: CloudSongContextV1, _r: Date | null) => true),
      readTags: vi.fn(async (_track: CurrentTrack): Promise<Tags | null> => null),
      saveTags: vi.fn(async (_track: CurrentTrack, _tags: Tags, _negative: boolean) => {}),
      readAnalysis: vi.fn(async (_track: CurrentTrack): Promise<SongVisualProfile | null> => null),
    },
  };
}
type Deps = ReturnType<typeof makeDeps>;
const run = (d: Deps, signal?: AbortSignal) =>
  createSongContextService(d).getSongContext(HEADERS, signal ?? new AbortController().signal);

function expectValid(r: CloudSongContextV1) {
  expect(isCloudSongContext(r)).toBe(true);
  expect(r.capabilities).toEqual(CAPS);
  expect(JSON.stringify(r)).not.toContain(SECRET);
}
function expectCleared(r: CloudSongContextV1, status: CloudSongStatus) {
  expectValid(r);
  expect(r).toMatchObject({ status, track: null, analysis: null, trackTags: [], artistTags: [] });
}
function expectNoWrites(d: Deps) {
  expect(d.repository.finishPoll).not.toHaveBeenCalled();
  expect(d.repository.saveTags).not.toHaveBeenCalled();
}

afterEach(() => { vi.useRealTimers(); });

it('synthetic fixtures satisfy the shared validator', () => {
  expect(isCloudSongContext(ctx())).toBe(true);
  expect(isCloudSongContext(ctx({ status: 'paused', track: track(false) }))).toBe(true);
  expect(isCloudSongContext(ctx({ ...TAGS, analysis: { wholeSong: traits(), sections: [{ startMs: 0, endMs: 200_000, traits: traits() }] } }))).toBe(true);
  expect(isCloudSongContext(cleared('rateLimited', { nextRetryUtc: at(30_000) }))).toBe(true);
});

it.each([0, 2_000, 5_000])('returns a valid cached context aged %ims unchanged', async age => {
  const d = makeDeps();
  const stored = ctx({ observedAtUtc: at(-age) });
  d.repository.readContext.mockResolvedValue(stored);
  expect(await run(d)).toEqual(stored);
  expect(d.repository.readContext).toHaveBeenCalledWith(USER);
  expect(d.repository.claimPoll).not.toHaveBeenCalled();
  expect(d.getSpotifyToken).not.toHaveBeenCalled();
});

it('respects a future cooldown on a stored rateLimited context older than 5000ms', async () => {
  const d = makeDeps();
  const stored = cleared('rateLimited', { observedAtUtc: at(-6_000), nextRetryUtc: at(30_000) });
  expect(isCloudSongContext(stored)).toBe(true);
  d.repository.readContext.mockResolvedValue(stored);
  expect(await run(d)).toEqual(stored);
  expect(d.repository.claimPoll).not.toHaveBeenCalled();
  expect(d.getSpotifyToken).not.toHaveBeenCalled();
  expect(d.readCurrentPlayback).not.toHaveBeenCalled();
});

it.each([
  ['expired 5001ms', ctx({ observedAtUtc: at(-5_001) })],
  ['future-dated', ctx({ observedAtUtc: at(1) })],
  ['malformed', { protocolVersion: 2 } as unknown as CloudSongContextV1],
])('ignores %s cache and claims a fresh poll', async (_label, stored) => {
  const d = makeDeps();
  d.repository.readContext.mockResolvedValue(stored);
  const r = await run(d);
  expectValid(r);
  expect(r).toMatchObject({ status: 'playing', observedAtUtc: at(0) });
  expect(d.repository.claimPoll).toHaveBeenCalledWith(USER, expect.any(String), new Date(NOW));
  expect(d.readCurrentPlayback).toHaveBeenCalledTimes(1);
});

it('lost claim returns unavailable retry+1s without calling the token provider', async () => {
  const d = makeDeps();
  d.repository.claimPoll.mockResolvedValue(false);
  const r = await run(d);
  expectCleared(r, 'unavailable');
  expect(r.nextRetryUtc).toBe(at(1_000));
  expect(d.getSpotifyToken).not.toHaveBeenCalled();
  expectNoWrites(d);
});

it('durable allowContext false yields rateLimited retry+60s', async () => {
  const d = makeDeps();
  d.allowContext.mockResolvedValue(false);
  const r = await run(d);
  expectCleared(r, 'rateLimited');
  expect(r.nextRetryUtc).toBe(at(60_000));
  expect(d.allowContext).toHaveBeenCalledWith(USER);
  expect(d.repository.claimPoll).not.toHaveBeenCalled();
  expect(d.getSpotifyToken).not.toHaveBeenCalled();
});

it.each([[401, 'signedOut'], [403, 'forbidden'], [0, 'unavailable']] as const)('initial auth failure %i clears without touching the repository', async (code, status) => {
  const d = makeDeps();
  d.requireUser.mockRejectedValue(code ? new AuthFailure(code) : new Error(SECRET));
  expectCleared(await run(d), status);
  expect(d.repository.readContext).not.toHaveBeenCalled();
  expect(d.repository.claimPoll).not.toHaveBeenCalled();
  expect(d.getSpotifyToken).not.toHaveBeenCalled();
});

it.each([true, false])('isPlaying=%s returns a real DTO finished by the claim owner after same-user revalidation', async isPlaying => {
  const d = makeDeps();
  d.readCurrentPlayback.mockResolvedValue(track(isPlaying));
  d.repository.readTags.mockResolvedValue(TAGS);
  const r = await run(d);
  expectValid(r);
  expect(r).toMatchObject({ status: isPlaying ? 'playing' : 'paused', track: track(isPlaying), ...TAGS });
  expect(d.getSpotifyToken).toHaveBeenCalledWith(HEADERS, USER);
  expect(d.readCurrentPlayback).toHaveBeenCalledWith('synthetic-token', expect.any(AbortSignal));
  expect(d.requireUser).toHaveBeenCalledTimes(2);
  expect(d.requireUser.mock.calls.every(([h]) => h === HEADERS)).toBe(true);
  const owner = d.repository.claimPoll.mock.calls[0]?.[1];
  expect(owner).toEqual(expect.any(String));
  expect(d.repository.finishPoll).toHaveBeenCalledTimes(1);
  expect(d.repository.finishPoll.mock.calls[0]?.slice(0, 3)).toEqual([USER, owner, r]);
});

it.each([
  ['nothing playing', null, 'none', null],
  ['429', new ProviderFailure(429, 30), 'rateLimited', at(30_000)],
  ['403', new ProviderFailure(403), 'forbidden', null],
  ['401', new ProviderFailure(401), 'signedOut', null],
  ['503', new ProviderFailure(503), 'unavailable', null],
] as const)('maps Spotify %s to a cleared context', async (_label, failure, status, retry) => {
  const d = makeDeps();
  if (failure) d.readCurrentPlayback.mockRejectedValue(failure);
  else d.readCurrentPlayback.mockResolvedValue(null);
  const r = await run(d);
  expectCleared(r, status);
  if (retry) expect(r.nextRetryUtc).toBe(retry);
  expect(d.getTags).not.toHaveBeenCalled();
});

it('token provider 401 clears to signedOut with the error redacted', async () => {
  const d = makeDeps();
  d.getSpotifyToken.mockRejectedValue(new AuthFailure(401));
  expectCleared(await run(d), 'signedOut');
  expect(d.readCurrentPlayback).not.toHaveBeenCalled();
});

it('serves cached Last.fm tags without refetching', async () => {
  const d = makeDeps();
  d.repository.readTags.mockResolvedValue(TAGS);
  expect(await run(d)).toMatchObject(TAGS);
  expect(d.getTags).not.toHaveBeenCalled();
  expect(d.repository.saveTags).not.toHaveBeenCalled();
});

it('refetches uncached tags and saves them as positive', async () => {
  const d = makeDeps();
  expect(await run(d)).toMatchObject(TAGS);
  expect(d.getTags).toHaveBeenCalledWith(sameTrack(), expect.any(AbortSignal));
  expect(d.repository.saveTags).toHaveBeenCalledWith(sameTrack(), TAGS, false);
});

it('saves an empty provider result as a negative entry', async () => {
  const d = makeDeps();
  d.getTags.mockResolvedValue(EMPTY);
  expect(await run(d)).toMatchObject({ status: 'playing', ...EMPTY });
  expect(d.repository.saveTags).toHaveBeenCalledWith(sameTrack(), EMPTY, true);
});

it('keeps the valid track when the tag provider fails', async () => {
  const d = makeDeps();
  d.getTags.mockRejectedValue(new Error(SECRET));
  const r = await run(d);
  expectValid(r);
  expect(r).toMatchObject({ status: 'playing', track: track(), ...EMPTY });
  expect(d.repository.saveTags).not.toHaveBeenCalled();
});

const BAD_TAGS = [
  ['bad weight', { trackTags: [{ name: 'synthwave', weight: 2 }], artistTags: [] }],
  ['extra field', { trackTags: [{ name: 'synthwave', weight: 1, extra: 1 }], artistTags: [] }],
  ['private field', { trackTags: [], artistTags: [{ name: 'electronic', weight: null, token: SECRET }] }],
] as unknown as [string, Tags][];

it.each(BAD_TAGS)('rejects malformed cached Last.fm tags (%s) and never persists them', async (_label, bad) => {
  const d = makeDeps();
  d.repository.readTags.mockResolvedValue(bad);
  d.getTags.mockResolvedValue(EMPTY);
  const r = await run(d);
  expectValid(r);
  expect(r).toMatchObject({ status: 'playing', track: track(), ...EMPTY });
  expect(d.repository.saveTags).not.toHaveBeenCalledWith(expect.anything(), bad, expect.anything());
});

it.each(BAD_TAGS)('rejects malformed fetched Last.fm tags (%s) without caching', async (_label, bad) => {
  const d = makeDeps();
  d.getTags.mockResolvedValue(bad);
  const r = await run(d);
  expectValid(r);
  expect(r).toMatchObject({ status: 'playing', track: track(), ...EMPTY });
  expect(d.repository.saveTags).not.toHaveBeenCalled();
});

const literalCases: MoodTraits[] = [
  ...moods.map(mood => traits({ mood })),
  ...hostedImageries.map(imagery => traits({ imagery })),
  ...effects.map(e => traits({ bassEffect: e, midEffect: e, trebleEffect: e })),
];
it.each(literalCases)('accepts analysis using shared literals %o', async t => {
  const d = makeDeps();
  const analysis: SongVisualProfile = { wholeSong: t, sections: [{ startMs: 0, endMs: 1_000, traits: t }] };
  expect(isCloudSongContext(ctx({ analysis }))).toBe(true);
  d.repository.readAnalysis.mockResolvedValue(analysis);
  const r = await run(d);
  expectValid(r);
  expect(r.analysis).toEqual(analysis);
});

it.each([[200_000, true], [200_001, false]] as const)('section ending at %ims accepted=%s', async (endMs, ok) => {
  const d = makeDeps();
  const analysis: SongVisualProfile = { wholeSong: traits(), sections: [{ startMs: 0, endMs, traits: traits() }] };
  expect(isCloudSongContext(ctx({ analysis }))).toBe(ok);
  d.repository.readAnalysis.mockResolvedValue(analysis);
  const r = await run(d);
  expectValid(r);
  expect(r).toMatchObject({ status: 'playing', analysis: ok ? analysis : null });
  expect(d.repository.readAnalysis).toHaveBeenCalledWith(sameTrack());
});

it.each([
  ['a different user', (d: Deps) => d.requireUser.mockResolvedValueOnce({ userId: USER }).mockResolvedValueOnce({ userId: 'user-b' })],
  ['no session', (d: Deps) => d.requireUser.mockResolvedValueOnce({ userId: USER }).mockRejectedValueOnce(new AuthFailure(401))],
])('does not finish the poll when revalidation finds %s', async (_label, arrange) => {
  const d = makeDeps();
  arrange(d);
  expectCleared(await run(d), 'signedOut');
  expect(d.requireUser).toHaveBeenCalledTimes(2);
  expect(d.repository.finishPoll).not.toHaveBeenCalled();
});

it('returns unavailable when finishPoll reports the claim lost', async () => {
  const d = makeDeps();
  d.repository.finishPoll.mockResolvedValue(false);
  expectCleared(await run(d), 'unavailable');
});

it('ignores a late provider result after the caller aborts', async () => {
  const d = makeDeps();
  const late = Promise.withResolvers<CurrentTrack | null>();
  d.readCurrentPlayback.mockReturnValue(late.promise);
  const controller = new AbortController();
  const pending = run(d, controller.signal);
  pending.catch(() => {}); // observed synchronously; awaiting below still fails on rejection
  await vi.waitFor(() => expect(d.readCurrentPlayback).toHaveBeenCalled());
  controller.abort();
  late.resolve(track());
  const r = await pending;
  expectCleared(r, 'unavailable');
  expect(d.readCurrentPlayback.mock.calls[0]?.[1].aborted).toBe(true);
  expect(d.getTags).not.toHaveBeenCalled();
  expectNoWrites(d);
});

it('aborts the provider signal at the 20s deadline and does not finish', async () => {
  vi.useFakeTimers({ now: NOW });
  const d = makeDeps();
  d.readCurrentPlayback.mockImplementation((_t, signal) => new Promise<CurrentTrack | null>((_res, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason));
  }));
  const pending = run(d);
  pending.catch(() => {}); // observed synchronously; awaiting below still fails on rejection
  await vi.advanceTimersByTimeAsync(19_999);
  const signal = d.readCurrentPlayback.mock.calls[0]?.[1];
  expect(signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(signal?.aborted).toBe(true);
  const r = await pending;
  expectCleared(r, 'unavailable');
  expectNoWrites(d);
});
