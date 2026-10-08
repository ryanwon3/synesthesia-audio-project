import type { CurrentTrack } from "../../shared/SongIdentity";
import type { SongVisualProfile } from "../../shared/SongTraits";
import { isCloudSongContext, type CloudSongContextV1 } from "../../shared/CloudSongContext";
import { AuthFailure } from "./auth";
import { startDeadline } from "./bounded-body";
import { HttpFailure } from "./http";
import { ProviderFailure } from "./provider-http";
import type { LeaseReservation } from "./usage-budget";
export interface EnrichmentRepository {
  read(cacheKey: string): Promise<unknown>;
  finish(cacheKey: string, owner: string, track: CurrentTrack, lyricsHash: string, profile: SongVisualProfile): Promise<boolean>;
}
export interface EnrichmentDependencies {
  enabled: boolean; model: string; promptVersion: number;
  requireUser(headers: Headers): Promise<{ userId: string }>;
  allowEnrichment(userId: string): Promise<boolean>;
  getSongContext(headers: Headers, signal: AbortSignal): Promise<CloudSongContextV1>;
  getLyrics(track: CurrentTrack, signal: AbortSignal): Promise<{ text: string; source: string; hash: string } | null>;
  analyze(track: CurrentTrack, lyrics: string, signal: AbortSignal): Promise<SongVisualProfile>;
  reserve(userId: string, trackId: string, requestId: string, key: string): Promise<LeaseReservation>;
  repository: EnrichmentRepository; now(): Date;
}
export interface EnrichmentService {
  requestEnrichment(headers: Headers, request: unknown, signal: AbortSignal): Promise<{ status: "ready" | "pending" | "disabled" | "limited" }>;
}
export function createEnrichmentService(deps: EnrichmentDependencies): EnrichmentService {
  return {
    async requestEnrichment(headers, request, signal) {
      if (!deps.enabled) return { status: "disabled" };
      const deadline = startDeadline(signal, 20000);
      const step = <T>(work: () => Promise<T>) => deadline.run(work);
      try {
        const input = parseEnrichmentRequest(request);
        const { userId } = await step(() => deps.requireUser(headers));
        if (typeof userId !== "string" || userId.length === 0 || userId.length > 256) throw new AuthFailure(401);
        if (!await step(() => deps.allowEnrichment(userId))) return { status: "limited" };
        const current = await step(() => deps.getSongContext(headers, deadline.signal));
        if (!isCloudSongContext(current)) throw new Error("Invalid context");
        if (current.status === "signedOut") throw new AuthFailure(401);
        if (current.status === "forbidden") throw new AuthFailure(403);
        const age = deps.now().getTime() - Date.parse(current.observedAtUtc);
        if (!current.track || current.track.spotifyTrackId !== input.trackId || !Number.isFinite(age) || age < 0 || age > 10000) {
          throw new HttpFailure(409);
        }
        // Snapshot the validated song. This job never writes current_context, so
        // a song change cannot be overwritten by a late result for the old song.
        const base = JSON.parse(JSON.stringify(current)) as CloudSongContextV1;
        const track = base.track!;
        if (base.analysis !== null) return { status: "ready" };
        const lyrics = await step(() => deps.getLyrics(track, deadline.signal));
        if (lyrics === null) throw new HttpFailure(404);
        if (!/^[a-f0-9]{64}$/.test(lyrics.hash) || typeof lyrics.text !== "string" || lyrics.text.length > 200000) {
          throw new Error("Invalid lyrics");
        }
        const key = createHash("sha256").update(JSON.stringify([track.spotifyTrackId, deps.model,
          deps.promptVersion, lyrics.hash])).digest("hex");
        const cached = await step(() => deps.repository.read(key));
        if (cached !== null && isCloudSongContext({ ...base, analysis: cached })) return { status: "ready" };
        const reservation = await step(() => deps.reserve(userId, track.spotifyTrackId, input.requestId, key));
        if (reservation.status === "limited") return { status: "limited" };
        if (reservation.status !== "reserved") return { status: "pending" };
        if (!reservation.owner) throw new Error("Invalid owner");
        const verifyUser = async () => {
          if ((await step(() => deps.requireUser(headers))).userId !== userId) throw new AuthFailure(401);
        };
        // Only a committed daily reservation with a unique cache lease reaches
        // paid generation. Failed or uncertain attempts are never refunded.
        await verifyUser();
        const generated = await step(() => deps.analyze(track, lyrics.text, deadline.signal));
        if (!isCloudSongContext({ ...base, analysis: generated })) throw new Error("Invalid analysis");
        await verifyUser();
        const saved = await step(() => deps.repository.finish(key, reservation.owner!, track, lyrics.hash,
          JSON.parse(JSON.stringify(generated)) as SongVisualProfile));
        return { status: saved ? "ready" : "pending" };
      } catch (error) {
        if (!deadline.signal.aborted && (error instanceof AuthFailure || error instanceof HttpFailure || error instanceof ProviderFailure)) throw error;
        throw new Error("Enrichment unavailable");
      } finally { deadline.dispose(); }
    },
  };
}
import { createHash } from "node:crypto";

export function parseEnrichmentRequest(value: unknown): { trackId: string; requestId: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HttpFailure(400);
  const keys = Reflect.ownKeys(value);
  const { trackId, requestId } = value as Record<string, unknown>;
  if (keys.length !== 2 || !keys.includes("trackId") || !keys.includes("requestId") ||
    typeof trackId !== "string" || !/^[A-Za-z0-9]{1,128}$/.test(trackId) || typeof requestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) throw new HttpFailure(400);
  return { trackId, requestId };
}
