import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { TenantContext, ExperimentRef } from "@finnor/shared-types";
import { receiveWork } from "@finnor/db";
import { canExerciseWorkforceAuthorityTx as canExerciseAuthorityTx,
  canExerciseWorkforceAuthorityBatchTx,
  workforceEmployeeAuthoritySnapshotTx as employeeAuthoritySnapshotTx } from "@finnor/authority";
import { applyWorkforceCommand, checkWorkforceExecutionProgram, workforceDigest, workforceProgramGraph, workforceCanonicalGraph,
  type AuthenticatedWorkforceCommand, type WorkforceAssignment, type WorkforceExecutionProgram } from "../../../workforce/src/execution-program/index";
import type { WorkforceCompilerInput } from "../../../workforce/src/execution-program/index";
import { reserveWorkforceBudgetTx, recordWorkforceCarvesTx, releaseUnconsumedWorkforceCarveTx,
  retireKnownWorkforceCarveTx, assertCurrentWorkforceAllocationAuthorityTx } from "../../../private-equity/src/workforce-allocation";
import { assertWorkforceCompensationMappingsTx, recordWorkforceCompensationAcceptanceTx,
  readWorkforceCompensationTx } from "../../../private-equity/src/workforce-compensation";
import { exactQuantity } from "../../../workforce/src/execution-program/exact";
import { recordWorkforceOutcomeExperienceTx } from "../../../capability-evolution/src/workforce-experience";
import { workforceP7Closure } from "./dependencies";
import { persistWorkforceProtectedChildBinding, protectedChildRefusalCode,
  refuseWorkforceProtectedChildTx } from "./protected-child";
import { submitWorkforceExecutionSchema, recipientWorkforceActionSchema, nativeWorkforceOriginalSchema, intakeWorkforceExecutionSchema,
  nativeWorkforceTaskCreationRecordSchema, WorkforceRuntimeError,
  type RecipientWorkforceAction } from "./contracts";
import { activePrincipal, evidence, event, events, originalWork, portfolioLock, principal, programRow, publish, reference,
  reject, resolveActors, resolveCanonicalInput, resolveNativeDefinitions, recordWorkforceCurrentnessTx, taskCreationObservation, rootContext, tx,
  type WorkforceProgramRow, type ResolvedActor } from "./store";

export async function enqueueWorkforceTx(ctx: TenantContext, q: WorkforceProgramRow, phase: "COMPILE" | "ADVANCE" | "RECONCILE",
  key: string, c: PoolClient, runAt?: string) {
  if (runAt && (!Number.isFinite(Date.parse(runAt)) || Date.parse(runAt) >= Date.parse(q.original.outcome.deadline)))
    reject("WORKFORCE_SCHEDULE_EXCEEDS_ORIGINAL_DEADLINE");
  const id = randomUUID();
  const result = await c.query(`INSERT INTO finnor_os.jobs(id,tenant_id,type,payload,status,run_at,lane,protocol_version,max_attempts,idempotency_key)
    VALUES($1,$2,'run_workforce_execution_v1',$3::jsonb,'queued',COALESCE($5::timestamptz,clock_timestamp()),'interactive',1,4,$4)
    ON CONFLICT DO NOTHING RETURNING id`, [id, ctx.tenantId, JSON.stringify({ tenantId: ctx.tenantId,
      principalId: q.principal_id, programId: q.id, phase }), "w2:" + q.id + ":" + key, runAt ?? null]);
  return result.rows[0]?.id as string | undefined;
}
export async function submitWorkforceExecution(ctx: TenantContext, value: unknown) {
  const input = submitWorkforceExecutionSchema.parse(value);
  return tx(ctx, async c => {
    await portfolioLock(ctx, c);
    const work = await originalWork(ctx, input.workId, input.workInputId, c);
    const digest = workforceDigest(input);
    const prior = (await c.query<WorkforceProgramRow>(`SELECT * FROM finnor_os.w2_programs WHERE tenant_id=$1
      AND (work_input_id=$2 OR principal_id=$3 AND idempotency_key=$4 OR work_id=$5) FOR UPDATE`,
    [ctx.tenantId, input.workInputId, principal(ctx), input.idempotencyKey, input.workId])).rows[0];
    if (prior) {
      if (prior.principal_id !== principal(ctx) || prior.request_digest !== digest) reject("WORKFORCE_ORIGINAL_EPISODE_ALREADY_BOUND");
      return { id: prior.id, workId: prior.work_id, status: prior.status, revision: prior.revision, semanticReplay: true };
    }
    if (["completed", "cancelled", "failed"].includes(work.status)) reject("WORKFORCE_ORIGINAL_WORK_NOT_ACTIVE");
    const id = randomUUID();
    const budget = await reserveWorkforceBudgetTx({ auth: ctx }, c, { ...work.original.resources, workId: input.workId,
      programmeId: id, purpose: work.original.outcome.ceiling.purposes.join(","), deadlineAt: work.original.outcome.deadline,
      idempotencyKey: "workforce:" + id });
    await assertWorkforceCompensationMappingsTx({ auth: ctx }, c, budget, work.original.outcome.tasks);
    await c.query(`INSERT INTO finnor_os.w2_programs(tenant_id,id,principal_id,work_id,work_input_id,idempotency_key,
      request_digest,original_digest,original,budget,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,'QUEUED')`,
    [ctx.tenantId, id, principal(ctx), input.workId, input.workInputId, input.idempotencyKey, digest, work.digest,
      JSON.stringify(work.original), JSON.stringify(budget)]);
    const q = await programRow(ctx, id, c, true), jobId = await enqueueWorkforceTx(ctx, q, "COMPILE", "compile", c);
    await c.query("UPDATE finnor_os.w2_programs SET job_id=$3 WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, id, jobId]);
    await event(ctx, q, "ORIGINAL_ACCEPTED", "original", { workId: q.work_id, inputId: q.work_input_id,
      originalDigest: q.original_digest, budgetRef: budget.ref, originalDeadline: work.original.outcome.deadline,
      sourceClass: work.original.sourceClass, protectedAdmission: false, genuineHumanEvidence: false }, c);
    return { id, workId: q.work_id, status: "QUEUED", revision: 0, semanticReplay: false };
  });
}

/** Ordinary authenticated intake uses Core's existing immutable Work/input
 * claim. No planner call, synthetic department or alternate Work ledger. */
export async function intakeWorkforceExecution(ctx: TenantContext, value: unknown) {
  const input = intakeWorkforceExecutionSchema.parse(value);
  await tx(ctx, async c => {
    await activePrincipal(ctx, c);
    if (!await canExerciseAuthorityTx(ctx, { operation: "action", capability: "action:workforce_assign_contract",
      resource: { type: "work", id: input.workId }, risk: "low" }, c)) reject("WORKFORCE_ORIGINAL_INTAKE_AUTHORITY_REQUIRED", 403);
  });
  const work = await receiveWork({ tenantId: ctx.tenantId, userId: principal(ctx), channel: "text",
    workId: input.workId, instruction: JSON.stringify(input.original), idempotencyKey: "w2-intake:" + input.idempotencyKey,
    requireExactIntake: true, authorityContext: { authenticatedPrincipal: principal(ctx), channel: "WORKFORCE_ORDINARY_INTAKE",
      executionAuthorityGranted: false } });
  const result = await submitWorkforceExecution(ctx, { workId: work.workId, workInputId: work.workInputId,
    idempotencyKey: input.idempotencyKey });
  return { ...result, workInputId: work.workInputId };
}

export async function applyNativeCommand(ctx: TenantContext, q: WorkforceProgramRow, program: WorkforceExecutionProgram,
  assignment: WorkforceAssignment, actorId: string, action: AuthenticatedWorkforceCommand["action"], key: string, c: PoolClient,
  provenance: Record<string, unknown>, resolved?: WorkforceCompilerInput) {
  const binding = (await resolveActors(ctx, q, c, new Set([actorId]))).find(value => value.actor.id === actorId);
  if (!binding || binding.actor.status !== "CURRENT") reject("WORKFORCE_CURRENT_COMMAND_ISSUER_REQUIRED", 403);
  const issuer = { ...ctx, userId: binding.principalId, employeeId: binding.principalId };
  const institutional = ["OFFER", "CANCEL", "EXPIRE", "CLOSE", "REASSIGN", "REVISE_TERMS", "REVOKE", "SUBDELEGATE"].includes(action.kind) ||
    action.kind === "ACCEPT" && actorId === assignment.delegatorActorId ||
    action.kind === "BLOCK" && actorId === q.principal_id;
  const capability = institutional ? "action:workforce_assign_contract" : "action:workforce_respond_contract";
  if (!await canExerciseAuthorityTx(issuer, { operation: "action", capability, workId: q.work_id,
    resource: { type: "workforce_assignment", id: assignment.id }, risk: "low" }, c))
    reject("WORKFORCE_CURRENT_COMMAND_AUTHORITY_REQUIRED", 403);
  const standing = await employeeAuthoritySnapshotTx(issuer, c);
  const recovery = ["BLOCK", "RETURN", "CANCEL", "CONFIRM_CANCEL", "MARK_UNKNOWN_EFFECT", "RECONCILE", "DISPUTE", "REVOKE"].includes(action.kind);
  const now = new Date().toISOString(), authorityRef = reference("authority", q.id + ":command:" + key,
    { authenticatedPrincipal: principal(ctx), actorId, assignmentId: assignment.id, action, provenance, originalRoot: q.work_id,
      standingPrincipal: binding.principalId, standingRevision: standing.revision, capability });
  const command: AuthenticatedWorkforceCommand = { id: q.id + ":" + key, actorId, assignmentId: assignment.id,
    expectedRevision: program.revision, at: now, authorityRef, action };
  const authority = { ref: authorityRef, commandId: command.id, actorId, assignmentId: assignment.id, commandDigest: workforceDigest(command),
    actions: [action.kind], validFrom: now, validUntil: new Date(Math.min(
      recovery ? Math.max(Date.parse(q.original.outcome.deadline), Date.parse(now) + 60000) : Date.parse(q.original.outcome.deadline),
      standing.validUntil ? Date.parse(standing.validUntil) : Infinity)).toISOString() };
  await event(ctx, q, "COMMAND_AUTHORITY", "authority:" + key, { observation: authority, authenticatedPrincipal: principal(ctx), provenance }, c);
  const canonical = resolved ?? await resolveCanonicalInput(ctx, q, c);
  if (resolved) { canonical.now = now; canonical.commandAuthorities.push(authority); }
  const result = applyWorkforceCommand(program, command, canonical);
  if (result.status === "REJECTED") reject("WORKFORCE_CONTRACT_TRANSITION_REJECTED", 409, result.issues);
  await event(ctx, q, "COMMAND", "command:" + key, { command, authenticatedPrincipal: principal(ctx), provenance }, c);
  if (action.kind === "ACCEPT") {
    const recipient = canonical.actors.find(actor => actor.id === assignment.actorId);
    if (recipient && ["INTERNAL_HUMAN", "EXTERNAL_PROFESSIONAL", "PROVIDER"].includes(recipient.kind)) {
      const observation = { assignmentId: assignment.id, rootId: assignment.rootId,
        kind: "ACCEPTED_LABOR" as const, status: "OPEN" as const, at: now };
      const ref = await evidence(ctx, q, "accepted-labor:" + key, { ...observation,
        acceptedActorKind: recipient.kind, termsDigest: assignment.termsDigest, dispositionRef: action.dispositionRef,
        authenticatedPrincipal: principal(ctx), sourceClass: q.original.sourceClass,
        compensationSettlementAsserted: false, genuineHumanQualificationAsserted: false }, c);
      await event(ctx, q, "OBLIGATION", "accepted-labor:" + key, { observation: { ...observation, ref },
        authenticatedPrincipal: principal(ctx), acceptedActorKind: recipient.kind,
        statement: "RETAIN_ACTUAL_NATIVE_ACCEPTANCE_INDEPENDENT_OF_FUTURE_ACTOR_PROFILE" }, c);
    }
    if (exactQuantity(assignment.terms.compensation.value).n > 0n)
      await recordWorkforceCompensationAcceptanceTx({ auth: ctx }, c, q.budget, assignment.id, action.dispositionRef);
  }
  return result.program;
}

async function authorizeAction(authenticated: TenantContext, root: TenantContext, q: WorkforceProgramRow,
  assignment: WorkforceAssignment, action: RecipientWorkforceAction, c: PoolClient) {
  const bindings = await resolveActors(root, q, c);
  const recipient = bindings.find(a => a.actor.id === assignment.actorId);
  const delegator = bindings.find(a => a.actor.id === assignment.delegatorActorId);
  const definitions = await resolveNativeDefinitions(root, q, c);
  const task = definitions.tasks.find(t => t.id === assignment.taskId);
  const criterion = definitions.criteria.find(v => v.id === task?.criterionId);
  if (!recipient || !delegator || !criterion || !task) reject("WORKFORCE_CURRENT_BINDING_REQUIRED");
  const actual = principal(authenticated);
  let actorId = recipient.actor.id;
  if (["CANCEL", "EXPIRE", "CLOSE", "REASSIGN", "REVISE_TERMS"].includes(action.action)) {
    if (actual !== delegator.principalId && actual !== q.principal_id) reject("WORKFORCE_DELEGATOR_REQUIRED", 403);
    actorId = assignment.delegatorActorId;
  } else if (action.action === "VERIFY") {
    const checker = bindings.find(a => a.actor.id === criterion.checkerActorId);
    if (!checker || checker.principalId !== actual || checker.actor.id === assignment.actorId)
      reject("WORKFORCE_INDEPENDENT_CHECKER_REQUIRED", 403);
    actorId = checker.actor.id;
  } else if (actual !== recipient.principalId) {
    if (action.action !== "ACCEPT" || task.assignmentMode !== "INTERNAL_AUTHORIZED" || actual !== q.principal_id)
      reject("WORKFORCE_EXACT_RECIPIENT_REQUIRED", 403);
    actorId = assignment.delegatorActorId;
  }
  await activePrincipal(authenticated, c);
  if (!await canExerciseAuthorityTx(authenticated, { operation: "action", capability:
    ["CANCEL", "EXPIRE", "CLOSE", "REASSIGN", "REVISE_TERMS", "SUBDELEGATE"].includes(action.action) ||
      action.action === "ACCEPT" && actual !== recipient.principalId ? "action:workforce_assign_contract" : "action:workforce_respond_contract",
    workId: q.work_id, resource: { type: "workforce_assignment", id: assignment.id }, risk: "low" }, c))
    reject("WORKFORCE_CURRENT_PARTICIPANT_AUTHORITY_REQUIRED", 403);
  if (assignment.termsDigest !== action.termsDigest || assignment.terms.revision !== action.termsRevision)
    reject("WORKFORCE_EXACT_CURRENT_TERMS_REQUIRED");
  if (Date.now() >= Date.parse(q.original.outcome.deadline) && !["CANCEL", "CONFIRM_CANCEL", "EXPIRE", "RETURN", "DISPUTE", "RELEASE_LABOR"].includes(action.action))
    reject("WORKFORCE_ORIGINAL_DEADLINE_EXPIRED");
  return { bindings, recipient, delegator, criterion, task, actorId, actual };
}

/** Authenticated participant input. The caller never supplies an authority,
 * disposition, verification or S6 reference for the checker to trust. */
export async function actOnWorkforceAssignment(authenticated: TenantContext, programId: string, value: unknown) {
  const input = recipientWorkforceActionSchema.parse(value);
  const access = await tx(authenticated, async c => {
    await activePrincipal(authenticated, c);
    const owner = (await c.query<WorkforceProgramRow>("SELECT * FROM finnor_os.w2_programs WHERE tenant_id=$1 AND id=$2 AND principal_id=$3",
      [authenticated.tenantId, programId, principal(authenticated)])).rows[0];
    if (owner) return { principal_id: owner.principal_id };
    const row = (await c.query("SELECT finnor_os.w2_participant_access($1,$2) principal_id",
      [programId, input.assignmentId])).rows[0];
    if (!row?.principal_id) reject("WORKFORCE_CONTEXT_UNAVAILABLE", 404);
    return row as { principal_id: string };
  });
  const root = rootContext({ tenant_id: authenticated.tenantId, principal_id: access.principal_id });
  try {
  return await tx(root, async c => {
    await portfolioLock(root, c);
    const q = await programRow(root, programId, c, true), program = q.program;
    if (!program) reject("WORKFORCE_PROGRAM_NOT_COMPILED");
    const assignment = program.assignments.find(a => a.id === input.assignmentId);
    if (!assignment) reject("WORKFORCE_ASSIGNMENT_UNAVAILABLE", 404);
    const auth = await authorizeAction(authenticated, root, q, assignment, input, c);
    const previous = (await c.query("SELECT body FROM finnor_os.w2_events WHERE tenant_id=$1 AND program_id=$2 AND event_id=$3",
      [root.tenantId, q.id, "request:" + input.idempotencyKey])).rows[0]?.body;
    if (previous) {
      if (previous.requestDigest !== workforceDigest(input) || previous.authenticatedPrincipal !== auth.actual)
        reject("WORKFORCE_COMMAND_IDEMPOTENCY_CONFLICT");
      return { id: q.id, status: q.status, revision: program.revision, semanticReplay: true };
    }
    if (input.expectedRevision !== program.revision) reject("WORKFORCE_PROGRAM_REVISION_CHANGED");
    if (!["RETURN", "DECLINE", "DISPUTE", "CANCEL", "CONFIRM_CANCEL", "EXPIRE", "RELEASE_LABOR", "CLOSE"].includes(input.action))
      await assertCurrentWorkforceAllocationAuthorityTx({ auth: root }, c, q.budget);
    const key = input.idempotencyKey, now = new Date().toISOString();
    if (input.action === "RELEASE_LABOR") {
      if (auth.actual !== auth.recipient.principalId ||
          !["INTERNAL_HUMAN", "EXTERNAL_PROFESSIONAL", "PROVIDER"].includes(auth.recipient.actor.kind) ||
          !program.history.some(command => command.assignmentId === assignment.id && command.action.kind === "ACCEPT"))
        reject("WORKFORCE_ACTUAL_ACCEPTED_LABOR_RECIPIENT_REQUIRED", 403);
      const observation = { assignmentId: assignment.id, rootId: assignment.rootId, kind: "ACCEPTED_LABOR" as const,
        status: "RELEASED" as const, at: now };
      const ref = await evidence(root, q, "labor-release:" + key, { ...observation,
        authenticatedPrincipal: auth.actual, compensationSettlementAsserted: false, possibleEffectReleaseAsserted: false }, c);
      await event(root, q, "OBLIGATION", "labor-release:" + key, { observation: { ...observation, ref },
        authenticatedPrincipal: auth.actual, statement: "EXPLICIT_RECIPIENT_LABOR_RELEASE_ONLY" }, c);
      const published = await publish(root, q, program, c);
      await event(root, q, "REQUEST", "request:" + key, { requestDigest: workforceDigest(input),
        authenticatedPrincipal: auth.actual, action: input.action, assignmentId: assignment.id, revision: program.revision }, c);
      await enqueueWorkforceTx(root, q, "ADVANCE", "labor-release:" + key, c);
      return { id: q.id, status: published.status, revision: program.revision, semanticReplay: false };
    }
    let action: AuthenticatedWorkforceCommand["action"];
    let replacementRetirement: Awaited<ReturnType<typeof retireKnownWorkforceCarveTx>> | null = null;
    if (input.action === "ACCEPT" || input.action === "DECLINE") {
      if (input.action === "ACCEPT") {
        const conflicting = (await c.query(`SELECT * FROM finnor_os.w2_actor_occupation($1::uuid[],$2::uuid)
          WHERE actor_id=$3 AND slot_start<$4::timestamptz AND slot_end>$5::timestamptz`,
        [[assignment.actorId], q.id, assignment.actorId, auth.task.slot.endAt, auth.task.slot.startAt])).rows;
        const availability = auth.recipient.actor.availability;
        if (availability.kind !== "OBSERVED" || conflicting.length >= availability.maxConcurrent)
          reject("WORKFORCE_SHARED_ACTOR_CAPACITY_CONFLICT");
      }
      const body = { assignmentId: assignment.id, actorId: assignment.actorId, mode: auth.task.assignmentMode,
        source: auth.task.assignmentMode === "INTERNAL_AUTHORIZED"
          ? "NATIVE_INSTITUTIONAL_ASSIGNMENT" as const : "NATIVE_RECIPIENT_DISPOSITION" as const,
        decision: input.action, termsDigest: assignment.termsDigest, termsRevision: assignment.terms.revision, at: now, revokedAt: null };
      const ref = reference("workforce-recipient", q.id + ":" + key, body);
      await event(root, q, "DISPOSITION", "disposition:" + key, { observation: { ...body, ref },
        authenticatedPrincipal: auth.actual, voluntaryHumanResponseSimulated: false }, c);
      action = { kind: input.action, dispositionRef: ref };
    } else if (input.action === "DELIVER") {
      if (!Object.prototype.hasOwnProperty.call(input, "value")) reject("WORKFORCE_DELIVERY_VALUE_REQUIRED");
      const ref = await evidence(root, q, key, { value: input.value, assignmentId: assignment.id, actorId: assignment.actorId,
        authenticatedPrincipal: auth.actual, sourceClass: q.original.sourceClass, termsDigest: assignment.termsDigest }, c);
      const body = { assignmentId: assignment.id, actorId: assignment.actorId, termsDigest: assignment.termsDigest,
        evidenceRefs: [ref], custodianActorId: auth.criterion.evidenceCustodianActorId, at: now };
      const deliveryRef = reference("S1", q.id + ":delivery:" + key, body);
      await event(root, q, "DELIVERY", "delivery:" + key, { observation: { ...body, ref: deliveryRef },
        value: input.value, authenticatedPrincipal: auth.actual }, c);
      action = { kind: "DELIVER", deliveryRef };
    } else if (input.action === "VERIFY") {
      const delivery = (await events(root, q, c)).filter(v => v.kind === "DELIVERY" &&
        (v.body.observation as { assignmentId?: string })?.assignmentId === assignment.id).at(-1)?.body;
      if (!delivery) reject("WORKFORCE_ORIGINAL_DELIVERY_REQUIRED");
      if (auth.criterion.acceptance.kind === "AUTHENTICATED_HUMAN_JUDGMENT" &&
          (!["INTERNAL_HUMAN", "EXTERNAL_PROFESSIONAL"].includes(auth.bindings.find(a => a.actor.id === auth.actorId)!.actor.kind) ||
          typeof input.value !== "boolean")) reject("WORKFORCE_ACTUAL_HUMAN_JUDGMENT_REQUIRED");
      const satisfied = auth.criterion.acceptance.kind === "EXACT_JSON"
        ? workforceDigest(delivery.value) === workforceDigest(auth.criterion.acceptance.expected) : input.value === true;
      const criterionRef = workforceCanonicalGraph(await resolveCanonicalInput(root, q, c)).criteria.find(v => v.id === auth.criterion.id)!.ref;
      const body = { assignmentId: assignment.id, deliveryRef: (delivery.observation as { ref: ExperimentRef }).ref, criterionRef,
        checkerActorId: auth.actorId, custodianActorId: auth.criterion.evidenceCustodianActorId,
        evidenceRefs: (delivery.observation as { evidenceRefs: ExperimentRef[] }).evidenceRefs,
        result: satisfied ? "SATISFIED" as const : "FAILED" as const, at: now };
      const ref = reference("S1", q.id + ":verification:" + key, body);
      await event(root, q, "VERIFICATION", "verification:" + key, { observation: { ...body, ref }, authenticatedPrincipal: auth.actual }, c);
      action = satisfied ? { kind: "VERIFY", verificationRef: ref } : { kind: "DISPUTE", observationRef: ref, reason: "ORIGINAL_CRITERION_FAILED" };
    } else if (input.action === "SUBDELEGATE") {
      const refinement = input.refinement;
      if (!refinement || !["ACCEPTED", "IN_PROGRESS", "BLOCKED"].includes(assignment.state.kind) ||
          auth.actual !== auth.recipient.principalId || !assignment.terms.subdelegation || !assignment.ceiling.allowSubdelegation)
        reject("WORKFORCE_ACCEPTED_SUBDELEGATOR_REQUIRED", 403);
      const graph = workforceProgramGraph(program);
      if (graph.tasks.some(task => task.id === refinement.task.id) || graph.criteria.some(criterion => criterion.id === refinement.criterion.id))
        reject("WORKFORCE_CHILD_TASK_OR_CRITERION_ALREADY_EXISTS");
      const task = { ...refinement.task, parentTaskId: assignment.taskId, delegatorActorId: assignment.actorId,
        criterionId: refinement.criterion.id, returnTo: [...new Set([...refinement.task.returnTo, assignment.taskId])] };
      if (task.effectId !== null || task.ceiling.effects.length)
        await refuseWorkforceProtectedChildTx(root, q, program, assignment, task,
          await resolveCanonicalInput(root, q, c), c);
      await assertWorkforceCompensationMappingsTx({ auth: root }, c, q.budget, [
        { ...auth.task, terms: assignment.terms }, task]);
      if (Buffer.byteLength(JSON.stringify(task)) > 262144) reject("WORKFORCE_CHILD_TASK_RECORD_PROFILE_EXCEEDED");
      const record = nativeWorkforceTaskCreationRecordSchema.parse({ schema: "finnor.workforce-task-creation.v1",
        programmeId: q.id, originalWorkId: q.work_id, originalMeaningDigest: q.original_digest,
        kind: refinement.kind, parentAssignmentId: assignment.id, parentTermsDigest: assignment.termsDigest,
        actorId: assignment.actorId, recipientActorId: refinement.recipientActorId, authenticatedPrincipalId: auth.actual,
        assignmentId: `${q.id}:${task.id}:1`, at: now, task, criterion: refinement.criterion, computation: refinement.computation });
      const ref = await evidence(root, q, "task-creation:" + key, record, c);
      const observation = taskCreationObservation(record, ref);
      await event(root, q, "TASK_CREATION", "task-creation:" + key, { observation, authenticatedPrincipal: auth.actual,
        originalRoot: q.work_id, originalBudget: q.budget.ref, freshRecipientAcceptanceRequired: true }, c);
      const canonical = await resolveCanonicalInput(root, q, c);
      const carves = canonical.funding.filter(f => f.status === "HELD").map(f => ({
        assignmentId: f.assignmentId, parentAssignmentId: program.assignments.find(a => a.id === f.assignmentId)!.parentAssignmentId,
        rootId: f.rootId, envelope: f.envelope }));
      carves.push({ assignmentId: record.assignmentId, parentAssignmentId: assignment.id,
        rootId: assignment.rootId, envelope: task.demand });
      const recorded = await recordWorkforceCarvesTx({ auth: root }, c, q.budget, carves);
      await event(root, q, "FUNDING", "funding:child:" + key, {
        refs: recorded.filter(f => f.assignmentId === record.assignmentId).map(f => f.ref),
        originalReservation: q.budget.reservationRef, independentGrantsCreated: false }, c);
      action = { kind: "SUBDELEGATE", taskCreationRef: ref };
    } else if (input.action === "REASSIGN") {
      if (!input.replacementActorId || !input.replacementAssignmentId) reject("WORKFORCE_REPLACEMENT_IDENTITY_REQUIRED");
      const canonical = await resolveCanonicalInput(root, q, c), all = await events(root, q, c);
      if (auth.task.effectId !== null || program.assignments.some(child => child.parentAssignmentId === assignment.id))
        reject("WORKFORCE_ORIGINAL_ATTEMPT_OR_DESCENDANTS_REQUIRE_OWNER_RECONCILIATION");
      const funding = canonical.funding.find(f => f.assignmentId === assignment.id);
      if (!funding) reject("WORKFORCE_ORIGINAL_FUNDING_REQUIRED");
      if (all.some(e => e.kind === "S6_INTENDED" && e.body.assignmentId === assignment.id))
        replacementRetirement = await retireKnownWorkforceCarveTx({ auth: root }, c, q.budget, assignment.id, funding.ref, key);
      else await releaseUnconsumedWorkforceCarveTx({ auth: root }, c, q.budget, assignment.id, funding.ref, key);
      const carves = canonical.funding.filter(f => f.status === "HELD" && f.assignmentId !== assignment.id).map(f => ({
        assignmentId: f.assignmentId, parentAssignmentId: program.assignments.find(a => a.id === f.assignmentId)!.parentAssignmentId,
        rootId: f.rootId, envelope: f.envelope }));
      carves.push({ assignmentId: input.replacementAssignmentId, parentAssignmentId: assignment.parentAssignmentId,
        rootId: assignment.rootId, envelope: replacementRetirement?.remainingEnvelope ?? funding.envelope });
      const recorded = await recordWorkforceCarvesTx({ auth: root }, c, q.budget, carves);
      await event(root, q, "FUNDING", "funding:replacement:" + key, {
        refs: recorded.filter(f => f.assignmentId === input.replacementAssignmentId).map(f => f.ref),
        originalReservation: q.budget.reservationRef, independentGrantsCreated: false,
        knownRetirementRef: replacementRetirement?.ref ?? null,
        retainedSpent: replacementRetirement?.record.spent ?? funding.spent }, c);
      action = { kind: "REASSIGN", replacementActorId: input.replacementActorId,
        replacementAssignmentId: input.replacementAssignmentId, reconciliationRef: null };
    } else if (input.action === "REVISE_TERMS") {
      const terms = input.revisedTerms;
      const compensation = await readWorkforceCompensationTx({ auth: root }, c, q.budget);
      if (compensation.records.some(record => record.assignmentId === assignment.id))
        reject("WORKFORCE_S5_ACCEPTED_COMPENSATION_TERMS_REQUIRE_FINANCIAL_RECONCILIATION");
      if ((await events(root, q, c)).some(e => e.kind === "S6_INTENDED" && e.body.assignmentId === assignment.id))
        reject("WORKFORCE_DISPATCHED_TERMS_REQUIRE_ORIGINAL_OWNER_RECONCILIATION");
      if (!terms || terms.revision !== assignment.terms.revision + 1 ||
          terms.compensation.unit !== auth.task.terms.compensation.unit ||
          exactQuantity(terms.compensation.value).compare(exactQuantity(auth.task.terms.compensation.value)) > 0 ||
          terms.subdelegation && (!auth.task.terms.subdelegation || !assignment.ceiling.allowSubdelegation) ||
          Date.parse(terms.expiresAt) <= Date.now() ||
          Date.parse(terms.expiresAt) > Math.min(Date.parse(q.original.outcome.deadline), Date.parse(auth.task.dueAt),
            Date.parse(assignment.ceiling.validUntil)))
        reject("WORKFORCE_REVISED_TERMS_EXCEED_ORIGINAL_ENVELOPE");
      const change = { taskId: assignment.taskId, terms };
      const ref = reference("workforce-terms", q.id + ":terms:" + key, change);
      await event(root, q, "TERM_CHANGE", "terms:" + key, { observation: { ...change, ref },
        authenticatedPrincipal: auth.actual, originalMeaningAndBudgetUnchanged: true }, c);
      action = { kind: "REVISE_TERMS", termChangeRef: ref };
    } else {
      const ref = reference("workforce-observation", q.id + ":" + key, { assignmentId: assignment.id,
        action: input.action, reason: input.reason ?? null, authenticatedPrincipal: auth.actual, at: now });
      await event(root, q, "STATUS_OBSERVATION", "status:" + key, { ref, authenticatedPrincipal: auth.actual, action: input.action }, c);
      if (["BLOCK", "RETURN", "DISPUTE"].includes(input.action))
        action = { kind: input.action as "BLOCK" | "RETURN" | "DISPUTE", observationRef: ref, reason: input.reason ?? "PARTICIPANT_REPORTED_OBSTACLE" };
      else action = { kind: input.action as "START" | "CANCEL" | "CONFIRM_CANCEL" | "EXPIRE" | "CLOSE", observationRef: ref };
    }
    let changed = await applyNativeCommand(root, q, program, assignment, auth.actorId, action, key, c,
      { authenticatedPrincipal: auth.actual, channel: "AUTHENTICATED_ORDINARY_API", action: input.action });
    if (input.action === "REASSIGN") {
      const old = changed.assignments.find(a => a.id === assignment.id)!;
      changed = await applyNativeCommand(root, q, changed, old, auth.actorId,
        { kind: "CLOSE", observationRef: replacementRetirement?.ref ??
          reference("S5", "unused-original:" + key, { originalAssignmentId: old.id, noPhysicalUse: true }) },
        "close-replaced:" + key, c, { originalAttemptNeverDispatched: replacementRetirement === null,
          originalAttemptKnownReconciled: replacementRetirement !== null,
          retainedSpent: replacementRetirement?.record.spent ?? null,
          originalReservationRetained: q.budget.reservationRef });
    }
    if (input.action === "REASSIGN" || input.action === "REVISE_TERMS" || input.action === "SUBDELEGATE") {
      const nextId = input.action === "REASSIGN" ? input.replacementAssignmentId : input.action === "SUBDELEGATE"
        ? `${q.id}:${input.refinement!.task.id}:1` : assignment.id;
      const next = changed.assignments.find(a => a.id === nextId)!;
      const offer = { assignmentId: next.id, actorId: next.actorId, terms: next.terms, termsDigest: next.termsDigest,
        originalDeadline: next.originalDeadline, originalReservation: q.budget.reservationRef, freshAcceptanceRequired: true };
      const ref = reference("workforce-offer", q.id + ":updated-offer:" + key, offer);
      await event(root, q, "OFFER", "updated-offer:" + key, { ref, offer, acceptanceImplied: false }, c);
      changed = await applyNativeCommand(root, q, changed, next, next.delegatorActorId,
        { kind: "OFFER", offerRef: ref }, "updated-offer:" + key, c, { authenticatedPrincipal: auth.actual, freshAcceptanceRequired: true });
    }
    const published = await publish(root, q, changed, c);
    if (["DELIVER", "VERIFY", "CLOSE"].includes(input.action))
      await recordWorkforceOutcomeExperienceTx(root, c, q.id, assignment.id);
    await event(root, q, "REQUEST", "request:" + key, { requestDigest: workforceDigest(input), authenticatedPrincipal: auth.actual,
      action: input.action, assignmentId: assignment.id, revision: changed.revision }, c);
    if (["ACCEPT", "START", "DELIVER", "RETURN", "VERIFY", "CLOSE"].includes(input.action))
      await enqueueWorkforceTx(root, q, "ADVANCE", "after:" + key, c,
        input.action === "ACCEPT" && Date.parse(auth.task.slot.startAt) > Date.now() ? auth.task.slot.startAt : undefined);
    return { id: q.id, status: published.status, revision: changed.revision, semanticReplay: false };
  });
  } catch (error) {
    // A refused mutation must leave the current fence durable by itself: no
    // later GET/reload may be the first writer of this exact P7 closure.
    if (error instanceof WorkforceRuntimeError && (error.status === 403 || error.status === 409)) {
      if (error.code === protectedChildRefusalCode)
        await persistWorkforceProtectedChildBinding(root, programId, error.detail)
          .catch(bindingError => { (error as { bindingError?: unknown }).bindingError = String(bindingError); });
      const fence = await tx(root, async c => {
        await portfolioLock(root, c);
        const current = await programRow(root, programId, c, true);
        if (!current.program) return null;
        const canonical = await resolveCanonicalInput(root, current, c);
        return recordWorkforceCurrentnessTx(root, current, canonical,
          checkWorkforceExecutionProgram(current.program, canonical), c);
      }).catch(fenceError => ({ fenceError: String(fenceError) }));
      if (fence && "fenceError" in fence) (error as { fenceError?: unknown }).fenceError = fence.fenceError;
    }
    throw error;
  }
}

export async function readWorkforceExecution(ctx: TenantContext, id: string) {
  const access = await tx(ctx, async c => {
    await activePrincipal(ctx, c);
    const row = (await c.query<WorkforceProgramRow>("SELECT * FROM finnor_os.w2_programs WHERE tenant_id=$1 AND id=$2 AND principal_id=$3",
      [ctx.tenantId, id, principal(ctx)])).rows[0];
    if (row) return { accountable: true, principalId: row.principal_id };
    const owner = (await c.query("SELECT finnor_os.w2_participant_access($1,NULL) principal_id", [id])).rows[0];
    if (!owner?.principal_id) reject("WORKFORCE_CONTEXT_UNAVAILABLE", 404);
    return { accountable: false, principalId: String(owner.principal_id) };
  });
  const root = rootContext({ tenant_id: ctx.tenantId, principal_id: access.principalId });
  // Release the scoped lookup before taking the root transaction. A one-client
  // pool and a queued principal revocation must not deadlock a private read.
  return tx(root, async c => {
    await portfolioLock(root, c);
    await activePrincipal(ctx, c);
    const row = await programRow(root, id, c, true);
    if (!access.accountable) {
        const rootClient = c, q = row;
        if (!q.program) reject("WORKFORCE_CONTEXT_UNAVAILABLE", 404);
        const canonical = await resolveCanonicalInput(root, q, rootClient);
        if (!await canExerciseAuthorityTx(ctx, { operation: "query", capability: "query:work", workId: q.work_id,
          resource: { type: "work", id: q.work_id }, risk: "low" }, rootClient))
          reject("WORKFORCE_CONTEXT_UNAVAILABLE", 404);
        const check = checkWorkforceExecutionProgram(q.program, canonical), bindings = await resolveActors(root, q, rootClient);
        await recordWorkforceCurrentnessTx(root, q, canonical, check, rootClient);
        const own = q.program.assignments.filter(assignment => bindings.some(binding => binding.actor.id === assignment.actorId &&
          binding.principalId === principal(ctx) && binding.actor.status === "CURRENT"));
        const affected = new Set(check.affectedAssignmentIds);
        const globallyFenced = check.issues.some(issue => issue.assignmentId === null);
        const assignments = own.filter(a => !globallyFenced && !affected.has(a.id)).map(assignment => ({
          assignment, task: workforceProgramGraph(q.program!).tasks.find(task => task.id === assignment.taskId)!,
        }));
        const definitions = await resolveNativeDefinitions(root, q, rootClient);
        const controls = await participantControls(ctx, q, assignments.map(value => value.assignment), bindings, definitions, rootClient);
        const reviews = await pendingReviews(ctx, q, check, bindings, rootClient);
        return { id: q.id, workId: q.work_id, status: globallyFenced || own.length !== assignments.length ? "FENCED" : q.status,
          revision: q.revision, assignments, reviews, view: "RECIPIENT_SCOPED", originalDeadline: q.original.outcome.deadline,
          requestedWork: await requestedWork(ctx, q, check, bindings, rootClient),
          availableActions: controls,
          sourceQualification: "ORDINARY_NATIVE_RECORDS_UNADMITTED", protectedReceipt: null, executionAuthorityGranted: false,
          gates: { nativeRecords: true, protectedAdmission: false, genuineHumanQualified: false, fieldEconomics: "UNKNOWN" } };
    }
    const canonical = await resolveCanonicalInput(ctx, row, c);
    const check = row.program ? checkWorkforceExecutionProgram(row.program, canonical) : null;
    const currentness = check ? await recordWorkforceCurrentnessTx(root, row, canonical, check, c) : null;
    const quarantine = (await c.query(`SELECT count(*)::int count FROM finnor_os.jobs
      WHERE tenant_id=$1 AND type='run_workforce_execution_v1' AND payload->>'programId'=$2 AND status='quarantined'`,
      [ctx.tenantId, id])).rows[0].count;
    const bindings = await resolveActors(ctx, row, c);
    const definitions = await resolveNativeDefinitions(root, row, c);
    const controls = await participantControls(ctx, row, row.program?.assignments ?? [], bindings, definitions, c);
    const compensation = await readWorkforceCompensationTx({ auth: root }, c, row.budget);
    return { id: row.id, workId: row.work_id, status: check && !check.valid ? "FENCED" : row.status, revision: row.revision,
      program: row.program, compileResult: row.compile_result, currentCheck: check, view: "ACCOUNTABLE_ROOT", compensation,
      currentness: currentness ?? (row.program ? workforceP7Closure(row.program,
        check?.issues.flatMap(issue => issue.assignmentId ? [issue.assignmentId] : row.program!.assignments.map(a => a.id)) ?? []) : null),
      nativeObservations: (await events(ctx, row, c)).filter(value => value.kind === "NATIVE_PHASE_METER").map(value => value.body),
      reviews: check ? await pendingReviews(ctx, row, check, bindings, c, definitions, controls) : [],
      requestedWork: check ? await requestedWork(ctx, row, check, bindings, c) : [],
      budgetRef: row.budget.ref, originalDeadline: row.original.outcome.deadline, lastError: row.last_error,
      recovery: { required: quarantine > 0, quarantinedJobs: quarantine, readOnlyPossibleAttemptRecovery: true },
      availableActions: controls,
      protectedReceipt: null, executionAuthorityGranted: false,
      gates: { nativeRecords: true, protectedAdmission: false, genuineHumanQualified: false, fieldEconomics: "UNKNOWN" } };
  });
}
export async function listWorkforceExecutions(ctx: TenantContext, workId: string) {
  return tx(ctx, async c => {
    await activePrincipal(ctx, c);
    const rows = (await c.query(`SELECT id,work_id AS "workId",status,revision FROM finnor_os.w2_programs
      WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 ORDER BY created_at,id LIMIT 129`,
    [ctx.tenantId, principal(ctx), workId])).rows;
    const received = (await c.query(`SELECT id,work_id AS "workId" FROM finnor_os.w2_participant_programs($1)`, [workId])).rows;
    if (rows.length > 128 || received.length > 128) reject("WORKFORCE_WORK_PROGRAMME_PROFILE_EXCEEDED");
    let originalInput: { workInputId: string; originalDeadline: string } | null = null;
    const work = (await c.query(`SELECT i.id,w.initial_instruction FROM finnor_os.works w
      JOIN finnor_os.work_inputs i ON i.tenant_id=w.tenant_id AND i.work_id=w.id AND i.instruction_text=w.initial_instruction
      WHERE w.tenant_id=$1 AND w.id=$2 AND w.created_by=$3 AND i.created_by=$3 ORDER BY i.created_at,i.id LIMIT 1`,
      [ctx.tenantId, workId, principal(ctx)])).rows[0];
    if (work && await canExerciseAuthorityTx(ctx, { operation: "query", capability: "query:work", workId,
        resource: { type: "work", id: workId }, risk: "low" }, c)) {
      try {
        const parsed = nativeWorkforceOriginalSchema.safeParse(JSON.parse(work.initial_instruction));
        if (parsed.success) originalInput = { workInputId: work.id, originalDeadline: parsed.data.outcome.deadline };
      } catch { /* A non-workforce Work is not eligible for this compiler. */ }
    }
    return { data: [...new Map([...rows, ...received].map(row => [row.id, row])).values()], complete: true, workId, originalInput };
  });
}

function participantActionCandidates(ctx: TenantContext, q: WorkforceProgramRow, assignment: WorkforceAssignment,
  bindings: ResolvedActor[], definitions: Awaited<ReturnType<typeof resolveNativeDefinitions>>) {
  const actual = principal(ctx), root = actual === q.principal_id;
  const recipient = bindings.find(binding => binding.actor.id === assignment.actorId);
  const isRecipient = recipient?.principalId === actual, task = definitions.tasks.find(t => t.id === assignment.taskId)!;
  const criterion = definitions.criteria.find(value => value.id === task.criterionId)!;
  const checker = bindings.find(binding => binding.actor.id === criterion.checkerActorId);
  const state = assignment.state.kind, actions: string[] = [];
  if (isRecipient) {
    if (state === "OFFERED") actions.push("ACCEPT", "DECLINE");
    if (state === "ACCEPTED") actions.push("START", "RETURN");
    if (state === "IN_PROGRESS") actions.push("BLOCK", "DELIVER", "RETURN");
    if (state === "BLOCKED") actions.push("RETURN");
    if (["ACCEPTED", "IN_PROGRESS", "BLOCKED"].includes(state) && assignment.terms.subdelegation && assignment.ceiling.allowSubdelegation)
      actions.push("SUBDELEGATE");
    if (state === "DELIVERED") actions.push("DISPUTE");
    if (state === "CANCEL_REQUESTED") actions.push("CONFIRM_CANCEL");
    if (recipient && ["INTERNAL_HUMAN", "EXTERNAL_PROFESSIONAL", "PROVIDER"].includes(recipient.actor.kind) &&
        q.program?.history.some(command => command.assignmentId === assignment.id && command.action.kind === "ACCEPT") &&
        state !== "CLOSED") actions.push("RELEASE_LABOR");
  } else if (root && task.assignmentMode === "INTERNAL_AUTHORIZED" && state === "OFFERED") actions.push("ACCEPT");
  if (root) {
    if (!["CLOSED", "CANCELLED_WITH_RESIDUAL_EXPOSURE"].includes(state)) actions.push("CANCEL");
    if (state === "VERIFIED") actions.push("CLOSE");
    if (["PROPOSED", "OFFERED", "ACCEPTED", "BLOCKED", "DISPUTED"].includes(state)) actions.push("REVISE_TERMS");
    if (["RETURNED", "DECLINED", "EXPIRED", "BLOCKED", "CANCELLED_WITH_RESIDUAL_EXPOSURE"].includes(state)) actions.push("REASSIGN");
  }
  if (["DELIVERED", "DISPUTED"].includes(state) && checker?.principalId === actual && assignment.actorId !== checker.actor.id)
    actions.push("VERIFY");
  return { actions, isRecipient };
}
async function participantControls(ctx: TenantContext, q: WorkforceProgramRow, assignments: WorkforceAssignment[],
  bindings: ResolvedActor[], definitions: Awaited<ReturnType<typeof resolveNativeDefinitions>>, c: PoolClient) {
  const capabilityFor = (action: string, isRecipient: boolean) =>
    ["CANCEL", "EXPIRE", "CLOSE", "REASSIGN", "REVISE_TERMS", "SUBDELEGATE"].includes(action) ||
      action === "ACCEPT" && !isRecipient ? "action:workforce_assign_contract" : "action:workforce_respond_contract";
  const plans = assignments.map(assignment => ({ assignment,
    ...participantActionCandidates(ctx, q, assignment, bindings, definitions) }));
  const requests = plans.flatMap(plan => [...new Set(plan.actions.map(action => capabilityFor(action, plan.isRecipient)))]
    .map(capability => ({ operation: "action" as const, capability, workId: q.work_id,
      resource: { type: "workforce_assignment", id: plan.assignment.id }, risk: "low" as const })));
  const allowed = await canExerciseWorkforceAuthorityBatchTx(ctx, requests, c);
  const decisions = new Map(requests.map((request, index) => [
    request.resource.id + "\0" + request.capability, allowed[index] === true,
  ]));
  return Object.fromEntries(plans.map(plan => [plan.assignment.id, plan.actions.filter(action =>
    decisions.get(plan.assignment.id + "\0" + capabilityFor(action, plan.isRecipient)) === true)]));
}

/** Return only work actually requested by this current participant. A caller
 * does not gain a parent/sibling view merely by receiving a nested assignment. */
async function requestedWork(ctx: TenantContext, q: WorkforceProgramRow,
  check: ReturnType<typeof checkWorkforceExecutionProgram>, bindings: ResolvedActor[], c: PoolClient) {
  if (!q.program?.taskCreations?.length || check.issues.some(issue => issue.assignmentId === null)) return [];
  const actual = new Set(bindings.filter(binding => binding.principalId === principal(ctx) &&
    binding.actor.status === "CURRENT").map(binding => binding.actor.id));
  const affected = new Set(check.affectedAssignmentIds), all = await events(rootContext(q), q, c);
  return (q.program.taskCreations ?? []).filter(fact => actual.has(fact.actorId) &&
    !affected.has(fact.parentAssignmentId)).flatMap(fact => {
    const assignment = q.program!.assignments.filter(a => a.taskId === fact.task.id).sort((a, b) => b.attempt - a.attempt)[0];
    if (!assignment) return [];
    const delivery = !affected.has(assignment.id) ? all.filter(e => e.kind === "DELIVERY" &&
      (e.body.observation as { assignmentId?: string; termsDigest?: string })?.assignmentId === assignment.id &&
      (e.body.observation as { termsDigest?: string }).termsDigest === assignment.termsDigest).at(-1) : undefined;
    const verification = delivery ? all.filter(e => e.kind === "VERIFICATION" &&
      (e.body.observation as { assignmentId?: string })?.assignmentId === assignment.id &&
      workforceDigest((e.body.observation as { deliveryRef?: ExperimentRef }).deliveryRef) ===
        workforceDigest((delivery.body.observation as { ref: ExperimentRef }).ref)).at(-1) : undefined;
    return [{ taskCreationRef: fact.ref, parentAssignmentId: fact.parentAssignmentId, assignmentId: assignment.id,
      taskId: assignment.taskId, state: assignment.state.kind, deliverable: assignment.terms.deliverable,
      result: delivery ? { value: delivery.body.value,
        evidenceRefs: (delivery.body.observation as { evidenceRefs: ExperimentRef[] }).evidenceRefs,
        verificationResult: (verification?.body.observation as { result?: string } | undefined)?.result ?? "UNKNOWN" } : null }];
  });
}

async function pendingReviews(ctx: TenantContext, q: WorkforceProgramRow,
  check: ReturnType<typeof checkWorkforceExecutionProgram>, bindings: ResolvedActor[], c: PoolClient,
  resolved?: Awaited<ReturnType<typeof resolveNativeDefinitions>>, controls?: Record<string, string[]>) {
  if (!q.program || check.issues.some(issue => issue.assignmentId === null)) return [];
  if (!q.program.assignments.some(assignment => ["DELIVERED", "DISPUTED"].includes(assignment.state.kind))) return [];
  const definitions = resolved ?? await resolveNativeDefinitions(rootContext(q), q, c);
  const candidates = q.program.assignments.filter(assignment => ["DELIVERED", "DISPUTED"].includes(assignment.state.kind) &&
    !check.affectedAssignmentIds.includes(assignment.id) && definitions.criteria.some(criterion =>
      criterion.id === definitions.tasks.find(task => task.id === assignment.taskId)?.criterionId &&
      bindings.some(binding => binding.actor.id === criterion.checkerActorId && binding.actor.status === "CURRENT" &&
        binding.principalId === principal(ctx) && binding.actor.id !== assignment.actorId)));
  if (!candidates.length) return [];
  controls ??= await participantControls(ctx, q, candidates, bindings, definitions, c);
  const all = await events(rootContext(q), q, c), reviews = [];
  for (const assignment of candidates) {
    if (!controls[assignment.id]?.includes("VERIFY")) continue;
    const criterion = definitions.criteria.find(value =>
      value.id === definitions.tasks.find(task => task.id === assignment.taskId)!.criterionId)!;
    const delivery = all.filter(e => e.kind === "DELIVERY" &&
      (e.body.observation as { assignmentId?: string })?.assignmentId === assignment.id).at(-1);
    if (delivery) reviews.push({ assignmentId: assignment.id, criterionId: criterion.id,
      termsDigest: assignment.termsDigest, termsRevision: assignment.terms.revision,
      acceptance: criterion.acceptance, deliveryValue: delivery.body.value });
  }
  return reviews;
}

/** The generic queue keeps an expired reconcilable delivery quarantined. Only
 * its original authenticated owner can request a new, read-only reconciliation
 * job. It does not reset the root, deadline, S5 envelope or earlier attempt. */
export async function reconcileWorkforceExecution(ctx: TenantContext, id: string,
  input: { idempotencyKey: string; expectedRevision: number }) {
  if (!/^[a-zA-Z0-9:_-]{1,160}$/.test(input.idempotencyKey) ||
      !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) reject("WORKFORCE_INVALID_RECOVERY_INPUT", 400);
  return tx(ctx, async c => {
    await portfolioLock(ctx, c);
    const q = await programRow(ctx, id, c, true);
    await originalWork(ctx, q.work_id, q.work_input_id, c);
    const prior = (await events(ctx, q, c)).find(e => e.event_id === "reconcile-request:" + input.idempotencyKey);
    if (prior) {
      if (prior.body.requestDigest !== workforceDigest(input)) reject("WORKFORCE_RECOVERY_IDEMPOTENCY_CONFLICT");
      return { id, revision: q.revision, jobId: prior.body.jobId, semanticReplay: true };
    }
    if (input.expectedRevision !== q.revision) reject("WORKFORCE_PROGRAM_REVISION_CHANGED");
    const jobs = (await c.query(`SELECT id,status,claim_fence FROM finnor_os.jobs WHERE tenant_id=$1
      AND type='run_workforce_execution_v1' AND payload->>'programId'=$2 ORDER BY run_at,id LIMIT 129 FOR UPDATE`,
      [ctx.tenantId, id])).rows;
    if (jobs.length > 128 || jobs.some(job => ["queued", "running"].includes(job.status)))
      reject("WORKFORCE_ORIGINAL_DELIVERY_STILL_ACTIVE_OR_PROFILE_EXCEEDED");
    if (!jobs.some(job => job.status === "quarantined")) reject("WORKFORCE_QUARANTINED_ORIGINAL_REQUIRED");
    if ((await events(ctx, q, c)).filter(e => e.kind === "RECONCILIATION_REQUEST").length >= 16)
      reject("WORKFORCE_ORIGINAL_RECONCILIATION_LIMIT");
    const jobId = await enqueueWorkforceTx(ctx, q, "RECONCILE", "reconcile:" + input.idempotencyKey, c);
    await event(ctx, q, "RECONCILIATION_REQUEST", "reconcile-request:" + input.idempotencyKey, {
      requestDigest: workforceDigest(input), jobId, originalJobs: jobs, originalRoot: q.work_id,
      originalReservation: q.budget.reservationRef, originalDeadline: q.original.outcome.deadline,
      possibleAttemptReplayAllowed: false, authenticatedPrincipal: principal(ctx) }, c);
    return { id, revision: q.revision, jobId, semanticReplay: false };
  });
}
