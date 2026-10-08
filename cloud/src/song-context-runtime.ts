import { getSpotifyToken, requireUser } from "./auth";
import { ANALYSIS_PROMPT_VERSION } from "./analysis";
import { startDeadline } from "./bounded-body";
import { readCloudConfig } from "./config";
import { PostgresContextRepository } from "./context-repository";
import { getDatabase } from "./db";
import { getTags } from "./lastfm";
import { ProviderFailure } from "./provider-http";
import { createSongContextService, type SongContextService } from "./song-context";
import { readCurrentPlayback } from "./spotify";
import { allowRequest } from "./usage-budget";

// The only production composition boundary. Nothing reads secrets or connects
// at module import. Context polling never invokes lyrics or paid AI generation.
export function getHostedSongContext(): SongContextService {
  const result = readCloudConfig(process.env);
  if (!result.ok) throw new Error("Cloud configuration unavailable");
  const config = result.config;
  const database = getDatabase();
  const repository = new PostgresContextRepository(database, { model: config.ai.model, promptVersion: ANALYSIS_PROMPT_VERSION });
  return createSongContextService({ requireUser, getSpotifyToken, readCurrentPlayback, repository,
    getTags: async (track, signal) => {
      // Configuration absence is not a provider's negative lookup; do not poison
      // the shared 30-day negative cache if the owner adds the key later.
      if (config.lastFmApiKey === null) throw new ProviderFailure(503);
      const optional = startDeadline(signal, 3000);
      try {
        if (await optional.run(() => repository.lastFmCoolingDown())) throw new ProviderFailure(503);
        return await optional.run(() => getTags(track, optional.signal));
      }
      catch (error) {
        if (!optional.signal.aborted && error instanceof ProviderFailure && error.status === 429) {
          await optional.run(() => repository.deferTags(track, error.retrySeconds ?? 60));
        }
        throw error;
      } finally { optional.dispose(); }
    },
    allowContext: userId => allowRequest(database, userId, "context", 24),
    now: () => new Date(), capabilities: { lyrics: config.capabilities.lyrics, ai: config.capabilities.ai },
  });
}
