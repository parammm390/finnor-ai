import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const bodyMilliseconds = 180000;
const cleanupMilliseconds = 10000;

function processCommand(pid: number) {
  try {
    return execFileSync("ps", ["-ww", "-p", String(pid), "-o", "command="],
      { encoding: "utf8", timeout: 1000 }).trim();
  } catch (failure) {
    const error = failure as Error & { status?: number; signal?: string };
    if (error.status === 1 && !error.signal) return "";
    throw error;
  }
}

type Observation = { exitCode: number | null; signal: NodeJS.Signals | null; error: string | null; bodyElapsedMilliseconds: number };
type ParticipantReport = { status: "PASS" | "FAIL"; cases?: unknown[]; supervision: Record<string, unknown>; [key: string]: unknown };

function assertOutputClaim(output: string, body: string, token: string | undefined, ownerPid: number) {
  assert(token && /^[a-f0-9]{64}$/.test(token) && ownerPid > 1, "OWNED_OUTPUT_CLAIM_REQUIRED");
  const directory = lstatSync(output, { bigint: true });
  const claim = JSON.parse(readFileSync(join(output, ".owner.json"), "utf8"));
  assert(directory.isDirectory() && !directory.isSymbolicLink() &&
    claim.schema === "finnor.w2.participant-output-owner.v1" && claim.token === token &&
    claim.ownerPid === ownerPid && claim.output === resolve(output) && claim.body === body &&
    claim.device === String(directory.dev) && claim.inode === String(directory.ino), "OWNED_OUTPUT_CLAIM_REQUIRED");
}

export function assertParticipantBodyOutput(output: string, body: string) {
  assert(Number(process.env.FINNOR_W2_PARTICIPANT_OWNER_PID) === process.ppid, "OWNED_PARENT_IDENTITY_REQUIRED");
  assertOutputClaim(output, body, process.env.FINNOR_W2_PARTICIPANT_OWNER_TOKEN, process.ppid);
}

export async function superviseParticipantAuthority({ root, body, output }: { root: string; body: string; output: string }): Promise<ParticipantReport> {
  assert(isAbsolute(output), "NEW_ABSOLUTE_OUTPUT_REQUIRED");
  const started = performance.now();
  try { mkdirSync(output, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return { status: "FAIL", supervision: { stopReason: "OUTPUT_ALREADY_CLAIMED", ownerClaimCreated: false,
      childSpawned: false, artifactWritten: false, deadlineMilliseconds: bodyMilliseconds } };
  }
  const directory = lstatSync(output, { bigint: true }), token = randomBytes(32).toString("hex");
  writeFileSync(join(output, ".owner.json"), JSON.stringify({ schema: "finnor.w2.participant-output-owner.v1",
    ownerPid: process.pid, token, output: resolve(output), body, device: String(directory.dev), inode: String(directory.ino) }) + "\n",
  { flag: "wx", mode: 0o600 });
  let ownedOutputClaim = true;
  const requireClaim = () => {
    assert(ownedOutputClaim, "OWNED_OUTPUT_CLAIM_LOST");
    try { assertOutputClaim(output, body, token, process.pid); }
    catch (error) { ownedOutputClaim = false; throw error; }
  };
  requireClaim();
  const command = [process.execPath, "--import=tsx", body, "--output", output];
  const environment = Object.fromEntries(["PATH", "HOME", "LANG", "TMPDIR", "NODE_OPTIONS"]
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  environment.FINNOR_W2_PARTICIPANT_OWNER_TOKEN = token;
  environment.FINNOR_W2_PARTICIPANT_OWNER_PID = String(process.pid);
  const child = spawn(command[0]!, command.slice(1), {
    cwd: join(root, "finnor-os"), env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let stopReason: string | null = null, timedOut = false, logBytes = 0;
  const log: Buffer[] = [], cleanupErrors: string[] = [];
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); }
    catch (failure) {
      const error = failure as NodeJS.ErrnoException;
      if (error.code !== "ESRCH") cleanupErrors.push(error.code ?? error.name);
    }
  };
  const observed = await new Promise<Observation>(resolve => {
    let completed = false;
    let hardKill: ReturnType<typeof setTimeout> | undefined, finalWait: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const interrupt = (signal: string) => stop("INTERRUPTED_" + signal);
    const finish = (result: Omit<Observation, "bodyElapsedMilliseconds">) => {
      if (completed) return;
      completed = true;
      for (const timer of [deadline, hardKill, finalWait]) clearTimeout(timer);
      process.removeListener("SIGTERM", onTerm); process.removeListener("SIGINT", onInt);
      resolve({ ...result, bodyElapsedMilliseconds: performance.now() - started });
    };
    const stop = (reason: string) => {
      if (completed || stopReason) return;
      stopReason = reason; timedOut = reason === "WHOLE_BODY_DEADLINE";
      signalGroup("SIGTERM");
      hardKill = setTimeout(() => signalGroup("SIGKILL"), 500);
      finalWait = setTimeout(() => finish({ exitCode: null, signal: null,
        error: "OWNED_CHILD_DID_NOT_EXIT" }), 2000);
    };
    const capture = (chunk: Buffer) => {
      logBytes += chunk.length;
      if (logBytes <= 2 * 1024 ** 2) log.push(chunk);
      else stop("OWNED_CHILD_LOG_LIMIT");
    };
    const onTerm = () => interrupt("SIGTERM"), onInt = () => interrupt("SIGINT");
    child.stdout.on("data", capture); child.stderr.on("data", capture);
    child.once("error", error => finish({ exitCode: null, signal: null, error: (error as NodeJS.ErrnoException).code ?? error.name }));
    child.once("close", (exitCode, signal) => finish({ exitCode, signal, error: null }));
    process.once("SIGTERM", onTerm); process.once("SIGINT", onInt);
    deadline = setTimeout(() => stop("WHOLE_BODY_DEADLINE"), Math.max(0, bodyMilliseconds - (performance.now() - started)));
  });
  const cleanupStarted = performance.now();
  let unexpectedPostgres = false, postgresStopped = false, ownedProcessGroupStopped = false;
  try {
    if (stopReason) {
      signalGroup("SIGKILL");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (child.pid && processCommand(child.pid)) {
      signalGroup("SIGKILL");
      assert(!processCommand(child.pid), "OWNED_CHILD_STILL_LIVE");
    }
    requireClaim();
    const directory = join(output, "owned-postgres"), pidfile = join(directory, "postmaster.pid");
    if (existsSync(pidfile)) {
      const [pidText, recordedDirectory] = readFileSync(pidfile, "utf8").split("\n");
      const pid = Number(pidText);
      assert(Number.isInteger(pid) && pid > 1 && recordedDirectory === directory, "OWNED_DATABASE_IDENTITY_CHANGED");
      let identity = processCommand(pid);
      if (identity) {
        assert(identity.includes(join(root, "finnor-os/node_modules/@embedded-postgres/"))
          && identity.includes("-D " + directory + " -p "), "OWNED_DATABASE_PROCESS_IDENTITY_CHANGED");
        unexpectedPostgres = !stopReason;
        requireClaim();
        process.kill(pid, "SIGTERM");
        const until = performance.now() + 7000;
        while (identity && performance.now() < until) {
          await new Promise(resolve => setTimeout(resolve, 50));
          identity = processCommand(pid);
        }
        if (identity) {
          assert(identity.includes("-D " + directory + " -p "), "OWNED_DATABASE_PROCESS_IDENTITY_CHANGED");
          requireClaim();
          process.kill(pid, "SIGKILL");
          await new Promise(resolve => setTimeout(resolve, 100));
          identity = processCommand(pid);
        }
        assert(!identity, "OWNED_DATABASE_STILL_LIVE");
      }
    }
    postgresStopped = true;
  } catch (error) { cleanupErrors.push((error as Error).message); }
  try {
    if (child.pid) {
      try { process.kill(-child.pid, 0); }
      catch (failure) {
        if ((failure as NodeJS.ErrnoException).code === "ESRCH") ownedProcessGroupStopped = true;
        else throw failure;
      }
      assert(ownedProcessGroupStopped, "OWNED_PROCESS_GROUP_STILL_LIVE");
    } else ownedProcessGroupStopped = true;
  } catch (error) { cleanupErrors.push((error as Error).message); }
  if (performance.now() - cleanupStarted >= cleanupMilliseconds) cleanupErrors.push("OWNED_CLEANUP_DEADLINE");
  child.stdout.destroy(); child.stderr.destroy(); child.unref();
  let bodyReport: { status?: string; cases?: unknown[]; [key: string]: unknown } = {}, receiptFailure: string | null = null;
  try { requireClaim(); bodyReport = JSON.parse(readFileSync(join(output, "receipt.json"), "utf8")); }
  catch { receiptFailure = "BODY_RECEIPT_MISSING_OR_INVALID"; }
  const elapsedMilliseconds = performance.now() - started;
  const pass = !stopReason && observed.exitCode === 0 && !observed.error && bodyReport.status === "PASS"
    && observed.bodyElapsedMilliseconds < bodyMilliseconds && cleanupErrors.length === 0 && !unexpectedPostgres && !receiptFailure && ownedOutputClaim;
  const report: ParticipantReport = { ...bodyReport, status: pass ? "PASS" : "FAIL",
    supervision: { command, deadlineMilliseconds: bodyMilliseconds, timedOut, stopReason,
      ...observed, elapsedMilliseconds, cleanupMilliseconds, postgresStopped, ownedProcessGroupStopped, unexpectedPostgres, receiptFailure,
      ownerClaimCreated: true, ownedOutputClaim, childSpawned: Boolean(child.pid), artifactWritten: false,
      cleanupStatus: cleanupErrors.length === 0 ? "PASS" : "FAIL", cleanupErrors } };
  try {
    requireClaim(); writeFileSync(join(output, "supervised-child.log"), Buffer.concat(log), { mode: 0o600 });
    requireClaim(); report.supervision.artifactWritten = true;
    writeFileSync(join(output, "receipt.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  } catch (error) {
    report.status = "FAIL"; report.supervision.ownedOutputClaim = ownedOutputClaim;
    report.supervision.artifactWritten = false; report.supervision.artifactFailure = (error as Error).name;
  }
  return report;
}
