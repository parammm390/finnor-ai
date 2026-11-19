import { createNangoConnectSession } from "../../../../../../../packages/orchestration/src/capabilities/nango-bindings";
import { enforceRouteRateLimit } from "../../../../../lib/auth";
import { requireCapabilityActor, capabilityBody, capabilityError } from "../../../../../lib/capabilities";

export const runtime = "nodejs";
export async function POST(request: Request): Promise<Response> {
  try {
    const actor = await requireCapabilityActor(request); await enforceRouteRateLimit(`nango-connect:${actor.tenantId}`, 5);
    return Response.json(await createNangoConnectSession(actor, await capabilityBody(request)), { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) { return capabilityError(error); }
}
