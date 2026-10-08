import { isCloudSongContext, type CloudSongContextV1 } from "../../../shared/CloudSongContext";
import { toLocalSongContext } from "./CloudContextAdapter";
import type { SongContextSnapshot } from "./SongContext";

export type HostedSongContextStatus = "connecting" | "connected" | "disconnected";
export type HostedSnapshotListener = (snapshot: SongContextSnapshot) => void;
export type HostedStatusListener = (status: HostedSongContextStatus) => void;

// Fixed same-origin relative endpoints; no configurable origin, query or auth header.
const contextUrl = "/api/song-context";
const enrichmentUrl = "/api/enrichment";
const pollMs = 5_000;
// Longer than the server's controlled 20s metadata pipeline, still bounded.
const timeoutMs = 25_000;
const enrichmentTimeoutMs = 30_000;
const maxBackoffMs = 60_000;
const maxBodyBytes = 262_144;
const maxPostBody = 1024;
const trackIdPattern = /^[A-Za-z0-9]{1,128}$/;
const baseInit = { credentials: "same-origin", cache: "no-store", redirect: "error" } as const;

type Outcome =
  | { kind: "ok"; snapshot: SongContextSnapshot; trackId: string | null }
  | { kind: "auth"; snapshot: SongContextSnapshot }
  | { kind: "fail"; retryAfterMs: number };

const fail = (retryAfterMs = 0): Outcome => ({ kind: "fail", retryAfterMs });
const redacted = (): Error => new Error("Hosted analysis request failed");

// Races a promise against the signal so a mock or body read that ignores abort cannot outlive it.
function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      promise.catch(() => {});
      reject(new Error("Hosted request aborted"));
      return;
    }
    const onAbort = (): void => reject(new Error("Hosted request aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      () => { signal.removeEventListener("abort", onAbort); reject(new Error("Hosted request failed")); },
    );
  });
}

// Numeric seconds or HTTP date; finite values clamped to 1..86400 seconds.
function retryAfterMs(header: string | null): number {
  if (!header) return 0;
  const text = header.trim();
  const seconds = /^[0-9]+$/.test(text) ? Number(text) : (Date.parse(text) - Date.now()) / 1000;
  if (!Number.isFinite(seconds)) return 0;
  return Math.min(86_400, Math.max(1, Math.ceil(seconds))) * 1000;
}

// Secret-free stale context with all account track/tags/analysis cleared.
function authSnapshot(code: 401 | 403): SongContextSnapshot {
  const dto: CloudSongContextV1 = {
    protocolVersion: 1, status: code === 401 ? "signedOut" : "forbidden", observedAtUtc: new Date().toISOString(),
    nextRetryUtc: null, track: null, trackTags: [], artistTags: [], analysis: null, capabilities: { lyrics: false, ai: false },
  };
  return { ...toLocalSongContext(dto), stale: true };
}

// Best-effort, never awaited: drops an unread body so the connection is not held open.
function discard(response: Response): void {
  try {
    const body = response.body;
    if (body && !body.locked) body.cancel().catch(() => {});
  } catch { /* ignore */ }
}

// Cancel (not awaited) then release; works for aborted, oversized or completed reads.
function release(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try { reader.cancel().catch(() => {}); } catch { /* ignore */ }
  try { reader.releaseLock(); } catch { /* ignore */ }
}

// Streams at most maxBodyBytes UTF-8 bytes; null means fail closed. Each read races the abort signal.
async function readCapped(response: Response, signal: AbortSignal): Promise<string | null> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const text = declared.trim();
    if (!/^[0-9]+$/.test(text) || Number(text) > maxBodyBytes) {
      discard(response);
      return null;
    }
  }
  const stream = response.body;
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      if (!(value instanceof Uint8Array)) return null;
      total += value.byteLength;
      if (total > maxBodyBytes) return null;
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    release(reader);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
}

async function read(response: Response, signal: AbortSignal): Promise<Outcome> {
  if (response.status === 401 || response.status === 403) {
    discard(response);
    return { kind: "auth", snapshot: authSnapshot(response.status === 401 ? 401 : 403) };
  }
  if (!response.ok) {
    discard(response);
    return fail(retryAfterMs(response.headers.get("retry-after")));
  }
  const text = await readCapped(response, signal);
  if (text === null) return fail();
  let value: unknown;
  try { value = JSON.parse(text); } catch { return fail(); }
  if (!isCloudSongContext(value)) return fail();
  const playing = value.status === "playing" || value.status === "paused";
  return { kind: "ok", snapshot: toLocalSongContext(value), trackId: playing ? value.track?.spotifyTrackId ?? null : null };
}

export class HostedSongContextClient {
  private readonly snapshotListeners = new Set<HostedSnapshotListener>();
  private readonly statusListeners = new Set<HostedStatusListener>();
  private readonly enrichments = new Set<AbortController>();
  private status: HostedSongContextStatus = "disconnected";
  private running = false;
  private generation = 0;
  private inflight: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private freshTrackId: string | null = null;

  onSnapshot(listener: HostedSnapshotListener): () => void {
    this.snapshotListeners.add(listener);
    return () => { this.snapshotListeners.delete(listener); };
  }

  onStatus(listener: HostedStatusListener): () => void {
    this.statusListeners.add(listener);
    return () => { this.statusListeners.delete(listener); };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.generation++;
    this.failures = 0;
    const gen = this.generation;
    this.setStatus("connecting");
    if (gen === this.generation) void this.poll();
  }

  stop(): void {
    this.running = false;
    this.generation++;
    this.clearTimer();
    this.inflight?.abort();
    this.inflight = null;
    for (const controller of this.enrichments) controller.abort();
    this.enrichments.clear();
    this.failures = 0;
    this.freshTrackId = null;
    this.setStatus("disconnected");
  }

  async requestAnalysis(trackId: string): Promise<void> {
    const gen = this.generation;
    if (!this.running || typeof trackId !== "string" || !trackIdPattern.test(trackId) || trackId !== this.freshTrackId ||
      typeof globalThis.crypto?.randomUUID !== "function") {
      throw redacted();
    }
    const body = JSON.stringify({ trackId, requestId: globalThis.crypto.randomUUID() });
    if (body.length > maxPostBody) throw redacted();
    const controller = new AbortController();
    this.enrichments.add(controller);
    const timeout = setTimeout(() => controller.abort(), enrichmentTimeoutMs);
    let ok = false;
    try {
      const pending = fetch(enrichmentUrl, {
        ...baseInit, method: "POST", headers: { "content-type": "application/json" }, body, signal: controller.signal,
      });
      void pending.then(response => {
        if (controller.signal.aborted || gen !== this.generation || !this.running) discard(response);
      }, () => {});
      const response = await withAbort(pending, controller.signal);
      ok = response.ok && !response.redirected;
      discard(response); // Body (possibly empty 202) is never trusted or read.
    } catch {
      ok = false;
    } finally {
      clearTimeout(timeout);
      this.enrichments.delete(controller);
    }
    if (!ok || gen !== this.generation || !this.running) throw redacted();
    if (this.freshTrackId === trackId) this.forcePoll();
  }

  private forcePoll(): void {
    if (!this.running) return;
    this.inflight?.abort(); // Prior poll's late result is invalidated by controller identity.
    this.inflight = null;
    this.clearTimer();
    void this.poll();
  }

  private async poll(): Promise<void> {
    if (!this.running || this.inflight) return;
    this.clearTimer();
    const gen = this.generation;
    const controller = new AbortController();
    this.inflight = controller;
    const current = (): boolean => gen === this.generation && this.inflight === controller;
    const timeout = setTimeout(() => controller.abort(), timeoutMs); // Covers headers and body read.
    let outcome: Outcome;
    try {
      const response = await withAbort(fetch(contextUrl, { ...baseInit, method: "GET", signal: controller.signal }), controller.signal);
      if (current()) {
        outcome = await read(response, controller.signal);
      } else {
        discard(response);
        outcome = fail();
      }
    } catch {
      outcome = fail();
    } finally {
      clearTimeout(timeout);
    }
    if (!current()) return;
    this.inflight = null;
    this.apply(outcome, gen);
  }

  private apply(outcome: Outcome, gen: number): void {
    const live = (): boolean => this.running && gen === this.generation;
    if (outcome.kind === "ok") {
      this.failures = 0;
      this.freshTrackId = outcome.trackId;
      this.setStatus("connected");
      if (live()) this.emit(outcome.snapshot, gen);
      if (live()) this.schedule(pollMs, gen);
      return;
    }
    this.failures = Math.min(this.failures + 1, 16);
    const backoff = Math.min(maxBackoffMs, pollMs * 2 ** (this.failures - 1));
    if (outcome.kind === "auth") {
      this.freshTrackId = null;
      this.emit(outcome.snapshot, gen);
    } else {
      this.freshTrackId = null; // No snapshot; caller marks existing context stale.
    }
    if (live()) this.setStatus("disconnected");
    if (live()) this.schedule(outcome.kind === "fail" ? Math.max(backoff, outcome.retryAfterMs) : backoff, gen);
  }

  private schedule(delay: number, gen: number): void {
    if (!this.running || gen !== this.generation) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.running && gen === this.generation) void this.poll();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private emit(snapshot: SongContextSnapshot, gen: number): void {
    for (const listener of [...this.snapshotListeners]) {
      if (!this.running || gen !== this.generation) return; // Stop/restart invalidates the rest of this batch.
      if (!this.snapshotListeners.has(listener)) continue;
      try { listener(snapshot); } catch { /* listener faults never break polling */ }
    }
  }

  private setStatus(status: HostedSongContextStatus): void {
    if (this.status === status) return;
    this.status = status;
    const gen = this.generation;
    for (const listener of [...this.statusListeners]) {
      if (gen !== this.generation || this.status !== status) return; // Superseded by a nested stop/start.
      if (!this.statusListeners.has(listener)) continue;
      try { listener(status); } catch { /* ignore */ }
    }
  }
}

export default HostedSongContextClient;
