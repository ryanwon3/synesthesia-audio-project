import { AuthFailure } from "./auth";
import { readCloudConfig } from "./config";
import { parseEnrichmentRequest, type EnrichmentService } from "./enrichment";
import { getHostedEnrichment } from "./enrichment-runtime";
import { HttpFailure, privateJson, sameOrigin, smallJson } from "./http";
import { ProviderFailure } from "./provider-http";
export async function handleEnrichment(request: Request, getService: () => EnrichmentService = getHostedEnrichment): Promise<Response> {
  try {
    const result = readCloudConfig(process.env);
    if (!result.ok) return privateJson({ error: "unavailable" }, 503);
    if (request.method !== "POST") return privateJson({ error: "methodNotAllowed" }, 405);
    if (!sameOrigin(request, result.config.publicOrigin)) return privateJson({ error: "forbidden" }, 403);
    const url = new URL(request.url);
    if (url.pathname !== "/api/enrichment" || url.search !== "") throw new HttpFailure(400);
    const input = parseEnrichmentRequest(await smallJson(request));
    const outcome = await getService().requestEnrichment(request.headers, input, request.signal);
    if (Object.keys(outcome).length !== 1 || !["ready", "pending", "disabled", "limited"].includes(outcome.status)) {
      return privateJson({ error: "unavailable" }, 503);
    }
    const status = outcome.status === "pending" ? 202 : outcome.status === "limited" ? 429 : outcome.status === "disabled" ? 503 : 200;
    return privateJson({ status: outcome.status }, status, status === 429 ? 60 : undefined);
  } catch (error) {
    const status = error instanceof AuthFailure || error instanceof HttpFailure ? error.status :
      error instanceof ProviderFailure && error.status === 429 ? 429 : 503;
    return privateJson({ error: "unavailable" }, status,
      status === 429 ? Math.min(86400, Math.max(1, error instanceof ProviderFailure ? error.retrySeconds ?? 60 : 60)) : undefined);
  }
}
