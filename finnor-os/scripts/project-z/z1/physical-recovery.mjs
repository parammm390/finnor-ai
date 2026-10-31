import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { freshHistoricalRequest as freshRequest } from "./fixtures.mjs";
import { runProducer, checkOriginal, runtimeIdentity } from "../../../packages/private-equity/src/project-z/z1-shared-work/processes.ts";

// This is a physical local transport/checkpoint E2E. Its file fixture is
// deliberately NOT an implementation of canonical jobs, S5, S6 or S3/S4.
const self = fileURLToPath(import.meta.url);
const root = resolve(dirname(self), "../../../..");
const loader = resolve(root, "finnor-os/node_modules/tsx/dist/loader.mjs");
const readState = async (dir) => JSON.parse(await readFile(resolve(dir, "fixture-state.json"), "utf8"));
async function syncWrite(path, body, flags = "wx") {
  const fd = await open(path, flags, 0o600);
  try { await fd.writeFile(body); await fd.sync(); } finally { await fd.close(); }
}
async function persist(dir, state, fence) {
  const old = await readState(dir);
  if (old.fence !== fence) throw Error("LOCAL_FIXTURE_FENCE_REJECTED");
  const temporary = resolve(dir, `.state-${process.pid}.tmp`);
  await syncWrite(temporary, JSON.stringify(state));
  await rename(temporary, resolve(dir, "fixture-state.json"));
  const fd = await open(dir, "r"); try { await fd.sync(); } finally { await fd.close(); }
}
async function event(dir, body) {
  await syncWrite(resolve(dir, "fixture-events.jsonl"), JSON.stringify({ ...body, at: new Date().toISOString(), pid: process.pid }) + "\n", "a");
}
async function checkpoint(stage) {
  const continued = new Promise((done) => process.once("message", done));
  process.send({ stage, pid: process.pid });
  await continued;
}
async function worker(dir, expectedFence) {
  let state = await readState(dir);
  if (state.fence !== expectedFence) throw Error("LOCAL_FIXTURE_FENCE_REJECTED");
  await event(dir, { kind: "CLAIMED_LOCAL_FIXTURE", fence: expectedFence, workIds: state.request.works.map(w => w.id) });
  await checkpoint("CLAIM");
  const beforeCharges = state.checkpoint?.charges ?? null;
  const produced = await runProducer(state.request, state.checkpoint ?? undefined, 15000, undefined, async (pid) => {
    await event(dir, { kind: "PRODUCER_PID", pid, fence: expectedFence });
  });
  assert.equal(produced.production.disposition, "UNKNOWN", produced.production.reason);
  assert.ok(produced.production.program);
  const checked = await checkOriginal(state.request, produced.production.program, 15000, undefined,
    async (pid) => event(dir, { kind: "INDEPENDENT_CHECKER_PID", pid, fence: expectedFence }));
  assert.equal(checked.disposition, "CHECKED_CANDIDATE");
  if (beforeCharges) assert.deepEqual(produced.production.checkpoint.charges, beforeCharges);
  state = { ...state, checkpoint: produced.production.checkpoint,
    candidate: produced.production.program, check: checked, physical: [...(state.physical ?? []), produced.receipt, checked.process] };
  await persist(dir, state, expectedFence);
  await event(dir, { kind: "DURABLE_LOCAL_ARTIFACT", candidateDigest: state.candidate.envelope.immutableArtifactDigest });
  await checkpoint("ARTIFACT");
  state = await readState(dir);
  for (const projection of state.candidate.workProjections) {
    const key = state.candidate.envelope.immutableArtifactDigest + ":" + projection.workId;
    const prior = state.deliveries.find(x => x.key === key);
    if (prior) prior.deliveryAttempts++;
    else state.deliveries.push({ key, workId: projection.workId, result: projection.result,
      parentReservation: projection.binding.original.resources.parentReservationRef,
      unresolvedObligationRefs: projection.unresolvedObligationRefs, deliveryAttempts: 1 });
  }
  await persist(dir, state, expectedFence);
  await event(dir, { kind: "DELIVERED_TO_LOCAL_FIXTURE_NOT_NATIVE_OWNER", fence: expectedFence });
  await checkpoint("DELIVERY");
  state.fixtureAcknowledged = true;
  await persist(dir, state, expectedFence);
  await event(dir, { kind: "LOCAL_FIXTURE_ACK_NOT_S3_S4_ACK", fence: expectedFence });
  process.send({ stage: "DONE", pid: process.pid });
  process.disconnect();
}
async function launch(dir, fence, stopAt = null) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, ["--max-old-space-size=1536", "--import", loader, self, "--fixture-worker", dir, String(fence)], {
      cwd: root, env: { PATH: process.env.PATH, LANG: "C.UTF-8", TSX_DISABLE_CACHE: "1", PYTHONDONTWRITEBYTECODE: "1" },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const stages = [];
    let errors = "", killed = false;
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(Error("OWNED_FIXTURE_WORKER_TIMEOUT")); }, 40000);
    child.on("error", reject);
    child.stdout.resume();
    child.stderr.on("data", chunk => { errors += chunk.toString(); if (errors.length > 65536) child.kill("SIGKILL"); });
    child.on("message", message => {
      stages.push(message);
      if (message.stage === stopAt && !killed) { killed = true; child.kill("SIGKILL"); }
      else if (message.stage !== "DONE") child.send({ continue: true });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      done({ pid: child.pid, code, signal, stages, errors, killed });
    });
  });
}
async function drive(evidence) {
  if (!evidence || !isAbsolute(evidence)) throw Error("ABSOLUTE_NEW_EVIDENCE_DIRECTORY_REQUIRED");
  await mkdir(evidence, { recursive: false, mode: 0o700 });
  const runtime = await runtimeIdentity(), results = [];
  for (const [index, stage] of ["CLAIM", "ARTIFACT", "DELIVERY"].entries()) {
    const dir = resolve(evidence, stage.toLowerCase()); await mkdir(dir, { mode: 0o700 });
    const request = freshRequest(31, index + 20, runtime.digest);
    await syncWrite(resolve(dir, "fixture-state.json"), JSON.stringify({
      request, fence: 1, checkpoint: null, deliveries: [], fixtureAcknowledged: false, orphanedAttempts: [],
    }));
    const interrupted = await launch(dir, 1, stage);
    assert.equal(interrupted.signal, "SIGKILL"); assert.ok(interrupted.killed);
    const afterKill = await readState(dir);
    const charges = afterKill.checkpoint?.charges ?? null;
    afterKill.fence = 2;
    afterKill.orphanedAttempts.push({ workerPid: interrupted.pid, atBoundary: stage, physicalCostStatus: "UNKNOWN_RETAINED", originalIdsUnchanged: true });
    // The driver owns this fixture and advances its epoch only after real exit.
    await syncWrite(resolve(dir, "fixture-state.json"), JSON.stringify(afterKill), "w");
    const stale = await launch(dir, 1);
    assert.equal(stale.code, 2); assert.match(stale.errors, /LOCAL_FIXTURE_FENCE_REJECTED/);
    const restarted = await launch(dir, 2);
    assert.equal(restarted.code, 0, restarted.errors);
    const final = await readState(dir);
    assert.equal(final.fixtureAcknowledged, true);
    assert.deepEqual(final.request, request);
    if (charges) assert.deepEqual(final.checkpoint.charges, charges);
    assert.equal(final.deliveries.length, 2);
    for (const work of request.works) {
      const delivery = final.deliveries.find(d => d.workId === work.id);
      assert.deepEqual(delivery.unresolvedObligationRefs, work.unresolvedObligationRefs);
      assert.equal(delivery.parentReservation, work.resources.parentReservationRef);
      assert.equal(delivery.deliveryAttempts, stage === "DELIVERY" ? 2 : 1);
    }
    results.push({ stage, status: "PASSED", interrupted, stale, restarted,
      originalWorkIds: request.works.map(w => w.id), finalArtifactDigest: final.candidate.envelope.immutableArtifactDigest,
      tickCharges: final.checkpoint.charges, remainingUnknown: final.orphanedAttempts,
      nativeJobClaimAndFencing: "NOT_RUN", nativeOwnerAcknowledgement: "NOT_RUN" });
  }
  const report = {
    scope: "Three real SIGKILL/restarts of an owned LOCAL FILE FIXTURE worker, actual producer/checker children and durable files",
    status: "PASSED", runtime, results,
    canonicalQueuePhysicalRecovery: "NOT_RUN", realS3S4Consumption: "NOT_RUN", realS5S6Liability: "NOT_RUN",
    protectedAdmission: "NOT_RUN", sourceTruth: "NOT_CLAIMED",
  };
  await writeFile(resolve(evidence, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, physicalLocalBoundaries: 3, nativeRecovery: "NOT_RUN", evidence }));
}
if (process.argv[2] === "--fixture-worker") {
  worker(process.argv[3], Number(process.argv[4])).catch(error => {
    process.stderr.write(error.message === "LOCAL_FIXTURE_FENCE_REJECTED" ? error.message + "\n" : "LOCAL_FIXTURE_WORKER_FAILED\n");
    process.exitCode = 2;
    if (process.connected) process.disconnect();
  });
} else {
  drive(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
}
