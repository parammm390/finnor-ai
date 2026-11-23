/** Original candidate only. Proof/projection run under different enrolled OS/SQL roles. */
import type { ExperimentRef, TenantContext } from "@finnor/shared-types";
import type { JobExecutionContext } from "../../../../apps/worker/src/queue";
import { applyWorkforceCommand, checkWorkforceExecutionProgram, parseWorkforceCompilerInput,
  workforceDigest, workforceProgramGraph, type AuthenticatedWorkforceCommand,
  type WorkforceCompilerInput, type WorkforceExecutionProgram } from "../../../workforce/src/execution-program";
import { byteDigest, digest, fault } from "../../../capability-evolution/src/contracts";
import { CanonicalSpecialistAuthority } from "../../../capability-evolution/src/specialist-publication-authority";
import { candidateSchema, observationSchema, type PublicationCandidate } from "../../../capability-evolution/src/specialist-publication-protocol";
import { readOriginalAttemptIdentity, readOriginalPublicationWitness } from "../../../governed-execution/src/specialist-publication-witness";
import { specialistExecutionBindingSchema, type SpecialistExecutionBinding } from "../../../governed-execution/src/specialist-contract";
import type { WorkforceSpecialistResult } from "../../../governed-execution/src/executor-specialist";
import type { WorkforceSpecialistCapability } from "../../../capability-evolution/src/specialist-consumer";
import type { WorkforceAuthorityPin } from "./native-authority";
import { events, reference, reject, resolveNativeDefinitions, taskCreationObservation } from "./store";
import { loadSpecialistPublicationScope } from "./specialist";
import { nativeWorkforceTaskCreationRecordSchema } from "./contracts";
import { exactQuantity } from "../../../workforce/src/execution-program/exact";
import { deriveOriginalBusinessBounds, originalNativeReadySourceSchema } from "./specialist-original-source";
import { finalizeOriginalOriginPublication } from "../../../governed-execution/src/specialist-origin-collector-client";

export const specialistPublicationId = (workId: string, assignmentId: string) =>
  digest({ schema: "finnor.w2.original-publication-identity.v1", workId, assignmentId });
interface OriginalNativeInput {
  canonical: WorkforceCompilerInput;
  originalStatus: "ACTIVE" | "PARTIAL";
  assignmentId: string;
  authorityPins: WorkforceAuthorityPin[];
  exactExpected: unknown;
  observedValue: unknown;
  evidenceRef: ExperimentRef;
  originalAt: string;
  originalValidUntil: string;
}
interface HistoricalEvent { kind: string; event_id: string; request_digest: string; body: Record<string, unknown> }
interface OriginalDelta {
  program: WorkforceExecutionProgram;
  heads: Array<{ assignment_id: string; body: unknown; state: string; revision: number; holds_capacity: boolean }>;
  events: HistoricalEvent[];
  status: string;
  historicalCheck: ReturnType<typeof checkWorkforceExecutionProgram>;
}
function historicalEvent(kind: string, event_id: string, body: Record<string, unknown>): HistoricalEvent {
  return { kind, event_id, request_digest: workforceDigest(body), body };
}
/** Pure independent replay from the LOCKED ORIGINAL input. Never resolves current
 * authority, uses current time, calls S5/model, or issues an ordinary DB command. */
export function recomputeOriginalDelta(program: WorkforceExecutionProgram, raw: OriginalNativeInput): OriginalDelta {
  const input = structuredClone(raw), canonical = parseWorkforceCompilerInput(input.canonical);
  canonical.now = input.originalAt;
  const assignment = program.assignments.find(a => a.id === input.assignmentId);
  const graph = workforceProgramGraph(program), task = graph.tasks.find(t => t.id === assignment?.taskId);
  const criterion = graph.criteria.find(c => c.id === task?.criterionId);
  const pin = input.authorityPins.find(p => p.id === input.assignmentId);
  const roles = pin?.proof.roles;
  const producer = roles?.find(r => r.role === "PRODUCER_RESPOND");
  const checker = roles?.find(r => r.role === "CHECKER_RESPOND");
  if (!producer || !checker) reject("WORKFORCE_SPECIALIST_ORIGINAL_ROLES_REQUIRED");
  if (!assignment || !task || !criterion || !pin?.allowed || pin.digest !== workforceDigest(pin.proof)
    || pin.proof.originalRoot !== assignment.workId || pin.proof.assignmentId !== assignment.id
    || !roles?.length || roles.some(r => r.actorStatus !== "CURRENT" || r.source?.allowed !== true
      || r.source.principalId !== r.principalId)
    || producer?.actorId !== assignment.actorId || checker?.actorId !== criterion.checkerActorId
    || !producer?.principalId || !checker?.principalId || producer.principalId === checker.principalId
    || criterion.checkerActorId === assignment.actorId || criterion.evidenceCustodianActorId === assignment.actorId
    || task.effectId !== null || task.ceiling.effects.length
    || workforceDigest(input.observedValue) !== workforceDigest(input.exactExpected)
    || Date.parse(input.originalAt) >= Date.parse(input.originalValidUntil))
    reject("WORKFORCE_SPECIALIST_ORIGINAL_NATIVE_EVIDENCE_REJECTED");
  const delivery = { assignmentId: assignment.id, actorId: assignment.actorId, termsDigest: assignment.termsDigest,
    evidenceRefs: [input.evidenceRef], custodianActorId: criterion.evidenceCustodianActorId, at: input.originalAt };
  const deliveryRef = reference("S1", program.id + ":original-specialist-delivery:" + assignment.id, delivery);
  const verification = { assignmentId: assignment.id, deliveryRef, criterionRef: criterion.ref,
    checkerActorId: criterion.checkerActorId, custodianActorId: criterion.evidenceCustodianActorId,
    evidenceRefs: [input.evidenceRef], result: "SATISFIED" as const, at: input.originalAt };
  const verificationRef = reference("S1", program.id + ":original-specialist-verification:" + assignment.id, verification);
  canonical.deliveries.push({ ...delivery, ref: deliveryRef });
  canonical.verifications.push({ ...verification, ref: verificationRef });
  const rows = [
    historicalEvent("DELIVERY", "delivery:original-specialist:" + assignment.id,
      { observation: { ...delivery, ref: deliveryRef }, value: input.observedValue,
        origin: "ACTUAL_ORIGINAL_S6_OUTPUT", historicalProjection: true }),
    historicalEvent("VERIFICATION", "verification:original-specialist:" + assignment.id,
      { observation: { ...verification, ref: verificationRef }, evaluator: "ORIGINAL_LITERAL_CRITERION_COMPARATOR",
        claimedHumanJudgment: false, historicalProjection: true }),
  ];
  let current = program;
  for (const [role, action] of [
    [producer, { kind: "DELIVER", deliveryRef }],
    [checker, { kind: "VERIFY", verificationRef }],
  ] as const) {
    const id = program.id + ":original-specialist:" + action.kind + ":" + assignment.id;
    const authorityRef = reference("authority", id, { originalSource: role.source,
      originalSourceDigest: workforceDigest(role.source), actorId: role.actorId, action });
    const command: AuthenticatedWorkforceCommand = { id, actorId: role.actorId, assignmentId: assignment.id,
      expectedRevision: current.revision, at: input.originalAt, authorityRef, action };
    const authority = { ref: authorityRef, commandId: id, actorId: role.actorId, assignmentId: assignment.id,
      commandDigest: workforceDigest(command), actions: [action.kind],
      validFrom: input.originalAt, validUntil: input.originalValidUntil };
    canonical.commandAuthorities.push(authority);
    const applied = applyWorkforceCommand(current, command, canonical);
    if (applied.status === "REJECTED") reject("WORKFORCE_SPECIALIST_ORIGINAL_COMMAND_REJECTED", 409, applied.issues);
    current = applied.program;
    rows.push(historicalEvent("COMMAND_AUTHORITY", "authority:" + id,
      { observation: authority, originalSource: role.source, historicalProjection: true }));
    rows.push(historicalEvent("COMMAND", "command:" + id,
      { command, authenticatedPrincipal: role.principalId, historicalProjection: true }));
  }
  const historicalCheck = checkWorkforceExecutionProgram(current, canonical);
  if (!historicalCheck.valid) reject("WORKFORCE_SPECIALIST_ORIGINAL_INDEPENDENT_CHECK_REJECTED", 409, historicalCheck);
  const updated = current.assignments.find(a => a.id === assignment.id)!;
  // A verified assignment still holds capacity. Closure/compensation is a
  // separate current-authority operation and cannot be inferred from this proof.
  return { program: current, heads: [{ assignment_id: assignment.id, body: updated,
    state: updated.state.kind, revision: current.revision, holds_capacity: true }],
    events: rows, status: input.originalStatus, historicalCheck };
}

function assertNativeOriginalBounds(candidate: PublicationCandidate, binding: SpecialistExecutionBinding, native: OriginalNativeInput) {
  const named = new Map(candidate.bounds.map(bound => [bound.name, bound]));
  const original = named.get("BINDING_ORIGINAL"), effective = named.get("BINDING_EFFECTIVE"), scope = named.get("NATIVE_SCOPE");
  if (named.size !== candidate.bounds.length || !original || !effective || !scope
    || BigInt(original.upper) !== BigInt(Date.parse(binding.originalDeadline)) * 1000n
    || BigInt(effective.upper) !== BigInt(Date.parse(binding.effectiveDeadline)) * 1000n
    || BigInt(scope.upper) > BigInt(Date.parse(native.originalValidUntil)) * 1000n)
    reject("WORKFORCE_SPECIALIST_NAMED_ORIGINAL_OWNER_BOUNDS_NOT_ROOT_BOUND");
}
function assertOriginalLiveResult(raw: unknown, binding: SpecialistExecutionBinding, hostDigest: string) {
  const result = raw as Partial<WorkforceSpecialistResult> | null;
  const usage = result?.kernelUsage, model = result?.modelUsage, provenance = result?.provenance;
  if (!result || result.successful !== true || result.errorCode !== null || result.exitCode !== null
    || result.signal !== null || result.possibleModelCall !== true || result.modelResponseReceived !== true
    || !usage || usage.stopped !== false || usage.cleanupStatus !== "NOT_RUN" || usage.memoryOomKills !== "0"
    || [usage.cpuMicros, usage.memoryPeakBytes, usage.pidsPeak, usage.pidsObserved].some(v => !/^\d+$/.test(v ?? ""))
    || BigInt(usage.pidsObserved!) < 2n || !Array.isArray(usage.meterGaps)
    || !usage.meterGaps.includes("ORIGINAL_PHYSICAL_LIFETIME_NOT_CLOSED")
    || !model || model.model !== binding.modelIdentity.model
    || [model.inputTokens, model.outputTokens, model.responseBytes].some(v => !Number.isSafeInteger(v) || Number(v) < 0)
    || provenance?.publicationPhase !== "LIVE_ORIGINAL_CANDIDATE" || provenance.physicalLifetimeClosed !== false
    || provenance.physicalSlotReleased !== false || provenance.bindingDigest !== digest(binding)
    || provenance.originalDeadline !== binding.originalDeadline || provenance.effectiveDeadline !== binding.effectiveDeadline
    || digest({ reference: provenance.hostReference, nativeBootstrap: provenance.nativeBootstrap }) !== hostDigest)
    reject("WORKFORCE_SPECIALIST_ORIGINAL_LIVE_RESULT_REQUIRED");
}
export async function commitOriginalSpecialistCandidate(input: {
  authority: CanonicalSpecialistAuthority; ctx: TenantContext; programmeId: string; assignmentId: string;
  execution: Readonly<JobExecutionContext>; binding: SpecialistExecutionBinding; admission: WorkforceSpecialistCapability;
  originalSignal: AbortSignal;
}): Promise<{ status: "CANDIDATE_COMMITTED" | "UNKNOWN_READ_ONLY"; publicationId: string }> {
  const { authority, ctx, execution } = input;
  const signal = AbortSignal.any([input.originalSignal, ...(execution.leaseLossSignal ? [execution.leaseLossSignal] : [])]);
  signal.throwIfAborted();
  if (authority.config.role !== "candidate") fault("SPECIALIST_CANDIDATE_ROLE_REQUIRED", 403);
  const publicationId = specialistPublicationId(input.binding.originalWorkId, input.assignmentId);
  // A known original never opens a fresh candidate transaction or inserts again.
  if (await authority.observeOriginal(publicationId)) return { status: "UNKNOWN_READ_ONLY", publicationId };
  const client = await authority.candidateConnection();
  let commitAttempted = false, released = false;
  const abort = () => {
    if (!released) { released = true; client.release(Error("SPECIALIST_ORIGINAL_LIVE_SIGNAL_LOST")); }
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)", [ctx.tenantId, ctx.userId]);
    signal.throwIfAborted();
    await client.query("SELECT finnor_specialist.open_candidate_scope($1,$2,$3,$4,$5,$6,$7)",
      [ctx.tenantId, ctx.userId, input.programmeId, input.assignmentId, execution.jobId,
        String(execution.claimFence), byteDigest(Buffer.from(execution.claimToken))]);
    const scope = await loadSpecialistPublicationScope(ctx, input.programmeId, input.assignmentId, execution, client);
    const all = await events(ctx, scope.q, client);
    const intended = all.find(e => e.event_id === "s6-intent:" + input.assignmentId);
    const observed = all.find(e => e.event_id === "s6-result:" + input.assignmentId);
    const possible = all.find(e => e.event_id === "specialist-model-possible:" + input.assignmentId);
    const nativeReady = all.find(e => e.event_id === "specialist-native-ready:" + input.assignmentId);
    const binding = specialistExecutionBindingSchema.parse(intended?.body.binding);
    const result = observed?.body.execution as { successful?: boolean; value?: unknown } | undefined;
    const evidenceRef = observed?.body.evidenceRef as ExperimentRef | undefined;
    if (digest(binding) !== digest(input.binding) || !observed || !evidenceRef || !result?.successful
      || observed.body.bindingDigest !== digest(binding) || scope.scopeDigest !== binding.acceptedScopeDigest
      || !possible || possible.body.bindingDigest !== digest(binding)
      || !nativeReady || nativeReady.body.bindingDigest !== digest(binding)
      || all.some(e => e.event_id === "recovery:" + input.assignmentId))
      reject("WORKFORCE_SPECIALIST_ORIGINAL_RESULT_UNAVAILABLE");
    const definitions = await resolveNativeDefinitions(ctx, scope.q, client);
    const criterion = definitions.criteria.find(c => c.id === scope.criterion.id);
    if (criterion?.acceptance.kind !== "EXACT_JSON") reject("WORKFORCE_SPECIALIST_ORIGINAL_LITERAL_CRITERION_REQUIRED");
    const epoch = await authority.readEpoch();
    if (digest(input.admission.canonicalAuthority) !== digest({ enrollmentDigest: epoch.enrollmentDigest,
      epoch: epoch.epoch, historyDigest: epoch.historyDigest }))
      reject("WORKFORCE_SPECIALIST_ORIGINAL_ADMISSION_EPOCH_CHANGED");
    const original = await readOriginalAttemptIdentity({ enrollment: authority.enrollment,
      directory: authority.config.witnessDirectory, publicationId, bindingDigest: digest(binding),
      expectedHostDigest: digest({ reference: possible.body.hostReference, nativeBootstrap: possible.body.nativeBootstrap }),
      expectedOriginalSourceDigest: digest({ intent: intended!.body, nativeReady: nativeReady!.body }),
      expectedMonotonicDeadline: String((possible.body.nativeBootstrap as {deadlineMonotonicNanoseconds?: unknown})
        .deadlineMonotonicNanoseconds) });
    assertOriginalLiveResult(result, binding, original.hostDigest);
    const native: OriginalNativeInput = { canonical: scope.canonical, assignmentId: input.assignmentId,
      originalStatus: (scope.q.compile_result as {status?: string} | null)?.status === "PARTIAL" ? "PARTIAL" : "ACTIVE",
      authorityPins: scope.authority, exactExpected: criterion.acceptance.expected, observedValue: observed.body.value,
      evidenceRef, originalAt: scope.canonical.now, originalValidUntil: new Date(scope.maximumDeadline).toISOString() };
    const delta = recomputeOriginalDelta(scope.program, native);
    const candidate = candidateSchema.parse({
      schema: "finnor.w2.original-publication-candidate.v1", publicationId,
      tenantId: ctx.tenantId, principalId: scope.q.principal_id, programmeId: scope.q.id, assignmentId: input.assignmentId,
      originalWorkId: scope.q.work_id, originalInputId: scope.q.work_input_id,
      originalMeaningDigest: scope.q.original_digest, originalScopeDigest: scope.scopeDigest,
      intentDigest: digest(intended!.body), bindingDigest: digest(binding), resultDigest: digest(result), resultRef: evidenceRef,
      budgetRef: binding.budgetRef, reservationRef: binding.reservationRef, consumptionRef: binding.consumptionRef,
      nativeRevision: scope.program.revision, nativeDigest: digest(scope.program), proposedDeltaDigest: digest(delta),
      sourceClosureDigest: binding.sourceClosureDigest, runtimeDigest: binding.runtimeDigest,
      hostDigest: original.hostDigest, bootId: original.bootId, guardianId: original.guardianId,
      cgroupId: original.cgroupId, processIdentity: original.processIdentity,
      originalMonotonicStart: original.originalMonotonicStart, originalMonotonicDeadline: original.originalMonotonicDeadline,
      bounds: original.originalUtcBounds, requiredOriginIds: authority.enrollment.body.origins.map(o => o.id),
      s8Epoch: epoch.epoch, enrollmentDigest: epoch.enrollmentDigest, primary: authority.enrollment.body.primary,
      jobId: execution.jobId, claimFence: String(execution.claimFence), claimTokenDigest: binding.job.claimTokenSha256,
      physicalContract: "LOGICAL_COMMIT",
    });
    // Exact named original owner bounds, never an arbitrary smaller bound.
    assertNativeOriginalBounds(candidate, binding, native);
    const backend = (await client.query(`SELECT pg_current_xact_id()::text xid8,pg_backend_pid() pid,
      backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
    if (!backend) reject("WORKFORCE_SPECIALIST_ORIGINAL_BACKEND_IDENTITY_UNKNOWN");
    // The separate committed marker consumes identity BEFORE possibly sending
    // candidate INSERT/COMMIT. A lost response can never create a fresh attempt.
    if (!await authority.reserveOriginal(candidate, backend.xid8, backend.pid, backend.backend_start)) {
      await client.query("ROLLBACK");
      return { status: "UNKNOWN_READ_ONLY", publicationId };
    }
    signal.throwIfAborted();
    const pre = observationSchema.parse((await client.query(
      "SELECT finnor_specialist.insert_candidate($1,$2,$3,$4,$5,$6) value",
      [ctx.tenantId, scope.q.principal_id, candidate, digest(candidate), delta, native])).rows[0]?.value);
    signal.throwIfAborted();
    commitAttempted = true;
    await client.query("COMMIT");
    signal.throwIfAborted();
    const post = observationSchema.parse((await client.query(
      "SELECT finnor_specialist.capture_original_upper($1,$2,$3) value",
      [ctx.tenantId, scope.q.principal_id, publicationId])).rows[0]?.value);
    signal.throwIfAborted();
    await finalizeOriginalOriginPublication({ enrollment: authority.enrollment, publicationId, signal });
    signal.throwIfAborted();
    await readOriginalPublicationWitness({ enrollment: authority.enrollment, candidate, pre, post,
      originalSourceDigest: digest({ intent: intended!.body, nativeReady: nativeReady!.body }),
      directory: authority.config.witnessDirectory, expectedDirectory: authority.config.witnessDirectory });
    signal.throwIfAborted();
    return { status: "CANDIDATE_COMMITTED", publicationId };
  } catch (error) {
    if (commitAttempted) return { status: "UNKNOWN_READ_ONLY", publicationId };
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    // Destroy a connection with a possibly outstanding COMMIT. Never send a
    // second COMMIT, BEGIN or INSERT to learn what the first one did.
    if (!released) client.release(commitAttempted ? Error("SPECIALIST_ORIGINAL_COMMIT_CONNECTION_CONSUMED") : undefined);
  }
}

/** Invoked only by the separately enrolled proof service. Original-only readback
 * plus genuine root witness and pure native replay; no original candidate retry. */
export async function proveOriginalSpecialistPublication(authority: CanonicalSpecialistAuthority, publicationId: string) {
  if (authority.config.role !== "proof") fault("SPECIALIST_PROOF_ROLE_REQUIRED", 403);
  const observed = await authority.observeOriginal(publicationId);
  if (!observed) return { status: "UNKNOWN_READ_ONLY" as const };
  if (!observed.candidateRow || observed.originalUpperCaptured !== true)
    return { status: "UNKNOWN_READ_ONLY" as const };
  if (observed.decision) return { status: "ORIGINAL_DECISION_ALREADY_RECORDED" as const };
  const row = observed.candidateRow;
  const candidate = candidateSchema.parse(row.candidate);
  const pre = observationSchema.parse(row.pre_observation), post = observationSchema.parse(observed.postObservation);
  if (candidate.publicationId !== publicationId || row.candidate_digest !== digest(candidate)
    || row.original_xid8 !== pre.xid8 || candidate.nativeDigest !== digest(row.locked_program.program)
    || candidate.proposedDeltaDigest !== digest(row.proposed_delta))
    reject("WORKFORCE_SPECIALIST_ORIGINAL_CANDIDATE_ROW_CHANGED");
  const native = row.locked_native_input as OriginalNativeInput;
  const originalAssignment = row.locked_program.program.assignments.find((a: {id: string}) => a.id === candidate.assignmentId);
  const originalTask = workforceProgramGraph(row.locked_program.program).tasks.find(t => t.id === originalAssignment?.taskId);
  const pin = native.authorityPins.find(pin => pin.id === candidate.assignmentId);
  const head = row.locked_heads.find((h: {assignment_id: string}) => h.assignment_id === candidate.assignmentId);
  if (!head || !originalAssignment || !originalTask
    || head.tenant_id !== candidate.tenantId || head.principal_id !== candidate.principalId
    || head.program_id !== candidate.programmeId || head.work_id !== candidate.originalWorkId
    || head.actor_id !== originalAssignment.actorId
    || head.recipient_principal_id !== pin?.proof.roles.find(r => r.role === "PRODUCER_RESPOND")?.principalId
    || head.checker_principal_id !== pin?.proof.roles.find(r => r.role === "CHECKER_RESPOND")?.principalId
    || digest(head.body) !== digest(originalAssignment) || digest(head.task) !== digest(originalTask)
    || Date.parse(head.slot_start) !== Date.parse(originalTask.slot.startAt)
    || Date.parse(head.slot_end) !== Date.parse(originalTask.slot.endAt)
    || exactQuantity(head.effort_seconds).compare(exactQuantity(originalTask.effortSeconds)) !== 0
    || head.holds_capacity !== true || head.revision > candidate.nativeRevision
    || native.originalStatus !== (row.locked_program.compile_result?.status === "PARTIAL" ? "PARTIAL" : "ACTIVE"))
    reject("WORKFORCE_SPECIALIST_ORIGINAL_NATIVE_HEAD_IDENTITY_CHANGED");
  const source = row.original_sources, originalInput = source?.input, originalWork = source?.work;
  const evidence = row.original_evidence, intent = row.original_intent, result = row.original_result;
  const binding = specialistExecutionBindingSchema.parse(intent?.binding);
  assertNativeOriginalBounds(candidate, binding, native);
  const originalReady = originalNativeReadySourceSchema.parse(source?.nativeReady);
  const allOriginalBounds = deriveOriginalBusinessBounds({ enrollment: authority.enrollment, binding,
    program: row.locked_program.program, original: row.locked_program.original, budget: row.locked_program.budget,
    nativeReady: originalReady, admission: intent.admittedDevelopmentMethod });
  if (digest(allOriginalBounds) !== digest(candidate.bounds)
    || digest(native.authorityPins) !== digest(originalReady.originalAcceptedSource.authority))
    reject("WORKFORCE_SPECIALIST_ALL_ORIGINAL_BOUNDS_OR_AUTHORITY_SUBSTITUTED");
  if (!source?.modelPossible || !source.nativeReady || source.modelPossible.bindingDigest !== digest(binding)
    || source.nativeReady.bindingDigest !== digest(binding)
    || source.nativeReady.publicationId !== candidate.publicationId
    || digest(source.nativeReady.hostReference) !== digest(source.modelPossible.hostReference)
    || digest(source.nativeReady.nativeBootstrap) !== digest(source.modelPossible.nativeBootstrap)
    || candidate.originalMonotonicDeadline !== source.modelPossible.nativeBootstrap?.deadlineMonotonicNanoseconds
    || candidate.hostDigest !== digest({ reference: source.modelPossible.hostReference,
      nativeBootstrap: source.modelPossible.nativeBootstrap }))
    reject("WORKFORCE_SPECIALIST_ORIGINAL_NATIVE_HOST_NOT_BOUND");
  if (!originalInput || !originalWork || originalInput.id !== candidate.originalInputId
    || originalInput.work_id !== candidate.originalWorkId || originalInput.tenant_id !== candidate.tenantId
    || originalWork.id !== candidate.originalWorkId || originalWork.tenant_id !== candidate.tenantId
    || originalInput.instruction_text !== originalWork.initial_instruction
    || byteDigest(Buffer.from(originalInput.instruction_text)) !== candidate.originalMeaningDigest
    || digest(JSON.parse(originalInput.instruction_text)) !== digest(row.locked_program.original)
    || digest(intent) !== candidate.intentDigest || digest(binding) !== candidate.bindingDigest
    || digest(result?.execution) !== candidate.resultDigest || result?.execution?.successful !== true
    || result?.bindingDigest !== candidate.bindingDigest || digest(result?.evidenceRef) !== digest(candidate.resultRef)
    || evidence?.id !== candidate.resultRef.id || String(evidence?.version_number) !== candidate.resultRef.version
    || evidence?.tenant_id !== candidate.tenantId || evidence?.content_hash !== candidate.resultRef.contentDigest
    || typeof evidence?.content !== "string"
    || byteDigest(Buffer.from(evidence.content)) !== candidate.resultRef.contentDigest
    || binding.originalWorkId !== candidate.originalWorkId || binding.originalInputId !== candidate.originalInputId
    || binding.originalMeaningDigest !== candidate.originalMeaningDigest
    || binding.job.id !== candidate.jobId || String(binding.job.claimFence) !== candidate.claimFence
    || binding.job.claimTokenSha256 !== candidate.claimTokenDigest
    || binding.acceptedScopeDigest !== candidate.originalScopeDigest
    || binding.sourceClosureDigest !== candidate.sourceClosureDigest || binding.runtimeDigest !== candidate.runtimeDigest
    || digest(binding.budgetRef) !== digest(candidate.budgetRef)
    || digest(binding.reservationRef) !== digest(candidate.reservationRef)
    || digest(binding.consumptionRef) !== digest(candidate.consumptionRef))
    reject("WORKFORCE_SPECIALIST_ORIGINAL_SOURCE_RECOMPUTATION_MISMATCH");
  const sourceObservation = JSON.parse(evidence.content);
  assertOriginalLiveResult(result.execution, binding, candidate.hostDigest);
  if (sourceObservation.schema !== "finnor.workforce-specialist-observation.v1"
    || sourceObservation.assignmentId !== candidate.assignmentId
    || digest(sourceObservation.binding) !== candidate.bindingDigest
    || digest(sourceObservation.result) !== candidate.resultDigest
    || digest(sourceObservation.result.value) !== digest(native.observedValue)
    || digest(result.value) !== digest(native.observedValue))
    reject("WORKFORCE_SPECIALIST_ORIGINAL_S1_S6_RESULT_SUBSTITUTED");
  const assignment = row.locked_program.program.assignments.find((a: {id: string}) => a.id === candidate.assignmentId);
  const task = workforceProgramGraph(row.locked_program.program).tasks.find(t => t.id === assignment?.taskId);
  let originalCriterion = row.locked_program.original.outcome.criteria.find((c: {id: string}) => c.id === task?.criterionId);
  for (const creation of source.creationEvidence ?? []) {
    const ref = creation.event?.body?.observation?.ref, version = creation.version;
    if (!ref || ref.owner !== "S1" || ref.id !== version?.id || ref.version !== String(version?.version_number)
      || ref.contentDigest !== version?.content_hash || typeof version?.content !== "string"
      || byteDigest(Buffer.from(version.content)) !== ref.contentDigest
      || creation.source?.source_key !== "workforce:" + candidate.programmeId + ":" + creation.event.event_id)
      reject("WORKFORCE_SPECIALIST_ORIGINAL_CREATION_SOURCE_UNAVAILABLE");
    const record = nativeWorkforceTaskCreationRecordSchema.parse(JSON.parse(version.content));
    if (record.programmeId !== candidate.programmeId || record.originalWorkId !== candidate.originalWorkId
      || record.originalMeaningDigest !== candidate.originalMeaningDigest
      || record.authenticatedPrincipalId !== creation.event.body.authenticatedPrincipal
      || digest(taskCreationObservation(record, ref)) !== digest(creation.event.body.observation))
      reject("WORKFORCE_SPECIALIST_ORIGINAL_CREATION_BINDING_CHANGED");
    if (record.criterion.id === task?.criterionId) {
      if (originalCriterion) reject("WORKFORCE_SPECIALIST_ORIGINAL_CRITERION_AMBIGUOUS");
      originalCriterion = record.criterion;
    }
  }
  if (!originalCriterion || originalCriterion.acceptance.kind !== "EXACT_JSON"
    || digest(originalCriterion.acceptance.expected) !== digest(native.exactExpected))
    reject("WORKFORCE_SPECIALIST_ORIGINAL_CRITERION_SUBSTITUTED");
  const delta = recomputeOriginalDelta(row.locked_program.program, native);
  if (digest(delta) !== candidate.proposedDeltaDigest
    || digest(native.evidenceRef) !== digest(candidate.resultRef))
    reject("WORKFORCE_SPECIALIST_ORIGINAL_DELTA_RECOMPUTATION_MISMATCH");
  const witness = await readOriginalPublicationWitness({ directory: authority.config.witnessDirectory,
    originalSourceDigest: digest({ intent, nativeReady: source.nativeReady }),
    expectedDirectory: authority.config.witnessDirectory, enrollment: authority.enrollment, candidate, pre, post });
  const decision = { schema: "finnor.w2.verified-original-publication-decision.v1",
    status: "ACCEPTED_ORIGINAL_COMMIT", publicationId, candidateDigest: digest(candidate),
    proposedDeltaDigest: digest(delta), xid8: pre.xid8, primary: candidate.primary,
    interval: witness.interval, witnessDigest: witness.evidenceDigest, historicalCheck: delta.historicalCheck,
    nativeRevision: candidate.nativeRevision, originalOnly: true, currentAuthorityGranted: false,
    budgetRenewed: false, physicalReplayPermitted: false, economicGain: null };
  await authority.decideOriginal(publicationId, decision,
    { preObservation: pre, postObservation: post, nativeReplayDigest: digest(delta), witness: witness.evidence });
  return { status: "ORIGINAL_DECISION_RECORDED" as const, publicationId };
}
export async function projectOriginalSpecialistPublication(authority: CanonicalSpecialistAuthority, publicationId: string) {
  if (authority.config.role !== "projection") fault("SPECIALIST_HISTORICAL_PROJECTION_ROLE_REQUIRED", 403);
  return authority.projectOriginal(publicationId);
}
