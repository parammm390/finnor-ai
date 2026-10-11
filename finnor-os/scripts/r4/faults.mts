/** Registered disposable HTTP/SQL/physical probes. No protected grants/signers. */
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync, type ChildProcess } from "node:child_process";
import pg from "pg";

const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const pause = (ms: number) => new Promise<void>(yes => setTimeout(yes, ms));
async function until<T>(name: string, read: () => Promise<T | undefined | false>, ms = 20000, interval = 20): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await pause(interval);
  }
  throw Error("ACTUAL_PROBE_BOUND_" + name);
}

export async function installFaultExecutable(directory: string, real: string, artifact: (name: string, body: unknown) => Promise<unknown>) {
  const executable = join(directory, "r4-fault-python"), marker = join(directory, "r4-corrupt-candidate");
  const code = `#!${real}
import json, os, subprocess, sys
real = ${JSON.stringify(real)}
marker = ${JSON.stringify(marker)}
if not os.path.exists(marker) or "producer" not in sys.argv[1:]:
    os.execv(real, [real] + sys.argv[1:])
p = subprocess.run([real] + sys.argv[1:], input=sys.stdin.buffer.read(), capture_output=True)
sys.stderr.buffer.write(p.stderr)
if p.returncode == 0:
    result = json.loads(p.stdout)
    result["value"]["plan"]["selected"]["totalCost"] = {"numerator":"0","denominator":"1"}
    sys.stdout.write(json.dumps(result, sort_keys=True, separators=(",",":")))
else:
    sys.stdout.buffer.write(p.stdout)
sys.exit(p.returncode)
`;
  await writeFile(executable, code, { mode: 0o700, flag: "wx" });
  await artifact("fault-executable.json", { executable, sha256: hash(code), real,
    purpose: "Untrusted native output mutation only when explicit disposable marker exists",
    qualification: "DISPOSABLE_FAULT_INJECTION_NOT_FINAL_RUNTIME_OR_PROTECTED_ADMISSION" });
  return { executable, marker };
}

type Inputs = {
  repo: string; admin: pg.Client; http: any; fixture: any; corruptionMarker: string;
  prepareOwnerFixture: (name: string, options?: any) => Promise<any>;
  submitFixture: (scope: any) => Promise<any>; drain: (scope: any, id: string) => Promise<any>;
  story: (id: string, expected: string, fn: () => Promise<unknown>) => Promise<void>;
  artifact: (name: string, body: unknown) => Promise<any>;
  tick: () => Promise<unknown>; startWorker: () => Promise<void>; worker: () => ChildProcess;
  remainingOnly?: boolean;
  finalOnly?: boolean;
  tailOnly?: boolean;
  stopWorker: () => Promise<void>;
};
export async function runFaultProbes(x: Inputs) {
  const { admin, http, artifact } = x;
  const remaining = new Set(["registered-delay-refusal", "cross-tenant-principal-submit-read-work",
    "two-works-one-original-three-attempt-grant", "physical-producer-checker-cancel-worker-faults",
    "publication-lock-rights-revocation", "publication-lock-original-expiry", "work-input-resource-population-revisions"]);
  const story: Inputs["story"] = async (id, expected, fn) => {
    if (x.tailOnly && !["publication-lock-original-expiry", "work-input-resource-population-revisions"].includes(id)) return;
    if (x.finalOnly && ["physical-producer-checker-cancel-worker-faults", "publication-lock-rights-revocation"].includes(id)) return;
    if (x.remainingOnly && !remaining.has(id)) return;
    return x.story(id, expected, fn);
  };
  const ok = (r: any, status = 200) => { assert.equal(r.status, status, JSON.stringify(r)); return r.body; };
  const rawRun = async (id: string) => (await admin.query("SELECT * FROM finnor_os.r4_runs WHERE id=$1", [id])).rows[0];
  const attempts = async (id: string) => (await admin.query("SELECT * FROM finnor_os.r4_attempts WHERE run_id=$1 ORDER BY created_at", [id])).rows;
  async function history(scope: any, id: string) { return ok(await http.call(scope, "history", { runId: id })); }
  async function fallback(scope: any, id: string, ownerExpected = true) {
    const h = await history(scope, id);
    const f = h.records.artifacts.filter((a: any) => a.kind === "FALLBACK").at(-1)?.body;
    assert(f, "Concrete fallback artifact required");
    assert.equal(f.originalEpisode, (await rawRun(id)).episode_id);
    assert.equal(f.callee, "S4.synthesizeEnterpriseControlProposal -> chooseEnterpriseControlBranch");
    if (ownerExpected) {
      assert.equal(f.observed.callee, "synthesizeEnterpriseControlProposal -> chooseEnterpriseControlBranch");
      assert.equal(f.observed.review.status, "WAIT");
      assert(f.observed.proposal && f.observed.decision, "Actual persisted owner proposal and decision, not a flag");
    }
    await artifact("faults/" + id + "/fallback.json", f);
    return f;
  }
  async function run(scope: any) {
    const submitted = await x.submitFixture(scope);
    const result = await x.drain(scope, submitted.accepted.runId);
    await artifact("faults/" + submitted.accepted.runId + "/run.json", { scope: scope.registration, ...submitted, result });
    return { ...submitted, result, id: submitted.accepted.runId };
  }
  async function secondWork(scope: any) {
    const work = scope.competingWork;
    assert(work, "Both canonical Works must precede the immutable S3/S4/S5 owner cut");
    const persisted = (await admin.query("SELECT * FROM finnor_os.works WHERE tenant_id=$1 AND id=$2", [scope.tenant, work.workId])).rows[0];
    await artifact("faults/competing-work-before-registration.json", { work, persisted });
    assert.equal(persisted.current_owner_id, scope.principal, "Competing Work must retain its canonical owner");
    const registration = { ...scope.registration, workId: work.workId, workInputId: work.workInputId, priorProfileId: null };
    return { ...scope, work, registration, registered: ok(await http.call(scope, "register", registration)) };
  }
  function ownProcess(attempt: any, worker = x.worker()) {
    const pid = Number(attempt.body.pid);
    assert(Number.isInteger(pid) && pid > 1 && worker.pid);
    const row = execFileSync("ps", ["-p", String(pid), "-o", "pid=,ppid=,stat=,command="], { encoding: "utf8" }).trim();
    const fields = row.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    assert(fields && Number(fields[1]) === pid && Number(fields[2]) === worker.pid, "Accepted supervisor must be this owned worker's child");
    assert(fields[4]!.includes("identification-plan/supervisor.py"), "No peer process may receive a signal");
    return { pid, parent: worker.pid, stat: fields[3], command: fields[4] };
  }
  async function accepted(scope: any, kind: string) {
    const submitted = await x.submitFixture(scope), id = submitted.accepted.runId;
    let ticking = false, pending: Promise<any> = Promise.resolve({ deferred: true });
    const attempt = await until("ACCEPTED_" + kind, async () => {
      const rows = await attempts(id), row = rows.find(a => a.kind === kind && a.status === "SUBMITTED" && a.body.pid);
      if (row) return row;
      const state = await rawRun(id);
      if (!ticking && state.status === "QUEUED" && !rows.length) {
        ticking = true;
        pending = x.tick().then(value => ({ value }), error => ({ error: String(error) })).finally(() => { ticking = false; });
      }
      if (!["QUEUED", "RUNNING"].includes(state.status)) {
        await artifact("faults/missed-physical-window.json", { id, kind, state, rows });
        throw Error("PHYSICAL_PROBE_TARGET_COMPLETED_OR_REFUSED_" + kind);
      }
      return false;
    });
    return { scope, id, submitted, pending, attempt, process: ownProcess(attempt) };
  }
  async function noRetry(scope: any, id: string, before: number) {
    await x.tick();
    assert.equal((await attempts(id)).length, before);
    const rows = await attempts(id);
    assert(rows.every(a => a.body.chargedNativeAttempts === 1));
    return rows;
  }

  let expensive: any = x.remainingOnly ? x.fixture : undefined, delayed: any, unsupported: any, incumbent: any, physical: any;
  let independent = x.fixture;
  await story("registered-cost-refusal", "Unchanged benefit 100, actual registered price 120 is refused and existing S4 WAIT/STOP executes", async () => {
    expensive = await x.prepareOwnerFixture("r4-cost-" + randomUUID().slice(0, 8), { prices: [120, 150] });
    expensive.checked = await run(expensive);
    assert.equal(expensive.checked.result.status, "COMPLETE");
    const consumer = ok(await http.call(expensive, "consume", { runId: expensive.checked.id, disposition: "PROPOSE" }));
    assert.equal(consumer.decision.review.status, "DECLINED_REGISTERED_COST_OR_DELAY");
    assert(consumer.decision.proposal && consumer.decision.decision);
    await artifact("faults/cost-refusal.json", consumer); return consumer.decision;
  });
  await story("registered-delay-refusal", "Unchanged 0.001 USD/ms delay utility rejects 120 seconds without rewriting utility or query horizon", async () => {
    delayed = await x.prepareOwnerFixture("r4-delay-" + randomUUID().slice(0, 8), { delays: [120, 150] });
    delayed.checked = await run(delayed);
    assert.equal(delayed.checked.result.status, "COMPLETE");
    const consumer = ok(await http.call(delayed, "consume", { runId: delayed.checked.id, disposition: "PROPOSE" }));
    assert.equal(consumer.decision.review.status, "DECLINED_REGISTERED_COST_OR_DELAY");
    assert(consumer.decision.proposal && consumer.decision.decision);
    await artifact("faults/delay-refusal.json", consumer); return consumer.decision;
  });
  await story("cross-tenant-principal-submit-read-work", "Genuine foreign bearer cannot use private profile/run/Work, even with forged principal/tenant headers", async () => {
    assert(expensive && delayed);
    const request = x.fixture.accepted ? (await rawRun(x.fixture.accepted.runId)).request : expensive.checked.request;
    const scope = x.fixture, id = scope.accepted.runId;
    const probes = [];
    for (const bearer of [scope.otherBearer, delayed.bearer]) {
      for (const [op, body] of [["read", { runId: id }], ["submit", request],
        ["work", { root: scope.root, workId: scope.work.workId }]] as const) {
        const value = await http.call(scope, op, body, { bearer, claimedPrincipal: scope.principal, claimedTenant: scope.tenant });
        await artifact("faults/foreign-access-" + probes.length + ".json", { op, value });
        if (op === "work" && value.status === 200) {
          assert.equal(value.body.profile, null); assert.equal(value.body.run, null);
        } else assert([400, 401, 403, 404].includes(value.status));
        assert(!JSON.stringify(value).includes("affordable-joint"));
        probes.push({ op, value });
      }
    }
    await artifact("faults/foreign-access.json", probes); return probes;
  });
  await story("unsupported-full-coverage-and-fallback", "Actual producer and separate checker retain unsupported laws, all masks/pairs, no minimum theorem, and real original-budget S4 fallback", async () => {
    unsupported = await x.prepareOwnerFixture("r4-unsupported-" + randomUUID().slice(0, 8), { lawMode: "UNSUPPORTED" });
    unsupported.checked = await run(unsupported);
    const result = unsupported.checked.result;
    assert.equal(result.status, "UNSUPPORTED"); assert.equal(result.artifact_ref, null);
    const h = await history(unsupported, unsupported.checked.id), report = h.records.artifacts.find((a: any) => a.kind === "PLAN").body;
    assert.equal(report.checker.status, "ACCEPTED");
    assert.equal(report.checker.checks.masks, 4); assert.equal(report.checker.checks.pairs, 12);
    assert.equal(report.plan.minimality.status, "UNKNOWN");
    assert.equal(report.plan.identification, "UNKNOWN");
    return { result, report, fallback: await fallback(unsupported, unsupported.checked.id) };
  });
  await story("checked-incumbent-not-current-recommendation", "Cheaper unknown support keeps durable INCOMPLETE, checked incumbent and gaps; S4 receives fallback, not acquisition recommendation", async () => {
    incumbent = await x.prepareOwnerFixture("r4-incumbent-" + randomUUID().slice(0, 8), { lawMode: "UNKNOWN_CHEAPER" });
    incumbent.checked = await run(incumbent);
    const r = incumbent.checked.result;
    assert.equal(r.status, "INCOMPLETE"); assert.equal(r.artifact_ref, null); assert(r.incumbent_ref);
    assert.equal(r.incumbent.checker.status, "ACCEPTED");
    assert.equal(r.incumbent.plan.selected.bundleIds[0], "expensive-joint");
    assert.deepEqual(r.incumbent.plan.minimality.unresolvedMasks, [1]);
    const work = ok(await http.call(incumbent, "work", { root: incumbent.root, workId: incumbent.work.workId }));
    assert.equal(work.run.currentUseGranted, false); assert.equal(work.run.plan, null);
    return { result: r, work, fallback: await fallback(incumbent, incumbent.checked.id) };
  });
  await story("profile-support-graph-menu-currentness", "Unsupported support promotion is rejected; real graph/menu CAS invalidates earlier incumbent and recompiles unchanged original grant", async () => {
    assert(incumbent);
    const bad = structuredClone(incumbent.registration);
    bad.priorProfileId = incumbent.registered.profileId;
    bad.problem.bundles[0].laws[0].premises.positivity.status = "SATISFIED";
    const refused = await http.call(incumbent, "register", bad);
    assert.equal(refused.status, 400); assert.equal(refused.body.code, "R4_SOURCE_LAW_PREIMAGE_OR_COLLECTION_DECLARATION_MISMATCH");
    const next = structuredClone(incumbent.registration);
    next.priorProfileId = incumbent.registered.profileId;
    next.problem.graphs[0].directed = [["outcome", "price"]];
    next.problem.costItems[0].amount = { numerator: "1", denominator: "1" };
    incumbent.registered = ok(await http.call(incumbent, "register", next)); incumbent.registration = next;
    assert.equal(ok(await http.call(incumbent, "read", { runId: incumbent.checked.id })).status, "INVALIDATED");
    const revised = await run(incumbent), h = await history(incumbent, incumbent.checked.id);
    assert.equal(revised.result.status, "INCOMPLETE");
    assert.notEqual(revised.result.incumbent.checker.inputDigest, incumbent.checked.result.incumbent.checker.inputDigest);
    assert(h.records.artifacts.some((a: any) => a.kind === "PLAN"));
    return { refused, revised, oldHistoryRetained: true };
  });
  await story("two-works-one-original-three-attempt-grant", "Actual concurrent S5 clearing/occupancy accepts exactly three children, one complete checked plan, one exhausted original grant", async () => {
    const a = await x.prepareOwnerFixture("r4-shared-" + randomUUID().slice(0, 8), { capacity: 3, twoWorks: true });
    const b = await secondWork(a), sa = await x.submitFixture(a), sb = await x.submitFixture(b);
    await Promise.all([x.tick(), x.tick()]);
    const ra = ok(await http.call(a, "read", { runId: sa.accepted.runId })), rb = ok(await http.call(b, "read", { runId: sb.accepted.runId }));
    assert.deepEqual([ra.status, rb.status].sort(), ["COMPLETE", "INCOMPLETE"]);
    const episode = (await admin.query("SELECT * FROM finnor_os.r4_episodes WHERE tenant_id=$1", [a.tenant])).rows;
    assert.equal(episode.length, 1); assert.equal(episode[0].native_used, 3);
    const aa = [...await attempts(sa.accepted.runId), ...await attempts(sb.accepted.runId)];
    assert.equal(aa.length, 3); assert(aa.every(v => v.body.chargedNativeAttempts === 1));
    const spent = (await admin.query("SELECT spent FROM finnor_os.p2_grant_usage WHERE tenant_id=$1", [a.tenant])).rows;
    assert.equal(Number(spent[0].spent), 3);
    const loser = ra.status === "INCOMPLETE" ? [a, sa.accepted.runId] : [b, sb.accepted.runId];
    independent = ra.status === "COMPLETE" ? { ...a, accepted: sa.accepted } : { ...b, accepted: sb.accepted };
    const disposition = await fallback(loser[0], loser[1]);
    const counts = (await admin.query("SELECT (SELECT count(*)::int FROM finnor_os.s5_reservations WHERE tenant_id=$1) reservations,(SELECT count(*)::int FROM finnor_os.business_effects WHERE tenant_id=$1) effects", [a.tenant])).rows[0];
    assert.equal(counts.reservations, 1); assert.equal(counts.effects, 0);
    await artifact("faults/shared-grant.json", { ra, rb, episode, aa, spent, counts });
    return { ra, rb, episode, counts, fallback: disposition };
  });
  await story("physical-producer-checker-cancel-worker-faults", "Accepted owned children/worker are interrupted, debits/deadline persist, actual recovery never retries physical work", async () => {
    physical = await x.prepareOwnerFixture("r4-physical-" + randomUUID().slice(0, 8));
    const observations = [];
    for (const kind of x.remainingOnly ? [] : ["PRODUCER", "CHECKER"]) {
      const task = await accepted(physical, kind);
      process.kill(-task.process.pid, "SIGKILL");
      const done = await task.pending;
      const result = ok(await http.call(physical, "read", { runId: task.id }));
      assert.equal(result.artifact_ref, null);
      const rows = await noRetry(physical, task.id, kind === "PRODUCER" ? 1 : 2);
      assert(rows.every(a => a.body.terminationObserved === true));
      const observed = { kind, id: task.id, process: task.process, done, result, rows,
        fallback: await fallback(physical, task.id) };
      await artifact("faults/" + kind.toLowerCase() + "-kill.json", observed); observations.push(observed);
    }
    const cancelled = await accepted(physical, "PRODUCER");
    ok(await http.call(physical, "cancel", { runId: cancelled.id }));
    await cancelled.pending;
    assert.equal((await rawRun(cancelled.id)).status, "CANCELLED");
    const cancellation = await noRetry(physical, cancelled.id, 1);
    assert(cancellation[0].body.terminationObserved);
    await artifact("faults/cancellation.json", { cancelled: cancelled.id, process: cancelled.process, cancellation });
    const abandoned = await accepted(physical, "PRODUCER"), workerPid = x.worker().pid!;
    process.kill(workerPid, "SIGKILL"); await abandoned.pending;
    await until("ORPHAN_TERMINATED", async () => {
      try { process.kill(abandoned.process.pid, 0); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? true : false; }
    });
    await admin.query("UPDATE finnor_os.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [abandoned.attempt.body.jobId]);
    await x.startWorker();
    const recovery = await x.tick();
    const unknown = ok(await http.call(physical, "read", { runId: abandoned.id }));
    assert.equal(unknown.status, "UNKNOWN");
    const retained = await noRetry(physical, abandoned.id, 1);
    assert.equal(retained[0].status, "UNKNOWN");
    assert.equal(retained[0].body.physicalRetryGranted, false);
    assert.equal(retained[0].body.originalDeadline, abandoned.attempt.body.originalDeadline);
    await artifact("faults/worker-restart.json", { workerPid, restartedPid: x.worker().pid, abandoned: abandoned.id,
      process: abandoned.process, recovery, unknown, retained });
    return { observations, cancellation, unknown, retained };
  });
  await story("actual-independent-checker-rejection-fallback", "Native untrusted output corrupts selected cost; separate checker reaches minimality, rejects and original-budget real S4 fallback executes", async () => {
    assert(physical);
    await writeFile(x.corruptionMarker, "Registered native output mutation\n", { flag: "wx", mode: 0o600 });
    let tested;
    try { tested = await run(physical); } finally { await unlink(x.corruptionMarker); }
    assert.equal(tested.result.artifact_ref, null);
    const h = await history(physical, tested.id), check = h.records.artifacts.find((a: any) => a.kind === "CHECK").body;
    assert.equal(check.status, "REJECTED"); assert.equal(check.boundary, "minimality");
    assert.equal((await attempts(tested.id)).length, 2);
    return { tested, check, fallback: await fallback(physical, tested.id) };
  });
  await story("stale-queue-fence-and-duplicate", "A replaced actual claim token cannot publish; repeated HTTP idempotency cannot create another attempt", async () => {
    assert(physical);
    const task = await accepted(physical, "PRODUCER");
    await admin.query("UPDATE finnor_os.jobs SET claim_token=$2,claim_fence=claim_fence+1 WHERE id=$1", [task.attempt.body.jobId, randomUUID()]);
    await task.pending;
    const result = ok(await http.call(physical, "read", { runId: task.id }));
    assert.equal(result.artifact_ref, null);
    assert.equal(ok(await http.call(physical, "submit", task.submitted.request), 202).runId, task.id);
    const rows = await noRetry(physical, task.id, 1);
    return { result, rows, fallback: await fallback(physical, task.id) };
  });
  await story("publication-lock-original-expiry", "Real blocking PID/SQL wait after checker admission; original wall deadline prevents publication, retaining checked work/cost", async () => {
    const retainedJobs = (await admin.query("SELECT id,status,claim_fence FROM finnor_os.jobs WHERE status='running'")).rows;
    await artifact("faults/retained-fenced-jobs-before-publication.json", retainedJobs);
    assert.equal((await admin.query("SELECT count(*)::int n FROM finnor_os.r4_attempts WHERE status='SUBMITTED'")).rows[0].n, 0);
    await x.stopWorker(); await x.startWorker();
    const scope = await x.prepareOwnerFixture("r4-publication-" + randomUUID().slice(0, 8), { expiryMs: 20000 });
    const observations = [];
    for (const [target, mode] of [[scope, "EXPIRY"]] as const) {
      const task = await accepted(target, "CHECKER");
      const blocker = new pg.Client({ connectionString: (admin as any).connectionParameters ?
        `postgres://finnor:finnor@127.0.0.1:${(admin as any).connectionParameters.port}/r4_owner` : undefined });
      await blocker.connect(); await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM finnor_os.r4_runs WHERE id=$1 FOR NO KEY UPDATE", [task.id]);
      let waiting;
      try {
        waiting = await until("REAL_PUBLICATION_SQL_WAIT", async () => {
          const rows = (await admin.query("SELECT pid,wait_event_type,wait_event,pg_blocking_pids(pid) blockers,query FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid))>0 AND query LIKE '%r4_runs%FOR UPDATE%'")).rows;
          return rows.find(r => r.blockers.length);
        });
        assert.equal((await attempts(task.id)).find(a => a.kind === "CHECKER")?.status, "COMPLETED");
        const original = (await admin.query("SELECT deadline_at FROM finnor_os.r4_episodes WHERE id=$1", [(await rawRun(task.id)).episode_id])).rows[0].deadline_at;
        await pause(Math.max(0, new Date(original).getTime() - Date.now()) + 50);
        await blocker.query("COMMIT");
      } finally { await blocker.query("ROLLBACK").catch(() => undefined); await blocker.end(); }
      await task.pending;
      const row = await rawRun(task.id), h = await history(target, task.id);
      assert.equal(row.failure, "R4_PUBLICATION_ORIGINAL_DEADLINE_EXHAUSTED", "Must reach actual deadline guard, not the SQL statement timeout");
      assert.equal(row.head_id, null); assert(!h.records.artifacts.some((a: any) => a.kind === "PLAN"));
      assert(h.records.artifacts.some((a: any) => a.kind === "CHECK"));
      const observed = { mode, waiting, row, attempts: await attempts(task.id), fallback: await fallback(target, task.id, false) };
      await artifact("faults/publication-" + mode.toLowerCase() + ".json", observed); observations.push(observed);
    }
    return observations;
  });
  await story("publication-lock-rights-revocation", "Real publication lock wait plus canonical rights revision invalidates the accepted checker claim; history and costs remain after restored access", async () => {
    assert(physical);
    const task = await accepted(physical, "CHECKER"), blocker = new pg.Client({
      connectionString: `postgres://finnor:finnor@127.0.0.1:${(admin as any).connectionParameters.port}/r4_owner` });
    await blocker.connect(); await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["s5-portfolio:" + physical.tenant]);
    let waiting;
    try {
      waiting = await until("RIGHTS_PUBLICATION_SQL_WAIT", async () =>
        (await admin.query("SELECT pid,wait_event_type,wait_event,pg_blocking_pids(pid) blockers,query FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid))>0 AND query LIKE '%pg_advisory_xact_lock%'")).rows[0]);
      assert.equal((await attempts(task.id)).find(a => a.kind === "CHECKER")?.status, "COMPLETED");
      await blocker.query("UPDATE finnor_os.users SET status='suspended' WHERE tenant_id=$1 AND id=$2", [physical.tenant, physical.principal]);
      await blocker.query("COMMIT");
    } finally { await blocker.query("ROLLBACK").catch(() => undefined); await blocker.end(); }
    await task.pending;
    await admin.query("UPDATE finnor_os.users SET status='active' WHERE tenant_id=$1 AND id=$2", [physical.tenant, physical.principal]);
    const row = await rawRun(task.id), h = await history(physical, task.id);
    assert.equal(row.status, "INVALIDATED"); assert.equal(row.head_id, null);
    assert(h.records.artifacts.some((a: any) => a.kind === "CHECK") && !h.records.artifacts.some((a: any) => a.kind === "PLAN"));
    const observed = { waiting, row, attempts: await attempts(task.id), fallback: await fallback(physical, task.id, false) };
    await artifact("faults/publication-rights.json", observed); return observed;
  });
  await story("work-input-resource-population-revisions", "Canonical Work input, actual S5 resource head and S7 population correction invalidate dependent checked output, preserving unrelated tenant/history/cost", async () => {
    if (x.tailOnly) {
      assert.equal((await admin.query("SELECT count(*)::int n FROM finnor_os.jobs WHERE status='running'")).rows[0].n, 0);
      await x.stopWorker(); await x.startWorker();
      delayed = await x.prepareOwnerFixture("r4-resource-" + randomUUID().slice(0, 8));
      delayed.checked = await run(delayed);
      assert.equal(delayed.checked.result.status, "COMPLETE");
    }
    if (x.remainingOnly) {
      expensive.checked = { id: expensive.accepted.runId };
      unsupported = await x.prepareOwnerFixture("r4-population-" + randomUUID().slice(0, 8));
      unsupported.checked = await run(unsupported);
      if (independent === x.fixture) {
        independent = await x.prepareOwnerFixture("r4-untouched-" + randomUUID().slice(0, 8));
        independent.accepted = (await run(independent)).accepted;
      }
    }
    assert(expensive && delayed && unsupported);
    const { receiveWork } = await import("@finnor/db");
    await receiveWork({ tenantId: expensive.tenant, userId: expensive.principal, workId: expensive.work.workId,
      instruction: "Revised original Work input", channel: "console", idempotencyKey: randomUUID(),
      activeContext: { entityRefs: [expensive.root] } });
    assert.equal(ok(await http.call(expensive, "read", { runId: expensive.checked.id })).status, "INVALIDATED");
    const { registerEnterpriseAllocationResource, readEnterpriseAllocation } = await import("@finnor/private-equity");
    const issued = await readEnterpriseAllocation(delayed.ctx, delayed.allocation.certificate.ref);
    const old = issued.problem.resources[0]!, { ref: _ref, revision: _revision, priorRef: _priorRef, ...body } = old;
    const revisedResource = await registerEnterpriseAllocationResource(delayed.ctx, { resource: { ...body,
      availability: body.availability.map((entry: any) => ({ ...entry, amount: "0" })) }, expectedRef: old.ref });
    assert.equal(ok(await http.call(delayed, "read", { runId: delayed.checked.id })).status, "INVALIDATED");
    const { appendEnterpriseEconomicRecord } = await import("@finnor/private-equity");
    const correction = await appendEnterpriseEconomicRecord(unsupported.ctx, { kind: "CORRECTION",
      estimandRefId: unsupported.estimand.ref.id, revisionOf: unsupported.target.ref.id,
      record: { schema: "finnor.r4.s7-query-binding.v1", reason: "Population revision invalidates prior query",
        population: "different-population-v2" }, sourceRefs: [unsupported.model.ref],
      validAt: new Date().toISOString(), idempotencyKey: randomUUID() });
    assert.equal(ok(await http.call(unsupported, "read", { runId: unsupported.checked.id })).status, "INVALIDATED");
    assert.equal(ok(await http.call(independent, "read", { runId: independent.accepted.runId })).status, "COMPLETE");
    const preserved = await Promise.all([history(expensive, expensive.checked.id), history(delayed, delayed.checked.id), history(unsupported, unsupported.checked.id)]);
    assert(preserved.every(h => h.records.artifacts.some((a: any) => a.kind === "PLAN") && h.costs.attempts.length === 2));
    return { revisedResource, correction, oldHistoryRetained: true, unrelatedTenantComplete: true };
  });
  await story("method-replacement-cold-worker-currentness", "Changed owning method bytes invalidate existing profile; exact restoration and cold worker cannot revive terminal claims", async () => {
    assert(physical);
    const path = join(x.repo, "finnor-os/packages/epistemic-runtime/src/identification-plan/producer.py"), preimage = await readFile(path);
    const modified = Buffer.concat([preimage, Buffer.from("\n# Registered disposable method-replacement probe.\n")]);
    try {
      await writeFile(path, modified);
      const result = ok(await http.call(x.fixture, "read", { runId: x.fixture.accepted.runId }));
      assert.equal(result.status, "INVALIDATED");
      await artifact("faults/method-replacement.json", { preimage: hash(preimage), modified: hash(modified), result });
    } finally {
      assert.equal(hash(await readFile(path)), hash(modified), "Restore only this probe's exact owned bytes");
      await writeFile(path, preimage); assert.equal(hash(await readFile(path)), hash(preimage));
    }
    const result = ok(await http.call(x.fixture, "read", { runId: x.fixture.accepted.runId }));
    assert.equal(result.status, "INVALIDATED");
    return { terminalRevivalRefused: true, restorationDigest: hash(preimage), result };
  });
  const fixtureCount = Number((await admin.query("SELECT count(*)::int n FROM finnor_os.tenants WHERE name LIKE 'r4-%'")).rows[0]?.n ?? 0);
  assert(fixtureCount <= 8, "Frozen owner fixture cap");
  const count = Number((await admin.query("SELECT count(*)::int n FROM finnor_os.r4_attempts")).rows[0].n);
  assert(count <= 32, "Frozen native delivery cap");
  await artifact("faults/bounds.json", { fixtureCount, acceptedNativeDeliveries: count, maximum: 32,
    reusedS6Interruption: "NOT_RUN_EXACT_EXISTING_IMMUTABLE_RECEIPT_NOT_FOUND_NO_NEW_SIGNER" });
}
