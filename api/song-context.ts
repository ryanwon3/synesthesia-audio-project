import { handleSongContext } from "../cloud/src/song-context-route";

export const GET = (request: Request): Promise<Response> => handleSongContext(request);
