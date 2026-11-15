/** Complete owning-domain journeys and named semantic counterexamples.
 * Public builder development with synthetic observations, never native/human
 * qualification or independently held-out protected custody. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyWorkforceCommand, checkWorkforceExecutionProgram, checkWorkforceUse,
  compileWorkforceExecutionProgram, parseWorkforceCompilerInput, workforceDigest,
  workforceHistoryAnchor, type AuthenticatedWorkforceCommand, type WorkforceAssignment,
  type WorkforceCompilerInput, type WorkforceExecutionProgram, type WorkforceIssue,
} from "../../packages/workforce/src/execution-program/index";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const contractPath = "scope-postz/w2-accountable-workforce/dynamic/structural-contract.json";
type Family = { id: string; code: string; boundary: WorkforceIssue["boundary"]; mutation: string };
const contract = JSON.parse(await readFile(join(root, contractPath), "utf8")) as {
  casesPerFamily: number; requiredFamilies: number; expectedCases: number; wallSeconds: number;
  maximumOutputBytes: number; families: Family[];
};
assert.equal(contract.families.length, 16);
assert.equal(contract.casesPerFamily, 8);
assert.equal(new Set(contract.families.map(f => f.id)).size, 16);
const base = process.env.FINNOR_W2_STRUCTURAL_EVIDENCE_ROOT ?? join(root, "artifacts/postz-w2/structural");
assert(base.startsWith("/"));
const evidence = join(base, "structural-run-" + Date.now());
await mkdir(evidence, { recursive: true });
let outputBytes = 0;
const save = async (name: string, value: unknown) => {
  const body = JSON.stringify(value, null, name === "report.json" || name === "failure.json" ? 2 : undefined) + "\n";
  outputBytes += Buffer.byteLength(body);
  assert(outputBytes <= contract.maximumOutputBytes, "FROZEN_STRUCTURAL_OUTPUT_ENVELOPE");
  await writeFile(join(evidence, name), body, { mode: 0o600 });
};
const ref = (id: string, body: unknown = id) => ({
  owner: "SYNTHETIC_DEVELOPMENT_OBSERVATION", id, version: "1", contentDigest: workforceDigest(body),
});
const sourcePaths = [contractPath, "finnor-os/scripts/postz-w2/run-structural-e2e.mts",
  ...["schema", "exact", "graph", "compiler", "checker", "lifecycle", "index"].map(name =>
    "finnor-os/packages/workforce/src/execution-program/" + name + ".ts")];
const sources = await Promise.all(sourcePaths.map(async path => ({ path,
  sha256: createHash("sha256").update(await readFile(join(root, path))).digest("hex") })));
await save("frozen-contract-and-sources.json", { contract, sources, beforeCampaign: true,
  sourceClass: "SYNTHETIC", custody: "PUBLIC_BUILDER_DEVELOPMENT_NOT_PROTECTED",
  rerun: "cd finnor-os && node_modules/.bin/tsx scripts/postz-w2/run-structural-e2e.mts" });
type Action = AuthenticatedWorkforceCommand["action"];
type Input = WorkforceCompilerInput;
const results: Array<Record<string, unknown>> = [];
const seenOriginals = new Set<string>(), started = performance.now(), cpu = process.cpuUsage();
let failure: string | null = null;
let active: Record<string, unknown> | null = null;
const wall = setTimeout(async () => {
  await save("wall-bound-failure.json", { failure: "FROZEN_300_SECOND_WALL_EXHAUSTED", results, activeCase: active });
  process.exit(1);
}, contract.wallSeconds * 1000);

function original(family: Family, fi: number, variant: number, lane: string): Input {
  const key = `${family.id}-${variant}-${lane}`, count = variant + 3, target = 1 + variant % (count - 2);
  const at = new Date(Date.UTC(2026, 9, 25 + fi, 10, variant)).toISOString();
  const end = new Date(Date.parse(at) + 3600000).toISOString();
  const slotEnd = new Date(Date.parse(end) - 60000).toISOString();
  const until = new Date(Date.parse(end) + 3600000).toISOString();
  const quantity = (numerator: number) => {
    let a = numerator, b = variant + 1;
    while (b) [a, b] = [b, a % b];
    return (variant + 1) / a === 1 ? String(numerator / a) : `${numerator / a}/${(variant + 1) / a}`;
  };
  const envelope = (amount: number) => ({ resourceId: "resource-" + key, unit: "synthetic-work-unit", kind: "STOCK",
    horizon: { startAt: at, periodMs: 3600000, periods: 1 }, quantities: [quantity(amount), "0"], minimumQuantities: ["0", "0"] });
  const ceiling = { capabilities: ["analyse"], dataScopes: ["public"], purposes: ["purpose-" + key],
    effects: family.id === "ambiguous-original-egress" ? ["TEST_PURCHASE"] : [],
    validFrom: at, validUntil: until, allowSubdelegation: true };
  const actor = (id: string, kind: "MODEL_AGENT" | "INTERNAL_HUMAN", skill?: string) => ({
    id, tenantId: "tenant-" + key, identityRef: ref("identity:" + id), kind, status: "CURRENT",
    capabilities: skill ? [{ skill, scope: "public", evidenceRef: ref("skill:" + id), validUntil: until, certainty: "OBSERVED" }] : [],
    availability: { kind: "OBSERVED", ref: ref("schedule:" + id), validUntil: until,
      slots: [{ startAt: at, endAt: end, capacity: "4", committed: "0" }], maxConcurrent: 4,
      humanLimits: kind === "INTERNAL_HUMAN" ? { kind: "OBSERVED", maxEffortSeconds: "3600",
        alreadyCommittedSeconds: "0", fatigue: "WITHIN_LIMIT", ref: ref("human-limits:" + id) } : { kind: "NOT_HUMAN" } },
  });
  const humans = new Set(Array.from({ length: count }, (_, i) => i).filter(i =>
    i > 0 && i < count - 1 && ((i + variant) % 3 === 0 || family.id === "cancelled-compensation" && i === target)));
  const producer = (i: number) => `producer-${i}-${key}`;
  const requester = "requester-" + key, checker = "checker-" + key, custodian = "custodian-" + key;
  const actors = [actor(requester, "INTERNAL_HUMAN"), actor(checker, "MODEL_AGENT"), actor(custodian, "MODEL_AGENT"),
    ...Array.from({ length: count }, (_, i) => actor(producer(i), humans.has(i) ? "INTERNAL_HUMAN" : "MODEL_AGENT", "skill-" + i))];
  const tasks = Array.from({ length: count }, (_, i) => ({
    id: "task-" + i, parentTaskId: i > 0 && i < count - 1 ? "task-0" : null,
    dependsOn: [], returnTo: i > 0 && i < count - 1 ? ["task-0"] : [],
    delegatorActorId: i > 0 && i < count - 1 ? producer(0) : requester, criterionId: "criterion-" + i,
    requiredCapabilities: [{ skill: "skill-" + i, scope: "public" }],
    allowedActorKinds: ["MODEL_AGENT", "INTERNAL_HUMAN"],
    assignmentMode: humans.has(i) ? "EXTERNAL_VOLUNTARY" : "INTERNAL_AUTHORIZED",
    ceiling: structuredClone(ceiling),
    terms: { revision: 1, deliverable: `Original independent literal ${42 + variant + i}`,
      compensation: { value: family.id === "cancelled-compensation" && i === target ? String(variant + 1) : "0", unit: "USD" },
      subdelegation: true, expiresAt: end },
    dueAt: new Date(Date.parse(end) - i * 1000).toISOString(), slot: { startAt: at, endAt: slotEnd },
    effortSeconds: String(5 + variant + i), demand: [envelope(i === 0 ? count - 1 : 1)],
    context: { dataScopes: ["public"], purposes: ceiling.purposes, includesCredentials: false },
    effectId: family.id === "ambiguous-original-egress" && i === target ? "original-effect-" + key : null,
  }));
  const input = parseWorkforceCompilerInput({
    schema: "finnor.workforce-compiler-input.v1", programId: "programme-" + key, tenantId: "tenant-" + key,
    principalId: requester, now: new Date(Date.parse(at) + 1000).toISOString(), sourceClass: "SYNTHETIC",
    snapshotRef: ref("snapshot-" + key), historyAnchor: workforceHistoryAnchor([]),
    outcome: { ref: ref("original-" + key), workId: "work-" + key, rootId: "work-" + key, requesterActorId: requester,
      deadline: end, tasks, criteria: tasks.map(t => ({ id: t.criterionId, ref: ref("original-" + key + ":" + t.criterionId),
        checkerActorId: checker, evidenceCustodianActorId: custodian })), ceiling, resourceLimits: [envelope(count + 8)] },
    actors, grants: actors.map(a => ({ ref: ref("grant:" + a.id), actorId: a.id, tenantId: "tenant-" + key, ceiling, revoked: false })),
    funding: [], dispositions: [], deliveries: [], verifications: [], effects: [], reconciliations: [],
    obligations: [], termChanges: [], commandAuthorities: [],
  });
  for (const task of input.outcome.tasks.filter(t => t.effectId !== null))
    input.effects.push({ ref: ref("original-s6:" + key), assignmentId: input.programId + ":" + task.id + ":1",
      rootId: input.outcome.rootId, effectId: task.effectId!, status: "NOT_DISPATCHED", at: input.now, reconciliationRef: null });
  if (lane === "adverse" && family.id === "private-disclosure")
    input.outcome.tasks.find(t => t.id === "task-" + (variant + 1))!.context.dataScopes = ["private-ungranted-" + variant];
  const digest = workforceDigest(input);
  assert(!seenOriginals.has(digest), "FRESH_ORIGINAL_REQUIRED");
  seenOriginals.add(digest);
  return input;
}

function journey(input: Input, except?: string) {
  const initial = structuredClone(input), compiled = compileWorkforceExecutionProgram(input);
  if (active) { active.latestInput = input; active.latestCompilation = compiled; }
  assert.equal(compiled.status, "COMPLETE", JSON.stringify(compiled.gaps));
  assert(compiled.program);
  let program = compiled.program, serial = 0;
  const steps: Array<Record<string, unknown>> = [];
  if (active) active.latestSteps = steps;
  const facts = program.assignments.map(a => ({ ref: ref("funding:" + a.id), assignment: a }));
  input.funding = facts.map(({ ref: funding, assignment: a }) => {
    const task = input.outcome.tasks.find(t => t.id === a.taskId)!;
    const children = program.assignments.filter(child => child.parentAssignmentId === a.id);
    const direct = task.demand.map(e => ({ ...e, quantities: e.quantities.map((value, i) => {
      if (!children.length) return value;
      // The independently constructed fork has exactly one unit of direct work.
      return i === 0 ? input.outcome.tasks.find(t => t.id !== "task-0")!.demand[0]!.quantities[0]! : "0";
    }) }));
    const empty = task.demand.map(e => ({ ...e, quantities: e.quantities.map(() => "0") }));
    return { ref: funding, assignmentId: a.id, rootId: a.rootId, parentReservationId:
      facts.find(f => f.assignment.id === a.parentAssignmentId)?.ref.id ?? null, envelope: structuredClone(task.demand),
      directReserved: direct, spent: empty, unresolved: structuredClone(empty), status: "HELD" as const };
  });
  function command(action: Action, id: string, by?: string) {
    const a = program.assignments.find(a => a.id === id)!;
    const c: AuthenticatedWorkforceCommand = { id: `${program.id}:command:${serial++}`,
      expectedRevision: program.revision, actorId: by ?? a.delegatorActorId, assignmentId: id,
      at: input.now, authorityRef: ref(`${program.id}:authority:${serial}`), action };
    input.commandAuthorities.push({ ref: c.authorityRef, commandId: c.id, actorId: c.actorId, assignmentId: id,
      commandDigest: workforceDigest(c), actions: [action.kind], validFrom: input.outcome.ceiling.validFrom,
      validUntil: input.outcome.deadline });
    return c;
  }
  function step(action: Action, id: string, by?: string, mustApply = true) {
    const c = command(action, id, by), result = applyWorkforceCommand(program, c, input);
    steps.push({ command: c, status: result.status, issues: result.issues });
    if (mustApply) assert.equal(result.status, "APPLIED", JSON.stringify({ c, issues: result.issues }));
    if (result.status === "APPLIED") { program = result.program; input.historyAnchor = workforceHistoryAnchor(program.history); }
    if (active) active.latestProgram = program;
    return result;
  }
  function disposition(a: WorkforceAssignment, decision: "ACCEPT" | "DECLINE") {
    const task = input.outcome.tasks.find(t => t.id === a.taskId)!;
    const r = ref(decision.toLowerCase() + ":" + a.id);
    input.dispositions.push({ ref: r, assignmentId: a.id, actorId: a.actorId, mode: task.assignmentMode,
      source: task.assignmentMode === "EXTERNAL_VOLUNTARY" ? "NATIVE_RECIPIENT_DISPOSITION" : "NATIVE_INSTITUTIONAL_ASSIGNMENT",
      decision, termsDigest: a.termsDigest, termsRevision: a.terms.revision, at: input.now, revokedAt: null });
    return step({ kind: decision, dispositionRef: r }, a.id, a.actorId);
  }
  for (const a of program.assignments) step({ kind: "OFFER", offerRef: ref("offer:" + a.id) }, a.id);
  for (const a of program.assignments) if (a.taskId !== except) disposition(a, "ACCEPT");
  function perform(id: string, close = true) {
    const a = program.assignments.find(a => a.id === id)!, task = input.outcome.tasks.find(t => t.id === a.taskId)!;
    const criterion = input.outcome.criteria.find(c => c.id === task.criterionId)!;
    step({ kind: "START", observationRef: ref("arrival:" + a.id) }, a.id, a.actorId);
    assert.equal(checkWorkforceUse(program, id, input).allowed, true);
    const value = task.terms.deliverable, evidence = ref("literal-evidence:" + a.id, value);
    const delivery = { ref: ref("delivery:" + a.id), assignmentId: a.id, actorId: a.actorId, termsDigest: a.termsDigest,
      evidenceRefs: [evidence], custodianActorId: criterion.evidenceCustodianActorId, at: input.now };
    input.deliveries.push(delivery); step({ kind: "DELIVER", deliveryRef: delivery.ref }, id, a.actorId);
    // Comparator reads the immutable original literal, not a producer verdict.
    assert.equal(value, initial.outcome.tasks.find(t => t.id === a.taskId)!.terms.deliverable);
    const verification = { ref: ref("verification:" + a.id), assignmentId: id, deliveryRef: delivery.ref,
      criterionRef: criterion.ref, checkerActorId: criterion.checkerActorId, custodianActorId: criterion.evidenceCustodianActorId,
      evidenceRefs: [evidence], result: "SATISFIED" as const, at: input.now };
    input.verifications.push(verification);
    step({ kind: "VERIFY", verificationRef: verification.ref }, id, criterion.checkerActorId);
    if (close) {
      const kind = input.actors.find(actor => actor.id === a.actorId)!.kind;
      if (kind === "INTERNAL_HUMAN") input.obligations.push({ ref: ref("synthetic-labor-release:" + a.id),
        assignmentId: id, rootId: a.rootId, kind: "ACCEPTED_LABOR", status: "RELEASED", at: input.now });
      if (a.terms.compensation.value !== "0") input.obligations.push({ ref: ref("synthetic-not-real-money:" + a.id),
        assignmentId: id, rootId: a.rootId, kind: "COMPENSATION", status: "SETTLED", at: input.now });
      step({ kind: "CLOSE", observationRef: ref("closure:" + a.id) }, id);
    }
  }
  return { initial, input, compiled, steps, get program() { return program; }, step, disposition, perform };
}

async function retainCase(id: string, family: Family, variant: number, good: ReturnType<typeof journey>,
  positiveCheck: ReturnType<typeof checkWorkforceExecutionProgram>, adverse: unknown) {
  await save(id + ".json", { id, sourceClass: "SYNTHETIC", status: "PASS", family, variant,
    genuineHumanQualified: false, protectedQualification: false, realPaymentOrEgress: false,
    freshPositive: { original: good.initial, program: good.program, canonical: good.input, steps: good.steps, check: positiveCheck },
    adverse });
  results.push({ id, family: family.id, variant, positiveOriginalTasks: good.program.assignments.length,
    positiveClosedTasks: good.program.assignments.length, namedAdverseCode: family.code, namedBoundary: family.boundary, status: "PASS" });
}

try {
  for (const [fi, family] of contract.families.entries()) for (let variant = 0; variant < 8; variant++) {
    const id = family.id + "-" + variant, targetTask = "task-" + (1 + variant % (variant + 1));
    active = { id, family, variant, targetTask };
    const good = journey(original(family, fi, variant, "positive"));
    active.positive = good;
    const order = [...good.program.assignments.filter(a => a.parentAssignmentId !== null),
      ...good.program.assignments.filter(a => a.parentAssignmentId === null)];
    for (const a of order) good.perform(a.id);
    const positiveCheck = checkWorkforceExecutionProgram(good.program, good.input);
    assert.equal(positiveCheck.valid, true, JSON.stringify(positiveCheck.issues));
    assert(good.program.assignments.every(a => a.state.kind === "CLOSED"));
    if (family.id === "private-disclosure") {
      // Supply the excessive context at original intake. Changing a committed
      // original instead correctly hits ORIGINAL_OUTCOME_CHANGED first, which
      // does not exercise the independently preregistered disclosure owner.
      const badInput = original(family, fi, variant, "adverse"), compiled = compileWorkforceExecutionProgram(badInput);
      active.adverse = { original: badInput, compilation: compiled };
      assert(compiled.program); assert.notEqual(compiled.status, "COMPLETE");
      const checked = checkWorkforceExecutionProgram(compiled.program, badInput);
      assert(checked.issues.some(issue => issue.code === family.code && issue.boundary === family.boundary),
        "NAMED_OWNER_NOT_REACHED:" + JSON.stringify({ family, variant, issues: checked.issues }));
      await retainCase(id, family, variant, good, positiveCheck, { original: badInput, program: compiled.program,
        canonical: badInput, steps: [{ kind: "COMPILE", result: compiled }], issues: checked.issues,
        observed: { excessiveDisclosureRefusedAtOriginalBoundary: true } });
      continue;
    }
    const bad = journey(original(family, fi, variant, "adverse"), family.id === "decline-not-performance" ? targetTask : undefined);
    active.adverse = bad;
    const target = bad.program.assignments.find(a => a.taskId === targetTask)!;
    const actor = bad.input.actors.find(a => a.id === target.actorId)!;
    let issues: WorkforceIssue[] = [], observed: Record<string, unknown> = {};
    if (family.id === "canonical-identity") actor.status = "REVOKED";
    else if (family.id === "skill-evidence") actor.capabilities = [];
    else if (family.id === "competing-capacity") {
      assert.equal(actor.availability.kind, "OBSERVED");
      if (actor.availability.kind === "OBSERVED") for (const slot of actor.availability.slots) slot.committed = slot.capacity;
    } else if (family.id === "exact-acceptance") {
      bad.input.dispositions.find(d => d.assignmentId === target.id)!.termsDigest = workforceDigest({ differentTerms: variant + 1 });
    } else if (family.id === "recipient-authority") {
      bad.input.grants.find(g => g.actorId === target.actorId)!.ceiling.capabilities = [];
    } else if (family.id === "accounting-frontier") {
      bad.input.funding.find(f => f.assignmentId === target.id)!.directReserved[0]!.quantities[0] = String(variant + 2);
    } else if (family.id === "resource-ancestry") {
      const funding = bad.input.funding.find(f => f.assignmentId === target.id)!; funding.parentReservationId = funding.ref.id;
    } else if (family.id === "independent-custody") {
      bad.perform(target.id, false);
      bad.input.verifications.find(v => v.assignmentId === target.id)!.checkerActorId = target.actorId;
    } else if (family.id === "open-descendant") {
      const parent = bad.program.assignments.find(a => a.taskId === "task-0")!;
      bad.perform(parent.id, false);
      issues = bad.step({ kind: "CLOSE", observationRef: ref("premature-parent:" + id) }, parent.id, undefined, false).issues;
    } else if (family.id === "command-principal") {
      issues = bad.step({ kind: "START", observationRef: ref("wrong-principal-arrival:" + id) }, target.id,
        bad.input.outcome.criteria[0]!.evidenceCustodianActorId, false).issues;
    } else if (family.id === "decline-not-performance") {
      bad.disposition(target, "DECLINE");
      const use = checkWorkforceUse(bad.program, target.id, bad.input); assert.equal(use.allowed, false);
      issues = use.issues; assert.equal(bad.program.assignments.find(a => a.id === target.id)!.state.kind, "DECLINED");
    } else if (family.id === "ambiguous-original-egress") {
      bad.step({ kind: "START", observationRef: ref("actual-shaped-arrival:" + id) }, target.id, target.actorId);
      const effect = bad.input.effects.find(e => e.assignmentId === target.id)!;
      effect.status = variant % 2 ? "MAY_HAVE_LEFT" : "UNKNOWN";
      const use = checkWorkforceUse(bad.program, target.id, bad.input); assert.equal(use.allowed, false);
      issues = use.issues; observed = { retainedOriginalEffect: effect.effectId, physicalReplayAllowed: false };
    } else if (family.id === "cancelled-compensation") {
      bad.step({ kind: "CANCEL", observationRef: ref("request-cancel:" + id) }, target.id);
      bad.step({ kind: "CONFIRM_CANCEL", observationRef: ref("actual-shaped-cancel:" + id) }, target.id);
      bad.input.obligations.push({ ref: ref("labor-only-not-money:" + id), assignmentId: target.id,
        rootId: target.rootId, kind: "ACCEPTED_LABOR", status: "RELEASED", at: bad.input.now });
      issues = bad.step({ kind: "CLOSE", observationRef: ref("false-paid-closure:" + id) }, target.id, undefined, false).issues;
    } else if (family.id === "smallest-currentness-closure") {
      const separate = bad.program.assignments.find(a => a.parentAssignmentId === null && a.taskId !== "task-0")!;
      bad.step({ kind: "START", observationRef: ref("unaffected-arrival:" + id) }, separate.id, separate.actorId);
      bad.input.dependencyInvalidations = [{ sourceKind: "S1_ACTOR_EVIDENCE", sourceId: "pinned-source:" + target.actorId,
        expectedDigest: workforceDigest("old"), actualDigest: workforceDigest("new"), assignmentIds: [target.id] }];
      const use = checkWorkforceUse(bad.program, separate.id, bad.input);
      assert.equal(use.allowed, true, JSON.stringify(use));
      const expectedAffected = bad.program.assignments.filter(a => a.id !== separate.id).map(a => a.id).sort();
      assert.deepEqual([...use.affectedAssignmentIds].sort(), expectedAffected);
      issues = use.issues; observed = { unrelatedBranchUsable: true, exactAffected: expectedAffected, kept: [separate.id] };
    } else if (family.id === "committed-history") {
      const replay = structuredClone(bad.program.history.at(-1)!);
      assert.equal(applyWorkforceCommand(bad.program, replay, bad.input).status, "IDEMPOTENT");
      bad.program.history[0]!.id += ":forged-prefix";
      const replayed = applyWorkforceCommand(bad.program, replay, bad.input);
      assert.equal(replayed.status, "REJECTED"); issues = replayed.issues;
    } else throw Error("UNREGISTERED_STRUCTURAL_FAMILY:" + family.id);
    if (!issues.length) issues = checkWorkforceExecutionProgram(bad.program, bad.input).issues;
    assert(issues.some(issue => issue.code === family.code && issue.boundary === family.boundary),
      "NAMED_OWNER_NOT_REACHED:" + JSON.stringify({ family, variant, issues }));
    await retainCase(id, family, variant, good, positiveCheck,
      { original: bad.initial, program: bad.program, canonical: bad.input, steps: bad.steps, issues, observed });
  }
  assert.equal(results.length, 128); assert.equal(seenOriginals.size, 256);
  for (const source of sources) assert.equal(createHash("sha256").update(await readFile(join(root, source.path))).digest("hex"),
    source.sha256, "SOURCE_CHANGED_DURING_STRUCTURAL_CAMPAIGN:" + source.path);
} catch (error) {
  failure = error instanceof Error ? error.stack ?? error.message : String(error);
  await save("failure.json", { failure, completedCases: results, activeCase: active });
  console.error(failure);
} finally {
  clearTimeout(wall);
  await save("report.json", { schema: "finnor.postz.w2.structural-development-report.v1", status: failure ? "FAIL" : "PASS",
    failure, results, observedFamilies: new Set(results.map(r => r.family)).size, observedCases: results.length,
    freshOriginals: seenOriginals.size, elapsedMs: performance.now() - started, supervisorCpu: process.cpuUsage(cpu),
    outputBytes, sourceClass: "SYNTHETIC", custody: "PUBLIC_BUILDER_DEVELOPMENT_NOT_INDEPENDENT_OR_PROTECTED",
    genuineHumanQualified: false, nativePopulation: false, realPaymentOrEgress: false, protectedQualification: false,
    originalProtectedFloorsChanged: false, economicImprovementEstablished: false, sourceHashes: sources });
  console.log(JSON.stringify({ evidence, status: failure ? "FAIL" : "PASS", observedCases: results.length }));
}
process.exit(failure ? 1 : 0);
