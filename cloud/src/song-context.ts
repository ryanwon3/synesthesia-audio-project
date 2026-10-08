import { randomUUID } from "node:crypto";
import {
  isCloudSongContext, type CloudSongCapabilities, type CloudSongContextV1, type CloudSongStatus, type LastFmTag,
} from "../../shared/CloudSongContext";
import type { CurrentTrack } from "../../shared/SongIdentity";
import { AuthFailure } from "./auth";
import { startDeadline, type Deadline } from "./bounded-body";
import { ProviderFailure } from "./provider-http";

// Metadata-only polling orchestration over injected dependencies. No SQL, default repository, routes,
// env/config reads, provider URLs, lyrics, paid AI or personal colors live here. Every awaited
// dependency call is raced against one controlled 20s deadline that also follows caller abort, and
// continuations are await-only (nothing detached), so no new write starts after cancellation.
// LIMITATION: a dependency call already invoked (e.g. a DB write) cannot be undone by the race. The
// actual repository SQL (owner lease CAS, revocation checks) and integration gates must follow and
// are NOT provided by this module.

export type Tags = { trackTags: LastFmTag[]; artistTags: LastFmTag[] };

export interface ContextRepository {
  /** Returns stored data as unknown. Callers must validate it before use. */
  readContext(userId: string): Promise<unknown>;
  claimPoll(userId: string, owner: string, now: Date): Promise<boolean>;
  finishPoll(userId: string, owner: string, context: CloudSongContextV1, retryAt: Date | null): Promise<boolean>;
  /** Returns stored data as unknown. Callers must validate it before use. */
  readTags(track: CurrentTrack): Promise<unknown>;
  saveTags(track: CurrentTrack, tags: Tags, negative: boolean): Promise<void>;
  /** Returns stored data as unknown. Callers must validate it before use. */
  readAnalysis(track: CurrentTrack): Promise<unknown>;
}

export interface SongContextDependencies {
  requireUser(headers: Headers): Promise<{ userId: string }>;
  getSpotifyToken(headers: Headers, userId: string): Promise<string>;
  readCurrentPlayback(token: string, signal: AbortSignal): Promise<CurrentTrack | null>;
  getTags(track: CurrentTrack, signal: AbortSignal): Promise<Tags>;
  allowContext(userId: string): Promise<boolean>;
  repository: ContextRepository;
  now(): Date;
  capabilities: CloudSongCapabilities;
}

export interface SongContextService {
  getSongContext(headers: Headers, signal: AbortSignal): Promise<CloudSongContextV1>;
}

type Analysis = NonNullable<CloudSongContextV1["analysis"]>;
type Caps = CloudSongCapabilities;

const DEADLINE_MS = 20_000;
const CACHE_MAX_AGE_MS = 5_000;
const RATE_LIMIT_RETRY_MS = 60_000;
const LOST_CLAIM_RETRY_MS = 1_000;
const MAX_RETRY_SECONDS = 86_400;
const DEFAULT_RETRY_SECONDS = 60;
const MAX_USER_ID_LENGTH = 256;
const MAX_CLOCK_MS = 253_000_000_000_000; // keeps toISOString within the validator's 4-digit years

export function createSongContextService(deps: SongContextDependencies): SongContextService {
  return {
    async getSongContext(headers: Headers, signal: AbortSignal): Promise<CloudSongContextV1> {
      const caps = capabilitiesOf(deps.capabilities);
      const deadline = startDeadline(signal, DEADLINE_MS);
      try {
        const result = await orchestrate(deps, headers, deadline, caps);
        // A result that only lands after abort/timeout is dropped, never returned.
        return deadline.signal.aborted || !isCloudSongContext(result) ? unavailable(deps, caps) : result;
      } catch {
        // Redacted: no error message, cause, token or provider detail reaches the DTO.
        return unavailable(deps, caps);
      } finally {
        deadline.dispose();
      }
    },
  };
}

async function orchestrate(deps: SongContextDependencies, headers: Headers, deadline: Deadline,
  caps: Caps): Promise<CloudSongContextV1> {
  const step = <T>(work: () => Promise<T>): Promise<T> => deadline.run(work);
  const aborted = (): boolean => deadline.signal.aborted;
  const clear = (status: CloudSongStatus, retryMs: number | null = null): CloudSongContextV1 =>
    cleared(status, clockMs(deps), retryMs, caps);
  const repo = deps.repository;

  // Identity comes only from requireUser; headers are never parsed for a user id.
  let userId: string;
  try { userId = validUserId(await step(() => deps.requireUser(headers))); }
  catch (error) { if (aborted()) throw error; return clear(authStatus(error)); }

  // Durable rate limit: first check after auth, before cache, claim or provider work.
  if ((await step(() => deps.allowContext(userId))) !== true) return clear("rateLimited", RATE_LIMIT_RETRY_MS);

  let stored: unknown = null;
  try { stored = await step(() => repo.readContext(userId)); }
  catch (error) { if (aborted()) throw error; }
  const cached = cachedContext(stored, clockMs(deps), caps);
  if (cached) return cached;

  const owner = randomUUID();
  if ((await step(() => repo.claimPoll(userId, owner, new Date(clockMs(deps))))) !== true) {
    return clear("unavailable", LOST_CLAIM_RETRY_MS);
  }

  // Revalidate the same user, then CAS-finish with the exact owner and the context's own retryAt.
  const finish = async (context: CloudSongContextV1): Promise<CloudSongContextV1> => {
    let again: string;
    try { again = validUserId(await step(() => deps.requireUser(headers))); }
    catch (error) { if (aborted()) throw error; return clear(authStatus(error)); }
    if (again !== userId) return clear("signedOut");
    const retryAt = context.nextRetryUtc === null ? null : new Date(context.nextRetryUtc);
    if ((await step(() => repo.finishPoll(userId, owner, json(context), retryAt))) !== true) return clear("unavailable");
    return json(context);
  };
  const fail = async (error: unknown): Promise<CloudSongContextV1> => {
    if (aborted()) throw error;
    const { status, retryMs } = providerStatus(error);
    return finish(clear(status, retryMs));
  };

  let token: string;
  try { token = await step(() => deps.getSpotifyToken(headers, userId)); }
  catch (error) { return fail(error); }
  if (typeof token !== "string" || token.length === 0) return finish(clear("unavailable"));

  let playback: CurrentTrack | null;
  try { playback = await step(() => deps.readCurrentPlayback(token, deadline.signal)); }
  catch (error) { return fail(error); }
  if (playback === null) return finish(clear("none"));
  const base = trackContext(playback, clockMs(deps), caps);
  const current = base?.track;
  if (!base || !current) return finish(clear("unavailable"));
  const trackArg = (): CurrentTrack => json(current);

  // Optional metadata: failures keep the valid track unless the deadline/abort fired.
  let tags: Tags | null = null;
  try { tags = validTags(await step(() => repo.readTags(trackArg())), base); }
  catch (error) { if (aborted()) throw error; }
  if (!tags) {
    let fetched: Tags | null = null;
    try { fetched = validTags(await step(() => deps.getTags(trackArg(), deadline.signal)), base); }
    catch (error) { if (aborted()) throw error; }
    if (fetched) {
      tags = fetched;
      const save = json(fetched);
      const negative = save.trackTags.length === 0 && save.artistTags.length === 0;
      // Awaited and deadline-raced, never a detached background write; failure keeps the track.
      try { await step(() => repo.saveTags(trackArg(), save, negative)); }
      catch (error) { if (aborted()) throw error; }
    }
  }

  let analysis: Analysis | null = null;
  try { analysis = validAnalysis(await step(() => repo.readAnalysis(trackArg())), base); }
  catch (error) { if (aborted()) throw error; }

  const full: unknown = { ...base, trackTags: tags?.trackTags ?? [], artistTags: tags?.artistTags ?? [], analysis };
  return finish(isCloudSongContext(full) ? full : base);
}

function cleared(status: CloudSongStatus, nowMs: number, retryMs: number | null, caps: Caps): CloudSongContextV1 {
  return {
    protocolVersion: 1, status, observedAtUtc: new Date(nowMs).toISOString(),
    nextRetryUtc: retryMs === null ? null : new Date(nowMs + retryMs).toISOString(),
    track: null, trackTags: [], artistTags: [], analysis: null, capabilities: { ...caps },
  };
}

function unavailable(deps: SongContextDependencies, caps: Caps): CloudSongContextV1 {
  return cleared("unavailable", clockMs(deps), null, caps);
}

function clockMs(deps: SongContextDependencies): number {
  try {
    const value: unknown = deps.now();
    if (value instanceof Date) {
      const ms = value.getTime();
      if (Number.isFinite(ms) && ms >= 0 && ms <= MAX_CLOCK_MS) return ms;
    }
  } catch { /* fall back to the platform clock */ }
  return Date.now();
}

// Always the current injected flags, reduced to two strict booleans.
function capabilitiesOf(source: unknown): Caps {
  return { lyrics: flag(source, "lyrics"), ai: flag(source, "ai") };
}

function flag(source: unknown, key: "lyrics" | "ai"): boolean {
  try { return typeof source === "object" && source !== null && (source as Record<string, unknown>)[key] === true; }
  catch { return false; }
}

function validUserId(session: unknown): string {
  const id = typeof session === "object" && session !== null ? (session as { userId?: unknown }).userId : undefined;
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_USER_ID_LENGTH) throw new Error("Invalid session");
  for (let i = 0; i < id.length; i += 1) {
    const code = id.charCodeAt(i);
    if (code < 32 || (code >= 127 && code <= 159)) throw new Error("Invalid session");
  }
  return id;
}

function authStatus(error: unknown): CloudSongStatus {
  if (!(error instanceof AuthFailure)) return "unavailable";
  return error.status === 401 ? "signedOut" : error.status === 403 ? "forbidden" : "unavailable";
}

function providerStatus(error: unknown): { status: CloudSongStatus; retryMs: number | null } {
  const code = error instanceof AuthFailure || error instanceof ProviderFailure ? error.status : 0;
  if (code === 401) return { status: "signedOut", retryMs: null };
  if (code === 403) return { status: "forbidden", retryMs: null };
  if (code === 429 && error instanceof ProviderFailure) {
    return { status: "rateLimited", retryMs: retrySeconds(error.retrySeconds) * 1000 };
  }
  return { status: "unavailable", retryMs: null };
}

function retrySeconds(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(MAX_RETRY_SECONDS, Math.max(1, Math.ceil(value))) : DEFAULT_RETRY_SECONDS;
}

function json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// Shared validator, cloned JSON, current capabilities; the stored stamp is never refreshed.
function cachedContext(stored: unknown, nowMs: number, caps: Caps): CloudSongContextV1 | null {
  if (!isCloudSongContext(stored)) return null;
  const age = nowMs - Date.parse(stored.observedAtUtc);
  if (!Number.isFinite(age) || age < 0) return null;
  let usable = age <= CACHE_MAX_AGE_MS;
  if (!usable && (stored.status === "rateLimited" || stored.status === "unavailable") && stored.nextRetryUtc !== null) {
    const wait = Date.parse(stored.nextRetryUtc) - nowMs;
    usable = Number.isFinite(wait) && wait > 0 && wait <= MAX_RETRY_SECONDS * 1000;
  }
  if (!usable) return null;
  const copy: unknown = { ...json(stored), capabilities: { ...caps } };
  return isCloudSongContext(copy) ? copy : null;
}

// Validates the complete provider track through the shared DTO; malformed input is never repaired.
function trackContext(playback: unknown, nowMs: number, caps: Caps): CloudSongContextV1 | null {
  if (typeof playback !== "object" || playback === null) return null;
  const playing = (playback as { isPlaying?: unknown }).isPlaying === true;
  const candidate: unknown = {
    protocolVersion: 1, status: playing ? "playing" : "paused", observedAtUtc: new Date(nowMs).toISOString(),
    nextRetryUtc: null, track: playback, trackTags: [], artistTags: [], analysis: null, capabilities: { ...caps },
  };
  if (!isCloudSongContext(candidate)) return null;
  const copy: unknown = { ...candidate, track: json(candidate.track) };
  return isCloudSongContext(copy) ? copy : null;
}

// Exactly two own keys; every nested tag checked by the shared validator via the track envelope.
function validTags(value: unknown, base: CloudSongContextV1): Tags | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes("trackTags") || !keys.includes("artistTags")) return null;
  const { trackTags, artistTags } = value as Record<string, unknown>;
  if (!isCloudSongContext({ ...base, trackTags, artistTags })) return null;
  const copy: unknown = { ...base, ...json({ trackTags, artistTags }) };
  return isCloudSongContext(copy) ? { trackTags: copy.trackTags, artistTags: copy.artistTags } : null;
}

// Unknown repository data, validated against this track's duration via the complete DTO.
function validAnalysis(value: unknown, base: CloudSongContextV1): Analysis | null {
  if (value === null || value === undefined) return null;
  if (!isCloudSongContext({ ...base, analysis: value })) return null;
  const copy: unknown = { ...base, analysis: json(value) };
  return isCloudSongContext(copy) ? copy.analysis : null;
}
