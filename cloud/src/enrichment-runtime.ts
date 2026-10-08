import { ANALYSIS_PROMPT_VERSION, analyzeLyrics } from "./analysis";
import { requireUser } from "./auth";
import { readCloudConfig } from "./config";
import { getDatabase } from "./db";
import { createEnrichmentService, type EnrichmentService } from "./enrichment";
import { PostgresEnrichmentRepository } from "./enrichment-repository";
import { getMatchedLyrics } from "./lyrics";
import { getHostedSongContext } from "./song-context-runtime";
import { allowRequest, UsageBudget } from "./usage-budget";

// Lazy and explicitly off by default. Enabling configuration alone does not
// trigger generation: only the authenticated manual POST can invoke it.
export function getHostedEnrichment(): EnrichmentService {
  const result = readCloudConfig(process.env);
  if (!result.ok) throw new Error("Cloud configuration unavailable");
  const config = result.config;
  if (!config.ai.enabled || !config.capabilities.ai) {
    return { async requestEnrichment() { return { status: "disabled" }; } };
  }
  const database = getDatabase();
  const budget = new UsageBudget(database, { userDaily: config.ai.userDaily, globalDaily: config.ai.globalDaily });
  const context = getHostedSongContext();
  return createEnrichmentService({ enabled: true, model: config.ai.model, promptVersion: ANALYSIS_PROMPT_VERSION,
    requireUser, getSongContext: (headers, signal) => context.getSongContext(headers, signal),
    allowEnrichment: userId => allowRequest(database, userId, "enrichment", 6),
    getLyrics: getMatchedLyrics, analyze: analyzeLyrics,
    reserve: (userId, trackId, requestId, key) => budget.reserve(userId, trackId, requestId, key),
    repository: new PostgresEnrichmentRepository(database, { model: config.ai.model, promptVersion: ANALYSIS_PROMPT_VERSION }),
    now: () => new Date(),
  });
}
