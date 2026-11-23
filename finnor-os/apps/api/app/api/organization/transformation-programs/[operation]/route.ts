import { requireContext } from "../../../../../lib/auth";
import { getOrchestrator } from "../../../../../lib/orchestrator";
import type { TenantContext } from "@finnor/shared-types";
import type { ORGANIZATION_GET_OPERATIONS, ORGANIZATION_POST_OPERATIONS } from
  "@finnor/private-equity/src/organization-transformation/native-contracts";
import {
  intakeOrganizationTransformation, submitOrganizationTransformation, readOrganizationTransformation,
  actOrganizationTransformation, decideOrganizationAdoption, useOrganizationProcess,
  registerOrganizationSource, readOrganizationOffers, composeOrganizationObligation, composeOrganizationResourceConstraint,
  readOrganizationPackets, acknowledgeOrganizationPacket,
  readOrganizationOriginalInput,
  prepareOrganizationEffectContinuation, readOrganizationEffectContinuation,
  recordOrganizationEffectContinuationReadback, evaluateOrganizationOperation, readOrganizationEvaluation,
  registerOrganizationTrial, readOrganizationTrial, recordOrganizationTrialObservation,
} from "@finnor/private-equity/src/organization-transformation/native";
import { organizationJson, organizationHttpError, organizationPrivateHeaders } from "../http";

type Context = { params: Promise<{ operation: string }> };
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function continueOriginalEffect(ctx: TenantContext, value: unknown) {
  const prepared = await prepareOrganizationEffectContinuation(ctx, value);
  if (!prepared.executeOriginalAction) return prepared.result;
  try {
    await getOrchestrator().runAction(prepared.executeOriginalAction.actionId, ctx.tenantId,
      prepared.executeOriginalAction.approvedBy);
  } catch {
    // The committed intent is not a retry permit. Only original-owner readback
    // below determines what was actually authorized, dispatched or left unknown.
  }
  return recordOrganizationEffectContinuationReadback(ctx, value);
}
export async function POST(req: Request, context: Context): Promise<Response> {
  try {
    const ctx = await requireContext(req), { operation } = await context.params;
    const routes = {
      intake: intakeOrganizationTransformation, submit: submitOrganizationTransformation,
      source: registerOrganizationSource, action: actOrganizationTransformation,
      adoption: decideOrganizationAdoption, "process-use": useOrganizationProcess, "compose-obligation": composeOrganizationObligation,
      "compose-resource-constraint": composeOrganizationResourceConstraint,
      "packet-read": acknowledgeOrganizationPacket,
      continuation: continueOriginalEffect, evaluation: evaluateOrganizationOperation,
      trial: registerOrganizationTrial, "trial-observation": recordOrganizationTrialObservation,
    } satisfies Record<(typeof ORGANIZATION_POST_OPERATIONS)[number], (ctx: TenantContext, value: unknown) => Promise<unknown>>;
    if (!Object.hasOwn(routes, operation)) return Response.json({ error: "W5_OPERATION_UNAVAILABLE" },
      { status: 404, headers: organizationPrivateHeaders });
    const result = await routes[operation as keyof typeof routes](ctx, await organizationJson(req));
    return Response.json(result, { headers: organizationPrivateHeaders });
  } catch (error) { return organizationHttpError(error); }
}
export async function GET(req: Request, context: Context): Promise<Response> {
  try {
    const ctx = await requireContext(req), { operation } = await context.params;
    const url = new URL(req.url);
    const routes = { read: readOrganizationTransformation, offers: readOrganizationOffers,
      input: readOrganizationOriginalInput, packets: readOrganizationPackets,
      continuation: readOrganizationEffectContinuation, evaluation: readOrganizationEvaluation,
      trial: readOrganizationTrial,
    } satisfies Record<(typeof ORGANIZATION_GET_OPERATIONS)[number], (ctx: TenantContext, value: unknown) => Promise<unknown>>;
    if (!Object.hasOwn(routes, operation)) return Response.json({ error: "W5_OPERATION_UNAVAILABLE" },
      { status: 404, headers: organizationPrivateHeaders });
    const result = await routes[operation as keyof typeof routes](ctx, Object.fromEntries(url.searchParams));
    return Response.json(result, { headers: organizationPrivateHeaders });
  } catch (error) { return organizationHttpError(error); }
}
