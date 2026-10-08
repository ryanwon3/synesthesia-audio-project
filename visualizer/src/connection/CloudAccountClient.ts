// Same-origin account client: fixed endpoints, bounded reads and one fixed redacted error.
// No browser storage, provider keys, token requests or query/config origin overrides.
// Sign-out/disconnect never read bodies or touch storage; the account UI clears memory separately.
const FAILED = "Account request failed";
const DEADLINE_MS = 5_000;
const MAX_BYTES = 8_192;
const MAX_URL = 4_096;
const AUTH_ORIGIN = "https://accounts.spotify.com";
const noop = (): void => undefined;

type Navigate = (url: string) => void;
type Payload = Readonly<Record<string, string>>;
export interface HostedCapabilities { spotify: boolean; lyrics: boolean; ai: boolean }

function fail(): Error {
  return new Error(FAILED);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

// Strict {url, redirect: false}: cloud/src/auth-policy.ts always forwards disableRedirect: true, so the pinned
// better-auth reply is {url, redirect: !disableRedirect} with no Location; the caller navigates after validation.
// Canonical https://accounts.spotify.com/authorize, no port/userinfo/hash.
function authorizeUrl(value: unknown): string {
  if (!plainRecord(value) || !exactKeys(value, ["url", "redirect"]) || value.redirect !== false) throw fail();
  const raw = value.url;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL || raw.includes("#")) throw fail();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw fail();
  }
  if (parsed.protocol !== "https:" || parsed.origin !== AUTH_ORIGIN || parsed.port !== "" || parsed.username !== "" ||
    parsed.password !== "" || parsed.hash !== "" || parsed.pathname !== "/authorize" || parsed.href !== raw) throw fail();
  return raw;
}

// Non-awaited cancel with swallowed rejection; never reads untrusted bytes.
function discard(response: Response): void {
  try {
    void response.body?.cancel().catch(noop);
  } catch {
    // locked or already released: nothing further to read
  }
}

export class CloudAccountClient {
  private generation = 0;
  private readonly active = new Set<AbortController>();
  private readonly navigate: Navigate;

  // Optional seam is the production UI navigation policy; default is a full-page assign.
  constructor(navigate?: Navigate) {
    this.navigate = navigate ?? ((url: string) => window.location.assign(url));
  }

  async connect(): Promise<void> {
    await this.request("/api/auth/sign-in/social", { provider: "spotify", callbackURL: "/", errorCallbackURL: "/" }, (value) => {
      this.navigate(authorizeUrl(value));
    });
  }

  async signOut(): Promise<void> {
    await this.request("/api/auth/sign-out", {});
  }

  async disconnect(): Promise<void> {
    await this.request("/api/disconnect", {});
  }
  async capabilities(): Promise<HostedCapabilities> {
    const result = await this.request("/api/capabilities", null, value => {
      if (!plainRecord(value) || !exactKeys(value, ["spotify", "lyrics", "ai"]) ||
        [value.spotify, value.lyrics, value.ai].some(flag => typeof flag !== "boolean")) throw fail();
      return { spotify: value.spotify as boolean, lyrics: value.lyrics as boolean, ai: value.ai as boolean };
    });
    if (!result) throw fail();
    return result;
  }

  // Strict {signedIn: boolean} only; anything else rejects with the fixed error.
  async signedIn(): Promise<boolean> {
    const result = await this.request("/api/auth/get-session", null, (value) => {
      if (!plainRecord(value) || !exactKeys(value, ["signedIn"])) throw fail();
      const signed = value.signedIn;
      if (typeof signed !== "boolean") throw fail();
      return signed;
    });
    if (typeof result !== "boolean") throw fail();
    return result;
  }

  // Aborts everything outstanding; later calls run in a fresh generation.
  stop(): void {
    this.generation += 1;
    const outstanding = [...this.active];
    this.active.clear();
    for (const controller of outstanding) controller.abort();
  }

  private async request<T>(path: string, payload: Payload | null, accept?: (value: unknown) => T): Promise<T | undefined> {
    const generation = this.generation;
    const controller = new AbortController();
    const { signal } = controller;
    this.active.add(controller);
    let onAbort: () => void = noop;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(fail());
      signal.addEventListener("abort", onAbort);
    });
    void aborted.catch(noop);
    const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
    const live = (): void => {
      if (generation !== this.generation || signal.aborted) throw fail();
    };
    const race = <V>(work: Promise<V>): Promise<V> => Promise.race([work, aborted]);
    let finished = false;
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<unknown> | undefined;
    try {
      const init: RequestInit = { method: payload ? "POST" : "GET", credentials: "same-origin", cache: "no-store", redirect: "error", signal };
      if (payload) {
        init.headers = { "content-type": "application/json" };
        init.body = JSON.stringify(payload);
      }
      const fetching = fetch(path, init);
      // Late headers after deadline/stop are never read: cancel their body, swallow rejection.
      void fetching.then((late) => { if (finished) discard(late); }, noop);
      response = await race(fetching);
      live();
      if (!response.ok || response.redirected) throw fail();
      if (!accept) return undefined;
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d{1,5}$/.test(length) || Number(length) > MAX_BYTES)) throw fail();
      if (!response.body) throw fail();
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const step = await race(reader.read());
        live();
        if (step.done) break;
        const chunk: unknown = step.value;
        if (!ArrayBuffer.isView(chunk)) throw fail();
        total += chunk.byteLength;
        if (total > MAX_BYTES) throw fail();
        chunks.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      live();
      return accept(value);
    } catch {
      throw fail();
    } finally {
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      this.active.delete(controller);
      if (reader) {
        const held = reader;
        try { void held.cancel().catch(noop); } catch { /* already released */ }
        try { held.releaseLock(); } catch { /* nothing held */ }
      } else if (response) {
        discard(response);
      }
    }
  }
}
