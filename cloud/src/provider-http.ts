import { declaredWithin, decodeJson, discard, readBounded, startDeadline } from "./bounded-body";

// Source-owned ceiling: the AI path passes 18000; nothing may extend past it.
const MAX_TIMEOUT_MS = 18000;

export class ProviderFailure extends Error {
  constructor(public readonly status: number, public readonly retrySeconds: number | null = null) { super("Provider unavailable"); }
}
export function retryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = /^\d+$/.test(value) ? Number(value) : (Date.parse(value) - now) / 1000;
  return Number.isFinite(seconds) ? Math.min(86400, Math.max(1, Math.ceil(seconds))) : null;
}
// Private helper: callers below construct only fixed, source-owned HTTPS endpoints.
export async function providerJson(url: URL | string, signal: AbortSignal, maxBytes: number,
  init: Omit<RequestInit, "signal" | "redirect"> = {}, timeoutMs = 5000): Promise<unknown> {
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, MAX_TIMEOUT_MS) : 5000;
  const deadline = startDeadline(signal, ms);
  try {
    let response: Response;
    try {
      response = await deadline.run(() => {
        const pending = fetch(url, { ...init, signal: deadline.signal, redirect: "error" });
        // A transport that ignores abort may resolve late: drop that body unread.
        pending.then((late) => { if (deadline.signal.aborted) discard(late.body); }, () => {});
        return pending;
      });
    } catch { throw new ProviderFailure(503); }
    if (response.status === 204) { discard(response.body); return null; }
    if (!response.ok) {
      discard(response.body);
      throw new ProviderFailure(response.status, retryAfter(response.headers.get("retry-after")));
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && !declaredWithin(declared, maxBytes)) { discard(response.body); throw new ProviderFailure(502); }
    const body = response.body;
    if (!body) throw new ProviderFailure(502);
    try { return decodeJson(await readBounded(body, maxBytes, deadline)); }
    catch { throw new ProviderFailure(502); }
  } finally { deadline.dispose(); }
}
