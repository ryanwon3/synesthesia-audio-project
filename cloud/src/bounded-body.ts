// Internal helper: deadline-raced, byte-bounded body reads. Never touches config, logs, errors or causes.
export class BodyTooLarge extends Error {
  constructor() { super("Body too large"); }
}
export interface Deadline {
  readonly signal: AbortSignal;
  run<T>(work: () => Promise<T>): Promise<T>;
  dispose(): void;
}
// Controlled setTimeout (fakeable, always cleared) plus parent abort. Every awaited step is raced,
// so a transport or stream that ignores abort still cannot hold the caller.
export function startDeadline(parent: AbortSignal | null | undefined, ms: number): Deadline {
  const controller = new AbortController();
  const stop = new Error("Deadline");
  let reject: (reason: Error) => void = () => {};
  const stopped = new Promise<never>((_resolve, fail) => { reject = fail; });
  stopped.catch(() => {});
  const fire = (): void => { controller.abort(); reject(stop); };
  const timer = setTimeout(fire, ms);
  parent?.addEventListener("abort", fire, { once: true });
  if (parent?.aborted) fire();
  return {
    signal: controller.signal,
    run<T>(work: () => Promise<T>): Promise<T> {
      if (controller.signal.aborted) return Promise.reject(stop);
      let pending: Promise<T>;
      try { pending = work(); } catch { return Promise.reject(stop); }
      pending.catch(() => {});
      return Promise.race([pending, stopped]);
    },
    dispose(): void { clearTimeout(timer); parent?.removeEventListener("abort", fire); },
  };
}
// Decimal digits only; 15 digits stays within Number.MAX_SAFE_INTEGER.
export function declaredWithin(value: string, maxBytes: number): boolean {
  return /^\d{1,15}$/.test(value) && Number(value) <= maxBytes;
}
// Best effort, never awaited: a cancel that never settles cannot stall the caller.
export function discard(body: ReadableStream<Uint8Array> | null): void {
  if (body && !body.locked) body.cancel().catch(() => {});
}
export async function readBounded(body: ReadableStream<Uint8Array>, maxBytes: number,
  deadline: Deadline): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await deadline.run(() => reader.read());
      if (done) break;
      if (!ArrayBuffer.isView(value)) throw new Error("Invalid body");
      total += value.byteLength;
      if (total > maxBytes) throw new BodyTooLarge();
      chunks.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
export function decodeJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}
