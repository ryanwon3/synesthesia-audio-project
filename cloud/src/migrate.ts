import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getMigrations } from "better-auth/db/migration";
import { authOptions } from "./auth";
import { readCloudConfig } from "./config";
import { getDatabase } from "./db";

// Never imported by the build or an API. Explicit preview-only owner operation.
async function main(): Promise<void> {
  if (process.argv.slice(2).join(" ") !== "--apply-preview" || process.env.SYNESTHESIA_MIGRATION_TARGET !== "preview") {
    throw new Error("Preview migration requires explicit target and --apply-preview approval");
  }
  const result = readCloudConfig(process.env);
  if (!result.ok) throw new Error("Cloud configuration unavailable");
  const pool = getDatabase();
  const authPlan = await getMigrations(authOptions(result.config, pool));
  // The generated plan must be reviewed in a disposable database before owner use.
  if (authPlan.unsafeChanges.length || authPlan.schemaProblems.length) throw new Error("Auth schema requires owner review");
  await authPlan.runMigrations();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(73920816)");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, checksum char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT NOW())");
    const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
    const files = (await readdir(directory)).filter(name => /^\d{3}-[a-z-]+\.sql$/.test(name)).sort();
    for (const name of files) {
      const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query<{ checksum: string }>("SELECT checksum FROM schema_migration WHERE name=$1", [name]);
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum) throw new Error("Applied migration changed; use a new version");
        continue;
      }
      await client.query(sql);
      await client.query("INSERT INTO schema_migration(name,checksum) VALUES($1,$2)", [name, checksum]);
    }
    await client.query("COMMIT");
  } catch {
    await client.query("ROLLBACK").catch(() => {});
    throw new Error("Preview migration failed");
  } finally { client.release(); await pool.end(); }
}
void main().catch(() => { console.error("Preview migration unavailable; check configuration and reviewed schema privately."); process.exitCode = 1; });
