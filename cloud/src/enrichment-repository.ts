import type { Pool } from "pg";
import type { CurrentTrack } from "../../shared/SongIdentity";
import type { SongVisualProfile } from "../../shared/SongTraits";
import { isCloudSongContext } from "../../shared/CloudSongContext";
import type { EnrichmentRepository } from "./enrichment";
export class PostgresEnrichmentRepository implements EnrichmentRepository {
  constructor(private readonly database: Pool, private readonly options: { model: string; promptVersion: number }) {}
  async read(key: string): Promise<unknown> {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Analysis cache unavailable");
    return (await this.query("SELECT profile FROM generated_analysis WHERE cache_key=$1", [key])).rows[0]?.profile ?? null;
  }
  async finish(key: string, owner: string, track: CurrentTrack, hash: string, profile: SongVisualProfile): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(key) || !/^[a-f0-9]{64}$/.test(hash) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(owner) ||
      !isCloudSongContext({ protocolVersion: 1, status: track.isPlaying ? "playing" : "paused",
        observedAtUtc: track.observedAtUtc, nextRetryUtc: null, track, analysis: profile,
        trackTags: [], artistTags: [], capabilities: { lyrics: false, ai: false } })) return false;
    // Row lock serializes lease replacement with publication. No current_context
    // write occurs here, and late/replaced owners cannot insert or overwrite.
    const result = await this.query(`WITH owned AS MATERIALIZED (
      SELECT cache_key,expires_at FROM enrichment_lease WHERE cache_key=$1 AND owner=$2 FOR UPDATE
    ) INSERT INTO generated_analysis(cache_key,track_id,model,prompt_version,lyrics_hash,profile)
      SELECT cache_key,$3,$4,$5,$6,$7::jsonb FROM owned WHERE expires_at>clock_timestamp()
      ON CONFLICT(cache_key) DO NOTHING RETURNING cache_key`,
    [key, owner, track.spotifyTrackId, this.options.model, this.options.promptVersion, hash, JSON.stringify(profile)]);
    return result.rows[0]?.cache_key === key;
  }
  private async query(sql: string, parameters: unknown[]) {
    try { return await this.database.query(sql, parameters); }
    catch { throw new Error("Analysis cache unavailable"); }
  }
}
