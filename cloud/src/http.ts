import { BodyTooLarge, declaredWithin, decodeJson, readBounded, startDeadline } from "./bounded-body";

const SMALL_JSON_TIMEOUT_MS = 5000;

export class HttpFailure extends Error {
  constructor(public readonly status: number) { super("Request unavailable"); }
}
export function privateJson(value: unknown, status = 200, retrySeconds?: number): Response {
  const headers: Record<string, string> = { "Cache-Control": "no-store", "Content-Type": "application/json", "X-Content-Type-Options": "nosniff" };
  if (retrySeconds !== undefined) headers["Retry-After"] = String(Math.max(1, Math.ceil(retrySeconds)));
  return new Response(JSON.stringify(value), { status, headers });
}
export function sameOrigin(request: Request, origin: string): boolean {
  return request.headers.get("origin") === origin && new URL(request.url).origin === origin &&
    request.headers.get("sec-fetch-site") !== "cross-site";
}
export async function smallJson(request: Request, maxBytes = 1024): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) throw new HttpFailure(415);
  const length = request.headers.get("content-length");
  if (length !== null && !declaredWithin(length, maxBytes)) throw new HttpFailure(413);
  const body = request.body;
  if (!body) throw new HttpFailure(400);
  // Client abort (request.signal) or the fixed 5s deadline ends the read with a fixed 400.
  const deadline = startDeadline(request.signal, SMALL_JSON_TIMEOUT_MS);
  let bytes: Uint8Array;
  try { bytes = await readBounded(body, maxBytes, deadline); }
  catch (error) { throw new HttpFailure(error instanceof BodyTooLarge ? 413 : 400); }
  finally { deadline.dispose(); }
  try { return decodeJson(bytes); }
  catch { throw new HttpFailure(400); }
}
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
// Copy library responses into fresh headers; fetch()/Response.redirect headers are immutable.
// Never mutate the library response. Each Set-Cookie is kept as a separate header line.
export function privateResponse(response: Response): Response {
  const headers = new Headers();
  response.headers.forEach((value, name) => { if (name.toLowerCase() !== "set-cookie") headers.set(name, value); });
  const source = response.headers as Headers & { getSetCookie?: () => string[] };
  const cookies = typeof source.getSetCookie === "function" ? [...source.getSetCookie()] : [];
  const single = response.headers.get("set-cookie");
  if (cookies.length === 0 && single !== null) cookies.push(single);
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
