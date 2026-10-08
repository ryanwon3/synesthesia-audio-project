import { Client, Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CONFIG_NAMES: readonly string[] = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "SPOTIFY_CLIENT_ID",
  "SPOTIFY_CLIENT_SECRET",
  "SPOTIFY_ALLOWED_USER_IDS",
  "AI_ENRICHMENT_ENABLED",
  "OPENAI_MODEL",
  "OPENAI_API_KEY",
];
const RUNTIME_KEYS = ["PATH", "Path", "SystemRoot", "TEMP", "TMP", "NODE_ENV"];

const FAKE_PASSWORD = "fake-db-password";
const HOSTILE_QUERY =
  "sslkey=/nonexistent/fake.key&sslcert=/nonexistent/fake.crt&sslrootcert=/nonexistent/fake-ca.crt" +
  "&ssl=0&sslmode=no-verify&host=spoofed.example.invalid";
const VALID_ENV: Record<string, string> = {
  DATABASE_URL: `postgres://fake_user:${FAKE_PASSWORD}@db.example.invalid:6543/fake_db?${HOSTILE_QUERY}`,
  BETTER_AUTH_SECRET: "fake-auth-secret-0123456789abcdef0123456789abcdef",
  BETTER_AUTH_URL: "https://synesthesia.example.invalid",
  SPOTIFY_CLIENT_ID: "fake-spotify-client-id",
  SPOTIFY_CLIENT_SECRET: "fake-spotify-client-secret",
  SPOTIFY_ALLOWED_USER_IDS: "fake-user-a,fake-user-b",
};

type ConnectionParameters = {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: Record<string, unknown> | boolean | undefined;
  query_timeout: unknown;
  statement_timeout: unknown;
  lock_timeout: unknown;
  idle_in_transaction_session_timeout: unknown;
};

const originalEnv = process.env;
const ownedPools: Pool[] = [];

function installEnv(vars: Record<string, string>): string[] {
  const reads: string[] = [];
  const target: Record<string, string | undefined> = {};
  for (const key of Object.keys(originalEnv)) {
    if (RUNTIME_KEYS.includes(key) || key.startsWith("VITEST")) target[key] = originalEnv[key];
  }
  Object.assign(target, vars);
  const observe = (key: string | symbol) => {
    if (typeof key === "string" && CONFIG_NAMES.includes(key)) reads.push(key);
  };
  process.env = new Proxy(target, {
    get(t, key, receiver) {
      observe(key);
      return Reflect.get(t, key, receiver);
    },
    has(t, key) {
      observe(key);
      return Reflect.has(t, key);
    },
    getOwnPropertyDescriptor(t, key) {
      observe(key);
      return Reflect.getOwnPropertyDescriptor(t, key);
    },
  }) as NodeJS.ProcessEnv;
  return reads;
}

function spyOnNetwork() {
  return [
    vi.spyOn(Pool.prototype, "connect"),
    vi.spyOn(Pool.prototype, "query"),
    vi.spyOn(Client.prototype, "connect"),
    vi.spyOn(Client.prototype, "query"),
  ];
}

describe("getDatabase", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    process.env = originalEnv;
    vi.restoreAllMocks();
    await Promise.all(ownedPools.splice(0).map((pool) => pool.end()));
  });

  it("reads no configuration when the module is imported", async () => {
    const reads = installEnv(VALID_ENV);
    const db = await import("../src/db");

    expect(typeof db.getDatabase).toBe("function");
    expect(reads).toEqual([]);
  });

  it("lazily builds one forced-TLS pool that ignores connection string overrides", async () => {
    const reads = installEnv(VALID_ENV);
    const networkSpies = spyOnNetwork();
    const { getDatabase } = await import("../src/db");

    const pool = getDatabase();
    ownedPools.push(pool);

    expect(reads).toContain("DATABASE_URL");
    expect(pool).toBeInstanceOf(Pool);
    expect(getDatabase()).toBe(pool);
    expect([pool.totalCount, pool.idleCount, pool.waitingCount]).toEqual([0, 0, 0]);

    const options = pool.options as unknown as Record<string, unknown>;
    expect(options.max).toBe(3);
    expect(options.connectionTimeoutMillis).toBe(5000);
    expect(options.enableChannelBinding).toBe(true);
    expect(options.connectionString).toBeUndefined();
    expect([options.query_timeout, options.statement_timeout, options.lock_timeout,
      options.idle_in_transaction_session_timeout]).toEqual([5000, 5000, 2000, 5000]);

    const client = new Client(pool.options);
    const params = (client as unknown as { connectionParameters: ConnectionParameters })
      .connectionParameters;
    expect(params.host).toBe("db.example.invalid");
    expect(params.port).toBe(6543);
    expect(params.database).toBe("fake_db");
    expect(params.user).toBe("fake_user");
    expect(params.password).toBe(FAKE_PASSWORD);
    expect(typeof params.ssl).toBe("object");
    const ssl = params.ssl as Record<string, unknown>;
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.key).toBeUndefined();
    expect(ssl.cert).toBeUndefined();
    expect(ssl.ca).toBeUndefined();
    // Real pg parsing: client-side query deadline plus server timeouts sent in the startup packet.
    expect([params.query_timeout, params.statement_timeout, params.lock_timeout,
      params.idle_in_transaction_session_timeout]).toEqual([5000, 5000, 2000, 5000]);
    const startup = (client as unknown as { getStartupConf(): Record<string, string> }).getStartupConf();
    expect(startup).toMatchObject({ statement_timeout: "5000", lock_timeout: "2000",
      idle_in_transaction_session_timeout: "5000" });

    const consoleSpies = (["error", "warn", "log", "info", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    expect(pool.listenerCount("error")).toBeGreaterThan(0);
    expect(() =>
      pool.emit(
        "error",
        new Error(`idle client lost: postgres://fake_user:${FAKE_PASSWORD}@db.example.invalid`),
      ),
    ).not.toThrow();
    const logged = consoleSpies.flatMap((spy) => spy.mock.calls.flat().map(String)).join("\n");
    expect(logged).not.toContain(FAKE_PASSWORD);
    expect(logged).not.toContain("db.example.invalid");

    expect([pool.totalCount, pool.idleCount, pool.waitingCount]).toEqual([0, 0, 0]);
    for (const spy of networkSpies) expect(spy).not.toHaveBeenCalled();
  });

  it("throws a generic error without touching the network when configuration is missing", async () => {
    const { DATABASE_URL: _omitted, ...withoutDatabase } = VALID_ENV;
    installEnv(withoutDatabase);
    const networkSpies = spyOnNetwork();
    const { getDatabase } = await import("../src/db");

    let caught: unknown;
    try {
      ownedPools.push(getDatabase());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const error = caught as Error;
    expect(error.message).toBe("Cloud configuration unavailable");
    expect(error.cause).toBeUndefined();
    const rendered = `${String(error.stack)}\n${JSON.stringify(error)}`;
    for (const value of Object.values(withoutDatabase)) expect(rendered).not.toContain(value);
    for (const spy of networkSpies) expect(spy).not.toHaveBeenCalled();
  });
});
