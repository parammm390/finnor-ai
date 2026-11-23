/** Failure-first finite source process for continuation 02. No Auth, native
 * owner, admission or allowance is created; records are SOURCE observations. */
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ExperimentRef } from "@finnor/shared-types";
import { hash } from "../../../packages/private-equity/src/project-z/z3-viability/contracts";
import { assertNativeProjectionCoverage, nativeKnowledgeAdmits, nativePredicateMatches,
  NATIVE_MAXIMUM_OWNER_CUBES, type NativeDomainRegion, type NativeObservation,
  type NativePredicate } from "../../../packages/private-equity/src/project-z/z3-viability/general-model";

const argument = (key: string) => process.argv.find(x => x.startsWith(key + "="))?.slice(key.length + 1);
const input = argument("--inputs"), output = argument("--output");
if (!input || !output || !isAbsolute(input) || !isAbsolute(output)) throw Error("ABSOLUTE_SOURCE_PATHS_REQUIRED");
const raw = await readFile(input, "utf8");
const fixture = JSON.parse(raw) as {
  scope: string;
  coverage: Array<{ name: string; domain: string[]; open?: boolean; missing?: boolean; predicates: string[]; expected: string }>;
  composite: { left: { token: string; available: boolean }; right: { token: string; available: boolean };
    bothExpected: boolean; lostChannelExpected: boolean; changedRevisionExpected: string };
  largeCover: { independentBooleanFields: number; maximumOwnerCubes: number; expected: string };
  knowledge: { meaning: string; freshContextDoesNotReplaceResult: boolean };
  identity: { changedMapExpected: string; newAllowance: boolean };
};
assert.equal(fixture.scope, "FROZEN_SOURCE_EXPECTATIONS_BEFORE_CONTINUATION_02_NOT_OWNER_EVIDENCE");
const revision: ExperimentRef = { owner: "S4", id: "source-fixture-not-an-owner", version: "fixture", contentDigest: "1".repeat(64) };
const predicate = (owner: string, values: NativePredicate["values"]): NativePredicate => ({ observerId: owner, revision, values });
const observation = (owner: string, facts: NativeObservation["facts"]): NativeObservation =>
  ({ observerId: owner, revision, sourceRef: revision, facts, qualification: fixture.scope });
const records: Array<Record<string, unknown>> = [];
let failures = 0;
const code = (error: unknown) => error && typeof error === "object" && "code" in error
  ? String(error.code) : error instanceof Error ? error.message : String(error);
function run(name: string, expected: unknown, action: () => unknown) {
  let actual: unknown;
  try { actual = action(); } catch (error) { actual = code(error); }
  let passed = false;
  try { assert.deepEqual(actual, expected); passed = true; } catch { failures++; }
  records.push({ name, expected, actual, passed, scope: fixture.scope });
}
for (const item of fixture.coverage) run(item.name, item.expected, () => {
  const domain: NativeDomainRegion[] = [{ fields: [{ observerId: "control", field: "token",
    values: item.domain, open: item.open ?? false, missing: item.missing ?? false }] }];
  assertNativeProjectionCoverage(item.predicates.map(value => predicate("control", { token: value })), domain);
  return "COMPLETE";
});
const { left, right } = fixture.composite;
const combined: NativePredicate = { ...predicate("left", { token: left.token }),
  and: [predicate("right", { token: right.token, available: right.available })] };
const frame = [observation("left", { token: left.token, available: left.available }),
  observation("right", { token: right.token, available: right.available })];
run("composite-both-real-channels", fixture.composite.bothExpected, () => nativePredicateMatches(combined, frame, {}));
run("composite-lost-channel-not-false-justice-evidence", fixture.composite.lostChannelExpected,
  () => nativePredicateMatches(combined, frame.slice(0, 1), {}));
run("composite-current-owner-revision", fixture.composite.changedRevisionExpected, () =>
  nativePredicateMatches(combined, [frame[0]!, { ...frame[1]!, revision: { ...revision, contentDigest: "2".repeat(64) } }], {}));
run("maximum-owner-cubes-frozen", fixture.largeCover.maximumOwnerCubes, () => NATIVE_MAXIMUM_OWNER_CUBES);
run("64-boolean-fields-not-2-to-64-enumeration", fixture.largeCover.expected, () => {
  const fields = Array.from({ length: fixture.largeCover.independentBooleanFields }, (_, i) =>
    ({ observerId: "control", field: "b" + i, values: [false, true], open: false, missing: false }));
  assertNativeProjectionCoverage([predicate("control", { b0: false }), predicate("control", { b0: true })], [{ fields }]);
  return "COMPLETE";
});
run("cube-limit-refused", "Z3_NATIVE_TYPED_PROJECTION_CUBE_LIMIT", () => {
  const fields = Array.from({ length: 4 }, (_, i) =>
    ({ observerId: "control", field: "b" + i, values: [false, true], open: false, missing: false }));
  const cubes = Array.from({ length: 16 }, (_, n) =>
    predicate("control", Object.fromEntries(fields.map((f, i) => [f.field, Boolean(n >> i & 1)]))));
  assertNativeProjectionCoverage(cubes, [{ fields }]);
  return "COMPLETE";
});
run("request-field-without-typed-domain-refused", "Z3_NATIVE_TYPED_PROJECTION_DOMAIN_REQUIRED", () => {
  assertNativeProjectionCoverage([predicate("control", { token: "LEFT", asserted: true })],
    [{ fields: [{ observerId: "control", field: "token", values: ["LEFT"], open: false, missing: false }] }]);
  return "COMPLETE";
});
run("wildcard-covers-open-and-missing-leaves", "COMPLETE", () => {
  assertNativeProjectionCoverage([predicate("control", {})],
    [{ fields: [{ observerId: "control", field: "token", values: [], open: true, missing: true }] }]);
  return "COMPLETE";
});
const retained: NativeObservation = { ...observation("exact", { token: left.token }), knowledge: "RETURNED_OWNER_RESULT" };
const fresh = observation("exact", { token: left.token, $view: "CONTEXT" });
run("last-owner-result-fresh-context-refused", !fixture.knowledge.freshContextDoesNotReplaceResult,
  () => nativeKnowledgeAdmits(fixture.knowledge.meaning as "LAST_OWNER_RESULT", fresh));
run("last-owner-result-retained-frame-admitted", true,
  () => nativeKnowledgeAdmits(fixture.knowledge.meaning as "LAST_OWNER_RESULT", retained));
run("current-context-does-not-read-retained-result", false, () => nativeKnowledgeAdmits("CURRENT_CONTEXT", retained));
await mkdir(output);
await writeFile(join(output, "records.ndjson"), records.map(x => JSON.stringify(x)).join("\n") + "\n");
const report = { scope: fixture.scope, status: failures ? "FAIL" : "PASS", inputSha256: hash(raw),
  records: records.length, failures, actualOwnerCalls: 0, native: "NOT_RUN", installed: "NOT_RUN",
  identityBridge: { expected: fixture.identity.changedMapExpected, status: "NOT_RUN_REQUIRES_DB_SESSION" },
  newAllowance: fixture.identity.newAllowance };
await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
if (failures) process.exitCode = 1;
