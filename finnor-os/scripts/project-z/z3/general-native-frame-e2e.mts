/** Finite source process for the persisted owner-frame cursor (v3), retained
 * owner lineage, the v3 identity bridge, multi-channel frames and coverage
 * wiring. No Auth, owner call, receipt, admission or allowance is created; every
 * record is a SOURCE observation over the frozen cut-01 map and strategy. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ExperimentRef } from "@finnor/shared-types";
import type { OriginalBinding, PublicArena, Strategy } from "../../../packages/epistemic-runtime/src/project-z/z3-viability/contracts";
import { hash } from "../../../packages/private-equity/src/project-z/z3-viability/contracts";
import { parseNativeOriginalInstruction } from "../../../packages/private-equity/src/project-z/z3-viability/native-model";
import { assertNativeOwnerOutcomeCoverage, nativeFrameChannels, nativeOutcomeObservers, nativeStateMatches,
  nativeStateObservers, selectNativeEnvironmentEdge, type GeneralNativeInstruction, type NativeDomainField,
  type NativeResourceObservation } from "../../../packages/private-equity/src/project-z/z3-viability/general-model";
import { advanceGeneralFrameCursor, assertGeneralCursor, assertGeneralFrameCursor, assertRetainedOwnerLineage,
  consumedOwnerObservation, initialGeneralCursor, initialGeneralFrameCursor, retainedOwnerSource,
  type GeneralViabilityCursor, type GeneralViabilityFrameCursor, type RetainedLineageBridge, type RetainedOwnerLineage,
  type RetainedOwnerObservation } from "../../../packages/private-equity/src/project-z/z3-viability/general-transition";
import { originalGeneralViabilityFrameRefinement,
  originalGeneralViabilityIdentityRefinement } from "../../../packages/orchestration/src/project-z/z3-viability/general-revision";

const BASE_SHA256 = "51294dff2d120f5b3696f5e12cbff109d05670fd8ab25945451a57ab3a6fd5ac";
const argument = (key: string) => process.argv.find(x => x.startsWith(key + "="))?.slice(key.length + 1);
const input = argument("--inputs"), base = argument("--base"), output = argument("--output");
if (!input || !base || !output || ![input, base, output].every(path => isAbsolute(path))) throw Error("ABSOLUTE_SOURCE_PATHS_REQUIRED");
const raw = await readFile(input, "utf8"), baseRaw = await readFile(base, "utf8");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
assert.equal(sha256(baseRaw), BASE_SHA256);
type Expected = Record<string, unknown> & {
  frameTrace: Record<string, unknown>; lineage: Record<string, unknown>; bridge: Record<string, unknown>;
  multiChannel: Record<string, unknown>; coverage: Record<string, unknown>; tamper: Record<string, unknown>;
};
const fixture = JSON.parse(raw) as { scope: string; frameStates: string[];
  trace: { edges: number[]; operationReturns: Record<string, string> }; expected: Expected };
const baseFixture = JSON.parse(baseRaw) as { instruction: GeneralNativeInstruction & { arena: PublicArena }; strategy: Strategy };
assert.equal(fixture.scope, "FROZEN_SOURCE_EXPECTATIONS_BEFORE_Z3_INTERNAL_28_NOT_OWNER_EVIDENCE");
const E = fixture.expected;
const records: Array<Record<string, unknown>> = [];
let failures = 0;
const code = (error: unknown) => error && typeof error === "object" && "code" in error
  ? String(error.code) : error instanceof Error ? error.message : String(error);
const attempt = (action: () => unknown) => { try { return action(); } catch (error) { return code(error); } };
function run(name: string, expected: unknown, action: () => unknown) {
  const actual = attempt(action);
  let passed = false;
  try { assert.deepEqual(actual, expected); passed = true; } catch { failures++; }
  records.push({ name, expected, actual, passed, scope: fixture.scope });
}
const parse = (value: unknown) => {
  const model = parseNativeOriginalInstruction(JSON.stringify(value));
  if (model.kind !== "GENERAL") throw Error("GENERAL_NATIVE_VERSION_REQUIRED");
  return model;
};
const strategy = baseFixture.strategy;
const baseModel = parse(baseFixture.instruction);
const frameInstruction = structuredClone(baseFixture.instruction);
for (const row of frameInstruction.observations) {
  if (fixture.frameStates.includes(row.stateId)) row.knowledge = "LAST_OWNER_RESULT";
}
const frameModel = parse(frameInstruction);
const firstObserver = baseModel.original.observers[0]!;
if (firstObserver.kind === "APPLICATION_SNAPSHOT") throw Error("CONTROL_SOURCE_FIXTURE_REQUIRED");
const revision = firstObserver.policyRef;
let receipts = 0;
const observation = (token: string, view = "CONTEXT"): RetainedOwnerObservation => ({
  observerId: "control", revision, sourceRef: { ...revision, owner: "S2", id: "source-fixture-not-a-real-realization" },
  facts: { $view: view, token, availablePeriod: 0 }, qualification: fixture.scope,
  receiptRef: { ...revision, owner: "S4", id: `source-fixture-not-an-owner-receipt-${++receipts}` },
});
const reservationRef: ExperimentRef = { ...revision, owner: "S5", id: "source-fixture-not-a-reservation" };
const resources: NativeResourceObservation = { maximum: 0, remaining: 0, capacity: 0, unknown: [], reservationRef };
const previousBinding: OriginalBinding = { tenantId: "source-fixture-tenant", principalId: "source-fixture-principal",
  workId: "source-fixture-work", workInputId: "source-fixture-input", originalParentId: "source-fixture-parent",
  sourceRevision: "source-fixture-revision-1", rightsRevision: "source-fixture-rights-1", mandateDigest: "6".repeat(64),
  observationDigest: "7".repeat(64), resourceDigest: "8".repeat(64), deadlineAt: "2026-12-31T00:00:00.000Z",
  codeDigest: "9".repeat(64) };
const currentBinding: OriginalBinding = { ...previousBinding, sourceRevision: "source-fixture-revision-2" };
const identity = { candidateDigest: "2".repeat(64), checkDigest: "3".repeat(64),
  bindingDigest: hash(previousBinding), ownerEvidenceDigest: "5".repeat(64) };
const lineage: RetainedOwnerLineage = { sessionId: "source-fixture-session-1", workId: previousBinding.workId,
  workInputId: previousBinding.workInputId, bindingDigest: identity.bindingDigest, mapDigest: frameModel.mapDigest,
  ownerEvidenceDigest: identity.ownerEvidenceDigest };
const reload = (cursor: GeneralViabilityFrameCursor) => {
  const persisted = JSON.parse(JSON.stringify({ cursor, cursorDigest: hash(cursor) })) as
    { cursor: GeneralViabilityFrameCursor; cursorDigest: string };
  assertGeneralFrameCursor(frameModel, strategy, persisted.cursor, persisted.cursorDigest, identity);
  return persisted.cursor;
};
const step = (cursor: GeneralViabilityFrameCursor, edgeIndex: number, returned: RetainedOwnerObservation) => {
  const owner = frameModel.arena.states.find(s => s.id === cursor.stateId)!.owner;
  return advanceGeneralFrameCursor(frameModel, strategy, cursor, edgeIndex,
    [consumedOwnerObservation(frameModel, edgeIndex, returned)], resources, [], lineage, owner === "C" ? returned : null);
};
const initialFrame = () => initialGeneralFrameCursor(frameModel, strategy, [observation("RIGHT")], resources, identity, lineage);

run("v2-cursor-validator-unchanged", E.v2Unchanged, () => {
  const v2 = initialGeneralCursor(baseModel, strategy, [observation("RIGHT")], resources, identity);
  const v3 = initialFrame();
  const valid = (action: () => void) => attempt(() => { action(); return "VALID"; });
  return {
    v2CursorOnV2Validator: valid(() => assertGeneralCursor(baseModel, strategy, v2, hash(v2), identity)),
    v3CursorOnV2Validator: valid(() => assertGeneralCursor(frameModel, strategy,
      v3 as unknown as GeneralViabilityCursor, hash(v3), identity)),
    v2CursorOnV3Validator: valid(() => assertGeneralFrameCursor(baseModel, strategy,
      v2 as unknown as GeneralViabilityFrameCursor, hash(v2), identity)),
  };
});
const persisted = reload(step(initialFrame(), 1, observation("LEFT", "OPERATION_RETURNED")));
run("frame-cursor-persists-observed-owner-frame", E.persisted, () => ({ stateId: persisted.stateId,
  frameStateId: persisted.frame?.stateId ?? null, frameKnowledge: persisted.frame?.observations.map(o => o.knowledge ?? null) ?? null,
  pending: persisted.pending !== null }));
run("continuation-last-owner-result-reads-retained-frame", E.continuation, () => {
  const source = retainedOwnerSource(frameModel, persisted, lineage, null);
  if (source.source !== "RETAINED_FRAME") return source.source;
  return { source: source.source, retainedMatches: nativeStateMatches(frameModel, "e1", source.observations, resources),
    freshContextMatches: nativeStateMatches(frameModel, "e1", [observation("LEFT", "OPERATION_RETURNED")], resources) };
});
run("current-context-state-reads-current-owners", E.currentContextSource,
  () => retainedOwnerSource(frameModel, initialFrame(), lineage, null).source);
run("consecutive-C-E-states-keep-operation-return", E.frameTrace, () => {
  let cursor = initialFrame();
  const states = [cursor.stateId], memories = [cursor.memory], pending: boolean[] = [], frameKnowledge: unknown[] = [],
    sources: string[] = [];
  let returned: RetainedOwnerObservation | null = null;
  fixture.trace.edges.forEach((edgeIndex, at) => {
    const state = frameModel.arena.states.find(s => s.id === cursor.stateId)!;
    const source = retainedOwnerSource(frameModel, cursor, lineage, null);
    sources.push(source.source);
    if (state.owner === "C") {
      const fresh = observation(state.id === "c0" ? "LEFT" : "RIGHT");
      assert.equal(nativeStateMatches(frameModel, state.id, source.source === "RETAINED_FRAME" ? source.observations : [fresh], resources), true);
      returned = observation(fixture.trace.operationReturns[String(at)]!, "OPERATION_RETURNED");
    } else {
      assert.ok(returned && cursor.pending && hash(returned) === cursor.pending.observationDigest);
      assert.equal(selectNativeEnvironmentEdge(frameModel, state.id, returned, resources), edgeIndex);
    }
    cursor = reload(step(cursor, edgeIndex, returned!));
    states.push(cursor.stateId); memories.push(cursor.memory); pending.push(cursor.pending !== null);
    frameKnowledge.push(cursor.frame?.observations[0]?.knowledge ?? null);
  });
  return { states, memories, pending, frameKnowledge, sources, operations: cursor.operations,
    transitions: cursor.transitions, goalVisits: cursor.goalVisits };
});
run("tampered-retained-frame-refused", E.tamper, () => {
  const changed = structuredClone(persisted);
  changed.frame!.observations[0]!.facts.token = "RIGHT";
  return { cursorDigest: attempt(() => assertGeneralFrameCursor(frameModel, strategy, changed, hash(persisted), identity)),
    frameDigest: attempt(() => assertGeneralFrameCursor(frameModel, strategy, changed, hash(changed), identity)) };
});
run("last-owner-result-without-retained-frame-refused", E.missingFrame,
  () => retainedOwnerSource(frameModel, { ...persisted, frame: null }, lineage, null).source);
const accepted = (value: RetainedOwnerLineage, current: RetainedOwnerLineage, bridge: RetainedLineageBridge | null) =>
  attempt(() => { assertRetainedOwnerLineage(value, current, bridge); return "ACCEPTED"; });
const nextLineage: RetainedOwnerLineage = { ...lineage, sessionId: "source-fixture-session-2", bindingDigest: hash(currentBinding) };
const lineageBridge: RetainedLineageBridge = { previousSessionId: lineage.sessionId,
  previousBindingDigest: lineage.bindingDigest, currentBindingDigest: nextLineage.bindingDigest };
run("retained-lineage-exact-identity-only", E.lineage, () => ({
  sameSession: accepted(lineage, lineage, null),
  otherSession: accepted(lineage, { ...lineage, sessionId: "source-fixture-other-session" }, null),
  otherWork: accepted(lineage, { ...lineage, workId: "source-fixture-other-work" }, null),
  otherInput: accepted(lineage, { ...lineage, workInputId: "source-fixture-other-input" }, null),
  bridgedExact: accepted(lineage, nextLineage, lineageBridge),
  bridgedOtherInput: accepted(lineage, { ...nextLineage, workInputId: "source-fixture-other-input" }, lineageBridge),
  bridgedWrongPreviousBinding: accepted(lineage, nextLineage, { ...lineageBridge, previousBindingDigest: "0".repeat(64) }),
}));
const bridgeInput = { previousSessionId: lineage.sessionId, previousBinding, binding: currentBinding,
  previousArena: frameModel.arena, arena: frameModel.arena, previousReservation: reservationRef, reservation: reservationRef,
  strategy, cursor: persisted, mapDigest: frameModel.mapDigest, ownerEvidenceDigest: identity.ownerEvidenceDigest };
const frameBridge = (change: Partial<typeof bridgeInput>) => attempt(() => originalGeneralViabilityFrameRefinement({ ...bridgeInput, ...change }).schema);
run("identity-bridge-v3-exact-lineage-no-allowance", E.bridge, () => {
  const exact = originalGeneralViabilityFrameRefinement(bridgeInput);
  const v2 = initialGeneralCursor(baseModel, strategy, [observation("RIGHT")], resources, identity);
  return {
    exact: { schema: exact.schema, pendingCarried: exact.pendingLineage !== null, newAllowance: exact.newAllowance,
      candidateReuseAllowed: exact.candidateReuseAllowed },
    changedMap: frameBridge({ mapDigest: "0".repeat(64) }),
    changedParent: frameBridge({ binding: { ...currentBinding, originalParentId: "source-fixture-other-parent" } }),
    changedResource: frameBridge({ binding: { ...currentBinding, resourceDigest: "0".repeat(64) } }),
    changedRights: frameBridge({ binding: { ...currentBinding, rightsRevision: "source-fixture-rights-2" } }),
    changedCode: frameBridge({ binding: { ...currentBinding, codeDigest: "0".repeat(64) } }),
    changedDeadline: frameBridge({ binding: { ...currentBinding, deadlineAt: "2027-01-31T00:00:00.000Z" } }),
    pendingFromOtherSession: frameBridge({ previousSessionId: "source-fixture-other-session" }),
    frameFromOtherInput: frameBridge({ binding: { ...currentBinding, workInputId: "source-fixture-other-input" } }),
    v2BridgeV2Cursor: attempt(() => originalGeneralViabilityIdentityRefinement({ ...bridgeInput, previousArena: baseModel.arena,
      arena: baseModel.arena, cursor: v2, mapDigest: baseModel.mapDigest }).schema),
    v2BridgeRejectsV3Cursor: attempt(() => originalGeneralViabilityIdentityRefinement({ ...bridgeInput,
      cursor: persisted as unknown as GeneralViabilityCursor }).schema),
  };
});
const compositeInstruction = structuredClone(baseFixture.instruction);
compositeInstruction.predicateScope = "COMPOSITE_OWNER_FRAME";
compositeInstruction.observers.push({ id: "control2", kind: "CONTROL_OBSERVATION", policyRef: revision,
  instrumentId: "source-fixture-instrument-2", availablePeriod: 0 });
const ready = { observerId: "control2", revision, values: { ready: true } };
compositeInstruction.observations.find(row => row.stateId === "c0")!.predicate.and = [ready];
for (const row of compositeInstruction.environment) if (row.edgeIndex === 0 || row.edgeIndex === 4) row.predicate.and = [ready];
const compositeModel = attempt(() => parse(compositeInstruction));
const composite = () => {
  if (typeof compositeModel === "string") throw Error(compositeModel);
  return compositeModel as ReturnType<typeof parse>;
};
const readyObservation: RetainedOwnerObservation = { ...observation("UNUSED"), observerId: "control2", facts: { ready: true } };
run("multi-channel-frame-reads-every-named-owner", E.multiChannel, () => ({
  stateObservers: { c0: nativeStateObservers(composite(), "c0"), c1: nativeStateObservers(composite(), "c1") },
  outcomeObservers: { e0: nativeOutcomeObservers(composite(), "e0") },
  channelCount: nativeFrameChannels(composite()), baseChannelCount: nativeFrameChannels(baseModel),
  bothChannels: attempt(() => selectNativeEnvironmentEdge(composite(), "e0",
    [observation("LEFT", "OPERATION_RETURNED"), readyObservation], resources)),
  lostChannel: attempt(() => selectNativeEnvironmentEdge(composite(), "e0", [observation("LEFT", "OPERATION_RETURNED")], resources)),
}));
const field = (observerId: string, name: string, values: NativeDomainField["values"]): NativeDomainField =>
  ({ observerId, field: name, values, open: false, missing: false });
const controlFields = [field("control", "$view", ["CONTEXT", "OPERATION_RETURNED"]), field("control", "token", ["LEFT", "RIGHT"]),
  field("control", "availablePeriod", [0])];
run("owner-result-domain-coverage-wiring", E.coverage, () => ({
  tagged: attempt(() => assertNativeOwnerOutcomeCoverage(baseModel, null)),
  nullProvider: attempt(() => assertNativeOwnerOutcomeCoverage(composite(), null)),
  missingChannel: attempt(() => assertNativeOwnerOutcomeCoverage(composite(), id => id === "control" ? controlFields : undefined)),
  fullDomain: attempt(() => assertNativeOwnerOutcomeCoverage(composite(), id => id === "control" ? controlFields
    : id === "control2" ? [field("control2", "ready", [true, false])] : undefined)),
}));
await mkdir(output);
await writeFile(join(output, "records.ndjson"), records.map(x => JSON.stringify(x)).join("\n") + "\n");
const report = { scope: fixture.scope, status: failures ? "FAIL" : "PASS", inputSha256: sha256(raw), baseSha256: sha256(baseRaw),
  records: records.length, failures, actualOwnerCalls: 0, native: "NOT_RUN_REQUIRES_DB_SESSION", installed: "NOT_RUN",
  ownerResultDomains: "NOT_EXPORTED_BY_S4_OWNER_MODULE_REFUSED_BY_NAME", newAllowance: false };
await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
if (failures) process.exitCode = 1;
