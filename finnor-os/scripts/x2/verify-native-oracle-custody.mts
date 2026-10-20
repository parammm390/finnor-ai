/** One deliberate ending-custody attack against the actual native driver.
 * Business success under a changed oracle pin is not a sealed positive proof. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const out = process.env.FINNOR_X2_EVIDENCE_DIR;
if (!out?.startsWith("/")) throw Error("NEW_ABSOLUTE_CUSTODY_EVIDENCE_DIRECTORY_REQUIRED");
await mkdir(out, { mode: 0o700 });
const native = join(out, "native");
const fixture = resolve(import.meta.dirname, "fixtures/evaluate.mjs");
const original = await readFile(fixture);
const mode = (await stat(fixture)).mode & 0o777;
const mutant = Buffer.concat([original, Buffer.from("\n// Owned X2 ending-oracle custody attack, no behavior change.\n")]);
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
await writeFile(join(out, "private-original-evaluator.mjs"), original, { mode: 0o600, flag: "wx" });
const child = spawn(process.execPath, ["--import=tsx", resolve(import.meta.dirname, "run-native-e2e.mts")], {
  cwd: resolve(import.meta.dirname, "../.."),
  env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C", TZ: "UTC",
    FINNOR_X2_EVIDENCE_DIR: native, FINNOR_X2_TEST_SURFACE: "api", FINNOR_X2_TEST_S8: "0" },
  stdio: ["ignore", "pipe", "pipe"],
});
const chunks: Buffer[] = [];
child.stdout!.on("data", bytes => chunks.push(Buffer.from(bytes)));
child.stderr!.on("data", bytes => chunks.push(Buffer.from(bytes)));
let exited = false, changed = false;
const exit = new Promise<{ code: number | null; signal: string | null }>((yes, no) => {
  child.once("error", no);
  child.once("close", (code, signal) => { exited = true; yes({ code, signal }); });
});
void exit.catch(() => undefined);
const started = Date.now();
let disposition: Record<string, unknown> = {};
try {
  let freeze: { oraclePins: Array<{ path: string; sha256: string }> } | null = null;
  while (!freeze && !exited && Date.now() - started < 30000) {
    try { freeze = JSON.parse(await readFile(join(native, "freeze.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!freeze) await new Promise(yes => setTimeout(yes, 20));
  }
  assert(freeze, "ACTUAL_NATIVE_STARTING_ORACLE_FREEZE_REQUIRED");
  assert.equal(freeze.oraclePins.find(pin => pin.path === "fixtures/evaluate.mjs")?.sha256, digest(original));
  assert.equal(digest(await readFile(fixture)), digest(original), "ORACLE_CHANGED_BEFORE_OWNED_ATTACK");
  await writeFile(fixture, mutant, { mode });
  changed = true;
  const childExit = await exit;
  const results = JSON.parse(await readFile(join(native, "results.json"), "utf8"));
  const custody = results.results.find((result: { id: string }) => result.id === "unchanged-source-and-runtime-custody");
  disposition = { schema: "finnor.x2.native-oracle-custody-regression.v1",
    expected: "ORACLE_CHANGED_DURING_NATIVE_PROOF", childExit, custody,
    originalDigest: digest(original), mutantDigest: digest(mutant),
    input: { surface: "api", configuredS8: false, inertEvaluatorComment: true },
    businessCases: results.results.filter((result: { id: string }) => result.id !== custody?.id),
    protectedQualification: false, sealedPositiveRun: false, wallMs: Date.now() - started };
  await writeFile(join(out, "result.json"), JSON.stringify(disposition, null, 2) + "\n", { mode: 0o600 });
  assert.equal(childExit.code, 1, "CHANGED_EXECUTABLE_ORACLE_MUST_NOT_EXIT_GREEN");
  assert.equal(custody?.status, "FAIL", "CHANGED_EXECUTABLE_ORACLE_MUST_FAIL_ENDING_CUSTODY");
  assert.equal(custody?.predicate, "ORACLE_CHANGED_DURING_NATIVE_PROOF");
  assert(results.results.some((result: { id: string; status: string }) =>
    result.id === "fresh-Work-model-composition-and-independent-business-outcome" && result.status === "PASS"),
  "CUSTODY_ATTACK_MUST_REACH_ACTUAL_BUSINESS_EVALUATION");
  console.log("PASS: actual native driver refuses a changed executable oracle");
} finally {
  if (!exited) { child.kill("SIGTERM"); await exit; }
  await writeFile(join(out, "private-native-driver.log"), Buffer.concat(chunks), { mode: 0o600 });
  if (changed) {
    assert.equal(digest(await readFile(fixture)), digest(mutant), "CONCURRENT_ORACLE_CHANGE_MUST_NOT_BE_OVERWRITTEN");
    await writeFile(fixture, original, { mode });
    assert.equal(digest(await readFile(fixture)), digest(original), "OWNED_ORACLE_RESTORATION_UNPASSED");
  }
  await writeFile(join(out, "restoration.json"), JSON.stringify({
    originalDigest: digest(original), endingDigest: digest(await readFile(fixture)),
    originalMode: mode, endingMode: (await stat(fixture)).mode & 0o777, restoredAfterChildExit: exited,
    ordinaryDevelopmentOnly: true,
  }, null, 2) + "\n", { mode: 0o600 });
}
