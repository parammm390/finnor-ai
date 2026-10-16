import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { lstat, open, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { fingerprintFixture } from './compatibility-fingerprint.mts';

const repo = resolve(import.meta.dirname, '../../..');
const registration = process.argv[process.argv.indexOf('--registration') + 1];
assert(registration && registration.startsWith('/'), 'Exact registered absolute plan required');
const plan = JSON.parse(await readFile(registration, 'utf8'));
assert.equal(plan.driver, 'compatibility');
assert(['old-worker', 'current-worker'].includes(plan.case));
assert.equal(plan.repositoryMode, 'compatibility');
assert(plan.upgradeMode === undefined || plan.upgradeMode === 'paused-inflight');
const inflight = plan.upgradeMode === 'paused-inflight';
assert.equal(plan.assignedCases.includes('COMPAT-live-original-worker-charged-before-DDL'), inflight);
const out = join(repo, plan.outputRelative);
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const artifact = async (name: string, value: unknown) =>
  writeFile(join(out, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const copies = await readJson(plan.databaseCopiesReceipt);
assert.equal(sha(await readFile(plan.databaseCopiesReceipt)), plan.databaseCopiesReceiptSha256);
assert.equal(copies.status, 'PASS_TWO_BYTE_IDENTICAL_STOPPED_FIXTURE_COPIES');
const directory = copies.destinations[plan.case === 'old-worker' ? 0 : 1];
const generation = resolve(repo, plan.generationRelative
  ?? 'scope-v/v5-living-investment-firm/evidence/compatibility-generation-001');
assert(generation.startsWith(join(repo, 'scope-v/v5-living-investment-firm/evidence') + '/'));
const generationInputs = ['queue-and-evaluation-final.json', 'owner-http-observations.json', 'results.json'];
for (const name of generationInputs) {
  assert.equal(sha(await readFile(join(generation, name))), plan.generationInputsSha256[name]);
}
assert.equal((await lstat(directory)).uid, process.getuid!());
assert.equal(await lstat(join(directory, 'postmaster.pid')).then(() => true, () => false), false);
for (const member of copies.sourceFiles) {
  const path = join(directory, member.path);
  assert(!(await lstat(path)).isSymbolicLink());
  assert.equal(sha(await readFile(path)), member.sha256, 'Untouched stopped original copy:' + member.path);
}
const retained = await readJson(join(generation, 'queue-and-evaluation-final.json'));
assert.equal(retained.physicalWorker, null);
assert.equal(retained.evaluations.length, 2);
assert.equal(retained.jobs.length, 2);
const ids: string[] = retained.evaluations.map((row: any) => row.id).sort();
const jobIds: string[] = retained.jobs.map((row: any) => row.id).sort();
const originalStore = join(copies.source, 'owner-artifacts');
Object.assign(process.env, {
  FINNOR_ENVIRONMENT: 'staging', P3_DISABLE_PROACTIVE_SCHEDULER: '1',
  FINNOR_WORKLOAD_CLASS: 'INTERACTIVE', PG_POOL_MAX: '1',
  FINNOR_TEST_MANAGED_EXTENSIONS: 'omit', AUTH_DEV_BYPASS: '0',
  FINNOR_ALLOW_STAGING_COMPUTE_CAPACITY: '1', LOG_LEVEL: 'info',
  FINNOR_S3_MODEL_STORE: join(originalStore, 's3'), FINNOR_S4_POLICY_STORE: join(originalStore, 's4'),
  FINNOR_S4_PYTHON: process.env.FINNOR_S3_PYTHON!,
});
const port = await new Promise<number>((yes, no) => {
  const server = createServer(); server.once('error', no);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address(); assert(address && typeof address !== 'string');
    server.close(() => yes(address.port));
  });
});
const adminPassword = process.env.FINNOR_COMPAT_ADMIN_PASSWORD;
const appPassword = process.env.FINNOR_COMPAT_APP_PASSWORD;
assert(adminPassword && appPassword, 'Exact retained fixture credentials must be supplied through FINNOR_COMPAT_ADMIN_PASSWORD and FINNOR_COMPAT_APP_PASSWORD');
const postgres = new EmbeddedPostgres({ databaseDir: directory, user: 'finnor', password: adminPassword,
  port, persistent: true, postgresFlags: ['-c', 'listen_addresses=127.0.0.1'], onLog: () => undefined });
const adminUrl = `postgres://finnor:${encodeURIComponent(adminPassword)}@127.0.0.1:${port}/v5_development`;
process.env.DATABASE_URL = `postgres://finnor_app:${encodeURIComponent(appPassword)}@127.0.0.1:${port}/v5_development`;
const admin = new pg.Client({ connectionString: adminUrl });
const results: any[] = [], children: ChildProcess[] = [];
type ProcessIdentity = { pid: number; ppid: number; birth: string; state: string };
type NativePause = { processes: ProcessIdentity[]; started: number; automaticResume: boolean;
  resumed: boolean; resumeError?: string; elapsedMs?: number; timer?: ReturnType<typeof setTimeout> };
const workerBirths = new Map<number, string>();
let nativePause: NativePause | undefined, preUpgradeWorker: ChildProcess | undefined;
let pausedRows: Awaited<ReturnType<typeof fingerprintFixture>> | undefined;
let initialized = false;
const save = () => artifact('results.json', { cases: results, qualification: plan.qualification,
  sourceFixture: copies.source, counterfactualDatabaseCopy: directory });
async function story(id: string, run: () => Promise<unknown>) {
  const started = performance.now();
  try { results.push({ id, status: 'PASS', observed: await run(), elapsedMs: performance.now() - started }); }
  catch (error) {
    results.push({ id, status: 'FAIL', predicate: (error as Error).message,
      stack: (error as Error).stack, elapsedMs: performance.now() - started });
    throw error;
  } finally { await save(); }
}
async function state() {
  const evaluations = (await admin.query(`SELECT e.*,c.original_budget,c.owner_vector original_owner_vector,
    c.delivery_session_id,c.charged,c.cost_refs,c.result_private
    FROM finnor_os.v5_evaluations e JOIN finnor_os.v5_evaluation_custody c
    ON c.evaluation_id=e.id AND c.tenant_id=e.tenant_id WHERE e.id=ANY($1::uuid[]) ORDER BY e.id`, [ids])).rows;
  const jobs = (await admin.query(`SELECT id,type,payload,idempotency_key,lane,protocol_version,retry_safety,
    max_attempts,status,attempts,claim_fence,accepted_at,completed_at,last_error
    FROM finnor_os.jobs WHERE id=ANY($1::uuid[]) ORDER BY id`, [jobIds])).rows;
  const deliveries = (await admin.query(`SELECT id,job_id,claim_fence,protocol_version,retry_safety,outcome,
    started_at,finished_at,failure_kind FROM finnor_os.job_delivery_attempts
    WHERE job_id=ANY($1::uuid[]) ORDER BY job_id,claim_fence`, [jobIds])).rows;
  const usage = (await admin.query(`SELECT tenant_id,principal_id,grant_digest,resource_id,spent
    FROM finnor_os.p2_grant_usage ORDER BY tenant_id,principal_id,grant_digest,resource_id`)).rows;
  const noCashReservation = (await admin.query(`SELECT NOT EXISTS(
    SELECT 1 FROM finnor_os.s5_reservations r CROSS JOIN LATERAL jsonb_array_elements(r.envelopes) e
    CROSS JOIN LATERAL jsonb_array_elements_text(e->'quantities') q
    WHERE r.status<>'RELEASED' AND e->>'resourceId'='cash' AND q.value::numeric<>0) value`)).rows[0].value;
  const dispatches = (await admin.query('SELECT count(*)::int n FROM finnor_os.v5_dispatch_refs')).rows[0].n;
  return { evaluations, jobs, deliveries, usage, noCashReservation, dispatches };
}
async function waitFor<T>(read: () => Promise<T | undefined>, description: string, milliseconds = 120000): Promise<T> {
  const end = performance.now() + milliseconds;
  while (performance.now() < end) {
    const found = await read(); if (found !== undefined) return found;
    await sleep(200);
  }
  throw Error('FINITE_WAIT_EXHAUSTED:' + description);
}
function processes() {
  const rows = new Map<number, ProcessIdentity>();
  for (const line of execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,state='],
    { encoding: 'utf8', timeout: 1000 }).trim().split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 8) continue;
    const row = { pid: Number(fields[0]), ppid: Number(fields[1]), birth: fields.slice(2, 7).join(' '), state: fields[7]! };
    rows.set(row.pid, row);
  }
  return rows;
}
function resumeNative(pause = nativePause) {
  if (!pause || pause.resumed) return;
  const current = processes();
  // Resume descendants before the controller, checking the captured birth.
  for (const row of [...pause.processes].reverse()) {
    if (current.get(row.pid)?.birth === row.birth) {
      try { process.kill(row.pid, 'SIGCONT'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
  }
  pause.resumed = true; pause.elapsedMs = performance.now() - pause.started;
  clearTimeout(pause.timer);
}
async function workerConnections() {
  return (await admin.query(`SELECT pid,state,xact_start FROM pg_stat_activity
    WHERE usename='v5_worker' AND datname=current_database() ORDER BY pid`)).rows;
}
async function pauseRunningWorker(worker: ChildProcess) {
  const pid = worker.pid!, root = processes().get(pid);
  assert(root && root.birth === workerBirths.get(pid) && worker.exitCode === null && worker.signalCode === null,
    'Original spawned worker identity is still live');
  const pause: NativePause = { processes: [root], started: performance.now(), resumed: false, automaticResume: false };
  nativePause = pause;
  pause.timer = setTimeout(() => {
    pause.automaticResume = true;
    try { resumeNative(pause); } catch (error) { pause.resumeError = (error as Error).message; }
  }, 8000);
  assert(worker.kill('SIGSTOP'), 'Stop only the actual spawned worker');
  for (let pass = 0; pass < 4; pass++) {
    const current = processes(), descendants = new Set([pid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of current.values()) if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
        descendants.add(row.pid); changed = true;
      }
    }
    for (const id of descendants) {
      if (pause.processes.some(row => row.pid === id)) continue;
      const row = current.get(id)!;
      assert(processes().get(id)?.birth === row.birth, 'Descendant birth must still match');
      try { process.kill(id, 'SIGSTOP'); pause.processes.push(row); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    const stopped = processes();
    const finalDescendants = new Set([pid]);
    changed = true;
    while (changed) {
      changed = false;
      for (const row of stopped.values()) if (finalDescendants.has(row.ppid) && !finalDescendants.has(row.pid)) {
        finalDescendants.add(row.pid); changed = true;
      }
    }
    if (stopped.get(pid)?.birth === root.birth && [...finalDescendants].every(id =>
      pause.processes.some(row => row.pid === id && row.birth === stopped.get(id)?.birth)
      && /^[TZ]/.test(stopped.get(id)!.state))) return pause;
    await sleep(20);
  }
  throw Error('Owned native descendants did not reach a stopped checkpoint');
}
async function startWorker(name: string) {
  const logPath = join(out, name), file = await open(logPath, 'wx', 0o600);
  const child = spawn(process.execPath, ['--import=tsx', 'apps/worker/src/index.ts'], {
    cwd: join(repo, 'finnor-os'), env: { ...process.env,
      DATABASE_URL: `postgres://v5_worker:v5-worker-disposable@127.0.0.1:${port}/v5_development` },
    stdio: ['ignore', file.fd, file.fd],
  });
  children.push(child); await file.close();
  await waitFor(async () => {
    assert(child.exitCode === null && child.signalCode === null, 'Actual production worker exited before readiness');
    return (await readFile(logPath, 'utf8')).includes('"worker_started"') ? true : undefined;
  }, 'actual production worker readiness');
  if (inflight) {
    const identity = processes().get(child.pid!); assert(identity, 'Spawned production worker has a birth identity');
    workerBirths.set(child.pid!, identity.birth);
  }
  return child;
}
async function stopWorker(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(yes => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => { clearTimeout(timer); yes(); }); child.kill('SIGTERM');
  });
}
const immutable = ['v5_sessions', 'v5_branches', 'v5_branch_custody', 'v5_consequence_grants', 'v5_commands',
  'work_inputs', 'work_entity_links', 's5_proposals', 's5_reservation_origins', 's5_reservations',
  's5_resources', 's5_resource_heads', 'employee_actor_profiles', 'employee_role_assignments', 'role_authority_grants'];
let before: Awaited<ReturnType<typeof state>>;
let originalRows: Awaited<ReturnType<typeof fingerprintFixture>>;
try {
  await postgres.start(); initialized = true; await admin.connect();
  await story('COMPAT-old-180-accepted-original-fixture-readback', async () => {
    assert.equal((await admin.query('SELECT count(*)::int n FROM finnor_os._migrations')).rows[0].n, 180);
    before = await state();
    assert.equal(before.evaluations.length, 2); assert.equal(before.jobs.length, 2);
    assert(before.evaluations.every(row => row.status === 'ACCEPTED' && !row.charged && row.cost_refs.length === 0
      && row.original_budget && Date.parse(row.original_budget.deadlineAt) > Date.now()));
    assert(before.jobs.every(row => row.status === 'queued' && row.protocol_version === 1
      && row.attempts === 0 && Number(row.claim_fence) === 0));
    assert.equal(before.deliveries.length, 0); assert(before.noCashReservation); assert.equal(before.dispatches, 0);
    const commands = (await admin.query(`SELECT principal_id,session_id,operation,request_digest,result
      FROM finnor_os.v5_commands WHERE operation='evaluate' ORDER BY result->>'evaluationId'`)).rows;
    assert.deepEqual(commands.map(row => row.result.evaluationId).sort(), ids);
    for (const command of commands) {
      const evaluation = before.evaluations.find(row => row.id === command.result.evaluationId)!;
      assert.equal(command.result.jobId, evaluation.job_id);
      assert.equal(command.principal_id, evaluation.principal_id); assert.equal(command.session_id, evaluation.session_id);
    }
    const http = await readJson(join(generation, 'owner-http-observations.json'));
    assert(http.filter((row: any) => row.path === '/api/live-controls' && row.status === 200 && row.verifiedBearer).length >= 2);
    originalRows = await fingerprintFixture(admin);
    if (plan.expectedOriginalRows) {
      assert.equal(sha(await readFile(plan.expectedOriginalRows)), plan.expectedOriginalRowsSha256);
      const expected = await readJson(plan.expectedOriginalRows);
      assert.equal(originalRows.sha256, expected.sha256, 'Both copies retain the same original application rows');
    }
    await artifact('original-row-fingerprints.json', originalRows);
    await artifact('original-accepted-state.json', before);
    return { evaluationIds: ids, jobIds, commands, applicationRowDigest: originalRows.sha256,
      loopbackAddress: originalRows.loopbackAddress, originalAddressCast: originalRows.originalAddressCast,
      originalGenerationStatus: (await readJson(join(generation, 'results.json'))).results
        .some((row: any) => row.status === 'FAIL') ? 'FAIL_PRESERVED' : 'PASS',
      noGrantOrDeadlineReset: true };
  });
  if (inflight) await story('COMPAT-live-original-worker-charged-before-DDL', async () => {
    preUpgradeWorker = await startWorker('production-worker-before-DDL.log');
    const end = performance.now() + 30000;
    const samples: unknown[] = [];
    try {
      while (performance.now() < end && samples.length < 4000) {
        const rows = (await admin.query(`SELECT e.id,e.status,c.charged,
          jsonb_array_length(c.cost_refs) cost_ref_count,j.status job_status,j.attempts,j.claim_fence,
          (SELECT coalesce(jsonb_agg(jsonb_build_object('pid',a.pid,'state',a.state,'xact_start',a.xact_start)),'[]'::jsonb)
            FROM pg_stat_activity a WHERE a.usename='v5_worker' AND a.datname=current_database()) connections
          FROM finnor_os.v5_evaluations e JOIN finnor_os.v5_evaluation_custody c
            ON c.evaluation_id=e.id AND c.tenant_id=e.tenant_id
          JOIN finnor_os.jobs j ON j.id=e.job_id AND j.tenant_id=e.tenant_id
          WHERE e.id=ANY($1::uuid[]) ORDER BY e.id`, [ids])).rows;
        samples.push({ atMonotonicMs: performance.now(), rows });
        const connections = rows[0]?.connections ?? [];
        const running = rows.some(row => row.status === 'RUNNING' && row.charged && row.cost_ref_count === 1
          && row.job_status === 'running' && row.attempts === 1 && Number(row.claim_fence) === 1);
        if (running && connections.length && connections.every((row: any) => row.state === 'idle' && row.xact_start === null)) {
          const pause = await pauseRunningWorker(preUpgradeWorker);
          const frozen = await state(), idle = await workerConnections();
          const accepted = frozen.evaluations.some(row => row.status === 'RUNNING' && row.charged
            && row.cost_refs.length === 1 && frozen.jobs.some(job => job.id === row.job_id
              && job.status === 'running' && job.attempts === 1 && Number(job.claim_fence) === 1));
          if (accepted && idle.length && idle.every(row => row.state === 'idle' && row.xact_start === null)) {
            assert(!pause.automaticResume && !pause.resumed);
            pausedRows = await fingerprintFixture(admin);
            await artifact('paused-inflight-row-fingerprints.json', pausedRows);
            await artifact('genuine-inflight-before-DDL.json', { workerPid: preUpgradeWorker.pid,
              processes: pause.processes, frozen, databaseConnections: idle, noDatabaseTransactionHeld: true,
              originalClocksAndDeadlinesContinue: true });
            return { actualWorkerPid: preUpgradeWorker.pid, runningChargedOriginalJobObserved: true,
              applicationTableCount: pausedRows.tableCount, pauseAssistedNotUninterrupted: true };
          }
          resumeNative(pause);
        }
        await sleep(10);
      }
      throw Error('No genuine RUNNING charged transaction-free native checkpoint before DDL');
    } finally {
      await artifact('inflight-checkpoint-observations.json', { samples, maximumSamples: 4000,
        checkpointWaitMs: 30000, pollingSleepMs: 10, productionWorkerUnmodified: true });
    }
  });
  await story('COMPAT-populated-180-to-182-immutable-row-and-bundle-replay', async () => {
    const pause = nativePause;
    const migrationUrl = new URL(adminUrl);
    if (inflight) {
      assert(pause && pausedRows && !pause.resumed && !pause.automaticResume);
      migrationUrl.searchParams.set('options', '-c statement_timeout=5000 -c lock_timeout=2000');
    }
    try {
      assert.equal(sha(await readFile(plan.bundlePath)), plan.bundleSha256);
      const { MIGRATIONS } = await import(pathToFileURL(plan.bundlePath).href);
      assert.equal(MIGRATIONS.length, 182);
      const { migrate } = await import('../../packages/db/migrate');
      const target = inflight ? migrationUrl.href : adminUrl;
      const applied = plan.case === 'old-worker' ? await migrate(target, MIGRATIONS) : await migrate(target);
      assert.deepEqual(applied, ['0178_closing_evidence_custody_composition.sql', '0179_closing_primary_profile_custody.sql']);
      const replay = await migrate(target, MIGRATIONS), restart = await migrate(target, MIGRATIONS);
      assert.deepEqual(replay, []); assert.deepEqual(restart, []);
      assert.equal((await admin.query('SELECT count(*)::int n FROM finnor_os._migrations')).rows[0].n, 182);
      const after = await fingerprintFixture(admin); assert.deepEqual(after.tables, (pausedRows ?? originalRows).tables);
      if (pause) {
        resumeNative(pause);
        assert(!pause.automaticResume && !pause.resumeError && pause.resumed && pause.elapsedMs! < 10000,
          'Bounded intentional resume, never clock subtraction');
      }
      await artifact('post-migration-row-fingerprints.json', after);
      return { applied, replay, restart, originalApplicationTables: after.tableCount,
        originalApplicationRowsUnchanged: true, baseline: inflight ? 'GENUINE_RUNNING_PHYSICALLY_PAUSED' : 'ORIGINAL_QUEUED',
        pauseElapsedMs: pause?.elapsedMs, sourceKind: plan.case === 'old-worker' ? 'ACTUAL_BUNDLE' : 'ACTUAL_DIRECTORY_AND_BUNDLE' };
    } finally {
      resumeNative(pause);
      if (pause) await artifact('bounded-native-pause.json', { ...pause, timer: undefined });
    }
  });
  await story('COMPAT-original-two-queued-evaluations-complete', async () => {
    const worker = preUpgradeWorker ?? await startWorker('production-worker-first.log');
    const completed = await waitFor(async () => {
      const current = await state();
      if (current.evaluations.some(row => ['FAILED', 'BLOCKED', 'INVALIDATED', 'UNKNOWN', 'PARTIAL'].includes(row.status))) {
        await artifact('rejected-original-state.json', current);
        throw Error('ORIGINAL_TWO_COMPLETE_ORACLE_REFUSED:' + JSON.stringify(current.evaluations.map(row => ({ id: row.id, status: row.status }))));
      }
      return current.evaluations.every(row => row.status === 'COMPLETE')
        && current.jobs.every(row => row.status === 'completed') ? current : undefined;
    }, 'both original accepted evaluations complete');
    assert.equal(completed.deliveries.length, 2);
    assert(completed.jobs.every(row => row.attempts === 1 && Number(row.claim_fence) === 1));
    assert(completed.deliveries.every(row => row.outcome === 'completed' && Number(row.claim_fence) === 1));
    for (const row of completed.evaluations) {
      const original = before.evaluations.find(other => other.id === row.id)!;
      assert.deepEqual(row.original_budget, original.original_budget);
      assert.equal(row.job_id, original.job_id);
      assert(row.charged && row.result_private && row.cost_refs.length === 1);
      const debit = row.cost_refs[0];
      assert.equal(debit.identity, row.id); assert.equal(debit.refundGranted, false);
      assert.equal(debit.originalDeadlineAt, original.original_budget.deadlineAt);
      const key = (usage: any) => usage.principal_id === row.principal_id
        && usage.grant_digest === debit.grantDigest && usage.resource_id === debit.resourceId;
      const initial = before.usage.find(key), final = completed.usage.find(key);
      assert(final && Number(final.spent) === Number(initial?.spent ?? 0) + 1);
    }
    for (const job of completed.jobs) {
      const original = before.jobs.find(row => row.id === job.id)!;
      for (const name of ['payload', 'idempotency_key', 'protocol_version', 'retry_safety', 'max_attempts']) {
        assert.deepEqual(job[name], original[name]);
      }
    }
    assert(completed.noCashReservation); assert.equal(completed.dispatches, 0);
    const after = await fingerprintFixture(admin);
    for (const name of immutable) {
      assert(originalRows.tables.some(table => table.name === name), 'Required immutable owner table exists:' + name);
      assert.deepEqual(after.tables.find(table => table.name === name), originalRows.tables.find(table => table.name === name), name);
    }
    await artifact('completed-original-state.json', completed); await artifact('post-worker-row-fingerprints.json', after);
    await stopWorker(worker);
    return { evaluationIds: ids, jobIds, immutableOwnerTables: immutable, completedOriginalJobs: 2,
      claimAndDeliveryPerJob: 1, retainedNativeDebitPerEvaluation: 1, noNewCashReservation: true, noDispatch: true };
  });
  await story('COMPAT-worker-restart-no-duplicate-charge-or-effect', async () => {
    const stable = await state(), worker = await startWorker('production-worker-restart.log');
    await sleep(5000);
    assert(worker.exitCode === null && worker.signalCode === null);
    const after = await state(); assert.deepEqual(after, stable);
    await stopWorker(worker);
    assert.equal(sha(await readFile(plan.bundlePath)), plan.bundleSha256);
    for (const name of generationInputs) {
      assert.equal(sha(await readFile(join(generation, name))), plan.generationInputsSha256[name]);
    }
    if (plan.expectedOriginalRows) {
      assert.equal(sha(await readFile(plan.expectedOriginalRows)), plan.expectedOriginalRowsSha256);
    }
    return { actualRestartedWorkerPid: worker.pid, secondsAfterActualReadiness: 5,
      unchangedOriginalJobClaimsAndDeliveriesAndDebitsAndResults: true, newCashReservation: false, newDispatch: false };
  });
} catch (error) {
  if (!results.some(row => row.status === 'FAIL')) results.push({ id: 'compatibility-runtime', status: 'FAIL',
    predicate: (error as Error).message, stack: (error as Error).stack });
} finally {
  try { resumeNative(); } catch (error) {
    results.push({ id: 'compatibility-native-resume', status: 'FAIL',
      predicate: (error as Error).message, ownedProcessIdentities: nativePause?.processes });
    await artifact('native-resume-failure.json', { status: 'FAIL', explicitOwnedProcessRecoveryRequired: true,
      predicate: (error as Error).message, processes: nativePause?.processes });
  }
  for (const child of children) await stopWorker(child);
  if (initialized) {
    await artifact('final-state.json', await state().catch(error => ({ readbackError: String(error) })));
    const { closePool } = await import('../../packages/db'); await closePool();
  }
  await admin.end().catch(() => undefined);
  if (initialized) await postgres.stop();
  await artifact('owned-resource-shutdown.json', { directory, persistent: true,
    children: children.map(child => ({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode })),
    originalGeneratedDatabaseNeverStarted: true });
  await save();
}
const failed = results.some(row => row.status === 'FAIL');
console.log(JSON.stringify({ failed, evidenceDirectory: out, counterfactualDatabaseCopy: directory }));
process.exit(failed ? 1 : 0);
