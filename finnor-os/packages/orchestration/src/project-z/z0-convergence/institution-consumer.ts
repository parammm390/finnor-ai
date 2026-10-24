import type { PoolClient } from "pg";
import type { ApplicationActionModel, ApplicationModelCheck, ExperimentRef } from "@finnor/shared-types";
import type { JobExecutionContext } from "../../../../../apps/worker/src/queue";
import type { PeMutationContext } from "@finnor/private-equity/src/types";
import type { ApplicationSessionRow } from "@finnor/private-equity/src/application-semantics/store";
import { applicationArtifact, applicationEvent, applicationSession, retainApplicationArtifact } from "@finnor/private-equity/src/application-semantics/store";
import { assertApplicationClaim } from "@finnor/private-equity/src/application-semantics/obligations";
import { assertApplicationModelUse } from "@finnor/private-equity/src/application-semantics/checker";
import { parseApplicationCheck, parseApplicationModel, sameX2Ref, x2Digest, x2Fault, x2Ref } from "@finnor/private-equity/src/application-semantics/contracts";
import { principal, tx } from "@finnor/private-equity/src/evidence-execution/store";
import { assertProgramCurrent, enqueueProgram, nativeRequestRow, trace } from "@finnor/private-equity/src/program-synthesis/store";
import { isInstitutionRequest } from "@finnor/private-equity/src/program-synthesis/contracts";
import { assertInstitutionApplicationOriginCurrent, assertNoPendingInstitutionApplication,
  lockInstitutionApplicationOwners, retainedInstitutionApplicationOrigin, type InstitutionalAcquireRequest } from "./institution-origin";

interface InstitutionModelAcceptance {
  schema: "finnor.s4.institution-application-model-acceptance.v1";
  institutionalOriginRef: ExperimentRef; originalProgrammeId: string; programmeGeneration: number;
  workId: string; workInputId: string; originalReservationRef: ExperimentRef; deadlineAt: string;
  modelRef: ExperimentRef; checkRef: ExperimentRef; originalParentRef: ExperimentRef; sessionId: string;
  resourceChargeRoot: ExperimentRef; completionOwner: "ORIGINAL_P1_AND_INDEPENDENT_CANONICAL_OBSERVER";
  learnedModelCompletesResponsibility: false; newAllowance: false; executionAuthorityGranted: false;
  protectedAdmission: false;
}
async function retainedModel(ctx: PeMutationContext, row: ApplicationSessionRow, c: PoolClient) {
  if (!row.model_ref || !row.check_ref) x2Fault("Z0_RETAINED_CHECKED_APPLICATION_MODEL_REQUIRED");
  const model = parseApplicationModel({ ...await applicationArtifact<Omit<ApplicationActionModel, "ref">>(ctx, row.model_ref, c), ref: row.model_ref });
  const check = parseApplicationCheck({ ...await applicationArtifact<Omit<ApplicationModelCheck, "ref">>(ctx, row.check_ref, c), ref: row.check_ref });
  assertApplicationModelUse(model, check);
  if (!sameX2Ref(model.envelope.originalParentRef, row.original_parent_ref)
    || !row.parent.institutionalProgramRef || !model.envelope.institutional_program_ref
    || !sameX2Ref(model.envelope.institutional_program_ref, row.parent.institutionalProgramRef)
    || !sameX2Ref(model.envelope.resource_grant_ref, row.reservation_ref)
    || !sameX2Ref(model.envelope.checkerRef, check.checkerRef)
    || model.envelope.validUntil !== row.parent.deadlineAt) x2Fault("Z0_INDEPENDENT_MODEL_ORIGINAL_ANCESTRY_REQUIRED");
  return { model, check };
}
async function assertNoUnobservedParentEffect(ctx: PeMutationContext, reservationRef: ExperimentRef, c: PoolClient) {
  const unresolved = await c.query(`SELECT co.consumption_id FROM finnor_os.s5_consumptions co
    JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id)
    JOIN finnor_os.s6_obligation_origins o ON o.tenant_id=co.tenant_id AND o.consumption_id=co.consumption_id
    JOIN finnor_os.business_effects e ON e.tenant_id=o.tenant_id AND e.id=o.effect_id
    WHERE co.tenant_id=$1 AND co.principal_id=$2 AND co.reservation_id=$3
      AND (st.status='UNKNOWN_OUTCOME' OR e.status IN('executing','reconciliation_required'))
    LIMIT 1`, [ctx.auth.tenantId, principal(ctx), reservationRef.id]);
  if (unresolved.rowCount) x2Fault("Z0_ORIGINAL_S6_UNCERTAINTY_MUST_BE_OBSERVED");
}
/** Invoked inside the real X2 publication transaction, not a completion toast. */
export async function acceptInstitutionApplicationModel(ctx: PeMutationContext, row: ApplicationSessionRow,
  proposedModel: ApplicationActionModel, proposedCheck: ApplicationModelCheck,
  execution: Readonly<JobExecutionContext>, c: PoolClient) {
  const origin = await retainedInstitutionApplicationOrigin(ctx, row, c);
  if (!origin) return null;
  await assertApplicationClaim(ctx, row, execution, c);
  await assertInstitutionApplicationOriginCurrent(ctx, origin, row.request as InstitutionalAcquireRequest, c);
  const { model, check } = await retainedModel(ctx, row, c);
  if (x2Digest(model) !== x2Digest(proposedModel) || x2Digest(check) !== x2Digest(proposedCheck)
    || row.status !== "MODEL_READY") x2Fault("Z0_ACTUAL_MODEL_PUBLICATION_REQUIRED");
  await assertNoUnobservedParentEffect(ctx, row.reservation_ref, c);
  const original = await nativeRequestRow(ctx, origin.body.selector.programId, c, true);
  await assertProgramCurrent(ctx, original, c, true);
  const body: InstitutionModelAcceptance = {
    schema: "finnor.s4.institution-application-model-acceptance.v1",
    institutionalOriginRef: origin.ref, originalProgrammeId: original.id, programmeGeneration: original.generation,
    workId: row.work_id, workInputId: row.work_input_id, originalReservationRef: row.reservation_ref,
    deadlineAt: row.parent.deadlineAt, modelRef: model.ref, checkRef: check.ref,
    originalParentRef: row.original_parent_ref, sessionId: row.id, resourceChargeRoot: row.root_consumption_ref,
    completionOwner: "ORIGINAL_P1_AND_INDEPENDENT_CANONICAL_OBSERVER", learnedModelCompletesResponsibility: false,
    newAllowance: false, executionAuthorityGranted: false, protectedAdmission: false,
  };
  const ref = x2Ref("S4", "institution-application-model-acceptance", body);
  await retainApplicationArtifact(ctx, ref, body, false, c, [row.parent.rightsRevision]);
  await applicationEvent(ctx, row, "S4_INSTITUTION_APPLICATION_MODEL_ACCEPTED", {
    acceptanceRef: ref, programmeId: original.id, responsibilityIdentity: origin.body.selector.responsibilityIdentity,
    originalReservationRef: row.reservation_ref, modelRef: model.ref, checkRef: check.ref,
    learnedModelCompletesResponsibility: false, resourceReleaseGranted: false, newAllowance: false,
  }, c);
  await trace(ctx, original, "S4_ORIGINAL_APPLICATION_MODEL_AVAILABLE", {
    acceptanceRef: ref, sessionId: row.id, modelRef: model.ref, checkRef: check.ref,
    originalWorkInputId: row.work_input_id, originalReservationRef: row.reservation_ref,
    responsibilityIdentity: origin.body.selector.responsibilityIdentity, completionClaimed: false, newAllowance: false,
  }, c);
  await enqueueProgram(ctx, original, `x2-model:${row.id}:${check.ref.contentDigest}`, c);
  return ref;
}

/** The actual P1 delivery consumes S4's accepted result before continuing its
 * existing frozen intent. Its ordinary owner and observer alone can fulfill it. */
export async function consumeInstitutionApplicationModels(ctx: PeMutationContext, programId: string, client?: PoolClient) {
  const consume = async (c: PoolClient) => {
    await lockInstitutionApplicationOwners(ctx, c);
    const original = await nativeRequestRow(ctx, programId, c, true);
    if (!isInstitutionRequest(original.request)) return [];
    await assertNoPendingInstitutionApplication(ctx, original.id, c);
    const accepted = (await c.query<{ ref: ExperimentRef; session_id: string }>(`SELECT
      e.body->'detail'->'acceptanceRef' ref,e.session_id::text FROM finnor_os.application_semantics_events e
      JOIN finnor_os.application_semantics_artifacts a ON a.tenant_id=e.tenant_id AND a.principal_id=e.principal_id
        AND a.artifact_id=e.body->'detail'->'acceptanceRef'->>'id'
      WHERE e.tenant_id=$1 AND e.principal_id=$2 AND e.kind='S4_INSTITUTION_APPLICATION_MODEL_ACCEPTED'
        AND a.body->>'originalProgrammeId'=$3 AND (a.body->>'programmeGeneration')::integer=$4
      ORDER BY e.created_at,e.event_id LIMIT 129`,
    [ctx.auth.tenantId, principal(ctx), original.id, original.generation])).rows;
    if (accepted.length > 128) x2Fault("Z0_ORIGINAL_MODEL_ACCEPTANCE_POPULATION_BOUND");
    const refs: ExperimentRef[] = [];
    for (const acceptedModel of accepted) {
      const body = await applicationArtifact<InstitutionModelAcceptance>(ctx, acceptedModel.ref, c);
      if (body.schema !== "finnor.s4.institution-application-model-acceptance.v1"
        || !sameX2Ref(x2Ref("S4", "institution-application-model-acceptance", body), acceptedModel.ref)
        || body.originalProgrammeId !== original.id || body.programmeGeneration !== original.generation
        || body.workId !== original.work_id || body.workInputId !== original.work_input_id
        || !sameX2Ref(body.originalReservationRef, original.request.institution.reservationRef)
        || body.learnedModelCompletesResponsibility !== false) x2Fault("Z0_ORIGINAL_P1_MODEL_CONSUMPTION_SUBSTITUTION");
      const consumed = await c.query(`SELECT id FROM finnor_os.p1_events WHERE tenant_id=$1 AND principal_id=$2
        AND request_id=$3 AND generation=$4 AND kind='P1_ORIGINAL_APPLICATION_MODEL_CONSUMED'
        AND body->'acceptanceRef'=$5::jsonb LIMIT 1`,
      [ctx.auth.tenantId, principal(ctx), original.id, original.generation, JSON.stringify(acceptedModel.ref)]);
      if (!consumed.rowCount) {
        const row = await applicationSession(ctx, acceptedModel.session_id, c);
        const origin = await retainedInstitutionApplicationOrigin(ctx, row, c);
        if (!origin) x2Fault("Z0_ORIGINAL_P1_MODEL_ORIGIN_REQUIRED");
        await assertInstitutionApplicationOriginCurrent(ctx, origin, row.request as InstitutionalAcquireRequest, c);
        const { model, check } = await retainedModel(ctx, row, c);
        if (!sameX2Ref(body.modelRef, model.ref) || !sameX2Ref(body.checkRef, check.ref)) x2Fault("Z0_ORIGINAL_P1_CHECK_CHANGED");
        await assertNoUnobservedParentEffect(ctx, row.reservation_ref, c);
        await trace(ctx, original, "P1_ORIGINAL_APPLICATION_MODEL_CONSUMED", {
          acceptanceRef: acceptedModel.ref, modelRef: model.ref, checkRef: check.ref, sessionId: row.id,
          originalWorkInputId: row.work_input_id, originalReservationRef: row.reservation_ref,
          obligationIdentity: origin.body.selector.responsibilityIdentity,
          independentBusinessObservationStillRequired: true, newAllowance: false,
        }, c);
      }
      refs.push(acceptedModel.ref);
    }
    return refs;
  };
  return client ? consume(client) : tx(ctx, consume);
}

/** Failure/cancellation does not cancel the original responsibility. A lawful
 * direct continuation may spend only the original remaining S5 units. */
export async function returnInstitutionApplicationToOriginal(ctx: PeMutationContext, row: ApplicationSessionRow, c: PoolClient) {
  const origin = await retainedInstitutionApplicationOrigin(ctx, row, c);
  if (!origin) return null;
  if (!["CANCELLED", "FAILED", "STALE", "BLOCKED"].includes(row.status)) return null;
  const unresolved = await c.query(`SELECT id FROM finnor_os.application_semantics_requests
    WHERE tenant_id=$1 AND principal_id=$2 AND parent_id=$3
      AND possible_egress AND status NOT IN('VERIFIED','DENIED') LIMIT 1`,
  [ctx.auth.tenantId, principal(ctx), row.parent_id]);
  if (unresolved.rowCount) return { state: "RETAINED_UNKNOWN", newAllowance: false };
  let original;
  try {
    await assertInstitutionApplicationOriginCurrent(ctx, origin, row.request as InstitutionalAcquireRequest, c);
    original = await nativeRequestRow(ctx, origin.body.selector.programId, c, true);
    await assertProgramCurrent(ctx, original, c, true);
  } catch (error) {
    // A typed stale/deadline refusal is retained. It is not permission to retry
    // against a newer compiler head or acquire another reservation.
    if (!(error instanceof Error) || !/^[A-Z][A-Z0-9_]{1,159}$/.test(error.message)) throw error;
    const reason = error.message;
    await applicationEvent(ctx, row, "S4_ORIGINAL_APPLICATION_FALLBACK_NOT_CURRENT",
      { reason, originalReservationRef: row.reservation_ref, newAllowance: false }, c);
    return { state: "RETAINED_NOT_CURRENT", newAllowance: false };
  }
  await trace(ctx, original, "S4_ORIGINAL_APPLICATION_DIRECT_FALLBACK", {
    sessionId: row.id, applicationStatus: row.status, originalReservationRef: row.reservation_ref,
    originalWorkInputId: row.work_input_id, remainingBudgetRecheckedBy: "ORIGINAL_S5_OWNER",
    responsibilityCompleted: false, newAllowance: false,
  }, c);
  await enqueueProgram(ctx, original, `x2-fallback:${row.id}:${row.generation}`, c);
  return { state: "ORIGINAL_P1_ENQUEUED", newAllowance: false };
}
