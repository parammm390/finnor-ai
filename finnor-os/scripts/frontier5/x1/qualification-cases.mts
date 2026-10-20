import assert from "node:assert/strict";

// Independent, hand-calculated contract expectations, frozen before scorer code.
// No protected oracle, authority keys or live application receipt is fabricated.
const { scoreEnvironment } = await import("../../../packages/private-equity/src/institution-qualification/scoring");
const instant = "2026-10-11T00:00:00.000Z", deadline = "2026-10-11T01:00:00.000Z";
const expected = { mappings: [{ identity: "entity-A", semanticDigest: "a".repeat(64) }],
  obligations: [{ identity: "duty-A", semanticDigest: "b".repeat(64), postconditionDigest: "c".repeat(64),
    deadlineAt: deadline, critical: false, businessAssignmentId: "assignment-A", fixedBusinessWeight: 1 }],
  changes: [{ identity: "change-A", occurredAt: instant, availableAt: "2026-10-11T00:10:00.000Z" }] };
const observed = { mappings: [{ identity: "entity-A", semanticDigest: "a".repeat(64) }],
  obligations: [{ identity: "duty-A", semanticDigest: "b".repeat(64) }],
  completions: [{ identity: "duty-A", disposition: "OBSERVED", postconditionDigest: "c".repeat(64),
    observedAt: deadline, witnessDigest: "d".repeat(64) }],
  changes: [{ identity: "change-A", recognizedAt: "2026-10-11T00:12:00.000Z", witnessDigest: "e".repeat(64) }],
  violations: [] };
const complete = scoreEnvironment(expected, observed);
assert.equal(complete.mapping.precision, 1); assert.equal(complete.mapping.recall, 1);
assert.equal(complete.completion.rate, 1); assert.equal(complete.changeRecognition.rate, 1);
assert.equal(complete.transportLagMs[0], 600000); assert.equal(complete.performancePassed, true);
const duplicate = structuredClone(observed); duplicate.mappings.push({ ...duplicate.mappings[0]! });
assert.equal(scoreEnvironment(expected, duplicate).mapping.precision, 0.5, "one-to-one duplicate credit");
assert.equal(scoreEnvironment(expected, duplicate).mapping.recall, 1);
const late = structuredClone(observed);
late.completions[0]!.observedAt = "2026-10-11T01:00:00.001Z";
late.changes[0]!.recognizedAt = "2026-10-11T00:12:00.001Z";
const delayed = scoreEnvironment(expected, late);
assert.equal(delayed.completion.rate, 0); assert.equal(delayed.changeRecognition.rate, 0);
assert.equal(delayed.performancePassed, false);
const missing = structuredClone(observed); missing.obligations = []; missing.completions = [];
assert.equal(scoreEnvironment(expected, missing).obligation.recall, 0);
assert.equal(scoreEnvironment(expected, missing).completion.rate, 0);
const critical = structuredClone(expected); critical.obligations[0]!.critical = true;
assert.deepEqual(scoreEnvironment(critical, missing).criticalMisses, ["duty-A"]);
const veto = { ...observed, violations: ["UNAUTHORIZED_EFFECT"] };
assert.equal(scoreEnvironment(expected, veto).performancePassed, false);
const empty = { mappings: [], obligations: [], changes: [] };
assert.equal(scoreEnvironment(empty, { ...observed, mappings: [], obligations: [], completions: [], changes: [] }).performancePassed, false);
console.log(JSON.stringify({ status: "PASS_DEVELOPMENT_SCORER_CONTRACT", basis: "INDEPENDENT_HAND_CALCULATION_NOT_PROTECTED_POPULATION", cases: 7 }));
