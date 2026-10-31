/** Failure-first finite source process. No fake Auth, native owner, or admission. */
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ExperimentRef } from "@finnor/shared-types";
import { hash } from "../../../packages/private-equity/src/project-z/z3-viability/contracts";
import { nativePredicateMatches, type NativePredicate, type NativeObservation } from "../../../packages/private-equity/src/project-z/z3-viability/general-model";
import { assertNativeProjectionCoverage, type NativeDomainRegion } from "../../../packages/private-equity/src/project-z/z3-viability/general-coverage";

const argument = (key: string) => process.argv.find(x => x.startsWith(key + "="))?.slice(key.length + 1);
const input = argument("--inputs"), output = argument("--output");
if (!input || !output || !isAbsolute(input) || !isAbsolute(output)) throw Error("ABSOLUTE_SOURCE_PATHS_REQUIRED");
const raw = await readFile(input, "utf8");
const fixture = JSON.parse(raw) as { scope: string; coverage: Array<{
  name: string; domain: string[]; open?: boolean; missing?: boolean; predicates: string[]; expected: string;
}>; largeCover: { independentBooleanFields: number; maximumOwnerCubes: number; expected: string } };
assert.equal(fixture.scope, "FROZEN_SOURCE_EXPECTATIONS_BEFORE_CONTINUATION_02_NOT_OWNER_EVIDENCE");
const revision: ExperimentRef = { owner: "S4", id: "source-fixture-not-an-owner", version: "fixture", contentDigest: "1".repeat(64) };
const predicate = (owner: string, values: NativePredicate["values"]): NativePredicate =>
  ({ observerId: owner, revision, values });
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
const combined: NativePredicate = { ...predicate("left", { token: "LEFT" }),
  and: [predicate("right", { token: "RIGHT", available: false })] };
const frame = [observation("left", { token: "LEFT", available: true }),
  observation("right", { token: "RIGHT", available: false })];
run("composite-both-real-channels", true, () => nativePredicateMatches(combined, frame, {}));
run("composite-lost-channel-not-false-justice-evidence", false, () => nativePredicateMatches(combined, frame.slice(0, 1), {}));
run("composite-current-owner-revision", "Z3_NATIVE_OWNER_PREDICATE_REVISION_CHANGED", () =>
  nativePredicateMatches(combined, [frame[0]!, { ...frame[1]!, revision: { ...revision, contentDigest: "2".repeat(64) } }], {}));
run("64-boolean-fields-not-2-to-64-enumeration", fixture.largeCover.expected, () => {
  const fields = Array.from({ length: fixture.largeCover.independentBooleanFields }, (_, i) =>
    ({ observerId: "control", field: "b" + i, values: [false, true], open: false, missing: false }));
  assertNativeProjectionCoverage([predicate("control", { b0: false }), predicate("control", { b0: true })], [{ fields }]);
  return "COMPLETE";
});
run("wildcard-covers-open-and-missing-leaves", "COMPLETE", () => {
  assertNativeProjectionCoverage([predicate("control", {})],
    [{ fields: [{ observerId: "control", field: "token", values: [], open: true, missing: true }] }]);
  return "COMPLETE";
});
await mkdir(output);
await writeFile(join(output, "records.ndjson"), records.map(x => JSON.stringify(x)).join("\n") + "\n");
const report = { scope: fixture.scope, status: failures ? "FAIL" : "PASS", inputSha256: hash(raw),
  records: records.length, failures, actualOwnerCalls: 0, native: "NOT_RUN", installed: "NOT_RUN", newAllowance: false };
await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
if (failures) process.exitCode = 1;
