import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { CurrentTrack } from "../../shared/SongIdentity";
import { isCloudSongContext, type CloudSongContextV1 } from "../../shared/CloudSongContext";
import type { ContextRepository, Tags } from "./song-context";

const POSITIVE_TAG_SECONDS = 7 * 86400;
const NEGATIVE_TAG_SECONDS = 30 * 86400;

// Queries are parameterized and bounded by the pool's statement timeout. Reads
// remain unknown until the orchestration layer validates the complete DTO.
export class PostgresContextRepository implements ContextRepository {
  constructor(private readonly database: Pool,
    private readonly options: { model: string; promptVersion: number }) {}

  async readContext(userId: string): Promise<unknown> {
    return (await this.query("SELECT context FROM current_context WHERE user_id=$1", [userId])).rows[0]?.context ?? null;
  }
  async claimPoll(userId: string, owner: string, now: Date): Promise<boolean> {
    const result = await this.query(`INSERT INTO current_context(user_id,poll_owner,poll_expires_at)
      VALUES($1,$2,$3::timestamptz+INTERVAL '25 seconds')
      ON CONFLICT(user_id) DO UPDATE SET poll_owner=EXCLUDED.poll_owner,poll_expires_at=EXCLUDED.poll_expires_at
      WHERE (current_context.poll_owner IS NULL OR current_context.poll_expires_at<=$3)
        AND current_context.updated_at<$3::timestamptz-INTERVAL '5 seconds'
        AND (current_context.retry_at IS NULL OR current_context.retry_at<=$3)
      RETURNING poll_owner`, [userId, owner, now]);
    return result.rows[0]?.poll_owner === owner;
  }
  async finishPoll(userId: string, owner: string, context: CloudSongContextV1, retryAt: Date | null): Promise<boolean> {
    if (!isCloudSongContext(context) || (retryAt !== null && !Number.isFinite(retryAt.getTime())) ||
      (retryAt?.toISOString() ?? null) !== context.nextRetryUtc) return false;
    // UPDATE only: disconnect deletes the row, so a late completion cannot
    // recreate it. Expired/replaced owners cannot publish another poll's result.
    const result = await this.query(`WITH owned AS MATERIALIZED (
      SELECT user_id FROM current_context WHERE user_id=$1 AND poll_owner=$2 FOR UPDATE
    ) UPDATE current_context AS context_row
      SET context=$3::jsonb,updated_at=$4,retry_at=$5,poll_owner=NULL,poll_expires_at=NULL
      FROM owned WHERE context_row.user_id=owned.user_id AND context_row.poll_owner=$2
        AND context_row.poll_expires_at>clock_timestamp() RETURNING context_row.user_id`,
    [userId, owner, JSON.stringify(context), new Date(context.observedAtUtc), retryAt]);
    return result.rows[0]?.user_id === userId;
  }
  async readTags(track: CurrentTrack): Promise<unknown> {
    return (await this.query("SELECT tags FROM lastfm_tag_cache WHERE cache_key=$1 AND expires_at>NOW()",
      [tagKey(track)])).rows[0]?.tags ?? null;
  }
  async saveTags(track: CurrentTrack, tags: Tags, negative: boolean): Promise<void> {
    const keys = Reflect.ownKeys(tags);
    const envelope = { protocolVersion: 1, status: track.isPlaying ? "playing" : "paused",
      observedAtUtc: track.observedAtUtc, nextRetryUtc: null, track,
      trackTags: tags.trackTags, artistTags: tags.artistTags, analysis: null, capabilities: { lyrics: false, ai: false } };
    if (keys.length !== 2 || !keys.includes("trackTags") || !keys.includes("artistTags") ||
      !isCloudSongContext(envelope) || negative !== (tags.trackTags.length === 0 && tags.artistTags.length === 0)) {
      throw new Error("Context cache unavailable");
    }
    await this.query(`INSERT INTO lastfm_tag_cache(cache_key,tags,expires_at)
      VALUES($1,$2::jsonb,NOW()+$3*INTERVAL '1 second')
      ON CONFLICT(cache_key) DO UPDATE SET tags=EXCLUDED.tags,expires_at=EXCLUDED.expires_at`,
    [tagKey(track), JSON.stringify(tags), negative ? NEGATIVE_TAG_SECONDS : POSITIVE_TAG_SECONDS]);
  }
  async deferTags(track: CurrentTrack, retrySeconds: number): Promise<void> {
    const seconds = Number.isFinite(retrySeconds) ? Math.min(86400, Math.max(1, Math.ceil(retrySeconds))) : 60;
    // An outage is NOT a durable provider no-match. An empty bounded record
    // suppresses repeated lookups only until this provider cooldown expires.
    await this.query(`WITH cooldown AS (
      INSERT INTO provider_cooldown(provider,retry_at) VALUES('lastfm',clock_timestamp()+$3*INTERVAL '1 second')
      ON CONFLICT(provider) DO UPDATE SET retry_at=GREATEST(provider_cooldown.retry_at,EXCLUDED.retry_at) RETURNING provider
    ) INSERT INTO lastfm_tag_cache(cache_key,tags,expires_at)
      SELECT $1,$2::jsonb,clock_timestamp()+$3*INTERVAL '1 second' FROM cooldown
      ON CONFLICT(cache_key) DO UPDATE SET expires_at=EXCLUDED.expires_at`,
    [tagKey(track), JSON.stringify({ trackTags: [], artistTags: [] }), seconds]);
  }
  async lastFmCoolingDown(): Promise<boolean> {
    return (await this.query("SELECT provider FROM provider_cooldown WHERE provider='lastfm' AND retry_at>clock_timestamp()", [])).rows.length > 0;
  }
  async readAnalysis(track: CurrentTrack): Promise<unknown> {
    return (await this.query(`SELECT profile FROM generated_analysis
      WHERE track_id=$1 AND model=$2 AND prompt_version=$3 ORDER BY created_at DESC LIMIT 1`,
    [track.spotifyTrackId, this.options.model, this.options.promptVersion])).rows[0]?.profile ?? null;
  }

  private async query(sql: string, parameters: unknown[]) {
    try { return await this.database.query(sql, parameters); }
    catch { throw new Error("Context cache unavailable"); }
  }
}

function tagKey(track: CurrentTrack): string {
  // Never include progress, playback state, observation time or provider tokens.
  return createHash("sha256").update(JSON.stringify(["lastfm-v1", track.spotifyTrackId, track.isrc,
    track.title, track.artists.map(artist => [artist.spotifyArtistId, artist.name]), track.durationMs])).digest("hex");
}
