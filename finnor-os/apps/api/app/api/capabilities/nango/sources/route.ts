import { listNangoSources } from "../../../../../../../packages/orchestration/src/capabilities/nango-bindings";
import { requireCapabilityActor, capabilityError } from "../../../../../lib/capabilities";

export const runtime = "nodejs";
export async function GET(request: Request): Promise<Response> {
  try { return Response.json(await listNangoSources(await requireCapabilityActor(request)), { headers: { "cache-control": "no-store" } }); }
  catch (error) { return capabilityError(error); }
}
