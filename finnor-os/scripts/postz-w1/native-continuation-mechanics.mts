/** Failure-first v5 driver: literals/conditional traces precede continuation implementation. */
import { strict as assert } from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fitNativeContinuation, nativeFrameKey, nativeActionRef } from "../../packages/private-equity/src/economic-orchestration/continuation";
import { compileNativePolicy, consumeNativePolicy, planNativeFallback } from "../../packages/private-equity/src/economic-orchestration/policy";
import { diffNativeDependencies } from "../../packages/private-equity/src/economic-orchestration/dependencies";
import { orderedNativeLockIds, gapReasonsForAttempt } from "../../packages/private-equity/src/economic-orchestration/gaps";

const destination = resolve(process.argv[2] ?? "");
assert(process.argv[2]); await mkdir(destination, { recursive: false });
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const pins = { sourceRef: "original-source", modelRef: "original-native", providerRef: "local", methodRef: "actual-methods",
  priceRef: "original-price", checkerRef: "original-SQL", runtimeRef: "current-runtime" };
const features = { structureRef: "two-native-methods", outcomeClassRef: "original-acceptance", domainRef: "literal-v5" };
const context = { tenantId: "tenant", principalId: "principal", purposeRef: "purpose", populationRef: "population",
  pins, features, validUntil: "2099-01-01T00:00:00.000Z", sourceClass: "SYNTHETIC_DEVELOPMENT" };
const knowledgeAt = "2026-01-02T00:00:00.000Z";
const root: any = { units: ["A", "B"].flatMap(name => [
  { key: name + ":execute", unitId: name + "-execute", kind: "EXECUTE_P1", status: "PENDING", prerequisites: [], steps: 1, observationRef: null },
  { key: name + ":verify", unitId: name + "-verify", kind: "VERIFY_P1", status: "PENDING", prerequisites: [name + ":execute"], steps: 1, observationRef: null },
]), history: [], obligations: [], requiredChecks: ["A:verify", "B:verify"], completedChecks: [], acceptanceRef: null, disposition: "ACTIVE" };
const samples: any[] = [];
function action(keys: string[]) { return { ref: nativeActionRef(keys), unitKeys: [...keys].sort(), unitIds: keys.map(key => root.units.find((u: any) => u.key === key).unitId),
  computationRef: keys.map(key => key[0]).sort().join("+"), contextRefs: ["original-source"], verifierRefs: ["original-SQL"],
  attempts: keys.length, steps: keys.length }; }
function step(before: any, keys: string[], status: "COMPLETED" | "FAILED" | "UNKNOWN", wall: number, premise: string) {
  const a = action(keys), after = structuredClone(before);
  for (const unit of after.units.filter((u: any) => keys.includes(u.key))) {
    unit.status = status; unit.observationRef = status + ":" + unit.key;
    if (unit.kind === "VERIFY_P1" && status === "COMPLETED") {
      after.completedChecks.push(unit.key); after.acceptanceRef = "original-SQL:" + unit.key; after.disposition = "ACCEPTED";
    }
    if (status === "UNKNOWN") { after.obligations.push({ id: "unknown:" + unit.key, status: "UNKNOWN", resolutionRef: null }); after.disposition = "UNKNOWN"; }
  }
  const observation = hash({ units: after.units.map((u: any) => [u.key, u.status, u.observationRef]), disposition: after.disposition });
  after.history.push({ actionRef: a.ref, observation });
  const id = "sample-" + samples.length;
  samples.push({ schema: "finnor.w1.native-stage-observation.v1", id, assignmentRef: id, episodeRef: "original-episode",
    workId: "original-work", premiseRef: premise, split: "TRAIN", before, action: a, after, observation,
    consumption: { attempts: keys.length, steps: keys.length, wallMs: String(wall) },
    evidenceRefs: ["original-attempt:" + id, "original-SQL:" + id], observedAt: "2026-01-01T00:00:00.000Z" });
  return after;
}
const aOK = step(root, ["A:execute"], "COMPLETED", 1, "A-positive");
step(aOK, ["A:verify"], "COMPLETED", 1, "A-positive");
const aFail = step(root, ["A:execute"], "FAILED", 1, "A-negative");
const aFailB = step(aFail, ["B:execute"], "COMPLETED", 5, "A-negative");
step(aFailB, ["B:verify"], "COMPLETED", 1, "A-negative");
const bOK = step(root, ["B:execute"], "COMPLETED", 5, "B-alone");
step(bOK, ["B:verify"], "COMPLETED", 1, "B-alone");
step(root, ["A:execute", "B:execute"], "FAILED", 2, "joint-correlated-negative");
const ref = (name: string) => ({ owner: "P1", id: name, version: "v1", contentDigest: "a".repeat(64) });
const entries = [["A"], ["B"], ["A", "B"]].map(names => ({ computationRef: names.join("+"), treatmentRef: names.join("+"),
  unitIds: names.flatMap(name => [name + "-execute", name + "-verify"]),
  unitCosts: names.flatMap(name => [{ unitId: name + "-execute", attempts: 1, steps: 1 }, { unitId: name + "-verify", attempts: 1, steps: 1 }]),
  moduleIds: names, methodRefs: names.map(ref), contextRefs: ["original-source"], verifierRefs: ["original-SQL"],
  prerequisiteEdges: names.map(name => ({ from: name + "-execute", to: name + "-verify" })), attempts: names.length * 2, steps: names.length * 2,
  independence: "COMMON_PREMISE_ALTERNATE_IMPLEMENTATIONS", available: true }));
const continuation = fitNativeContinuation(samples, context, null, knowledgeAt);
const input: any = { schema: "finnor.w1.native-control-input.v1", searchId: "search", programId: "program", episodeId: "original-episode",
  workInputId: "work-input", workInputDigest: "a".repeat(64), generation: 1, purposeRef: "purpose", populationRef: "population",
  protocolRef: "logged-native-current-owner-assignment-v1", pins, features,
  binding: { tenantId: "tenant", principalId: "principal", workId: "original-work", outcomeRef: "original-acceptance", mandateRef: "original-mandate",
    sourceRef: pins.sourceRef, rightsRef: "original-rights", catalogueRef: "catalogue", responseRef: continuation.ref, modelRef: pins.modelRef,
    priceRef: pins.priceRef, checkerRef: pins.checkerRef, runtimeRef: pins.runtimeRef, parentGrantRef: "original-grant", deadline: context.validUntil },
  catalogue: { ref: "catalogue", entries }, response: null, continuation, frame: root,
  utility: { ref: ref("owner-conversion"), unit: "model-utility", lossGap: "100", nativeAttemptCost: "1", delayMsCost: "1", controllerMsCost: "0" },
  remaining: { attempts: 20, steps: 1000, wallMs: 10000, maxParallel: 2, publicationAttempts: 0 },
  incumbentRef: null, outstanding: [], now: "2026-01-02T00:00:00.000Z" };
const cases: unknown[] = [];
const test = (id: string, run: () => unknown) => { try { cases.push({ id, status: "PASS", observed: run() }); }
  catch (error) { cases.push({ id, status: "FAIL", error: String(error) }); process.exitCode = 1; } };
let proposal: any;
test("empirical-correlated-contingent-root93", () => {
  proposal = compileNativePolicy(input); assert.equal(proposal.status, "CHECKED_POLICY");
  assert.equal(proposal.policy.states[proposal.policy.rootStateId].value, "93");
  assert(proposal.continuation.horizonUsed >= 3);
  return { root: "93", horizon: proposal.continuation.horizonUsed, fittedSamples: samples.length };
});
test("same-capsule-nonroot-consumption", () => {
  // The original A failure consumed its recorded resources. Moving the frame
  // while restoring the root budget is not a valid same-capsule continuation.
  const consumption = samples[2].consumption;
  assert.deepEqual(consumption, { attempts: 1, steps: 1, wallMs: "1" });
  const remaining = { ...input.remaining, attempts: input.remaining.attempts - consumption.attempts,
    steps: input.remaining.steps - consumption.steps, wallMs: input.remaining.wallMs - Number(consumption.wallMs) };
  const units = aFail.units.map((u: any) => ({ id: u.unitId, status: u.status,
    prerequisites: u.prerequisites.map((key: string) => aFail.units.find((v: any) => v.key === key).unitId) }));
  const refusedResets = ["attempts", "steps", "wallMs"].map(dimension => {
    const result = consumeNativePolicy({ ...input, frame: aFail,
      remaining: { ...remaining, [dimension]: remaining[dimension] + 1 } }, proposal, units);
    assert.equal(result.status, "FALLBACK");
    if (result.status === "FALLBACK") assert.equal(result.reason, "W1_OBSERVED_STATE_NOT_UNIQUELY_IN_EMPIRICAL_SUPPORT");
    return { dimension, result };
  });
  const used: any = consumeNativePolicy({ ...input, frame: aFail, remaining }, proposal, units);
  assert.equal(used.status, "DISPATCH"); assert.deepEqual(used.unitIds, ["B-execute"]);
  assert.notEqual(used.stateId, proposal.policy.rootStateId);
  return { ...used, originalConsumption: consumption, originalRemaining: remaining, refusedResets };
});
test("missing-cost-not-selected-positive-denominator", () => {
  const bad = structuredClone(samples); bad[0].consumption.wallMs = null;
  const fitted = fitNativeContinuation(bad, context, null, knowledgeAt);
  const value: any = compileNativePolicy({ ...input, continuation: fitted });
  assert.equal(value.status, "CHECKED_POLICY");
  const selected = value.continuation.actions[value.policy.states[value.policy.rootStateId].selectedChoiceId];
  assert.deepEqual(selected.unitKeys, ["B:execute"]); return { selected: selected.unitKeys };
});
test("UNKNOWN-observation-and-no-replay", () => {
  const frame = structuredClone(root); frame.obligations = [{ id: "original-attempt", status: "UNKNOWN", resolutionRef: null }];
  const used = consumeNativePolicy({ ...input, frame, outstanding: [{ id: "original-attempt", status: "UNKNOWN" }] }, proposal, []);
  assert.equal(used.status, "WAIT"); return used;
});
test("STOP-and-UNKNOWN-labels-retained", () => {
  const unknown = structuredClone(samples[0]); unknown.id = unknown.assignmentRef = "unknown-label";
  unknown.after.disposition = "UNKNOWN"; unknown.after.obligations = [{ id: "original-unknown", status: "UNKNOWN", resolutionRef: null }];
  unknown.consumption.wallMs = null;
  const stop = { ...structuredClone(samples[0]), id: "stop-label", assignmentRef: "stop-label", action: null,
    after: { ...structuredClone(root), disposition: "INCOMPLETE" }, consumption: { attempts: 0, steps: 0, wallMs: "0" } };
  const fitted = fitNativeContinuation([...samples, unknown, stop], context, null, knowledgeAt);
  assert.equal(fitted.samples.length, samples.length + 2);
  assert(fitted.samples.some((s: any) => s.action === null));
  assert(fitted.samples.some((s: any) => s.after.disposition === "UNKNOWN"));
  return { retained: fitted.samples.length };
});
test("state-bound-refuses-without-pruning", () => {
  const branches = Array.from({ length: 64 }, (_, index) => {
    const sample = structuredClone(samples[0]); sample.id = sample.assignmentRef = "branch-" + index;
    sample.premiseRef = sample.id; sample.after.units[0].observationRef = "distinct-observation-" + index;
    return sample;
  });
  const result: any = compileNativePolicy({ ...input, continuation: fitNativeContinuation(branches, context, null, knowledgeAt) });
  assert.equal(result.status, "FALLBACK_REQUIRED"); assert.equal(result.reason, "W1_CONTINUATION_STATE_BOUND");
  return { refused: true, noPruning: true };
});
test("all-owner-facets-invalidate-without-authority", () => {
  const facets = ["METHOD", "MODEL", "PRICE", "DEADLINE", "RESOURCE", "SOURCE", "RIGHTS", "WORK"];
  const before = Object.fromEntries(facets.map(facet => [facet, "old"]));
  const after = Object.fromEntries(facets.map(facet => [facet, "new"]));
  assert.equal(diffNativeDependencies(before, after).length, facets.length);
  return { facets, originalGrant: "original-grant", originalEpisode: "original-episode" };
});
test("signed-lock-order-and-named-meter-gaps", () => {
  assert.deepEqual(orderedNativeLockIds(["10", "-1", "2", "10"]), ["-1", "2", "10"]);
  const reasons = gapReasonsForAttempt({ status: "UNKNOWN", body: { costUSD: null } });
  for (const reason of ["MISSING_ROOT_METER", "UNKNOWN_PHYSICAL_DISPOSITION", "UNKNOWN_MONETARY_COST", "UNMETERED_CHILD_CPU", "UNMETERED_CHILD_MEMORY"])
    assert(reasons.includes(reason));
  return { reasons };
});
for (const boundary of ["workId", "episodeRef"] as const) {
  test(`original-${boundary}-cannot-cross-splits`, () => {
    const leak = structuredClone(samples[0]); leak.id = leak.assignmentRef = "split-leak-" + boundary;
    leak.premiseRef = "different-premise-" + boundary; leak.split = "CALIBRATION";
    if (boundary === "workId") leak.episodeRef = "different-episode";
    else leak.workId = "different-Work";
    assert.throws(() => fitNativeContinuation([...samples, leak], context, null, knowledgeAt)); return { refused: true };
  });
}
for (const split of ["TRAIN", "CALIBRATION"]) {
  test(`future-${split}-not-used-at-earlier-input-cut`, () => {
    const future = structuredClone(samples[0]); future.id = future.assignmentRef = "future-" + split;
    future.workId = "future-Work"; future.episodeRef = "future-episode"; future.premiseRef = "future-premise"; future.split = split;
    future.observedAt = "2026-01-03T00:00:00.000Z";
    assert.throws(() => fitNativeContinuation([...samples, future], context, null, knowledgeAt));
    const result = compileNativePolicy({ ...input, continuation: fitNativeContinuation([...samples, future], context, null, future.observedAt) });
    assert.equal(result.status, "FALLBACK_REQUIRED");
    if (result.status === "FALLBACK_REQUIRED") assert.equal(result.reason, "W1_CONTINUATION_OBSERVATION_AFTER_KNOWLEDGE_CUT");
    return { refused: true };
  });
}
test("stage-after-immutable-validity-refused", () => {
  assert.throws(() => fitNativeContinuation(samples, { ...context, validUntil: "2025-12-31T00:00:00.000Z" }, null, knowledgeAt));
  return { refused: true };
});
test("resolved-native-obligation-requires-original-receipt", () => {
  const invalid = structuredClone(samples[0]); invalid.after.obligations = [{ id: "missing-resolution", status: "RESOLVED", resolutionRef: null }];
  assert.throws(() => fitNativeContinuation([invalid], context, null, knowledgeAt)); return { refused: true };
});
test("fallback-never-dispatches-without-complete-native-frame", () => {
  const units = root.units.map((u: any) => ({ id: u.unitId, status: u.status,
    prerequisites: u.prerequisites.map((key: string) => root.units.find((v: any) => v.key === key).unitId) }));
  const result = planNativeFallback({ ...input, frame: undefined }, units);
  assert.equal(result.status, "FALLBACK");
  if (result.status === "FALLBACK") assert.equal(result.reason, "W1_NATIVE_FRAME_REQUIRED_FOR_FALLBACK");
  return { refused: true };
});
if (proposal?.status === "CHECKED_POLICY") {
  const record = { model: JSON.parse(proposal.modelBytes), policy: proposal.policy,
    actions: proposal.continuation.actions, frames: proposal.continuation.frames };
  const path = join(destination, "conditional-model.json"); await writeFile(path, JSON.stringify(record, null, 2) + "\n");
  const oracle = spawnSync(process.env.FINNOR_TEST_PYTHON ?? "python3",
    [join(import.meta.dirname, "native-continuation-oracle.py"), path, "--output", join(destination, "independent-fraction.json")],
    { encoding: "utf8", timeout: 10_000 });
  cases.push({ id: "independent-Fraction-oracle", status: oracle.status === 0 ? "PASS" : "FAIL", exitCode: oracle.status, stdout: oracle.stdout, stderr: oracle.stderr });
  if (oracle.status !== 0) process.exitCode = 1;
}
await writeFile(join(destination, "mechanics.json"), JSON.stringify({ input, samples, cases,
  qualification: "SYNTHETIC_CONDITIONAL_MECHANICS_NOT_NATIVE_E2E", frameKey: nativeFrameKey(root) }, null, 2) + "\n");
assert.equal(process.exitCode ?? 0, 0, JSON.stringify(cases));
