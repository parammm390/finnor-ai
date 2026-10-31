import { listNangoSources } from "../../../../../../../packages/orchestration/src/capabilities/nango-bindings";
import { capabilityError, requireCapabilityOwner } from "../../../../../lib/capabilities";

export const runtime = "nodejs";
export async function GET(request: Request): Promise<Response> {
  try { return Response.json(await listNangoSources(await requireCapabilityOwner(request)), { headers: { "cache-control": "no-store" } }); }
  catch (error) { return capabilityError(error); }
}
