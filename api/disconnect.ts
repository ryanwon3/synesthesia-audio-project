import { AuthFailure, disconnectSpotify, getAuth, requireUser } from "../cloud/src/auth";
import { readCloudConfig } from "../cloud/src/config";
import { HttpFailure, privateJson, privateResponse, record, sameOrigin, smallJson } from "../cloud/src/http";
export async function POST(request: Request): Promise<Response> {
  const config = readCloudConfig(process.env);
  if (!config.ok) return privateJson({ error: "unavailable" }, 503);
  if (!sameOrigin(request, config.config.publicOrigin)) return privateJson({ error: "forbidden" }, 403);
  try {
    const body = await smallJson(request);
    if (!record(body) || Object.keys(body).length !== 0) throw new HttpFailure(400);
    const { userId } = await requireUser(request.headers);
    await disconnectSpotify(userId);
    return privateResponse(await getAuth().api.signOut({ headers: request.headers, asResponse: true }));
  } catch (error) {
    return privateJson({ error: "unavailable" }, error instanceof AuthFailure || error instanceof HttpFailure ? error.status : 503);
  }
}
