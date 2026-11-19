import { randomInt, randomUUID } from "node:crypto";
import { z } from "zod";
import type { PoolClient } from "pg";
import type { ExperimentRef, TenantContext } from "@finnor/shared-types";
import { canExerciseWorkforceAuthorityTx } from "@finnor/authority";
import type { JobExecutionContext } from "../../../../apps/worker/src/queue";
import { allocationRef } from "../../../epistemic-runtime/src/allocation-contracts";
import { epistemicHash } from "../../../epistemic-runtime/src/source-precedence";
import { W5_ASSIGNMENT_DENOMINATOR, W5TrialUnitSchema, w5TrialRecord, w5AssignmentRecord,
  checkW5ProspectiveTrial, type W5TrialUnit, type W5ProspectiveTrialRecord,
  type W5NativeAssignmentRecord, type W5NativeAssignment } from "../../../epistemic-runtime/src/postz-w5-prospective-trial";
import { analyzeW5RandomizedTaskEffect, W5RandomizedOutcomeSchema, type W5RandomizedOutcome } from "../../../epistemic-runtime/src/postz-w5-randomized-effect";
import { organizationDigest } from "./compiler";
import { OrganizationTransformationError, type OrganizationReference, type OrganizationTransformationProgram } from "./contracts";
import { organizationMethodPins, inspectOrganizationDependenciesTx } from "./dependencies";
import { organizationProcessUse, organizationTrialRegistration, organizationTrialQuery, organizationTrialObservation } from "./native-contracts";
import { readOrganizationEvidenceTx, resolveOrganizationSourcesTx } from "./sources";
import { organizationSelfContractTx, type OrganizationSelfOffer } from "./audience";
import { orgActor, orgAuthority, orgCurrent, orgEnqueue, orgEvent, orgFail, orgLock, orgRow, orgTx,
  principal, rawDigest, type OrganizationRequestRow } from "./store";

const uuid = z.string().uuid(), key = z.string().min(1).max(160), sha = z.string().regex(/^[a-f0-9]{64}$/);
const originalIntent = z.object({
  schema: z.literal("finnor.organization-prospective-trial-intent.v1"), processId: key,
  originalRoleId: key, transformedRoleId: key,
  transformedNumerator: z.number().int().min(1).max(W5_ASSIGNMENT_DENOMINATOR - 1),
  maximumUnits: z.number().int().min(40).max(512),
  atMostOneTrial: z.literal(true), fixedFinalLook: z.literal(true),
}).strict();
const enrollment = z.object({
  schema: z.literal("finnor.organization-prospective-unit.v1"), requestId: uuid, companyId: uuid,
  workId: uuid, workInputId: uuid, workInputDigest: sha, processId: key,
}).strict();
const outcomeInput = z.object({
  schema: z.literal("finnor.organization-prospective-outcome.v1"), requestId: uuid,
  assignmentRef: z.object({ owner: z.string(), id: z.string(), version: z.string(), contentDigest: sha }).strict(),
  workId: uuid, workInputId: uuid, processId: key, arm: z.enum(["ORIGINAL", "TRANSFORMED"]),
  elapsedSeconds: z.number().int().nonnegative().max(2_000_000_000),
  humanSeconds: z.number().int().nonnegative().max(2_000_000_000).nullable(),
  serviceRetained: z.boolean().nullable(), useKey: z.string().min(1).max(240).nullable(),
  observedAt: z.string().datetime({ offset: true }),
}).strict();
interface TrialRow {
  id: string; request_id: string; principal_id: string; evaluator_id: string; process_id: string;
  idempotency_key: string; request_digest: string; trial_ref: ExperimentRef; body: W5ProspectiveTrialRecord["body"];
  body_digest: string; registered_at: Date;
}
interface AssignmentRow {
  id: string; trial_id: string; request_id: string; principal_id: string; evaluator_id: string; performer_id: string;
  work_id: string; work_input_id: string; process_id: string; arm: string; body: W5NativeAssignment;
  assignment_ref: ExperimentRef; body_digest: string; assigned_at: Date;
  job_id: string; delivery_attempt_id: string; claim_fence: string; consumption_id: string;
}
interface TrialUseMailbox {
  assignment_id: string; trial_id: string; request_id: string; principal_id: string; evaluator_id: string;
  performer_id: string; work_id: string; work_input_id: string; process_id: string; role_id: string;
  idempotency_key: string; intent_digest: string; terms_digest: string; packet_ref: OrganizationReference; job_id: string;
}
interface TrialUseAuthorization {
  assignment: W5NativeAssignmentRecord; trialId: string; evaluatorId: string; intentDigest: string; mailbox: TrialUseMailbox | null;
}
export function organizationProcessUseIntentDigest(value: unknown) {
  const input = organizationProcessUse.strip().parse(value);
  return organizationDigest({ requestId: input.requestId, workId: input.workId, processId: input.processId,
    roleId: input.roleId, idempotencyKey: input.idempotencyKey, evidence: input.evidence,
    trialAssignmentRef: input.trialAssignmentRef ?? null });
}
const same = (a: unknown, b: unknown) => epistemicHash(a) === epistemicHash(b);
const methodDigest = () => organizationDigest(organizationMethodPins());
async function physicalTrialClaimTx(ctx: TenantContext, q: OrganizationRequestRow,
  execution: Readonly<JobExecutionContext>, c: PoolClient) {
  if (execution.tenantId !== ctx.tenantId || principal(ctx) !== q.principal_id) orgFail("W5_TRIAL_PHYSICAL_CLAIM_FENCED");
  const claim = (await c.query(`SELECT j.payload,j.lease_expires_at,a.worker_id,clock_timestamp() claim_checked_at
    FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts a ON a.tenant_id=j.tenant_id AND a.job_id=j.id
    WHERE j.tenant_id=$1 AND j.id=$2 AND a.id=$3 AND j.status='running'
    AND j.type='advance_organization_transformation_v1' AND j.protocol_version=1
    AND j.claim_token=$4 AND j.claim_fence=$5 AND j.lease_expires_at>clock_timestamp()
    AND a.claim_token=j.claim_token AND a.claim_fence=j.claim_fence AND a.finished_at IS NULL
    AND a.outcome IN('claimed','running') FOR SHARE OF j,a`,
    [ctx.tenantId, execution.jobId, execution.deliveryAttemptId, execution.claimToken, execution.claimFence])).rows[0];
  if (!claim || claim.worker_id !== execution.workerId || claim.payload.tenantId !== ctx.tenantId ||
      claim.payload.principalId !== q.principal_id || claim.payload.requestId !== q.id || claim.payload.phase !== "ADVANCE")
    orgFail("W5_TRIAL_PHYSICAL_CLAIM_FENCED");
  return claim;
}
function trialRecord(row: TrialRow) {
  const record = w5TrialRecord(row.body), b = record.body;
  if (!same(record.ref, row.trial_ref) || record.ref.contentDigest !== row.body_digest || b.trialId !== row.id ||
      b.requestId !== row.request_id || b.principalId !== row.principal_id || b.evaluatorPrincipalId !== row.evaluator_id ||
      b.processId !== row.process_id || Date.parse(b.registeredAt) !== row.registered_at.getTime())
    orgFail("W5_ORIGINAL_TRIAL_PREIMAGE_CHANGED");
  return record;
}
function assignmentRecord(row: AssignmentRow) {
  const record = w5AssignmentRecord(row.body), b = record.body, p = b.nativeProvenance;
  if (!same(record.ref, row.assignment_ref) || record.ref.contentDigest !== row.body_digest || b.assignmentId !== row.id ||
      b.requestId !== row.request_id || b.principalId !== row.principal_id || b.performerPrincipalId !== row.performer_id ||
      b.unit.workId !== row.work_id || b.unit.workInputId !== row.work_input_id || b.processId !== row.process_id ||
      b.arm !== row.arm || Date.parse(b.assignedAt) !== row.assigned_at.getTime() ||
      p.jobId !== row.job_id || p.deliveryAttemptId !== row.delivery_attempt_id ||
      String(p.claimFence) !== String(row.claim_fence) || p.consumptionRef.id !== row.consumption_id)
    orgFail("W5_ORIGINAL_NATIVE_ASSIGNMENT_PREIMAGE_CHANGED");
  return record;
}
async function assignmentsTx(ctx: TenantContext, trialId: string, c: PoolClient) {
  // These rows are immutable. FOR SHARE would incorrectly apply UPDATE RLS.
  const rows = (await c.query<AssignmentRow>(`SELECT * FROM finnor_os.w5_trial_assignments
    WHERE tenant_id=$1 AND trial_id=$2 ORDER BY work_input_id LIMIT 513`, [ctx.tenantId, trialId])).rows;
  if (rows.length > 512) orgFail("W5_COMPLETE_ORIGINAL_ASSIGNMENT_POPULATION_REQUIRED");
  return rows.map(assignmentRecord);
}
async function lockUnitWriters(c: PoolClient, unitIdentityOnly = false) {
  await c.query(`SELECT set_config('lock_timeout',(CASE WHEN setting::bigint<=0 THEN 1000
    ELSE least(setting::bigint,1000) END)::text||'ms',true) FROM pg_settings WHERE name='lock_timeout'`);
  if (unitIdentityOnly) {
    await c.query("LOCK TABLE finnor_os.work_entity_links,finnor_os.work_inputs IN SHARE MODE");
    return;
  }
  await c.query(`LOCK TABLE finnor_os.work_entity_links,finnor_os.work_inputs,finnor_os.domain_actions,
    finnor_os.business_effects,finnor_os.evidence_sources,
    finnor_os.evidence_source_versions IN SHARE MODE`);
}
async function currentUnitsTx(ctx: TenantContext, q: OrganizationRequestRow,
  units: readonly W5TrialUnit[], processId: string, c: PoolClient) {
  if (new Set(units.map(u => u.workId)).size !== units.length || new Set(units.map(u => u.unitId)).size !== units.length)
    orgFail("W5_UNIQUE_ORIGINAL_TRIAL_UNITS_REQUIRED");
  const rows = (await c.query(`SELECT w.id,w.created_by,w.status,i.id work_input_id,i.input_digest,i.bytes
    FROM finnor_os.works w JOIN LATERAL(SELECT latest.id,
      encode(sha256(convert_to(latest.instruction_text,'UTF8')),'hex') input_digest,
      octet_length(latest.instruction_text) bytes FROM finnor_os.work_inputs latest
      WHERE latest.tenant_id=w.tenant_id AND latest.work_id=w.id ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1) i ON true
    WHERE w.tenant_id=$1 AND w.id=ANY($2::uuid[]) AND EXISTS(SELECT 1 FROM finnor_os.work_entity_links l
      WHERE l.tenant_id=w.tenant_id AND l.work_id=w.id AND l.entity_type='external_organization' AND l.entity_id=$3)
    ORDER BY w.id FOR SHARE OF w`, [ctx.tenantId, units.map(u => u.workId), q.company_id])).rows;
  if (rows.length !== units.length || rows.some(r => r.bytes > 131072) ||
      rows.reduce((n, r) => n + Number(r.bytes), 0) > 8 * 1024 * 1024)
    orgFail("W5_COMPLETE_BOUNDED_REAL_WORK_UNIT_POPULATION_REQUIRED");
  for (const unit of units) {
    const row = rows.find(r => r.id === unit.workId);
    if (!row || row.id === q.work_id || row.created_by !== q.principal_id || ["failed", "cancelled"].includes(row.status) ||
        row.work_input_id !== unit.workInputId || row.input_digest !== unit.workInputDigest || unit.unitId !== unit.workInputId)
      orgFail("W5_ORIGINAL_TRIAL_WORK_INPUT_CHANGED");
    await orgAuthority(ctx, c, unit.workId, false);
    const source = await readOrganizationEvidenceTx(ctx, unit.enrollmentRef, c), parsed = enrollment.safeParse(source.record.body);
    if (!parsed.success || source.record.kind !== "MEASUREMENT" || source.metadata.workId !== unit.workId ||
        source.record.authenticatedPrincipalId !== q.principal_id || source.record.sourceClass !== q.original.sourceClass ||
        parsed.data.requestId !== q.id || parsed.data.companyId !== q.company_id || parsed.data.processId !== processId ||
        parsed.data.workId !== unit.workId || parsed.data.workInputId !== unit.workInputId ||
        parsed.data.workInputDigest !== unit.workInputDigest)
      orgFail("W5_CURRENT_AUTHENTICATED_UNIT_ENROLLMENT_REQUIRED");
  }
}
async function pristineUnitsTx(ctx: TenantContext, units: readonly W5TrialUnit[], c: PoolClient) {
  const ids = units.map(u => u.workId);
  const prior = (await c.query(`SELECT EXISTS(
    SELECT 1 FROM finnor_os.domain_actions WHERE tenant_id=$1 AND work_id=ANY($2::uuid[])
    UNION ALL SELECT 1 FROM finnor_os.business_effects WHERE tenant_id=$1 AND
      (effect#>>'{source,workId}'=ANY($2::text[]) OR effect#>>'{delta,values,workLineage,workId}'=ANY($2::text[]))
    UNION ALL SELECT 1 WHERE finnor_os.w5_trial_units_have_use($2::uuid[]) IS DISTINCT FROM false
    UNION ALL SELECT 1 FROM finnor_os.jobs WHERE tenant_id=$1 AND payload#>>'{processUse,workId}'=ANY($2::text[])
    UNION ALL SELECT 1 FROM finnor_os.w5_trial_outcomes WHERE tenant_id=$1 AND work_id=ANY($2::uuid[])
    UNION ALL SELECT 1 FROM finnor_os.evidence_sources s JOIN finnor_os.evidence_source_versions v
      ON v.tenant_id=s.tenant_id AND v.source_id=s.id WHERE s.tenant_id=$1
      AND s.source_type='organization_authenticated_record' AND
      (s.metadata->>'workId'=ANY($2::text[]) OR v.content::jsonb->'body'->>'workId'=ANY($2::text[]))
      AND (v.content::jsonb->>'kind'='OPERATING_OBSERVATION' OR
        v.content::jsonb->>'schema'='finnor.organization-prepared-packet.v1')) present`, [ctx.tenantId, ids])).rows[0];
  if (prior?.present) orgFail("W5_ENROLLMENT_OR_ASSIGNMENT_AFTER_OBSERVATION_USE_OR_EFFECT_FORBIDDEN");
}
function trialGraph(q: OrganizationRequestRow, program: OrganizationTransformationProgram, trial: W5ProspectiveTrialRecord) {
  const b = trial.body, alternative = program.alternatives.find(a => a.id === program.selectedAlternativeId);
  const originalTrial = q.original.mandate.trial;
  const originalRole = q.original.organization.roles.find(r => r.id === b.originalRoleId);
  const transformedRole = alternative?.roles.find(r => r.id === b.transformedRoleId);
  const process = alternative?.processes.find(p => p.id === b.processId);
  if (!alternative || alternative.kind === "RETAIN" || !["TRIAL", "ACTIVE"].includes(program.status) ||
      alternative.id !== b.selectedAlternativeId || organizationDigest(alternative) !== b.selectedAlternativeDigest ||
      q.original_digest !== b.originalDigest || q.id !== b.requestId || q.work_id !== b.parentWorkId ||
      q.work_input_id !== b.parentWorkInputId || q.principal_id !== b.principalId || q.tenant_id !== b.tenantId ||
      q.original.mandate.originalDeadline !== b.originalDeadline || q.original.sourceClass !== b.sourceClass ||
      q.original.mandate.evaluatorPrincipalId !== b.evaluatorPrincipalId || originalTrial.kind !== "PARALLEL_RANDOMIZED" ||
      !same(originalTrial.assignmentRef, b.originalAssignmentIntentRef) ||
      !same(b.analysis, { kind: "BOUNDED_HT_HOEFFDING_FIXED_FINAL_LOOK", outcomeRangeSeconds: originalTrial.outcomeRangeSeconds,
        confidence: originalTrial.confidence, minimumPerArm: originalTrial.minimumPerArm,
        materialMarginSeconds: q.original.mandate.materialImprovementSeconds, interference: originalTrial.interference,
        carryover: originalTrial.carryover }) ||
      !same(q.budget.ref, b.originalBudgetRef) || !same(q.budget.reservationRef, b.originalReservationRef) ||
      b.methodPinsDigest !== methodDigest() || b.registeredRevision > program.revision ||
      !originalRole || originalRole.principalId !== b.originalPrincipalId ||
      !transformedRole || transformedRole.principalId !== b.transformedPrincipalId ||
      !q.original.organization.processes.find(p => p.id === b.processId)?.nodes.some(n =>
        n.kind === "PREPARE" && !n.mandatory && n.roleId === b.originalRoleId) ||
      !process || !alternative.constructedAssets.some(a => a.processId === b.processId &&
        process.nodes.some(n => n.id === a.nodeId && n.roleId === b.transformedRoleId)) ||
      [b.originalRoleId, b.transformedRoleId].some(id => {
        const role = alternative.roles.find(r => r.id === id), adoption = program.adoptions.find(a => a.roleId === id);
        return !role || adoption?.state !== "ADOPTED" || adoption.termsDigest !== organizationDigest({ alternativeId: alternative.id, role });
      })) orgFail("W5_ORIGINAL_EXACT_ADOPTED_TRIAL_GRAPH_REQUIRED");
}
async function currentTrialIntentTx(ctx: TenantContext, q: OrganizationRequestRow, c: PoolClient,
  trial?: W5ProspectiveTrialRecord) {
  const source = await readOrganizationEvidenceTx(ctx, q.original.mandate.trial.assignmentRef, c);
  const intent = originalIntent.parse(source.record.body);
  if (source.record.kind !== "MEASUREMENT" || source.record.authenticatedPrincipalId !== q.principal_id ||
      source.record.sourceClass !== q.original.sourceClass || trial &&
      (trial.body.processId !== intent.processId || trial.body.originalRoleId !== intent.originalRoleId ||
        trial.body.transformedRoleId !== intent.transformedRoleId || trial.body.units.length > intent.maximumUnits ||
        trial.body.assignment.transformedNumerator !== intent.transformedNumerator ||
        source.created_at.getTime() > Date.parse(trial.body.registeredAt)))
    orgFail("W5_ORIGINAL_PREREGISTERED_TRIAL_INTENT_REQUIRED");
  return intent;
}

/** Freeze the complete prospective roster. Only the existing metered worker
 * draws entropy; HTTP callers cannot supply arms, draws, seeds or a new budget. */
export async function registerOrganizationTrial(ctx: TenantContext, value: unknown) {
  const input = organizationTrialRegistration.parse(value), digest = organizationDigest(input);
  return orgTx(ctx, async c => {
    await orgLock(ctx, c); await orgActor(ctx, c, true);
    const q = await orgRow(ctx, input.requestId, c, true);
    await orgCurrent(ctx, q, c);
    const existing = (await c.query<TrialRow>("SELECT * FROM finnor_os.w5_trials WHERE tenant_id=$1 AND request_id=$2",
      [ctx.tenantId, q.id])).rows[0];
    if (existing) {
      trialRecord(existing);
      if (existing.idempotency_key !== input.idempotencyKey || existing.request_digest !== digest)
        orgFail("W5_ORIGINAL_TRIAL_CANNOT_BE_REPLACED_OR_REASSIGNED");
      return { requestId: q.id, trialRef: existing.trial_ref, semanticReplay: true,
        assignmentStatus: "READ_ORIGINAL_COMMITTED_ASSIGNMENT", executionAuthorityGranted: false };
    }
    if (!q.program || q.revision !== input.expectedRevision || q.original.mandate.trial.kind !== "PARALLEL_RANDOMIZED")
      orgFail("W5_CURRENT_PROSPECTIVE_RANDOMIZED_PROGRAM_REQUIRED");
    await resolveOrganizationSourcesTx(ctx, q.original, c);
    if ((await inspectOrganizationDependenciesTx(ctx, q, c)).status !== "CURRENT") orgFail("W5_CURRENT_TRIAL_DEPENDENCIES_REQUIRED");
    const intent = await currentTrialIntentTx(ctx, q, c);
    if (input.units.length > intent.maximumUnits || input.units.length < q.original.mandate.trial.minimumPerArm * 2)
      orgFail("W5_ORIGINAL_PREREGISTERED_TRIAL_INTENT_REQUIRED");
    await lockUnitWriters(c);
    const ids = input.units.map(u => u.workId);
    const occupied = (await c.query(`SELECT 1 FROM finnor_os.w5_trial_units
      WHERE tenant_id=$1 AND work_id=ANY($2::uuid[]) LIMIT 1`, [ctx.tenantId, ids])).rowCount;
    if (occupied) orgFail("W5_ORIGINAL_WORK_ALREADY_PERMANENTLY_ENROLLED");
    const units: W5TrialUnit[] = [];
    for (const unit of input.units) {
      const s = await readOrganizationEvidenceTx(ctx, unit.enrollmentRef, c), body = enrollment.parse(s.record.body);
      units.push(W5TrialUnitSchema.parse({ unitId: unit.workInputId, ...unit, workInputDigest: body.workInputDigest }));
    }
    units.sort((a, b) => a.unitId.localeCompare(b.unitId));
    await currentUnitsTx(ctx, q, units, intent.processId, c); await pristineUnitsTx(ctx, units, c);
    const alternative = q.program.alternatives.find(a => a.id === q.program!.selectedAlternativeId);
    const originalRole = q.original.organization.roles.find(r => r.id === intent.originalRoleId);
    const transformedRole = alternative?.roles.find(r => r.id === intent.transformedRoleId);
    if (!alternative || !originalRole || !transformedRole) orgFail("W5_EXACT_ORIGINAL_AND_TRANSFORMED_ROLES_REQUIRED");
    const registeredAt = (await c.query("SELECT clock_timestamp() at")).rows[0].at.toISOString();
    const trial = w5TrialRecord({ schema: "finnor.s2.w5-prospective-trial.v1", trialId: randomUUID(),
      tenantId: ctx.tenantId, principalId: q.principal_id, requestId: q.id, parentWorkId: q.work_id,
      parentWorkInputId: q.work_input_id, originalDigest: q.original_digest,
      originalBudgetRef: q.budget.ref, originalReservationRef: q.budget.reservationRef, methodPinsDigest: methodDigest(),
      processId: intent.processId, originalRoleId: originalRole.id, originalPrincipalId: originalRole.principalId,
      transformedRoleId: transformedRole.id, transformedPrincipalId: transformedRole.principalId,
      evaluatorPrincipalId: q.original.mandate.evaluatorPrincipalId, selectedAlternativeId: alternative.id,
      selectedAlternativeDigest: organizationDigest(alternative), registeredRevision: q.revision,
      originalAssignmentIntentRef: q.original.mandate.trial.assignmentRef, registeredAt,
      originalDeadline: q.original.mandate.originalDeadline, sourceClass: q.original.sourceClass,
      assignment: { kind: "INDEPENDENT_BERNOULLI", transformedNumerator: intent.transformedNumerator,
        denominator: W5_ASSIGNMENT_DENOMINATOR, entropy: "NODE_CRYPTO_RANDOMINT" },
      analysis: { kind: "BOUNDED_HT_HOEFFDING_FIXED_FINAL_LOOK", outcomeRangeSeconds: q.original.mandate.trial.outcomeRangeSeconds,
        confidence: q.original.mandate.trial.confidence, minimumPerArm: q.original.mandate.trial.minimumPerArm,
        materialMarginSeconds: q.original.mandate.materialImprovementSeconds, interference: q.original.mandate.trial.interference,
        carryover: q.original.mandate.trial.carryover }, units, scientificAdmission: "NOT_ESTABLISHED", executionAuthorityGranted: false });
    trialGraph(q, q.program, trial);
    const b = trial.body;
    await c.query(`INSERT INTO finnor_os.w5_trials(tenant_id,id,request_id,principal_id,evaluator_id,process_id,
      idempotency_key,request_digest,trial_ref,body,body_digest,registered_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12)`,
      [ctx.tenantId, b.trialId, q.id, q.principal_id, b.evaluatorPrincipalId, b.processId, input.idempotencyKey,
        digest, JSON.stringify(trial.ref), JSON.stringify(b), trial.ref.contentDigest, registeredAt]);
    for (const unit of units) await c.query(`INSERT INTO finnor_os.w5_trial_units(tenant_id,trial_id,request_id,principal_id,
      evaluator_id,original_performer_id,transformed_performer_id,unit_id,work_id,work_input_id,work_input_digest,body,registered_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)`,
      [ctx.tenantId, b.trialId, q.id, q.principal_id, b.evaluatorPrincipalId, b.originalPrincipalId, b.transformedPrincipalId,
        unit.unitId, unit.workId, unit.workInputId, unit.workInputDigest, JSON.stringify(unit), registeredAt]);
    await orgEvent(ctx, q, "PROSPECTIVE_TRIAL_REGISTERED", "trial:" + b.trialId, {
      trialRef: trial.ref, unitCount: units.length, requestDigest: digest, callerEntropyOrArmsAccepted: false }, c);
    const jobId = await orgEnqueue(ctx, q, "ADVANCE", "trial:" + b.trialId, c);
    return { requestId: q.id, trialRef: trial.ref, registeredUnitCount: units.length, jobId,
      assignmentStatus: "QUEUED_REQUIRES_ORIGINAL_S5_PHYSICAL_CLAIM", semanticReplay: false, executionAuthorityGranted: false };
  });
}

/** Called within the real worker's fenced, originally budgeted transaction.
 * This independently checks its actual physical claim and committed S5 use. */
export async function assignPendingOrganizationTrialsTx(ctx: TenantContext, q: OrganizationRequestRow,
  program: OrganizationTransformationProgram, execution: Readonly<JobExecutionContext>,
  consumptionRef: ExperimentRef, c: PoolClient) {
  const rows = (await c.query<TrialRow>("SELECT * FROM finnor_os.w5_trials WHERE tenant_id=$1 AND request_id=$2 LIMIT 2",
    [ctx.tenantId, q.id])).rows;
  if (rows.length > 1) orgFail("W5_SINGLE_REGISTERED_FINAL_LOOK_REQUIRED");
  for (const row of rows) {
    const trial = trialRecord(row), existing = await assignmentsTx(ctx, row.id, c);
    if (existing.length) {
      if (checkW5ProspectiveTrial(trial, existing).status !== "CHECKED_NATIVE_ASSIGNMENT")
        orgFail("W5_PARTIAL_OR_CHANGED_ASSIGNMENT_CANNOT_BE_REPLACED");
      continue;
    }
    if (!["TRIAL", "ACTIVE"].includes(program.status)) {
      await orgEvent(ctx, q, "UNASSIGNED_TRIAL_RETAINED_WITHOUT_NEW_EPISODE", "trial-retained:" + row.id,
        { trialRef: trial.ref, originalUnitsRetained: true, assignmentAuthorityGranted: false }, c);
      continue;
    }
    trialGraph(q, program, trial);
    await currentTrialIntentTx(ctx, q, c, trial);
    if ((await inspectOrganizationDependenciesTx(ctx, q, c)).status !== "CURRENT") orgFail("W5_CURRENT_TRIAL_DEPENDENCIES_REQUIRED");
    await physicalTrialClaimTx(ctx, q, execution, c);
    const accepted = (await c.query(`SELECT body,body_digest FROM finnor_os.w5_events
      WHERE tenant_id=$1 AND request_id=$2 AND event_key=$3 AND kind='NATIVE_COMPUTE_ACCEPTED'`,
      [ctx.tenantId, q.id, "accepted:" + execution.deliveryAttemptId])).rows[0];
    const consumed = (await c.query(`SELECT body,principal_id,reservation_id FROM finnor_os.s5_consumptions
      WHERE tenant_id=$1 AND consumption_id=$2 FOR SHARE`, [ctx.tenantId, consumptionRef.id])).rows[0];
    const { ref: nativeRef, ...nativeBody } = consumed?.body ?? {};
    if (!accepted || accepted.body_digest !== organizationDigest(accepted.body) ||
        accepted.body.jobId !== execution.jobId || accepted.body.claimFence !== execution.claimFence ||
        !same(accepted.body.consumptionRef, consumptionRef) || !same(accepted.body.originalBudgetRef, q.budget.ref) ||
        !consumed || consumed.principal_id !== q.principal_id || consumed.reservation_id !== q.budget.reservationRef.id ||
        nativeBody.schema !== "finnor.s5.workforce-consumption.v1" || nativeBody.nodeId !== q.budget.programmeId ||
        !same(nativeRef, consumptionRef) || !same(nativeRef, allocationRef("S5", "workforce-consumption", nativeBody, "s5-workforce-v1")))
      orgFail("W5_TRIAL_ORIGINAL_S5_ACCEPTANCE_REQUIRED");
    await lockUnitWriters(c);
    const enrolled = (await c.query(`SELECT body FROM finnor_os.w5_trial_units
      WHERE tenant_id=$1 AND trial_id=$2 ORDER BY unit_id LIMIT 513`, [ctx.tenantId, row.id])).rows;
    if (enrolled.length !== trial.body.units.length || !same(enrolled.map(r => r.body), trial.body.units))
      orgFail("W5_COMPLETE_IMMUTABLE_ENROLLMENT_POPULATION_REQUIRED");
    await currentUnitsTx(ctx, q, trial.body.units, trial.body.processId, c);
    await pristineUnitsTx(ctx, trial.body.units, c);
    const claim = await physicalTrialClaimTx(ctx, q, execution, c);
    const nativeProvenance = { jobId: execution.jobId, deliveryAttemptId: execution.deliveryAttemptId,
      claimFence: execution.claimFence, workerId: execution.workerId, claimTokenDigest: rawDigest(execution.claimToken),
      claimCheckedAt: claim.claim_checked_at.toISOString(), claimLeaseExpiresAt: claim.lease_expires_at.toISOString(),
      consumptionRef, originalBudgetRef: q.budget.ref, methodPinsDigest: methodDigest() };
    const assignedAt = (await c.query("SELECT clock_timestamp() at")).rows[0].at.toISOString();
    const assignments = trial.body.units.map(unit => {
      const nativeDraw = randomInt(W5_ASSIGNMENT_DENOMINATOR), transformed = nativeDraw < trial.body.assignment.transformedNumerator;
      return w5AssignmentRecord({ schema: "finnor.s2.w5-native-assignment.v1", assignmentId: randomUUID(),
        trialRef: trial.ref, tenantId: ctx.tenantId, principalId: q.principal_id, requestId: q.id, unit,
        processId: trial.body.processId, selectedAlternativeDigest: trial.body.selectedAlternativeDigest,
        arm: transformed ? "TRANSFORMED" : "ORIGINAL", performerRoleId: transformed ? trial.body.transformedRoleId : trial.body.originalRoleId,
        performerPrincipalId: transformed ? trial.body.transformedPrincipalId : trial.body.originalPrincipalId,
        transformedNumerator: trial.body.assignment.transformedNumerator, denominator: W5_ASSIGNMENT_DENOMINATOR,
        nativeDraw, entropy: "NODE_CRYPTO_RANDOMINT", assignedAt, nativeProvenance,
        qualifier: "NATIVE_PROSPECTIVE_RANDOMIZATION_NOT_SCIENTIFIC_OR_FIELD_ADMISSION", executionAuthorityGranted: false });
    });
    const checked = checkW5ProspectiveTrial(trial, assignments);
    if (checked.status !== "CHECKED_NATIVE_ASSIGNMENT") orgFail("W5_INDEPENDENT_NATIVE_ASSIGNMENT_CHECK_FAILED");
    for (const record of assignments) {
      const a = record.body;
      await c.query(`INSERT INTO finnor_os.w5_trial_assignments(tenant_id,id,trial_id,request_id,principal_id,evaluator_id,
        performer_id,work_id,work_input_id,process_id,arm,assignment_ref,body,body_digest,assigned_at,job_id,delivery_attempt_id,claim_fence,consumption_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15,$16,$17,$18,$19)`,
        [ctx.tenantId, a.assignmentId, row.id, q.id, q.principal_id, trial.body.evaluatorPrincipalId, a.performerPrincipalId,
          a.unit.workId, a.unit.workInputId, a.processId, a.arm, JSON.stringify(record.ref), JSON.stringify(a),
          record.ref.contentDigest, assignedAt, execution.jobId, execution.deliveryAttemptId, execution.claimFence, consumptionRef.id]);
    }
    await orgEvent(ctx, q, "PROSPECTIVE_NATIVE_ASSIGNMENTS_COMMITTED", "trial-assigned:" + row.id,
      { trialRef: trial.ref, assignmentRefs: assignments.map(a => a.ref), nativeProvenance, checked,
        fullCostOrFieldBenefitEstablished: false }, c);
  }
}

async function currentAssignedUnitTx(ctx: TenantContext, a: W5NativeAssignment, c: PoolClient, writerFence = true) {
  // A row lock on the old input cannot fence an appended latest input.
  if (writerFence) await lockUnitWriters(c, true);
  const source = await readOrganizationEvidenceTx(ctx, a.unit.enrollmentRef, c), enrolled = enrollment.parse(source.record.body);
  if (source.record.schema !== "finnor.organization-authenticated-source.v1" || source.record.kind !== "MEASUREMENT" ||
      source.record.authenticatedPrincipalId !== a.principalId || source.metadata.workId !== a.unit.workId ||
      enrolled.requestId !== a.requestId || enrolled.workId !== a.unit.workId ||
      enrolled.workInputId !== a.unit.workInputId || enrolled.workInputDigest !== a.unit.workInputDigest ||
      enrolled.processId !== a.processId) orgFail("W5_CURRENT_ORIGINAL_ASSIGNED_ENROLLMENT_REQUIRED");
  const latest = (await c.query(`SELECT w.created_by,w.status,i.id,i.digest FROM finnor_os.works w
    JOIN LATERAL(SELECT id,encode(sha256(convert_to(instruction_text,'UTF8')),'hex') digest
      FROM finnor_os.work_inputs WHERE tenant_id=w.tenant_id AND work_id=w.id ORDER BY created_at DESC,id DESC LIMIT 1) i ON true
    WHERE w.tenant_id=$1 AND w.id=$2 AND EXISTS(SELECT 1 FROM finnor_os.work_entity_links l
      WHERE l.tenant_id=w.tenant_id AND l.work_id=w.id AND l.entity_type='external_organization' AND l.entity_id=$3)
    FOR SHARE OF w`, [ctx.tenantId, a.unit.workId, enrolled.companyId])).rows[0];
  if (!latest || latest.created_by !== a.principalId || ["failed", "cancelled"].includes(latest.status) ||
      latest.id !== a.unit.workInputId || latest.digest !== a.unit.workInputDigest)
    orgFail("W5_ASSIGNED_ORIGINAL_WORK_INPUT_CHANGED");
}

/** A committed original-arm or pending unit is not a transformed-use permit.
 * The worker passes the authenticated packet author, never a caller override. */
export async function assertOrganizationTrialProcessUseTx(ctx: TenantContext,
  input: z.infer<typeof organizationProcessUse>, parentWorkId: string, c: PoolClient,
  authenticatedPrincipalId = principal(ctx),
  publication?: { jobId: string; packetRef: OrganizationReference; termsDigest: string }): Promise<TrialUseAuthorization | null> {
  if (!await canExerciseWorkforceAuthorityTx(ctx, { operation: "query", capability: "query:work",
    workId: input.workId, resource: { type: "work", id: input.workId }, risk: "low" }, c) ||
      !(await c.query("SELECT id FROM finnor_os.works WHERE tenant_id=$1 AND id=$2",
        [ctx.tenantId, input.workId])).rows[0])
    orgFail("W5_PROCESS_INPUT_WORK_AUTHORITY_REQUIRED", 403);
  const reserved = (await c.query<{ reserved: boolean }>("SELECT finnor_os.w5_trial_unit_reserved($1) reserved",
    [input.workId])).rows[0]?.reserved;
  const unit = (await c.query(`SELECT trial_id,request_id,body FROM finnor_os.w5_trial_units
    WHERE tenant_id=$1 AND work_id=$2`, [ctx.tenantId, input.workId])).rows[0];
  if (!unit) {
    if (input.trialAssignmentRef) orgFail("W5_ORIGINAL_ARM_OR_WRONG_ASSIGNMENT_TRANSFORMED_USE_FORBIDDEN");
    if (reserved !== false) orgFail("W5_COMMITTED_ORIGINAL_TRIAL_ASSIGNMENT_REQUIRED");
    return null;
  }
  const row = (await c.query<AssignmentRow>(`SELECT * FROM finnor_os.w5_trial_assignments
    WHERE tenant_id=$1 AND work_id=$2`, [ctx.tenantId, input.workId])).rows[0];
  if (!row && input.trialAssignmentRef) orgFail("W5_ORIGINAL_ARM_OR_WRONG_ASSIGNMENT_TRANSFORMED_USE_FORBIDDEN");
  if (!row || unit.request_id !== input.requestId || row.trial_id !== unit.trial_id || !input.trialAssignmentRef)
    orgFail("W5_PENDING_OR_OTHER_TRIAL_UNIT_CANNOT_ENTER_TRANSFORMED_USE");
  const record = assignmentRecord(row), a = record.body;
  if (!same(record.ref, input.trialAssignmentRef) || !same(a.unit, unit.body) ||
      a.arm !== "TRANSFORMED" || a.requestId !== input.requestId || a.tenantId !== ctx.tenantId ||
      a.processId !== input.processId || a.performerRoleId !== input.roleId || a.performerPrincipalId !== authenticatedPrincipalId)
    orgFail("W5_ORIGINAL_ARM_OR_WRONG_ASSIGNMENT_TRANSFORMED_USE_FORBIDDEN");
  await currentAssignedUnitTx(ctx, a, c);
  const actor = (await c.query("SELECT role,status FROM finnor_os.users WHERE tenant_id=$1 AND id=$2 FOR SHARE",
    [ctx.tenantId, authenticatedPrincipalId])).rows[0];
  if (!actor || actor.status !== "active") orgFail("W5_CURRENT_ASSIGNED_PERFORMER_REQUIRED");
  // Read-only canonical checks of the packet's actual authenticated author.
  // This neither executes as that principal nor creates a grant.
  const performer: TenantContext = { tenantId: ctx.tenantId, userId: authenticatedPrincipalId,
    employeeId: authenticatedPrincipalId, role: actor.role };
  if (!await canExerciseWorkforceAuthorityTx(performer, { operation: "query", capability: "query:work",
    workId: input.workId, resource: { type: "work", id: input.workId }, risk: "low" }, c) ||
      !await canExerciseWorkforceAuthorityTx(performer, { operation: "action", capability: "action:workforce_respond_contract",
        workId: parentWorkId, resource: { type: "workforce_assignment", id: input.requestId + ":" + input.roleId }, risk: "low" }, c))
    orgFail("W5_CURRENT_ASSIGNED_PERFORMER_AUTHORITY_REQUIRED", 403);
  const intentDigest = organizationProcessUseIntentDigest(input);
  const mailbox = (await c.query<TrialUseMailbox>(`SELECT * FROM finnor_os.w5_trial_use_mailboxes
    WHERE tenant_id=$1 AND assignment_id=$2`, [ctx.tenantId, a.assignmentId])).rows[0] ?? null;
  if (mailbox && (mailbox.assignment_id !== a.assignmentId || mailbox.trial_id !== row.trial_id ||
      mailbox.request_id !== a.requestId || mailbox.principal_id !== a.principalId || mailbox.evaluator_id !== row.evaluator_id ||
      mailbox.performer_id !== a.performerPrincipalId || mailbox.work_id !== a.unit.workId ||
      mailbox.work_input_id !== a.unit.workInputId || mailbox.process_id !== a.processId ||
      mailbox.role_id !== a.performerRoleId || mailbox.idempotency_key !== input.idempotencyKey ||
      mailbox.intent_digest !== intentDigest))
    orgFail("W5_ASSIGNED_UNIT_ORIGINAL_MAILBOX_CANNOT_BE_REPLACED");
  if (publication && (!mailbox || mailbox.job_id !== publication.jobId ||
      mailbox.terms_digest !== publication.termsDigest || !same(mailbox.packet_ref, publication.packetRef)))
    orgFail("W5_PHYSICAL_USE_REQUIRES_ORIGINAL_ASSIGNED_MAILBOX_JOB_AND_PACKET");
  const conflict = (await c.query<{ conflict: boolean }>("SELECT finnor_os.w5_trial_mailbox_conflict($1) conflict",
    [a.assignmentId])).rows[0]?.conflict;
  if (conflict !== false) orgFail("W5_ASSIGNED_UNIT_DUPLICATE_OR_FOREIGN_USE_FORBIDDEN");
  return { assignment: record, trialId: row.trial_id, evaluatorId: row.evaluator_id, intentDigest, mailbox };
}

/** Appended atomically with the genuine S1 packet and its one queued job.
 * Failed/UNKNOWN jobs never free this original semantic intent. */
export async function reserveOrganizationTrialUseMailboxTx(ctx: TenantContext, authorization: TrialUseAuthorization,
  idempotencyKey: string, termsDigest: string, packetRef: OrganizationReference, jobId: string, c: PoolClient) {
  const a = authorization.assignment.body;
  if (authorization.mailbox || principal(ctx) !== a.performerPrincipalId)
    orgFail("W5_ORIGINAL_SELF_ASSIGNED_MAILBOX_REQUIRED");
  await c.query(`INSERT INTO finnor_os.w5_trial_use_mailboxes(tenant_id,assignment_id,trial_id,request_id,principal_id,
    evaluator_id,performer_id,work_id,work_input_id,process_id,role_id,idempotency_key,intent_digest,terms_digest,packet_ref,job_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16)`,
    [ctx.tenantId, a.assignmentId, authorization.trialId, a.requestId, a.principalId, authorization.evaluatorId,
      a.performerPrincipalId, a.unit.workId, a.unit.workInputId, a.processId, a.performerRoleId, idempotencyKey,
      authorization.intentDigest, termsDigest, JSON.stringify(packetRef), jobId]);
}

export async function readOrganizationTrial(ctx: TenantContext, value: unknown) {
  const input = organizationTrialQuery.parse(value);
  return orgTx(ctx, async c => {
    const actor = await orgActor(ctx, c);
    await orgLock(ctx, c);
    const row = (await c.query<TrialRow>("SELECT * FROM finnor_os.w5_trials WHERE tenant_id=$1 AND request_id=$2",
      [ctx.tenantId, input.requestId])).rows[0];
    if (input.audience !== "SELF" && row && (row.principal_id === principal(ctx) && actor.role === "owner" && ctx.role === "owner" ||
        row.evaluator_id === principal(ctx))) {
      const trial = trialRecord(row);
      if (row.principal_id === principal(ctx)) {
        const q = await orgRow(ctx, input.requestId, c);
        await orgAuthority(ctx, c, q.work_id, false);
      }
      for (const unit of trial.body.units) await orgAuthority(ctx, c, unit.workId, false);
      const assignments = await assignmentsTx(ctx, row.id, c);
      const outcomes = (await c.query(`SELECT assignment_id FROM finnor_os.w5_trial_outcomes
        WHERE tenant_id=$1 AND trial_id=$2 ORDER BY assignment_id LIMIT 513`, [ctx.tenantId, row.id])).rows;
      if (outcomes.length > 512) orgFail("W5_COMPLETE_ORIGINAL_OUTCOME_POPULATION_REQUIRED");
      return { access: row.evaluator_id === principal(ctx) ? "EVALUATOR" : "OWNER", requestId: input.requestId,
        trial, assignments, observedAssignmentIds: outcomes.map(o => o.assignment_id),
        assignmentCheck: checkW5ProspectiveTrial(trial, assignments),
        nativeProvenanceRequiresOwningEvaluation: true, executionAuthorityGranted: false, fieldBenefitEstablished: false };
    }
    const assignments = (await c.query<AssignmentRow>(`SELECT * FROM finnor_os.w5_trial_assignments
      WHERE tenant_id=$1 AND request_id=$2 AND performer_id=$3 ORDER BY work_input_id LIMIT 513`,
      [ctx.tenantId, input.requestId, principal(ctx)])).rows;
    if (assignments.length > 512) orgFail("W5_SELF_ASSIGNMENT_PROFILE_BOUND");
    const own: W5NativeAssignmentRecord[] = [];
    for (const assignment of assignments) {
      const record = assignmentRecord(assignment), a = record.body;
      const offer = (await c.query<OrganizationSelfOffer>(`SELECT * FROM finnor_os.w5_role_offers
        WHERE tenant_id=$1 AND request_id=$2 AND role_id=$3 AND participant_id=$4`,
        [ctx.tenantId, input.requestId, a.performerRoleId, principal(ctx)])).rows[0];
      if (!offer || (await organizationSelfContractTx(ctx, offer, c)).status !== "CURRENT")
        return { access: "PARTICIPANT", requestId: input.requestId, assignments: [], currentness: "INVALIDATED",
          mailboxes: [], parentPrivateDataDisclosed: false, executionAuthorityGranted: false };
      await orgAuthority(ctx, c, a.unit.workId, false);
      // Advisory read snapshot only; actual submission/publication fence the
      // complete input/link writers and revalidate before any new effect.
      try { await currentAssignedUnitTx(ctx, a, c, false); }
      catch (error) {
        if (!(error instanceof OrganizationTransformationError)) throw error;
        return { access: "PARTICIPANT", requestId: input.requestId, assignments: [], currentness: "INVALIDATED",
          mailboxes: [], parentPrivateDataDisclosed: false, executionAuthorityGranted: false };
      }
      own.push(record);
    }
    if (input.audience !== "SELF" && !row && !own.length && actor.role === "owner" && ctx.role === "owner") {
      const q = await orgRow(ctx, input.requestId, c);
      await orgAuthority(ctx, c, q.work_id, false);
      return { access: "OWNER", requestId: input.requestId, trial: null, assignments: [],
        assignmentStatus: "NO_REGISTERED_TRIAL", executionAuthorityGranted: false };
    }
    if (!own.length) orgFail("W5_SELF_OR_INDEPENDENT_TRIAL_CONTEXT_UNAVAILABLE", 404);
    const mailboxes = (await c.query<{ assignment_id: string; idempotency_key: string; packet_ref: OrganizationReference;
      job_id: string; job_status: string | null }>(`SELECT m.assignment_id,m.idempotency_key,m.packet_ref,m.job_id,j.status job_status
      FROM finnor_os.w5_trial_use_mailboxes m LEFT JOIN finnor_os.jobs j ON j.tenant_id=m.tenant_id AND j.id=m.job_id
      WHERE m.tenant_id=$1 AND m.performer_id=$2 AND m.assignment_id=ANY($3::uuid[])
      ORDER BY m.assignment_id LIMIT 513`, [ctx.tenantId, principal(ctx), own.map(a => a.body.assignmentId)])).rows;
    if (mailboxes.length > own.length) orgFail("W5_COMPLETE_SELF_MAILBOX_PROFILE_BOUND");
    return { access: "PARTICIPANT", requestId: input.requestId, assignments: own, currentness: "CURRENT",
      mailboxes: mailboxes.map(m => ({ assignmentRef: own.find(a => a.body.assignmentId === m.assignment_id)!.ref,
        idempotencyKey: m.idempotency_key, packetRef: m.packet_ref, jobId: m.job_id,
        jobStatus: m.job_status ?? "ORIGINAL_JOB_UNAVAILABLE_NO_REQUEUE" })),
      parentPrivateDataDisclosed: false, executionAuthorityGranted: false };
  });
}

function checkUseBinding(a: W5NativeAssignment, observation: z.infer<typeof outcomeInput>, uses: any[]) {
  if (uses.length > 1024) orgFail("W5_COMPLETE_UNIT_USE_POPULATION_REQUIRED");
  if (a.arm === "ORIGINAL") {
    if (observation.useKey !== null || uses.length) orgFail("W5_ORIGINAL_ARM_CONTAMINATION_FORBIDDEN");
    return;
  }
  const use = uses[0];
  if (uses.length !== 1 || !use || use.use_key !== observation.useKey || use.request_id !== a.requestId ||
      use.work_id !== a.unit.workId || use.process_id !== a.processId || use.participant_id !== a.performerPrincipalId ||
      use.role_id !== a.performerRoleId || new Date(use.created_at).getTime() < Date.parse(a.assignedAt) ||
      new Date(use.created_at).getTime() > Date.parse(observation.observedAt))
    orgFail("W5_EXACT_POST_ASSIGNMENT_TRANSFORMED_USE_REQUIRED");
}

async function checkAssignedPacketTx(ctx: TenantContext, assignment: W5NativeAssignmentRecord,
  trialId: string, evaluatorId: string, use: { source_ref: OrganizationReference }, c: PoolClient) {
  const a = assignment.body;
  const mailbox = (await c.query<TrialUseMailbox>(`SELECT * FROM finnor_os.w5_trial_use_mailboxes
    WHERE tenant_id=$1 AND assignment_id=$2`, [ctx.tenantId, a.assignmentId])).rows[0];
  if (!mailbox || mailbox.trial_id !== trialId || mailbox.request_id !== a.requestId ||
      mailbox.principal_id !== a.principalId || mailbox.evaluator_id !== evaluatorId ||
      mailbox.performer_id !== a.performerPrincipalId || mailbox.work_id !== a.unit.workId ||
      mailbox.work_input_id !== a.unit.workInputId || mailbox.process_id !== a.processId ||
      mailbox.role_id !== a.performerRoleId || !same(mailbox.packet_ref, use.source_ref))
    orgFail("W5_EXACT_ORIGINAL_ASSIGNED_MAILBOX_REQUIRED");
  const packet = await readOrganizationEvidenceTx(ctx, use.source_ref, c), p = packet.record;
  if (p.schema !== "finnor.organization-prepared-packet.v1" ||
      packet.metadata.authenticatedPrincipal !== a.performerPrincipalId ||
      packet.metadata.workId !== a.unit.workId || p.requestId !== a.requestId || p.workId !== a.unit.workId ||
      p.processId !== a.processId || p.roleId !== a.performerRoleId ||
      p.authenticatedPrincipalId !== a.performerPrincipalId || p.exactTermsDigest !== mailbox.terms_digest ||
      p.idempotencyKey !== mailbox.idempotency_key || !same(p.trialAssignmentRef, assignment.ref) ||
      organizationProcessUseIntentDigest(p) !== mailbox.intent_digest)
    orgFail("W5_EXACT_ASSIGNED_NATIVE_PACKET_REQUIRED");
  const job = (await c.query(`SELECT type,protocol_version,payload FROM finnor_os.jobs WHERE tenant_id=$1 AND id=$2`,
    [ctx.tenantId, mailbox.job_id])).rows[0], request = job?.payload?.processUse;
  if (!job || job.type !== "advance_organization_transformation_v1" || job.protocol_version !== 1 ||
      job.payload.tenantId !== ctx.tenantId || job.payload.principalId !== a.principalId ||
      job.payload.requestId !== a.requestId || job.payload.phase !== "ADVANCE" ||
      !request || request.authenticatedPrincipalId !== a.performerPrincipalId ||
      request.termsDigest !== mailbox.terms_digest || !same(request.packetRef, mailbox.packet_ref) ||
      organizationProcessUseIntentDigest(request) !== mailbox.intent_digest)
    orgFail("W5_ORIGINAL_ASSIGNED_PUBLICATION_JOB_UNAVAILABLE_OR_CHANGED");
}

/** Independent attestation over an actual, current post-assignment S1 record.
 * Unknown human/service facts are recorded, never converted into successes. */
export async function recordOrganizationTrialObservation(ctx: TenantContext, value: unknown) {
  const input = organizationTrialObservation.parse(value), requestDigest = organizationDigest(input);
  return orgTx(ctx, async c => {
    await orgLock(ctx, c); await orgActor(ctx, c);
    const row = (await c.query<AssignmentRow>(`SELECT * FROM finnor_os.w5_trial_assignments
      WHERE tenant_id=$1 AND request_id=$2 AND assignment_ref=$3::jsonb`,
      [ctx.tenantId, input.requestId, JSON.stringify(input.assignmentRef)])).rows[0];
    if (!row || row.evaluator_id !== principal(ctx) || row.principal_id === principal(ctx) || row.performer_id === principal(ctx))
      orgFail("W5_EXACT_INDEPENDENT_TRIAL_EVALUATOR_REQUIRED", 404);
    const assignment = assignmentRecord(row), a = assignment.body;
    const trialRow = (await c.query<TrialRow>("SELECT * FROM finnor_os.w5_trials WHERE tenant_id=$1 AND id=$2",
      [ctx.tenantId, row.trial_id])).rows[0];
    if (!trialRow) orgFail("W5_ORIGINAL_TRIAL_REQUIRED");
    const trial = trialRecord(trialRow);
    if (!same(a.trialRef, trial.ref) || trial.body.evaluatorPrincipalId !== principal(ctx))
      orgFail("W5_ORIGINAL_INDEPENDENT_TRIAL_BINDING_REQUIRED");
    await orgAuthority(ctx, c, a.unit.workId, false);
    const prior = (await c.query(`SELECT * FROM finnor_os.w5_trial_outcomes WHERE tenant_id=$1 AND
      (assignment_id=$2 OR request_id=$3 AND evaluator_id=$4 AND idempotency_key=$5) LIMIT 2`,
      [ctx.tenantId, a.assignmentId, input.requestId, principal(ctx), input.idempotencyKey])).rows;
    if (prior.length) {
      const p = prior[0];
      if (prior.length !== 1 || p.assignment_id !== a.assignmentId || p.idempotency_key !== input.idempotencyKey ||
          p.request_digest !== requestDigest || p.body_digest !== epistemicHash(p.body))
        orgFail("W5_ORIGINAL_OUTCOME_CANNOT_BE_REPLACED_OR_REASSIGNED");
      return { requestId: input.requestId, assignmentRef: assignment.ref, observationRef: p.source_ref,
        semanticReplay: true, executionAuthorityGranted: false };
    }
    await lockUnitWriters(c);
    const source = await readOrganizationEvidenceTx(ctx, input.evidenceRef, c), o = outcomeInput.parse(source.record.body);
    const receivedAt = (await c.query("SELECT clock_timestamp() at")).rows[0].at.toISOString();
    const latest = (await c.query(`SELECT id,encode(sha256(convert_to(instruction_text,'UTF8')),'hex') digest
      FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1`,
      [ctx.tenantId, a.unit.workId])).rows[0];
    if (source.record.kind !== "OPERATING_OBSERVATION" || source.record.authenticatedPrincipalId !== principal(ctx) ||
        source.metadata.workId !== a.unit.workId || source.record.workId !== a.unit.workId ||
        source.record.sourceClass !== trial.body.sourceClass || source.record.observedAt !== o.observedAt ||
        !same(o.assignmentRef, assignment.ref) || o.requestId !== a.requestId || o.workId !== a.unit.workId ||
        o.workInputId !== a.unit.workInputId || o.processId !== a.processId || o.arm !== a.arm ||
        !latest || latest.id !== a.unit.workInputId || latest.digest !== a.unit.workInputDigest ||
        source.created_at.getTime() <= Date.parse(a.assignedAt) || source.created_at.getTime() > Date.parse(receivedAt) ||
        Date.parse(o.observedAt) < Date.parse(a.assignedAt) || Date.parse(o.observedAt) > source.created_at.getTime() ||
        Date.parse(o.observedAt) > Date.parse(trial.body.originalDeadline) ||
        o.elapsedSeconds > Math.ceil((Date.parse(o.observedAt) - Date.parse(a.assignedAt)) / 1000))
      orgFail("W5_INDEPENDENT_POST_ASSIGNMENT_SOURCE_REQUIRED");
    const uses = (await c.query("SELECT * FROM finnor_os.w5_trial_evaluator_uses($1)", [a.assignmentId])).rows;
    checkUseBinding(a, o, uses);
    if (a.arm === "TRANSFORMED") await checkAssignedPacketTx(ctx, assignment, row.trial_id,
      trial.body.evaluatorPrincipalId, uses[0], c);
    const body: W5RandomizedOutcome = { assignmentId: a.assignmentId, unitId: a.unit.unitId, workId: a.unit.workId,
      workInputId: a.unit.workInputId, workInputDigest: a.unit.workInputDigest, arm: a.arm,
      elapsedSeconds: o.elapsedSeconds, humanSeconds: o.humanSeconds, serviceRetained: o.serviceRetained,
      useKey: o.useKey, evaluatorPrincipalId: principal(ctx), observationRef: input.evidenceRef, observedAt: o.observedAt, receivedAt };
    await c.query(`INSERT INTO finnor_os.w5_trial_outcomes(tenant_id,id,trial_id,assignment_id,request_id,principal_id,
      evaluator_id,work_id,idempotency_key,request_digest,source_ref,body,body_digest,observed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14)`,
      [ctx.tenantId, randomUUID(), row.trial_id, a.assignmentId, a.requestId, a.principalId, principal(ctx), a.unit.workId,
        input.idempotencyKey, requestDigest, JSON.stringify(input.evidenceRef), JSON.stringify(body), epistemicHash(body), o.observedAt]);
    return { requestId: input.requestId, assignmentRef: assignment.ref, observationRef: input.evidenceRef,
      semanticReplay: false, qualification: "INDEPENDENT_AUTHENTICATED_OBSERVATION_NOT_FIELD_TRUTH",
      unknownHumanTimeRetained: o.humanSeconds === null, unknownServiceRetained: o.serviceRetained === null,
      executionAuthorityGranted: false, fieldBenefitEstablished: false };
  });
}

export interface OrganizationRandomizedEvidence {
  trial: W5ProspectiveTrialRecord | null; assignments: W5NativeAssignmentRecord[]; outcomes: W5RandomizedOutcome[];
  assignmentVerified: boolean; nativeProvenanceGaps: string[]; gaps: string[];
  effect: ReturnType<typeof analyzeW5RandomizedTaskEffect> | null;
  rejectedOutcomes: Array<{ assignmentId: string; reason: string }>;
}
/** Independent readback of the complete native S2/S3 population. A pure S2
 * checker alone cannot establish native entropy, physical claims or S5 use. */
export async function readOrganizationRandomizedEvidenceTx(ctx: TenantContext, q: OrganizationRequestRow,
  c: PoolClient): Promise<OrganizationRandomizedEvidence> {
  const rows = (await c.query<TrialRow>("SELECT * FROM finnor_os.w5_trials WHERE tenant_id=$1 AND request_id=$2 LIMIT 2",
    [ctx.tenantId, q.id])).rows;
  if (rows.length > 1) orgFail("W5_SINGLE_REGISTERED_FINAL_LOOK_REQUIRED");
  if (!rows.length) return { trial: null, assignments: [], outcomes: [], assignmentVerified: false,
    nativeProvenanceGaps: ["S2_NATIVE_PROSPECTIVE_TRIAL_NOT_REGISTERED"], gaps: ["S2_NATIVE_PROSPECTIVE_TRIAL_NOT_REGISTERED"],
    effect: null, rejectedOutcomes: [] };
  const row = rows[0]!, trial = trialRecord(row), assignments = await assignmentsTx(ctx, row.id, c);
  const check = checkW5ProspectiveTrial(trial, assignments), nativeGaps = [...check.errors], gaps: string[] = [];
  const event = (await c.query(`SELECT body,body_digest FROM finnor_os.w5_events
    WHERE tenant_id=$1 AND request_id=$2 AND event_key=$3 AND kind='PROSPECTIVE_NATIVE_ASSIGNMENTS_COMMITTED'`,
    [ctx.tenantId, q.id, "trial-assigned:" + row.id])).rows[0];
  const provenance = assignments[0]?.body.nativeProvenance;
  if (!provenance || !event || event.body_digest !== organizationDigest(event.body) ||
      !same(event.body.trialRef, trial.ref) || !same(event.body.assignmentRefs, assignments.map(a => a.ref)) ||
      !same(event.body.nativeProvenance, provenance) || assignments.some(a => !same(a.body.nativeProvenance, provenance)))
    nativeGaps.push("S2_COMPLETE_ATOMIC_NATIVE_ASSIGNMENT_COMMIT_UNAVAILABLE");
  if (provenance) {
    const proof = (await c.query(`SELECT j.type,j.protocol_version,j.payload,a.claim_fence,a.worker_id,a.started_at,
      accepted.body accepted,accepted.body_digest accepted_digest,finished.body finished,finished.body_digest finished_digest,
      co.body consumption,co.principal_id,co.reservation_id
      FROM finnor_os.job_delivery_attempts a JOIN finnor_os.jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id
      LEFT JOIN finnor_os.w5_events accepted ON accepted.tenant_id=a.tenant_id AND accepted.request_id=$4
        AND accepted.event_key='accepted:'||a.id::text AND accepted.kind='NATIVE_COMPUTE_ACCEPTED'
      LEFT JOIN finnor_os.w5_events finished ON finished.tenant_id=a.tenant_id AND finished.request_id=$4
        AND finished.event_key='finished:'||a.id::text AND finished.kind='NATIVE_COMPUTE_FINISHED'
      LEFT JOIN finnor_os.s5_consumptions co ON co.tenant_id=a.tenant_id AND co.consumption_id=$5
      WHERE a.tenant_id=$1 AND a.id=$2 AND j.id=$3 FOR SHARE OF j,a`,
      [ctx.tenantId, provenance.deliveryAttemptId, provenance.jobId, q.id, provenance.consumptionRef.id])).rows[0];
    const { ref, ...body } = proof?.consumption ?? {};
    if (!proof || proof.type !== "advance_organization_transformation_v1" || proof.protocol_version !== 1 ||
        proof.payload.tenantId !== ctx.tenantId || proof.payload.principalId !== q.principal_id ||
        proof.payload.requestId !== q.id || proof.payload.phase !== "ADVANCE" ||
        String(proof.claim_fence) !== String(provenance.claimFence) || proof.worker_id !== provenance.workerId ||
        proof.started_at.getTime() > Date.parse(provenance.claimCheckedAt) ||
        !proof.accepted || proof.accepted_digest !== organizationDigest(proof.accepted) ||
        proof.accepted.jobId !== provenance.jobId || proof.accepted.deliveryAttemptId !== provenance.deliveryAttemptId ||
        proof.accepted.claimFence !== provenance.claimFence || proof.accepted.workerId !== provenance.workerId ||
        proof.accepted.claimTokenDigest !== provenance.claimTokenDigest ||
        !same(proof.accepted.consumptionRef, provenance.consumptionRef) ||
        !same(proof.accepted.originalBudgetRef, q.budget.ref) ||
        Date.parse(proof.accepted.acceptedAt) > Date.parse(provenance.claimCheckedAt) ||
        !proof.finished || proof.finished_digest !== organizationDigest(proof.finished) ||
        proof.finished.jobId !== provenance.jobId || proof.finished.deliveryAttemptId !== provenance.deliveryAttemptId ||
        proof.finished.consumptionId !== provenance.consumptionRef.id || !same(proof.finished.originalBudgetRef, q.budget.ref) ||
        proof.principal_id !== q.principal_id || proof.reservation_id !== q.budget.reservationRef.id ||
        body.schema !== "finnor.s5.workforce-consumption.v1" || body.nodeId !== q.budget.programmeId ||
        body.programmeId !== q.budget.programmeId || body.executionAuthorityGranted !== false || body.protectedReceipt !== null ||
        !same(ref, provenance.consumptionRef) || !same(ref, allocationRef("S5", "workforce-consumption", body, "s5-workforce-v1")))
      nativeGaps.push("S2_ORIGINAL_PHYSICAL_CLAIM_AND_S5_CONSUMPTION_NOT_VERIFIED");
  }
  await lockUnitWriters(c);
  try { await currentTrialIntentTx(ctx, q, c, trial); }
  catch { gaps.push("ORIGINAL_PREREGISTERED_TRIAL_INTENT_INVALIDATED"); }
  try { await currentUnitsTx(ctx, q, trial.body.units, trial.body.processId, c); }
  catch { gaps.push("REGISTERED_REAL_WORK_INPUT_OR_ENROLLMENT_SOURCE_INVALIDATED"); }
  if (q.program) {
    try { trialGraph(q, q.program, trial); }
    catch { gaps.push("REGISTERED_ORIGINAL_TRIAL_GRAPH_OR_CURRENT_ADOPTION_INVALIDATED"); }
  } else gaps.push("REGISTERED_ORIGINAL_TRIAL_GRAPH_UNAVAILABLE");
  const stored = (await c.query(`SELECT assignment_id,evaluator_id,work_id,source_ref,body,body_digest,observed_at,created_at
    FROM finnor_os.w5_trial_outcomes WHERE tenant_id=$1 AND (trial_id=$2 OR request_id=$3)
    ORDER BY assignment_id LIMIT 513`, [ctx.tenantId, row.id, q.id])).rows;
  if (stored.length > 512) orgFail("W5_COMPLETE_ORIGINAL_OUTCOME_POPULATION_REQUIRED");
  const uses = (await c.query("SELECT * FROM finnor_os.w5_trial_owner_uses($1)", [row.id])).rows;
  if (uses.length > 1024) orgFail("W5_COMPLETE_REGISTERED_USE_POPULATION_REQUIRED");
  const outcomes: W5RandomizedOutcome[] = [], rejectedOutcomes: OrganizationRandomizedEvidence["rejectedOutcomes"] = [];
  for (const saved of stored) {
    const parsed = W5RandomizedOutcomeSchema.safeParse(saved.body);
    if (!parsed.success || saved.body_digest !== epistemicHash(saved.body)) {
      rejectedOutcomes.push({ assignmentId: saved.assignment_id, reason: "ORIGINAL_OUTCOME_PREIMAGE_INVALID" }); continue;
    }
    const outcome = parsed.data, a = assignments.find(entry => entry.body.assignmentId === saved.assignment_id);
    outcomes.push(outcome);
    try {
      const source = await readOrganizationEvidenceTx(ctx, saved.source_ref, c), o = outcomeInput.parse(source.record.body);
      if (!a || !same(outcome.observationRef, saved.source_ref) || !same(o.assignmentRef, a.ref) ||
          source.record.kind !== "OPERATING_OBSERVATION" || source.record.authenticatedPrincipalId !== trial.body.evaluatorPrincipalId ||
          source.metadata.workId !== outcome.workId || source.record.sourceClass !== trial.body.sourceClass ||
          saved.evaluator_id !== outcome.evaluatorPrincipalId || saved.work_id !== outcome.workId ||
          saved.assignment_id !== outcome.assignmentId || saved.observed_at.getTime() !== Date.parse(outcome.observedAt) ||
          saved.created_at.getTime() < Date.parse(outcome.receivedAt) || source.created_at.getTime() <= Date.parse(a.body.assignedAt) ||
          source.record.observedAt !== o.observedAt || o.observedAt !== outcome.observedAt ||
          o.requestId !== q.id || o.workId !== outcome.workId || o.workInputId !== outcome.workInputId ||
          o.processId !== trial.body.processId || o.arm !== outcome.arm || o.elapsedSeconds !== outcome.elapsedSeconds ||
          o.humanSeconds !== outcome.humanSeconds || o.serviceRetained !== outcome.serviceRetained || o.useKey !== outcome.useKey ||
          o.elapsedSeconds > Math.ceil((Date.parse(o.observedAt) - Date.parse(a.body.assignedAt)) / 1000))
        orgFail("W5_INDEPENDENT_ORIGINAL_OUTCOME_BINDING_CHANGED");
      const ownUses = uses.filter(use => use.work_id === a.body.unit.workId);
      checkUseBinding(a.body, o, ownUses);
      if (a.body.arm === "TRANSFORMED") await checkAssignedPacketTx(ctx, a, row.id,
        trial.body.evaluatorPrincipalId, ownUses[0], c);
    } catch { rejectedOutcomes.push({ assignmentId: saved.assignment_id, reason: "INDEPENDENT_SOURCE_OR_NATIVE_USE_BINDING_INVALIDATED" }); }
  }
  if (rejectedOutcomes.length) gaps.push("INVALID_OR_CHANGED_ORIGINAL_OUTCOME_EVIDENCE_PRESENT");
  const effect = analyzeW5RandomizedTaskEffect(trial, assignments, outcomes);
  const uniqueNative = [...new Set(nativeGaps)], allGaps = [...new Set([...uniqueNative, ...gaps, ...effect.gaps])];
  return { trial, assignments, outcomes, assignmentVerified: uniqueNative.length === 0,
    nativeProvenanceGaps: uniqueNative, gaps: allGaps, rejectedOutcomes,
    effect: { ...effect, status: allGaps.length ? "UNIDENTIFIED" : effect.status, gaps: allGaps,
      registeredMaterialMarginEstablished: allGaps.length === 0 && effect.registeredMaterialMarginEstablished } };
}
