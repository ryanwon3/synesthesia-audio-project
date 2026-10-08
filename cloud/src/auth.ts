import { betterAuth, type BetterAuthOptions } from "better-auth";
import { spotify } from "better-auth/social-providers";
import type { Pool, PoolClient } from "pg";
import { startDeadline } from "./bounded-body";
import { readCloudConfig, type CloudConfig } from "./config";
import { getDatabase } from "./db";

export class AuthFailure extends Error {
  constructor(public readonly status: 401 | 403) { super("Account access unavailable"); }
}

const REFRESH_FAILED = "Spotify token refresh unavailable";
const REFRESH_DEADLINE_MS = 3000;

// Explicit options also supply the migration generator; neither is constructed at import.
export function authOptions(config: CloudConfig, database: Pool): BetterAuthOptions {
  const secure = config.publicOrigin.startsWith("https://");
  const spotifyBase: Parameters<typeof spotify>[0] = {
    clientId: config.spotifyClientId,
    clientSecret: config.spotifyClientSecret,
    redirectURI: `${config.publicOrigin}/api/auth/callback/spotify`,
    scope: ["user-read-currently-playing"],
    disableIdTokenSignIn: true,
  };
  // The library refresh (endpoint, client credential codec, expiry parsing) is built from the base
  // options WITHOUT the override below, so the wrapper never calls itself. It is network-only.
  const original = spotify(spotifyBase);
  const refresh = original.refreshAccessToken;
  return {
    database,
    baseURL: config.publicOrigin,
    basePath: "/api/auth",
    secret: config.authSecret,
    trustedOrigins: [config.publicOrigin],
    emailAndPassword: { enabled: false },
    socialProviders: {
      spotify: {
        ...spotifyBase,
        // Bounds only the provider refresh. The library awaits this before updating the account row,
        // so a deadline rejection precedes any write. The SDK transport itself is not aborted; a late
        // settle is observed and discarded. Fixed error: no cause, provider detail or logging.
        refreshAccessToken: async (refreshToken: string) => {
          const deadline = startDeadline(undefined, REFRESH_DEADLINE_MS);
          try {
            if (!refresh) throw new Error(REFRESH_FAILED);
            return await deadline.run(() => refresh.call(original, refreshToken));
          } catch {
            throw new Error(REFRESH_FAILED);
          } finally { deadline.dispose(); }
        },
      },
    },
    user: {
      validateUserInfo: ({ source }) => {
        const id = source.oauth?.profile?.id;
        if (source.method !== "oauth" || source.oauth?.providerId !== "spotify" ||
          typeof id !== "string" || !config.allowedSpotifyUserIds.includes(id)) {
          return { error: "pilot_access_denied", errorDescription: "This account is not in the private pilot." };
        }
      },
    },
    account: {
      encryptOAuthTokens: true,
      storeStateStrategy: "database",
      storeAccountCookie: false,
      accountLinking: { enabled: false },
    },
    // Deliberate fixed 24h pilot session (no sliding refresh): public get-session returns only
    // { signedIn } and cannot carry a refreshed session cookie, so the library must not rotate it.
    session: { cookieCache: { enabled: false }, expiresIn: 86400, disableSessionRefresh: true },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 30 },
    advanced: {
      useSecureCookies: secure,
      disableCSRFCheck: false,
      disableOriginCheck: false,
      defaultCookieAttributes: { secure, httpOnly: true, sameSite: "lax" },
      crossSubDomainCookies: { enabled: false },
    },
    // The library may include provider errors in its default logger. Keep those private.
    logger: { disabled: true },
  };
}

function createAuth() {
  const result = readCloudConfig(process.env);
  if (!result.ok) throw new Error("Cloud configuration unavailable");
  return betterAuth(authOptions(result.config, getDatabase()));
}
let instance: ReturnType<typeof createAuth> | undefined;
export function getAuth(): ReturnType<typeof createAuth> { return instance ??= createAuth(); }

async function ownedAccount(userId: string): Promise<{ id: string; accountId: string }> {
  const result = readCloudConfig(process.env);
  if (!result.ok) throw new Error("Cloud configuration unavailable");
  const account = await getDatabase().query<{ id: string; accountId: string }>(
    'SELECT "id", "accountId" FROM "account" WHERE "userId"=$1 AND "providerId"=$2 ORDER BY "id" LIMIT 2',
    [userId, "spotify"]);
  const row = account.rows[0];
  if (account.rows.length !== 1 || !row || !result.config.allowedSpotifyUserIds.includes(row.accountId)) throw new AuthFailure(403);
  return row;
}

export async function requireUser(headers: Headers): Promise<{ userId: string }> {
  const session = await getAuth().api.getSession({ headers, query: { disableCookieCache: true } });
  if (!session) throw new AuthFailure(401);
  await ownedAccount(session.user.id);
  return { userId: session.user.id };
}

export async function getSpotifyToken(headers: Headers, userId: string): Promise<string> {
  const config = readCloudConfig(process.env);
  if (!config.ok) throw new Error("Cloud configuration unavailable");
  const client = await getDatabase().connect();
  try {
    await client.query("BEGIN");
    // Serialize trusted token refresh and disconnect without locking the row the library updates.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`auth:${userId}`]);
    // Use this borrowed connection for library queries as well. Holding a pool
    // slot while acquiring another can starve a three-connection serverless pool.
    const auth = betterAuth(authOptions(config.config, borrowedPool(getDatabase(), client)));
    const session = await auth.api.getSession({ headers, query: { disableCookieCache: true } });
    if (!session || session.user.id !== userId) throw new AuthFailure(401);
    const accounts = await client.query<{ id: string; accountId: string }>(
      'SELECT "id","accountId" FROM "account" WHERE "userId"=$1 AND "providerId"=$2 ORDER BY "id" LIMIT 2', [userId, "spotify"]);
    const account = accounts.rows[0];
    if (accounts.rows.length !== 1 || !account || !config.config.allowedSpotifyUserIds.includes(account.accountId)) throw new AuthFailure(403);
    const token = await auth.api.getAccessToken({ headers, body: { accountId: account.id } });
    if (!token.accessToken) throw new AuthFailure(401);
    await client.query("COMMIT");
    return token.accessToken;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error instanceof AuthFailure ? error : new Error("Account access unavailable");
  } finally { client.release(); }
}

function borrowedPool(pool: Pool, client: PoolClient): Pool {
  const borrowed = new Proxy(client, {
    get(target, key) {
      if (key === "release") return () => {};
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(pool, {
    get(target, key) {
      if (key === "connect") return async () => borrowed;
      if (key === "end") return async () => {};
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export async function disconnectSpotify(userId: string): Promise<void> {
  const client = await getDatabase().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`auth:${userId}`]);
    await client.query('UPDATE "account" SET "accessToken"=NULL,"refreshToken"=NULL,"idToken"=NULL,' +
      '"accessTokenExpiresAt"=NULL,"refreshTokenExpiresAt"=NULL,"updatedAt"=NOW() WHERE "userId"=$1 AND "providerId"=$2', [userId, "spotify"]);
    await client.query('DELETE FROM "session" WHERE "userId"=$1', [userId]);
    await client.query("DELETE FROM current_context WHERE user_id=$1", [userId]);
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK").catch(() => {});
    throw new Error("Account disconnect unavailable");
  } finally { client.release(); }
}
