import type { ExperimentRef } from "@finnor/shared-types";
import type { PeMutationContext } from "@finnor/private-equity/src/types";
import type { ApplicationSessionRow } from "@finnor/private-equity/src/application-semantics/store";
import { principal, tx } from "@finnor/private-equity/src/evidence-execution/store";
import { nativeRequestRow } from "@finnor/private-equity/src/program-synthesis/store";
import { projectInheritedApplicationBudget } from "./institution-allocation";
import { retainedInstitutionApplicationOrigin } from "./institution-origin";

/** References and accounting only. Private compiler sources, credentials,
 * bindings and learned interaction code are never part of the mounted view. */
export async function projectInstitutionApplication(ctx: PeMutationContext, row: ApplicationSessionRow) {
  const ancestry = await tx(ctx, async c => {
    const origin = await retainedInstitutionApplicationOrigin(ctx, row, c);
    if (!origin) return null;
    const programme = await nativeRequestRow(ctx, origin.body.selector.programId, c);
    const accepted = (await c.query<{ ref: ExperimentRef; consumed: boolean }>(`SELECT
      e.body->'detail'->'acceptanceRef' ref,
      EXISTS(SELECT 1 FROM finnor_os.p1_events p
        JOIN finnor_os.domain_actions d ON d.tenant_id=p.tenant_id AND d.id::text=p.body->>'canonicalActionId'
        WHERE p.tenant_id=e.tenant_id AND p.principal_id=e.principal_id AND p.request_id=$4
          AND p.generation=$5 AND p.kind='P1_ORIGINAL_APPLICATION_MODEL_CONSUMED'
          AND p.body->>'schema'='finnor.z0.original-owner-model-use.v1'
          AND p.body->>'actualOwner'='ORIGINAL_NATIVE_P1_ACTION_BRIDGE'
          AND d.work_id=$6 AND d.initiated_by=e.principal_id
          AND d.authority_context->'applicationModelUseRef'=p.body->'modelUseRef'
          AND d.authority_context->>'applicationModelInputDigest'=p.body->>'ownerInputDigest'
          AND p.body->'acceptanceRef'=e.body->'detail'->'acceptanceRef') consumed
      FROM finnor_os.application_semantics_events e
      WHERE e.tenant_id=$1 AND e.principal_id=$2 AND e.session_id=$3
        AND e.kind='S4_INSTITUTION_APPLICATION_MODEL_ACCEPTED'
      ORDER BY e.created_at DESC,e.event_id DESC LIMIT 1`,
    [ctx.auth.tenantId, principal(ctx), row.id, programme.id, programme.generation, programme.work_id])).rows[0];
    return {
      schema: "finnor.z0.institution-application-view.v1" as const,
      originRef: origin.ref, compilerRequestId: origin.body.selector.compilerRequestId,
      programId: origin.body.selector.programId,
      responsibilityIdentity: origin.body.selector.responsibilityIdentity,
      originalWorkId: origin.body.workId, originalWorkInputId: origin.body.workInputId,
      institutionalProgramRef: origin.body.institutionalProgramRef,
      originalReservationRef: origin.body.originalReservationRef,
      originalDeadlineAt: origin.body.originalDeadlineAt, wallDeadlineAt: origin.body.wallDeadlineAt,
      childDeadlineAt: origin.body.deadlineAt, programmeStatus: programme.status,
      modelAcceptanceRef: accepted?.ref ?? null, modelConsumedByOriginalP1: accepted?.consumed ?? false,
      completionOwner: "ORIGINAL_P1_AND_INDEPENDENT_CANONICAL_OBSERVER" as const,
      learnedModelCompletesResponsibility: false as const, newAllowance: false as const,
      protectedAdmission: false as const, executionAuthorityGranted: false as const,
    };
  }, true);
  if (!ancestry) return null;
  return { ...ancestry, budget: await projectInheritedApplicationBudget(ctx, row.allocation_ref) };
}
