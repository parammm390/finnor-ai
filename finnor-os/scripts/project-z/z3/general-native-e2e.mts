/** Finite source-process replay, not fake authenticated owner execution.
 * Original Work JSON -> parser -> actual initial/memory -> every E branch ->
 * original source-state transition -> persisted cursor reload -> falsifiers.
 * No owner context, S5/S6 receipt, certificate or effect is fabricated. */
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ExperimentRef } from "@finnor/shared-types";
import type { PublicArena, Strategy } from "../../../packages/epistemic-runtime/src/project-z/z3-viability/contracts";
import { hash } from "../../../packages/private-equity/src/project-z/z3-viability/contracts";
import { parseNativeOriginalInstruction } from "../../../packages/private-equity/src/project-z/z3-viability/native-model";
import { nativeStateMatches, parseGeneralNativeModel, selectNativeEnvironmentEdge, selectNativeInitial,
  type GeneralNativeInstruction, type NativeObservation, type NativeResourceObservation } from "../../../packages/private-equity/src/project-z/z3-viability/general-model";
import { advanceGeneralCursor, assertGeneralCursor, assertNativeResourceStep, consumedOwnerObservation,
  initialGeneralCursor } from "../../../packages/private-equity/src/project-z/z3-viability/general-transition";

const argument = (name: string) => process.argv.find(arg => arg.startsWith(name + "="))?.slice(name.length + 1);
const inputPath = argument("--inputs"), output = argument("--output");
if (!inputPath || !output || !isAbsolute(inputPath) || !isAbsolute(output)) throw Error("ABSOLUTE_INPUT_AND_OUTPUT_REQUIRED");
const raw = await readFile(inputPath, "utf8");
const fixture = JSON.parse(raw) as {
  scope: string; instruction: GeneralNativeInstruction & { arena: PublicArena }; strategy: Strategy;
  expected: { actualInitial: { stateId: string; initialIndex: number; memory: number }; edgeTrace: number[];
    stateTrace: string[]; memoryTrace: number[]; goalVisits: Record<string, number>; allEnvironmentBranches: Record<string, number> };
};
assert.equal(fixture.scope, "SOURCE_FIXTURE_NOT_AUTHENTICATED_OWNER_EVIDENCE_OR_ADMISSION");
await mkdir(output);
const records: Array<Record<string, unknown>> = [];
let failures = 0;
const codeOf = (error: unknown) => error && typeof error === "object" && "code" in error
  ? String(error.code) : error instanceof Error ? error.message : String(error);
function run(name: string, input: unknown, expected: unknown, action: () => unknown) {
  let actual: unknown, error: string | null = null;
  try { actual = action(); } catch (caught) { error = codeOf(caught); actual = { error }; }
  let pass = false;
  try { assert.deepEqual(actual, expected); pass = true; } catch { failures++; }
  records.push({ name, scope: fixture.scope, input, expected, actual, pass });
}
const original = () => structuredClone(fixture.instruction);
const parsed = parseNativeOriginalInstruction(JSON.stringify(fixture.instruction));
assert.equal(parsed.kind, "GENERAL");
if (parsed.kind !== "GENERAL") throw Error("GENERAL_NATIVE_VERSION_REQUIRED");
const model = parsed, firstObserver = model.original.observers[0]!;
if (firstObserver.kind === "APPLICATION_SNAPSHOT") throw Error("CONTROL_SOURCE_FIXTURE_REQUIRED");
const revision = firstObserver.policyRef;
const observation = (token: string, view = "CONTEXT"): NativeObservation => ({
  observerId: "control", revision, sourceRef: { ...revision, owner: "S2", id: "source-fixture-not-a-real-realization" },
  facts: { $view: view, token, availablePeriod: 0 }, qualification: fixture.scope,
});
const reservationRef: ExperimentRef = { ...revision, owner: "S5", id: "source-fixture-not-a-reservation" };
const resources: NativeResourceObservation = { maximum: 0, remaining: 0, capacity: 0, unknown: [], reservationRef };
const identity = { candidateDigest: "2".repeat(64), checkDigest: "3".repeat(64),
  bindingDigest: "4".repeat(64), ownerEvidenceDigest: "5".repeat(64) };

run("versioned-original-arena-unchanged", fixture.instruction, {
  kind: "GENERAL", arenaDigest: hash(fixture.instruction.arena), assumptions: 1, initials: ["c0", "c1"],
}, () => ({ kind: model.kind, arenaDigest: hash(model.arena), assumptions: model.arena.assumptions.length, initials: model.arena.initial }));
run("actual-non-first-initial-and-corresponding-memory", { observation: observation("RIGHT"), resources },
  fixture.expected.actualInitial, () => {
    const cursor = initialGeneralCursor(model, fixture.strategy, [observation("RIGHT")], resources, identity);
    return { ...selectNativeInitial(model, [observation("RIGHT")], resources), memory: cursor.memory };
  });
for (const [key, expected] of Object.entries(fixture.expected.allEnvironmentBranches)) {
  const [stateId, token] = key.split(":") as [string, string];
  run("original-E-branch:" + key, { stateId, observation: observation(token, "OPERATION_RETURNED") }, expected,
    () => selectNativeEnvironmentEdge(model, stateId, observation(token, "OPERATION_RETURNED"), resources));
}
run("source-state-memory-all-branches-and-durable-reload", {
  strategy: fixture.strategy, edgeTrace: fixture.expected.edgeTrace,
}, { states: fixture.expected.stateTrace, memories: fixture.expected.memoryTrace, goalVisits: fixture.expected.goalVisits }, () => {
  let cursor = initialGeneralCursor(model, fixture.strategy, [observation("RIGHT")], resources, identity);
  const states = [cursor.stateId], memories = [cursor.memory];
  for (const edgeIndex of fixture.expected.edgeTrace) {
    const state = model.arena.states.find(s => s.id === cursor.stateId)!;
    const token = edgeIndex === 5 ? "LEFT" : edgeIndex === 4 || edgeIndex === 2 ? "RIGHT"
      : cursor.stateId === "c0" ? "LEFT" : "RIGHT";
    const actual = observation(token, "OPERATION_RETURNED");
    if (state.owner === "E") assert.equal(selectNativeEnvironmentEdge(model, state.id, actual, resources), edgeIndex);
    const view = consumedOwnerObservation(model, edgeIndex, actual);
    cursor = advanceGeneralCursor(model, fixture.strategy, cursor, edgeIndex, view, resources, []);
    const persisted = JSON.stringify({ cursor, cursorDigest: hash(cursor) });
    const reloaded = JSON.parse(persisted) as { cursor: typeof cursor; cursorDigest: string };
    assertGeneralCursor(model, fixture.strategy, reloaded.cursor, reloaded.cursorDigest, identity);
    cursor = reloaded.cursor;
    states.push(cursor.stateId); memories.push(cursor.memory);
  }
  return { states, memories, goalVisits: cursor.goalVisits };
});

const falsifiers: Array<{ name: string; expected: string; mutate: (value: ReturnType<typeof original>) => void }> = [
  { name: "missing-C-index", expected: "Z3_NATIVE_TOTAL_C_EDGE_BINDING_REQUIRED", mutate: x => { x.controller.pop(); } },
  { name: "E-index-not-a-C-binding", expected: "Z3_NATIVE_TOTAL_C_EDGE_BINDING_REQUIRED", mutate: x => { x.controller[0]!.edgeIndex = 0; } },
  { name: "missing-E-branch", expected: "Z3_NATIVE_TOTAL_E_OUTCOME_BINDING_REQUIRED", mutate: x => { x.environment.pop(); } },
  { name: "duplicate-E-index", expected: "Z3_NATIVE_TOTAL_E_OUTCOME_BINDING_REQUIRED", mutate: x => { x.environment.push(x.environment[0]!); } },
  { name: "missing-public-state-observation", expected: "Z3_NATIVE_TOTAL_STATE_OBSERVATION_REQUIRED", mutate: x => { x.observations.pop(); } },
  { name: "ambiguous-E-predicates", expected: "Z3_NATIVE_AMBIGUOUS_E_OUTCOME_PREDICATES", mutate: x => {
    x.environment.find(r => r.edgeIndex === 4)!.predicate.values = { ...x.environment[0]!.predicate.values };
  } },
  { name: "lost-original-assumption", expected: "Z3_NATIVE_ORIGINAL_JUSTICE_COVERAGE_REQUIRED", mutate: x => { x.assumptions = []; } },
  { name: "changed-original-goal", expected: "Z3_NATIVE_ORIGINAL_JUSTICE_MEANING_CHANGED", mutate: x => {
    x.goals[0]!.clauses[0]!.values.token = "RIGHT";
  } },
  { name: "changed-goal-predicate-revision", expected: "Z3_NATIVE_ORIGINAL_PREDICATE_REVISION_OR_VALUATION_MISSING", mutate: x => {
    x.goals[0]!.clauses[0]!.revision = { ...revision, contentDigest: "9".repeat(64) };
  } },
  { name: "caller-admission-boolean", expected: "Z3_GENERAL_NATIVE_MAPPING_SCHEMA", mutate: x => {
    Object.assign(x, { admitted: true });
  } },
  { name: "arbitrary-action-interpreter", expected: "Z3_GENERAL_NATIVE_MAPPING_SCHEMA", mutate: x => {
    Object.assign(x.controller[0]!.operation, { callback: "execute arbitrary action text" });
  } },
];
for (const test of falsifiers) {
  const value = original(); test.mutate(value);
  run(test.name, value, { error: test.expected }, () => parseNativeOriginalInstruction(JSON.stringify(value)));
}
run("unmodelled-real-value-does-not-pick-first-initial", observation("OTHER"),
  { error: "Z3_NATIVE_ACTUAL_INITIAL_UNMODELLED" }, () => selectNativeInitial(model, [observation("OTHER")], resources));
const ambiguous = original(); ambiguous.arena.initial = ["e0", "e1"];
run("ambiguous-actual-initial-refused", ambiguous, { error: "Z3_NATIVE_ACTUAL_INITIAL_AMBIGUOUS" },
  () => selectNativeInitial(parseGeneralNativeModel(ambiguous), [observation("LEFT", "OPERATION_RETURNED")], resources));
run("unmodelled-E-value-not-pruned-or-guessed", observation("OTHER", "OPERATION_RETURNED"),
  { error: "Z3_NATIVE_ACTUAL_E_OUTCOME_UNMODELLED" },
  () => selectNativeEnvironmentEdge(model, "e0", observation("OTHER", "OPERATION_RETURNED"), resources));
const changed = observation("RIGHT"); changed.revision = { ...revision, contentDigest: "8".repeat(64) };
run("actual-owner-revision-changed", changed, { error: "Z3_NATIVE_OWNER_PREDICATE_REVISION_CHANGED" },
  () => selectNativeInitial(model, [changed], resources));
const cursor = initialGeneralCursor(model, fixture.strategy, [observation("RIGHT")], resources, identity);
const tampered = { ...cursor, memory: 0 };
run("persisted-cursor-tampering", tampered, { error: "Z3_S4_CURSOR_PREIMAGE_CHANGED" },
  () => assertGeneralCursor(model, fixture.strategy, tampered, hash(cursor), identity));

const renewable = original();
renewable.resources.meaning = "ORIGINAL_S5_REQUEST_ALLOWANCE_AND_S4_UNKNOWN_CAPACITY";
renewable.arena.resources.maximum = 2; renewable.arena.states.forEach(s => { s.remaining = s.id === "c1" ? 1 : 2; });
renewable.arena.edges[1]!.renewalRef = "renewal";
renewable.arena.edges[4]!.renewalRef = null;
renewable.arena.resources.renewalRefs = ["renewal"];
renewable.resources.renewals = [{ alias: "renewal", receiptRef: { ...reservationRef, id: "unadmitted-source-renewal-selector" } }];
run("nonzero-resource-and-original-renewal-preserved-by-parser", renewable,
  { maximum: 2, renewalRefs: ["renewal"], assumptions: 1, initials: ["c0", "c1"] }, () => {
    const result = parseGeneralNativeModel(renewable);
    return { maximum: result.arena.resources.maximum, renewalRefs: result.arena.resources.renewalRefs,
      assumptions: result.arena.assumptions.length, initials: result.arena.initial };
  });
run("renewal-label-is-not-S5-authority", renewable, { error: "Z3_S5_ORIGINAL_RENEWAL_RECEIPT_REPRESENTATION_REQUIRED" },
  () => assertNativeResourceStep(parseGeneralNativeModel(renewable), 1, []));

const unsettled = original();
unsettled.resources.meaning = "ORIGINAL_S5_REQUEST_ALLOWANCE_AND_S4_UNKNOWN_CAPACITY";
unsettled.arena.resources.maximum = 2; unsettled.arena.resources.capacity = 1; unsettled.arena.resources.obligationIds = ["u"];
unsettled.arena.states.forEach(s => { s.remaining = 2; s.unknown = s.id === "e1" ? ["u"] : []; });
unsettled.arena.edges[2]!.settlementRef = "q"; unsettled.arena.edges[5]!.settlementRef = "q";
unsettled.arena.resources.settlementRefs = ["q"];
unsettled.observers.push({ id: "application", kind: "APPLICATION_SNAPSHOT", responsibilityIdentity: "x1-obligation:" + "7".repeat(64),
  observation: "CURRENT_ORIGINAL_LAWFUL_READBACK" });
unsettled.resources.capacityObserverId = "application";
unsettled.resources.settlements = [{ alias: "q", receipt: "CURRENT_ORIGINAL_INDEPENDENT_DISPOSITION",
  obligations: [{ obligationId: "u", obligationRef: { ...revision, owner: "S6", id: "u" } }] }];
const unknownModel = parseGeneralNativeModel(unsettled);
run("UNKNOWN-cannot-be-erased-by-reference-text", unsettled, { error: "Z3_NATIVE_ACTUAL_S6_SETTLEMENT_REQUIRED" },
  () => assertNativeResourceStep(unknownModel, 2, []));
run("unobserved-UNKNOWN-not-fabricated", unsettled, false, () =>
  nativeStateMatches(unknownModel, "e1", [observation("RIGHT", "OPERATION_RETURNED")],
    { ...resources, maximum: 2, remaining: 2, capacity: 1, unknown: [] }));

const legacyArena: PublicArena = {
  schema: "finnor.z3.public-arena.v1", id: "legacy-readiness-source", observationMode: "PUBLIC_PERFECT_INFORMATION",
  states: [
    { id: "c", owner: "C", observation: "oc", safe: true, remaining: 0, unknown: [] },
    { id: "ready", owner: "E", observation: "or", safe: true, remaining: 0, unknown: [] },
    { id: "reconcile", owner: "E", observation: "os", safe: true, remaining: 0, unknown: [] },
  ],
  edges: [
    { from: "c", to: "ready", action: "READINESS", renewalRef: null, settlementRef: null },
    { from: "c", to: "reconcile", action: "RECONCILE", renewalRef: null, settlementRef: null },
    ...["READY", "NOT_READY"].map(action => ({ from: "ready", to: "c", action, renewalRef: null, settlementRef: null })),
    ...["CLEAR", "UNKNOWN_RETAINED"].map(action => ({ from: "reconcile", to: "c", action, renewalRef: null, settlementRef: null })),
  ],
  initial: ["c"], assumptions: [], goals: [["ready"], ["reconcile"]],
  resources: { capacity: 0, maximum: 0, obligationIds: [], renewalRefs: [], settlementRefs: [], unknownOccupiesCapacity: true },
};
const legacy = { schema: "finnor.z3.original-internal-readiness.v1", profile: "S4_READINESS_RECONCILIATION",
  resourceMeaning: "S6_OUTSTANDING_CAPACITY_NOT_COMPUTE_ALLOWANCE", arena: legacyArena };
run("readiness-v1-preserved", legacy, "READINESS", () => parseNativeOriginalInstruction(JSON.stringify(legacy)).kind);
const invalidLegacy = structuredClone(legacy); invalidLegacy.arena.assumptions = [["c"]];
run("readiness-v1-not-silently-widened", invalidLegacy, { error: "Z3_NATIVE_PROFILE_UNSUPPORTED" },
  () => parseNativeOriginalInstruction(JSON.stringify(invalidLegacy)));

await writeFile(join(output, "records.ndjson"), records.map(record => JSON.stringify(record)).join("\n") + "\n");
const report = { schema: "finnor.z3.general-native-source-process.v1", status: failures ? "FAIL" : "PASS",
  scope: fixture.scope, inputDigest: hash(JSON.parse(raw)), cases: records.length, failures,
  authenticatedNative: "NOT_RUN", protectedAdmission: "NOT_RUN", installedRebuild: "NOT_RUN",
  actualOwnerReceiptsCreated: 0, originalBudgetRenewed: false, money: null };
await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
if (failures) process.exitCode = 1;
