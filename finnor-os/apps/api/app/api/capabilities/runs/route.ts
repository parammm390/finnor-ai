import { createCapabilityRun, listCapabilityRuns } from "../../../../../../packages/orchestration/src/capabilities/repository";
import { enforceRouteRateLimit } from "../../../../lib/auth";
import { capabilityBody, capabilityError, requireCapabilityOwner } from "../../../../lib/capabilities";

export const runtime = "nodejs";
export async function GET(request: Request): Promise<Response> {
  try {
    const actor = await requireCapabilityOwner(request);
    await enforceRouteRateLimit(`capability-history:${actor.tenantId}`, 60);
    return Response.json(await listCapabilityRuns(actor, Object.fromEntries(new URL(request.url).searchParams)), { headers: { "cache-control": "no-store" } });
  } catch (error) { return capabilityError(error); }
}
export async function POST(request: Request): Promise<Response> {
  try {
    const actor = await requireCapabilityOwner(request);
    await enforceRouteRateLimit(`capability:${actor.tenantId}`, 20);
    const result = await createCapabilityRun(actor, await capabilityBody(request));
    return Response.json(result, { status: result.replayed ? 200 : 202, headers: { "cache-control": "no-store" } });
  } catch (error) { return capabilityError(error); }
}
