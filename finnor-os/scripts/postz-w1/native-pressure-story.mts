/** W006/W015: three actual Works compete for one original S5 grant and one
 * native physical permit. No alternative scheduler or fabricated attempt. */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { prepareNativeOwnerFixture } from "./native-stories.mjs";
import { nativeHttpFixture } from "../p7/native-http-fixture.mjs";
import { physicalNativeQueue } from "../p5/native-worker-client.mjs";
import { driveNativeProgram } from "./native-drive.mjs";
import { closeInternalResources, committedEventObserver, internalOwnerCut, registerInternalHandlers,
  siblingInternalProgramme, stageInternalSources, submitInternalSearch } from "./native-internal-support.mjs";

export async function nativePressureStory(e: any) {
  const directory = join(e.evidence, "internal-pressure");
  await mkdir(directory, { recursive: true });
  const artifact = (name: string, value: unknown) => writeFile(join(directory, name),
    JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  const originalPhysical = (await e.admin.query(
    "SELECT * FROM finnor_os.compute_resource_policies WHERE resource_key='native:p2'")).rows[0];
  assert(originalPhysical);
  await e.admin.query(`UPDATE finnor_os.compute_resource_policies
    SET capacity=1,per_tenant_capacity=1,interactive_reserve=0 WHERE resource_key='native:p2'`);
  let observer: Awaited<ReturnType<typeof committedEventObserver>> | undefined;
  let http: any, sourceQueue: any, executionQueue: any, contenderQueue: any, watch: any;
  let report: any = { schema: "finnor.w1.concurrent-native-pressure.v1", status: "FAIL",
    caseIds: ["W006", "W015"], originalPhysical };
  try {
    observer = await committedEventObserver(e); report.observerCatalogue = observer.catalogue;
    const other = randomUUID();
    const f = await prepareNativeOwnerFixture(e, { beforeFit: async owner => {
      await e.admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')",
        [other, owner.tenant, other + "@pressure.example.test"]);
    } });
    f.search.limits = { ...f.search.limits, maxParallel: 1 };
    http = await nativeHttpFixture(e.admin, f.f.tenant, f.f.principal, other);
    sourceQueue = await e.createQueue();
    await registerInternalHandlers(sourceQueue, true);
    executionQueue = await physicalNativeQueue(process.env.FINNOR_P2_WORKER_DATABASE_URL!, directory, "P2",
      { priorityAgingSeconds: 2, leaseSeconds: 30, workloadClass: "INTERACTIVE" });
    await registerInternalHandlers(executionQueue);
    contenderQueue = await physicalNativeQueue(process.env.FINNOR_P2_WORKER_DATABASE_URL!, directory, "P2",
      { priorityAgingSeconds: 2, leaseSeconds: 30, workloadClass: "INTERACTIVE" });
    await registerInternalHandlers(contenderQueue);
    assert.equal(executionQueue.identity.scheduler.priorityAgingSeconds, 2);
    assert.equal(executionQueue.identity.scheduler.workloadClass, "INTERACTIVE");
    const aSearch = await submitInternalSearch(http, f);
    await stageInternalSources(e, sourceQueue, [aSearch]);
    // The deadline belongs to C's original independent submission. It is never
    // rewritten to create an apparent queue miss or reset on a continuation.
    const b = await siblingInternalProgramme(http, f);
    const bSearch = await submitInternalSearch(http, f, b.program.programId);
    await stageInternalSources(e, sourceQueue, [bSearch]);
    const c = await siblingInternalProgramme(http, f, { deadlineMs: 15000 });
    const cSearch = await submitInternalSearch(http, f, c.program.programId);
    await stageInternalSources(e, sourceQueue, [cSearch]);
    const population = [
      { label: "A_CANCELLED_IN_FLIGHT", workId: f.p.workId, programId: f.p.programId, searchId: aSearch },
      { label: "C_ORIGINAL_DEADLINE_MISSED", workId: c.work.workId, programId: c.program.programId, searchId: cSearch },
      { label: "B_UNAFFECTED_PROGRESS", workId: b.work.workId, programId: b.program.programId, searchId: bSearch },
    ];
    report.sourcePreparation = {
      observedAt: new Date().toISOString(),
      searches: (await e.admin.query(`SELECT id,status,reason,program_id,generation
        FROM finnor_os.p2_requests WHERE id=ANY($1::uuid[]) ORDER BY id`, [[aSearch, bSearch, cSearch]])).rows,
      programmes: (await e.admin.query(`SELECT p.id,p.status,p.episode_id,e.deadline_at
        FROM finnor_os.p1_requests p JOIN finnor_os.p1_episodes e ON e.id=p.episode_id
        WHERE p.id=ANY($1::uuid[]) ORDER BY p.id`, [population.map(row => row.programId)])).rows,
      units: (await e.admin.query(`SELECT id,search_id,kind,status,attempts
        FROM finnor_os.p2_units WHERE search_id=ANY($1::uuid[]) ORDER BY search_id,id`, [[aSearch, bSearch, cSearch]])).rows,
      jobs: (await e.admin.query(`SELECT id,type,status,priority,protocol_version,run_at,
        payload->>'searchId' AS search_id FROM finnor_os.jobs
        WHERE payload->>'searchId'=ANY($1::text[]) ORDER BY run_at,id`, [[aSearch, bSearch, cSearch]])).rows,
    };
    await artifact("source-preparation.json", report.sourcePreparation);
    // Disclosed operator-owned queue priorities, fixed before any native claim.
    // No due time, age, deadline, grant, attempt or application result is edited.
    const priorityInputs = [];
    for (const [searchId, priority] of [[aSearch, 300], [cSearch, -100], [bSearch, 200]] as const) {
      const rows = (await e.admin.query(`UPDATE finnor_os.jobs SET priority=$2
        WHERE tenant_id=$3 AND status='queued' AND type='run_compute_search_unit_v1'
          AND protocol_version=3 AND payload->>'searchId'=$1
        RETURNING to_jsonb(jobs) body`, [searchId, priority, f.f.tenant])).rows.map((row: any) => row.body);
      assert(rows.length);
      priorityInputs.push({ searchId, priority, rows });
    }
    const before = await internalOwnerCut(e, f.f.tenant);
    assert.equal(before.p2_attempts.length, 0);
    const cParent = before.p1_requests.find((row: any) => row.id === c.program.programId);
    const cEpisode = before.p1_episodes.find((row: any) => row.id === cParent.episode_id);
    const deadline = Date.parse(cEpisode.deadline_at), targetStart = deadline - 7000;
    assert(Date.now() < targetStart, "Original C source setup must leave a real pressure interval");
    watch = await observer.arm(executionQueue, { tenantId: f.f.tenant, searchId: aSearch,
      kind: "W1_BOUNDARY_CURRENTNESS_CHECKED", boundary: "USE", unitKind: "EXECUTE_P1" });
    await new Promise<void>(resolve => setTimeout(resolve, Math.max(0, targetStart - Date.now())));
    const paused = await watch.drive(), held = await internalOwnerCut(e, f.f.tenant);
    assert(Date.now() < deadline, "Pause must actually precede C's original deadline");
    assert.equal(held.p2_attempts.length, 1, "Only A may have physical intent at the controlled cut");
    assert.equal(held.p2_attempts[0].search_id, aSearch);
    assert.equal(held.p2_attempts[0].status, "SUBMITTED");
    assert.equal(held.leases.filter((row: any) => row.resource_key === "native:p2" &&
      row.released_at === null && Date.parse(row.expires_at) > Date.now()).length, 1);
    assert(held.jobs.some((row: any) => row.status === "queued" && row.payload.searchId === bSearch));
    assert(held.jobs.some((row: any) => row.status === "queued" && row.payload.searchId === cSearch));
    assert(await contenderQueue.tick(), "A separate original worker must actually contest the held permit");
    const contended = await internalOwnerCut(e, f.f.tenant);
    assert.equal(contended.p2_attempts.length, 1, "Capacity refusal cannot create a physical intent or debit");
    const deferred = contended.job_delivery_attempts.filter((row: any) => row.outcome === "capacity_deferred" &&
      contended.jobs.some((job: any) => job.id === row.job_id && job.payload.searchId === cSearch));
    assert.equal(deferred.length, 1, "The genuinely aged lower-priority C must encounter actual native capacity pressure");
    assert(Date.now() < deadline, "Actual contention must precede the original C deadline");
    const cancelled = await http.call("economic-orchestration-cancel", { searchId: aSearch });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled));
    const cancellationCut = await internalOwnerCut(e, f.f.tenant);
    assert.equal(cancellationCut.p2_requests.find((row: any) => row.id === aSearch).status, "CANCELLED");
    assert.equal(cancellationCut.p2_attempts.length, 1);
    assert.equal(cancellationCut.p2_attempts[0].status, "SUBMITTED");
    assert.deepEqual(cancellationCut.p2_grant_usage, held.p2_grant_usage);
    const wait = deadline + 50 - Date.now();
    assert(wait >= 0 && wait < 7500, "Retain the original configured physical/queue lease during pressure");
    await new Promise<void>(resolve => setTimeout(resolve, wait));
    const expiredWhileHeld = await internalOwnerCut(e, f.f.tenant);
    assert(Date.parse(expiredWhileHeld.observedAt) > deadline);
    assert.equal(expiredWhileHeld.p2_attempts.length, 1);
    await watch.release(); watch = null;
    const afterRelease = await internalOwnerCut(e, f.f.tenant);
    // The earlier C-first capacity-deferred delivery proves actual aging.
    // Its owner-controlled backoff may change subsequent fair order. Retain a
    // second actual delivery after C's original deadline, not just a clock read.
    const order: any[] = [];
    for (let decision = 0; decision < 32; decision++) {
      const ran = await executionQueue.tick();
      const cut = await internalOwnerCut(e, f.f.tenant);
      const deliveries = cut.job_delivery_attempts.filter((row: any) =>
        [bSearch, cSearch].some(id => cut.jobs.some((job: any) =>
          job.id === row.job_id && job.payload.searchId === id)));
      order.push({ decision, cut });
      if (deliveries.some((row: any) => Date.parse(row.started_at) > deadline &&
          cut.jobs.some((job: any) => job.id === row.job_id && job.payload.searchId === cSearch))) break;
      if (decision === 31) throw Error("W1_ORIGINAL_EXPIRED_DELIVERY_NOT_OBSERVED");
      if (!ran) await new Promise<void>(resolve => setTimeout(resolve, 2050));
    }
    const missed = await internalOwnerCut(e, f.f.tenant);
    assert.equal(missed.p2_attempts.filter((row: any) => row.search_id === cSearch).length, 0);
    const cCancelledAfterMiss = await http.call("economic-orchestration-cancel", { searchId: cSearch });
    assert.equal(cCancelledAfterMiss.status, 200, JSON.stringify(cCancelledAfterMiss));
    assert.equal(await driveNativeProgram(e.admin, executionQueue, b.program.programId, performance.now()), "TESTED");
    const unaffected = await http.call("program-read", { programId: b.program.programId });
    assert.equal(unaffected.status, 200, JSON.stringify(unaffected));
    assert.equal(unaffected.body.program.result.values.netEquity.value, "43");
    assert.equal(unaffected.body.program.result.values.leverage.value, "3.5");
    const terminal = await internalOwnerCut(e, f.f.tenant);
    const observations = { schema: report.schema, population, priorityInputs,
      originalGrant: f.search.computeGrant, originalBinding: before.p2_requests[0].binding,
      scheduler: executionQueue.identity.scheduler, contenderIdentity: contenderQueue.identity,
      before, paused, held, contended, cancelled, cancellationCut,
      expiredWhileHeld, afterRelease, order, missed, cCancelledAfterMiss, unaffected, terminal,
      qualification: "ACTUAL_CONFIGURED_QUEUE_AGING_NOT_DEFAULT_WAIT_TIME_OR_ECONOMIC_SUPERIORITY",
      costs: { usd: null, completeChildUsage: null, missingCostIsZero: false },
      noDueTimeOrDeadlineMutation: true };
    await artifact("owner-observations.json", observations);
    const oracle = spawnSync(process.env.FINNOR_TEST_PYTHON!,
      [join(e.repo, "finnor-os/scripts/postz-w1/native-pressure-oracle.py"),
        join(directory, "owner-observations.json"), join(directory, "independent-oracle.json")],
      { encoding: "utf8", timeout: 30000, maxBuffer: 65536 });
    await artifact("oracle-process.json", { status: oracle.status, signal: oracle.signal, stdout: oracle.stdout, stderr: oracle.stderr });
    assert.equal(oracle.status, 0, oracle.stderr || oracle.stdout);
    report = { ...report, status: "PASS_LOCAL_OWNER_CONSERVATION_AND_QUEUE_PRESSURE",
      population, scheduler: executionQueue.identity.scheduler,
      independentOracle: join(directory, "independent-oracle.json"), observations: join(directory, "owner-observations.json"),
      billingUSD: null, completeCostQualified: false, economicsQualified: false, originalGrantRenewed: false };
    return { directory, report };
  } catch (error) { report.failure = String(error); report.stack = (error as Error).stack; throw error; }
  finally {
    try { await closeInternalResources(report, [
      () => watch?.release(), () => contenderQueue?.close(), () => executionQueue?.close(),
      () => sourceQueue?.close(), () => http?.close(), () => observer?.close(),
      () => e.admin.query(`UPDATE finnor_os.compute_resource_policies
          SET capacity=$1,per_tenant_capacity=$2,interactive_reserve=$3 WHERE resource_key='native:p2'`,
          [originalPhysical.capacity, originalPhysical.per_tenant_capacity, originalPhysical.interactive_reserve]),
    ]); } finally { await artifact("results.json", report); }
  }
}
