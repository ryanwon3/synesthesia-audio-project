import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpFailure, privateJson, privateResponse, record, sameOrigin, smallJson } from '../src/http';

// Real http helpers only. Synthetic origins, no network.
const ORIGIN = 'https://synesthesia.example.test';
const TARGET = `${ORIGIN}/api/auth/sign-out`;

function post(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  const init = { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body, duplex: 'half' };
  return new Request(TARGET, init as RequestInit);
}

async function failure(pending: Promise<unknown>): Promise<number | 'ok'> {
  try {
    await pending;
    return 'ok';
  } catch (error) {
    if (error instanceof HttpFailure) return error.status;
    throw error;
  }
}

function stream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  });
}

// Synthetic body that never yields and whose cancel never settles (a reader ignoring abort).
function stalled(): { body: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull: () => new Promise<void>(() => {}),
    cancel: () => { cancelled = true; return new Promise<void>(() => {}); },
  });
  return { body, cancelled: () => cancelled };
}

// Observes settlement immediately so rejections are never unhandled.
function watch(pending: Promise<unknown>): { done: boolean; status?: unknown } {
  const out: { done: boolean; status?: unknown } = { done: false };
  pending.then(() => { out.done = true; out.status = 'ok'; },
    (error: unknown) => { out.done = true; out.status = error instanceof HttpFailure ? error.status : error; });
  return out;
}

async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

afterEach(() => { vi.useRealTimers(); });

describe('http helpers', () => {
  it('privateJson is no-store nosniff JSON with a clamped Retry-After only on request', async () => {
    const response = privateJson({ ok: true }, 429, 0.2);
    expect(response.status).toBe(429);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('retry-after')).toBe('1');
    expect(await response.json()).toEqual({ ok: true });
    expect(privateJson({}, 503, 2.1).headers.get('retry-after')).toBe('3');
    expect(privateJson({}).headers.has('retry-after')).toBe(false);
    expect(privateJson({}).status).toBe(200);
  });

  it('sameOrigin needs an exact Origin, matching URL origin and no cross-site fetch', () => {
    const at = (url: string, headers: Record<string, string>) =>
      sameOrigin(new Request(url, { method: 'POST', headers }), ORIGIN);
    expect(at(TARGET, { origin: ORIGIN })).toBe(true);
    expect(at(TARGET, { origin: ORIGIN, 'sec-fetch-site': 'same-origin' })).toBe(true);
    const rejected: Array<Record<string, string>> = [
      {},
      { origin: 'null' },
      { origin: `${ORIGIN}/` },
      { origin: 'https://evil.example.test' },
      { origin: 'http://synesthesia.example.test' },
      { origin: `${ORIGIN}.evil.example.test` },
      { origin: ORIGIN, 'sec-fetch-site': 'cross-site' },
    ];
    for (const headers of rejected) expect(at(TARGET, headers), JSON.stringify(headers)).toBe(false);
    expect(at('https://evil.example.test/api/auth/sign-out', { origin: ORIGIN })).toBe(false);
  });

  it('smallJson bounds declared and streamed bytes and fails closed on bad input', async () => {
    const bytes = (text: string) => new TextEncoder().encode(text);
    const typed = post(JSON.stringify({ provider: 'spotify' }), { 'content-type': 'Application/JSON; charset=utf-8' });
    expect(await smallJson(typed)).toEqual({ provider: 'spotify' });
    const exact = JSON.stringify('x'.repeat(1022));
    expect(exact).toHaveLength(1024);
    expect(await smallJson(post(exact))).toBe('x'.repeat(1022));
    expect(await failure(smallJson(post(JSON.stringify('x'.repeat(1023)))))).toBe(413);
    for (const type of ['text/plain', 'application/jsonp', 'application/x-www-form-urlencoded']) {
      expect(await failure(smallJson(post('{}', { 'content-type': type })))).toBe(415);
    }
    expect(await failure(smallJson(new Request(TARGET, { method: 'POST', body: '{}' })))).toBe(415);
    for (const length of ['1025', '1e3', '-1', '0x10']) {
      expect(await failure(smallJson(post('{}', { 'content-length': length })))).toBe(413);
    }
    const chunk = new Uint8Array(600).fill(0x20);
    expect(await failure(smallJson(post(stream([chunk, chunk]))))).toBe(413);
    expect(await smallJson(post(stream([bytes('{"a"'), bytes(':1}')])))).toEqual({ a: 1 });
    for (const bad of ['', '{', '{"a":1}x']) expect(await failure(smallJson(post(bad)))).toBe(400);
    expect(await failure(smallJson(post(new Uint8Array([0x22, 0xff, 0x22]))))).toBe(400);
    expect(await failure(smallJson(post(null)))).toBe(400);
  });

  it('smallJson ends a stalled body on abort or a 5s deadline without awaiting cancel', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const first = stalled();
    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: first.body,
      duplex: 'half', signal: controller.signal };
    const abortable = new Request(TARGET, init as RequestInit);
    const aborted = watch(smallJson(abortable));
    await tick(100);
    expect(aborted.done).toBe(false);
    controller.abort();
    await tick(0);
    expect(aborted).toEqual({ done: true, status: 400 });
    expect([first.cancelled(), abortable.body?.locked]).toEqual([true, false]);

    const second = stalled();
    const slow = post(second.body);
    const late = watch(smallJson(slow));
    await tick(4999);
    expect(late.done).toBe(false);
    await tick(1);
    expect(late).toEqual({ done: true, status: 400 });
    expect([second.cancelled(), slow.body?.locked]).toEqual([true, false]);
  });

  it('record accepts only plain objects', () => {
    expect(record({})).toBe(true);
    expect(record(JSON.parse('{"__proto__":{"a":1}}'))).toBe(true);
    for (const value of [null, [], 'x', 1, Object.create(null), new Date(0), new Map()]) {
      expect(record(value)).toBe(false);
    }
  });

  it('privateResponse copies each Set-Cookie line exactly without mutating the original', async () => {
    const first = 'synthA=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/; HttpOnly; Secure';
    const second = 'synthB=2; Path=/; SameSite=Lax';
    const headers = new Headers();
    headers.append('Set-Cookie', first);
    headers.append('Set-Cookie', second);
    headers.set('Cache-Control', 'public, max-age=60');
    const original = new Response('synthetic body', { status: 201, statusText: 'Created', headers });
    const copy = privateResponse(original);
    expect(copy.headers.getSetCookie()).toEqual([first, second]);
    expect(copy.status).toBe(201);
    expect(copy.statusText).toBe('Created');
    expect(copy.headers.get('cache-control')).toBe('no-store');
    expect(copy.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await copy.text()).toBe('synthetic body');
    expect(original.headers.get('cache-control')).toBe('public, max-age=60');
    expect(original.headers.has('x-content-type-options')).toBe(false);
    expect(original.headers.getSetCookie()).toEqual([first, second]);
  });
});
