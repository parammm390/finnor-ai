/** Shared finite runner, generalized from the reviewed W2 participant supervisor.
 * Output ownership is acquired before spawn. Existing-output losers do nothing
 * else. A body verdict never substitutes for process/database cleanup. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const claimSchema = "finnor.w2.owned-campaign-output.v1";
const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const safeFailure = (error: unknown) => {
  const value = error as NodeJS.ErrnoException | undefined;
  const name = typeof value?.name === "string" && /^[A-Za-z]{1,80}$/.test(value.name) ? value.name : "Unknown";
  return { errorType: name, ...(typeof value?.code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(value.code)
    ? { code: value.code } : {}) };
};
function assertClaim(output: string, body: string, token: string | undefined, ownerPid: number) {
  assert(token && /^[a-f0-9]{64}$/.test(token) && Number.isInteger(ownerPid) && ownerPid > 1, "OWNED_OUTPUT_CLAIM_REQUIRED");
  const directory = lstatSync(output, { bigint: true }), claimFile = join(output, ".owner.json");
  assert(directory.isDirectory() && !directory.isSymbolicLink(), "OWNED_OUTPUT_DIRECTORY_REQUIRED");
  const file = lstatSync(claimFile);
  assert(file.isFile() && !file.isSymbolicLink() && (file.mode & 0o777) === 0o600, "OWNED_OUTPUT_CLAIM_REQUIRED");
  const claim = JSON.parse(readFileSync(claimFile, "utf8"));
  assert(claim.schema === claimSchema && claim.token === token && claim.ownerPid === ownerPid
    && claim.output === resolve(output) && claim.body === resolve(body)
    && claim.device === String(directory.dev) && claim.inode === String(directory.ino), "OWNED_OUTPUT_CLAIM_REQUIRED");
}
export function ownedCampaignBody(body: string) {
  const args = process.argv.slice(2);
  assert(args.length === 2 && args[0] === "--output" && isAbsolute(args[1]!), "NEW_ABSOLUTE_OUTPUT_REQUIRED");
  const output = resolve(args[1]!);
  const requireClaim = () => {
    assert(Number(process.env.FINNOR_W2_SUPERVISOR_OWNER_PID) === process.ppid, "OWNED_PARENT_IDENTITY_REQUIRED");
    assertClaim(output, body, process.env.FINNOR_W2_SUPERVISOR_OWNER_TOKEN, process.ppid);
  };
  requireClaim();
  return { output, requireClaim };
}
export interface OwnedCleanup {
  status: "PASS" | "FAIL";
  steps: Array<{ name: string; status: "PASS" | "FAIL"; elapsedMilliseconds: number; errorType?: string; code?: string }>;
}
export async function runOwnedClosers(closers: ReadonlyArray<readonly [string, () => unknown]>, milliseconds = 10000): Promise<OwnedCleanup> {
  assert(Number.isSafeInteger(milliseconds) && milliseconds > 0 && milliseconds <= 10000, "FINITE_OWNED_CLOSER_BOUND_REQUIRED");
  const steps: OwnedCleanup["steps"] = [];
  for (const [name, close] of closers) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = performance.now();
    try {
      await Promise.race([Promise.resolve().then(close), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(Error("OWNED_CLOSER_TIMEOUT"), { code: "OWNED_CLOSER_TIMEOUT" })), milliseconds);
      })]);
      steps.push({ name, status: "PASS", elapsedMilliseconds: performance.now() - started });
    } catch (error) { steps.push({ name, status: "FAIL", elapsedMilliseconds: performance.now() - started, ...safeFailure(error) }); }
    finally { clearTimeout(timer); }
  }
  return { status: steps.every(step => step.status === "PASS") ? "PASS" : "FAIL", steps };
}
type ProcessRow = { pid: number; parent: number; group: number; residentBytes: number; command: string };
function processes(): ProcessRow[] {
  return execFileSync("ps", ["-ww", "-axo", "pid=,ppid=,pgid=,rss=,command="], { encoding: "utf8", timeout: 1000 })
    .split("\n").flatMap(line => {
      const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      return row ? [{ pid: Number(row[1]), parent: Number(row[2]), group: Number(row[3]),
        residentBytes: Number(row[4]) * 1024, command: row[5]! }] : [];
    });
}
const redactedLog = (value: Buffer) => value.toString("utf8")
  .replace(/\bpostgres(?:ql)?:\/\/[^@\s]+@/g, "postgres://<redacted>@")
  .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, "Bearer <redacted>");
export interface OwnedCampaignReport {
  status: "PASS" | "FAIL"; supervision: Record<string, unknown>; [key: string]: unknown;
}
export interface OwnedCampaignOptions {
  root: string; body: string; output: string; bodyMilliseconds: number;
  cleanupMilliseconds?: number; receiptName?: string; postgresRelativeDirectory?: string;
  nodeArguments?: string[]; environment?: Record<string, string>; maximumProcessMemoryBytes?: number;
}
export async function superviseOwnedCampaign(options: OwnedCampaignOptions): Promise<OwnedCampaignReport> {
  const { root, body, bodyMilliseconds } = options, output = resolve(options.output);
  const cleanupMilliseconds = options.cleanupMilliseconds ?? 10000, receiptName = options.receiptName ?? "report.json";
  assert(isAbsolute(options.output) && isAbsolute(root) && isAbsolute(body), "ABSOLUTE_OWNED_CAMPAIGN_PATHS_REQUIRED");
  assert(Number.isSafeInteger(bodyMilliseconds) && bodyMilliseconds > 0, "FINITE_ORIGINAL_BODY_WALL_REQUIRED");
  assert(Number.isSafeInteger(cleanupMilliseconds) && cleanupMilliseconds > 0 && cleanupMilliseconds <= 10000,
    "FINITE_OWNED_CLEANUP_BOUND_REQUIRED");
  assert(/^[a-z][a-z0-9-]*\.json$/.test(receiptName), "OWNED_RECEIPT_BASENAME_REQUIRED");
  const relativeDatabase = options.postgresRelativeDirectory ?? "owned-runtime/database";
  assert(relativeDatabase.split("/").every(part => /^[a-z][a-z0-9-]*$/.test(part)), "EXACT_OWNED_DATABASE_DIRECTORY_REQUIRED");
  const started = performance.now();
  try { mkdirSync(output, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return { status: "FAIL", supervision: { stopReason: "OUTPUT_ALREADY_CLAIMED", ownerClaimCreated: false,
      childSpawned: false, artifactWritten: false, deadlineMilliseconds: bodyMilliseconds } };
  }
  const directory = lstatSync(output, { bigint: true }), token = randomBytes(32).toString("hex");
  writeFileSync(join(output, ".owner.json"), JSON.stringify({ schema: claimSchema, ownerPid: process.pid, token,
    output, body: resolve(body), device: String(directory.dev), inode: String(directory.ino) }) + "\n",
  { flag: "wx", mode: 0o600 });
  let ownedOutputClaim = true;
  const requireClaim = () => {
    assert(ownedOutputClaim, "OWNED_OUTPUT_CLAIM_LOST");
    try { assertClaim(output, body, token, process.pid); }
    catch (error) { ownedOutputClaim = false; throw error }
  };
  requireClaim();
  const command = [process.execPath, ...(options.nodeArguments ?? ["--max-old-space-size=1536", "--import=tsx"]), body, "--output", output];
  const environment: NodeJS.ProcessEnv = Object.fromEntries(["PATH", "HOME", "LANG", "TMPDIR", "NODE_OPTIONS"]
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  Object.assign(environment, options.environment, { FINNOR_W2_SUPERVISOR_OWNER_TOKEN: token,
    FINNOR_W2_SUPERVISOR_OWNER_PID: String(process.pid), FINNOR_W2_SUPERVISOR_WALL_MS: String(bodyMilliseconds) });
  const child = spawn(command[0]!, command.slice(1), { cwd: join(root, "finnor-os"), env: environment,
    detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let stopReason: string | null = null, timedOut = false, logBytes = 0;
  let peakProcessMemoryBytes: number | null = null, processMemorySamples = 0;
  let processSampleFailure = false;
  const log: Buffer[] = [], cleanupErrors: string[] = [];
  const groupRows = () => child.pid ? processes().filter(row => row.group === child.pid) : [];
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      const rows = groupRows(), leader = rows.find(row => row.pid === child.pid);
      if (leader) assert(leader.parent === process.pid && leader.command.includes(body), "OWNED_CHILD_PROCESS_IDENTITY_CHANGED");
      if (rows.length) process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH")
        cleanupErrors.push((error as Error).name === "AssertionError" ? "OWNED_CHILD_PROCESS_IDENTITY_CHANGED" : "OWNED_GROUP_SIGNAL_FAILED");
    }
  };
  const observed = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null;
    error: string | null; bodyElapsedMilliseconds: number }>(finishPromise => {
    let complete = false;
    let deadline: ReturnType<typeof setTimeout> | undefined, kill: ReturnType<typeof setTimeout> | undefined;
    let finalWait: ReturnType<typeof setTimeout> | undefined, sampling: ReturnType<typeof setInterval> | undefined;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, error: string | null) => {
      if (complete) return;
      complete = true;
      for (const timer of [deadline, kill, finalWait]) clearTimeout(timer);
      clearInterval(sampling); process.removeListener("SIGTERM", onTerm); process.removeListener("SIGINT", onInt);
      finishPromise({ exitCode, signal, error, bodyElapsedMilliseconds: performance.now() - started });
    };
    const stop = (reason: string) => {
      if (complete || stopReason) return;
      stopReason = reason; timedOut = reason === "WHOLE_BODY_DEADLINE";
      signalGroup("SIGCONT"); signalGroup("SIGTERM");
      kill = setTimeout(() => signalGroup("SIGKILL"), 500);
      finalWait = setTimeout(() => finish(null, null, "OWNED_CHILD_DID_NOT_EXIT"), 2000);
    };
    const capture = (chunk: Buffer) => {
      logBytes += chunk.length;
      if (logBytes <= 2 * 1024 ** 2) log.push(chunk);
      else stop("OWNED_CHILD_LOG_LIMIT");
    };
    const onTerm = () => stop("INTERRUPTED_SIGTERM"), onInt = () => stop("INTERRUPTED_SIGINT");
    child.stdout.on("data", capture); child.stderr.on("data", capture);
    child.once("error", error => finish(null, null, safeFailure(error).code ?? error.name));
    // Exit, not close: descendants retaining a pipe must not mask a leaked group.
    child.once("exit", (code, signal) => finish(code, signal, null));
    process.once("SIGTERM", onTerm); process.once("SIGINT", onInt);
    const sample = () => {
      try {
        const bytes = groupRows().reduce((sum, row) => sum + row.residentBytes, 0);
        processMemorySamples++;
        peakProcessMemoryBytes = Math.max(peakProcessMemoryBytes ?? 0, bytes);
        if (bytes > options.maximumProcessMemoryBytes!) stop("OWNED_PROCESS_MEMORY_LIMIT");
      } catch { processSampleFailure = true; stop("OWNED_PROCESS_OBSERVATION_FAILED") }
    };
    if (options.maximumProcessMemoryBytes !== undefined) {
      child.once("spawn", sample);
      sampling = setInterval(sample, 250);
    }
    deadline = setTimeout(() => stop("WHOLE_BODY_DEADLINE"), Math.max(0, bodyMilliseconds - (performance.now() - started)));
  });
  const cleanupStarted = performance.now(), cleanupUntil = cleanupStarted + cleanupMilliseconds;
  let unexpectedProcessGroup = false, unexpectedPostgres = false, ownedProcessGroupStopped = false, postgresStopped = false;
  try {
    let rows = groupRows();
    if (rows.length) {
      unexpectedProcessGroup = !stopReason;
      signalGroup("SIGCONT"); signalGroup("SIGTERM");
      const grace = Math.min(cleanupUntil, performance.now() + 500);
      while (rows.length && performance.now() < grace) { await pause(25); rows = groupRows() }
      if (rows.length) signalGroup("SIGKILL");
      while (rows.length && performance.now() < cleanupUntil) { await pause(25); rows = groupRows() }
    }
    assert(rows.length === 0, "OWNED_PROCESS_GROUP_STILL_LIVE");
    ownedProcessGroupStopped = true;
  } catch { cleanupErrors.push("OWNED_PROCESS_GROUP_CLEANUP_FAILED") }
  try {
    requireClaim();
    const database = join(output, relativeDatabase), pidfile = join(database, "postmaster.pid");
    if (existsSync(database)) assert(lstatSync(database).isDirectory() && !lstatSync(database).isSymbolicLink(), "OWNED_DATABASE_DIRECTORY_CHANGED");
    if (existsSync(pidfile)) {
      assert(lstatSync(pidfile).isFile() && !lstatSync(pidfile).isSymbolicLink(), "OWNED_DATABASE_PIDFILE_CHANGED");
      const [pidText, recordedDirectory, , portText] = readFileSync(pidfile, "utf8").split("\n"), pid = Number(pidText);
      assert(Number.isInteger(pid) && pid > 1 && recordedDirectory === database && /^\d+$/.test(portText ?? ""),
        "OWNED_DATABASE_IDENTITY_CHANGED");
      const identity = () => processes().find(row => row.pid === pid);
      const requireDatabaseIdentity = (row: ProcessRow) => {
        assert(row.command.includes("/@embedded-postgres/") && row.command.includes("/postgres -D " + database + " -p " + portText)
          && (row.command.endsWith(" -p " + portText) || row.command.includes(" -p " + portText + " ")),
        "OWNED_DATABASE_PROCESS_IDENTITY_CHANGED");
      };
      let row = identity();
      if (row) {
        requireDatabaseIdentity(row); unexpectedPostgres = !stopReason;
        requireClaim(); process.kill(pid, "SIGTERM");
        const grace = Math.min(cleanupUntil - 200, performance.now() + 7000);
        while (row && performance.now() < grace) { await pause(50); row = identity() }
        if (row) { requireDatabaseIdentity(row); requireClaim(); process.kill(pid, "SIGKILL") }
        while (row && performance.now() < cleanupUntil) { await pause(25); row = identity() }
        assert(!row, "OWNED_DATABASE_STILL_LIVE");
      }
    }
    postgresStopped = true;
  } catch { cleanupErrors.push("OWNED_DATABASE_IDENTITY_OR_CLEANUP_FAILED") }
  if (performance.now() >= cleanupUntil) cleanupErrors.push("OWNED_CLEANUP_DEADLINE");
  child.stdout.destroy(); child.stderr.destroy(); child.unref();
  let bodyReport: Record<string, unknown> = {}, receiptFailure: string | null = null;
  try {
    requireClaim();
    const path = join(output, receiptName), file = lstatSync(path);
    assert(file.isFile() && !file.isSymbolicLink() && file.size <= 64 * 1024 ** 2, "BOUNDED_REGULAR_BODY_RECEIPT_REQUIRED");
    bodyReport = JSON.parse(readFileSync(path, "utf8"));
    assert(bodyReport && typeof bodyReport === "object" && !Array.isArray(bodyReport), "BODY_RECEIPT_OBJECT_REQUIRED");
  } catch { receiptFailure = "BODY_RECEIPT_MISSING_OR_INVALID" }
  const pass = !stopReason && observed.exitCode === 0 && !observed.error && bodyReport.status === "PASS"
    && observed.bodyElapsedMilliseconds < bodyMilliseconds && cleanupErrors.length === 0 && !unexpectedProcessGroup
    && !unexpectedPostgres && !receiptFailure && ownedOutputClaim && !processSampleFailure;
  const report: OwnedCampaignReport = { ...bodyReport, status: pass ? "PASS" : "FAIL", supervision: {
    command, deadlineMilliseconds: bodyMilliseconds, cleanupMilliseconds, timedOut, stopReason, ...observed,
    elapsedMilliseconds: performance.now() - started, ownedProcessGroupStopped, postgresStopped,
    unexpectedProcessGroup, unexpectedPostgres, peakProcessMemoryBytes, processMemorySamples, processSampleFailure, receiptFailure,
    ownerClaimCreated: true, ownedOutputClaim, childSpawned: Boolean(child.pid), artifactWritten: false,
    cleanupStatus: cleanupErrors.length ? "FAIL" : "PASS", cleanupErrors,
    executedHost: { platform: process.platform, architecture: process.arch, node: process.version },
  } };
  try {
    requireClaim(); writeFileSync(join(output, "supervised-child.log"), redactedLog(Buffer.concat(log)), { mode: 0o600 });
    const path = join(output, receiptName);
    if (existsSync(path)) assert(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), "OWNED_REPORT_FILE_CHANGED");
    requireClaim(); report.supervision.artifactWritten = true;
    writeFileSync(path, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  } catch (error) {
    report.status = "FAIL"; report.supervision.ownedOutputClaim = ownedOutputClaim;
    report.supervision.artifactWritten = false; report.supervision.artifactFailure = safeFailure(error);
  }
  return report;
}
export async function launchOwnedW2Campaign(options: { root: string; body: string;
  evidenceBase: string; prefix: string; bodyMilliseconds: number }) {
  const args = process.argv.slice(2);
  assert(args.length === 0 || args.length === 2 && args[0] === "--output" && isAbsolute(args[1]!),
    "NEW_ABSOLUTE_OUTPUT_REQUIRED");
  if (!args.length) await mkdir(options.evidenceBase, { recursive: true, mode: 0o700 });
  const output = args[1] ?? join(options.evidenceBase, options.prefix + Date.now() + "-" + randomBytes(4).toString("hex"));
  const environment = Object.fromEntries(["FINNOR_W2_INSTALLATION", "FINNOR_W2_COORDINATION_LEDGER"]
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]!]));
  const report = await superviseOwnedCampaign({ ...options, output, environment,
    maximumProcessMemoryBytes: 6 * 1024 ** 3 });
  console.log(JSON.stringify({ status: report.status, evidence: report.supervision.artifactWritten ? output : null,
    passed: Array.isArray(report.results) ? report.results.filter(row => row?.status === "PASS").length : 0,
    supervision: report.supervision }));
  process.exit(report.status === "PASS" ? 0 : 1);
}
