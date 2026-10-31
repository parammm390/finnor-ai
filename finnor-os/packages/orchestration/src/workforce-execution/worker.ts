import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { JobExecutionContext } from "../../../../apps/worker/src/queue";
import type { AllocationEnvelope, ExperimentRef, TenantContext } from "@finnor/shared-types";
import { compileWorkforceExecutionProgram, checkWorkforceExecutionProgram, checkWorkforceUse, workforceDigest,
  workforceProgramGraph, workforceCanonicalGraph,
  type WorkforceAssignment, type WorkforceExecutionProgram } from "../../../workforce/src/execution-program/index";
import { launchIsolatedNodeExecutor } from "../../../governed-execution/src/executor";
import { workforceLocalExecutorScript as script } from "../../../governed-execution/src/workforce-local-attempt";
import { reserveWorkforceUseTx, observeWorkforceUseTx, recordWorkforceCarvesTx } from "../../../private-equity/src/workforce-allocation";
import { readWorkforceCompensationTx } from "../../../private-equity/src/workforce-compensation";
import { admitWorkforceCompensationAtFinancialBrokerBoundary, ensureWorkforceCompensationPaymentRequestTx,
  recordWorkforceCompensationBoundaryObservationTx,
  recordWorkforceCompensationInternalDischargeTx } from "../../../private-equity/src/workforce-compensation-payment";
import { persistEconomicRecordTx } from "../../../private-equity/src/economic-store";
import { recordWorkforceOutcomeExperienceTx } from "../../../capability-evolution/src/workforce-experience";
import { applyNativeCommand, enqueueWorkforceTx } from "./runtime";
import { workforceComputationSchema, WorkforceRuntimeError } from "./contracts";
import { persistWorkforceProtectedChildBinding, protectedChildRefusalCode,
  refuseWorkforceProtectedChildTx } from "./protected-child";
import { workforceP7Closure } from "./dependencies";
import { exactQuantity } from "../../../workforce/src/execution-program/exact";
import { evidence, event, events, portfolioLock, programRow, publish, reference, reject,
  resolveCanonicalInput, resolveNativeDefinitions, rootContext, tx, type WorkforceProgramRow } from "./store";

async function liveClaim(ctx: TenantContext, q: WorkforceProgramRow, execution: Readonly<JobExecutionContext>, c: PoolClient) {
  const row = (await c.query(`SELECT id FROM finnor_os.jobs WHERE tenant_id=$1 AND id=$2 AND type='run_workforce_execution_v1'
    AND protocol_version=1 AND status='running' AND claim_token=$3 AND claim_fence=$4
    AND lease_expires_at>clock_timestamp()`, [ctx.tenantId, execution.jobId, execution.claimToken, execution.claimFence])).rows[0];
  if (!row || execution.tenantId !== q.tenant_id || q.principal_id !== ctx.userId) reject("WORKFORCE_PHYSICAL_CLAIM_FENCED");
}
function operationCeiling(q: WorkforceProgramRow, demand?: AllocationEnvelope[]) {
  const resources = q.budget.resources;
  let counter = false;
  const result = resources.map(r => {
    if (r.unit !== "workforce-operation") {
      // Local computation spends only its operation counter. A promised
      // paycheck is not local computation spending power: payable cash (and
      // every other non-counter coordinate) stays untouched by this schedule.
      return { resourceId: r.resourceId, quantities: Array(r.horizon.periods + 1).fill("0") };
    }
    const values = demand?.find(e => e.resourceId === r.resourceId)?.quantities;
    const period = Math.floor((Date.now() - Date.parse(r.horizon.startAt)) / r.horizon.periodMs);
    const available = values?.[period] ?? (demand ? "0" : "1");
    const selected = values?.some(v => exactQuantity(v).compare(exactQuantity("0")) > 0) || !demand;
    if (selected) {
      if (period < 0 || period > r.horizon.periods || exactQuantity(available).compare(exactQuantity("1")) < 0)
        reject("WORKFORCE_SUPPORTED_OPERATION_CURRENT_COUNTER_BUDGET_EXHAUSTED");
      counter = true;
    }
    return { resourceId: r.resourceId, quantities: Array.from({ length: r.horizon.periods + 1 },
      (_, i) => selected && i === period ? available : "0") };
  });
  if (!counter) reject("WORKFORCE_SUPPORTED_OPERATION_METER_UNAVAILABLE");
  return result;
}
function observedOperations(q: WorkforceProgramRow, envelopes: AllocationEnvelope[], attributedAt: string) {
  return envelopes.filter(e => q.budget.resources.find(r => r.resourceId === e.resourceId)?.unit === "workforce-operation")
    .map(e => {
      const period = Math.floor((Date.parse(attributedAt) - Date.parse(e.horizon.startAt)) / e.horizon.periodMs);
      return { resourceId: e.resourceId, quantities: e.quantities.map((value, index) =>
        index === period && value !== "0" ? "1" : "0") };
    });
}
async function meter(ctx: TenantContext, q: WorkforceProgramRow, c: PoolClient, key: string, payload: Record<string, unknown>) {
  const result = await persistEconomicRecordTx({ auth: ctx }, { kind: "COMPUTE", payload: { schema: "finnor.workforce-physical-attribution.v1",
    workId: q.work_id, programmeId: q.id, originalBudget: q.budget.ref, ...payload,
    monetaryCost: null, pricebookRef: null, childCpuMicros: null, totalMemoryBytes: null,
    humanSupervisionSeconds: null, economicGain: null, counterfactual: "NOT_IDENTIFIED", sourceClass: q.original.sourceClass,
    gaps: ["CHILD_CPU", "TOTAL_MEMORY", "MONEY", "HUMAN_SUPERVISION", "FIELD_COUNTERFACTUAL"],
    protectedAdmission: false, capabilityPromotion: false }, rightsRef: q.budget.resources[0]!.rightsRef,
    idempotencyKey: "w2:" + q.id + ":" + key, validAt: new Date().toISOString(), horizon: "H0",
    uncertainty: "ORDINARY_CONTROLLED_NATIVE_OBSERVATION_NOT_FIELD_ECONOMICS", dependencies: [q.budget.ref] }, c);
  await event(ctx, q, "NATIVE_PHASE_METER", "native-meter:" + key, { economicRecordRef: result.record.ref,
    ...payload, originalRoot: q.work_id, originalBudget: q.budget.ref,
    cpuScope: "LOCAL_SUPERVISOR_PROCESS_ONLY_NOT_CHILD_OR_DATABASE",
    monetaryCost: { kind: "UNKNOWN", reason: "NO_LAWFUL_PRICEBOOK_OR_BILLING_OBSERVATION" },
    humanSupervision: { kind: "UNKNOWN", reason: "NO_GENUINE_HUMAN_TIME_OBSERVATION" },
    admission: "UNADMITTED", economicImprovementEstablished: false }, c);
  return result;
}
async function outcomeExperience(ctx: TenantContext, q: WorkforceProgramRow, assignmentId: string, c: PoolClient) {
  await recordWorkforceOutcomeExperienceTx(ctx, c, q.id, assignmentId);
}
async function compile(ctx: TenantContext, id: string, execution: Readonly<JobExecutionContext>) {
  const started = performance.now(), cpu = process.cpuUsage();
  const checkpoint = (phase: string, detail: Record<string, unknown> = {}) => console.info(JSON.stringify({
    event: "W2_NATIVE_COMPILE_CHECKPOINT", programmeId: id, phase, elapsedMs: performance.now() - started,
    transactionCommitted: false, diagnosticOnly: true, ...detail }));
  await tx(ctx, async c => {
    await portfolioLock(ctx, c);
    const q = await programRow(ctx, id, c, true); await liveClaim(ctx, q, execution, c);
    if (q.program) return;
    if (Date.now() >= Date.parse(q.original.outcome.deadline)) reject("WORKFORCE_ORIGINAL_DEADLINE_EXPIRED");
    const use = await reserveWorkforceUseTx({ auth: ctx }, c, q.budget, { assignmentId: q.id,
      operationKey: q.id + ":compile:" + execution.deliveryAttemptId, decisionDigest: q.original_digest, schedules: operationCeiling(q) });
    await event(ctx, q, "COMPILE_INTENDED", "compile:" + execution.deliveryAttemptId, { jobId: execution.jobId,
      claimFence: execution.claimFence, originalRoot: q.work_id, consumptionRef: use.consumption.ref }, c);
    const canonical = await resolveCanonicalInput(ctx, q, c);
    checkpoint("MATCHING_BEGIN");
    const matchingStarted = performance.now(), matchingCpu = process.cpuUsage();
    const built = compileWorkforceExecutionProgram(canonical);
    checkpoint("MATCHING_END", { status: built.status, assignments: built.program?.assignments.length ?? 0 });
    await meter(ctx, q, c, "matching:" + execution.deliveryAttemptId, { phase: "MATCHING", status: built.status,
      elapsedMs: performance.now() - matchingStarted, supervisorCpu: process.cpuUsage(matchingCpu), metrics: built.metrics });
    await c.query("UPDATE finnor_os.w2_programs SET compile_result=$3::jsonb,claim_token=$4,claim_fence=$5 WHERE tenant_id=$1 AND id=$2",
      [ctx.tenantId, q.id, JSON.stringify(built), execution.claimToken, execution.claimFence]);
    if (!built.program) {
      await c.query("UPDATE finnor_os.w2_programs SET status='BLOCKED',last_error=$3 WHERE tenant_id=$1 AND id=$2",
        [ctx.tenantId, q.id, built.status]);
      await observeWorkforceUseTx({ auth: ctx }, c, q.budget, { consumptionId: use.consumption.ref.id,
        observationKey: "compile:" + execution.deliveryAttemptId, actual: observedOperations(q, use.consumption.envelope, use.consumption.createdAt),
        evidenceRef: null, possibleEffect: false, meterGaps: q.budget.resources.some(r => r.unit !== "workforce-operation") ? ["NON_COUNTER_RESOURCE_ACTUAL_UNKNOWN"] : [] });
      await meter(ctx, q, c, "compile:" + execution.deliveryAttemptId, { phase: "COMPILE", status: built.status,
        elapsedMs: performance.now() - started, supervisorCpu: process.cpuUsage(cpu), metrics: built.metrics });
      return;
    }
    const independentlyResolved = await resolveCanonicalInput(ctx, q, c);
    const checkingStarted = performance.now(), checkingCpu = process.cpuUsage();
    checkpoint("INDEPENDENT_GRAPH_CHECK_BEGIN");
    const originalCheck = checkWorkforceExecutionProgram(built.program, independentlyResolved);
    checkpoint("INDEPENDENT_GRAPH_CHECK_END", { valid: originalCheck.valid });
    await meter(ctx, q, c, "graph-check:" + execution.deliveryAttemptId, { phase: "INDEPENDENT_GRAPH_CHECK",
      status: originalCheck.valid ? "VALID" : "INVALID", elapsedMs: performance.now() - checkingStarted,
      supervisorCpu: process.cpuUsage(checkingCpu), checked: originalCheck.checked });
    if (!originalCheck.valid) reject("WORKFORCE_PROPOSED_GRAPH_INDEPENDENTLY_REJECTED", 409, originalCheck);
    const carves = await recordWorkforceCarvesTx({ auth: ctx }, c, q.budget, built.program.assignments.map(a => ({
      assignmentId: a.id, parentAssignmentId: a.parentAssignmentId, rootId: a.rootId,
      envelope: canonical.outcome.tasks.find(t => t.id === a.taskId)!.demand })));
    await event(ctx, q, "FUNDING", "funding:initial", { refs: carves.map(v => v.ref), originalReservation: q.budget.reservationRef,
      independentGrantsCreated: false }, c);
    checkpoint("ORIGINAL_FUNDING_RECORDED", { carves: carves.length });
    const offeredCanonical = await resolveCanonicalInput(ctx, q, c);
    let program = built.program;
    for (const [index, assignment] of program.assignments.entries()) {
      const offer = { assignmentId: assignment.id, actorId: assignment.actorId, terms: assignment.terms,
        termsDigest: assignment.termsDigest, deadline: assignment.originalDeadline, rootId: assignment.rootId,
        originalReservation: q.budget.reservationRef, disclosure: canonical.outcome.tasks.find(t => t.id === assignment.taskId)!.context };
      const offerRef = reference("workforce-offer", q.id + ":" + assignment.id, offer);
      await event(ctx, q, "OFFER", "offer:" + assignment.id, { ref: offerRef, offer, acceptanceImplied: false }, c);
      program = await applyNativeCommand(ctx, q, program, assignment, assignment.delegatorActorId,
        { kind: "OFFER", offerRef }, "offer:" + assignment.id, c,
        { issuer: "REGISTERED_NATIVE_COMPILER", accountablePrincipal: q.principal_id }, offeredCanonical);
      if ((index + 1) % 128 === 0 || index + 1 === program.assignments.length)
        checkpoint("OFFERS_CHECKED_PREFIX", { offers: index + 1 });
    }
    // The authenticated original may legitimately assign internal machine work.
    // This is an institutional disposition, never voluntary human acceptance.
    let institutionalDispositions = 0;
    for (const assignment of program.assignments) {
      const task = offeredCanonical.outcome.tasks.find(t => t.id === assignment.taskId)!;
      const actor = offeredCanonical.actors.find(a => a.id === assignment.actorId)!;
      if (task.assignmentMode !== "INTERNAL_AUTHORIZED" ||
          !["DETERMINISTIC_SERVICE", "MODEL_AGENT", "COMPUTATIONAL_CELL"].includes(actor.kind)) continue;
      const observation = { assignmentId: assignment.id, actorId: assignment.actorId, mode: "INTERNAL_AUTHORIZED" as const,
        source: "NATIVE_INSTITUTIONAL_ASSIGNMENT" as const, decision: "ACCEPT" as const,
        termsDigest: assignment.termsDigest, termsRevision: assignment.terms.revision,
        at: new Date().toISOString(), revokedAt: null };
      const ref = reference("workforce-institution", q.id + ":internal:" + assignment.id, observation);
      await event(ctx, q, "DISPOSITION", "internal:" + assignment.id, {
        observation: { ...observation, ref }, authenticatedPrincipal: q.principal_id,
        originalInstitutionalInstruction: q.work_input_id, voluntaryHumanResponseSimulated: false }, c);
      offeredCanonical.dispositions.push({ ...observation, ref });
      program = await applyNativeCommand(ctx, q, program, assignment, assignment.delegatorActorId,
        { kind: "ACCEPT", dispositionRef: ref }, "internal-accept:" + assignment.id, c,
        { issuer: "AUTHENTICATED_ORIGINAL_INTERNAL_INSTITUTIONAL_ASSIGNMENT", originalInput: q.work_input_id }, offeredCanonical);
      institutionalDispositions++;
      if (institutionalDispositions % 128 === 0) checkpoint("INSTITUTIONAL_DISPOSITIONS_CHECKED_PREFIX", { institutionalDispositions });
    }
    checkpoint("INSTITUTIONAL_DISPOSITIONS_CHECKED_ALL", { institutionalDispositions });
    await publish(ctx, q, program, c);
    if (built.status === "PARTIAL") await c.query("UPDATE finnor_os.w2_programs SET status='PARTIAL' WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, q.id]);
    await observeWorkforceUseTx({ auth: ctx }, c, q.budget, { consumptionId: use.consumption.ref.id,
      observationKey: "compile:" + execution.deliveryAttemptId, actual: observedOperations(q, use.consumption.envelope, use.consumption.createdAt),
      evidenceRef: null, possibleEffect: false, meterGaps: q.budget.resources.some(r => r.unit !== "workforce-operation") ? ["NON_COUNTER_RESOURCE_ACTUAL_UNKNOWN"] : [] });
    await meter(ctx, q, c, "compile:" + execution.deliveryAttemptId, { phase: "COMPILE", status: built.status,
      elapsedMs: performance.now() - started, supervisorCpu: process.cpuUsage(cpu), metrics: built.metrics });
    await liveClaim(ctx, q, execution, c);
    if (program.assignments.some(a => a.state.kind === "ACCEPTED"))
      await enqueueWorkforceTx(ctx, q, "ADVANCE", "standing-internal-assignments", c);
  });
  checkpoint("COMPILE_TRANSACTION_COMMITTED", { transactionCommitted: true });
}

async function executeAssignment(ctx: TenantContext, id: string, assignmentId: string, execution: Readonly<JobExecutionContext>,
  recoveryOnly = false) {
  const prepared = await tx(ctx, async c => {
    await portfolioLock(ctx, c);
    const q = await programRow(ctx, id, c, true); await liveClaim(ctx, q, execution, c);
    const program = q.program!, assignment = program.assignments.find(a => a.id === assignmentId)!;
    const definitions = await resolveNativeDefinitions(ctx, q, c);
    const computation = workforceComputationSchema.parse(definitions.operations.find(op => op.taskId === assignment.taskId)?.computation);
    if (computation.kind === "HUMAN_JUDGMENT" || computation.kind === "PARTICIPANT_INPUT") return null;
    const previous = (await events(ctx, q, c)).find(e => e.event_id === "s6-intent:" + assignmentId);
    if (previous) {
      const all = await events(ctx, q, c);
      const observed = all.find(e => e.event_id === "s6-result:" + assignmentId);
      if (!observed && !all.some(e => e.event_id === "recovery:" + assignmentId)) {
        const observationRef = reference("S6", q.id + ":unknown:" + assignmentId, { originalIntent: previous.body, recovery: "READ_ONLY" });
        const blocked = await applyNativeCommand(ctx, q, program, assignment, q.principal_id,
          { kind: "BLOCK", observationRef, reason: "ORIGINAL_S6_ATTEMPT_OBSERVATION_UNAVAILABLE" },
          "unknown:" + assignmentId, c, { physicalClaim: execution.claimFence, readOnlyRecovery: true, newAttemptPermitted: false });
        await publish(ctx, q, blocked, c);
        await observeWorkforceUseTx({ auth: ctx }, c, q.budget, { consumptionId: (previous.body.consumptionRef as ExperimentRef).id,
          observationKey: "recovery:" + assignmentId, actual: [], evidenceRef: null, possibleEffect: false,
          meterGaps: ["ORIGINAL_ISOLATED_ATTEMPT_OUTCOME_AND_RESOURCE_USE_UNKNOWN"] });
        await event(ctx, q, "READ_ONLY_RECOVERY", "recovery:" + assignmentId, { assignmentId, originalIntent: previous.body,
          originalRoot: q.work_id, originalDeadline: q.original.outcome.deadline, newAttemptPermitted: false,
          externalEffectAuthority: false }, c);
        await outcomeExperience(ctx, q, assignmentId, c);
      }
      return null;
    }
    if (recoveryOnly) return null;
    const canonical = await resolveCanonicalInput(ctx, q, c), checked = checkWorkforceUse(program, assignmentId, canonical);
    const acceptedCanStart = assignment.state.kind === "ACCEPTED" &&
      !checked.affectedAssignmentIds.includes(assignmentId) &&
      !checked.issues.some(issue => issue.boundary === "USE" && issue.code !== "NOT_IN_PROGRESS" &&
        (issue.assignmentId === null || issue.assignmentId === assignmentId));
    if (!checked.allowed && !acceptedCanStart) {
      await event(ctx, q, "USE_FENCED", "fenced:" + execution.deliveryAttemptId + ":" + assignmentId,
        { assignmentId, check: checked, obligationsRetained: true,
          p7: workforceP7Closure(program, checked.issues.flatMap(issue =>
            issue.assignmentId ? [issue.assignmentId] : program.assignments.map(a => a.id))) }, c);
      return null;
    }
    const task = workforceCanonicalGraph(canonical).tasks.find(t => t.id === assignment.taskId)!;
    if (task.effectId !== null || task.ceiling.effects.length)
      await refuseWorkforceProtectedChildTx(ctx, q, program, assignment, task, canonical, c);
    const use = await reserveWorkforceUseTx({ auth: ctx }, c, q.budget, { assignmentId,
      operationKey: q.id + ":execute:" + assignmentId,
      schedules: operationCeiling(q, canonical.funding.find(f => f.assignmentId === assignmentId)!.directReserved),
      decisionDigest: workforceDigest({ taskId: task.id, assignmentId, computation, termsDigest: assignment.termsDigest }) });
    if (use.replay) reject("WORKFORCE_ORIGINAL_S6_INTENT_REQUIRES_READ_ONLY_RECOVERY");
    let current = program;
    if (assignment.state.kind === "ACCEPTED") {
      const observationRef = reference("workforce-observation", q.id + ":start:" + assignmentId,
        { assignmentId, recipientActorId: assignment.actorId, physicalClaim: execution.claimFence });
      current = await applyNativeCommand(ctx, q, current, assignment, assignment.actorId,
        { kind: "START", observationRef }, "start:" + assignmentId, c,
        { issuer: "ACCEPTED_BOUNDED_MACHINE_CONTRACT", jobId: execution.jobId, recipient: assignment.actorId });
      await publish(ctx, q, current, c);
    }
    const beforeDispatch = checkWorkforceUse(current, assignmentId, await resolveCanonicalInput(ctx, q, c));
    if (!beforeDispatch.allowed) reject("WORKFORCE_CURRENT_S6_BOUNDARY_FENCED", 409, beforeDispatch);
    await event(ctx, q, "S6_INTENDED", "s6-intent:" + assignmentId, { assignmentId, consumptionRef: use.consumption.ref,
      originalRoot: q.work_id, originalDeadline: q.original.outcome.deadline, scriptDigest: workforceDigest(script),
      inputDigest: workforceDigest(computation), claimFence: execution.claimFence, jobId: execution.jobId,
      egressAuthority: "NONE", protectedReceipt: null }, c);
    return { q, assignment, computation, use };
  }).catch(async error => {
    if (error instanceof WorkforceRuntimeError && error.code === protectedChildRefusalCode)
      await persistWorkforceProtectedChildBinding(ctx, id, error.detail)
        .catch(bindingError => { (error as { bindingError?: unknown }).bindingError = String(bindingError); });
    throw error;
  });
  if (!prepared) return false;
  console.log(JSON.stringify({ event: "W2_S6_INTENT_COMMITTED", programId: id, assignmentId, jobId: execution.jobId,
    claimFence: execution.claimFence, pid: process.pid }));
  const started = performance.now(), cpu = process.cpuUsage();
  const result = await launchIsolatedNodeExecutor({ script, input: prepared.computation, wallTimeMs: 10000, protectedExecution: false });
  await tx(ctx, async c => {
    await portfolioLock(ctx, c);
    const q = await programRow(ctx, id, c, true); await liveClaim(ctx, q, execution, c);
    let program = q.program!, assignment = program.assignments.find(a => a.id === assignmentId)!;
    const current = checkWorkforceUse(program, assignmentId, await resolveCanonicalInput(ctx, q, c));
    const successful = result.exitCode === 0 && result.termination === "EXITED";
    let value: unknown = null;
    if (successful) {
      try { value = JSON.parse(result.stdout).value; } catch { reject("WORKFORCE_UNTRUSTED_EXECUTOR_OUTPUT_INVALID"); }
    }
    const evidenceRef = await evidence(ctx, q, "s6:" + assignmentId, { schema: "finnor.workforce-s6-observation.v1",
      assignmentId, value, result, producerReceivedHiddenCriterion: false, authority: "NONE_OUTPUT_UNTRUSTED" }, c);
    await event(ctx, q, "S6_OBSERVATION", "s6-result:" + assignmentId, { assignmentId, evidenceRef, value,
      execution: result, acceptedAtPublication: current.allowed, physicalClaim: execution.claimFence }, c);
    await observeWorkforceUseTx({ auth: ctx }, c, q.budget, { consumptionId: prepared.use.consumption.ref.id,
      observationKey: "s6:" + assignmentId, actual: observedOperations(q, prepared.use.consumption.envelope, prepared.use.consumption.createdAt), evidenceRef,
      possibleEffect: false, meterGaps: q.budget.resources.some(r => r.unit !== "workforce-operation") ? ["NON_COUNTER_RESOURCE_ACTUAL_UNKNOWN"] : [] });
    await meter(ctx, q, c, "s6:" + assignmentId, { phase: "S6", status: successful ? "OBSERVED" : "FAILED",
      elapsedMs: performance.now() - started, supervisorCpu: process.cpuUsage(cpu), evidenceRef, provenance: result.provenance });
    if (!current.allowed || !successful) {
      const observationRef = reference("S6", q.id + ":blocked:" + assignmentId, { evidenceRef, currentness: current, successful });
      program = await applyNativeCommand(ctx, q, program, assignment, q.principal_id,
        { kind: "BLOCK", observationRef, reason: successful ? "CURRENT_AUTHORITY_CHANGED_AFTER_PHYSICAL_ATTEMPT" : "ISOLATED_COMPUTATION_FAILED" },
        "blocked:" + assignmentId, c, { originalAttemptRetained: true, evidenceRef });
      await publish(ctx, q, program, c);
      await outcomeExperience(ctx, q, assignmentId, c);
      return;
    }
    const graph = workforceProgramGraph(program);
    const criterion = graph.criteria.find(v => v.id === graph.tasks.find(t => t.id === assignment.taskId)!.criterionId)!;
    const delivery = { assignmentId, actorId: assignment.actorId, termsDigest: assignment.termsDigest,
      evidenceRefs: [evidenceRef], custodianActorId: criterion.evidenceCustodianActorId, at: new Date().toISOString() };
    const deliveryRef = reference("S1", q.id + ":delivery:" + assignmentId, delivery);
    await event(ctx, q, "DELIVERY", "delivery:machine:" + assignmentId, { observation: { ...delivery, ref: deliveryRef }, value,
      origin: "ACTUAL_S6_ISOLATED_OUTPUT_NOT_A_HUMAN_CALLBACK" }, c);
    program = await applyNativeCommand(ctx, q, program, assignment, assignment.actorId, { kind: "DELIVER", deliveryRef },
      "deliver:" + assignmentId, c, { originalS6Observation: evidenceRef });
    assignment = program.assignments.find(a => a.id === assignmentId)!;
    const original = (await resolveNativeDefinitions(ctx, q, c)).criteria.find(v => v.id === criterion.id)!;
    if (original.acceptance.kind === "EXACT_JSON") {
      const verificationStarted = performance.now(), verificationCpu = process.cpuUsage();
      const satisfied = workforceDigest(value) === workforceDigest(original.acceptance.expected);
      const comparison = { elapsedMs: performance.now() - verificationStarted, supervisorCpu: process.cpuUsage(verificationCpu) };
      const verification = { assignmentId, deliveryRef, criterionRef: criterion.ref, checkerActorId: criterion.checkerActorId,
        custodianActorId: criterion.evidenceCustodianActorId, evidenceRefs: [evidenceRef],
        result: satisfied ? "SATISFIED" as const : "FAILED" as const, at: new Date().toISOString() };
      const verificationRef = reference("S1", q.id + ":verification:" + assignmentId, verification);
      await event(ctx, q, "VERIFICATION", "verification:machine:" + assignmentId,
        { observation: { ...verification, ref: verificationRef }, evaluator: "ORIGINAL_LITERAL_CRITERION_COMPARATOR",
          claimedHumanJudgment: false, originalCriterion: criterion.ref }, c);
      await meter(ctx, q, c, "verification:" + assignmentId, { phase: "INDEPENDENT_DELIVERY_VERIFICATION",
        status: satisfied ? "SATISFIED" : "FAILED", assignmentId, criterionRef: criterion.ref, ...comparison });
      program = await applyNativeCommand(ctx, q, program, assignment, criterion.checkerActorId,
        satisfied ? { kind: "VERIFY", verificationRef } : { kind: "DISPUTE", observationRef: verificationRef, reason: "ORIGINAL_CRITERION_FAILED" },
        "verify:" + assignmentId, c, { separateOriginalCriterion: criterion.ref, observedEvidence: evidenceRef });
    }
    await publish(ctx, q, program, c);
    await outcomeExperience(ctx, q, assignmentId, c);
  });
  console.log(JSON.stringify({ event: "W2_S6_RESULT_COMMITTED", programId: id, assignmentId,
    jobId: execution.jobId, claimFence: execution.claimFence, pid: process.pid }));
  return true;
}

/** Bounded canonical outbound payment preparation. An accepted compensation
 * obligation either maps to an exact internal self-obligation discharge
 * (payer and payee are the same accountable principal of one budget; no cash
 * moves and no external settlement is claimed) or is prepared once for the
 * S6 financial broker boundary, which never admits it while no qualified
 * outbound settlement provider is installed. Responsibility waits here; the
 * accepted obligation record is never rewritten. */
async function prepareCompensationBoundary(ctx: TenantContext, id: string, execution: Readonly<JobExecutionContext>) {
  const dispatches = await tx(ctx, async c => {
    await portfolioLock(ctx, c);
    const q = await programRow(ctx, id, c, true); await liveClaim(ctx, q, execution, c);
    if (!q.program) return [];
    const compensation = await readWorkforceCompensationTx({ auth: ctx }, c, q.budget);
    const discharged = new Set(compensation.settlements.map(settlement => settlement.settlementOf.id as string));
    const open = compensation.records.filter(record => !discharged.has(record.ref.id as string));
    if (!open.length) return [];
    const canonical = await resolveCanonicalInput(ctx, q, c);
    const out: Array<{ requestId: string; obligationDigest: string;
      request: Parameters<typeof admitWorkforceCompensationAtFinancialBrokerBoundary>[0] }> = [];
    for (const record of open.slice(0, 32)) {
      const assignment = q.program.assignments.find(a => a.id === record.assignmentId);
      if (!assignment) continue;
      const actor = canonical.actors.find(a => a.id === assignment.actorId);
      const task = canonical.outcome.tasks.find(t => t.id === assignment.taskId);
      if (actor && ["DETERMINISTIC_SERVICE", "MODEL_AGENT", "COMPUTATIONAL_CELL"].includes(actor.kind) &&
          task?.assignmentMode === "INTERNAL_AUTHORIZED" && record.payeePrincipalId === q.principal_id &&
          assignment.state.kind === "VERIFIED") {
        const settlement = await recordWorkforceCompensationInternalDischargeTx({ auth: ctx }, c, record);
        if (settlement) await event(ctx, q, "COMPENSATION_SETTLEMENT", "compensation-settlement:" + record.ref.contentDigest,
          { settlement, obligationRef: record.ref, monetaryMovement: "NONE_INTERNAL_COUNTER_ENTRY",
            financialTransferAuthorized: false, externalSettlementEstablished: false, realPayment: false }, c);
        continue;
      }
      const prepared = await ensureWorkforceCompensationPaymentRequestTx({ auth: ctx }, c, q, record);
      if (prepared.created) await event(ctx, q, "PAYMENT_PREPARATION", "payment-prepare:" + record.ref.contentDigest,
        { requestId: prepared.requestId, bindingDigest: prepared.bindingDigest, obligationRef: record.ref,
          financialTransferAuthorized: false, externalSettlementEstablished: false }, c);
      if (prepared.awaitingBoundary) out.push(prepared);
    }
    return out;
  });
  // Preparation commits before any broker contact, and the boundary decision
  // lands in its own transaction. A crash between them leaves at most an
  // identical re-presented request whose first durable refusal stands.
  for (const dispatch of dispatches) {
    const observation = await admitWorkforceCompensationAtFinancialBrokerBoundary(dispatch.request);
    await tx(ctx, async c => {
      await portfolioLock(ctx, c);
      const q = await programRow(ctx, id, c, true); await liveClaim(ctx, q, execution, c);
      const stored = await recordWorkforceCompensationBoundaryObservationTx({ auth: ctx }, c, dispatch, observation);
      if (stored) await event(ctx, q, "PAYMENT_BOUNDARY", "payment-boundary:" + dispatch.obligationDigest,
        { requestId: dispatch.requestId, observation, reachedBoundary: observation.reachedBoundary,
          admission: observation.admission, financialTransferAuthorized: false,
          externalSettlementEstablished: false }, c);
    });
  }
}
async function closeVerified(ctx: TenantContext, id: string, execution: Readonly<JobExecutionContext>) {
  await tx(ctx, async c => {
    await portfolioLock(ctx, c);
    const q = await programRow(ctx, id, c, true); await liveClaim(ctx, q, execution, c);
    let program = q.program!;
    // A waiting participant programme has nothing to close. Republishing all
    // heads here needlessly holds the portfolio mutex across a native read.
    if (!program.assignments.some(assignment => assignment.state.kind === "VERIFIED")) return;
    const previouslyClosed = new Set(program.assignments.filter(a => a.state.kind === "CLOSED").map(a => a.id));
    // Children close before their accountable parents. A failed close is not
    // replaced by a producer assertion that the entire programme is finished.
    for (let depth = 0; depth < 9; depth++) {
      let changed = false;
      for (const assignment of program.assignments.filter(a => a.state.kind === "VERIFIED")) {
        if (program.assignments.some(a => a.parentAssignmentId === assignment.id && a.state.kind !== "CLOSED")) continue;
        const observationRef = reference("workforce-observation", q.id + ":close:" + assignment.id,
          { assignmentId: assignment.id, originalRoot: q.work_id, originalDeadline: q.original.outcome.deadline });
        // An open money or labor obligation refuses closure by independent
        // check. That is a reason to wait for qualified settlement, never to
        // quarantine the close job or to erase responsibility by assertion.
        await c.query("SAVEPOINT w2_close_attempt");
        try {
          program = await applyNativeCommand(ctx, q, program, assignment, q.principal_id,
            { kind: "CLOSE", observationRef }, "close:" + assignment.id, c,
            { independentGraphRequired: true, responsibilityRetainedInOriginalHistory: true });
          await c.query("RELEASE SAVEPOINT w2_close_attempt");
          changed = true;
        } catch (error) {
          await c.query("ROLLBACK TO SAVEPOINT w2_close_attempt");
          const issues = error instanceof WorkforceRuntimeError ? error.detail : null;
          const waiting = error instanceof WorkforceRuntimeError &&
            error.code === "WORKFORCE_CONTRACT_TRANSITION_REJECTED" && Array.isArray(issues) &&
            issues.some(issue => ["OPEN_OBLIGATION", "COMPENSATION_RELEASE_UNKNOWN", "LABOR_RELEASE_UNKNOWN"]
              .includes(String((issue as { code?: unknown })?.code)));
          if (!waiting) throw error;
          await event(ctx, q, "CLOSE_AWAITING_SETTLEMENT", "close-waiting:" + assignment.id + ":" + execution.deliveryAttemptId,
            { assignmentId: assignment.id, issues, responsibilityRetained: true, jobQuarantined: false,
              settlementOwner: "UNAVAILABLE", externalSettlementEstablished: false }, c);
        }
      }
      if (!changed) break;
    }
    const published = await publish(ctx, q, program, c);
    for (const assignment of program.assignments.filter(a => a.state.kind === "CLOSED" && !previouslyClosed.has(a.id)))
      await outcomeExperience(ctx, q, assignment.id, c);
    if (published.status === "CLOSED") {
      await c.query(`UPDATE finnor_os.works SET status='completed',final_outcome=$3::jsonb,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND id=$2 AND created_by=$4 AND status NOT IN('cancelled','failed')`, [ctx.tenantId, q.work_id,
        JSON.stringify({ schema: "finnor.workforce-verified-outcome.v1", programId: q.id, originalInput: q.work_input_id,
          revision: program.revision, check: published.check, protectedReceipt: null, genuineHumanQualified: false }), q.principal_id]);
      await event(ctx, q, "COMPLETION", "completed", { workId: q.work_id, originalInput: q.work_input_id,
        originalBudget: q.budget.ref, check: published.check, sourceClass: q.original.sourceClass,
        resourceEnvelopeRetained: true, protectedAdmission: false, genuineHumanQualified: false }, c);
    }
  });
}

/** New physical job type. Legacy agent assignment and governed protocol-3
 * handlers cannot accidentally claim these payloads. */
export async function runWorkforceExecutionJob(payload: Record<string, unknown>, execution?: Readonly<JobExecutionContext>) {
  if (!execution || execution.protocolVersion !== 1 || execution.retrySafety !== "reconcilable" ||
      typeof payload.tenantId !== "string" || payload.tenantId !== execution.tenantId ||
      typeof payload.principalId !== "string" || typeof payload.programId !== "string" ||
      !["COMPILE", "ADVANCE", "RECONCILE"].includes(String(payload.phase))) reject("WORKFORCE_ACTUAL_REGISTERED_JOB_REQUIRED");
  const ctx = rootContext({ tenant_id: payload.tenantId, principal_id: payload.principalId }), id = payload.programId;
  execution.registerHeartbeat(() => tx(ctx, async c => {
    const q = await programRow(ctx, id, c);
    try { await liveClaim(ctx, q, execution, c); return true; } catch { return false; }
  }));
  if (payload.phase === "COMPILE") { await compile(ctx, id, execution); return; }
  if (payload.phase === "RECONCILE") {
    const original = await tx(ctx, async c => {
      const q = await programRow(ctx, id, c);
      await liveClaim(ctx, q, execution, c);
      const all = await events(ctx, q, c);
      return { q, uncertain: all.filter(e => e.kind === "S6_INTENDED" &&
        !all.some(result => result.event_id === "s6-result:" + e.body.assignmentId)) };
    });
    for (const intent of original.uncertain)
      await executeAssignment(ctx, id, String(intent.body.assignmentId), execution, true);
    await tx(ctx, async c => {
      await portfolioLock(ctx, c);
      const q = await programRow(ctx, id, c, true);
      await liveClaim(ctx, q, execution, c);
      await event(ctx, q, "RECONCILIATION_AUDIT", "reconciliation-job:" + execution.deliveryAttemptId, {
        originalRoot: q.work_id, originalReservation: q.budget.reservationRef, originalDeadline: q.original.outcome.deadline,
        uncertainAttempts: original.uncertain.length, readOnly: true, physicalAttemptReplayAllowed: false,
        claimFence: execution.claimFence, jobId: execution.jobId }, c);
      if (!original.uncertain.length && q.program)
        await enqueueWorkforceTx(ctx, q, "ADVANCE", "reconciled-no-unknown:" + execution.deliveryAttemptId, c);
      else if (!q.program) {
        await c.query("UPDATE finnor_os.w2_programs SET status='BLOCKED',last_error='WORKFORCE_UNCOMMITTED_COMPILATION_REQUIRES_OWNER_REVIEW' WHERE tenant_id=$1 AND id=$2",
          [ctx.tenantId, q.id]);
      }
    });
    return;
  }
  let worked = 0;
  for (let step = 0; step < 8; step++) {
    const loaded = await tx(ctx, async c => {
      const q = await programRow(ctx, id, c);
      return { q, definitions: await resolveNativeDefinitions(ctx, q, c) };
    });
    const q = loaded.q;
    if (!q.program || q.status === "CLOSED") return;
    const ids = q.program.assignments.filter(a => ["ACCEPTED", "IN_PROGRESS"].includes(a.state.kind) &&
      loaded.definitions.operations.some(op => op.taskId === a.taskId &&
        ["SUM_INTEGERS", "SORT_STRINGS"].includes(op.computation.kind))).map(a => a.id);
    if (!ids.length) break;
    let progress = false;
    for (const assignmentId of ids) if (await executeAssignment(ctx, id, assignmentId, execution)) { worked++; progress = true; break; }
    if (!progress) break;
  }
  await prepareCompensationBoundary(ctx, id, execution);
  await closeVerified(ctx, id, execution);
  await tx(ctx, async c => {
    await portfolioLock(ctx, c);
    const q = await programRow(ctx, id, c, true);
    await liveClaim(ctx, q, execution, c);
    if (!q.program || q.status === "CLOSED") return;
    if (worked === 8) {
      await enqueueWorkforceTx(ctx, q, "ADVANCE", "continue:" + randomUUID(), c); return;
    }
    const definitions = await resolveNativeDefinitions(ctx, q, c);
    const future = q.program.assignments.filter(a => ["ACCEPTED", "IN_PROGRESS"].includes(a.state.kind) &&
      definitions.operations.some(op => op.taskId === a.taskId && ["SUM_INTEGERS", "SORT_STRINGS"].includes(op.computation.kind)))
      .flatMap(a => {
        const task = definitions.tasks.find(task => task.id === a.taskId);
        return task && Date.parse(task.slot.startAt) > Date.now() ? [{ assignment: a, task }] : [];
      }).sort((a, b) => Date.parse(a.task.slot.startAt) - Date.parse(b.task.slot.startAt))[0];
    if (future) await enqueueWorkforceTx(ctx, q, "ADVANCE", "window:" + future.assignment.id + ":" + future.task.slot.startAt,
      c, future.task.slot.startAt);
  });
}
