import { changePlannerActivation, readPlannerActivation } from "../../../../../../../packages/orchestration/src/capabilities/planner-activation";
import { enforceRouteRateLimit } from "../../../../../lib/auth";
import { capabilityBody, capabilityError, requireCapabilityOwner } from "../../../../../lib/capabilities";

export const runtime = "nodejs";
export async function GET(request: Request): Promise<Response> {
  try { return Response.json(await readPlannerActivation(await requireCapabilityOwner(request)), { headers: { "cache-control": "no-store" } }); }
  catch (error) { return capabilityError(error); }
}
export async function POST(request: Request): Promise<Response> {
  try {
    const actor = await requireCapabilityOwner(request); await enforceRouteRateLimit(`planner-activation:${actor.tenantId}`, 20);
    return Response.json(await changePlannerActivation(actor, await capabilityBody(request)), { headers: { "cache-control": "no-store" } });
  } catch (error) { return capabilityError(error); }
}
