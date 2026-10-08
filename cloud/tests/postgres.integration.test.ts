import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsageBudget } from "../src/usage-budget";
import { PostgresContextRepository } from "../src/context-repository";
import { PostgresEnrichmentRepository } from "../src/enrichment-repository";
import type { CloudSongContextV1 } from "../../shared/CloudSongContext";
import type { SongVisualProfile } from "../../shared/SongTraits";

// OFF by default. Never use the application's DATABASE_URL or cloud credentials.
// A deliberately created local test DB and explicit disposable flag are required.
const enabled = process.env.SYNESTHESIA_TEST_DATABASE_DISPOSABLE === "yes";
const schema = `synthetic_${randomUUID().replaceAll("-", "")}`;
let first: Pool; let second: Pool; let created = false;
const profile: SongVisualProfile = { wholeSong: { mood: "calm", energy: 0.2, tension: 0.1, softness: 0.9,
  imagery: "air", bassEffect: "ripples", midEffect: "clouds", trebleEffect: "sparks" }, sections: [] };
const context = (): CloudSongContextV1 => { const now = new Date().toISOString(); return {
  protocolVersion: 1, status: "playing", observedAtUtc: now, nextRetryUtc: null,
  trackTags: [], artistTags: [], analysis: null, capabilities: { lyrics: false, ai: false },
  track: { spotifyTrackId: "syntheticTrack", spotifyUri: null, isrc: null, title: "Synthetic",
    artists: [], album: null, durationMs: 180000, explicit: false, progressMs: 1000,
    isPlaying: true, observedAtUtc: now },
}; };
const options = { model: "synthetic-model", promptVersion: 1 };
const key = "a".repeat(64); const hash = "b".repeat(64);
async function query(connection: Pool | PoolClient, sql: string, parameters: unknown[] = []) {
  try { return await connection.query(sql, parameters); }
  catch { throw new Error("Disposable PostgreSQL verification failed"); }
}

describe.skipIf(!enabled)("real two-pool disposable PostgreSQL gates (not query doubles)", () => {
  beforeAll(async () => {
    try {
      const url = new URL(process.env.SYNESTHESIA_TEST_DATABASE_URL ?? "");
      const database = url.pathname.slice(1);
      const user = decodeURIComponent(url.username); const password = decodeURIComponent(url.password);
      if (!/^postgres(?:ql)?:$/.test(url.protocol) || url.hostname !== "127.0.0.1" || url.search || url.hash ||
        !/^synesthesia_test_[a-f0-9]{8,32}$/.test(database) || !user || !password ||
        !/^synthetic_[a-f0-9]{32}$/.test(schema)) throw new Error();
      const configuration = { host: "127.0.0.1", port: Number(url.port || 5432), database, user, password,
        max: 6, connectionTimeoutMillis: 3000, statement_timeout: 5000, lock_timeout: 3000,
        options: `-c search_path=${schema}` };
      first = new Pool(configuration); second = new Pool(configuration);
      first.on("error", () => {}); second.on("error", () => {});
      // A unique new schema owns every table touched by these tests. Creation
      // fails on collision; no existing schema or public table is reused.
      await query(first, `CREATE SCHEMA ${schema}`); created = true;
      for (const name of ["001-enrichment.sql", "002-lastfm-tags.sql"]) {
        await query(first, readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
      }
    } catch { throw new Error("An explicit disposable loopback PostgreSQL database is required"); }
  });
  beforeEach(async () => {
    await query(first, "TRUNCATE current_context,generated_analysis,usage_counter,enrichment_reservation,enrichment_lease,request_counter,lastfm_tag_cache,provider_cooldown");
  });
  afterAll(async () => {
    if (created && /^synthetic_[a-f0-9]{32}$/.test(schema)) {
      await query(first, `DROP SCHEMA ${schema} CASCADE`);
    }
    await Promise.all([first?.end(), second?.end()]);
  });

  it("20 parallel calls obey per-user=2 and shared global=3 limits across independent pools", async () => {
    const budgets = [first, second].map(pool => new UsageBudget(pool, { userDaily: 2, globalDaily: 3 }));
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      budgets[i % 2]!.tryReserve(`synthetic-user-${i % 2}`, "syntheticTrack", randomUUID())));
    expect(results.filter(result => result === "reserved")).toHaveLength(3);
    const rows = (await query(first, "SELECT scope,used FROM usage_counter")).rows;
    expect(rows.find(row => row.scope === "global")?.used).toBe(3);
    expect(rows.filter(row => row.scope !== "global").every(row => row.used <= 2)).toBe(true);
  }, 20000);

  it("the same request is charged exactly once across both pools", async () => {
    const requestId = randomUUID();
    const budgets = [first, second].map(pool => new UsageBudget(pool, { userDaily: 2, globalDaily: 3 }));
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      budgets[i % 2]!.tryReserve("synthetic-user", "syntheticTrack", requestId)));
    expect(results.filter(result => result === "reserved")).toHaveLength(1);
    expect((await query(first, "SELECT used FROM usage_counter WHERE scope='global'")).rows[0]?.used).toBe(1);
  }, 20000);

  it("a shared cache key has one provider owner and one charge", async () => {
    const budgets = [first, second].map(pool => new UsageBudget(pool, { userDaily: 20, globalDaily: 20 }));
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      budgets[i % 2]!.reserve(`synthetic-user-${i % 2}`, "syntheticTrack", randomUUID(), key)));
    expect(results.filter(result => result.status === "reserved")).toHaveLength(1);
    expect((await query(first, "SELECT used FROM usage_counter WHERE scope='global'")).rows[0]?.used).toBe(1);
  }, 20000);

  it("only one poll claims a user and deletion prevents late context resurrection", async () => {
    const repos = [first, second].map(pool => new PostgresContextRepository(pool, options));
    const owners = Array.from({ length: 20 }, () => randomUUID()); const now = new Date();
    const results = await Promise.all(owners.map((owner, i) => repos[i % 2]!.claimPoll("synthetic-user", owner, now)));
    expect(results.filter(Boolean)).toHaveLength(1);
    await query(first, "DELETE FROM current_context WHERE user_id=$1", ["synthetic-user"]);
    expect(await repos[0]!.finishPoll("synthetic-user", owners[results.indexOf(true)]!, context(), null)).toBe(false);
    expect((await query(first, "SELECT 1 FROM current_context")).rows).toHaveLength(0);
  }, 20000);

  it("an unchanged row lock held past analysis lease expiry prevents publication", async () => {
    const owner = randomUUID();
    await query(first, "INSERT INTO enrichment_lease(cache_key,owner,expires_at) VALUES($1,$2,clock_timestamp()+INTERVAL '150 milliseconds')", [key, owner]);
    const blocker = await first.connect();
    try {
      await query(blocker, "BEGIN"); await query(blocker, "SELECT 1 FROM enrichment_lease WHERE cache_key=$1 FOR UPDATE", [key]);
      const finish = new PostgresEnrichmentRepository(second, options).finish(key, owner, context().track!, hash, profile);
      await query(first, "SELECT pg_sleep(0.3)"); await query(blocker, "COMMIT");
      expect(await finish).toBe(false);
      expect((await query(first, "SELECT 1 FROM generated_analysis")).rows).toHaveLength(0);
    } finally { await query(blocker, "ROLLBACK"); blocker.release(); }
  });

  it("an unchanged row lock held past context lease expiry prevents finishing a poll", async () => {
    const owner = randomUUID();
    await query(first, "INSERT INTO current_context(user_id,poll_owner,poll_expires_at) VALUES($1,$2,clock_timestamp()+INTERVAL '150 milliseconds')", ["synthetic-user", owner]);
    const blocker = await first.connect();
    try {
      await query(blocker, "BEGIN"); await query(blocker, "SELECT 1 FROM current_context WHERE user_id=$1 FOR UPDATE", ["synthetic-user"]);
      const finish = new PostgresContextRepository(second, options).finishPoll("synthetic-user", owner, context(), null);
      await query(first, "SELECT pg_sleep(0.3)"); await query(blocker, "COMMIT");
      expect(await finish).toBe(false);
      expect((await query(first, "SELECT context FROM current_context")).rows[0]?.context).toBeNull();
    } finally { await query(blocker, "ROLLBACK"); blocker.release(); }
  });

  it("persists real tag JSON and a provider-wide cooldown across pools", async () => {
    const a = new PostgresContextRepository(first, options); const b = new PostgresContextRepository(second, options);
    const track = context().track!;
    await a.saveTags(track, { trackTags: [{ name: "ambient", weight: 1 }], artistTags: [] }, false);
    expect(await b.readTags(track)).toEqual({ trackTags: [{ name: "ambient", weight: 1 }], artistTags: [] });
    await a.deferTags(track, 90); expect(await b.lastFmCoolingDown()).toBe(true);
    // A cooldown does not destroy previously valid tags.
    expect(await b.readTags(track)).toEqual({ trackTags: [{ name: "ambient", weight: 1 }], artistTags: [] });
  });
});
