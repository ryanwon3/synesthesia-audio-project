import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CurrentTrack } from '../../shared/SongIdentity';
import { getTags, normalizeTags } from '../src/lastfm';
import { getMatchedLyrics, parseLines } from '../src/lyrics';
import { ProviderFailure, providerJson, retryAfter } from '../src/provider-http';
import { readCurrentPlayback } from '../src/spotify';

// Mocked global fetch + config with synthetic data only: no real env, credentials, network, db, profile or audio.
// These prove mocked behavior, not live provider behavior.
vi.mock('../src/config', () => ({ readCloudConfig: () => ({ ok: true, config: { lastFmApiKey: 'synthetic-key' } }) }));

const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => json({}));
const signal = (): AbortSignal => new AbortController().signal;
afterEach(() => { fetchMock.mockReset(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}
function serve(handler: (url: URL) => Response): void {
  fetchMock.mockImplementation(async (input) => handler(new URL(input instanceof Request ? input.url : String(input))));
  vi.stubGlobal('fetch', fetchMock);
}
function track(overrides: Partial<CurrentTrack> = {}): CurrentTrack {
  return { spotifyTrackId: 't1', spotifyUri: 'spotify:track:t1', isrc: null, title: 'Synth Song',
    artists: [{ spotifyArtistId: 'a1', name: 'Synth Artist' }],
    album: { spotifyAlbumId: 'b1', name: 'Synth Album', artworkUrl: null, releaseDate: null, releaseDatePrecision: null },
    durationMs: 200000, explicit: false, progressMs: 1000, isPlaying: true, observedAtUtc: '2026-01-01T00:00:00.000Z', ...overrides };
}

const TOP = { toptags: { tag: [{ name: 'Synthwave', count: 100 }, { name: 'Dreamy', count: '50' }] } };
const TOP_TAGS = [{ name: 'synthwave', weight: 1 }, { name: 'dreamy', weight: 0.5 }];
const MATCH = { name: 'Synth Song', artist: { name: 'Synth Artist' }, duration: '200000' };
const EMPTY = { trackTags: [], artistTags: [] };
function lastFm(info: (title: string) => unknown, artistTop: unknown = TOP): URLSearchParams[] {
  const calls: URLSearchParams[] = [];
  serve((url) => {
    const params = url.searchParams;
    const method = params.get('method');
    calls.push(params);
    if (method === 'track.getInfo') return json(info(params.get('track') ?? ''));
    return json(method === 'artist.getTopTags' ? artistTop : TOP);
  });
  return calls;
}
const methods = (calls: URLSearchParams[]): Array<string | null> => calls.map((p) => p.get('method'));

// Synthetic response body that never yields and whose cancel never settles (a reader ignoring abort).
function stalled(status = 200, headers: Record<string, string> = {}): { response: Response; cancelled: () => boolean } {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull: () => new Promise<void>(() => {}),
    cancel: () => { cancelled = true; return new Promise<void>(() => {}); },
  });
  return { response: new Response(body, { status, headers }), cancelled: () => cancelled };
}
// Observes settlement immediately so rejections are never unhandled.
function watch(pending: Promise<unknown>): { done: boolean; error?: unknown } {
  const out: { done: boolean; error?: unknown } = { done: false };
  pending.then(() => { out.done = true; }, (error: unknown) => { out.done = true; out.error = error; });
  return out;
}
async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}
function ended(result: { done: boolean; error?: unknown }, body: ReturnType<typeof stalled>, label: string): void {
  expect(result.done, label).toBe(true);
  expect(result.error, label).toBeInstanceOf(ProviderFailure);
  expect(result.error, label).toMatchObject({ message: 'Provider unavailable' });
  expect([body.cancelled(), body.response.body?.locked], label).toEqual([true, false]);
}

describe('Last.fm normalizeTags', () => {
  it('accepts one tag object as well as an array (expected RED on shown source)', () => {
    expect(normalizeTags({ name: ' Synthwave ', count: '40' })).toEqual([{ name: 'synthwave', weight: 1 }]);
    expect(normalizeTags([{ name: 'Synthwave', count: 40 }])).toEqual([{ name: 'synthwave', weight: 1 }]);
    for (const bad of [null, 'x', { name: 'bad\u0001' }, { count: 1 }]) expect(normalizeTags(bad)).toEqual([]);
  });

  it('dedups, bounds input, drops weak/unsafe tags and keeps the top 20 weights', () => {
    const result = normalizeTags([
      { name: 'Alpha', count: '100' }, { name: ' ALPHA ', count: 40 }, { name: 'tiny', count: 5 },
      { name: 'bad\u0001', count: 90 }, { name: 'x'.repeat(81), count: 90 },
      ...Array.from({ length: 230 }, (_, i) => ({ name: `tag ${i}`, count: i < 30 ? 60 : 1 })),
      { name: 'late', count: 1000 },
    ]);
    expect(result).toHaveLength(20);
    expect(result[0]).toEqual({ name: 'alpha', weight: 1 });
    expect(new Set(result.map((tag) => tag.name)).size).toBe(20);
    for (const tag of result) expect(tag.weight).toBeGreaterThanOrEqual(0.1);
    expect(result.map((tag) => tag.name)).not.toContain('late');
  });
});

describe('Last.fm getTags', () => {
  it('accepts a correction only when track["@attr"].corrected is "1" (expected RED on shown source)', async () => {
    const calls = lastFm(() => ({ track: { ...MATCH, '@attr': { corrected: '1' } } }), { toptags: { tag: { name: 'Electro', count: '9' } } });
    const typo = track({ artists: [{ spotifyArtistId: 'a1', name: 'Synth Artst' }] });
    expect(await getTags(typo, signal())).toEqual({ trackTags: TOP_TAGS, artistTags: [{ name: 'electro', weight: 1 }] });
    expect(calls.slice(1).map((p) => p.get('artist'))).toEqual(['Synth Artist', 'Synth Artist']);
    expect(calls.every((p) => p.get('api_key') === 'synthetic-key')).toBe(true);
  });

  it('rejects mismatches with no flag or an unrelated corrections bag (expected RED on shown source)', async () => {
    const other = { name: 'Other Song', artist: { name: 'Other Artist' } };
    for (const body of [{ track: other }, { track: other, corrections: { note: 'unrelated' } },
      { track: { ...other, '@attr': { corrected: '0' } } }, { track: { ...other, '@attr': { corrected: 1 } } }]) {
      const calls = lastFm(() => body);
      expect(await getTags(track(), signal()), JSON.stringify(body)).toEqual(EMPTY);
      expect(methods(calls)).toEqual(['track.getInfo']);
    }
  });

  it('treats getInfo error 6/7 as no-match and tries the alternate title (expected RED on shown source)', async () => {
    const titled = track({ title: 'Synth Song (Remastered)' });
    let calls = lastFm((title) => ({ error: title.includes('(') ? 6 : 7, message: 'Track not found' }));
    expect(await getTags(titled, signal())).toEqual(EMPTY);
    expect(calls.map((p) => p.get('track'))).toEqual(['Synth Song (Remastered)', 'Synth Song']);
    calls = lastFm((title) => (title.includes('(') ? { error: 6 } : { track: MATCH }));
    expect(await getTags(titled, signal())).toEqual({ trackTags: TOP_TAGS, artistTags: TOP_TAGS });
    expect(methods(calls).filter((m) => m === 'track.getInfo')).toHaveLength(2);
  });

  it('keeps rate-limit/other errors as failures and rejects a gross duration mismatch', async () => {
    lastFm(() => ({ error: 29 }));
    await expect(getTags(track(), signal())).rejects.toMatchObject({ status: 429, retrySeconds: 60 });
    lastFm(() => ({ error: 10 }));
    await expect(getTags(track(), signal())).rejects.toMatchObject({ status: 502 });
    const calls = lastFm(() => ({ track: { ...MATCH, duration: '400000' } }));
    expect(await getTags(track(), signal())).toEqual(EMPTY);
    expect(methods(calls)).toEqual(['track.getInfo']);
  });
});

describe('providerJson', () => {
  const at = 'https://provider.example.test/x';
  it('forbids redirects, honors abort and redacts non-OK responses with Retry-After', async () => {
    serve(() => json({ ok: true }));
    expect(await providerJson(at, signal(), 1000)).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) });
    const aborted = new AbortController();
    aborted.abort();
    fetchMock.mockImplementation(async (_input, init) => { init?.signal?.throwIfAborted(); return json({}); });
    await expect(providerJson(at, aborted.signal, 1000)).rejects.toMatchObject({ status: 503 });
    serve(() => json({ detail: 'synthetic-secret' }, 401));
    const denied: unknown = await providerJson(at, signal(), 1000).catch((error: unknown) => error);
    expect(denied).toMatchObject({ status: 401, retrySeconds: null, message: 'Provider unavailable' });
    expect(JSON.stringify(denied)).not.toContain('synthetic-secret');
    serve(() => json({}, 429, { 'retry-after': '7' }));
    await expect(providerJson(at, signal(), 1000)).rejects.toMatchObject({ status: 429, retrySeconds: 7 });
    expect(retryAfter('Thu, 01 Jan 2026 00:00:30 GMT', Date.parse('2026-01-01T00:00:00Z'))).toBe(30);
    expect([retryAfter('999999'), retryAfter('0'), retryAfter('soon')]).toEqual([86400, 1, null]);
  });

  it('rejects declared and streamed oversize bodies and cancels the stream', async () => {
    serve(() => new Response('{}', { headers: { 'content-length': '5000' } }));
    await expect(providerJson(at, signal(), 1000)).rejects.toMatchObject({ status: 502 });
    let cancelled = false;
    const chunk = new Uint8Array(600).fill(0x20);
    serve(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(chunk); controller.enqueue(chunk); }, cancel() { cancelled = true; } })));
    await expect(providerJson(at, signal(), 1000)).rejects.toMatchObject({ status: 502 });
    expect(cancelled).toBe(true);
  });

  it('ends a stalled body on caller abort or its finite deadline without awaiting cancel', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const first = stalled();
    serve(() => first.response);
    const aborted = watch(providerJson(at, controller.signal, 1000));
    await tick(100);
    expect(aborted.done).toBe(false);
    controller.abort();
    await tick(0);
    ended(aborted, first, 'abort');
    const second = stalled();
    serve(() => second.response);
    const late = watch(providerJson(at, signal(), 1000, {}, 5000));
    await tick(4999);
    expect(late.done).toBe(false);
    await tick(1);
    ended(late, second, 'deadline');
  });

  it('rejects malformed or oversize Content-Length and discards non-OK bodies without awaiting cancel', async () => {
    vi.useFakeTimers();
    const cases: Array<[number, string | null, number]> = [[200, '5000', 502], [200, '1e3', 502], [200, '-1', 502],
      [200, '0x10', 502], [200, '1.5', 502], [500, null, 500], [401, null, 401]];
    for (const [status, length, expected] of cases) {
      const body = stalled(status, length === null ? {} : { 'content-length': length });
      serve(() => body.response);
      const result = watch(providerJson(at, signal(), 1000));
      await tick(0);
      ended(result, body, `${status} ${String(length)}`);
      expect(result.error).toMatchObject({ status: expected });
    }
  });
});

describe('Spotify readCurrentPlayback', () => {
  const item = { id: 't1', uri: 'spotify:track:t1', name: 'Synth Song', type: 'track', is_local: false, popularity: 50,
    artists: [{ id: 'a1', name: 'Synth Artist', href: 'https://api.example.test/a1' }], duration_ms: 200000, explicit: false,
    album: { id: 'b1', name: 'Synth Album', images: [{ url: 'https://img.example.test/b1.jpg' }], release_date: '2026-01-02',
      release_date_precision: 'day', available_markets: ['US'] }, external_ids: { isrc: 'SYN000000001' } };
  const playing = { currently_playing_type: 'track', is_playing: true, progress_ms: 1000, item, device: { name: 'Synth Device' } };

  it('returns null for 204, no item, local files and podcasts', async () => {
    serve(() => new Response(null, { status: 204 }));
    expect(await readCurrentPlayback('synthetic-token', signal())).toBeNull();
    for (const body of [{ ...playing, item: null, currently_playing_type: 'ad' }, { ...playing, item: { ...item, is_local: true } },
      { ...playing, currently_playing_type: 'episode', item: { ...item, type: 'episode' } }]) {
      serve(() => json(body));
      expect(await readCurrentPlayback('synthetic-token', signal()), JSON.stringify(body)).toBeNull();
    }
  });

  it('returns only the normalized DTO, never raw provider fields', async () => {
    serve(() => json(playing));
    expect(await readCurrentPlayback('synthetic-token', signal())).toStrictEqual({
      spotifyTrackId: 't1', spotifyUri: 'spotify:track:t1', isrc: 'SYN000000001', title: 'Synth Song',
      artists: [{ spotifyArtistId: 'a1', name: 'Synth Artist' }], album: { spotifyAlbumId: 'b1', name: 'Synth Album',
        artworkUrl: 'https://img.example.test/b1.jpg', releaseDate: '2026-01-02', releaseDatePrecision: 'day' },
      durationMs: 200000, explicit: false, progressMs: 1000, isPlaying: true, observedAtUtc: expect.any(String) });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer synthetic-token' } });
  });
});

describe('LRCLIB getMatchedLyrics', () => {
  const lrc = (body: Record<string, unknown> = {}): Record<string, unknown> => ({ trackName: 'Synth Song', artistName: 'Synth Artist',
    albumName: 'Synth Album', duration: 200, plainLyrics: 'Plain line',
    syncedLyrics: '[offset:500]\n[00:02.00]Two\n[00:01.00][00:03.00]Echo\n[00:01.00]Echo\n[03:30.00]Late', ...body });

  it('matches identity, sorts offset stamps, dedups, drops out-of-range lines and falls back untimed', async () => {
    serve(() => json(lrc()));
    const result = await getMatchedLyrics(track(), signal());
    expect(result).toMatchObject({ source: 'LRCLIB', hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(JSON.parse(result?.text ?? 'null')).toEqual({ timed: true,
      lines: [{ text: 'Echo', startMs: 1500 }, { text: 'Two', startMs: 2500 }, { text: 'Echo', startMs: 3500 }] });
    const call = fetchMock.mock.calls[0];
    expect(Object.fromEntries(new URL(String(call?.[0])).searchParams)).toEqual({ track_name: 'Synth Song',
      artist_name: 'Synth Artist', album_name: 'Synth Album', duration: '200' });
    expect(call?.[1]?.headers).toMatchObject({ 'User-Agent': 'SpotifySynesthesia/1.0' });
    expect(parseLines('[00:01.00]\n', ' a \n\n b ', 200000)).toEqual({ timed: false,
      lines: [{ text: 'a', startMs: null }, { text: 'b', startMs: null }] });
  });

  it('returns null on identity/album/duration/empty mismatch or 404 but surfaces other failures', async () => {
    for (const body of [{ trackName: 'Other' }, { artistName: 'Other' }, { albumName: 'Other' }, { duration: 203 },
      { syncedLyrics: '', plainLyrics: '' }]) {
      serve(() => json(lrc(body)));
      expect(await getMatchedLyrics(track(), signal()), JSON.stringify(body)).toBeNull();
    }
    serve(() => json({ code: 404 }, 404));
    expect(await getMatchedLyrics(track(), signal())).toBeNull();
    serve(() => json({}, 500));
    await expect(getMatchedLyrics(track(), signal())).rejects.toMatchObject({ status: 500 });
  });
});
