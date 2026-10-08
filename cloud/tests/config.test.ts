import { describe, expect, it, vi } from 'vitest';
import { readCloudConfig } from '../src/config';

type Env = Record<string, string | undefined>;

// Synthetic only: plainly fake hosts and credentials, never real values.
const SENTINEL = 'SYNTHETIC_SENTINEL_7f3a';
const REQUIRED = [
  'DATABASE_URL',
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_URL',
  'SPOTIFY_CLIENT_ID',
  'SPOTIFY_CLIENT_SECRET',
  'SPOTIFY_ALLOWED_USER_IDS',
] as const;
const TRACKED: readonly string[] = [
  ...REQUIRED,
  'OPENAI_API_KEY',
  'AI_ENRICHMENT_ENABLED',
  'OPENAI_MODEL',
  'AI_USER_DAILY_LIMIT',
  'AI_GLOBAL_DAILY_LIMIT',
  'LASTFM_API_KEY',
];
const VALID: Env = {
  DATABASE_URL: 'postgres://fake_user:fake_password@db.example.test:5432/synesthesia_test',
  BETTER_AUTH_SECRET: 'fake-test-secret-0123456789abcdefghij',
  BETTER_AUTH_URL: 'https://synesthesia.example.test',
  SPOTIFY_CLIENT_ID: 'fake-spotify-client-id',
  SPOTIFY_CLIENT_SECRET: 'fake-spotify-client-secret',
  SPOTIFY_ALLOWED_USER_IDS: 'fake_user_a, fake_user_b',
};
const AI_ON: Env = {
  AI_ENRICHMENT_ENABLED: 'true',
  OPENAI_API_KEY: `sk-fake-${SENTINEL}`,
  OPENAI_MODEL: 'fake-model-x',
};

function withEnv(overrides: Env = {}): Env {
  const env: Env = { ...VALID, ...overrides };
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete env[key];
  }
  return env;
}

function okConfig(env: Env) {
  const result = readCloudConfig(env);
  if (!result.ok) throw new Error(`expected ok, missing=${result.missing.join(',')}`);
  return result.config;
}

function failedNames(env: Env): string[] {
  const result = readCloudConfig(env);
  if (result.ok) throw new Error('expected config failure');
  // Names only: no message/value fields, and no synthetic secret echoed back.
  // No config/capabilities are exposed, so lyrics and AI cannot report available.
  expect(Object.keys(result).sort()).toEqual(['missing', 'ok']);
  expect(JSON.stringify(result)).not.toContain(SENTINEL);
  return [...result.missing].sort();
}

describe('readCloudConfig', () => {
  // Mutation caught: any module-level process.env read or eager readCloudConfig(process.env).
  it('reads no server config from process.env at import', async () => {
    const original = process.env;
    const touched = new Set<string>();
    const track = (key: string | symbol): void => {
      if (typeof key === 'string' && TRACKED.includes(key)) touched.add(key);
    };
    const runtimeKeys = ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'NODE_ENV'];
    const target: NodeJS.ProcessEnv = {};
    for (const key of Object.keys(original)) {
      if (runtimeKeys.includes(key) || key.startsWith('VITEST')) target[key] = original[key];
    }
    process.env = new Proxy<NodeJS.ProcessEnv>(target, {
      get: (target, key, receiver) => (track(key), Reflect.get(target, key, receiver)),
      has: (target, key) => (track(key), Reflect.has(target, key)),
      getOwnPropertyDescriptor: (target, key) => (track(key), Reflect.getOwnPropertyDescriptor(target, key)),
    });
    try {
      vi.resetModules();
      const mod = await import('../src/config');
      expect(typeof mod.readCloudConfig).toBe('function');
    } finally {
      process.env = original;
    }
    expect([...touched]).toEqual([]);
  });

  // Mutation caught: OPENAI_API_KEY alone enabling paid AI, wrong defaults, untrimmed CSV,
  // lyrics capability gated on LASTFM_API_KEY.
  it('maps a valid env and keeps paid AI off with only an API key', () => {
    const config = okConfig(withEnv({ OPENAI_API_KEY: 'sk-fake-key-only' }));
    expect(config).toMatchObject({
      databaseUrl: VALID.DATABASE_URL,
      authSecret: VALID.BETTER_AUTH_SECRET,
      publicOrigin: 'https://synesthesia.example.test',
      spotifyClientId: 'fake-spotify-client-id',
      spotifyClientSecret: 'fake-spotify-client-secret',
      allowedSpotifyUserIds: ['fake_user_a', 'fake_user_b'],
      capabilities: { spotify: true, lyrics: true, ai: false },
      ai: { enabled: false, model: 'gpt-5-mini', userDaily: 10, globalDaily: 50 },
    });
    // LRCLIB lyrics are keyless; LASTFM_API_KEY must not gate the lyrics capability.
    expect(okConfig(withEnv({ LASTFM_API_KEY: 'fake-lastfm-key' })).capabilities.lyrics).toBe(true);
  });

  // Mutation caught: skipped required check, partial missing list, `>32` secret bound,
  // empty CSV entries, value leaks.
  it('fails closed with names only for missing or invalid required values', () => {
    // readCloudConfig({}) reports every required name, and nothing else.
    expect(failedNames({})).toEqual([...REQUIRED].sort());
    for (const name of REQUIRED) {
      expect(failedNames(withEnv({ [name]: undefined }))).toEqual([name]);
      expect(failedNames(withEnv({ [name]: '   ' }))).toEqual([name]);
    }
    expect(okConfig(withEnv({ BETTER_AUTH_SECRET: 'x'.repeat(32) })).authSecret).toHaveLength(32);
    expect(
      failedNames(
        withEnv({
          DATABASE_URL: `mysql://fake_user:${SENTINEL}@db.example.test/x`,
          BETTER_AUTH_SECRET: `${SENTINEL}`.slice(0, 31),
          SPOTIFY_ALLOWED_USER_IDS: `fake_user_a,,${SENTINEL}`,
        }),
      ),
    ).toEqual(['BETTER_AUTH_SECRET', 'DATABASE_URL', 'SPOTIFY_ALLOWED_USER_IDS']);
    for (const ids of [' , ', 'fake_user_a,', 'x'.repeat(1000)]) {
      expect(failedNames(withEnv({ SPOTIFY_ALLOWED_USER_IDS: ids }))).toEqual(['SPOTIFY_ALLOWED_USER_IDS']);
    }
  });

  // Mutation caught: accepting creds/path/query/hash, non-HTTPS, or loopback look-alikes.
  it('accepts only bare HTTPS or dev-only loopback BETTER_AUTH_URL origins', () => {
    const rejected: Array<[origin: string, nodeEnv: string]> = [
      ['http://synesthesia.example.test', 'production'],
      [`https://fake_user:${SENTINEL}@synesthesia.example.test`, 'production'],
      ['https://synesthesia.example.test/app', 'production'],
      ['https://synesthesia.example.test?next=1', 'production'],
      ['https://synesthesia.example.test#frag', 'production'],
      ['ftp://synesthesia.example.test', 'production'],
      ['synesthesia.example.test', 'production'],
      ['http://localhost:8787', 'production'],
      ['http://localhost.example.test:8787', 'development'],
      ['http://10.0.0.1:8787', 'development'],
    ];
    for (const [origin, nodeEnv] of rejected) {
      expect(
        failedNames(withEnv({ BETTER_AUTH_URL: origin, NODE_ENV: nodeEnv })),
        `${origin} (NODE_ENV=${nodeEnv})`,
      ).toEqual(['BETTER_AUTH_URL']);
    }
    for (const loopback of ['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787']) {
      const config = okConfig(withEnv({ BETTER_AUTH_URL: loopback, NODE_ENV: 'development' }));
      expect(config.publicOrigin).toBe(loopback);
    }
  });

  // Mutation caught: truthy-string parsing, ignoring explicit false, missing model default.
  it('enables paid AI only with explicit true flag and key', () => {
    expect(okConfig(withEnv(AI_ON))).toMatchObject({
      capabilities: { ai: true },
      ai: { enabled: true, model: 'fake-model-x' },
    });
    expect(okConfig(withEnv({ ...AI_ON, OPENAI_MODEL: undefined })).ai).toMatchObject({
      enabled: true,
      model: 'gpt-5-mini',
    });
    expect(okConfig(withEnv({ ...AI_ON, AI_ENRICHMENT_ENABLED: 'false' })).ai.enabled).toBe(false);
    for (const flag of ['yes', '1', 'on', `${SENTINEL}`]) {
      expect(failedNames(withEnv({ ...AI_ON, AI_ENRICHMENT_ENABLED: flag }))).toEqual(['AI_ENRICHMENT_ENABLED']);
    }
  });

  // Mutation caught: AI enabled without a key, or with blank/unbounded model.
  it('fails closed on missing key or invalid model when AI is enabled', () => {
    expect(failedNames(withEnv({ ...AI_ON, OPENAI_API_KEY: undefined }))).toEqual(['OPENAI_API_KEY']);
    expect(failedNames(withEnv({ ...AI_ON, OPENAI_API_KEY: '  ' }))).toEqual(['OPENAI_API_KEY']);
    expect(failedNames(withEnv({ ...AI_ON, OPENAI_MODEL: '  ' }))).toEqual(['OPENAI_MODEL']);
    expect(failedNames(withEnv({ ...AI_ON, OPENAI_MODEL: SENTINEL.repeat(10) }))).toEqual(['OPENAI_MODEL']);
  });

  // Mutation caught: Number()/parseInt leniency, off-by-one caps, accepting zero/negatives.
  it('accepts only bounded positive integer daily limits', () => {
    expect(
      okConfig(withEnv({ ...AI_ON, AI_USER_DAILY_LIMIT: '1000', AI_GLOBAL_DAILY_LIMIT: '10000' })).ai,
    ).toMatchObject({ userDaily: 1000, globalDaily: 10000 });
    const invalid = ['', ' ', '1e2', '1.5', 'NaN', 'Infinity', '-1', '0', '0x10'];
    for (const value of [...invalid, '1001']) {
      expect(failedNames(withEnv({ ...AI_ON, AI_USER_DAILY_LIMIT: value }))).toEqual(['AI_USER_DAILY_LIMIT']);
    }
    for (const value of [...invalid, '10001']) {
      expect(failedNames(withEnv({ ...AI_ON, AI_GLOBAL_DAILY_LIMIT: value }))).toEqual(['AI_GLOBAL_DAILY_LIMIT']);
    }
  });
});
