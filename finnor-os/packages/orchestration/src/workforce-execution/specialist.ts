/** Registered Work/S5 owner for the opt-in development specialist profile. */
import type { PoolClient } from "pg";
import type { AllocationEnvelope, AllocationResource, TenantContext } from "@finnor/shared-types";
import type { JobExecutionContext } from "../../../../apps/worker/src/queue";
import { withDatabaseExecutionDeadline } from "../../../db/execution-deadline";
import { checkWorkforceUse, workforceCanonicalGraph,
  type WorkforceAssignment } from "../../../workforce/src/execution-program/index";
import { exactQuantity } from "../../../workforce/src/execution-program/exact";
import { assertCurrentWorkforceAllocationAuthorityTx, assertWorkforceBudgetTx, observeWorkforceUseTx,
  reserveWorkforceUseTx, WorkforceAllocationError, type WorkforceResourceSchedule } from "../../../private-equity/src/workforce-allocation";
import { persistEconomicRecordTx } from "../../../private-equity/src/economic-store";
import { currentWorkforceSpecialistCapability, resolveInstalledWorkforceSpecialistCapability,
  openWorkforceSpecialistPublicationAuthority, type WorkforceSpecialistCapability } from "../../../capability-evolution/src/specialist-consumer";
import { commitOriginalSpecialistCandidate, specialistPublicationId } from "./specialist-publication";
import { readOriginalAttemptIdentity } from "../../../governed-execution/src/specialist-publication-witness";
import { activateOriginalSpecialistOrigins, withOriginalSpecialistOriginScope } from "../../../governed-execution/src/specialist-origin-source";
import { readActualOriginalClaimBounds } from "../../../governed-execution/src/specialist-origin-context";
import { launchWorkforceSpecialistExecutor } from "../../../governed-execution/src/executor";
import type { WorkforceSpecialistResult } from "../../../governed-execution/src/executor-specialist";
import { observeWorkforceSpecialistHost, workforceSpecialistHostConfiguration } from "../../../governed-execution/src/executor-specialist-linux";
import { SPECIALIST_HOST_LIMITS, SPECIALIST_QUALIFICATION_DOMAIN, renderSpecialistInput, specialistByteDigest,
  specialistComputationSchema, specialistDigest, specialistExecutionBindingSchema, specialistHostReferenceSchema,
  specialistRefSchema, type SpecialistComputation } from "../../../governed-execution/src/specialist-contract";
import { WorkforceRuntimeError } from "./contracts";
import { resolveWorkforceAuthorityPins } from "./native-authority";
import { applyNativeCommand } from "./runtime";
import { event, events, evidence, portfolioLock, programRow, publish, reference, reject, resolveActors,
  resolveCanonicalInput, resolveNativeDefinitions, tx, type WorkforceProgramRow } from "./store";

type ResourceKey = keyof SpecialistComputation["resourceBindings"];
const resourceContracts: Record<ResourceKey, { unit: string; resourceClass: string; kinds: string[] }> = {
  operation: { unit: "workforce-operation", resourceClass: "OPERATIONAL_CAPACITY", kinds: ["FLOW", "CUMULATIVE_EXPENDITURE"] },
  modelCalls: { unit: "model-call", resourceClass: "COMPUTE", kinds: ["FLOW", "CUMULATIVE_EXPENDITURE"] },
  inputTokens: { unit: "model-input-token", resourceClass: "COMPUTE", kinds: ["FLOW", "CUMULATIVE_EXPENDITURE"] },
  outputTokens: { unit: "model-output-token", resourceClass: "COMPUTE", kinds: ["FLOW", "CUMULATIVE_EXPENDITURE"] },
  inputBytes: { unit: "model-input-utf8-bytes", resourceClass: "COMPUTE", kinds: ["FLOW", "CUMULATIVE_EXPENDITURE"] },
  responseBytes: { unit: "model-response-body-bytes", resourceClass: "COMPUTE", kinds: ["FLOW", "CUMULATIVE_EXPENDITURE"] },
  cpuMicros: { unit: "cpu-microseconds", resourceClass: "COMPUTE", kinds: ["FLOW", "CUMULATIVE_EXPENDITURE"] },
  memoryBytes: { unit: "memory-bytes", resourceClass: "COMPUTE", kinds: ["OCCUPANCY"] },
  pids: { unit: "processes", resourceClass: "COMPUTE", kinds: ["OCCUPANCY"] },
  scratchBytes: { unit: "scratch-write-bytes", resourceClass: "COMPUTE", kinds: ["FLOW", "CUMULATIVE_EXPENDITURE"] },
};
const code = (error: unknown) => {
  const value = error instanceof Error ? (error as Error & { code?: unknown }).code ?? error.message : null;
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(value)
    ? value : "WORKFORCE_SPECIALIST_BOUNDARY_UNAVAILABLE";
};
const boundedTx = <T>(ctx: TenantContext, milliseconds: number, fn: (c: PoolClient) => Promise<T>) =>
  withDatabaseExecutionDeadline(performance.now() + Math.max(1, milliseconds), () => tx(ctx, fn));
async function assertAtomicPublicationBridge(): Promise<void> {
  const authority = await openWorkforceSpecialistPublicationAuthority("candidate");
  try { await authority.assertDatabaseCustody(); await authority.readEpoch(); }
  finally { await authority.close(); }
}

async function assertJobClaim(ctx: TenantContext, q: WorkforceProgramRow, execution: Readonly<JobExecutionContext>,
  c: PoolClient, physicalDeadline?: number) {
  execution.leaseLossSignal?.throwIfAborted();
  const row = (await c.query<{ lease_expires_at: Date }>(`SELECT lease_expires_at FROM finnor_os.jobs
    WHERE tenant_id=$1 AND id=$2 AND type='run_workforce_execution_v1' AND protocol_version=1
      AND status='running' AND claim_token=$3 AND claim_fence=$4 AND lease_owner=$5
      AND payload->>'programId'=$6 AND payload->>'principalId'=$7 AND payload->>'tenantId'=$1::text
      AND payload->>'phase' IN('ADVANCE','RECONCILE')
      AND lease_expires_at>clock_timestamp() FOR SHARE`,
  [ctx.tenantId, execution.jobId, execution.claimToken, execution.claimFence, execution.workerId, q.id, q.principal_id])).rows[0];
  if (!row || execution.tenantId !== q.tenant_id || q.principal_id !== ctx.userId
    || execution.protocolVersion !== 1 || execution.retrySafety !== "reconcilable")
    reject("WORKFORCE_SPECIALIST_PHYSICAL_CLAIM_FENCED");
  if (physicalDeadline !== undefined && (new Date(row.lease_expires_at).getTime() <= physicalDeadline + 2000
    || !Number.isSafeInteger(execution.leaseSeconds) || execution.leaseSeconds * 1000 <= physicalDeadline - Date.now() + 2000))
    reject("WORKFORCE_SPECIALIST_JOB_LEASE_ENDS_BEFORE_PHYSICAL_DRAIN");
  execution.leaseLossSignal?.throwIfAborted();
}

async function loadScope(ctx: TenantContext, id: string, assignmentId: string, execution: Readonly<JobExecutionContext>,
  c: PoolClient, allowAccepted: boolean, physicalDeadline?: number) {
  await portfolioLock(ctx, c);
  const q = await programRow(ctx, id, c, true);
  await assertJobClaim(ctx, q, execution, c, physicalDeadline);
  const work = (await c.query("SELECT status FROM finnor_os.works WHERE tenant_id=$1 AND id=$2 FOR SHARE",
    [ctx.tenantId, q.work_id])).rows[0];
  if (!work || ["cancelled", "canceled", "failed", "completed", "closed"].includes(String(work.status).toLowerCase()))
    reject("WORKFORCE_SPECIALIST_ORIGINAL_WORK_NOT_CURRENT");
  const program = q.program, assignment = program?.assignments.find(a => a.id === assignmentId);
  if (!program || !assignment) reject("WORKFORCE_SPECIALIST_ORIGINAL_ASSIGNMENT_REQUIRED");
  const definitions = await resolveNativeDefinitions(ctx, q, c);
  const computation = specialistComputationSchema.parse(definitions.operations.find(op => op.taskId === assignment.taskId)?.computation);
  const canonical = await resolveCanonicalInput(ctx, q, c), checked = checkWorkforceUse(program, assignmentId, canonical);
  const accepted = allowAccepted && assignment.state.kind === "ACCEPTED"
    && !checked.affectedAssignmentIds.includes(assignmentId)
    && !checked.issues.some(issue => issue.boundary === "USE" && issue.code !== "NOT_IN_PROGRESS"
      && (issue.assignmentId === null || issue.assignmentId === assignmentId));
  if (!checked.allowed && !accepted) reject("WORKFORCE_SPECIALIST_CURRENT_USE_FENCED", 409, checked);
  const graph = workforceCanonicalGraph(canonical), task = graph.tasks.find(t => t.id === assignment.taskId);
  const criterion = graph.criteria.find(item => item.id === task?.criterionId);
  const actor = canonical.actors.find(item => item.id === assignment.actorId);
  const funding = canonical.funding.find(item => item.assignmentId === assignmentId);
  if (!task || !criterion || !actor || !funding || funding.status !== "HELD")
    reject("WORKFORCE_SPECIALIST_CANONICAL_TASK_ACTOR_AND_CARVE_REQUIRED");
  if (actor.kind !== "MODEL_AGENT" || actor.status !== "CURRENT" || task.assignmentMode !== "INTERNAL_AUTHORIZED"
    || task.effectId !== null || task.ceiling.effects.length || assignment.ceiling.effects.length
    || task.context.includesCredentials || criterion.checkerActorId === assignment.actorId
    || criterion.evidenceCustodianActorId === assignment.actorId)
    reject("WORKFORCE_SPECIALIST_BOUNDED_MACHINE_SCOPE_REQUIRED");
  const lineage: WorkforceAssignment[] = [];
  let cursor: WorkforceAssignment | undefined = assignment;
  while (cursor) {
    if (lineage.some(item => item.id === cursor!.id) || lineage.length >= 8)
      reject("WORKFORCE_SPECIALIST_ORIGINAL_LINEAGE_INVALID");
    lineage.push(cursor);
    if (cursor.id !== assignmentId && !["ACCEPTED", "IN_PROGRESS"].includes(cursor.state.kind))
      reject("WORKFORCE_SPECIALIST_PARENT_ACCEPTANCE_NOT_CURRENT");
    if (cursor.parentAssignmentId === null) break;
    cursor = program.assignments.find(item => item.id === cursor!.parentAssignmentId);
    if (!cursor) reject("WORKFORCE_SPECIALIST_ORIGINAL_PARENT_REQUIRED");
  }
  if (lineage.some(item => computation.context.some(context => !item.ceiling.dataScopes.includes(context.scope))))
    reject("WORKFORCE_SPECIALIST_CONTEXT_EXCEEDS_PARENT_SCOPE");
  const authority = await resolveWorkforceAuthorityPins(ctx, q, program, await resolveActors(ctx, q, c), c,
    new Set(lineage.map(item => item.id)));
  if (authority.length !== lineage.length || authority.some(pin => !pin.allowed))
    reject("WORKFORCE_SPECIALIST_CURRENT_NATIVE_AUTHORITY_REQUIRED", 403);
  const ownAuthority = authority.find(pin => pin.id === assignmentId)!;
  const producerPrincipal = ownAuthority.proof.roles.find(role => role.role === "PRODUCER_RESPOND")?.principalId;
  const checkerPrincipal = ownAuthority.proof.roles.find(role => role.role === "CHECKER_RESPOND")?.principalId;
  if (!producerPrincipal || !checkerPrincipal || producerPrincipal === checkerPrincipal)
    reject("WORKFORCE_SPECIALIST_INDEPENDENT_CHECKER_REQUIRED", 403);
  await assertWorkforceBudgetTx({ auth: ctx }, c, q.budget);
  await assertCurrentWorkforceAllocationAuthorityTx({ auth: ctx }, c, q.budget);
  const resources = new Map<ResourceKey, AllocationResource>();
  for (const key of Object.keys(resourceContracts) as ResourceKey[]) {
    const resource = q.budget.resources.find(item => item.resourceId === computation.resourceBindings[key]);
    const contract = resourceContracts[key];
    if (!resource || resource.unit !== contract.unit || resource.resourceClass !== contract.resourceClass
      || !contract.kinds.includes(resource.kind) || resource.currency !== null || resource.revoked)
      reject("WORKFORCE_SPECIALIST_EXACT_RESOURCE_BINDING_REQUIRED", 409, { coordinate: key });
    resources.set(key, resource);
  }
  const producerTask = { deliverable: assignment.terms.deliverable,
    dataScopes: task.context.dataScopes, purposes: task.context.purposes };
  const rendered = renderSpecialistInput(computation, producerTask);
  const roleActorIds = new Set(authority.flatMap(pin => pin.proof.roles.map(role => role.actorId)));
  const roleActors = canonical.actors.filter(item => roleActorIds.has(item.id));
  const agentIds = [...new Set(authority.flatMap(pin => pin.proof.roles.filter(role =>
    role.principalId && roleActors.some(item => item.id === role.actorId && item.kind === "MODEL_AGENT"))
    .map(role => role.principalId!)))];
  const agentLifetimes = agentIds.length ? (await c.query<{ completion_deadline: string | null; expires_at: string | null; valid_from: string }>(`
    SELECT d.completion_deadline::text,a.expires_at::text,a.effective_from::text AS valid_from FROM finnor_os.employee_actor_profiles p
    JOIN finnor_os.delegations d ON d.tenant_id=p.tenant_id AND d.id=p.delegation_id
    JOIN finnor_os.employee_role_assignments a ON a.tenant_id=p.tenant_id AND a.id=p.authority_assignment_id
    JOIN finnor_os.users issuer ON issuer.tenant_id=p.tenant_id AND issuer.id=d.created_by AND issuer.status='active'
    WHERE p.tenant_id=$1 AND p.principal_id=ANY($2::uuid[]) AND p.actor_kind='AGENT'
      AND d.status='accepted' AND d.target_type='employee' AND d.target_id=p.principal_id
      AND d.created_by=p.delegated_by AND a.employee_id=p.principal_id AND a.active AND a.effective_from<=clock_timestamp()
      AND (a.expires_at IS NULL OR a.expires_at>clock_timestamp())
      AND (d.completion_deadline IS NULL OR d.completion_deadline>clock_timestamp())
    FOR SHARE OF p,d,a,issuer`, [ctx.tenantId, agentIds])).rows : [];
  if (agentLifetimes.length !== agentIds.length) reject("WORKFORCE_SPECIALIST_CURRENT_AGENT_LIFETIME_REQUIRED");
  const authorityDeadlines = authority.flatMap(pin => pin.proof.roles.flatMap(role =>
    role.source?.applicable.flatMap(item => item.assignment.validUntil ? [item.assignment.validUntil] : []) ?? []));
  const capabilityDeadlines = lineage.flatMap(item => {
    const definition = graph.tasks.find(value => value.id === item.taskId), holder = canonical.actors.find(value => value.id === item.actorId);
    return holder?.capabilities.filter(capability => definition?.requiredCapabilities.some(required =>
      required.skill === capability.skill && required.scope === capability.scope)
      && Date.parse(capability.validUntil) > Date.now()).map(capability => capability.validUntil) ?? [];
  });
  const maximumDeadline = Math.min(...[q.original.outcome.deadline, q.budget.validUntil, task.slot.endAt, task.dueAt,
    canonical.outcome.ceiling.validUntil, ...lineage.flatMap(item => [item.originalDeadline,
      item.terms.expiresAt, item.ceiling.validUntil]), ...authorityDeadlines, ...capabilityDeadlines,
    ...roleActors.flatMap(item => item.availability.kind === "OBSERVED" ? [item.availability.validUntil] : []),
    ...agentLifetimes.flatMap(item => [item.completion_deadline, item.expires_at]
      .flatMap(value => value ? [new Date(value).toISOString()] : []))].map(Date.parse));
  if (!Number.isFinite(maximumDeadline) || maximumDeadline <= Date.now()
    || physicalDeadline !== undefined && physicalDeadline > maximumDeadline)
    reject("WORKFORCE_SPECIALIST_ORIGINAL_CONTRACT_DEADLINE_EXPIRED");
  const scopeDigest = specialistDigest({ originalWorkId: q.work_id, originalInputId: q.work_input_id,
    originalMeaningDigest: q.original_digest, programmeId: q.id, task, computation,
    budgetRef: q.budget.ref, reservationRef: q.budget.reservationRef, carveRef: funding.ref,
    lineage: lineage.map(item => ({ id: item.id, actorId: item.actorId, parentAssignmentId: item.parentAssignmentId,
      rootId: item.rootId, workId: item.workId, originalDeadline: item.originalDeadline,
      termsDigest: item.termsDigest, terms: item.terms, ceiling: item.ceiling })) });
  return { q, program, assignment, computation, canonical, task, criterion, funding, lineage,
    authority, agentLifetimes, resources, rendered, producerTask, maximumDeadline, scopeDigest,
    rightsRef: resources.get("modelCalls")!.rightsRef };
}
export const loadSpecialistPublicationScope = (ctx: TenantContext, id: string, assignmentId: string,
  execution: Readonly<JobExecutionContext>, c: PoolClient) => loadScope(ctx, id, assignmentId, execution, c, false);
type Scope = Awaited<ReturnType<typeof loadScope>>;

function reserveSchedules(scope: Scope, startAt: number, deadlineAt: number): WorkforceResourceSchedule[] {
  const { computation, rendered } = scope;
  const maximum: Record<ResourceKey, string> = {
    operation: "1", modelCalls: "1", inputTokens: String(rendered.inputTokenUpperBound),
    outputTokens: String(computation.limits.maxOutputTokens), inputBytes: String(rendered.inputBytes),
    responseBytes: String(computation.limits.maxResponseBytes),
    cpuMicros: String((Math.ceil(computation.limits.wallTimeMs * 1000 / SPECIALIST_HOST_LIMITS.cpuPeriodMicros) + 2)
      * SPECIALIST_HOST_LIMITS.cpuQuotaMicros),
    memoryBytes: String(SPECIALIST_HOST_LIMITS.memoryBytes), pids: String(SPECIALIST_HOST_LIMITS.pids), scratchBytes: "0",
  };
  const selected = new Map([...scope.resources].map(([key, resource]) => [resource.resourceId, key]));
  return scope.q.budget.resources.map(resource => {
    const key = selected.get(resource.resourceId), quantities = Array<string>(resource.horizon.periods + 1).fill("0");
    if (key) {
      const first = Math.floor((startAt - Date.parse(resource.horizon.startAt)) / resource.horizon.periodMs);
      const last = Math.floor((deadlineAt - 1 - Date.parse(resource.horizon.startAt)) / resource.horizon.periodMs);
      if (first < 0 || last < first || last > resource.horizon.periods)
        reject("WORKFORCE_SPECIALIST_RESOURCE_CALENDAR_DOES_NOT_COVER_ATTEMPT");
      const held = scope.funding.directReserved.find(item => item.resourceId === resource.resourceId);
      // A crossing attempt reserves its entire bound in every possibly used
      // period. It cannot borrow another period's capacity or invent a conversion.
      for (let period = first; period <= last; period++) {
        if (exactQuantity(held?.quantities[period] ?? "0").compare(exactQuantity(maximum[key])) < 0)
          reject("WORKFORCE_SPECIALIST_ORIGINAL_DIRECT_FRONTIER_EXHAUSTED", 409, { coordinate: key });
        quantities[period] = maximum[key];
      }
    }
    return { resourceId: resource.resourceId, quantities };
  });
}

function observedSchedules(computation: SpecialistComputation, envelopes: AllocationEnvelope[],
  result: WorkforceSpecialistResult, renderedBytes: number) {
  const usage = result.kernelUsage, model = result.modelUsage;
  const liveOriginal = result.provenance.publicationPhase === "LIVE_ORIGINAL_CANDIDATE"
    && result.provenance.physicalLifetimeClosed === false && usage?.stopped === false;
  const native = result.provenance.nativeBootstrap as { scratchWriteBytes?: unknown; fixedJail?: unknown;
    cgroupMembershipVerified?: unknown } | null;
  const token = (value: number | null | undefined) =>
    value !== null && value !== undefined && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  const values: Record<ResourceKey, string | null> = {
    operation: "1", modelCalls: result.modelResponseReceived ? "1" : null,
    inputTokens: token(model?.inputTokens), outputTokens: token(model?.outputTokens),
    inputBytes: result.provenance.nativeBootstrap ? String(renderedBytes) : null,
    responseBytes: token(model?.responseBytes), cpuMicros: usage?.cpuMicros ?? null, memoryBytes: usage?.memoryPeakBytes ?? null,
    pids: usage?.pidsPeak ?? null, scratchBytes: usage?.stopped && usage.cleanupStatus === "PASS"
      || liveOriginal && native?.scratchWriteBytes === 0 && native.fixedJail === true
        && native.cgroupMembershipVerified === true && usage?.diskWriteBytes === "0" ? "0" : null,
  };
  const actual: WorkforceResourceSchedule[] = [], gaps = ["MODEL_BILLING_AND_PRICEBOOK_UNKNOWN",
    "SUPERVISOR_DATABASE_AND_HUMAN_RESOURCES_UNMETERED"];
  for (const key of Object.keys(values) as ResourceKey[]) {
    const envelope = envelopes.find(item => item.resourceId === computation.resourceBindings[key]);
    const value = values[key];
    if (!envelope || value === null || !/^\d+$/.test(value)) { gaps.push(key.toUpperCase() + "_ACTUAL_UNKNOWN"); continue; }
    const periods = envelope.quantities.flatMap((amount, index) => exactQuantity(amount).compare(exactQuantity("0")) > 0 ? [index] : []);
    if (value !== "0" && periods.length !== 1) { gaps.push(key.toUpperCase() + "_PERIOD_ATTRIBUTION_UNKNOWN"); continue; }
    actual.push({ resourceId: envelope.resourceId, quantities: envelope.quantities.map((_, index) =>
      value !== "0" && index === periods[0] ? value : "0") });
  }
  return { actual, gaps: [...new Set([...gaps, ...(usage?.meterGaps ?? [])])] };
}

async function refuseBeforeAttempt(ctx: TenantContext, id: string, assignmentId: string,
  execution: Readonly<JobExecutionContext>, error: unknown) {
  await boundedTx(ctx, 2000, async c => {
    await portfolioLock(ctx, c);
    const q = await programRow(ctx, id, c, true);
    await assertJobClaim(ctx, q, execution, c);
    execution.leaseLossSignal?.throwIfAborted();
    const refusalCode = code(error);
    await event(ctx, q, "SPECIALIST_REFUSED", "specialist-refused:" + execution.deliveryAttemptId + ":" + assignmentId,
      { assignmentId, reason: refusalCode, physicalAttemptStarted: false, modelCalls: 0,
        newS5Consumption: false, originalRoot: q.work_id, originalDeadline: q.original.outcome.deadline,
        qualificationDomain: SPECIALIST_QUALIFICATION_DOMAIN, productionAdmission: "UNADMITTED" }, c);
    if (q.status !== "CLOSED") await c.query(`UPDATE finnor_os.w2_programs SET status='BLOCKED',last_error=$3
      WHERE tenant_id=$1 AND id=$2`, [ctx.tenantId, q.id, refusalCode]);
    execution.leaseLossSignal?.throwIfAborted();
    await assertJobClaim(ctx, q, execution, c);
  });
}

async function recoverReadOnly(ctx: TenantContext, id: string, assignmentId: string, execution: Readonly<JobExecutionContext>,
  prior: { body: Record<string, unknown> }, hostBody?: Record<string, unknown>) {
  let hostObservation: unknown = { status: "UNKNOWN", reason: "ORIGINAL_HOST_REFERENCE_UNAVAILABLE" };
  if (hostBody) {
    try {
      const host = specialistHostReferenceSchema.parse(hostBody.reference);
      const binding = specialistExecutionBindingSchema.parse(prior.body.binding);
      if (host.bindingDigest !== specialistDigest(binding)) throw Error("SPECIALIST_RECOVERY_HOST_BINDING_CHANGED");
      hostObservation = await observeWorkforceSpecialistHost(host);
    } catch (error) { hostObservation = { status: "UNKNOWN", reason: code(error) }; }
  }
  await boundedTx(ctx, 3000, async c => {
    await portfolioLock(ctx, c);
    const q = await programRow(ctx, id, c, true);
    await assertJobClaim(ctx, q, execution, c);
    const all = await events(ctx, q, c);
    if (all.some(item => item.event_id === "s6-result:" + assignmentId || item.event_id === "recovery:" + assignmentId)) return;
    const original = all.find(item => item.event_id === "s6-intent:" + assignmentId);
    if (!original || specialistDigest(original.body) !== specialistDigest(prior.body))
      reject("WORKFORCE_SPECIALIST_ORIGINAL_RECOVERY_INTENT_CHANGED");
    const consumptionRef = specialistRefSchema.parse(original.body.consumptionRef);
    await observeWorkforceUseTx({ auth: ctx }, c, q.budget, { consumptionId: consumptionRef.id,
      observationKey: "specialist-recovery:" + assignmentId, actual: [], evidenceRef: null, possibleEffect: true,
      meterGaps: ["ORIGINAL_MODEL_CALL_OUTCOME_AND_BILLING_UNKNOWN", "NO_REPLAY_OR_INVENTED_ZERO", "ORIGINAL_RESOURCE_USE_UNSETTLED"] });
    await event(ctx, q, "READ_ONLY_RECOVERY", "recovery:" + assignmentId, { assignmentId,
      originalIntent: original.body, originalRoot: q.work_id, originalReservation: q.budget.reservationRef,
      originalDeadline: q.original.outcome.deadline, hostObservation, modelCallOutcome: "UNKNOWN",
      possibleCallMarkerObserved: all.some(item => item.event_id === "specialist-model-possible:" + assignmentId),
      readOnly: true, newAttemptPermitted: false, resourcesReleased: false, completionEstablished: false }, c);
    await c.query(`UPDATE finnor_os.w2_programs SET status='BLOCKED',last_error='WORKFORCE_SPECIALIST_ORIGINAL_OUTCOME_UNKNOWN'
      WHERE tenant_id=$1 AND id=$2`, [ctx.tenantId, q.id]);
    await assertJobClaim(ctx, q, execution, c);
  });
  return false;
}

function startCurrentnessWatchdog(check: () => Promise<void>, abort: () => void) {
  let stopped = false, pending: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      pending = check().catch(abort).finally(schedule);
    }, 250);
  };
  schedule();
  return async () => { stopped = true; clearTimeout(timer); await pending; };
}

export async function executeWorkforceSpecialistAssignment(ctx: TenantContext, id: string, assignmentId: string,
  execution: Readonly<JobExecutionContext>, recoveryOnly = false): Promise<boolean> {
  const prior = await boundedTx(ctx, 3000, async c => {
    const q = await programRow(ctx, id, c);
    await assertJobClaim(ctx, q, execution, c);
    const all = await events(ctx, q, c);
    return { intent: all.find(item => item.event_id === "s6-intent:" + assignmentId),
      observed: all.some(item => item.event_id === "s6-result:" + assignmentId),
      host: all.find(item => item.event_id === "specialist-host:" + assignmentId)?.body };
  });
  if (prior.intent) {
    if (!prior.observed) return recoverReadOnly(ctx, id, assignmentId, execution, prior.intent, prior.host);
    // A result event is NOT a publication decision. Read only the original
    // marker/candidate/decision; the worker owns neither proof nor projection.
    const authority = await openWorkforceSpecialistPublicationAuthority("candidate", true);
    try { await authority.observeOriginal(specialistPublicationId(String(prior.intent.body.originalRoot), assignmentId)); }
    finally { await authority.close(); }
    return false;
  }
  if (recoveryOnly) return false;
  const leaseSignal = execution.leaseLossSignal;
  if (!(leaseSignal instanceof AbortSignal)) {
    await refuseBeforeAttempt(ctx, id, assignmentId, execution, Error("WORKFORCE_SPECIALIST_GENUINE_JOB_LEASE_SIGNAL_REQUIRED"));
    return false;
  }
  leaseSignal.throwIfAborted();
  let snapshot: Scope, admission: WorkforceSpecialistCapability;
  let host: Awaited<ReturnType<typeof workforceSpecialistHostConfiguration>>, deadlineAt: number;
  try {
    if (!process.env.FINNOR_S8_WORKFORCE_SPECIALIST_CONSUMER_CONFIG
      || !process.env.FINNOR_S8_WORKFORCE_SPECIALIST_CONSUMER_ROOT) throw Error("WORKFORCE_SPECIALIST_UNADMITTED");
    await assertAtomicPublicationBridge();
    snapshot = await boundedTx(ctx, 4000, c => loadScope(ctx, id, assignmentId, execution, c, true));
    const preflightDeadline = Math.min(snapshot.maximumDeadline, Date.now() + 5000);
    const signal = AbortSignal.any([leaseSignal, AbortSignal.timeout(Math.max(1, preflightDeadline - Date.now()))]);
    host = await workforceSpecialistHostConfiguration();
    admission = await resolveInstalledWorkforceSpecialistCapability({ tenantId: ctx.tenantId, principalId: snapshot.q.principal_id,
      rightsRef: snapshot.rightsRef, spendBudgetRef: snapshot.q.budget.ref, methodRef: snapshot.computation.methodRef,
      admissionRef: snapshot.computation.admissionRef, mechanism: host.mechanism, deadlineAt: preflightDeadline, signal });
    const iamSource = host.policy.iamSessionSource;
    if (iamSource.tenantId !== ctx.tenantId || iamSource.principalId !== snapshot.q.principal_id
      || iamSource.rightsRef !== snapshot.rightsRef
      || specialistDigest(iamSource.modelIdentity) !== specialistDigest(admission.modelIdentity))
      throw Error("WORKFORCE_SPECIALIST_IAM_SOURCE_UNADMITTED");
    for (const key of Object.keys(snapshot.computation.limits) as (keyof SpecialistComputation["limits"])[])
      if (snapshot.computation.limits[key] > admission.limits[key]) throw Error("WORKFORCE_SPECIALIST_ADMITTED_LIMIT_EXCEEDED");
    deadlineAt = Math.min(snapshot.maximumDeadline, Date.parse(host.policy.validUntil) - iamSource.drainMs,
      Date.parse(iamSource.validUntil) - iamSource.drainMs, Date.parse(admission.validUntil) - 1,
      Date.now() + snapshot.computation.limits.wallTimeMs);
    if (deadlineAt - Date.now() < 100) throw Error("WORKFORCE_SPECIALIST_ORIGINAL_DEADLINE_EXHAUSTED");
  } catch (error) {
    leaseSignal.throwIfAborted();
    await refuseBeforeAttempt(ctx, id, assignmentId, execution, error);
    return false;
  }
  const controller = new AbortController(), signal = AbortSignal.any([leaseSignal, controller.signal,
    AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()))]);
  const capabilityScope = () => ({ tenantId: ctx.tenantId, principalId: snapshot.q.principal_id,
    rightsRef: snapshot.rightsRef, spendBudgetRef: snapshot.q.budget.ref, methodRef: snapshot.computation.methodRef,
    admissionRef: snapshot.computation.admissionRef, modelIdentity: admission.modelIdentity, mechanism: host.mechanism, deadlineAt, signal });
  const prepared = await boundedTx(ctx, Math.min(3000, deadlineAt - Date.now()), async c => {
    signal.throwIfAborted();
    const current = await loadScope(ctx, id, assignmentId, execution, c, true, deadlineAt);
    if (current.scopeDigest !== snapshot.scopeDigest) reject("WORKFORCE_SPECIALIST_ACCEPTED_SCOPE_CHANGED");
    if ((await events(ctx, current.q, c)).some(item => item.event_id === "s6-intent:" + assignmentId))
      reject("WORKFORCE_SPECIALIST_ORIGINAL_INTENT_REQUIRES_READ_ONLY_RECOVERY");
    const use = await reserveWorkforceUseTx({ auth: ctx }, c, current.q.budget, { assignmentId,
      operationKey: current.q.id + ":specialist:" + assignmentId, decisionDigest: current.scopeDigest,
      schedules: reserveSchedules(current, Date.now(), deadlineAt) });
    if (use.replay) reject("WORKFORCE_SPECIALIST_CONSUMPTION_REPLAY_REFUSED");
    let program = current.program;
    if (current.assignment.state.kind === "ACCEPTED") {
      const observationRef = reference("workforce-observation", id + ":specialist-start:" + assignmentId,
        { assignmentId, termsDigest: current.assignment.termsDigest, claimFence: execution.claimFence });
      program = await applyNativeCommand(ctx, current.q, program, current.assignment, current.assignment.actorId,
        { kind: "START", observationRef }, "specialist-start:" + assignmentId, c,
        { issuer: "CURRENT_ACCEPTED_BOUNDED_SPECIALIST_CONTRACT", jobId: execution.jobId });
      await publish(ctx, current.q, program, c);
    }
    const binding = specialistExecutionBindingSchema.parse({
      schema: "finnor.s6.workforce-specialist-binding.v1", tenantId: current.q.tenant_id, principalId: current.q.principal_id,
      actorId: current.assignment.actorId, originalWorkId: current.q.work_id, originalInputId: current.q.work_input_id,
      originalMeaningDigest: current.q.original_digest, programmeId: current.q.id, assignmentId,
      parentAssignmentId: current.assignment.parentAssignmentId, parentTermsDigest: current.lineage[1]?.termsDigest ?? null,
      termsDigest: current.assignment.termsDigest, termsRevision: current.assignment.terms.revision,
      taskDigest: specialistDigest(current.task), computationDigest: specialistDigest(current.computation),
      contextDigest: specialistDigest(current.computation.context), ceilingDigest: specialistDigest(current.assignment.ceiling),
      acceptedScopeDigest: current.scopeDigest,
      originalDeadline: current.q.original.outcome.deadline, effectiveDeadline: new Date(deadlineAt).toISOString(),
      budgetRef: current.q.budget.ref, reservationRef: current.q.budget.reservationRef, carveRef: current.funding.ref,
      consumptionRef: use.consumption.ref, methodRef: current.computation.methodRef, admissionRef: current.computation.admissionRef,
      modelIdentity: admission.modelIdentity, mechanismDigest: specialistDigest(host.mechanism),
      sourceClosureDigest: admission.sourceClosureDigest, runtimeDigest: admission.runtimeDigest,
      job: { id: execution.jobId, deliveryAttemptId: execution.deliveryAttemptId,
        claimTokenSha256: specialistByteDigest(execution.claimToken), claimFence: execution.claimFence, leaseSeconds: execution.leaseSeconds },
    });
    await event(ctx, current.q, "S6_INTENDED", "s6-intent:" + assignmentId,
      { assignmentId, executionKind: "SPECIALIST_ANALYSIS", binding, bindingDigest: specialistDigest(binding),
        consumptionRef: use.consumption.ref, originalRoot: current.q.work_id, originalDeadline: binding.originalDeadline,
        admittedDevelopmentMethod: admission, protectedReceipt: null, productionAdmission: "UNADMITTED" }, c);
    signal.throwIfAborted();
    await assertJobClaim(ctx, current.q, execution, c, deadlineAt);
    return { scope: current, use, binding };
  });
  const assertCurrent = async (c: PoolClient) => {
    signal.throwIfAborted();
    const current = await loadScope(ctx, id, assignmentId, execution, c, false, deadlineAt);
    if (current.scopeDigest !== snapshot.scopeDigest) reject("WORKFORCE_SPECIALIST_SCOPE_CHANGED_BEFORE_USE");
    const all = await events(ctx, current.q, c), intent = all.find(item => item.event_id === "s6-intent:" + assignmentId);
    if (!intent || intent.body.bindingDigest !== specialistDigest(prepared.binding)
      || all.some(item => item.event_id === "recovery:" + assignmentId || item.event_id === "s6-result:" + assignmentId))
      reject("WORKFORCE_SPECIALIST_ORIGINAL_ATTEMPT_FENCED");
    signal.throwIfAborted();
    return current;
  };
  const stopWatchdog = startCurrentnessWatchdog(
    () => boundedTx(ctx, Math.min(1000, deadlineAt - Date.now()), async c => { await assertCurrent(c); }),
    () => controller.abort(Error("WORKFORCE_SPECIALIST_CURRENT_CLAIM_OR_CONTRACT_LOST")));
  let liveCallbackAttempted = false;
  let publicationDisposition: "NOT_ATTEMPTED" | "UNKNOWN_READ_ONLY" | "CANDIDATE_COMMITTED" = "NOT_ATTEMPTED";
  const persistOriginal = async (result: WorkforceSpecialistResult, originalSignal?: AbortSignal) => {
  leaseSignal.throwIfAborted(); originalSignal?.throwIfAborted();
  const candidateEligible = await boundedTx(ctx, originalSignal ? Math.min(3000, deadlineAt - Date.now()) : 3000, async c => {
    await portfolioLock(ctx, c);
    const q = await programRow(ctx, id, c, true);
    await assertJobClaim(ctx, q, execution, c); leaseSignal.throwIfAborted();
    const all = await events(ctx, q, c), intent = all.find(item => item.event_id === "s6-intent:" + assignmentId);
    if (!intent || intent.body.bindingDigest !== specialistDigest(prepared.binding)
      || all.some(item => item.event_id === "s6-result:" + assignmentId || item.event_id === "recovery:" + assignmentId))
      reject("WORKFORCE_SPECIALIST_PUBLICATION_ATTEMPT_FENCED");
    let current: Scope | null = null;
    try { current = await loadScope(ctx, id, assignmentId, execution, c, false); }
    catch (error) {
      if (!(error instanceof WorkforceRuntimeError) && !(error instanceof WorkforceAllocationError)) throw error;
    }
    const evidenceRef = await evidence(ctx, q, "specialist-s6:" + assignmentId, {
      schema: "finnor.workforce-specialist-observation.v1", assignmentId, binding: prepared.binding, result,
      producerReceivedHiddenCriterion: false, authority: "NONE_OUTPUT_UNTRUSTED",
      qualificationDomain: SPECIALIST_QUALIFICATION_DOMAIN, productionAdmission: "UNADMITTED",
    }, c);
    const observed = observedSchedules(snapshot.computation, prepared.use.consumption.envelope, result, snapshot.rendered.inputBytes);
    const resourceObservation = await observeWorkforceUseTx({ auth: ctx }, c, q.budget,
      { consumptionId: prepared.use.consumption.ref.id, observationKey: "specialist-s6:" + assignmentId,
        actual: observed.actual, evidenceRef, possibleEffect: result.possibleModelCall, meterGaps: observed.gaps });
    await event(ctx, q, "S6_OBSERVATION", "s6-result:" + assignmentId,
      { assignmentId, evidenceRef, value: result.value, execution: result, acceptedAtPublication: false,
        publicationAuthority: "ORIGINAL_CANDIDATE_COORDINATOR_ONLY",
        bindingDigest: specialistDigest(prepared.binding), physicalClaim: execution.claimFence }, c);
    const economic = await persistEconomicRecordTx({ auth: ctx }, { kind: "COMPUTE",
      payload: { schema: "finnor.workforce-specialist-attribution.v1", workId: q.work_id, programmeId: q.id, assignmentId,
        originalBudget: q.budget.ref, bindingDigest: specialistDigest(prepared.binding), evidenceRef,
        actualModelUsage: result.modelUsage, actualKernelUsage: result.kernelUsage, elapsedMs: result.elapsedMs,
        monetaryCost: null, pricebookRef: null, humanSupervisionSeconds: null, economicGain: null,
        gaps: observed.gaps, counterfactual: "NOT_IDENTIFIED", productionAdmission: "UNADMITTED", capabilityPromotion: false },
      rightsRef: snapshot.rightsRef, idempotencyKey: "w2:" + q.id + ":specialist:" + assignmentId,
      validAt: new Date().toISOString(), horizon: "H0", uncertainty: "DEVELOPMENT_PHYSICAL_OBSERVATION_NOT_FIELD_ECONOMICS",
      dependencies: [q.budget.ref, admission.revisionRef, admission.admissionRef] }, c);
    await event(ctx, q, "NATIVE_PHASE_METER", "native-meter:specialist:" + assignmentId,
      { assignmentId, evidenceRef, economicRecordRef: economic.record.ref, resourceObservation,
        money: "UNKNOWN", humanSupervision: "UNKNOWN", economicImprovementEstablished: false }, c);
    let admissionCurrent = false;
    try { await currentWorkforceSpecialistCapability(capabilityScope(), admission); admissionCurrent = true; }
    catch { /* This diagnostic read can never authorize publication. */ }
    const eligible = !!originalSignal && result.provenance.publicationPhase === "LIVE_ORIGINAL_CANDIDATE"
      && result.provenance.physicalLifetimeClosed === false && result.kernelUsage?.stopped === false
      && result.successful && admissionCurrent && current?.scopeDigest === snapshot.scopeDigest
      && !signal.aborted && !resourceObservation.resourceOverrun
      && !observed.gaps.some(gap => /_ACTUAL_UNKNOWN$|_PERIOD_ATTRIBUTION_UNKNOWN$/.test(gap));
    await event(ctx, q, "SPECIALIST_PUBLICATION_CANDIDATE_STATE", "specialist-candidate-state:" + assignmentId,
      { assignmentId, evidenceRef, candidateEligible: eligible, resultSuccessful: result.successful,
        acceptedAtPublication: false, completionEstablished: false, replayAllowed: false,
        atomicPublicationBridge: "ORIGINAL_CANDIDATE_COMMIT_ONLY", disposition: "OBSERVATION_ONLY" }, c);
    if (!eligible) await c.query(`UPDATE finnor_os.w2_programs SET status='BLOCKED',
      last_error='WORKFORCE_SPECIALIST_ORIGINAL_RESULT_NOT_ADMISSIBLE' WHERE tenant_id=$1 AND id=$2`, [ctx.tenantId, q.id]);
    leaseSignal.throwIfAborted(); originalSignal?.throwIfAborted();
    await assertJobClaim(ctx, q, execution, c);
    return eligible;
  });
  if (candidateEligible && originalSignal) {
    const authority = await openWorkforceSpecialistPublicationAuthority("candidate");
    try {
      publicationDisposition = "UNKNOWN_READ_ONLY";
      publicationDisposition = (await commitOriginalSpecialistCandidate({ authority, ctx, programmeId: id, assignmentId,
        execution, binding: prepared.binding, admission, originalSignal })).status;
    } finally { await authority.close(); }
  }
  };
  let result: WorkforceSpecialistResult;
  try {
    result = await withOriginalSpecialistOriginScope({ execution, controller, signal }, () =>
      launchWorkforceSpecialistExecutor({ binding: prepared.binding, computation: snapshot.computation,
      task: snapshot.producerTask, rightsRef: snapshot.rightsRef, admission, signal,
      onPrepared: hostReference => boundedTx(ctx, Math.min(2000, deadlineAt - Date.now()), async c => {
        const current = await assertCurrent(c);
        await event(ctx, current.q, "SPECIALIST_HOST_PREPARED", "specialist-host:" + assignmentId,
          { assignmentId, reference: hostReference, bindingDigest: specialistDigest(prepared.binding),
            guestStarted: false, modelCallAuthority: false }, c);
        signal.throwIfAborted();
      }),
      beforeInvocation: async boundary => {
        // Commit this source before the independent root reader observes it.
        // It records the existing original only, not another model or budget.
        const originalSourceDigest = await boundedTx(ctx, Math.min(2000, deadlineAt - Date.now()), async c => {
          boundary.signal.throwIfAborted(); signal.throwIfAborted();
          const current = await assertCurrent(c);
          const initialClaims = readActualOriginalClaimBounds(execution, boundary.leases);
          const all = await events(ctx, current.q, c);
          if (all.some(item => item.event_id === "specialist-native-ready:" + assignmentId
            || item.event_id === "specialist-model-possible:" + assignmentId))
            reject("WORKFORCE_SPECIALIST_ORIGINAL_NATIVE_READY_ALREADY_RECORDED");
          await event(ctx, current.q, "SPECIALIST_NATIVE_READY", "specialist-native-ready:" + assignmentId, {
            schema: "finnor.w2.original-native-ready-source.v1",
            publicationId: specialistPublicationId(prepared.binding.originalWorkId, assignmentId),
            assignmentId, bindingDigest: specialistDigest(prepared.binding),
            intentEventId: "s6-intent:" + assignmentId,
            hostReference: boundary.hostReference, nativeBootstrap: boundary.nativeBootstrap,
            nativeSource: { canonical: current.canonical, authority: current.authority,
              agentLifetimes: current.agentLifetimes, scopeDigest: current.scopeDigest },
            originalAcceptedSource: { canonical: prepared.scope.canonical, authority: prepared.scope.authority,
              agentLifetimes: prepared.scope.agentLifetimes, scopeDigest: prepared.scope.scopeDigest },
            p3Leases: boundary.leases.map(lease => ({ resourceKey: lease.resourceKey,
              tokenSha256: specialistByteDigest(lease.token), fence: lease.fence,
              ownerId: lease.ownerId, leaseSeconds: lease.leaseSeconds })),
            initialJobClaim: initialClaims.initialJobClaim, initialP3Grants: initialClaims.initialP3Grants,
            jobId: execution.jobId, claimFence: execution.claimFence,
            possibleModelCall: false, replayAllowed: false, productionAdmission: "UNADMITTED",
          }, c);
          boundary.signal.throwIfAborted(); signal.throwIfAborted();
          await assertJobClaim(ctx, current.q, execution, c, deadlineAt);
          const committedSources = await events(ctx, current.q, c);
          const actualIntent = committedSources.find(item => item.event_id === "s6-intent:" + assignmentId);
          const actualReady = committedSources.find(item => item.event_id === "specialist-native-ready:" + assignmentId);
          if (!actualIntent || !actualReady) reject("WORKFORCE_SPECIALIST_ACTUAL_ORIGINAL_SOURCES_REQUIRED");
          return specialistDigest({ intent: actualIntent.body, nativeReady: actualReady.body });
        });
        // The transaction above has COMMITTED. Do not hold its locks while
        // the root independently reads exactly those original source rows.
        const originAuthority = await openWorkforceSpecialistPublicationAuthority("candidate");
        try {
          await activateOriginalSpecialistOrigins({ authority: originAuthority, enrollment: originAuthority.enrollment,
            execution, publicationId: specialistPublicationId(prepared.binding.originalWorkId, assignmentId),
            originalSourceDigest, binding: prepared.binding, hostReference: boundary.hostReference,
            nativeBootstrap: boundary.nativeBootstrap, combined: boundary.signal, leases: boundary.leases });
        } catch (error) { await originAuthority.close(); throw error; }
        // Ownership of this existing authority transfers to the original
        // source scope until all live delivery/collector/P3 work completes.
        await boundedTx(ctx, Math.min(2000, deadlineAt - Date.now()), async c => {
        boundary.signal.throwIfAborted();
        const current = await assertCurrent(c);
        const all = await events(ctx, current.q, c);
        const intended = all.find(item => item.event_id === "s6-intent:" + assignmentId);
        const nativeReady = all.find(item => item.event_id === "specialist-native-ready:" + assignmentId);
        if (!intended || !nativeReady
          || nativeReady.body.bindingDigest !== specialistDigest(prepared.binding)
          || all.some(item => item.event_id === "specialist-model-possible:" + assignmentId))
          reject("WORKFORCE_SPECIALIST_ORIGINAL_NATIVE_SOURCE_FENCED");
        const authority = await openWorkforceSpecialistPublicationAuthority("candidate");
        try { await readOriginalAttemptIdentity({ enrollment: authority.enrollment,
          directory: authority.config.witnessDirectory,
          publicationId: specialistPublicationId(prepared.binding.originalWorkId, assignmentId),
          bindingDigest: specialistDigest(prepared.binding), expectedHostDigest: specialistDigest({
            reference: boundary.hostReference, nativeBootstrap: boundary.nativeBootstrap }),
          expectedOriginalSourceDigest: specialistDigest({ intent: intended.body, nativeReady: nativeReady.body }),
          expectedMonotonicDeadline: String((boundary.nativeBootstrap as {deadlineMonotonicNanoseconds?: unknown})
            .deadlineMonotonicNanoseconds) }); }
        finally { await authority.close(); }
        await event(ctx, current.q, "SPECIALIST_MODEL_POSSIBLE", "specialist-model-possible:" + assignmentId,
          { assignmentId, bindingDigest: specialistDigest(prepared.binding), consumptionRef: prepared.use.consumption.ref,
            hostReference: boundary.hostReference, nativeBootstrap: boundary.nativeBootstrap,
            nativeAuthority: current.authority, possibleModelCall: true, outcome: "UNKNOWN_UNTIL_RESPONSE_OBSERVED",
            p3Leases: boundary.leases.map(lease => ({ resourceKey: lease.resourceKey, tokenSha256: specialistByteDigest(lease.token),
              fence: lease.fence, ownerId: lease.ownerId, leaseSeconds: lease.leaseSeconds })),
            jobId: execution.jobId, claimFence: execution.claimFence, at: new Date().toISOString(),
            automaticReplayAllowed: false, productionAdmission: "UNADMITTED" }, c);
        boundary.signal.throwIfAborted(); signal.throwIfAborted();
        await assertJobClaim(ctx, current.q, execution, c, deadlineAt);
        });
      },
      onOriginalDelivery: async boundary => {
        if (liveCallbackAttempted) reject("WORKFORCE_SPECIALIST_ORIGINAL_CALLBACK_REPLAY");
        liveCallbackAttempted = true;
        // Drain the pre-response checker before writing the one original result.
        // The candidate then loads and locks actual native/S5/job facts itself.
        await stopWatchdog();
        boundary.signal.throwIfAborted();
        await persistOriginal(boundary.result, boundary.signal);
      },
    }));
  } finally { await stopWatchdog(); }
  leaseSignal.throwIfAborted();
  if (!liveCallbackAttempted) await persistOriginal(result);
  else await boundedTx(ctx, 3000, async c => {
    await portfolioLock(ctx, c);
    const q = await programRow(ctx, id, c, true);
    await assertJobClaim(ctx, q, execution, c);
    const all = await events(ctx, q, c);
    const intent = all.find(item => item.event_id === "s6-intent:" + assignmentId);
    if (!intent || intent.body.bindingDigest !== specialistDigest(prepared.binding)
      || all.some(item => item.event_id === "specialist-physical-final:" + assignmentId))
      reject("WORKFORCE_SPECIALIST_ORIGINAL_FINAL_OBSERVATION_FENCED");
    const evidenceRef = await evidence(ctx, q, "specialist-physical-final:" + assignmentId,
      { schema: "finnor.workforce-specialist-physical-final.v1", assignmentId, result,
        bindingDigest: specialistDigest(prepared.binding), publicationDisposition,
        originalResultImmutable: true, newCandidatePermitted: false, acceptedOutcome: false }, c);
    const observed = observedSchedules(snapshot.computation, prepared.use.consumption.envelope, result, snapshot.rendered.inputBytes);
    const resourceObservation = await observeWorkforceUseTx({ auth: ctx }, c, q.budget,
      { consumptionId: prepared.use.consumption.ref.id, observationKey: "specialist-physical-final:" + assignmentId,
        actual: observed.actual, evidenceRef, possibleEffect: true,
        meterGaps: [...observed.gaps, "ORIGINAL_RESERVATION_RETAINED_NO_SETTLEMENT_AUTHORITY"] });
    await event(ctx, q, "SPECIALIST_PHYSICAL_FINAL_OBSERVATION", "specialist-physical-final:" + assignmentId,
      { assignmentId, evidenceRef, resourceObservation, publicationDisposition,
        countingBasis: "CUMULATIVE_ORIGINAL_OBSERVATION_NOT_ADDITIVE", originalResultImmutable: true,
        replayAllowed: false, acceptedOutcome: false, resourcesReleased: false, economicGain: null }, c);
    leaseSignal.throwIfAborted();
    await assertJobClaim(ctx, q, execution, c);
  });
  return true;
}
