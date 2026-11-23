/** Failure-first CONTROL_W1 recovery through the actual warm/intake/worker path. */
import { strict as assert } from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import pg from "pg";
import { closePool, getPool } from "@finnor/db";
import { codeIdentity, currentCodeIdentity } from "../../packages/private-equity/src/evidence-execution/store";
import { nativeOwnerStory } from "./native-stories.mjs";
import { recoveryWorker } from "./recovery-worker.mjs";
import { recoveryCut } from "./recovery-observe.mjs";
import { originalRequest } from "./original-recovery-request.mjs";

const destination = process.env.FINNOR_W1_RECOVERY_EVIDENCE ?? "";
assert(isAbsolute(destination), "NEW_ABSOLUTE_CONTROL_EVIDENCE_REQUIRED");
assert(["broken", "repaired"].includes(process.env.FINNOR_W1_RECOVERY_PHASE ?? ""), "EXPLICIT_CONTROL_EPOCH_REQUIRED");
const RUNNER_MS = 300000, PER_PROGRAMME_OBSERVER_MS = 120000, CONTENTION_OBSERVER_MS = 12000;
const repo = resolve(import.meta.dirname, "../../.."), started = performance.now(), finalDeadline = started + RUNNER_MS;
const initialIdentity = await codeIdentity();
assert.equal(initialIdentity.digest, (await currentCodeIdentity()).digest);
const record: any = { schema: "finnor.w1.control-pre-admission-recovery.v1",
  phase: process.env.FINNOR_W1_RECOVERY_PHASE, startedAt: new Date().toISOString(),
  productionIdentity: initialIdentity, status: "IN_PROGRESS", databaseErrors: [], cuts: [], calls: [], workers: [],
  node: { executable: process.execPath, version: process.version, pid: process.pid, parentPid: process.ppid },
  limits: { perProgrammeObserverMs: PER_PROGRAMME_OBSERVER_MS, runnerMs: RUNNER_MS, originalBusinessDeadlineMs: 300000, contentionObserverMs: CONTENTION_OBSERVER_MS },
  qualification: "LOCAL_CONTROL_RECOVERY_NOT_POSITIVE_CAPSULE_MOUNTED_COLD_OR_ECONOMIC_PROOF",
  billingUSD: null, completeChildUsage: null, protectedAdmission: false, productionActivated: false };
const save = () => writeFile(join(destination, "observations.json"), JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
await save();
const urls = Object.fromEntries((["ADMIN", "APP", "WORKER"] as const).map(role => {
  const raw = process.env["FINNOR_W1_RECOVERY_C_" + role + "_URL"];
  assert(raw, "EXISTING_DISPOSABLE_CONTROL_DATABASE_REQUIRED");
  const url = new URL(raw);
  assert(["postgres:", "postgresql:"].includes(url.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "LOOPBACK_CONTROL_DATABASE_REQUIRED");
  assert(!["host", "hostaddr", "service"].some(key => url.searchParams.has(key)), "DATABASE_TARGET_OVERRIDE_FORBIDDEN");
  if (role !== "ADMIN") assert.equal(url.username, role === "APP" ? "finnor_app" : "finnor_worker");
  return [role, raw];
})) as Record<"ADMIN" | "APP" | "WORKER", string>;
assert.equal(new URL(urls.APP).host + new URL(urls.APP).pathname, new URL(urls.WORKER).host + new URL(urls.WORKER).pathname);
assert.equal(new URL(urls.APP).host + new URL(urls.APP).pathname, new URL(urls.ADMIN).host + new URL(urls.ADMIN).pathname);
const admin = new pg.Client({ connectionString: urls.ADMIN, application_name: "w1-control-recovery-observer", statement_timeout: 5000 });
const queues: Array<Awaited<ReturnType<typeof recoveryWorker>>> = [];
let holder: pg.Client | undefined;
const usageBefore = process.resourceUsage();
const originalQuery = pg.Client.prototype.query;
// Passive observation only: return the original promise/query, with no result,
// error or argument replacement. No SQL parameters or database URLs are saved.
pg.Client.prototype.query = function (this: pg.Client, ...args: any[]) {
  const result = Reflect.apply(originalQuery, this, args);
  if (result && typeof result.catch === "function") void result.catch((error: any) => {
    record.databaseErrors.push({ at: new Date().toISOString(),
      code: typeof error.code === "string" ? error.code : null,
      constraint: typeof error.constraint === "string" ? error.constraint : null,
      routine: typeof error.routine === "string" ? error.routine : null });
  });
  return result;
} as typeof originalQuery;
const pause = (ms: number) => new Promise<void>(yes => setTimeout(yes, ms));
async function register(queue: Awaited<ReturnType<typeof recoveryWorker>>) {
  const contracts = (await import("../../packages/db/compute-contract")).PRODUCTION_JOB_CONTRACTS;
  queue.register("run_harness_program_v1", (await import("../../packages/private-equity/src/program-synthesis/worker")).runHarnessProgramJob, contracts.run_harness_program_v1);
  queue.register("run_evidence_derivation_v1", (await import("../../packages/private-equity/src/evidence-execution/worker")).runEvidenceDerivationJob, contracts.run_evidence_derivation_v1);
  queue.register("run_compute_search_unit_v1", (await import("../../packages/private-equity/src/compute-search/worker")).runComputeSearchUnitJob, contracts.run_compute_search_unit_v1);
}
async function makeQueue(label: string, deadline: number) {
  assert(performance.now() < deadline, "ORIGINAL_CONTROL_OBSERVER_BOUND");
  const queue = await recoveryWorker(urls.WORKER, destination, label, deadline);
  queues.push(queue);
  record.workers.push({ label, pid: queue.pid, identity: queue.identity, applicationName: queue.applicationName, trace: "worker-" + queue.pid + ".jsonl" });
  await register(queue); await save(); return queue;
}

try {
  assert.equal(process.env.DATABASE_URL, urls.APP);
  await admin.connect(); await admin.query("SET app.test_vertical_mode='explicit'");
  const empty = (await admin.query("SELECT (SELECT count(*)::int FROM finnor_os.p1_requests) parents,(SELECT count(*)::int FROM finnor_os.jobs) jobs")).rows[0];
  assert.equal(empty.parents, 0); assert.equal(empty.jobs, 0);
  record.appIdentity = (await getPool().query("SELECT current_user role,rolsuper,rolbypassrls,pg_has_role('finnor_app','finnor_worker','MEMBER') app_inherits_worker FROM pg_roles WHERE rolname=current_user")).rows[0];
  assert.equal(record.appIdentity.role, "finnor_app");
  assert(!record.appIdentity.rolsuper && !record.appIdentity.rolbypassrls && !record.appIdentity.app_inherits_worker);
  const warmQueue = await makeQueue("setup-warm", finalDeadline);
  const post = (await import("../../apps/api/app/api/company-brain/[operation]/route")).POST;
  const e: any = { admin, queue: warmQueue, evidence: destination, repo, request: originalRequest,
    periodStart: "2025-01-01T00:00:00.000Z", periodEnd: "2025-12-31T00:00:00.000Z", validAt: "2026-01-01T00:00:00.000Z",
    api: async (operation: string, body: any, identity: { tenant: string; actor: string }) => {
      assert(identity, "SETUP_IDENTITY_REQUIRED");
      const response = await post(new Request("http://localhost/api/company-brain/" + operation, { method: "POST",
        headers: { "content-type": "application/json", "x-tenant-id": identity.tenant, "x-user-id": identity.actor }, body: JSON.stringify(body) }),
        { params: Promise.resolve({ operation }) });
      return { status: response.status, body: await response.json() };
    } };
  await nativeOwnerStory(e, async ({ fixture, http, programId, searchId, before, input }) => {
    const scoredStart = performance.now(), end = scoredStart + PER_PROGRAMME_OBSERVER_MS;
    record.scoredStartedAt = new Date().toISOString(); record.warmEpisode = before; record.followUpInput = input;
    const check = () => assert(performance.now() < end && performance.now() < finalDeadline, "ORIGINAL_CONTROL_OBSERVER_BOUND");
    const checkpoint = async (label: string) => {
      check(); const cut = await recoveryCut(admin, programId, searchId, label, destination);
      record.cuts.push(cut); await save(); check(); return cut;
    };
    const waitFor = async (predicate: () => Promise<boolean>, failure: string, maxMs = CONTENTION_OBSERVER_MS) => {
      const limit = Math.min(end, performance.now() + maxMs);
      while (performance.now() < limit) { check(); if (await predicate()) return; await pause(75); }
      throw Error(failure);
    };
    const call = async (operation: string, body: any, identity: "actor" | "other" | "anonymous" = "actor") => {
      check(); assert.equal(process.env.AUTH_DEV_BYPASS, "0");
      const at = new Date().toISOString(), begin = performance.now(), result = await http.call(operation, body, identity);
      record.calls.push({ operation, identity, at, completedAt: new Date().toISOString(), wallMs: performance.now() - begin, ...result });
      await save(); check(); return result;
    };
    record.auth = { bypass: false,
      anonymousStatus: (await call("economic-orchestration-read", { searchId }, "anonymous")).status,
      foreignStatus: (await call("economic-orchestration-read", { searchId }, "other")).status };
    assert.equal(record.auth.anonymousStatus, 401); assert.equal(record.auth.foreignStatus, 404);
    for (let n = 0; n < 40; n++) {
      check();
      const ready = (await admin.query(`SELECT u.id FROM finnor_os.p2_units u JOIN finnor_os.jobs j ON j.payload->>'unitId'=u.id::text
        WHERE u.search_id=$1 AND u.kind='CONTROL_W1' AND u.status='QUEUED' AND j.protocol_version=3 AND j.status='queued'`, [searchId])).rows;
      if (ready.length) break;
      const ran = await warmQueue.tick(); check(); await pause(ran ? 25 : 2050);
    }
    await warmQueue.close();
    const selected = await checkpoint("selected");
    const unit = selected.units.find((u: any) => u.kind === "CONTROL_W1" && u.status === "QUEUED");
    assert(unit, "ACTUAL_TRAIN_SUPPORTED_CONTROL_W1_REQUIRED");
    const jobs = selected.jobs.filter((j: any) => j.payload?.unitId === unit.id && j.status === "queued");
    assert.equal(jobs.length, 1); const job = jobs[0];
    assert.equal(unit.attempts, 0); assert.equal(selected.attempts.length, 0); assert.equal(selected.capsules.length, 0);
    assert.equal(job.protocol_version, 3);
    assert.equal(job.idempotency_key, `p2:${searchId}:${unit.generation}:${unit.id}:admission:0`);
    const selection = selected.events.find((event: any) => event.kind === "W1_CONTROL_QUEUED" && event.body.unitId === unit.id);
    assert(selection?.body.continuationRef, "ACTUAL_CONTROL_TRAIN_REFERENCE_REQUIRED");
    record.trainingContinuation = (await admin.query(`SELECT digest,body FROM finnor_os.w1_continuation_states
      WHERE tenant_id=$1 AND principal_id=$2 AND body->>'ref'=$3`, [selected.parent.tenant_id,
      selected.parent.principal_id, selection.body.continuationRef])).rows;
    assert.equal(record.trainingContinuation.length, 1, "EXACT_RETAINED_TRAIN_CONTINUATION_REQUIRED");
    record.original = { programId, searchId, unitId: unit.id, jobId: job.id, workId: selected.parent.work_id,
      workInputId: selected.parent.work_input_id, episodeId: selected.episode.id, deadlineAt: selected.episode.deadline_at, grant: selected.search.request.computeGrant };
    holder = new pg.Client({ connectionString: urls.ADMIN, application_name: "w1-control-recovery-holder", statement_timeout: 5000 });
    await holder.connect(); await holder.query("BEGIN");
    const holderPid = (await holder.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["s5-portfolio:" + fixture.f.tenant]);
    record.gate = { holderPid, kind: "EXISTING_S5_PORTFOLIO_ADVISORY", heldAt: new Date().toISOString() };
    const victim = await makeQueue("victim", end);
    const tick = victim.tick().then(value => ({ ok: true, value }), error => ({ ok: false, error: String(error) }));
    await waitFor(async () => {
      const waits = (await admin.query("SELECT pid,query,pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE application_name=$1 AND usename='finnor_worker' AND wait_event_type='Lock'", [victim.applicationName])).rows;
      if (!waits.some(w => w.blockers.includes(holderPid) && w.query.includes("pg_advisory_xact_lock"))) return false;
      const current = (await admin.query("SELECT u.status unit_status,u.attempts,j.status job_status,(SELECT count(*)::int FROM finnor_os.p2_attempts a WHERE a.search_id=u.search_id) physical_attempts FROM finnor_os.p2_units u JOIN finnor_os.jobs j ON j.id=$2 WHERE u.id=$1", [unit.id, job.id])).rows[0];
      return current.unit_status === "QUEUED" && current.attempts === 0 && current.job_status === "running" && current.physical_attempts === 0;
    }, "REAL_CONTROL_S5_CONTENTION_NOT_REACHED");
    await checkpoint("contended");
    record.kill = await victim.killExact(); record.victimTick = await tick;
    await checkpoint("killed");
    await holder.query("ROLLBACK"); record.gate.releasedAt = new Date().toISOString(); await holder.end(); holder = undefined;
    await waitFor(async () => Number((await admin.query("SELECT count(*) n FROM pg_stat_activity WHERE application_name=$1", [victim.applicationName])).rows[0].n) === 0,
      "KILLED_CONTROL_CONNECTIONS_STILL_LIVE", 5000);
    await checkpoint("released");
    const replacement = await makeQueue("replacement", end); e.queue = replacement;
    assert.notEqual(replacement.pid, victim.pid);
    await waitFor(async () => {
      const row = (await admin.query("SELECT status,lease_expires_at<=clock_timestamp() expired FROM finnor_os.jobs WHERE id=$1", [job.id])).rows[0];
      assert.equal(row.status, "running", "ONLY_CANONICAL_RECOVERY_MAY_CHANGE_RUNNING_JOB"); return row.expired === true;
    }, "ORIGINAL_CONTROL_QUEUE_LEASE_DID_NOT_EXPIRE");
    await checkpoint("lease-expired");
    record.canonicalRecoveryCount = await replacement.recoverExpiredRunningJobs();
    await checkpoint("queue-recovered");
    const reconciled = await call("economic-orchestration-reconcile", { searchId });
    const recovered = await checkpoint("reconciled");
    if (reconciled.status === 422) {
      record.status = "RECORDED_CONTROL_RECONCILE_422"; await checkpoint("final");
    } else {
      assert.equal(reconciled.status, 200, JSON.stringify(reconciled));
      assert.equal(recovered.units.find((u: any) => u.id === unit.id)?.status, "FAILED");
      for (let n = 0; n < 96; n++) {
        check(); const status = (await admin.query("SELECT status FROM finnor_os.p1_requests WHERE id=$1", [programId])).rows[0].status;
        if (status === "TESTED") break;
        assert(!["FAILED", "INVALIDATED", "CANCELLED", "PARTIAL"].includes(status), "ORIGINAL_CONTROL_FALLBACK_PARENT_FAILED");
        const ran = await replacement.tick(); check(); await pause(ran ? 25 : 2050);
      }
      record.programRead = await call("program-read", { programId });
      assert.equal(record.programRead.status, 200); assert.equal(record.programRead.body.status, "TESTED");
      await checkpoint("final"); record.status = "RECORDED_CONTROL_FALLBACK_RECOVERED";
    }
    record.scoredWallMs = performance.now() - scoredStart; check();
    record.transport = http.observed; await save();
    return { evidence: destination, receipt: record };
  });
} catch (error) {
  record.status = "DRIVER_FAILED"; record.error = String(error);
} finally {
  if (holder) try { await holder.query("ROLLBACK"); await holder.end(); } catch (error) { record.cleanupError = String(error); }
  for (const queue of queues.reverse()) try { await queue.close(); } catch (error) { record.cleanupError = String(error); }
  try { await closePool(); await admin.end(); } catch (error) { record.cleanupError = String(error); }
  pg.Client.prototype.query = originalQuery;
  record.finalProductionIdentity = await codeIdentity();
  record.sourceUnchanged = initialIdentity.digest === record.finalProductionIdentity.digest;
  record.network = (globalThis as any).__FINNOR_W1_READ_NETWORK_METER ?? null;
  record.engineering = { wallMs: performance.now() - started, rootUsageBefore: usageBefore, rootUsageAfter: process.resourceUsage(),
    intervalsNonadditive: true, completeChildUsage: null, billingUSD: null, includesWarmAndSetup: true };
  record.completedAt = new Date().toISOString(); await save();
}
process.exitCode = record.status === "DRIVER_FAILED" || record.cleanupError || !record.sourceUnchanged ? 2 : 0;
