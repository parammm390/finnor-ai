/** Failure-first response-state proof, written before its implementation. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fitResponseState, appendResponseObservations, responseEstimate, parseResponseDataset } from "../../packages/epistemic-runtime/src/metalevel-policy/response.ts";

const pins = {
  sourceRef: "source:v1", modelRef: "model:v1", providerRef: "provider:v1",
  methodRef: "method:v1", priceRef: "price:v1", checkerRef: "checker:v1", runtimeRef: "runtime:v1",
};
const features = { structureRef: "original-dependency-graph:v1", outcomeClassRef: "original-criterion:v1", domainRef: "controlled-development-domain:v1" };
const sample = (id: string, unitId: string, accepted: boolean, split: "TRAIN" | "CALIBRATION" = "TRAIN") => ({
  id, workId: `original-work:${id}`, unitId, split, features, treatmentRef: "joint-topology:single-exact-plus-check",
  traceRef: `measured-trace:${id}`, evidenceRefs: [`independent-evidence:${id}`], premiseRefs: [`premise:${unitId}`],
  assignmentRef: `s2-assignment:${id}`, assignmentProbability: "1/2", accepted, acceptanceRef: `independent-original-acceptance:${id}`,
  censored: false, humanRescue: false, observedAt: "2026-10-25T00:00:00.000Z",
  latencyMs: accepted ? 20 : 40, cpuMs: 10, peakMemoryBytes: 1024, humanSeconds: 0,
  monetaryCost: { status: "KNOWN", amount: "2", unit: "USD" },
});
const originalInput = {
  schema: "finnor.orchestration-response-dataset.v1", datasetId: "development-dataset",
  tenantId: "tenant:development", principalId: "principal:development", purposeRef: "purpose:development",
  populationRef: "population:development", sourceClass: "SYNTHETIC_DEVELOPMENT",
  protocol: { kind: "RANDOMIZED_INDEPENDENT_UNITS", ref: "s2-protocol:development", confidenceLevel: 0.95 },
  pins, knowledgeAt: "2026-10-26T00:00:00.000Z", validUntil: "2026-11-01T00:00:00.000Z",
  samples: [sample("a", "unit-1", true), sample("a-repeat-source", "unit-1", true), sample("b", "unit-2", false), sample("calibration", "unit-c", true, "CALIBRATION")],
};
const output = resolve(process.argv[2] ?? "../scope-postz/w1-economic-orchestration/evidence/response");
await mkdir(output, { recursive: true });
const cases: Array<{ name: string; status: "PASS" | "FAIL"; detail: string }> = [];
function proof(name: string, run: () => void) {
  try { run(); cases.push({ name, status: "PASS", detail: "Literal pre-code predicate satisfied" }); }
  catch (error) { cases.push({ name, status: "FAIL", detail: error instanceof Error ? error.message : String(error) }); }
}
const dataset = parseResponseDataset(originalInput);
const state = fitResponseState(dataset);
const query = { tenantId: dataset.tenantId, principalId: dataset.principalId, purposeRef: dataset.purposeRef,
  populationRef: dataset.populationRef, protocolRef: dataset.protocol.ref, pins, features,
  treatmentRef: "joint-topology:single-exact-plus-check", now: "2026-10-26T00:00:00.000Z" };
proof("joint-response-independent-units", () => {
  const result = responseEstimate(state, query);
  assert.equal(result.status, "AVAILABLE");
  if (result.status !== "AVAILABLE") throw Error("No supported estimate");
  assert.equal(result.estimate.trainingSamples, 3);
  assert.equal(result.estimate.independentUnits, 2);
  assert.equal(result.estimate.acceptanceMean, "1/2");
  assert.equal(result.estimate.latencyMeanMs, "30");
  assert.equal(result.estimate.calibrationSamples, 1);
  assert.equal(result.estimate.monetaryCost.status, "KNOWN");
  assert.equal(result.estimate.identification, "RANDOMIZED_DESIGN_CONDITIONAL");
});
proof("calibration-does-not-fit-training-mean", () => {
  const altered = parseResponseDataset({ ...originalInput, samples: originalInput.samples.map(s => s.split === "CALIBRATION" ? { ...s, accepted: false } : s) });
  const result = responseEstimate(fitResponseState(altered), query);
  assert.equal(result.status === "AVAILABLE" ? result.estimate.acceptanceMean : "missing", "1/2");
});
proof("heldout-refused-at-fitting-boundary", () => {
  assert.throws(() => parseResponseDataset({ ...originalInput, samples: [{ ...sample("hidden", "unit-hidden", true), split: "HELD_OUT" }] }));
});
proof("unit-cannot-cross-splits", () => {
  assert.throws(() => parseResponseDataset({ ...originalInput, samples: [...originalInput.samples, sample("leak", "unit-1", true, "CALIBRATION")] }));
});
proof("original-Work-cannot-cross-splits", () => {
  const leak = { ...sample("work-leak", "unrelated-calibration-unit", true, "CALIBRATION"), workId: originalInput.samples[0]!.workId };
  assert.throws(() => parseResponseDataset({ ...originalInput, samples: [...originalInput.samples, leak] }));
});
for (const split of ["TRAIN", "CALIBRATION"] as const) {
  proof(`future-${split}-observation-not-available-at-earlier-cut`, () => {
    const future = { ...sample(`future-${split}`, `future-unit-${split}`, true, split), observedAt: "2026-10-27T00:00:00.000Z" };
    assert.throws(() => fitResponseState({ ...originalInput, samples: [...originalInput.samples, future] }));
    const fitted = fitResponseState({ ...originalInput, knowledgeAt: future.observedAt, samples: [...originalInput.samples, future] });
    assert.equal(responseEstimate(fitted, query).status, "UNKNOWN");
  });
}
proof("original-Work-repetition-does-not-create-independent-confidence", () => {
  const fitted = fitResponseState({ ...originalInput, samples: originalInput.samples.filter(s => s.split === "TRAIN").map((s, i) => ({
    ...s, workId: "same-original-Work", unitId: `different-unit-${i}`, premiseRefs: [`different-premise-${i}`],
  })) });
  const result = responseEstimate(fitted, query);
  assert.equal(result.status === "AVAILABLE" ? result.estimate.independentUnits : -1, 1);
});
proof("calibration-readback-is-equal-independent-group-weighted", () => {
  const calibration = [...Array.from({ length: 100 }, (_, i) => sample(`cal-repeat-${i}`, "one-calibration-unit", true, "CALIBRATION")),
    sample("cal-independent-failure", "second-calibration-unit", false, "CALIBRATION")];
  const result = responseEstimate(fitResponseState({ ...originalInput,
    samples: [...originalInput.samples.filter(s => s.split === "TRAIN"), ...calibration] }), query);
  assert.equal(result.status === "AVAILABLE" ? result.estimate.calibrationAcceptance : "missing", "1/2");
  assert.equal(result.status === "AVAILABLE" ? result.estimate.calibrationSamples : -1, 101);
});
proof("empty-observations-remain-UNKNOWN", () => {
  assert.equal(responseEstimate(fitResponseState({ ...originalInput, samples: [] }), query).status, "UNKNOWN");
});
proof("duplicate-observation-is-not-new-evidence", () => {
  assert.throws(() => appendResponseObservations(dataset, [dataset.samples[0]], query.now));
});
proof("unknown-dollars-are-not-zero", () => {
  const altered = parseResponseDataset({ ...originalInput, samples: originalInput.samples.map(s => s.id === "b" ? { ...s, monetaryCost: { status: "UNKNOWN", reason: "Unmetered provider dollars" } } : s) });
  const result = responseEstimate(fitResponseState(altered), query);
  assert.equal(result.status === "AVAILABLE" ? result.estimate.monetaryCost.status : "missing", "UNKNOWN");
});
proof("append-fits-new-state-retains-original", () => {
  const next = appendResponseObservations(dataset, [sample("fresh", "unit-3", true)], query.now);
  const updated = fitResponseState(next, state.ref);
  assert.notEqual(updated.ref, state.ref);
  assert.equal(updated.previousRef, state.ref);
  assert.equal(dataset.samples.length, 4);
  assert.equal(next.samples.length, 5);
});
proof("append-cannot-regress-the-original-knowledge-cut", () => {
  assert.throws(() => appendResponseObservations(dataset, [sample("earlier-cut", "unit-new", true)], "2026-10-24T00:00:00.000Z"));
});
proof("price-drift-refuses-dependent-estimate", () => {
  const result = responseEstimate(state, { ...query, pins: { ...pins, priceRef: "price:v2" } });
  assert.equal(result.status, "UNKNOWN");
});
proof("unseen-joint-treatment-not-interpolated", () => {
  assert.equal(responseEstimate(state, { ...query, treatmentRef: "joint-topology:three-correlated-specialists" }).status, "UNKNOWN");
});
proof("private-context-not-reused", () => {
  assert.equal(responseEstimate(state, { ...query, tenantId: "another-tenant" }).status, "UNKNOWN");
});
proof("logged-traces-not-causal-estimates", () => {
  const logged = parseResponseDataset({ ...originalInput, protocol: { ...originalInput.protocol, kind: "LOGGED_ASSOCIATION" } });
  const result = responseEstimate(fitResponseState(logged), query);
  assert.equal(result.status, "AVAILABLE");
  if (result.status !== "AVAILABLE") throw Error("No estimate");
  assert.equal(result.estimate.identification, "ASSOCIATIONAL_ONLY");
  assert.deepEqual(result.estimate.acceptanceBounds, ["0", "1"]);
});
proof("source-repeats-do-not-create-independent-confidence", () => {
  const repeated = parseResponseDataset({ ...originalInput, samples: originalInput.samples.filter(s => s.split === "TRAIN").map(s => ({ ...s, unitId: "same-source-unit", premiseRefs: ["same-premise"] })) });
  const result = responseEstimate(fitResponseState(repeated), query);
  assert.equal(result.status === "AVAILABLE" ? result.estimate.independentUnits : -1, 1);
});
proof("failed-rescued-work-is-retained-not-success", () => {
  const rescued = parseResponseDataset({ ...originalInput, samples: originalInput.samples.map(s => ({ ...s, humanRescue: true })) });
  const result = responseEstimate(fitResponseState(rescued), query);
  assert.equal(result.status === "AVAILABLE" ? result.estimate.acceptanceMean : "missing", "0");
});
const report = { schema: "finnor.postz.w1.response-development-proof.v1", sourceClass: "SYNTHETIC_DEVELOPMENT",
  nativeObservationProof: "NOT_RUN", protectedCustody: false, fittedState: state,
  originalInput, passed: cases.filter(c => c.status === "PASS").length, failed: cases.filter(c => c.status === "FAIL").length, cases };
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(resolve(output, `run-${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ...report, fittedState: state.ref, originalInput: "retained-in-artifact" }, null, 2)}\n`);
if (report.failed) process.exitCode = 1;
