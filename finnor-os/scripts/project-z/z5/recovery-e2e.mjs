import { spawn } from "node:child_process";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { ROOT, hash, save, load, fixture, evidenceDirectory } from "./e2e-tools.mjs";
const output = await evidenceDirectory(process.argv[2]), file = path.join(output, "journal.json"),
  worker = path.join(ROOT, "finnor-os/scripts/project-z/z5/journal-worker.mjs");
const f = await fixture("F30-01"), id = randomUUID(), deadline = new Date(Date.now() + 240000).toISOString();
const binding = { tenant: "OFFLINE_ONLY", principal: "NO_AUTHENTICATED_ROLE", work: id, input: f.id, root: "LOCAL_FILE_ONLY",
  inputDigest: hash(JSON.stringify(f.input)), sourceDigest: hash(await readFile(worker)), rightsRevision: "NO_NATIVE_RIGHTS",
  liveDigest: hash(JSON.stringify(f.input.live)), ownerCutDigest: "NO_NATIVE_OWNER_CUT", profile: "PRE_CODE_PUBLIC_FIXED_KERNEL",
  mandate: "NO_NATIVE_MANDATE", assignment: "NO_FINANCIAL_ASSIGNMENT", parentReservation: "UNCHANGED_LOCAL_FILE_RESERVATION",
  preparation: "LOCAL_FILE_PREPARATION", policy: "LOCAL_FILE_POLICY", allocation: "LOCAL_FILE_ACCOUNTING_ONLY",
  consumption: "LOCAL_FILE_CONSUMPTION", unresolvedObligations: ["LOCAL_FILE_OLD_CALLBACK"], originalDeadline: deadline };
await save(file, { schema: "finnor.z5.LOCAL_FILE.crash-journal.v1", runId: id,
  original: { binding, input: f.input, maxAttempts: 4, capacity: 12 }, binding,
  attempts: 0, spent: 0, fence: 0, token: null, cancelled: false, status: "QUEUED",
  certificate: null, selected: null, events: [] });
const rows = [], owned = new Set(), firstTokens = [];
function physical(stopAt = "", mode = "", token = "") {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--max-old-space-size=512", worker, file, stopAt, mode, token],
      { cwd: ROOT, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    owned.add(child);
    let stdout = "", stderr = "", physicallyKilled = false, reachedBoundary = false, timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 45000);
    child.stdout.on("data", bytes => {
      stdout += bytes;
      if (stopAt && stdout.includes('"stage":"' + stopAt + '"')) {
        const message = JSON.parse(stdout.trim().split("\n").at(-1));
        if (message.pid !== child.pid) throw Error("UNOWNED_PROCESS_INTERRUPT_ATTEMPT");
        reachedBoundary = true; firstTokens.push(message.token); physicallyKilled = child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", bytes => { stderr += bytes; });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout); owned.delete(child); resolve({ stopAt, mode, pid: child.pid, exitCode, signal, stdout, stderr, physicallyKilled, reachedBoundary, timedOut });
    });
  });
}
try {
  for (const point of ["AFTER_CLAIM", "AFTER_CERTIFICATE", "AFTER_REPLACEMENT"]) {
    const result = await physical(point), journal = await load(file);
    const passed = result.exitCode === null && result.signal === "SIGKILL" && result.physicallyKilled && result.reachedBoundary && !result.timedOut
      && journal.original.binding.originalDeadline === deadline && journal.spent === journal.attempts
      && JSON.stringify(journal.original.binding.unresolvedObligations) === JSON.stringify(binding.unresolvedObligations)
      && journal.binding.parentReservation === binding.parentReservation
      && (point !== "AFTER_REPLACEMENT" || journal.selected.callbackStillUnknown === true);
    const row = { point, passed, result, durableJournalDigest: hash(await readFile(file)),
      attempts: journal.attempts, spent: journal.spent, fence: journal.fence };
    rows.push(row); await save(path.join(output, point + ".json"), row);
    if (!passed) throw Error("PHYSICAL_LOCAL_FILE_INTERRUPTION_FAILED");
  }
  const recovered = await physical(), state = await load(file);
  rows.push({ point: "SAME_ID_RESTART_AND_ACK", passed: recovered.exitCode === 0 && state.status === "COMPLETE"
    && state.fence === 4 && state.attempts === 4 && state.spent === 4 && state.selected.callbackStillUnknown === true, result: recovered });
  const before = hash(await readFile(file)), stale = await physical("", "stale", firstTokens[0]);
  rows.push({ point: "OLD_FENCE_PERSISTENCE_REFUSED", passed: stale.exitCode === 3 && before === hash(await readFile(file)), result: stale });
  const exhausted = await physical("", "exhausted"), exhaustedState = await load(file);
  rows.push({ point: "DURABLE_ORIGINAL_EXHAUSTION", passed: exhausted.exitCode === 3 && exhaustedState.exhausted === true
    && exhaustedState.spent === 4 && exhaustedState.attempts === 4, result: exhausted });
  const callback = await physical("", "callback"), final = await load(file);
  rows.push({ point: "DELAYED_CALLBACK_AFTER_REPLACEMENT", passed: callback.exitCode === 0 && final.staleAfterCallback === true
    && final.selected.callbackStillUnknown === true && final.binding.parentReservation === binding.parentReservation
    && final.original.capacity === 12 && final.spent === 4 && final.original.binding.unresolvedObligations.length === 1, result: callback });
  const report = { schema: "finnor.z5.LOCAL_FILE.physical-recovery.v1", state: rows.every(r => r.passed) ? "PASSED" : "FAILED",
    workerSha256: hash(await readFile(worker)), rows, originalRunId: id, originalDeadline: deadline,
    nativeQueueRecovery: "NOT_RUN", physicalKills: rows.filter(r => r.result?.signal === "SIGKILL").length,
    databaseActions: 0, listeners: 0, financialCosts: null, humanCost: null,
    materialGap: "LOCAL_FILE_JOURNAL_AND_SHARED_FENCE_PREDICATES_NOT_NATIVE_OWNER_AUTH_OR_S5_RECOVERY",
    protectedAdmission: false };
  await save(path.join(output, "report.json"), report); console.log(JSON.stringify(report));
  process.exitCode = report.state === "PASSED" ? 0 : 1;
} finally { for (const child of owned) child.kill("SIGKILL"); }
