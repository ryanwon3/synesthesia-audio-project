import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

// Only auth transport (getAuth) and database transport (getDatabase) are mocked.
// config, http, auth-policy and authOptions are the real functions.
const mocks = vi.hoisted(() => ({
  handler: vi.fn<(request: Request) => Promise<Response>>(),
  getSession: vi.fn<(input: unknown) => Promise<unknown>>(),
  getDatabase: vi.fn(() => {
    throw new Error('no database in unit tests');
  }),
}));
vi.mock('../src/db', () => ({ getDatabase: mocks.getDatabase }));
vi.mock('../src/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/auth')>()),
  getAuth: () => ({ handler: mocks.handler, api: { getSession: mocks.getSession } }),
}));

import { authOptions } from '../src/auth';
import { handleAuth } from '../src/auth-policy';
import { readCloudConfig } from '../src/config';

const SENTINEL = 'SYNTHETIC_SENTINEL_9c1d';
const ORIGIN = 'https://synesthesia.example.test';
const SIGN_IN = '/api/auth/sign-in/social';
const ENV: Record<string, string | undefined> = {
  DATABASE_URL: 'postgres://fake_user:fake_password@db.example.test:5432/synesthesia_test',
  BETTER_AUTH_SECRET: 'fake-test-secret-0123456789abcdefghij',
  BETTER_AUTH_URL: ORIGIN,
  SPOTIFY_CLIENT_ID: 'fake-spotify-client-id',
  SPOTIFY_CLIENT_SECRET: 'fake-spotify-client-secret',
  SPOTIFY_ALLOWED_USER_IDS: 'fake_user_a',
  AI_ENRICHMENT_ENABLED: 'false',
  OPENAI_API_KEY: undefined,
  OPENAI_MODEL: undefined,
  LASTFM_API_KEY: undefined,
  AI_USER_DAILY_LIMIT: undefined,
  AI_GLOBAL_DAILY_LIMIT: undefined,
};

type Call = { method?: string; origin?: string | null; body?: string; headers?: Record<string, string>; base?: string };
function call(path: string, init: Call = {}): Promise<Response> {
  const method = init.method ?? 'POST';
  const headers: Record<string, string> = { 'content-type': 'application/json', ...init.headers };
  const origin = init.origin === undefined ? ORIGIN : init.origin;
  if (origin !== null) headers.origin = origin;
  // exactOptionalPropertyTypes: omit body entirely for GET/HEAD instead of passing undefined.
  const request: RequestInit = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') request.body = init.body ?? '{}';
  return handleAuth(new Request(`${init.base ?? ORIGIN}${path}`, request));
}

// Mirrors the immutable header guard on fetch() and Response.redirect results:
// any mutation throws, so the policy layer must copy headers/body instead.
function immutable(response: Response): Response {
  for (const name of ['set', 'append', 'delete'] as const) {
    Object.defineProperty(response.headers, name, { value: () => { throw new TypeError('immutable'); } });
  }
  return response;
}

async function denied(response: Response, status: number, error: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ error });
}

function libraryUntouched(): void {
  expect(mocks.handler).not.toHaveBeenCalled();
  expect(mocks.getSession).not.toHaveBeenCalled();
  expect(mocks.getDatabase).not.toHaveBeenCalled();
}

beforeEach(() => {
  for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
  mocks.handler.mockReset();
  mocks.getSession.mockReset();
  mocks.getDatabase.mockClear();
});

describe('handleAuth', () => {
  it('denies foreign origins, unlisted endpoints, wrong methods and missing config before the library', async () => {
    await denied(await call('/api/auth/ok', { method: 'GET', base: 'https://evil.example.test' }), 403, 'forbidden');
    await denied(await call(SIGN_IN, { base: 'http://synesthesia.example.test' }), 403, 'forbidden');
    const blocked = ['get-access-token', 'refresh-token', 'account-info', 'list-accounts', 'unlink-account',
      'link-social', 'sign-in/oauth2', 'sign-in/email', 'sign-up/email', 'callback/github',
      'oauth2/callback/spotify', 'update-user', 'delete-user', 'list-sessions', 'revoke-sessions',
      'sign-in/social/', 'callback/spotify/', 'SIGN-OUT', 'get%2Daccess%2Dtoken'];
    const body = JSON.stringify({ provider: 'spotify', providerId: 'github', accountId: 'x', userId: 'fake_user_b' });
    for (const name of blocked) {
      for (const method of ['GET', 'POST']) {
        await denied(await call(`/api/auth/${name}`, { method, body }), 403, 'forbidden');
      }
    }
    const wrong: Array<[string, string]> = [['GET', SIGN_IN], ['GET', '/api/auth/sign-out'],
      ['POST', '/api/auth/callback/spotify'], ['POST', '/api/auth/get-session'], ['PUT', '/api/auth/sign-out'],
      ['HEAD', '/api/auth/ok'], ['OPTIONS', SIGN_IN]];
    for (const [method, path] of wrong) await denied(await call(path, { method }), 403, 'forbidden');
    vi.stubEnv('BETTER_AUTH_URL', 'http://synesthesia.example.test');
    vi.stubEnv('SPOTIFY_CLIENT_SECRET', '');
    await denied(await call('/api/auth/get-session', { method: 'GET' }), 503, 'unavailable');
    await denied(await call(SIGN_IN, { body: JSON.stringify({ provider: 'spotify' }) }), 503, 'unavailable');
    libraryUntouched();
  });

  it('get-session reports only signedIn and never library tokens or user columns', async () => {
    mocks.getSession.mockResolvedValueOnce({
      session: { id: 's1', userId: 'u1', token: SENTINEL },
      user: { id: 'u1', email: `${SENTINEL}@example.test`, name: SENTINEL },
    });
    const response = await call('/api/auth/get-session', { method: 'GET', headers: { cookie: 'synthetic_session=1' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.has('set-cookie')).toBe(false);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ signedIn: true });
    expect(text).not.toContain(SENTINEL);
    const [input] = mocks.getSession.mock.calls[0] as [{ headers: Headers; query: unknown }];
    expect(input.query).toEqual({ disableCookieCache: true });
    expect(input.headers.get('cookie')).toBe('synthetic_session=1');
    mocks.getSession.mockResolvedValueOnce(null);
    expect(await (await call('/api/auth/get-session', { method: 'GET' })).json()).toEqual({ signedIn: false });
    mocks.getSession.mockRejectedValueOnce(new Error(SENTINEL));
    await denied(await call('/api/auth/get-session', { method: 'GET' }), 503, 'unavailable');
    expect(mocks.handler).not.toHaveBeenCalled();
  });

  it('requires exact same-origin headers for sign-in and sign-out', async () => {
    const body = JSON.stringify({ provider: 'spotify' });
    for (const path of [SIGN_IN, '/api/auth/sign-out']) {
      for (const origin of [null, 'null', 'https://evil.example.test', `${ORIGIN}.evil.example.test`, 'http://synesthesia.example.test']) {
        await denied(await call(path, { origin, body }), 403, 'forbidden');
      }
      await denied(await call(path, { body, headers: { 'sec-fetch-site': 'cross-site' } }), 403, 'forbidden');
    }
    libraryUntouched();
  });

  it('rejects non-Spotify providers, caller scopes, id tokens, user ids and off-site callbacks', async () => {
    const bodies: unknown[] = [{ provider: 'github' }, { provider: 'SPOTIFY' }, { provider: ['spotify'] }, {},
      { provider: 'spotify', scopes: ['user-read-private'] }, { provider: 'spotify', scope: 'playlist-modify-private' },
      { provider: 'spotify', idToken: { token: SENTINEL } }, { provider: 'spotify', userId: 'fake_user_b' },
      { provider: 'spotify', accountId: 'x' }, { provider: 'spotify', requestSignUp: true },
      { provider: 'spotify', disableRedirect: false }, { provider: 'spotify', loginHint: 'x' },
      { provider: 'spotify', newUserCallbackURL: '/' }, { provider: 'spotify', additionalData: {} },
      { provider: 'spotify', callbackURL: 'https://evil.example.test/' }, { provider: 'spotify', callbackURL: '//evil.example.test' },
      { provider: 'spotify', callbackURL: `${ORIGIN}/` }, { provider: 'spotify', errorCallbackURL: '/error' },
      { provider: 'spotify', callbackURL: null }];
    for (const body of bodies) await denied(await call(SIGN_IN, { body: JSON.stringify(body) }), 400, 'unavailable');
    for (const raw of ['[]', 'null', '"spotify"', '{bad', '{"__proto__":{"provider":"spotify"},"provider":"spotify"}']) {
      await denied(await call(SIGN_IN, { body: raw }), 400, 'unavailable');
    }
    const valid = JSON.stringify({ provider: 'spotify' });
    await denied(await call(SIGN_IN, { body: valid, headers: { 'content-type': 'text/plain' } }), 415, 'unavailable');
    const huge = JSON.stringify({ provider: 'spotify', callbackURL: '/'.padEnd(2000, 'a') });
    await denied(await call(SIGN_IN, { body: huge }), 413, 'unavailable');
    libraryUntouched();
  });

  it('forwards only the fixed Spotify sign-in body and forces no-store', async () => {
    const fixed = { provider: 'spotify', callbackURL: '/', errorCallbackURL: '/', disableRedirect: true };
    mocks.handler.mockResolvedValueOnce(new Response(JSON.stringify({ url: 'https://accounts.example.test/authorize', redirect: false }), {
      headers: { 'cache-control': 'public, max-age=60', 'set-cookie': 'synthetic_state=1; HttpOnly' },
    }));
    const body = JSON.stringify({ provider: 'spotify', callbackURL: '/', errorCallbackURL: '/' });
    const response = await call(SIGN_IN, { body, headers: { cookie: 'synthetic=1' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('set-cookie')).toBe('synthetic_state=1; HttpOnly');
    const forwarded = mocks.handler.mock.calls[0]![0];
    expect(forwarded.method).toBe('POST');
    expect(forwarded.url).toBe(`${ORIGIN}${SIGN_IN}`);
    expect(forwarded.headers.get('origin')).toBe(ORIGIN);
    expect(forwarded.headers.get('cookie')).toBe('synthetic=1');
    expect(forwarded.headers.has('content-length')).toBe(false);
    expect(await forwarded.json()).toEqual(fixed);
    mocks.handler.mockResolvedValueOnce(new Response('{}'));
    await call(SIGN_IN, { body: JSON.stringify({ provider: 'spotify' }) });
    expect(await mocks.handler.mock.calls[1]![0].json()).toEqual(fixed);
    expect(mocks.getDatabase).not.toHaveBeenCalled();
  });

  it('sign-out forwards only an empty JSON object', async () => {
    mocks.handler.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const response = await call('/api/auth/sign-out', { body: '{}' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await mocks.handler.mock.calls[0]![0].json()).toEqual({});
    for (const raw of [JSON.stringify({ all: true }), JSON.stringify({ userId: 'fake_user_b' }), '[]']) {
      await denied(await call('/api/auth/sign-out', { body: raw }), 400, 'unavailable');
    }
    expect(mocks.handler).toHaveBeenCalledTimes(1);
  });

  it('delegates the fixed Spotify callback and keeps library failures generic', async () => {
    const path = '/api/auth/callback/spotify?code=synthetic&state=synthetic';
    mocks.handler.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: `${ORIGIN}/` } }));
    const response = await call(path, { method: 'GET' });
    expect(response.status).toBe(302);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.handler.mock.calls[0]![0].url).toBe(`${ORIGIN}${path}`);
    mocks.handler.mockRejectedValueOnce(new Error(SENTINEL));
    await denied(await call(path, { method: 'GET' }), 400, 'authentication_failed');
    mocks.handler.mockRejectedValueOnce(new Error(SENTINEL));
    await denied(await call('/api/auth/sign-out'), 503, 'unavailable');
    expect(mocks.getSession).not.toHaveBeenCalled();
  });

  it('copies immutable library responses, keeping status, location, cookies, body and no-store', async () => {
    const path = '/api/auth/callback/spotify?code=synthetic&state=synthetic';
    mocks.handler.mockResolvedValueOnce(Response.redirect(`${ORIGIN}/`, 302));
    const redirect = await call(path, { method: 'GET' });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe(`${ORIGIN}/`);
    expect(redirect.headers.get('cache-control')).toBe('no-store');
    const authorize = { url: 'https://accounts.example.test/authorize', redirect: false };
    mocks.handler.mockResolvedValueOnce(immutable(new Response(JSON.stringify(authorize), {
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=60', 'set-cookie': 'synthetic_state=1; HttpOnly' },
    })));
    const signIn = await call(SIGN_IN, { body: JSON.stringify({ provider: 'spotify' }) });
    expect(signIn.status).toBe(200);
    expect(signIn.headers.get('cache-control')).toBe('no-store');
    expect(signIn.headers.get('set-cookie')).toBe('synthetic_state=1; HttpOnly');
    expect(await signIn.json()).toEqual(authorize);
    mocks.handler.mockResolvedValueOnce(immutable(new Response(JSON.stringify({ success: true }), {
      headers: { 'content-type': 'application/json', 'set-cookie': 'synthetic_session=; Max-Age=0' },
    })));
    const signOut = await call('/api/auth/sign-out');
    expect(signOut.status).toBe(200);
    expect(signOut.headers.get('cache-control')).toBe('no-store');
    expect(signOut.headers.get('set-cookie')).toBe('synthetic_session=; Max-Age=0');
    expect(await signOut.json()).toEqual({ success: true });
    expect(mocks.handler).toHaveBeenCalledTimes(3);
    expect(mocks.getSession).not.toHaveBeenCalled();
  });
});

describe('authOptions', () => {
  it('configures Spotify only, with fixed callback, scope and pilot allowlist', async () => {
    const result = readCloudConfig(ENV);
    if (!result.ok) throw new Error('synthetic config rejected');
    const pool = {} as Pool; // Never connected: building options must not touch the database.
    const options = authOptions(result.config, pool);
    expect(options.database).toBe(pool);
    expect(Object.keys(options.socialProviders ?? {})).toEqual(['spotify']);
    expect(options.socialProviders?.spotify).toMatchObject({
      redirectURI: `${ORIGIN}/api/auth/callback/spotify`,
      scope: ['user-read-currently-playing'],
      disableIdTokenSignIn: true,
    });
    expect(options).toMatchObject({
      baseURL: ORIGIN, basePath: '/api/auth', trustedOrigins: [ORIGIN],
      emailAndPassword: { enabled: false },
      account: { encryptOAuthTokens: true, storeAccountCookie: false, accountLinking: { enabled: false } },
      session: { cookieCache: { enabled: false } },
      advanced: { useSecureCookies: true, disableCSRFCheck: false, disableOriginCheck: false, crossSubDomainCookies: { enabled: false } },
      logger: { disabled: true },
    });
    expect(options.plugins ?? []).toEqual([]);
    const validate = options.user?.validateUserInfo as unknown as (input: unknown) => unknown;
    const source = (method: string, providerId: string, id: unknown) => ({ source: { method, oauth: { providerId, profile: { id } } } });
    expect(await validate(source('oauth', 'spotify', 'fake_user_a'))).toBeUndefined();
    const rejected = [source('oauth', 'spotify', 'fake_user_b'), source('oauth', 'github', 'fake_user_a'),
      source('id-token', 'spotify', 'fake_user_a'), source('oauth', 'spotify', 7), { source: { method: 'oauth' } }];
    for (const input of rejected) expect(await validate(input)).toMatchObject({ error: 'pilot_access_denied' });
    expect(mocks.getDatabase).not.toHaveBeenCalled();
    expect(mocks.handler).not.toHaveBeenCalled();
  });

  it('deliberately disables sliding session refresh because get-session cannot carry refreshed cookies', () => {
    const result = readCloudConfig(ENV);
    if (!result.ok) throw new Error('synthetic config rejected');
    const options = authOptions(result.config, {} as Pool);
    // Public get-session returns only { signedIn } and would drop a refreshed session cookie.
    expect(options.session).toMatchObject({ disableSessionRefresh: true, cookieCache: { enabled: false } });
    expect(mocks.getDatabase).not.toHaveBeenCalled();
  });
});
