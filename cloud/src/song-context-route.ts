import { isCloudSongContext } from "../../shared/CloudSongContext";
import { readCloudConfig } from "./config";
import { privateJson } from "./http";
import { getHostedSongContext } from "./song-context-runtime";
import type { SongContextService } from "./song-context";

export async function handleSongContext(request: Request,
  getService: () => SongContextService = getHostedSongContext): Promise<Response> {
  try {
    const result = readCloudConfig(process.env);
    if (!result.ok) return privateJson({ error: "unavailable" }, 503);
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    const site = request.headers.get("sec-fetch-site");
    if (url.origin !== result.config.publicOrigin || (origin !== null && origin !== url.origin) ||
      site === "cross-site" || site === "same-site") return privateJson({ error: "forbidden" }, 403);
    if (request.method !== "GET") return privateJson({ error: "methodNotAllowed" }, 405);
    if (url.pathname !== "/api/song-context" || url.search !== "") return privateJson({ error: "invalidRequest" }, 400);
    const context = await getService().getSongContext(request.headers, request.signal);
    if (!isCloudSongContext(context)) return privateJson({ error: "unavailable" }, 503);
    const status = context.status === "signedOut" ? 401 : context.status === "forbidden" ? 403 :
      context.status === "rateLimited" ? 429 : context.status === "unavailable" ? 503 : 200;
    const retry = context.nextRetryUtc === null ? undefined :
      Math.min(86400, Math.max(1, Math.ceil((Date.parse(context.nextRetryUtc) - Date.now()) / 1000)));
    return privateJson(context, status, retry);
  } catch { return privateJson({ error: "unavailable" }, 503); }
}
