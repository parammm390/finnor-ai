/** Owning E2E contract, frozen before the native W5 runtime. A local auth
 * transport is allowed; mocked Work, S5, S6, queue claims or receipts are not. */
import { strict as assert } from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const output = process.argv[2];
assert(output && isAbsolute(output), "A new absolute evidence directory is required");
await mkdir(output, { mode: 0o700 });
const began = performance.now();
const contract = {
  schema: "finnor.w5.native-e2e-original.v1",
  qualification: "CONTROLLED_NATIVE_NOT_FIELD_OR_PROTECTED",
  bounds: { wallSeconds: 300, workerHeapMiB: 1024, evidenceBytes: 128 * 1024 * 1024 },
  cases: [
    ["W041/W042", "Real bearer intake attaches one original Work and immutable input; a measured limiter constructs an evidence gate and preserves its actual approver."],
    ["W043", "Canonical S5 COMPUTE/request use is reserved before physical work; fabricated claims, wrong owners and resource overage receive no publication."],
    ["W044", "Only each authenticated participant can adopt current exact terms; installation and owner assertions are not adoption."],
    ["W045", "Forward trial preserves every original Work, S5 reservation and canonical S6 effect; UNKNOWN continues read-only under original identity."],
    ["W046", "Decline/revocation or a new accepted obligation without a lawful destination blocks unsafe migration/rollback, retaining accountability."],
    ["W047/W048", "Native observations and full-cost gaps are retained; caller booleans, controlled evidence and task-specific rescue cannot mint field benefit."],
    ["W049/W050", "A physically killed accepted worker is observed through canonical expired delivery; recovery retains charge/deadline/input and cannot replay a possible effect."],
    ["W051", "Cross-tenant and unrelated principals cannot read parent/private terms; participant projection contains only their own disclosed offer."],
  ],
};
await writeFile(join(output, "original-contract.json"), JSON.stringify(contract, null, 2) + "\n", { flag: "wx" });
let result: unknown, failure: unknown, status = "FAILED_RETAINED";
try {
  const native = await import("../../../packages/private-equity/src/organization-transformation/native");
  for (const symbol of ["intakeOrganizationTransformation", "submitOrganizationTransformation",
    "readOrganizationTransformation", "actOrganizationTransformation", "decideOrganizationAdoption", "useOrganizationProcess"])
    assert.equal(typeof (native as Record<string, unknown>)[symbol], "function", "Public native W5 owner missing: " + symbol);
  const { runNativeOrganizationJourney } = await import("./native-journey.mjs");
  result = await runNativeOrganizationJourney(resolve(output), contract);
  status = "PASS";
} catch (error) {
  failure = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) };
  process.exitCode = 1;
} finally {
  const report = { schema: "finnor.w5.native-e2e-evidence.v1", status, qualification: contract.qualification,
    runtime: process.version, elapsedMs: performance.now() - began, result, failure,
    rerun: `cd ${resolve(import.meta.dirname, "../../..")} && node --import=tsx scripts/postz/w5/native-e2e.mts /absolute/new/evidence-directory` };
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify(report));
}
// embedded-postgres can reset exitCode in its beforeExit hook after cleanup.
process.exit(status === "PASS" ? 0 : 1);
