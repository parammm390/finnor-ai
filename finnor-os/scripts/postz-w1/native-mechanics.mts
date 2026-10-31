import { strict as assert } from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { fitResponseState } from "../../packages/epistemic-runtime/src/metalevel-policy/response";
import { compileNativePolicy, consumeNativePolicy, planNativeFallback } from "../../packages/private-equity/src/economic-orchestration/policy";
import { fitNativeContinuation, nativeActionRef } from "../../packages/private-equity/src/economic-orchestration/continuation";
import { nativeFrameSchema, nativeStageObservationSchema, type NativeFrame, type NativeStageObservation } from "../../packages/private-equity/src/economic-orchestration/continuation-contracts";
import { nativeControlInputSchema } from "../../packages/private-equity/src/economic-orchestration/contracts";
import { r2MeasuredQuantity, r2Quantity, r2String } from "../../packages/epistemic-runtime/src/r2-rational";

const destination = resolve(process.argv[2] ?? "");
assert(process.argv[2], "New evidence directory required");
await mkdir(destination, { recursive: false });
const ref = (name: string) => ({ owner: "NATIVE_FIXTURE", id: name, version: "v1", contentDigest: "a".repeat(64) });
const pins = { sourceRef: "source", modelRef: "native", providerRef: "native", methodRef: "p1", priceRef: "price", checkerRef: "sql", runtimeRef: "runtime" };
const features = { structureRef: "dependent-execute-verify", outcomeClassRef: "original-acceptance", domainRef: "controlled-fixture" };
const knowledgeAt = "2026-01-02T00:00:00.000Z";
const dataset = { schema: "finnor.orchestration-response-dataset.v1", datasetId: "development", tenantId: "tenant", principalId: "principal", purposeRef: "purpose", populationRef: "population", sourceClass: "SYNTHETIC_DEVELOPMENT",
  protocol: { kind: "LOGGED_ASSOCIATION", ref: "logged-native-v1", confidenceLevel: .95 }, pins, knowledgeAt, validUntil: "2099-01-01T00:00:00.000Z",
  samples: ["fast", "slow"].map((treatmentRef, i) => ({ id: "observation-" + i, workId: "old-" + i, unitId: "unit-" + i, split: "TRAIN", features, treatmentRef, traceRef: "original-native-" + i,
    evidenceRefs: ["independent-SQL-" + i], premiseRefs: ["common-original-source"], assignmentRef: "logged-assignment-" + i, assignmentProbability: "1", accepted: true,
    acceptanceRef: "sql-check-" + i, censored: false, humanRescue: false, observedAt: "2026-01-01T00:00:00.000Z", latencyMs: i ? 100 : 10, cpuMs: 1, peakMemoryBytes: 100, humanSeconds: 0,
    monetaryCost: { status: "UNKNOWN", reason: "NATIVE_BILLING_UNKNOWN" } })) };
const entries = ["fast", "slow"].map((treatmentRef, i) => ({ computationRef: treatmentRef, treatmentRef, unitIds: [treatmentRef + "-execute", treatmentRef + "-verify"],
  unitCosts: [{ unitId: treatmentRef + "-execute", attempts: 1 as const, steps: i ? 19 : 9 }, { unitId: treatmentRef + "-verify", attempts: 1 as const, steps: 1 }],
  moduleIds: ["module-" + i], methodRefs: [ref("method-" + i)], contextRefs: ["source"], verifierRefs: ["sql"], prerequisiteEdges: [{ from: treatmentRef + "-execute", to: treatmentRef + "-verify" }],
  attempts: 2, steps: i ? 20 : 10, independence: "COMMON_PREMISE_ALTERNATE_IMPLEMENTATIONS", available: true }));
const root = nativeFrameSchema.parse({
  units: entries.flatMap(entry => entry.unitCosts.map((cost, index) => ({
    key: cost.unitId, unitId: cost.unitId, kind: index ? "VERIFY_P1" : "EXECUTE_P1", status: "PENDING",
    prerequisites: index ? [entry.unitIds[0]] : [], steps: cost.steps, observationRef: null,
  }))),
  history: [], obligations: [], requiredChecks: ["original-SQL"], completedChecks: [], acceptanceRef: null, disposition: "ACTIVE",
});
const samples: NativeStageObservation[] = [];
function observedStage(before: NativeFrame, name: string, kind: "execute" | "verify") {
  const after = structuredClone(before), key = name + "-" + kind;
  const unit = after.units.find(row => row.key === key);
  assert(unit, "Complete original stage required");
  unit.status = "COMPLETED"; unit.observationRef = "observed:" + key;
  if (kind === "verify") {
    after.completedChecks = ["original-SQL"]; after.acceptanceRef = "original-SQL:" + name; after.disposition = "ACCEPTED";
  }
  const action = { ref: nativeActionRef([key]), unitKeys: [key], unitIds: [unit.unitId], computationRef: name,
    contextRefs: ["source"], verifierRefs: ["sql"], attempts: 1, steps: unit.steps };
  const observation = createHash("sha256").update(JSON.stringify(after.units)).digest("hex");
  after.history.push({ actionRef: action.ref, observation });
  samples.push(nativeStageObservationSchema.parse({
    schema: "finnor.w1.native-stage-observation.v1", id: "stage-" + samples.length, assignmentRef: "assignment-" + samples.length,
    episodeRef: "observed-episode-" + name, workId: "observed-Work-" + name, premiseRef: "common-original-source", split: "TRAIN",
    before, action, after, observation, consumption: { attempts: 1, steps: unit.steps, wallMs: kind === "verify" ? "1" : name === "fast" ? "10" : "100" },
    evidenceRefs: ["original-attempt:" + key, "original-SQL:" + name], observedAt: "2026-01-01T00:00:00.000Z",
  }));
  return after;
}
const fastExecuted = observedStage(root, "fast", "execute");
observedStage(fastExecuted, "fast", "verify");
const slowExecuted = observedStage(root, "slow", "execute");
observedStage(slowExecuted, "slow", "verify");
const continuation = fitNativeContinuation(samples, { tenantId: "tenant", principalId: "principal", purposeRef: "purpose",
  populationRef: "population", pins, features, validUntil: dataset.validUntil, sourceClass: "SYNTHETIC_DEVELOPMENT" }, null, knowledgeAt);
const input = nativeControlInputSchema.parse({ schema: "finnor.w1.native-control-input.v1", searchId: "search", programId: "program", episodeId: "episode", workInputId: "work-input", workInputDigest: "a".repeat(64), generation: 1,
  purposeRef: "purpose", populationRef: "population", protocolRef: "logged-native-v1", features, pins,
  binding: { tenantId: "tenant", principalId: "principal", workId: "work", outcomeRef: "outcome", mandateRef: "mandate", sourceRef: "source", rightsRef: "rights", catalogueRef: "catalogue",
    responseRef: continuation.ref, modelRef: "native", priceRef: "price", checkerRef: "sql", runtimeRef: "runtime", parentGrantRef: "grant", deadline: "2099-01-01T00:00:00.000Z" },
  catalogue: { ref: "catalogue", entries }, response: fitResponseState(dataset), continuation, frame: root,
  utility: { ref: ref("owner-conversion"), unit: "model-utility", lossGap: "100", nativeAttemptCost: "1", delayMsCost: "0", controllerMsCost: "0" },
  remaining: { attempts: 5, steps: 1000, wallMs: 100000, maxParallel: 2, publicationAttempts: 1 },
  incumbentRef: null, outstanding: [], now: knowledgeAt });
const unitsOf = (frame: NativeFrame) => frame.units.map(unit => ({ id: unit.unitId, status: unit.status, prerequisites: unit.prerequisites }));
const cases: unknown[] = [];
async function check(id: string, fn: () => unknown) {
  try { cases.push({ id, status: "PASS", observed: fn() }); }
  catch (error) { cases.push({ id, status: "FAIL", observed: String(error) }); process.exitCode = 1; }
}
await check("joint-chain-exact-price-tie", () => {
  const result = compileNativePolicy(input);
  assert.equal(result.status, "CHECKED_POLICY");
  if (result.status !== "CHECKED_POLICY") throw Error("Checked policy absent");
  assert(result.continuation);
  const root = result.policy.states[result.policy.rootStateId];
  assert.equal(root?.value, "98");
  assert(root);
  assert.equal(result.continuation.actions[root.selectedChoiceId]?.computationRef, "fast");
  assert.deepEqual(root.optimalChoiceIds.map(id => result.continuation?.actions[id]?.computationRef), ["fast", "slow"]);
  const used = consumeNativePolicy(input, result, unitsOf(nativeFrameSchema.parse(input.frame)));
  assert.equal(used.status, "DISPATCH");
  if (used.status !== "DISPATCH") throw Error("Native dispatch absent");
  assert.deepEqual(used.unitIds, ["fast-execute"]);
  return { value: root?.value, ties: root?.optimalChoiceIds, selected: used.unitIds };
});
await check("original-check-barrier-continuation", () => {
  const result = compileNativePolicy(input);
  const used = consumeNativePolicy({ ...input, frame: fastExecuted,
    remaining: { ...input.remaining, attempts: 4, steps: 991, wallMs: 99990 } }, result, unitsOf(fastExecuted));
  assert.equal(used.status, "DISPATCH");
  if (used.status !== "DISPATCH") throw Error("Check continuation absent");
  assert.deepEqual(used.unitIds, ["fast-verify"]);
  return { selected: used.unitIds, businessCompletion: false };
});
await check("price-drift-consumer-refuses", () => {
  const result = compileNativePolicy(input), changed = structuredClone(input);
  changed.pins.priceRef = "changed-price";
  const used = consumeNativePolicy(changed, result, []);
  assert.equal(used.status, "FALLBACK");
  if (used.status !== "FALLBACK") throw Error("Drift was not fenced");
  assert.equal(used.reason, "W1_MATERIAL_PIN_DRIFT");
  return used;
});
await check("unknown-no-replay-fallback", () => {
  const result = planNativeFallback({ ...input, outstanding: [{ id: "original-effect-or-attempt", status: "UNKNOWN" }] }, []);
  assert.deepEqual(result, { status: "WAIT", reason: "W1_UNKNOWN_REQUIRES_ORIGINAL_OWNER_RECONCILIATION", authorityGranted: false });
  return result;
});
await check("unmeasured-cold-start-not-invented-ROI", () => {
  const result = compileNativePolicy({ ...input, response: null, continuation: null });
  assert.equal(result.status, "FALLBACK_REQUIRED");
  if (result.status !== "FALLBACK_REQUIRED") throw Error("Cold response fabricated");
  assert.equal(result.reason, "W1_NATIVE_CONDITIONAL_RESPONSE_REQUIRED");
  return result;
});
await check("descriptive-marginal-fit-is-not-continuation-authority", () => {
  const result = compileNativePolicy({ ...input, continuation: null });
  assert.equal(result.status, "FALLBACK_REQUIRED");
  if (result.status !== "FALLBACK_REQUIRED") throw Error("Marginal fit became policy authority");
  assert.equal(result.reason, "W1_NATIVE_CONDITIONAL_RESPONSE_REQUIRED");
  return result;
});
await check("fallback-carries-complete-original-stage", () => {
  const result = planNativeFallback({ ...input, continuation: null }, unitsOf(root));
  assert.equal(result.status, "DISPATCH");
  if (result.status !== "DISPATCH") throw Error("Original fallback unavailable");
  assert.deepEqual(result.unitIds, ["fast-execute"]); assert.equal(result.stateId, null);
  assert.equal(result.actionRef, nativeActionRef(["fast-execute"])); assert.deepEqual(result.beforeFrame, root);
  return result;
});
await check("finite-measurement-report-conversion", () => {
  for (const [measured, exact] of [[1.25, "5/4"], [-1.25, "-5/4"], [1e21, "1000000000000000000000"], [1e-7, "1/10000000"]] as const)
    assert.equal(r2String(r2MeasuredQuantity(measured)), exact);
  assert.equal(r2String(r2MeasuredQuantity(Number.MIN_VALUE)), r2String(r2Quantity("5/1" + "0".repeat(324))));
  for (const invalid of [NaN, Infinity, -Infinity]) assert.throws(() => r2MeasuredQuantity(invalid));
  return { ordinary: "5/4", scientific: true, smallestFinite: true, nonfiniteRefused: true };
});
await writeFile(join(destination, "native-mechanics.json"), JSON.stringify({ schema: "finnor.w1.native-mechanics-evidence.v1", input, cases,
  qualification: "SYNTHETIC_ISOLATED_MECHANICS_NOT_NATIVE_API_QUEUE_PROOF", independentlyProtected: false }, null, 2) + "\n");
assert.equal(process.exitCode ?? 0, 0, JSON.stringify(cases));
