/** Actual original S6/native readback. No input-body or bound-array admission port. */
import { z } from "zod";
import { byteDigest, digest, fault, sameRef } from "../../../capability-evolution/src/contracts";
import { CanonicalSpecialistAuthority } from "../../../capability-evolution/src/specialist-publication-authority";
import { currentWorkforceSpecialistCapability, type WorkforceSpecialistCapability } from "../../../capability-evolution/src/specialist-consumer";
import { assertCurrentEnrollment, assertVerifiedEnrollment, immutable, integer,
  type VerifiedEnrollment } from "../../../capability-evolution/src/specialist-publication-protocol";
import { parseWorkforceCompilerInput, parseWorkforceExecutionProgram, workforceCanonicalGraph,
  checkWorkforceUse, type WorkforceAssignment, type WorkforceCompilerInput } from "../../../workforce/src/execution-program";
import { specialistComputationSchema, specialistExecutionBindingSchema, specialistRefSchema,
  type SpecialistExecutionBinding } from "../../../governed-execution/src/specialist-contract";
import { nativeOriginPhysicsSchema, initialJobClaimSchema, initialP3GrantSchema } from "../../../governed-execution/src/specialist-origin-contract";
import { readOwnerTransportReference } from "../../../governed-execution/src/owner-transport";
import { nativeWorkforceOriginalSchema, nativeWorkforceTaskCreationRecordSchema } from "./contracts";

const text = z.string().min(1).max(4096), hex = z.string().regex(/^[a-f0-9]{64}$/);
const sourceContent = z.string().min(1).max(8 * 1024 * 1024);
const lifetime = z.object({ completion_deadline: text.nullable(), expires_at: text.nullable(), valid_from: text }).strict();
const originalAuthorityScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tenant") }).strict(),
  z.object({ kind: z.literal("resources"), resourceType: text.optional(),
    resourceIds: z.array(text).max(16384).optional() }).strict(),
  z.object({ kind: z.literal("assigned") }).strict(),
  z.object({ kind: z.literal("self") }).strict(),
  z.object({ kind: z.literal("unavailable") }).strict(),
]);
const originalAuthorityPinSchema = z.object({ id: text, digest: hex, allowed: z.literal(true),
  proof: z.object({ schema: z.literal("finnor.workforce-native-authority-source.v1"), assignmentId: text,
    originalRoot: text, executionAuthorityGranted: z.literal(false),
    roles: z.array(z.object({
      role: z.enum(["PRODUCER_RESPOND", "DELEGATOR_ASSIGN", "CHECKER_RESPOND", "CUSTODIAN_READ"]),
      actorId: text, principalId: text, actorStatus: z.literal("CURRENT"),
      source: z.object({ schema: z.literal("finnor.current-canonical-authority-source.v1"),
        principalId: text, request: z.object({ operation: z.enum(["query", "action"]), capability: text,
          workId: text, resource: z.object({ type: text, id: text }).strict(), risk: z.literal("low") }).strict(),
        employee: z.object({ id: text, status: z.literal("active"), role: z.enum(["owner", "participant"]) }).strict(),
        applicable: z.array(z.object({
          assignment: z.object({ id: text, roleId: text, scope: originalAuthorityScope,
            validFrom: text, validUntil: text.nullable() }).strict(),
          grant: z.object({ id: text, roleId: text, capability: text, resourceType: text,
            effect: z.enum(["allow", "deny"]), maxAmountUsd: text.nullable(),
            maxRisk: z.enum(["low", "medium", "high"]), approvalRequired: z.boolean(),
            approvalChainId: text.nullable() }).strict(),
        }).strict()).min(1).max(16384),
        allowed: z.literal(true), executionAuthorityGranted: z.literal(false),
      }).strict(),
    }).strict()).length(4),
  }).strict(),
}).strict();
const captured = z.object({ canonical: z.unknown(), authority: z.array(originalAuthorityPinSchema).min(1).max(8),
  agentLifetimes: z.array(lifetime).max(128), scopeDigest: hex }).strict();
const lease = z.object({ resourceKey: text, tokenSha256: hex, fence: z.number().int().positive(),
  ownerId: text, leaseSeconds: z.number().int().positive() }).strict();
export const originalNativeReadySourceSchema = z.object({
  schema: z.literal("finnor.w2.original-native-ready-source.v1"), publicationId: hex, assignmentId: text,
  bindingDigest: hex, intentEventId: text, hostReference: nativeOriginPhysicsSchema.shape.hostReference,
  nativeBootstrap: nativeOriginPhysicsSchema.shape.nativeBootstrap,
  nativeSource: captured, originalAcceptedSource: captured, p3Leases: z.array(lease).length(3),
  initialJobClaim: initialJobClaimSchema, initialP3Grants: z.array(initialP3GrantSchema).length(3),
  jobId: text, claimFence: z.number().int().positive(), possibleModelCall: z.literal(false),
  replayAllowed: z.literal(false), productionAdmission: z.literal("UNADMITTED"),
}).strict();
const event = z.object({ tenant_id: text, program_id: text, principal_id: text,
  event_id: text, kind: text, request_digest: hex, body: z.unknown(), created_at: text }).passthrough();
const budgetSchema = z.object({ schema: z.literal("finnor.s5.workforce-budget.v1"), ref: specialistRefSchema,
  tenantId: text, principalId: text, workId: text, programmeId: text, reservationRef: specialistRefSchema,
  validUntil: text }).passthrough();
const consumptionSchema = z.object({ schema: z.literal("finnor.s5.workforce-consumption.v1"), ref: specialistRefSchema,
  tenantId: text, principalId: text, programmeId: text, nodeId: text, decisionDigest: hex,
  operationKey: text, idempotencyKey: text, requestDigest: hex, reservationRef: specialistRefSchema }).passthrough();
export const originalAttemptSourceReadbackSchema = z.object({
  schema: z.literal("finnor.specialist.actual-original-attempt-source.v1"), enrollmentDigest: hex, epoch: integer,
  primary: z.unknown(), nativeReady: event, intent: event,
  programme: z.object({ tenant_id: text, principal_id: text, id: text, work_id: text, work_input_id: text,
    status: z.enum(["ACTIVE", "PARTIAL"]),
    original_digest: hex, original: z.unknown(), budget: z.unknown(), program: z.unknown() }).passthrough(),
  work: z.object({ id: text, tenant_id: text, created_by: text, initial_instruction: sourceContent }).passthrough(),
  input: z.object({ id: text, work_id: text, tenant_id: text, created_by: text, instruction_text: sourceContent }).passthrough(),
  job: z.object({ id: text, tenantId: text, status: z.literal("running"), type: z.literal("run_workforce_execution_v1"),
    protocolVersion: z.literal(1), payload: z.object({ tenantId: text, principalId: text, programId: text,
      phase: z.enum(["ADVANCE", "RECONCILE"]) }).passthrough(), claimFence: integer,
    claimTokenDigest: hex, workerId: text, currentLeaseLive: z.literal(true) }).strict(),
  budget: budgetSchema, consumption: consumptionSchema, heads: z.array(z.unknown()).min(1).max(4096),
  creationEvidence: z.array(z.object({ event, source: z.object({ source_key: text }).passthrough(),
    version: z.object({ id: text, tenant_id: text, content: sourceContent, content_hash: hex,
      version_number: z.union([text, z.number().int().positive()]) }).passthrough() }).strict()).max(512),
}).strict();
export interface OriginalBusinessBound { readonly name: string; readonly lower: string; readonly upper: string }
const actual = new WeakSet<object>();
export interface VerifiedOriginalBusinessSource {
  readonly publicationId: string; readonly originalSourceDigest: string; readonly enrollmentDigest: string;
  readonly binding: SpecialistExecutionBinding; readonly physics: z.infer<typeof nativeOriginPhysicsSchema>;
  readonly originalUtcBounds: readonly OriginalBusinessBound[];
  readonly initialJobClaim: z.infer<typeof initialJobClaimSchema>;
  readonly initialP3Grants: readonly z.infer<typeof initialP3GrantSchema>[];
  readonly p3: readonly z.infer<typeof lease>[]; readonly s8Epoch: string; readonly s8HistoryDigest: string;
}
export function assertVerifiedOriginalBusinessSource(value: VerifiedOriginalBusinessSource) {
  if (!actual.has(value)) fault("SPECIALIST_ACTUAL_ORIGINAL_BUSINESS_SOURCE_REQUIRED", 503);
}
function micros(value: string, lower = false) {
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) fault("SPECIALIST_ORIGINAL_SOURCE_TIME_REQUIRED", 503);
  const fraction = /[T ]\d{2}:\d{2}:\d{2}\.(\d+)/.exec(value)?.[1] ?? "";
  const remainder = BigInt(fraction.slice(3, 6).padEnd(3, "0") || "0");
  return BigInt(parsed) * 1000n + remainder + (lower && /[1-9]/.test(fraction.slice(6)) ? 1n : 0n);
}
function assertOriginalOutcome(canonical: WorkforceCompilerInput,
  original: z.infer<typeof nativeWorkforceOriginalSchema>, binding: SpecialistExecutionBinding) {
  const { ref, ...outcome } = canonical.outcome;
  const expected = { ...original.outcome,
    criteria: original.outcome.criteria.map(({ id, checkerActorId, evidenceCustodianActorId }) =>
      ({ id, checkerActorId, evidenceCustodianActorId })),
    workId: binding.originalWorkId, rootId: binding.originalWorkId, requesterActorId: binding.principalId };
  const actual = { ...outcome, criteria: outcome.criteria.map(({ ref: _ref, ...criterion }) => criterion) };
  if (digest(actual) !== digest(expected) || ref.owner !== "Work" || ref.id !== binding.originalInputId
    || ref.contentDigest !== digest({ originalDigest: binding.originalMeaningDigest, workId: binding.originalWorkId }))
    fault("SPECIALIST_ORIGINAL_SOURCE_WORK_OUTCOME_CHANGED", 503);
  for (const criterion of outcome.criteria) {
    const raw = original.outcome.criteria.find(value => value.id === criterion.id);
    if (!raw || criterion.ref.owner !== "Work" || criterion.ref.id !== binding.originalInputId + ":criterion:" + criterion.id
      || criterion.ref.contentDigest !== digest(raw))
      fault("SPECIALIST_ORIGINAL_SOURCE_WORK_CRITERION_CHANGED", 503);
  }
}
/** Historical pure recomputation from durable originals, never fresh authority. */
export function deriveOriginalBusinessBounds(input: {
  enrollment: VerifiedEnrollment; binding: SpecialistExecutionBinding; program: unknown;
  original: unknown; budget: unknown; nativeReady: unknown; admission: WorkforceSpecialistCapability;
}): readonly OriginalBusinessBound[] {
  assertVerifiedEnrollment(input.enrollment);
  const e = input.enrollment, binding = specialistExecutionBindingSchema.parse(input.binding),
    ready = originalNativeReadySourceSchema.parse(input.nativeReady),
    original = nativeWorkforceOriginalSchema.parse(input.original), budget = budgetSchema.parse(input.budget),
    admitted = input.admission, program = parseWorkforceExecutionProgram(input.program),
    accepted = parseWorkforceCompilerInput(ready.originalAcceptedSource.canonical),
    canonical = parseWorkforceCompilerInput(ready.nativeSource.canonical), graph = workforceCanonicalGraph(canonical);
  assertOriginalOutcome(accepted, original, binding); assertOriginalOutcome(canonical, original, binding);
  const lineage: WorkforceAssignment[] = [];
  let cursor = program.assignments.find(a => a.id === ready.assignmentId);
  while (cursor) {
    if (lineage.length >= 8 || lineage.some(a => a.id === cursor!.id))
      fault("SPECIALIST_ORIGINAL_SOURCE_LINEAGE_REQUIRED", 503);
    lineage.push(cursor);
    if (cursor.parentAssignmentId === null) break;
    cursor = program.assignments.find(a => a.id === cursor!.parentAssignmentId);
    if (!cursor) fault("SPECIALIST_ORIGINAL_SOURCE_PARENT_REQUIRED", 503);
  }
  const task = graph.tasks.find(t => t.id === lineage[0]?.taskId);
  if (!task || !lineage.length || ready.assignmentId !== binding.assignmentId
    || ready.bindingDigest !== digest(binding) || digest(task) !== binding.taskDigest
    || ready.hostReference.bindingDigest !== digest(binding)
    || original.outcome.deadline !== binding.originalDeadline || !sameRef(budget.ref, binding.budgetRef))
    fault("SPECIALIST_ORIGINAL_SOURCE_BOUND_INPUT_CHANGED", 503);
  const bounds: OriginalBusinessBound[] = [], add = (name: string, lower: bigint, upper: bigint) => {
    if (lower < 0n || lower >= upper || bounds.some(b => b.name === name))
      fault("SPECIALIST_ORIGINAL_SOURCE_WINDOW_INVALID", 503);
    bounds.push({ name, lower: String(lower), upper: String(upper) });
  };
  const until = (name: string, value: string) => add(name, 0n, micros(value));
  until("BINDING_ORIGINAL", original.outcome.deadline); until("BINDING_EFFECTIVE", binding.effectiveDeadline);
  until("BUDGET", budget.validUntil); until("TASK_DUE", task.dueAt);
  until("S8_ADMISSION", admitted.validUntil);
  until("TASK_TERMS", task.terms.expiresAt);
  add("TASK_CEILING", micros(task.ceiling.validFrom, true), micros(task.ceiling.validUntil));
  add("TASK_SLOT", micros(task.slot.startAt, true), micros(task.slot.endAt));
  add("OUTCOME_CEILING", micros(accepted.outcome.ceiling.validFrom, true), micros(accepted.outcome.ceiling.validUntil));
  for (const a of lineage) {
    add("ASSIGNMENT_CEILING:" + a.id, micros(a.ceiling.validFrom, true), micros(a.ceiling.validUntil));
    until("ASSIGNMENT_TERMS:" + a.id, a.terms.expiresAt); until("ASSIGNMENT_ORIGINAL:" + a.id, a.originalDeadline);
  }
  if (digest(ready.nativeSource.authority) !== digest(ready.originalAcceptedSource.authority))
    fault("SPECIALIST_ORIGINAL_AUTHORITY_SOURCE_REPLACED", 503);
  const pins = ready.originalAcceptedSource.authority;
  const authorityLowers: bigint[] = [], authorityUppers: bigint[] = [];
  for (const pin of pins) {
    const a = lineage.find(a => a.id === pin.id), t = graph.tasks.find(t => t.id === a?.taskId),
      criterion = graph.criteria.find(c => c.id === t?.criterionId);
    if (!a || !criterion || digest(pin.proof) !== pin.digest || pin.proof.assignmentId !== pin.id
      || pin.proof.originalRoot !== binding.originalWorkId || new Set(pin.proof.roles.map(r => r.role)).size !== 4)
      fault("SPECIALIST_ORIGINAL_SOURCE_AUTHORITY_REQUIRED", 503);
    const expectedRoles = [
      { role: "PRODUCER_RESPOND", actorId: a.actorId, capability: "action:workforce_respond_contract",
        type: "workforce_assignment", id: a.id },
      { role: "DELEGATOR_ASSIGN", actorId: a.delegatorActorId, capability: "action:workforce_assign_contract",
        type: "workforce_assignment", id: a.parentAssignmentId ?? a.id },
      { role: "CHECKER_RESPOND", actorId: criterion.checkerActorId, capability: "action:workforce_respond_contract",
        type: "workforce_assignment", id: a.id },
      { role: "CUSTODIAN_READ", actorId: criterion.evidenceCustodianActorId, capability: "query:work",
        type: "work", id: binding.originalWorkId },
    ];
    for (const role of pin.proof.roles) {
      const expected = expectedRoles.find(r => r.role === role.role)!, s = role.source;
      const request = { operation: expected.capability.startsWith("query:") ? "query" : "action",
        capability: expected.capability, workId: binding.originalWorkId,
        resource: { type: expected.type, id: expected.id }, risk: "low" };
      if (role.actorId !== expected.actorId || role.principalId !== s.principalId
        || s.employee.id !== role.principalId || digest(s.request) !== digest(request)
        || new Set(s.applicable.map(v => v.assignment.id + ":" + v.grant.id)).size !== s.applicable.length
        || !s.applicable.some(v => v.grant.effect === "allow" && !v.grant.approvalRequired))
        fault("SPECIALIST_ORIGINAL_SOURCE_ROLE_AUTHORITY_REQUIRED", 503);
      for (const item of s.applicable) {
        const g = item.grant, scope = item.assignment.scope;
        const capabilityMatches = g.capability === "*" || g.capability === request.capability
          || g.capability.endsWith(":*") && request.capability.startsWith(g.capability.slice(0, -1));
        if (g.roleId !== item.assignment.roleId || g.effect === "deny" || !capabilityMatches
          || g.resourceType !== "*" && g.resourceType !== request.resource.type
          || scope.kind === "unavailable" || scope.kind === "self"
          || scope.kind === "assigned" && request.resource.type !== "work"
          || scope.kind === "resources" && (scope.resourceType !== undefined && scope.resourceType !== "*"
            && scope.resourceType !== request.resource.type || !scope.resourceIds?.includes(request.resource.id)))
          fault("SPECIALIST_ORIGINAL_SOURCE_ROLE_GRANT_REQUIRED", 503);
        authorityLowers.push(micros(item.assignment.validFrom, true));
        if (item.assignment.validUntil) authorityUppers.push(micros(item.assignment.validUntil));
      }
    }
  }
  if (new Set(pins.map(p => p.id)).size !== lineage.length || pins.length !== lineage.length)
    fault("SPECIALIST_ORIGINAL_SOURCE_COMPLETE_AUTHORITY_REQUIRED", 503);
  const maximum = (values: bigint[]) => values.reduce((a, b) => a > b ? a : b, 0n);
  const minimum = (values: bigint[]) => values.reduce((a, b) => a < b ? a : b);
  add("NATIVE_AUTHORITY", maximum(authorityLowers),
    authorityUppers.length ? minimum(authorityUppers) : micros(binding.originalDeadline));
  const actorIds = new Set(pins.flatMap(p => p.proof.roles.map(r => r.actorId)));
  const actors = accepted.actors.filter(a => actorIds.has(a.id));
  if (actors.length !== actorIds.size || actors.some(a => a.status !== "CURRENT" || a.availability.kind !== "OBSERVED"))
    fault("SPECIALIST_ORIGINAL_SOURCE_ACTOR_CUSTODY_REQUIRED", 503);
  const availability = actors.flatMap(a => a.availability.kind === "OBSERVED" ? [micros(a.availability.validUntil)] : []);
  if (availability.length) add("ACTOR_AVAILABILITY", 0n, minimum(availability));
  const capabilities = lineage.flatMap(a => {
    const t = graph.tasks.find(t => t.id === a.taskId), actor = accepted.actors.find(actor => actor.id === a.actorId);
    return actor?.capabilities.filter(c => t?.requiredCapabilities.some(r => r.skill === c.skill && r.scope === c.scope)
      && micros(c.validUntil) > micros(accepted.now))
      .map(c => micros(c.validUntil)) ?? [];
  });
  if (capabilities.length) add("ACTOR_CAPABILITIES", 0n, minimum(capabilities));
  for (const [i, life] of ready.originalAcceptedSource.agentLifetimes.entries()) {
    const ends = [life.completion_deadline, life.expires_at].flatMap(v => v ? [micros(v)] : []);
    if (ends.length) add("AGENT_LIFETIME:" + i, micros(life.valid_from, true), minimum(ends));
  }
  // Match the actual owner's millisecond deadline arithmetic without replacing
  // the individual original microsecond source windows recorded above.
  add("NATIVE_SCOPE", maximum(bounds.map(b => BigInt(b.lower))),
    minimum(bounds.map(b => BigInt(b.upper))) / 1000n * 1000n);
  const job = ready.initialJobClaim;
  add("JOB", BigInt(job.initialAcquiredUtcMicros), BigInt(job.initialExpiresUtcMicros));
  for (const grant of ready.initialP3Grants)
    add("P3:" + grant.resourceKey, BigInt(grant.initialAcquiredUtcMicros), BigInt(grant.initialExpiresUtcMicros));
  add("P3", maximum(ready.initialP3Grants.map(g => BigInt(g.initialAcquiredUtcMicros))),
    minimum(ready.initialP3Grants.map(g => BigInt(g.initialExpiresUtcMicros))));
  until("CONTROLLER", binding.effectiveDeadline); until("COMBINED_ABORT", binding.effectiveDeadline);
  if (bounds.length > 128 || e.body.requiredBounds.some(name => !bounds.some(b => b.name === name)))
    fault("SPECIALIST_ORIGINAL_SOURCE_REQUIRED_BOUNDS_UNAVAILABLE", 503);
  return immutable(bounds);
}
export async function readVerifiedOriginalBusinessSource(
  authority: CanonicalSpecialistAuthority, publicationId: string, signal: AbortSignal,
): Promise<VerifiedOriginalBusinessSource> {
  if (process.platform !== "linux" || process.getuid?.() !== 0 || process.geteuid?.() !== 0
    || authority.config.role !== "reader") fault("SPECIALIST_ROOT_CANONICAL_SOURCE_READER_REQUIRED", 503);
  assertCurrentEnrollment(authority.enrollment); signal.throwIfAborted();
  await authority.assertDatabaseCustody();
  const before = await authority.readEpoch(), source = originalAttemptSourceReadbackSchema.parse(await authority.readOriginalAttemptSource(publicationId));
  const e = authority.enrollment, q = source.programme, ready = originalNativeReadySourceSchema.parse(source.nativeReady.body),
    intent = z.object({ binding: specialistExecutionBindingSchema, bindingDigest: hex,
      consumptionRef: specialistRefSchema }).passthrough().parse(source.intent.body),
    binding = intent.binding, original = nativeWorkforceOriginalSchema.parse(q.original),
    program = parseWorkforceExecutionProgram(q.program), canonical = parseWorkforceCompilerInput(ready.nativeSource.canonical),
    accepted = parseWorkforceCompilerInput(ready.originalAcceptedSource.canonical), graph = workforceCanonicalGraph(canonical);
  assertOriginalOutcome(accepted, original, binding); assertOriginalOutcome(canonical, original, binding);
  if (digest(ready.nativeSource.authority) !== digest(ready.originalAcceptedSource.authority))
    fault("SPECIALIST_ORIGINAL_AUTHORITY_SOURCE_REPLACED", 503);
  const assignment = program.assignments.find(a => a.id === ready.assignmentId), lineage: WorkforceAssignment[] = [];
  let cursor = assignment;
  while (cursor) {
    if (lineage.length >= 8 || lineage.some(a => a.id === cursor!.id))
      fault("SPECIALIST_ORIGINAL_SOURCE_LINEAGE_REQUIRED", 503);
    lineage.push(cursor);
    if (cursor.parentAssignmentId === null) break;
    cursor = program.assignments.find(a => a.id === cursor!.parentAssignmentId);
    if (!cursor) fault("SPECIALIST_ORIGINAL_SOURCE_PARENT_REQUIRED", 503);
  }
  const task = graph.tasks.find(t => t.id === assignment?.taskId), funding = canonical.funding.find(f => f.assignmentId === assignment?.id);
  if (!assignment || !task || !funding || funding.status !== "HELD"
    || !checkWorkforceUse(program, ready.assignmentId, canonical).allowed)
    fault("SPECIALIST_ORIGINAL_SOURCE_NATIVE_USE_REQUIRED", 503);
  const operations = original.operations.slice();
  for (const creation of source.creationEvidence) {
    const body = z.object({ observation: z.object({ ref: specialistRefSchema }).passthrough(),
      authenticatedPrincipal: text }).passthrough().parse(creation.event.body), ref = body.observation.ref;
    const record = nativeWorkforceTaskCreationRecordSchema.parse(JSON.parse(creation.version.content));
    if (ref.owner !== "S1" || ref.id !== creation.version.id || ref.version !== String(creation.version.version_number)
      || ref.contentDigest !== creation.version.content_hash || byteDigest(Buffer.from(creation.version.content)) !== ref.contentDigest
      || creation.version.tenant_id !== e.body.tenantId || creation.source.source_key !== "workforce:" + q.id + ":" + creation.event.event_id
      || record.programmeId !== q.id || record.originalWorkId !== q.work_id || record.originalMeaningDigest !== q.original_digest
      || record.authenticatedPrincipalId !== body.authenticatedPrincipal)
      fault("SPECIALIST_ORIGINAL_SOURCE_CREATION_PREIMAGE_REQUIRED", 503);
    operations.push({ taskId: record.task.id, computation: record.computation });
  }
  const selected = operations.filter(op => op.taskId === task.id);
  if (selected.length !== 1) fault("SPECIALIST_ORIGINAL_SOURCE_COMPUTATION_AMBIGUOUS", 503);
  const computation = specialistComputationSchema.parse(selected[0]!.computation), budget = source.budget, use = source.consumption;
  const { ref: budgetRef, ...budgetBody } = budget, { ref: consumptionRef, ...useBody } = use;
  if (digest(budget) !== digest(q.budget) || digest(budgetBody) !== budgetRef.contentDigest
    || digest(useBody) !== consumptionRef.contentDigest || !sameRef(use.reservationRef, budget.reservationRef)
    || budget.tenantId !== e.body.tenantId || budget.principalId !== e.body.principalId
    || budget.workId !== q.work_id || budget.programmeId !== q.id || use.tenantId !== budget.tenantId
    || use.principalId !== budget.principalId || use.programmeId !== q.id || use.nodeId !== assignment.id)
    fault("SPECIALIST_ORIGINAL_SOURCE_S5_READBACK_REQUIRED", 503);
  const scopeDigest = digest({ originalWorkId: q.work_id, originalInputId: q.work_input_id,
    originalMeaningDigest: q.original_digest, programmeId: q.id, task, computation, budgetRef,
    reservationRef: budget.reservationRef, carveRef: funding.ref,
    lineage: lineage.map(a => ({ id: a.id, actorId: a.actorId, parentAssignmentId: a.parentAssignmentId,
      rootId: a.rootId, workId: a.workId, originalDeadline: a.originalDeadline,
      termsDigest: a.termsDigest, terms: a.terms, ceiling: a.ceiling })) });
  const admitted = z.object({ admittedDevelopmentMethod: z.object({ schema: z.literal("finnor.s8.workforce-specialist-consumer-binding.v1"),
    mechanism: z.unknown() }).passthrough() }).passthrough().parse(source.intent.body)
    .admittedDevelopmentMethod as unknown as WorkforceSpecialistCapability;
  // The real S8 consumer re-reads the original authenticated refs/current epoch.
  // A stored source body is not itself an admission or a replacement capability.
  await currentWorkforceSpecialistCapability({ tenantId: e.body.tenantId, principalId: e.body.principalId,
    rightsRef: e.body.rightsRef, spendBudgetRef: budgetRef, methodRef: computation.methodRef,
    admissionRef: computation.admissionRef, modelIdentity: admitted.modelIdentity, mechanism: admitted.mechanism,
    deadlineAt: Date.parse(binding.effectiveDeadline), signal }, admitted);
  const initialJob = ready.initialJobClaim;
  const expectedBinding = { schema: "finnor.s6.workforce-specialist-binding.v1", tenantId: q.tenant_id, principalId: q.principal_id,
    actorId: assignment.actorId, originalWorkId: q.work_id, originalInputId: q.work_input_id,
    originalMeaningDigest: q.original_digest, programmeId: q.id, assignmentId: assignment.id,
    parentAssignmentId: assignment.parentAssignmentId, parentTermsDigest: lineage[1]?.termsDigest ?? null,
    termsDigest: assignment.termsDigest, termsRevision: assignment.terms.revision, taskDigest: digest(task),
    computationDigest: digest(computation), contextDigest: digest(computation.context), ceilingDigest: digest(assignment.ceiling),
    acceptedScopeDigest: scopeDigest, originalDeadline: original.outcome.deadline, effectiveDeadline: binding.effectiveDeadline, budgetRef,
    reservationRef: budget.reservationRef, carveRef: funding.ref, consumptionRef,
    methodRef: computation.methodRef, admissionRef: computation.admissionRef,
    modelIdentity: admitted.modelIdentity, mechanismDigest: digest(admitted.mechanism),
    sourceClosureDigest: admitted.sourceClosureDigest, runtimeDigest: admitted.runtimeDigest,
    job: { id: initialJob.jobId, deliveryAttemptId: initialJob.deliveryAttemptId,
      claimTokenSha256: initialJob.claimTokenDigest, claimFence: initialJob.claimFence,
      leaseSeconds: Number((BigInt(initialJob.initialExpiresUtcMicros) - BigInt(initialJob.initialAcquiredUtcMicros)) / 1000000n) } };
  if (source.enrollmentDigest !== e.digest || source.epoch !== String(before.epoch)
    || digest(source.primary) !== digest(e.body.primary) || ready.publicationId !== publicationId
    || digest({ schema: "finnor.w2.original-publication-identity.v1", workId: q.work_id, assignmentId: assignment.id }) !== publicationId
    || digest(binding) !== digest(expectedBinding) || digest(binding) !== ready.bindingDigest || digest(binding) !== intent.bindingDigest
    || binding.sourceClosureDigest !== e.body.sourceClosureDigest || binding.runtimeDigest !== e.body.runtimeDigest
    || ready.nativeSource.scopeDigest !== scopeDigest || ready.originalAcceptedSource.scopeDigest !== scopeDigest
    || use.decisionDigest !== scopeDigest || use.operationKey !== q.id + ":specialist:" + assignment.id
    || use.idempotencyKey !== "w2:" + use.operationKey
    || !sameRef(intent.consumptionRef, consumptionRef)
    || source.work.id !== q.work_id || source.input.id !== q.work_input_id || source.input.work_id !== q.work_id
    || source.work.tenant_id !== e.body.tenantId || source.input.tenant_id !== e.body.tenantId
    || q.tenant_id !== e.body.tenantId || q.principal_id !== e.body.principalId
    || source.work.created_by !== q.principal_id || source.input.created_by !== q.principal_id
    || source.work.initial_instruction !== source.input.instruction_text
    || byteDigest(Buffer.from(source.input.instruction_text)) !== q.original_digest
    || digest(JSON.parse(source.input.instruction_text)) !== digest(original))
    fault("SPECIALIST_ORIGINAL_SOURCE_BINDING_DISAGREES", 503);
  const heads = source.heads.map(value => z.object({ assignment_id: text, tenant_id: text, program_id: text,
    principal_id: text, work_id: text, body: z.unknown(), task: z.unknown(), holds_capacity: z.boolean() }).passthrough().parse(value))
    .filter(head => head.assignment_id === assignment.id);
  if (heads.length !== 1 || heads[0]!.tenant_id !== q.tenant_id || heads[0]!.program_id !== q.id
    || heads[0]!.principal_id !== q.principal_id || heads[0]!.work_id !== q.work_id || heads[0]!.holds_capacity !== true
    || digest(heads[0]!.body) !== digest(assignment) || digest(heads[0]!.task) !== digest(task))
    fault("SPECIALIST_ORIGINAL_SOURCE_ACTUAL_HEAD_REQUIRED", 503);
  for (const [row, id, kind] of [[source.intent, "s6-intent:", "S6_INTENDED"],
    [source.nativeReady, "specialist-native-ready:", "SPECIALIST_NATIVE_READY"]] as const) {
    if (row.tenant_id !== q.tenant_id || row.program_id !== q.id || row.principal_id !== q.principal_id
      || row.event_id !== id + assignment.id || row.kind !== kind || digest(row.body) !== row.request_digest)
      fault("SPECIALIST_ORIGINAL_SOURCE_EVENT_CUSTODY_REQUIRED", 503);
  }
  if (ready.intentEventId !== source.intent.event_id || ready.jobId !== binding.job.id
    || ready.claimFence !== binding.job.claimFence || ready.initialJobClaim.jobId !== binding.job.id
    || ready.initialJobClaim.deliveryAttemptId !== binding.job.deliveryAttemptId
    || ready.initialJobClaim.claimTokenDigest !== binding.job.claimTokenSha256
    || ready.initialJobClaim.claimFence !== binding.job.claimFence || source.job.id !== binding.job.id
    || source.job.claimFence !== String(binding.job.claimFence) || source.job.claimTokenDigest !== binding.job.claimTokenSha256
    || source.job.tenantId !== q.tenant_id
    || BigInt(initialJob.initialExpiresUtcMicros) - BigInt(initialJob.initialAcquiredUtcMicros) !== BigInt(binding.job.leaseSeconds) * 1000000n
    || source.job.workerId !== ready.initialJobClaim.workerId || source.job.payload.programId !== q.id
    || source.job.payload.principalId !== q.principal_id || source.job.payload.tenantId !== q.tenant_id)
    fault("SPECIALIST_ORIGINAL_INITIAL_JOB_SOURCE_REQUIRED", 503);
  const expectedKeys = ["model:global", "model-provider:bedrock", "model:bedrock:" + binding.modelIdentity.model].sort();
  if (digest(ready.p3Leases.map(l => l.resourceKey).sort()) !== digest(expectedKeys))
    fault("SPECIALIST_ORIGINAL_INITIAL_P3_SET_REQUIRED", 503);
  for (const grant of ready.initialP3Grants) {
    const matches = ready.p3Leases.filter(l => l.resourceKey === grant.resourceKey && l.tokenSha256 === grant.tokenSha256
      && l.fence === grant.fence && l.ownerId === grant.ownerId);
    if (matches.length !== 1 || ready.initialP3Grants.filter(g => g.resourceKey === grant.resourceKey).length !== 1
      || BigInt(grant.initialExpiresUtcMicros) - BigInt(grant.initialAcquiredUtcMicros) !== BigInt(matches[0]!.leaseSeconds) * 1000000n)
      fault("SPECIALIST_ORIGINAL_INITIAL_P3_SOURCE_REQUIRED", 503);
  }
  const bounds = deriveOriginalBusinessBounds({ enrollment: e, binding, program: q.program,
    original: q.original, budget, nativeReady: source.nativeReady.body, admission: admitted });
  for (const ref of [binding.methodRef, binding.admissionRef]) {
    signal.throwIfAborted();
    const found = await readOwnerTransportReference({ semanticOwner: "S8", tenantId: e.body.tenantId,
      principalId: e.body.principalId }, ref.id);
    if (!found.receipt || !sameRef(found.reference, ref) || digest(found.reference.content) !== ref.contentDigest)
      fault("SPECIALIST_ORIGINAL_SOURCE_GENUINE_S8_REFERENCE_REQUIRED", 503);
  }
  const after = await authority.readEpoch(); signal.throwIfAborted();
  if (digest(before) !== digest(after)) fault("SPECIALIST_ORIGINAL_SOURCE_EPOCH_CHANGED", 503);
  const value = immutable({ publicationId, enrollmentDigest: e.digest, binding,
    originalSourceDigest: digest({ intent: source.intent.body, nativeReady: source.nativeReady.body }),
    physics: nativeOriginPhysicsSchema.parse({ hostReference: ready.hostReference,
      nativeBootstrap: ready.nativeBootstrap, sourcePid: ready.nativeBootstrap.parentPid }),
    originalUtcBounds: bounds, initialJobClaim: ready.initialJobClaim,
    initialP3Grants: ready.initialP3Grants, p3: ready.p3Leases, s8Epoch: source.epoch, s8HistoryDigest: before.historyDigest });
  actual.add(value); return value;
}
