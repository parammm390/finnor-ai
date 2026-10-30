/** LOCAL FILE crash protocol only. Never opens a DB, authenticates an owner or
 * touches a native allowance. The real native handler is separately delivered. */
import { readFile, writeFile, open, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { ROOT, hash, producer, checker } from "./e2e-tools.mjs";
import { assertCurrentScope, assertPhysicalFence } from "../../../packages/epistemic-runtime/src/project-z/z5-institution-linker/ownership.ts";
const [file, stopAt, mode, staleToken] = process.argv.slice(2);
if (!file || !path.isAbsolute(file) || !file.startsWith(path.join(ROOT, "scope-z/phase-evidence/z5/")))
  throw Error("LOCAL_FILE_OWNED_JOURNAL_REQUIRED");
let record = JSON.parse(await readFile(file, "utf8"));
if (record.schema !== "finnor.z5.LOCAL_FILE.crash-journal.v1") throw Error("NOT_AN_OWNED_OFFLINE_JOURNAL");
const original = JSON.stringify(record.original), started = performance.now(), cpu = process.cpuUsage();
const claim = { tenant: record.original.binding.tenant, token: randomUUID(), fence: record.fence + 1 };
const guard = () => {
  assertCurrentScope(record.original.binding, record.binding);
  assertPhysicalFence({ tenant: record.binding.tenant, token: record.token, fence: record.fence,
    cancelled: record.cancelled, status: record.status, deadline: Date.parse(record.original.binding.originalDeadline) }, claim);
};
async function persist(stage, enforce = true) {
  const disk = JSON.parse(await readFile(file, "utf8"));
  if (JSON.stringify(disk.original) !== original) throw Error("ORIGINAL_OFFLINE_SCOPE_CHANGED");
  if (enforce && (disk.token !== claim.token || disk.fence !== claim.fence)) throw Error("OFFLINE_OLD_FENCE_CANNOT_PERSIST");
  record.events.push({ stage, fence: record.fence, pid: process.pid, originalDeadline: record.original.binding.originalDeadline,
    originalReservation: record.original.binding.parentReservation, oldObligations: record.original.binding.unresolvedObligations,
    physicalCost: { wallMs: performance.now() - started, cpu: process.cpuUsage(cpu), money: null, human: null },
    unknownIfHardKilledAfterThisPoint: true });
  const pending = file + "." + process.pid + ".pending";
  await writeFile(pending, JSON.stringify(record) + "\n", { flag: "wx", mode: 0o600 });
  const handle = await open(pending, "r"); try { await handle.sync(); } finally { await handle.close(); }
  await rename(pending, file);
  const directory = await open(path.dirname(file), "r"); try { await directory.sync(); } finally { await directory.close(); }
}
async function boundary(stage) {
  if (stopAt !== stage) return;
  process.stdout.write(JSON.stringify({ stage, pid: process.pid, fence: record.fence, token: record.token }) + "\n");
  // Parent owns this child and physically SIGKILLs it after the fsynced boundary.
  await new Promise(() => { setInterval(() => {}, 1000); });
}
try {
  if (mode === "stale") {
    assertPhysicalFence({ tenant: record.binding.tenant, token: record.token, fence: record.fence,
      cancelled: record.cancelled, status: "RUNNING", deadline: Date.parse(record.original.binding.originalDeadline) },
    { tenant: record.binding.tenant, token: staleToken, fence: 1 });
    throw Error("STALE_FENCE_UNEXPECTEDLY_ACCEPTED");
  }
  if (mode === "callback") {
    if (!record.selected || !record.original.binding.unresolvedObligations.length) throw Error("NO_ORIGINAL_CALLBACK_LIABILITY");
    record.independentCallbackObserved = true;
    record.staleAfterCallback = true;
    record.status = "STALE_CALLBACK_REQUIRES_CURRENT_RECHECK";
    await persist("INDEPENDENT_LOCAL_FILE_CALLBACK_NOT_CAPITAL_RELEASE", false);
    process.stdout.write(JSON.stringify({ disposition: record.status, originalOldObligationsRetained: true }) + "\n");
    process.exit(0);
  }
  assertCurrentScope(record.original.binding, record.binding);
  if (record.attempts >= record.original.maxAttempts || record.spent >= record.original.capacity) {
    record.exhausted = true;
    await persist("ORIGINAL_OFFLINE_EPISODE_EXHAUSTED_NO_NEW_ALLOWANCE", false);
    process.stdout.write(JSON.stringify({ disposition: "INCOMPLETE", newAllowance: false }) + "\n");
    process.exit(3);
  }
  record.attempts++; record.spent++; record.fence = claim.fence; record.token = claim.token; record.status = "RUNNING";
  await persist("CLAIM_AND_CUMULATIVE_LOCAL_FILE_DEBIT", false);
  await boundary("AFTER_CLAIM"); guard();
  if (!record.certificate) {
    const p = await producer(record.original.input);
    if (p.exitCode !== 0) throw Error("PRODUCER_FAILED");
    const certificate = JSON.parse(p.stdout), c = await checker(record.original.input, certificate);
    if (c.exitCode !== 0 || JSON.parse(c.stdout).checked !== true || certificate.replacement?.status !== "BRIDGED")
      throw Error("INDEPENDENT_CHECK_OR_LIVE_BRIDGE_FAILED");
    record.certificate = certificate; record.certificateDigest = hash(JSON.stringify(certificate));
    record.originalCheck = JSON.parse(c.stdout);
    record.processReceipts = { producer: p, checker: c };
  } else {
    if (hash(JSON.stringify(record.certificate)) !== record.certificateDigest) throw Error("IMMUTABLE_CERTIFICATE_CHANGED");
    const c = await checker(record.original.input, record.certificate);
    if (c.exitCode !== 0) throw Error("RECOVERED_ORIGINAL_PROOF_FAILED");
  }
  guard(); await persist("IMMUTABLE_CERTIFICATE_AND_ORIGINAL_PROOF"); await boundary("AFTER_CERTIFICATE");
  record.selected = { component: record.certificate.replacement.component, revision: record.certificate.replacement.revision,
    bridge: record.certificate.replacement.bridge, originalReservation: record.original.binding.parentReservation,
    oldObligations: record.original.binding.unresolvedObligations, callbackStillUnknown: true };
  guard(); await persist("REPLACEMENT_SELECTED_OLD_CALLBACK_STILL_UNKNOWN"); await boundary("AFTER_REPLACEMENT");
  guard(); record.status = "COMPLETE"; await persist("SAME_ORIGINAL_RESULT_ACKNOWLEDGED");
  process.stdout.write(JSON.stringify({ disposition: "COMPLETE", fence: record.fence, attempts: record.attempts,
    oldLiabilityRetained: true, callbackUnknown: true, nativeProof: false }) + "\n");
} catch (error) {
  process.stdout.write(JSON.stringify({ disposition: "REFUSED", reason: error.message, nativeProof: false }) + "\n");
  process.exitCode = 3;
}
