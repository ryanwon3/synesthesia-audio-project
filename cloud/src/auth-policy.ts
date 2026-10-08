import { getAuth } from "./auth";
import { readCloudConfig } from "./config";
import { HttpFailure, privateJson, privateResponse, record, sameOrigin, smallJson } from "./http";

export async function handleAuth(request: Request): Promise<Response> {
  const config = readCloudConfig(process.env);
  if (!config.ok) return privateJson({ error: "unavailable" }, 503);
  const url = new URL(request.url);
  const path = url.pathname;
  const get = request.method === "GET";
  const post = request.method === "POST";
  if (url.origin !== config.config.publicOrigin) return privateJson({ error: "forbidden" }, 403);
  if (get && path === "/api/auth/ok") return privateJson({ status: "ok" });
  if (get && path === "/api/auth/get-session") {
    // Never serialize the library session.token or arbitrary user/account columns.
    try {
      const session = await getAuth().api.getSession({ headers: request.headers, query: { disableCookieCache: true } });
      return privateJson({ signedIn: session !== null });
    } catch { return privateJson({ error: "unavailable" }, 503); }
  }
  if (get && path === "/api/auth/callback/spotify") {
    // Library checks signed state cookie, verification record and PKCE. No custom exchange.
    try {
      return privateResponse(await getAuth().handler(request));
    } catch { return privateJson({ error: "authentication_failed" }, 400); }
  }
  if (!post || (path !== "/api/auth/sign-in/social" && path !== "/api/auth/sign-out")) return privateJson({ error: "forbidden" }, 403);
  if (!sameOrigin(request, config.config.publicOrigin)) return privateJson({ error: "forbidden" }, 403);
  try {
    const body = await smallJson(request);
    if (!record(body)) throw new HttpFailure(400);
    if (path === "/api/auth/sign-in/social") {
      if (Object.keys(body).some(key => !["provider", "callbackURL", "errorCallbackURL"].includes(key)) || body.provider !== "spotify" ||
        (body.callbackURL !== undefined && body.callbackURL !== "/") || (body.errorCallbackURL !== undefined && body.errorCallbackURL !== "/")) throw new HttpFailure(400);
    } else if (Object.keys(body).length !== 0) throw new HttpFailure(400);
    const safeBody = path === "/api/auth/sign-in/social" ? { provider: "spotify", callbackURL: "/", errorCallbackURL: "/", disableRedirect: true } : {};
    const forwarded = new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(safeBody), signal: request.signal });
    forwarded.headers.delete("content-length");
    return privateResponse(await getAuth().handler(forwarded));
  } catch (error) {
    return privateJson({ error: "unavailable" }, error instanceof HttpFailure ? error.status : 503);
  }
}
