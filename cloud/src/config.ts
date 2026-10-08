export interface CloudCapabilities {
  spotify: boolean;
  lyrics: boolean;
  ai: boolean;
}

export interface CloudAiConfig {
  enabled: boolean;
  model: string;
  userDaily: number;
  globalDaily: number;
}

export interface CloudConfig {
  databaseUrl: string;
  authSecret: string;
  publicOrigin: string;
  spotifyClientId: string;
  spotifyClientSecret: string;
  allowedSpotifyUserIds: readonly string[];
  /** Server-only; null when unset. */
  lastFmApiKey: string | null;
  /** Server-only; null unless paid AI is explicitly enabled. */
  openAiApiKey: string | null;
  capabilities: CloudCapabilities;
  ai: CloudAiConfig;
}

export type CloudConfigResult =
  | { ok: true; config: CloudConfig }
  | { ok: false; missing: readonly string[] };

// Lazy by design: nothing here reads process.env or touches the network at import.
// readCloudConfig reads only the env it is given and reports failing names, never values.
// Capabilities mean "configured", not "provider verified live".

const DEFAULT_AI_MODEL = 'gpt-5-mini';
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const WHITESPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f-\u009f]/;
const SPOTIFY_USER_ID = /^[A-Za-z0-9_.-]{1,128}$/;
const MAX_ALLOWED_USERS = 100;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DECIMAL_LIMIT = /^[1-9][0-9]{0,5}$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Parsers return undefined for an invalid value; optional parsers map absence to a default.

function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return typeof value === 'string' ? value : undefined;
}

function parseSecret(value: string | undefined, min: number, max: number): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length < min || trimmed.length > max) return undefined;
  return CONTROL_CHARS.test(trimmed) ? undefined : trimmed;
}

function parseOptionalSecret(value: string | undefined, max: number): string | null | undefined {
  return value === undefined ? null : parseSecret(value, 1, max);
}

function parseUrl(value: string, maxLength: number): URL | undefined {
  if (!value || value.length > maxLength || WHITESPACE_OR_CONTROL.test(value)) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

// TLS and pooling are configured where the pool is created; nothing connects here.
function parseDatabaseUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const url = parseUrl(value, 4096);
  if (!url || value.includes('#')) return undefined;
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return undefined;
  if (url.hostname === '' || !/^\/[^/]+$/.test(url.pathname)) return undefined;
  if (url.port !== '' && Number(url.port) < 1) return undefined;
  return value;
}

// Exact bare origin: matching URL's canonical origin rejects userinfo, paths, query, hash,
// default ports, percent-encoding, and IPv4-shorthand or suffix look-alikes.
function parsePublicOrigin(value: string | undefined, nodeEnv: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const url = parseUrl(value, 2048);
  const bare = value.endsWith('/') ? value.slice(0, -1) : value;
  if (!url || url.origin.toLowerCase() !== bare.toLowerCase()) return undefined;
  if (url.protocol === 'https:') return url.origin;
  const devLoopback =
    nodeEnv === 'development' && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  return devLoopback ? url.origin : undefined;
}

function parseAllowedUserIds(value: string | undefined): readonly string[] | undefined {
  if (value === undefined || value.length > MAX_ALLOWED_USERS * 130) return undefined;
  const ids = value.split(',').map((id) => id.trim());
  if (!ids.every((id) => SPOTIFY_USER_ID.test(id))) return undefined;
  const unique = [...new Set(ids)];
  return unique.length <= MAX_ALLOWED_USERS ? unique : undefined;
}

function parseFlag(value: string | undefined): boolean | undefined {
  if (value === undefined) return false;
  return value === 'true' ? true : value === 'false' ? false : undefined;
}

function parseModel(value: string | undefined): string | undefined {
  if (value === undefined) return DEFAULT_AI_MODEL;
  return MODEL_ID.test(value) ? value : undefined;
}

function parseLimit(value: string | undefined, fallback: number, cap: number): number | undefined {
  if (value === undefined) return fallback;
  if (!DECIMAL_LIMIT.test(value)) return undefined;
  const limit = Number(value);
  return limit <= cap ? limit : undefined;
}

export function readCloudConfig(env: NodeJS.ProcessEnv): CloudConfigResult {
  const invalid: string[] = [];
  // Values are only used once `invalid` is empty, so the cast never exposes an invalid read.
  const check = <T>(name: string, value: T | undefined): T => {
    if (value === undefined) invalid.push(name);
    return value as T;
  };

  const databaseUrl = check('DATABASE_URL', parseDatabaseUrl(read(env, 'DATABASE_URL')));
  const authSecret = check('BETTER_AUTH_SECRET', parseSecret(read(env, 'BETTER_AUTH_SECRET'), 32, 512));
  const publicOrigin = check(
    'BETTER_AUTH_URL',
    parsePublicOrigin(read(env, 'BETTER_AUTH_URL'), read(env, 'NODE_ENV')),
  );
  const spotifyClientId = check('SPOTIFY_CLIENT_ID', parseSecret(read(env, 'SPOTIFY_CLIENT_ID'), 1, 256));
  const spotifyClientSecret = check(
    'SPOTIFY_CLIENT_SECRET',
    parseSecret(read(env, 'SPOTIFY_CLIENT_SECRET'), 1, 256),
  );
  const allowedSpotifyUserIds = check(
    'SPOTIFY_ALLOWED_USER_IDS',
    parseAllowedUserIds(read(env, 'SPOTIFY_ALLOWED_USER_IDS')),
  );
  const lastFmApiKey = check('LASTFM_API_KEY', parseOptionalSecret(read(env, 'LASTFM_API_KEY'), 128));

  // Paid AI needs the explicit flag; a key alone never enables it.
  const aiEnabled = check('AI_ENRICHMENT_ENABLED', parseFlag(read(env, 'AI_ENRICHMENT_ENABLED')));
  const rawKey = read(env, 'OPENAI_API_KEY');
  const openAiApiKey = check(
    'OPENAI_API_KEY',
    aiEnabled ? parseSecret(rawKey, 1, 512) : parseOptionalSecret(rawKey, 512),
  );
  const model = check('OPENAI_MODEL', parseModel(read(env, 'OPENAI_MODEL')));
  const userDaily = check('AI_USER_DAILY_LIMIT', parseLimit(read(env, 'AI_USER_DAILY_LIMIT'), 10, 1000));
  const globalDaily = check(
    'AI_GLOBAL_DAILY_LIMIT',
    parseLimit(read(env, 'AI_GLOBAL_DAILY_LIMIT'), 50, 10000),
  );

  if (invalid.length > 0) return { ok: false, missing: invalid };
  return {
    ok: true,
    config: {
      databaseUrl,
      authSecret,
      publicOrigin,
      spotifyClientId,
      spotifyClientSecret,
      allowedSpotifyUserIds,
      lastFmApiKey,
      openAiApiKey: aiEnabled ? openAiApiKey : null,
      capabilities: { spotify: true, lyrics: true, ai: aiEnabled },
      ai: { enabled: aiEnabled, model, userDaily, globalDaily },
    },
  };
}
