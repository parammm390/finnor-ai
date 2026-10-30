import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { ApplicationActionModel, ApplicationModelCheck, ApplicationSnapshot, ApplicationState,
  ApplicationTransitionEvidence, ExperimentRef } from "@finnor/shared-types";
import type { JobExecutionContext } from "../../../../../apps/worker/src/queue";
import type { PeMutationContext } from "@finnor/private-equity/src/types";
import type { ApplicationSessionRow } from "@finnor/private-equity/src/application-semantics/store";
import { applicationArtifact, applicationEvent, applicationSession, currentApplicationWork,
  nativeApplicationProfile, retainApplicationArtifact } from "@finnor/private-equity/src/application-semantics/store";
import { assertApplicationClaim } from "@finnor/private-equity/src/application-semantics/obligations";
import { assertApplicationModelUse } from "@finnor/private-equity/src/application-semantics/checker";
import { ApplicationSnapshotSchema, parseApplicationCheck, parseApplicationModel, parseTransitionEvidence,
  sameApplicationScalar, sameX2Ref, x2Digest, x2Fault, x2Ref, X2RefSchema } from "@finnor/private-equity/src/application-semantics/contracts";
import { assertApplicationComposition, composeApplicationActions } from "@finnor/private-equity/src/application-semantics/composition";
import { projectApplicationSnapshot } from "@finnor/private-equity/src/application-semantics/observation";
import type { PrivateApplicationBinding } from "@finnor/private-equity/src/application-semantics/ports";
import { chargeInstitutionDemand } from "@finnor/private-equity/src/allocation-store";
import { principal, sha, tx } from "@finnor/private-equity/src/evidence-execution/store";
import { assertProgramCurrent, enqueueProgram, nativeRequestRow, trace } from "@finnor/private-equity/src/program-synthesis/store";
import { isInstitutionRequest, type InstitutionHarnessProgram } from "@finnor/private-equity/src/program-synthesis/contracts";
import { frozenDutyExpectation, matchesFrozenInstitutionIntent } from "@finnor/private-equity/src/program-synthesis/duty-observer";
import { assertInstitutionApplicationOriginCurrent, assertNoPendingInstitutionApplication,
  assertInstitutionApplicationDeliveryClaim, lockInstitutionApplicationOwners,
  retainedInstitutionApplicationOrigin, type InstitutionalAcquireRequest } from "./institution-origin";

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

type DutyNode = InstitutionHarnessProgram["nodes"][number];
export interface InstitutionApplicationOwnerInput {
  node: DutyNode; modelUseRef: ExperimentRef | null; acceptanceRef: ExperimentRef | null;
}

async function originalDelivery(ctx: PeMutationContext, programId: string,
  execution: Readonly<JobExecutionContext>, c: PoolClient) {
  await lockInstitutionApplicationOwners(ctx, c);
  const original = await nativeRequestRow(ctx, programId, c, true);
  if (!isInstitutionRequest(original.request) || original.proposed.schema !== "finnor.institution-harness-program.v1") {
    x2Fault("Z0_ORIGINAL_INSTITUTION_P1_REQUIRED");
  }
  await assertInstitutionApplicationDeliveryClaim(ctx, original, execution, c);
  await assertProgramCurrent(ctx, original, c, true);
  await assertNoPendingInstitutionApplication(ctx, original.id, c);
  await assertNoUnobservedParentEffect(ctx, original.request.institution.reservationRef, c);
  return { ...original, request: original.request, proposed: original.proposed };
}

/** This fence is called only after P1 has adopted its real durable claim. */
export async function assertInstitutionApplicationDeliveryCurrent(ctx: PeMutationContext, programId: string,
  execution: Readonly<JobExecutionContext>) {
  await tx(ctx, c => originalDelivery(ctx, programId, execution, c));
}

async function acceptedForDuty(ctx: PeMutationContext, original: Awaited<ReturnType<typeof nativeRequestRow>>,
  node: DutyNode, c: PoolClient) {
  if (original.proposed.schema !== "finnor.institution-harness-program.v1"
    || !original.proposed.nodes.some(frozen => frozen.id === node.id && sha(frozen) === sha(node))) {
    x2Fault("Z0_COMPLETE_ORIGINAL_CHECKED_INTENT_REQUIRED");
  }
  const accepted = (await c.query<{ ref: ExperimentRef; session_id: string }>(`SELECT DISTINCT
      e.body->'detail'->'acceptanceRef' ref,e.session_id::text FROM finnor_os.application_semantics_events e
      JOIN finnor_os.application_semantics_artifacts a ON a.tenant_id=e.tenant_id AND a.principal_id=e.principal_id
        AND a.artifact_id=e.body->'detail'->'acceptanceRef'->>'id'
      JOIN finnor_os.application_semantics_artifacts origin ON origin.tenant_id=a.tenant_id
        AND origin.principal_id=a.principal_id AND origin.artifact_id=a.body->'institutionalOriginRef'->>'id'
      WHERE e.tenant_id=$1 AND e.principal_id=$2 AND e.kind='S4_INSTITUTION_APPLICATION_MODEL_ACCEPTED'
        AND a.body->>'originalProgrammeId'=$3 AND (a.body->>'programmeGeneration')::integer=$4
        AND origin.body->'selector'->>'responsibilityIdentity'=$5 LIMIT 2`,
  [ctx.auth.tenantId, principal(ctx), original.id, original.generation, node.stableIdentity])).rows;
  if (accepted.length > 1) x2Fault("Z0_ORIGINAL_MODEL_ACCEPTANCE_AMBIGUOUS");
  return accepted[0] ?? null;
}

/** Closed argument computation. No external operation is dispatched here. */
function materializeFrozenPayload(node: DutyNode, model: ApplicationActionModel, check: ApplicationModelCheck,
  initial: ApplicationSnapshot, deadlineAt: string) {
  const goal: ApplicationState = {};
  const flatten = (value: unknown, path: string, depth: number): boolean => {
    if (depth > 8 || !path.split(".").every(part => /^[A-Za-z][A-Za-z0-9_]*$/.test(part))) return false;
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      const field = model.stateSchema.find(item => item.path === path);
      if (!field || value === null && !field.nullable
        || typeof value === "string" && !["text", "enum"].includes(field.kind)
        || typeof value === "boolean" && field.kind !== "boolean") return false;
      goal[path] = value;
      return Object.keys(goal).length <= 16;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const entries = Object.entries(value);
    return entries.length > 0 && entries.every(([key, leaf]) => flatten(leaf, path ? `${path}.${key}` : key, depth + 1));
  };
  if (!node.action || !["open_workstream", "create_deal_request", "record_finding"].includes(node.operation)
    || !Object.entries(node.action.payload).every(([key, value]) => flatten(value, key, 1))
    || !Object.keys(goal).length) return { reason: "Z0_MODEL_CANNOT_REPRESENT_COMPLETE_FROZEN_PAYLOAD" } as const;
  const parameters: ApplicationState = {};
  for (const operation of model.operations) for (const assignment of operation.postcondition.assignments) {
    if (assignment.value.kind !== "parameter" || !Object.hasOwn(goal, assignment.field)) continue;
    const name = assignment.value.name, value = goal[assignment.field]!;
    if (Object.hasOwn(parameters, name) && !sameApplicationScalar(parameters[name], value)) {
      return { reason: "Z0_MODEL_FROZEN_PARAMETER_BINDING_AMBIGUOUS" } as const;
    }
    parameters[name] = value;
  }
  if (Object.keys(parameters).length > 16) return { reason: "Z0_MODEL_FROZEN_PARAMETER_BOUND" } as const;
  const composition = composeApplicationActions({ model, check, initial, goal, parameters,
    originalParentRef: model.envelope.originalParentRef, deadlineAt, authorizedRoles: [model.scope.role] });
  if (composition.disposition !== "COMPOSED_WITH_REQUIRED_OBSERVATIONS" || composition.gaps.length) {
    return { reason: "Z0_MODEL_NO_UNCONDITIONAL_FROZEN_ARGUMENT_COMPUTATION" } as const;
  }
  assertApplicationComposition({ composition, model, check, initial });
  const predicted = composition.steps.at(-1)!.expectedState;
  const useful = composition.steps.some(step => model.operations.find(op => op.id === step.operationId)!
    .postcondition.assignments.some(assignment => Object.hasOwn(goal, assignment.field)
      && !sameApplicationScalar(initial.state[assignment.field], goal[assignment.field])));
  if (!useful || !Object.entries(goal).every(([key, value]) =>
    Object.hasOwn(predicted, key) && sameApplicationScalar(predicted[key], value))) {
    return { reason: "Z0_MODEL_DID_NOT_COMPUTE_ORIGINAL_OWNER_ARGUMENT" } as const;
  }
  const rebuild = (value: unknown, path: string): unknown => value !== null && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).map(([key, leaf]) => [key, rebuild(leaf, path ? `${path}.${key}` : key)]))
    : predicted[path];
  const computed: DutyNode = { ...node, action: { ...node.action,
    payload: rebuild(node.action.payload, "") as Record<string, unknown> } };
  if (sha(computed) !== sha(node)) x2Fault("Z0_MODEL_CHANGED_COMPLETE_ORIGINAL_FROZEN_INTENT");
  return { computed, composition } as const;
}

/** Reuse the actual canonical argument on redelivery, not a newly charged
 * materialization with a different reference that the native row never used. */
export function institutionApplicationOwnerInputFromCanonicalAction(node: DutyNode,
  authority: Record<string, unknown>): InstitutionApplicationOwnerInput {
  if (!authority.applicationModelUseRef && !authority.applicationModelAcceptanceRef
    && !authority.applicationModelInputDigest) return { node, modelUseRef: null, acceptanceRef: null };
  const use = X2RefSchema.safeParse(authority.applicationModelUseRef);
  const acceptance = X2RefSchema.safeParse(authority.applicationModelAcceptanceRef);
  if (!use.success || !acceptance.success || authority.applicationModelInputDigest !== sha(node.action)) {
    x2Fault("Z0_CANONICAL_ORIGINAL_MODEL_ARGUMENT_REFERENCE_INVALID");
  }
  return { node, modelUseRef: use.data, acceptanceRef: acceptance.data };
}

async function currentAcceptedModel(ctx: PeMutationContext, original: Awaited<ReturnType<typeof originalDelivery>>,
  node: DutyNode, selected: { ref: ExperimentRef; session_id: string },
  execution: Readonly<JobExecutionContext>, c: PoolClient) {
  const body = await applicationArtifact<InstitutionModelAcceptance>(ctx, selected.ref, c);
  const row = await applicationSession(ctx, selected.session_id, c);
  const origin = await retainedInstitutionApplicationOrigin(ctx, row, c);
  if (!origin || body.schema !== "finnor.s4.institution-application-model-acceptance.v1"
    || !sameX2Ref(x2Ref("S4", "institution-application-model-acceptance", body), selected.ref)
    || !sameX2Ref(body.institutionalOriginRef, origin.ref) || body.sessionId !== row.id
    || origin.body.selector.programId !== original.id || origin.body.selector.responsibilityIdentity !== node.stableIdentity
    || body.originalProgrammeId !== original.id || body.programmeGeneration !== original.generation
    || body.workId !== original.work_id || body.workInputId !== original.work_input_id
    || !sameX2Ref(body.originalReservationRef, original.proposed.reservationRef)
    || !sameX2Ref(body.originalParentRef, row.original_parent_ref) || body.deadlineAt !== row.parent.deadlineAt
    || body.learnedModelCompletesResponsibility !== false || body.executionAuthorityGranted !== false
    || row.status !== "MODEL_READY" || row.cancel_requested_at) x2Fault("Z0_ORIGINAL_P1_MODEL_CONSUMPTION_SUBSTITUTION");
  await assertInstitutionApplicationOriginCurrent(ctx, origin, row.request as InstitutionalAcquireRequest, c, execution);
  await currentApplicationWork(ctx, row, c, false, execution);
  const { model, check } = await retainedModel(ctx, row, c);
  if (!sameX2Ref(body.modelRef, model.ref) || !sameX2Ref(body.checkRef, check.ref)) x2Fault("Z0_ORIGINAL_P1_CHECK_CHANGED");
  for (const operation of model.operations) {
    const validity = (await c.query<{ status: string; current_binding_ref: ExperimentRef }>(
      `SELECT status,current_binding_ref FROM finnor_os.application_operation_validities
       WHERE tenant_id=$1 AND principal_id=$2 AND model_id=$3 AND operation_id=$4 FOR SHARE`,
    [ctx.auth.tenantId, principal(ctx), model.ref.id, operation.id])).rows[0];
    const binding = await applicationArtifact<Omit<PrivateApplicationBinding, "ref">>(ctx, operation.privateBindingRef, c);
    if (validity?.status !== "CURRENT" || !sameX2Ref(validity.current_binding_ref, operation.privateBindingRef)
      || binding.schema !== "finnor.x2.private-application-binding.v1" || binding.operationId !== operation.id
      || !row.profile_ids.includes(binding.profileId)) x2Fault("Z0_ORIGINAL_MODEL_OPERATION_NOT_CURRENT");
    const profile = await nativeApplicationProfile(ctx, binding.profileId);
    if (!sameX2Ref(profile.profile.grantRef, operation.authorization.grantRef)
      || profile.profile.role !== operation.authorization.role || profile.profile.account !== model.scope.account
      || profile.profile.application !== model.scope.application) x2Fault("Z0_ORIGINAL_MODEL_PROFILE_CHANGED");
  }
  return { row, model, check };
}

/** Compute the actual argument for the existing native bridge. A prior trace
 * never skips validation, and materialization alone is not called consumption. */
export async function consumeInstitutionApplicationModels(ctx: PeMutationContext, programId: string,
  execution: Readonly<JobExecutionContext>, node: DutyNode): Promise<InstitutionApplicationOwnerInput> {
  const selection = await tx(ctx, async c => {
    const original = await originalDelivery(ctx, programId, execution, c);
    const accepted = await acceptedForDuty(ctx, original, node, c);
    return accepted ? { accepted, reservationRef: original.proposed.reservationRef } : null;
  });
  if (!selection) return { node, modelUseRef: null, acceptanceRef: null };
  const physicalInvocationId = randomUUID();
  // Commit the real original-owner debit before doing work. A later failure,
  // rollback, redelivery or historical use cannot erase this physical attempt.
  const charged = await chargeInstitutionDemand(ctx, selection.reservationRef, {
    responsibilityIdentity: node.stableIdentity, phase: "PREPARATION", ordinal: 1, units: 1, physicalInvocationId,
  });
  return tx(ctx, async c => {
    const original = await originalDelivery(ctx, programId, execution, c);
    const selected = await acceptedForDuty(ctx, original, node, c);
    if (!selected || !sameX2Ref(selected.ref, selection.accepted.ref)) x2Fault("Z0_ORIGINAL_MODEL_SELECTION_CHANGED");
    const { row, model, check } = await currentAcceptedModel(ctx, original, node, selected, execution, c);
    const evidenceRef = model.actual_independent_outcomes[0];
    if (!evidenceRef || !model.source_observations.some(ref => sameX2Ref(ref, evidenceRef))) {
      x2Fault("Z0_ORIGINAL_INDEPENDENT_MODEL_OBSERVATION_REQUIRED");
    }
    const evidence = parseTransitionEvidence({ ...await applicationArtifact<Omit<ApplicationTransitionEvidence, "ref">>(ctx, evidenceRef, c), ref: evidenceRef });
    if (evidence.independentOutcome !== "ESTABLISHED" || evidence.before.observationQualification !== "LAWFUL_INDEPENDENT_READBACK"
      || !sameX2Ref(evidence.originalParentRef, row.original_parent_ref)) x2Fault("Z0_ORIGINAL_INDEPENDENT_MODEL_OBSERVATION_REQUIRED");
    const initial = ApplicationSnapshotSchema.parse({ ...evidence.before, ...projectApplicationSnapshot(evidence.before, model.stateSchema) });
    const result = materializeFrozenPayload(node, model, check, initial,
      new Date(Math.min(Date.parse(node.deadlineAt), Date.parse(row.parent.deadlineAt))).toISOString());
    if ("reason" in result) {
      await trace(ctx, original, "P1_ORIGINAL_APPLICATION_DIRECT_FALLBACK", {
        reason: result.reason, acceptanceRef: selected.ref, modelRef: model.ref, checkRef: check.ref,
        chargeRef: charged.charge.ref, physicalInvocationId, originalReservationRef: row.reservation_ref,
        originalWorkInputId: row.work_input_id, independentBusinessObservationStillRequired: true, newAllowance: false,
      }, c);
      return { node, modelUseRef: null, acceptanceRef: null };
    }
    const { ref: compositionRef, ...compositionBody } = result.composition;
    await retainApplicationArtifact(ctx, compositionRef, compositionBody, true, c);
    const materialization = {
      schema: "finnor.z0.original-owner-model-materialization.v1",
      originalProgrammeId: original.id, programmeGeneration: original.generation,
      originalWorkId: original.work_id, originalWorkInputId: original.work_input_id,
      obligationIdentity: node.stableIdentity, originalReservationRef: row.reservation_ref,
      acceptanceRef: selected.ref, modelRef: model.ref, checkRef: check.ref, compositionRef,
      initialOriginalEvidenceRef: evidenceRef, derivedInitialDigest: x2Digest(initial),
      ownerInputDigest: sha(result.computed.action), frozenIntentDigest: sha(node.action),
      chargeRef: charged.charge.ref, physicalInvocationId, jobId: execution.jobId, claimFence: execution.claimFence,
      deadlineAt: result.composition.deadlineAt, predictionIsBusinessCompletion: false,
      qualification: "MODEL_RELATIVE_ARGUMENT_COMPUTATION_NOT_EXTERNAL_POSTCONDITION",
      newAllowance: false, executionAuthorityGranted: false,
    } as const;
    const modelUseRef = x2Ref("S4", "institution-application-model-use", materialization);
    await retainApplicationArtifact(ctx, modelUseRef, materialization, false, c, [row.parent.rightsRevision]);
    await trace(ctx, original, "P1_ORIGINAL_APPLICATION_MODEL_MATERIALIZED", { modelUseRef,
      acceptanceRef: selected.ref, compositionRef, ownerInputDigest: materialization.ownerInputDigest,
      physicalInvocationId, chargeRef: charged.charge.ref, consumed: false, completed: false }, c);
    return { node: result.computed, modelUseRef, acceptanceRef: selected.ref };
  });
}

/** Observe the real ordinary bridge's canonical row, never just a candidate
 * CONSUMED label. Its separate independent business observer still owns truth. */
export async function recordInstitutionApplicationModelUse(ctx: PeMutationContext, programId: string,
  execution: Readonly<JobExecutionContext>, input: InstitutionApplicationOwnerInput) {
  if (!input.modelUseRef) return;
  await tx(ctx, async c => {
    const original = await originalDelivery(ctx, programId, execution, c);
    const selected = await acceptedForDuty(ctx, original, input.node, c);
    if (!selected || !input.acceptanceRef || !sameX2Ref(selected.ref, input.acceptanceRef)) {
      x2Fault("Z0_NATIVE_OWNER_MODEL_ACCEPTANCE_CHANGED");
    }
    const current = await currentAcceptedModel(ctx, original, input.node, selected, execution, c);
    const use = await applicationArtifact<{
      schema: string; originalProgrammeId: string; programmeGeneration: number; originalWorkInputId: string;
      ownerInputDigest: string; acceptanceRef: ExperimentRef; modelRef: ExperimentRef; checkRef: ExperimentRef;
      compositionRef: ExperimentRef; chargeRef: ExperimentRef;
    }>(ctx, input.modelUseRef!, c);
    const action = input.node.action;
    frozenDutyExpectation(ctx.auth.tenantId, input.node);
    const actual = action && (await c.query<{ payload: unknown; authority_context: Record<string, unknown> }>(
      `SELECT payload,authority_context FROM finnor_os.domain_actions
       WHERE tenant_id=$1 AND id=$2 AND work_id=$3 AND initiated_by=$4 AND action_type=$5
         AND plan_revision_id=$6 FOR SHARE`,
    [ctx.auth.tenantId, action.expectedEntityId, original.work_id, principal(ctx), input.node.operation, original.plan_revision_id])).rows[0];
    if (use.schema !== "finnor.z0.original-owner-model-materialization.v1" || use.originalProgrammeId !== original.id
      || use.programmeGeneration !== original.generation || use.originalWorkInputId !== original.work_input_id
      || use.ownerInputDigest !== sha(action) || !sameX2Ref(use.acceptanceRef, input.acceptanceRef)
      || !sameX2Ref(use.modelRef, current.model.ref) || !sameX2Ref(use.checkRef, current.check.ref)
      || !actual || actual.authority_context.kind !== "institution_duty" || actual.authority_context.programId !== original.id
      || actual.authority_context.stableIdentity !== input.node.stableIdentity
      || x2Digest(actual.authority_context.applicationModelUseRef) !== x2Digest(input.modelUseRef)
      || actual.authority_context.applicationModelInputDigest !== use.ownerInputDigest
      || !matchesFrozenInstitutionIntent(action!.payload, actual.payload, original.work_id)) {
      x2Fault("Z0_ACTUAL_ORIGINAL_OWNER_ARGUMENT_USE_REQUIRED");
    }
    // Idempotence is after currentness and actual-row checks, never a historical
    // shortcut. A crash after the canonical insert can be recovered in place.
    const prior = await c.query(`SELECT 1 FROM finnor_os.p1_events
      WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3 AND generation=$4
        AND kind='P1_ORIGINAL_APPLICATION_MODEL_CONSUMED' AND body->'modelUseRef'=$5::jsonb
        AND body->>'canonicalActionId'=$6 LIMIT 1`,
    [ctx.auth.tenantId, principal(ctx), original.id, original.generation,
      JSON.stringify(input.modelUseRef), action!.expectedEntityId]);
    if (prior.rowCount) return;
    await trace(ctx, original, "P1_ORIGINAL_APPLICATION_MODEL_CONSUMED", {
      schema: "finnor.z0.original-owner-model-use.v1", modelUseRef: input.modelUseRef,
      acceptanceRef: use.acceptanceRef, modelRef: use.modelRef, checkRef: use.checkRef, compositionRef: use.compositionRef,
      chargeRef: use.chargeRef, canonicalActionId: action!.expectedEntityId, ownerInputDigest: use.ownerInputDigest,
      actualOwner: "ORIGINAL_NATIVE_P1_ACTION_BRIDGE", originalWorkInputId: original.work_input_id,
      independentBusinessObservationStillRequired: true, newAllowance: false, completed: false,
    }, c);
  });
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
