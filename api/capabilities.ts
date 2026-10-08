import { readCloudConfig } from "../cloud/src/config";

// Config is read per request, never at import. Only the three booleans are copied out;
// missing names, config values, and exceptions never reach the response or logs.
export function GET(): Response {
  let capabilities = { spotify: false, lyrics: false, ai: false };
  try {
    const result = readCloudConfig(process.env);
    if (result.ok) {
      const { spotify, lyrics, ai } = result.config.capabilities;
      capabilities = { spotify: spotify === true, lyrics: lyrics === true, ai: ai === true };
    }
  } catch {
    // Unexpected config failure reports everything off with the same body.
  }
  return Response.json(capabilities, { headers: { "Cache-Control": "no-store" } });
}
