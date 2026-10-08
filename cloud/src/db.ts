import { isIP } from "node:net";
import { Pool, type PoolConfig } from "pg";
import { readCloudConfig } from "./config";

// Lazy by design: importing this module reads no env and opens no connections.
// The pool is built from explicitly parsed URL fields, never `connectionString`, so query
// parameters (sslmode, ssl, sslkey/sslcert/sslrootcert files, host overrides) are ignored
// and TLS verification plus channel binding cannot be weakened from the environment.

type ChannelBoundPoolConfig = PoolConfig & { enableChannelBinding: boolean };

const UNAVAILABLE = "Cloud configuration unavailable";
const DEFAULT_PORT = 5432;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const DNS_LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const DNS_HOST = new RegExp(`^(?=.{1,253}$)${DNS_LABEL}(?:\\.${DNS_LABEL})*$`);

let pool: Pool | undefined;

// Postgres URLs are non-special, so hostname stays percent-encoded and is never decoded:
// '%', '/', controls, and empty hosts fail here instead of becoming a Unix socket path.
function parseHost(hostname: string): string | undefined {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    const inner = hostname.slice(1, -1);
    return isIP(inner) === 6 ? inner : undefined;
  }
  return DNS_HOST.test(hostname) ? hostname : undefined;
}

// Empty values are rejected so pg never falls back to PG* env vars or a pgpass file.
function decodeField(raw: string): string | undefined {
  const value = decodeURIComponent(raw);
  return value !== "" && !CONTROL_CHARS.test(value) ? value : undefined;
}

function buildPoolConfig(databaseUrl: string): ChannelBoundPoolConfig | undefined {
  const url = new URL(databaseUrl);
  const host = parseHost(url.hostname);
  const port = url.port === "" ? DEFAULT_PORT : Number(url.port);
  const database = decodeField(url.pathname.slice(1));
  const user = decodeField(url.username);
  const password = decodeField(url.password);
  if (!host || !database || !user || !password) return undefined;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return {
    host,
    port,
    database,
    user,
    password,
    max: 3,
    connectionTimeoutMillis: 5000,
    // Bounds each DB attempt: client-side query deadline plus server-side startup-packet timeouts.
    query_timeout: 5000,
    statement_timeout: 5000,
    lock_timeout: 2000,
    idle_in_transaction_session_timeout: 5000,
    ssl: { rejectUnauthorized: true },
    enableChannelBinding: true,
  };
}

// Any failure (config, URL, decode, constructor) collapses to undefined so no raw error,
// cause, or connection detail can escape.
function createPool(): Pool | undefined {
  try {
    const result = readCloudConfig(process.env);
    const config = result.ok ? buildPoolConfig(result.config.databaseUrl) : undefined;
    if (!config) return undefined;
    const created = new Pool(config);
    // Idle-client errors can embed host or credentials, so only a fixed message is logged.
    created.on("error", () => {
      console.error("Database pool: idle client error");
    });
    return created;
  } catch {
    return undefined;
  }
}

export function getDatabase(): Pool {
  if (pool) return pool;
  const created = createPool();
  if (!created) throw new Error(UNAVAILABLE);
  pool = created;
  return pool;
}
