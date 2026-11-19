/** Preregistered OS-level controls, authored before the reusable runner repair. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { superviseOwnedCampaign } from "./owned-campaign-supervisor.mts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const args = process.argv.slice(2);
assert(args.length === 2 && args[0] === "--output" && args[1]?.startsWith("/"), "NEW_ABSOLUTE_OUTPUT_REQUIRED");
const output = args[1]!, started = performance.now();
await mkdir(output, { mode: 0o700 });
const body = fileURLToPath(new URL("./fixtures/supervision-control-body.mts", import.meta.url));
const results: Array<{ id: string; status: string; observed?: unknown; failure?: string }> = [];
const sources = await Promise.all([
  fileURLToPath(import.meta.url), body,
  fileURLToPath(new URL("./owned-campaign-supervisor.mts", import.meta.url)),
].map(async path => ({ path, sha256: createHash("sha256").update(await readFile(path)).digest("hex") })));
const limits = { normalBodyMilliseconds: 4000, hungBodyMilliseconds: 1000, cleanupMilliseconds: 3000,
  childHeapMiB: 64, maximumObservedChildMemoryBytes: 256 * 1024 ** 2, wholeControlSeconds: 45 };
const save = () => writeFile(join(output, "report.json"), JSON.stringify({
  schema: "finnor.w2.supervision-controls.v1", status: results.some(r => r.status === "FAIL") ? "FAIL" : "PASS",
  qualification: "ACTUAL_OS_PROCESS_FILESYSTEM_CONTROLS_NOT_NATIVE_DATABASE_OR_BROWSER_W2",
  host: { platform: process.platform, architecture: process.arch, node: process.version }, limits, sources, results,
  elapsedMilliseconds: performance.now() - started,
  rerun: ["node", "--max-old-space-size=128", "--experimental-strip-types",
    "finnor-os/scripts/postz-w2/run-supervision-controls.mts", "--output", "<new-absolute-output>"],
}, null, 2) + "\n", { mode: 0o600 });
await writeFile(join(output, "frozen-controls.json"), JSON.stringify({ limits, sources,
  originalCampaignsUnchanged: { nativeBoundSeconds: 1200, nativeRecoverySeconds: 900, initialDiskGiB: 3 } }, null, 2) + "\n",
{ mode: 0o600 });
const run = (mode: string, path = join(output, mode), milliseconds = limits.normalBodyMilliseconds, extra: Record<string, string> = {}) =>
  superviseOwnedCampaign({ root, body, output: path, bodyMilliseconds: milliseconds,
    cleanupMilliseconds: limits.cleanupMilliseconds, receiptName: "report.json",
    postgresRelativeDirectory: "owned-runtime/database",
    nodeArguments: ["--max-old-space-size=64", "--experimental-strip-types"],
    maximumProcessMemoryBytes: limits.maximumObservedChildMemoryBytes,
    environment: { FINNOR_W2_CONTROL_MODE: mode, ...extra } });
const check = async (id: string, action: () => Promise<unknown>) => {
  try {
    assert(performance.now() - started < limits.wholeControlSeconds * 1000, "WHOLE_CONTROL_WALL");
    results.push({ id, status: "PASS", observed: await action() });
  } catch (error) { results.push({ id, status: "FAIL", failure: error instanceof Error ? error.message : "Unknown" }); }
  await save();
};
const existsProcess = (pid: number) => {
  try { process.kill(pid, 0); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error }
};
const waitForChild = async (path: string) => {
  const end = performance.now() + 2500;
  while (performance.now() < end) {
    try { return JSON.parse(await readFile(join(path, "child.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error("CONTROL_CHILD_START_DEADLINE");
};
const neighbor = spawn(process.execPath, ["--max-old-space-size=64", "-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
assert(neighbor.pid);
try {
  await check("positive-owned-process-and-cleanup", async () => {
    const report = await run("pass"); assert.equal(report.status, "PASS");
    assert.equal(report.supervision.cleanupStatus, "PASS"); return report.supervision;
  });
  await check("hung-startup-is-externally-finite", async () => {
    const report = await run("hang", undefined, limits.hungBodyMilliseconds);
    assert.equal(report.status, "FAIL"); assert.equal(report.supervision.timedOut, true);
    assert.equal(report.supervision.ownedProcessGroupStopped, true); return report.supervision;
  });
  for (const mode of ["closer-throw", "closer-hang"]) await check(mode, async () => {
    const report = await run(mode); assert.equal(report.status, "FAIL");
    assert.equal((report.cleanup as any).steps.find((row: any) => row.name === "challenged").status, "FAIL");
    assert.equal((report.cleanup as any).steps.find((row: any) => row.name === "last").status, "PASS");
    assert((await readFile(join(output, mode, "last-closer.json"), "utf8")).includes("attempted"));
    assert(!JSON.stringify(report).includes("CONTROL_PRIVATE_DETAIL_NOT_FOR_REPORT")); return report;
  });
  for (const mode of ["missing-receipt", "nonzero"]) await check(mode, async () => {
    const report = await run(mode); assert.equal(report.status, "FAIL"); return report.supervision;
  });
  await check("leaked-owned-group-fails-and-stops-not-neighbor", async () => {
    const report = await run("leak"); assert.equal(report.status, "FAIL");
    assert.equal(report.supervision.unexpectedProcessGroup, true);
    assert.equal(report.supervision.ownedProcessGroupStopped, true);
    assert(existsProcess(neighbor.pid!)); return report.supervision;
  });
  await check("atomic-same-output-loser-does-not-touch-winner", async () => {
    const path = join(output, "collision"), winning = run("collision", path);
    const child = await waitForChild(path);
    const before = await readFile(join(path, ".owner.json"), "utf8");
    const loser = await run("collision", path);
    assert.equal(loser.status, "FAIL"); assert.equal(loser.supervision.stopReason, "OUTPUT_ALREADY_CLAIMED");
    assert.equal(loser.supervision.childSpawned, false); assert.equal(loser.supervision.artifactWritten, false);
    assert.equal(await readFile(join(path, ".owner.json"), "utf8"), before); assert(existsProcess(child.pid));
    await writeFile(join(path, "release"), "owned-control-release\n", { mode: 0o600 });
    const winner = await winning; assert.equal(winner.status, "PASS");
    return { loser: loser.supervision, winner: winner.supervision };
  });
  await check("direct-body-refuses-without-output-write", async () => {
    const path = join(output, "direct-must-not-exist");
    const child = spawn(process.execPath, ["--max-old-space-size=64", "--experimental-strip-types", body, "--output", path],
      { env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdio: "ignore" });
    const exit = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    assert.notEqual(exit, 0);
    await assert.rejects(readFile(join(path, ".owner.json")), (error: any) => error.code === "ENOENT");
    return { exit, outputWritten: false };
  });
  await check("changed-claim-refuses-further-artifacts", async () => {
    const report = await run("claim-tamper");
    assert.equal(report.status, "FAIL"); assert.equal(report.supervision.ownedOutputClaim, false);
    assert.equal(report.supervision.artifactWritten, false); return report.supervision;
  });
  await check("actual-parent-signal-is-finite", async () => {
    const path = join(output, "interrupt"), result = run("interrupt", path);
    await waitForChild(path); process.kill(process.pid, "SIGTERM");
    const report = await result; assert.equal(report.status, "FAIL");
    assert.equal(report.supervision.stopReason, "INTERRUPTED_SIGTERM");
    assert.equal(report.supervision.ownedProcessGroupStopped, true); return report.supervision;
  });
  await check("nonpostgres-neighbor-pid-is-never-cleaned", async () => {
    const report = await run("database-identity-mismatch", undefined, limits.normalBodyMilliseconds,
      { FINNOR_W2_CONTROL_NEIGHBOR_PID: String(neighbor.pid) });
    assert.equal(report.status, "FAIL"); assert.equal(report.supervision.postgresStopped, false);
    assert(existsProcess(neighbor.pid!)); return report.supervision;
  });
} finally {
  if (neighbor.exitCode === null && neighbor.signalCode === null) {
    const closed = new Promise<void>(resolve => neighbor.once("exit", () => resolve()));
    neighbor.kill("SIGKILL"); await closed;
  }
  for (const source of sources)
    assert.equal(createHash("sha256").update(await readFile(source.path)).digest("hex"), source.sha256, "CONTROL_SOURCE_CHANGED");
  await save();
}
console.log(JSON.stringify({ status: results.every(r => r.status === "PASS") ? "PASS" : "FAIL",
  cases: results.length, failures: results.filter(r => r.status === "FAIL"), evidence: join(output, "report.json") }));
process.exit(results.every(r => r.status === "PASS") && results.length === 12 ? 0 : 1);
