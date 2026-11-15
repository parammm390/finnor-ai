/** Complete compiler -> authenticated lifecycle -> independent replay exercise.
 * All canonical observations here are SYNTHETIC. This is not native/human proof. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import * as domain from "../../packages/workforce/src/execution-program/index";
import type { AuthenticatedWorkforceCommand, WorkforceCompilerInput, WorkforceExecutionProgram, WorkforceTaskCreation } from "../../packages/workforce/src/execution-program/schema";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = process.env.FINNOR_W2_DYNAMIC_EVIDENCE_ROOT ?? join(root, "artifacts/postz-w2/dynamic-domain");
assert(output.startsWith("/"));
await mkdir(output, { recursive: true, mode: 0o700 });
const at = "2026-10-25T10:00:00.000Z", end = "2026-10-25T11:00:00.000Z";
const ref = (id: string) => ({ owner: "SYNTHETIC", id, version: "1", contentDigest: domain.workforceDigest({ id }) });
const ceiling = { capabilities: ["analyse"], dataScopes: ["public"], purposes: ["comparison"], effects: [],
  validFrom: at, validUntil: end, allowSubdelegation: true };
const envelope = (amount: string) => ({ resourceId: "ops", unit: "workforce-operation", kind: "CUMULATIVE_EXPENDITURE" as const,
  horizon: { startAt: at, periodMs: 3600000, periods: 1 }, quantities: [amount, "0"], minimumQuantities: ["0", "0"] });
const task = (id: string) => ({ id, parentTaskId: null, dependsOn: [], returnTo: [], delegatorActorId: "requester",
  criterionId: "original-criterion", requiredCapabilities: [{ skill: "compare", scope: "public" }],
  allowedActorKinds: ["MODEL_AGENT" as const], assignmentMode: "EXTERNAL_VOLUNTARY" as const, ceiling,
  terms: { revision: 1, deliverable: "Return independently checked evidence", compensation: { value: "0", unit: "USD" },
    subdelegation: true, expiresAt: end }, dueAt: end, slot: { startAt: at, endAt: end }, effortSeconds: "1",
  demand: [envelope("3")], context: { dataScopes: ["public"], purposes: ["comparison"], includesCredentials: false }, effectId: null });
const input = domain.parseWorkforceCompilerInput({
  schema: "finnor.workforce-compiler-input.v1", programId: "dynamic-programme", tenantId: "tenant", principalId: "principal",
  sourceClass: "SYNTHETIC", now: at, snapshotRef: ref("snapshot"), historyAnchor: { revision: 0, commandsDigest: domain.workforceDigest([]) },
  outcome: { ref: ref("original"), workId: "original-work", rootId: "original-root", requesterActorId: "requester",
    deadline: end, ceiling, resourceLimits: [envelope("3")], tasks: [task("original-task")],
    criteria: [{ id: "original-criterion", ref: ref("original-criterion"), checkerActorId: "requester", evidenceCustodianActorId: "requester" }] },
  actors: ["requester", "agent-a", "agent-b"].map(id => ({ id, tenantId: "tenant", kind: "MODEL_AGENT", status: "CURRENT",
    identityRef: ref("identity-" + id), capabilities: [{ skill: "compare", scope: "public", evidenceRef: ref("skill-" + id),
      certainty: "OBSERVED", validUntil: end }], availability: { kind: "OBSERVED", ref: ref("capacity-" + id),
      validUntil: end, maxConcurrent: 3, slots: [{ startAt: at, endAt: end, capacity: "3", committed: "0" }],
      humanLimits: { kind: "NOT_HUMAN" } } })),
  grants: ["requester", "agent-a", "agent-b"].map(actorId => ({ ref: ref("grant-" + actorId), actorId, tenantId: "tenant", ceiling, revoked: false })),
  funding: [], dispositions: [], deliveries: [], verifications: [], effects: [], reconciliations: [], obligations: [],
  termChanges: [], taskCreations: [], commandAuthorities: [],
});
const compiled = domain.compileWorkforceExecutionProgram(input);
assert.equal(compiled.status, "COMPLETE");
let program = compiled.program!;
const original = structuredClone(program.originalOutcome), originalDigest = program.originalOutcomeDigest;
const parentId = program.assignments[0]!.id;
assert.equal(program.assignments[0]!.actorId, "agent-a");
const cases: Array<{ id: string; ok: boolean; observed: unknown; program: WorkforceExecutionProgram; input: WorkforceCompilerInput }> = [];
function record(id: string, ok: boolean, observed: unknown, p = program, current = input) {
  cases.push({ id, ok, observed, program: structuredClone(p), input: structuredClone(current) });
}
let sequence = 0;
function command(p: WorkforceExecutionProgram, current: WorkforceCompilerInput, assignmentId: string, actorId: string,
  action: AuthenticatedWorkforceCommand["action"]) {
  current.historyAnchor = { revision: p.revision, commandsDigest: domain.workforceDigest(p.history) };
  const id = "command-" + ++sequence, authorityRef = ref("authority-" + id);
  const c: AuthenticatedWorkforceCommand = { id, actorId, assignmentId, expectedRevision: p.revision,
    at: current.now, authorityRef, action };
  current.commandAuthorities.push({ ref: authorityRef, commandId: id, actorId, assignmentId, commandDigest: domain.workforceDigest(c),
    actions: [action.kind], validFrom: at, validUntil: end });
  return domain.applyWorkforceCommand(p, c, current);
}
function apply(assignmentId: string, actorId: string, action: AuthenticatedWorkforceCommand["action"]) {
  const result = command(program, input, assignmentId, actorId, action);
  record("apply-" + action.kind + "-" + assignmentId, result.status === "APPLIED", result.issues, result.program);
  assert.equal(result.status, "APPLIED", JSON.stringify(result.issues));
  program = result.program;
}
function fund(assignmentId: string, amount: string, direct: string, parentReservationId: string | null) {
  input.funding.push({ ref: ref("fund-" + assignmentId), assignmentId, rootId: input.outcome.rootId, parentReservationId,
    envelope: [envelope(amount)], directReserved: [envelope(direct)], spent: [envelope("0")], unresolved: [envelope("0")], status: "HELD" });
}
function accept(assignmentId: string) {
  const a = program.assignments.find(a => a.id === assignmentId)!;
  const observation = { ref: ref("accept-" + assignmentId), assignmentId, actorId: a.actorId, mode: "EXTERNAL_VOLUNTARY" as const,
    source: "NATIVE_RECIPIENT_DISPOSITION" as const, decision: "ACCEPT" as const,
    termsDigest: a.termsDigest, termsRevision: a.terms.revision, at, revokedAt: null };
  input.dispositions.push(observation);
  apply(a.id, a.actorId, { kind: "ACCEPT", dispositionRef: observation.ref });
}
function fact(parent: string, id: string, recipientActorId: string, kind: WorkforceTaskCreation["kind"]): WorkforceTaskCreation {
  const a = program.assignments.find(a => a.id === parent)!;
  return { ref: ref("creation-" + id), kind, parentAssignmentId: a.id, parentTermsDigest: a.termsDigest,
    actorId: a.actorId, recipientActorId, assignmentId: `${program.id}:${id}:1`, at,
    task: { ...task(id), parentTaskId: a.taskId, delegatorActorId: a.actorId, criterionId: "criterion-" + id,
      returnTo: [a.taskId], demand: [envelope(id === "child" ? "2" : "1")] },
    criterion: { id: "criterion-" + id, ref: ref("criterion-" + id),
      checkerActorId: id === "child" ? "requester" : "agent-a", evidenceCustodianActorId: id === "child" ? "requester" : "agent-a" } };
}
function deliverAndVerify(assignmentId: string) {
  const a = program.assignments.find(a => a.id === assignmentId)!;
  const graph = domain.workforceProgramGraph(program), t = graph.tasks.find(t => t.id === a.taskId)!;
  const criterion = graph.criteria.find(c => c.id === t.criterionId)!;
  const delivery = { ref: ref("delivery-" + assignmentId), assignmentId, actorId: a.actorId, termsDigest: a.termsDigest,
    evidenceRefs: [ref("result-" + assignmentId)], custodianActorId: criterion.evidenceCustodianActorId, at };
  input.deliveries.push(delivery); apply(a.id, a.actorId, { kind: "DELIVER", deliveryRef: delivery.ref });
  const verification = { ref: ref("verification-" + assignmentId), assignmentId, deliveryRef: delivery.ref,
    criterionRef: criterion.ref, checkerActorId: criterion.checkerActorId, custodianActorId: criterion.evidenceCustodianActorId,
    evidenceRefs: delivery.evidenceRefs, result: "SATISFIED" as const, at };
  input.verifications.push(verification); apply(a.id, criterion.checkerActorId, { kind: "VERIFY", verificationRef: verification.ref });
  apply(a.id, input.outcome.requesterActorId, { kind: "CLOSE", observationRef: ref("close-" + assignmentId) });
}
let failure: string | null = null;
try {
  fund(parentId, "3", "3", null);
  apply(parentId, "requester", { kind: "OFFER", offerRef: ref("original-offer") });
  const beforeAcceptance = fact(parentId, "unaccepted-child", "agent-b", "SUBDELEGATION");
  const noAcceptanceInput = structuredClone(input); noAcceptanceInput.taskCreations!.push(beforeAcceptance);
  const noAcceptance = command(program, noAcceptanceInput, parentId, "agent-a",
    { kind: "SUBDELEGATE", taskCreationRef: beforeAcceptance.ref });
  record("creation-before-parent-acceptance-refused", noAcceptance.status === "REJECTED", noAcceptance.issues, program, noAcceptanceInput);
  accept(parentId);
  apply(parentId, "agent-a", { kind: "START", observationRef: ref("parent-start") });
  const child = fact(parentId, "child", "agent-b", "SUBDELEGATION");
  input.taskCreations!.push(child); input.funding[0]!.directReserved = [envelope("1")];
  fund(child.assignmentId, "2", "2", input.funding[0]!.ref.id);
  apply(parentId, "agent-a", { kind: "SUBDELEGATE", taskCreationRef: child.ref });
  const pending = structuredClone(program), pendingInput = structuredClone(input);
  const premature = command(program, input, parentId, "agent-a", { kind: "DELIVER", deliveryRef: ref("premature") });
  record("requester-cannot-deliver-before-returned-evidence", premature.status === "REJECTED" &&
    premature.issues.some(i => i.code === "REQUESTED_WORK_UNVERIFIED"), premature.issues);
  apply(child.assignmentId, "agent-a", { kind: "OFFER", offerRef: ref("child-offer") }); accept(child.assignmentId);
  apply(child.assignmentId, "agent-b", { kind: "START", observationRef: ref("child-start") });
  const reciprocal = fact(child.assignmentId, "reciprocal", "requester", "RECIPROCAL_REQUEST");
  input.taskCreations!.push(reciprocal); input.funding[1]!.directReserved = [envelope("1")];
  fund(reciprocal.assignmentId, "1", "1", input.funding[1]!.ref.id);
  apply(child.assignmentId, "agent-b", { kind: "SUBDELEGATE", taskCreationRef: reciprocal.ref });
  apply(reciprocal.assignmentId, "agent-b", { kind: "OFFER", offerRef: ref("reciprocal-offer") });
  accept(reciprocal.assignmentId);
  const early = structuredClone(input);
  early.now = "2026-10-25T09:59:59.000Z";
  const readiness = domain.checkWorkforceUse(program, reciprocal.assignmentId, early);
  record("actual-window-required", !readiness.allowed && readiness.issues.some(i => i.code === "TASK_WINDOW_NOT_OPEN"), readiness.issues, program, early);
  apply(reciprocal.assignmentId, "requester", { kind: "START", observationRef: ref("reciprocal-start") });
  deliverAndVerify(reciprocal.assignmentId); deliverAndVerify(child.assignmentId); deliverAndVerify(parentId);
  input.historyAnchor = { revision: program.revision, commandsDigest: domain.workforceDigest(program.history) };
  record("whole-dynamic-program-independently-valid", domain.checkWorkforceExecutionProgram(program, input).valid,
    domain.checkWorkforceExecutionProgram(program, input));
  record("original-work-meaning-budget-deadline-unchanged", domain.workforceDigest(program.originalOutcome) === domain.workforceDigest(original)
    && program.originalOutcomeDigest === originalDigest, program.originalOutcome);
  record("one-financial-tree-and-real-reciprocal-actor-return", program.assignments.length === 3 &&
    program.assignments.every(a => a.rootId === original.rootId && a.originalDeadline === original.deadline) &&
    program.assignments.find(a => a.id === reciprocal.assignmentId)!.actorId === original.requesterActorId &&
    program.assignments.find(a => a.id === reciprocal.assignmentId)!.parentAssignmentId === child.assignmentId, program.assignments);
  function corrupt(id: string, mutate: (p: WorkforceExecutionProgram, current: WorkforceCompilerInput) => void, code: string,
    p = program, current = input) {
    const changed = structuredClone(p), canonical = structuredClone(current); mutate(changed, canonical);
    const checked = domain.checkWorkforceExecutionProgram(changed, canonical);
    record(id, !checked.valid && checked.issues.some(i => i.code === code), checked.issues, changed, canonical);
  }
  corrupt("changed-canonical-creation-rejected", (_p, current) => { current.taskCreations![0]!.recipientActorId = "requester"; }, "TASK_CREATION_PROVENANCE");
  corrupt("unobserved-creation-rejected", (_p, current) => { current.taskCreations = []; }, "TASK_CREATION_PROVENANCE");
  corrupt("reordered-creation-records-rejected", p => p.taskCreations!.reverse(), "TASK_CREATION_ORDER");
  corrupt("child-terms-cannot-extend-parent-time", (p, current) => {
    p.taskCreations![0]!.task.terms.expiresAt = "2026-10-25T12:00:00.000Z";
    current.taskCreations![0]!.task.terms.expiresAt = "2026-10-25T12:00:00.000Z";
  }, "TASK_CREATION_TERMS_CEILING");
  corrupt("creation-does-not-reset-original-deadline", p => { p.assignments[2]!.originalDeadline = "2026-10-26T11:00:00.000Z"; }, "ORIGINAL_ROOT");
  corrupt("copied-parent-budget-is-not-spare-capacity", (_p, current) => { current.funding[0]!.directReserved = [envelope("3")]; }, "RESOURCE_LIMIT");
  corrupt("forgotten-unknown-parent-use-rejected", (_p, current) => { current.funding[0]!.unresolved = [envelope("3")]; }, "RESOURCE_LIMIT");
  corrupt("extra-uncreated-first-attempt-rejected", p => {
    p.assignments.push({ ...structuredClone(p.assignments[1]!), id: "forged-first", state: { kind: "PROPOSED" } });
  }, "UNROOTED_TASK_CREATION");
  corrupt("new-child-cannot-inherit-parent-credentials", (p, current) => {
    p.taskCreations![0]!.task.context.includesCredentials = true; current.taskCreations![0]!.task.context.includesCredentials = true;
  }, "DISCLOSURE_CEILING");
  corrupt("reciprocal-dependency-deadlock-rejected", (p, current) => {
    p.taskCreations![1]!.task.dependsOn = ["original-task"]; current.taskCreations![1]!.task.dependsOn = ["original-task"];
  }, "DEPENDENCY_CYCLE_OR_DANGLING");
  corrupt("self-producing-independent-checker-rejected", (p, current) => {
    p.taskCreations![0]!.criterion.checkerActorId = "agent-b"; current.taskCreations![0]!.criterion.checkerActorId = "agent-b";
  }, "VERIFICATION_CUSTODY");
  corrupt("revoked-live-child-source-fences-requester", (_p, current) => {
    current.actors.find(a => a.id === "agent-b")!.status = "REVOKED";
  }, "ACTOR_IDENTITY", pending, pendingInput);
  const fencedInput = structuredClone(pendingInput); fencedInput.actors.find(a => a.id === "agent-b")!.status = "REVOKED";
  record("affected-child-closure-reaches-original-requester", domain.checkWorkforceExecutionProgram(pending, fencedInput)
    .affectedAssignmentIds.includes(parentId), domain.checkWorkforceExecutionProgram(pending, fencedInput), pending, fencedInput);
  const cloneChild = structuredClone(pending);
  cloneChild.history.unshift({ ...structuredClone(program.history.find(c => c.assignmentId === child.assignmentId && c.action.kind === "OFFER")!),
    expectedRevision: 0 });
  const unanchored = structuredClone(pendingInput); unanchored.historyAnchor = { revision: 0, commandsDigest: domain.workforceDigest([]) };
  record("child-history-before-creation-rejected", domain.checkWorkforceExecutionProgram(cloneChild, unanchored).issues
    .some(i => i.code === "ASSIGNMENT_BEFORE_CREATION"), domain.checkWorkforceExecutionProgram(cloneChild, unanchored), cloneChild, unanchored);
} catch (error) { failure = error instanceof Error ? error.stack ?? error.message : String(error); }
const failed = cases.filter(c => !c.ok).map(c => c.id);
const artifact = join(output, "dynamic-domain-" + Date.now() + ".json");
await writeFile(artifact, JSON.stringify({ schema: "finnor.postz.w2.dynamic-domain-e2e.v1",
  sourceClass: "SYNTHETIC", status: failure || failed.length ? "FAIL" : "PASS", failure, failed, cases,
  genuineHumanQualified: false, nativeProof: false, rerun: "cd finnor-os && node --import tsx scripts/postz-w2/run-dynamic-e2e.mts" }, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ status: failure || failed.length ? "FAIL" : "PASS", cases: cases.length, failed, failure, artifact }));
process.exitCode = failure || failed.length ? 1 : 0;
