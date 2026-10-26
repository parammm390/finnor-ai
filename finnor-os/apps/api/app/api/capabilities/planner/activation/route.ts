import { changePlannerActivation, readPlannerActivation } from "../../../../../../../packages/orchestration/src/capabilities/planner-activation";
import { requireContext, enforceRouteRateLimit } from "../../../../../lib/auth";
import { capabilityBody, capabilityError } from "../../../../../lib/capabilities";

export const runtime = "nodejs";
export async function GET(request: Request): Promise<Response> {
  try { return Response.json(await readPlannerActivation(await requireContext(request)), { headers: { "cache-control": "no-store" } }); }
  catch (error) { return capabilityError(error); }
}
export async function POST(request: Request): Promise<Response> {
  try {
    const actor = await requireContext(request); await enforceRouteRateLimit(`planner-activation:${actor.tenantId}`, 20);
    return Response.json(await changePlannerActivation(actor, await capabilityBody(request)), { headers: { "cache-control": "no-store" } });
  } catch (error) { return capabilityError(error); }
}
