import { handleEnrichment } from "../cloud/src/enrichment-route";
export const POST = (request: Request): Promise<Response> => handleEnrichment(request);
