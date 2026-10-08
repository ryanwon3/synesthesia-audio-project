import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { spotify } from 'better-auth/social-providers';

// Only the database module and the fetch transport are replaced. authOptions, readCloudConfig and the
// public better-auth Spotify provider factory are real. The bound applies to provider refresh only;
// getAccessToken is never wrapped, and the wrapper does not abort the SDK transport.
const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(() => { throw new Error('no database in unit tests'); }),
}));
vi.mock('../src/db', () => ({ getDatabase: mocks.getDatabase }));

import { authOptions } from '../src/auth';
import { readCloudConfig } from '../src/config';

const SENTINEL = 'SYNTHETIC_SENTINEL_5e2a';
const FAILED = 'Spotify token refresh unavailable';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const NOW = Date.UTC(2026, 0, 1);
const ENV: Record<string, string | undefined> = {
  DATABASE_URL: 'postgres://fake_user:fake_password@db.example.test:5432/synesthesia_test',
  BETTER_AUTH_SECRET: 'fake-test-secret-0123456789abcdefghij',
  BETTER_AUTH_URL: 'https://synesthesia.example.test',
  SPOTIFY_CLIENT_ID: 'fake-spotify-client-id',
  SPOTIFY_CLIENT_SECRET: 'fake-spotify-client-secret',
  SPOTIFY_ALLOWED_USER_IDS: 'fake_user_a',
  AI_ENRICHMENT_ENABLED: 'false',
};
const CONSOLE = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;

type Refresh = (refreshToken: string) => Promise<unknown>;
type Seen = { url: string; method: string | undefined; headers: Array<[string, string]>; body: string };
type State = { fulfilled: number; rejected: number; reason: unknown };

function setup() {
  const result = readCloudConfig(ENV);
  if (!result.ok) throw new Error('synthetic config rejected');
  const options = authOptions(result.config, {} as Pool);
  // socialProviders.spotify is typed as options-or-lazy-factory; authOptions supplies a plain object.
  const configuredOptions = options.socialProviders?.spotify;
  if (!configuredOptions || typeof configuredOptions === 'function') throw new Error('spotify provider missing');
  const provider = configuredOptions as Parameters<typeof spotify>[0];
  const configured = spotify(provider).refreshAccessToken as Refresh;
  const original = spotify({
    clientId: result.config.spotifyClientId,
    clientSecret: result.config.spotifyClientSecret,
    redirectURI: provider.redirectURI as string,
  }).refreshAccessToken as Refresh;
  return { options, provider, configured, original };
}

// Observers attach immediately, so no rejection is ever unhandled and nothing awaits a pending promise.
function track(promise: Promise<unknown>): State {
  const state: State = { fulfilled: 0, rejected: 0, reason: undefined };
  promise.then(() => { state.fulfilled += 1; }, (reason: unknown) => { state.rejected += 1; state.reason = reason; });
  return state;
}

// setImmediate is not faked, so this drains transport/body microtasks without firing fake timers.
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

function capture(input: unknown, init?: RequestInit): Seen {
  const body = init?.body;
  return {
    url: input instanceof Request ? input.url : String(input),
    method: init?.method,
    headers: [...new Headers(init?.headers).entries()],
    body: body instanceof URLSearchParams ? body.toString() : String(body),
  };
}

const tokens = (): Response => new Response(JSON.stringify({
  access_token: 'fake-access-token', refresh_token: 'fake-refresh-token-2',
  expires_in: 3600, token_type: 'Bearer', scope: 'user-read-currently-playing',
}), { status: 200, headers: { 'content-type': 'application/json' } });

function stalled() {
  const gate: { resolve?: (response: Response) => void; reject?: (error: unknown) => void } = {};
  const fetch = vi.fn(() => new Promise<Response>((resolve, reject) => { gate.resolve = resolve; gate.reject = reject; }));
  vi.stubGlobal('fetch', fetch);
  return { fetch, gate };
}

function expectFixed(state: State): void {
  expect(state.fulfilled).toBe(0);
  expect(state.rejected).toBe(1);
  const reason = state.reason as Error;
  expect(reason).toBeInstanceOf(Error);
  expect(reason.message).toBe(FAILED);
  expect(reason.cause).toBeUndefined();
  expect(JSON.stringify(reason, Object.getOwnPropertyNames(reason))).not.toContain(SENTINEL);
}

let quiet: Array<ReturnType<typeof vi.spyOn>> = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: NOW });
  mocks.getDatabase.mockClear();
  quiet = CONSOLE.map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Spotify provider refresh bound', () => {
  it('keeps the library endpoint, client credential codec and token fields on success', async () => {
    const { options, provider, configured, original } = setup();
    expect(provider.scope).toEqual(['user-read-currently-playing']);
    expect(options.logger).toEqual({ disabled: true });
    expect(options.account?.encryptOAuthTokens).toBe(true);
    const seen: Seen[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => { seen.push(capture(input, init)); return tokens(); }));
    const fixed = await configured('fake-refresh-token');
    const baseline = await original('fake-refresh-token');
    expect(fixed).toEqual(baseline);
    expect(fixed).toMatchObject({ accessToken: 'fake-access-token', refreshToken: 'fake-refresh-token-2' });
    expect((fixed as { accessTokenExpiresAt?: unknown }).accessTokenExpiresAt).toBeInstanceOf(Date);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[0]!.url).toBe(TOKEN_URL);
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.body).toContain('grant_type=refresh_token');
    expect(seen[0]!.body).toContain('refresh_token=fake-refresh-token');
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.getDatabase).not.toHaveBeenCalled();
  });

  it('stays pending at 2999ms and rejects with the fixed error at 3000ms', async () => {
    const { configured } = setup();
    const { fetch } = stalled();
    const state = track(configured('fake-refresh-token'));
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2999);
    await settle();
    expect(state).toMatchObject({ fulfilled: 0, rejected: 0 });
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expectFixed(state);
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.getDatabase).not.toHaveBeenCalled();
  });

  it('a late transport success after the timeout cannot fulfil the refresh', async () => {
    const { configured } = setup();
    const { fetch, gate } = stalled();
    const state = track(configured('fake-refresh-token'));
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    await settle();
    expectFixed(state);
    gate.resolve!(tokens());
    await settle();
    expectFixed(state);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a late transport rejection after the timeout is handled and stays private', async () => {
    const { configured } = setup();
    const { fetch, gate } = stalled();
    const state = track(configured('fake-refresh-token'));
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    await settle();
    expectFixed(state);
    gate.reject!(new Error(SENTINEL));
    await settle();
    expectFixed(state);
    expect(vi.getTimerCount()).toBe(0);
    for (const spy of quiet) expect(spy).not.toHaveBeenCalled();
  });

  it('redacts immediate provider HTTP failures and transport errors without console output', async () => {
    const { configured } = setup();
    const failures: Array<() => Promise<Response>> = [
      async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: SENTINEL }),
        { status: 400, headers: { 'content-type': 'application/json' } }),
      () => Promise.reject(new TypeError(SENTINEL)),
    ];
    for (const failure of failures) {
      vi.stubGlobal('fetch', vi.fn(failure));
      const state = track(configured('fake-refresh-token'));
      await settle();
      expectFixed(state);
      expect(vi.getTimerCount()).toBe(0);
    }
    for (const spy of quiet) expect(spy).not.toHaveBeenCalled();
    expect(mocks.getDatabase).not.toHaveBeenCalled();
  });
});
