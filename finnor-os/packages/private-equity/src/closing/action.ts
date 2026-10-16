import type { DomainAction, DraftAction } from "@finnor/shared-types";
import type { ConsequentialDispatchRequest } from "@finnor/tools";
import type { PeMutationContext } from "../types";
import { closingTx as tx } from "../owner-context";
import { ClosingError } from "./contracts";
import { closingCanonical } from "./compiler";
import { assertClosingCurrent, closingProfile, closingProgramme } from "./store";
import { originalClosingRequirement } from "../../../governed-execution/src/closing-provider";
import { bindClosingAllocationAttempt } from "../allocation-store";
import { refreshIndependentClosingCheck } from "./check-client";
import { validateEnterpriseAllocation } from "../enterprise-allocation";

/** The receipt and execution authority exist now. Refresh the exact publication
 * cut here, not before the native executor has compiled its own close action. */
export async function prepareClosingPublication(ctx: PeMutationContext, domainActionId: string) {
  const link = await tx(ctx, async c => (await c.query(
    "SELECT programme_id FROM finnor_os.pe_closing_node_links WHERE tenant_id=$1 AND domain_action_id=$2 AND node_key='publish-close'",
    [ctx.auth.tenantId, domainActionId],
  )).rows[0], true);
  if (!link) throw new ClosingError("CLOSING_ORIGINAL_PUBLICATION_CHILD_REQUIRED");
  const q = await closingProgramme(ctx, link.programme_id);
  await assertClosingCurrent(ctx, q);
  if (q.publication_action_id !== domainActionId) throw new ClosingError("CLOSING_EXACT_PUBLICATION_ACTION_REQUIRED");
  const result = await refreshIndependentClosingCheck(ctx, q);
  if (!result.accepted) throw new ClosingError("CLOSING_CURRENT_INDEPENDENT_CONJUNCTION_REQUIRED");
}

export async function groundClosingOperation(ctx: PeMutationContext, action: DomainAction, draft: DraftAction) {
  const q = await closingProgramme(ctx, String(draft.payload.programmeId));
  await assertClosingCurrent(ctx, q);
  const step = q.spec.steps.find(s => s.key === draft.payload.nodeKey);
  if (!step || q.work_id !== action.workId || q.transaction_id !== draft.payload.dealId
      || q.spec_digest !== draft.payload.specDigest || step.actor.principalId !== action.initiatedBy) {
    throw new ClosingError("CLOSING_ACTION_ORIGINAL_SPEC_WORK_AND_ACTOR_REQUIRED");
  }
  const profile = await closingProfile(ctx, q), provider = profile.providers.find(p => p.id === step.providerProfileId);
  if (!provider || !provider.allowedKinds.includes(step.kind as never)) throw new ClosingError("CLOSING_OPERATION_INTERFACE_UNAVAILABLE");
  const { credentialRef: _privateCredentialReference, ...publicProvider } = provider;
  return {
    ...draft.payload, workId: q.work_id, closingStep: step,
    closingRequirement: originalClosingRequirement(q.spec, step),
    closingProvider: publicProvider,
    originalGrant: q.spec.originalGrant,
  };
}

/** This is the ordinary worker's last adapter guard. The separate broker repeats
 * the original-spec, independent-readiness and physical-egress checks. */
export async function verifyClosingToolDispatch(ctx: PeMutationContext, effect: {
  id: string; semanticHash: string; delta: { values: Record<string, unknown> };
}, request: ConsequentialDispatchRequest) {
  const values = effect.delta.values;
  const q = await closingProgramme(ctx, String(values.programmeId));
  await assertClosingCurrent(ctx, q);
  const step = q.spec.steps.find(s => s.key === values.nodeKey);
  if (!step || request.toolName !== "execute_closing_provider_operation" || request.provider !== "finnor_closing_provider"
      || request.runtime.actorId !== step.actor.principalId || values.specDigest !== q.spec_digest
      || closingCanonical(values.closingStep) !== closingCanonical(step)
      || closingCanonical(values.closingRequirement) !== closingCanonical(originalClosingRequirement(q.spec, step))) {
    throw new ClosingError("CLOSING_CONCRETE_DISPATCH_DIFFERS_FROM_ORIGINAL_APPROVED_EFFECT");
  }
  const expected = {
    tenantId: q.tenant_id, programmeId: q.id, nodeKey: step.key,
    domainActionId: request.runtime.domainActionId, businessEffectId: effect.id, businessEffectHash: effect.semanticHash,
  };
  if (closingCanonical(request.input) !== closingCanonical(expected)) throw new ClosingError("CLOSING_CONCRETE_NATIVE_REFS_CHANGED");
  const link = await tx(ctx, async c => {
    const l = (await c.query("SELECT * FROM finnor_os.pe_closing_node_links WHERE tenant_id=$1 AND programme_id=$2 AND node_key=$3", [q.tenant_id, q.id, step.key])).rows[0];
    const check = (await c.query("SELECT c.body,c.valid_until,c.observation_basis_digest,finnor_os.pe_closing_execution_basis_digest($1,$2,$4) current_basis FROM finnor_os.pe_closing_checks c WHERE c.tenant_id=$1 AND c.id=$3 AND c.programme_id=$2 AND c.spec_digest=$5", [q.tenant_id, q.id, q.last_check_id, effect.id, q.spec_digest])).rows[0];
    if (!l || l.business_effect_id !== effect.id || l.domain_action_id !== request.runtime.domainActionId
        || !l.consumption_ref || !check || new Date(check.valid_until).getTime() <= Date.now()
        || check.observation_basis_digest !== check.current_basis || !check.body.readyOperationKeys.includes(step.key)) {
      throw new ClosingError("CLOSING_CURRENT_INDEPENDENT_READINESS_AND_NATIVE_S5_BINDING_REQUIRED");
    }
    return l;
  }, true);
  const strip = (r: { owner: string; id: string; version: string; contentDigest: string }) =>
    ({ owner: r.owner, id: r.id, version: r.version, contentDigest: r.contentDigest });
  if (!step.allocationRef) throw new ClosingError("CLOSING_ORIGINAL_S5_ALLOCATION_REQUIRED");
  if ((await validateEnterpriseAllocation(ctx, strip(step.allocationRef))).status !== "CURRENT") {
    throw new ClosingError("CLOSING_S5_CURRENT_EGRESS_CLEARANCE_REQUIRED");
  }
  await bindClosingAllocationAttempt(ctx, {
    allocationRef: strip(step.allocationRef), consumptionRef: strip(link.consumption_ref),
    programmeId: q.id, nodeKey: step.key, effectId: effect.id,
  });
}
