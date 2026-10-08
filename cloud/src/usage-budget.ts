import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export type Reservation = "reserved" | "duplicate" | "limited";
export type LeaseReservation = { status: Reservation | "pending" | "cached"; owner: string | null };
export class UsageBudget {
  constructor(private readonly database: Pool, private readonly limits: { userDaily: number; globalDaily: number },
    private readonly now: () => Date = () => new Date()) {
    if (!Number.isInteger(limits.userDaily) || limits.userDaily < 1 || limits.userDaily > 1000 ||
      !Number.isInteger(limits.globalDaily) || limits.globalDaily < 1 || limits.globalDaily > 10000) throw new Error("Invalid usage limits");
  }
  async tryReserve(userId: string, trackId: string, requestId: string): Promise<Reservation> {
    const result = await this.reserve(userId, trackId, requestId, null);
    return result.status as Reservation;
  }
  async reserve(userId: string, trackId: string, requestId: string, cacheKey: string | null): Promise<LeaseReservation> {
    if (!userId || userId.length > 256 || !/^[A-Za-z0-9]{1,128}$/.test(trackId) || !requestId || requestId.length > 128 ||
      (cacheKey !== null && !/^[a-f0-9]{64}$/.test(cacheKey))) throw new Error("Invalid reservation");
    const day = this.now().toISOString().slice(0, 10);
    const userScope = `user:${userId}`;
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      // All transactions acquire global then user rows in the same order.
      for (const scope of ["global", userScope]) {
        await client.query("INSERT INTO usage_counter(day,scope) VALUES($1,$2) ON CONFLICT DO NOTHING", [day, scope]);
      }
      const global = await client.query<{ used: number }>("SELECT used FROM usage_counter WHERE day=$1 AND scope=$2 FOR UPDATE", [day, "global"]);
      const user = await client.query<{ used: number }>("SELECT used FROM usage_counter WHERE day=$1 AND scope=$2 FOR UPDATE", [day, userScope]);
      const prior = await client.query<{ track_id: string; cache_key: string | null }>("SELECT track_id,cache_key FROM enrichment_reservation WHERE user_id=$1 AND request_id=$2", [userId, requestId]);
      let outcome: LeaseReservation = { status: "limited", owner: null };
      if (prior.rows.length) {
        if (prior.rows[0]?.track_id !== trackId || prior.rows[0]?.cache_key !== cacheKey) throw new Error("Reservation identity changed");
        outcome.status = "duplicate";
      } else {
        let available = true;
        if (cacheKey !== null) {
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`analysis:${cacheKey}`]);
          const cached = await client.query("SELECT 1 FROM generated_analysis WHERE cache_key=$1", [cacheKey]);
          const lease = await client.query("SELECT 1 FROM enrichment_lease WHERE cache_key=$1 AND expires_at>NOW()", [cacheKey]);
          if (cached.rows.length) { outcome.status = "cached"; available = false; }
          else if (lease.rows.length) { outcome.status = "pending"; available = false; }
        }
        if (available && (global.rows[0]?.used ?? this.limits.globalDaily) < this.limits.globalDaily &&
          (user.rows[0]?.used ?? this.limits.userDaily) < this.limits.userDaily) {
          const owner = cacheKey === null ? null : randomUUID();
          await client.query("INSERT INTO enrichment_reservation(user_id,request_id,track_id,cache_key,day) VALUES($1,$2,$3,$4,$5)", [userId, requestId, trackId, cacheKey, day]);
          await client.query("UPDATE usage_counter SET used=used+1 WHERE day=$1 AND scope IN ($2,$3)", [day, "global", userScope]);
          if (cacheKey !== null) await client.query("INSERT INTO enrichment_lease(cache_key,owner,expires_at) VALUES($1,$2,NOW()+INTERVAL '30 seconds') ON CONFLICT(cache_key) DO UPDATE SET owner=EXCLUDED.owner,expires_at=EXCLUDED.expires_at", [cacheKey, owner]);
          outcome = { status: "reserved", owner };
        }
      }
      await client.query("COMMIT");
      return outcome;
    } catch {
      await client.query("ROLLBACK").catch(() => {});
      throw new Error("Usage reservation unavailable");
    } finally { client.release(); }
  }
}

// One atomic upsert: separate function instances cannot each spend a fresh allowance.
export async function allowRequest(database: Pool, userId: string, category: "context" | "enrichment", limit: number): Promise<boolean> {
  const minute = Math.floor(Date.now() / 60000);
  const result = await database.query("INSERT INTO request_counter(user_id,category,minute,used) VALUES($1,$2,$3,1) " +
    "ON CONFLICT(user_id,category,minute) DO UPDATE SET used=request_counter.used+1 WHERE request_counter.used<$4 RETURNING used", [userId, category, minute, limit]);
  return result.rows.length === 1;
}
