/** Failure-first native owner story. No API/auth bypass or planted producer head. */
import { strict as assert } from 'node:assert';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, appendFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import {nativeHttpFixture} from './native-http-fixture.mjs';

const repo = resolve(import.meta.dirname, '../../..');
const out = process.env.FINNOR_P7_EVIDENCE_DIR;
if (!out?.startsWith('/')) throw Error('Absolute fresh FINNOR_P7_EVIDENCE_DIR required');
await mkdir(out, { recursive: true });
const results: any[] = [];
const startHistory = process.env.FINNOR_P7_START_HISTORY ?? 'EMPTY';
if (!['EMPTY', 'EXACT_PUBLISHED_S7_INTERRUPTED'].includes(startHistory)) throw Error('Exact supported history required');
const sourcePaths = [
  'finnor-os/packages/private-equity/src/live-recompilation/api.ts',
  'finnor-os/packages/private-equity/src/live-recompilation/contracts.ts',
  'finnor-os/packages/private-equity/src/live-recompilation/worker.ts',
  'finnor-os/scripts/p7/run-native-e2e.mts',
  'finnor-os/scripts/p7/native-submission-child.mts',
  'finnor-os/scripts/p7/native-migration-child.mts',
  'finnor-os/scripts/p7/native-http-fixture.mts',
  'finnor-os/apps/api/app/api/company-brain/[operation]/route.ts',
  'finnor-os/apps/api/lib/auth.ts',
  'finnor-os/packages/security/src/auth.ts',
  'finnor-os/apps/worker/src/index.ts',
  'finnor-os/packages/db/migrations/0162z_completion_c_p7_native.sql',
  'finnor-os/packages/db/migrations-bundle.ts',
  'finnor-os/packages/db/migrate.ts',
  'finnor-os/package-lock.json',
];
async function source() {
  return Promise.all(sourcePaths.map(async path => {
    const bytes = await readFile(join(repo, path)).catch(() => null);
    return { path, sha256: bytes && createHash('sha256').update(bytes).digest('hex') };
  }));
}
const before = await source();
await writeFile(join(out, 'freeze.json'), JSON.stringify({
  node: process.version, before, startHistory, selected: ['normal-worker-registration', 'source-continuation',
    'commit-race', 'principal-boundary', 'physical-intake-crash-recovery', 'authenticated-http-boundary'],
  qualification: 'PUBLIC_NATIVE_OWNER_DEVELOPMENT_NOT_ORIGINAL_GATE_P7',
  independentOracle: 'POSTGRES_NUMERIC_ORIGINAL_FINANCIAL_CONSTANTS', usd: null,
}, null, 2), { flag: 'wx', mode: 0o600 });
async function save() {
  await writeFile(join(out!, 'results.json'), JSON.stringify({
    results, qualification: 'NATIVE_SELECTED_ONLY_NOT_ALL_34_ORIGINAL_FAMILIES', usd: null,
  }, null, 2), { mode: 0o600 });
}
async function story(id: string, fn: () => Promise<unknown>) {
  const started = Date.now();
  try { results.push({ id, status: 'PASS', observed: await fn(), elapsedMs: Date.now() - started }); }
  catch (error) {
    results.push({ id, status: 'FAIL', predicate: String((error as Error).message),
      code: (error as any).code ?? (error as any).cause?.code ?? null, elapsedMs: Date.now() - started });
  }
  await save();
}
let product: any;
try { product = await import('../../packages/private-equity/src/live-recompilation/api'); }
catch (error) {
  results.push({ id: 'native-continuation-entrypoint', status: 'FAIL',
    predicate: 'P7_NATIVE_CONTINUATION_NOT_IMPLEMENTED', code: (error as any).code ?? null });
  await save(); process.exitCode = 1;
}
if (product) {
  const directory = await mkdtemp(join(tmpdir(), 'completion-c-p7-'));
  const port = await new Promise<number>((yes, no) => {
    const server = createServer(); server.once('error', no);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return no(Error('PORT_UNAVAILABLE'));
      server.close(() => yes(address.port));
    });
  });
  const postgres = new EmbeddedPostgres({ databaseDir: directory, user: 'finnor',
    password: 'finnor', port, persistent: true, onLog: () => undefined });
  let admin: pg.Client | undefined;
  let http:Awaited<ReturnType<typeof nativeHttpFixture>>|undefined;
  const tenant = randomUUID(), actor = randomUUID(), company = randomUUID(), otherActor = randomUUID();
  const ctx = { auth: { tenantId: tenant, userId: actor, employeeId: actor, role: 'owner' as const },
    provenance: { sourceSystem: 'completion-c:p7-native-development', createdBy: actor } };
  const root = { entityType: 'external_organization' as const, entityId: company };
  try {
    process.env.NODE_ENV = 'test'; process.env.FINNOR_P4_PROFILE = 'ordinary_disposable';
    process.env.FINNOR_TEST_MANAGED_EXTENSIONS = 'omit'; process.env.LOG_LEVEL = 'silent';
    await postgres.initialise();
    await appendFile(join(directory, 'postgresql.conf'), '\ntrack_commit_timestamp=on\n');
    await postgres.start(); await postgres.createDatabase('p7_native');
    const adminUrl = `postgres://finnor:finnor@127.0.0.1:${port}/p7_native`;
    const { migrate } = await import('../../packages/db/migrate');
    admin = new pg.Client({ connectionString: adminUrl }); await admin.connect();
    const migrationStages: unknown[] = [];
    if (startHistory === 'EXACT_PUBLISHED_S7_INTERRUPTED') {
      const published = 'd8d72f8f37f20761e7cd7d8517b80acaa124115a';
      const originalPaths = execFileSync('git', ['-C', repo, 'ls-tree', '-r', '--name-only',
        published, '--', 'finnor-os/packages/db/migrations'], { encoding: 'utf8' }).trim().split('\n').filter(p => p.endsWith('.sql'));
      const historical = originalPaths.map(path => ({ name: path.split('/').at(-1)!,
        sql: execFileSync('git', ['-C', repo, 'show', published + ':' + path], { encoding: 'utf8', maxBuffer: 8_388_608 }) }));
      for (const file of historical)
        assert.equal(await readFile(join(repo, 'finnor-os/packages/db/migrations', file.name), 'utf8'), file.sql, 'Published migration bytes changed');
      migrationStages.push({ stage: 'GENUINE_PUBLISHED_S7_INSTALLED', published,
        applied: await migrate(adminUrl, historical),
        sql: historical.map(f => ({ name: f.name, sha256: createHash('sha256').update(f.sql).digest('hex') })) });
      const partial = ['0157_completion_p4_evidence_execution.sql', '0158_completion_p3_branch_fabric_candidate.sql',
        '0159_completion_p1_program_synthesis.sql'];
      migrationStages.push({ stage: 'FORWARD_COMMITTED_PREFIX', applied: await migrate(adminUrl,
        await Promise.all(partial.map(async name => ({ name, sql: await readFile(join(repo, 'finnor-os/packages/db/migrations', name), 'utf8') })))) });
      // Hold an actual relation lock, not a runtime fault flag. The normal
      // migration process must block inside an uncommitted forward transaction.
      await admin.query('BEGIN');
      await admin.query('LOCK TABLE finnor_os.p1_requests IN ACCESS EXCLUSIVE MODE');
      const child = spawn(process.execPath, ['--import=tsx', join(import.meta.dirname, 'native-migration-child.mts')],
        { cwd: join(repo, 'finnor-os'), env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
          NODE_ENV: 'test', FINNOR_TEST_MANAGED_EXTENSIONS: 'omit', DATABASE_URL: adminUrl },
        stdio: ['ignore', 'ignore', 'ignore'] });
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((yes, no) => {
        child.once('error', no); child.once('close', (code, signal) => yes({ code, signal }));
      });
      let blocked: { pid: number; backend_xid: string | null; query_start: string } | undefined;
      try {
        for (let i = 0; i < 120; i++) {
          // PostgreSQL caches activity observations inside this lock-holding
          // transaction. Refresh statistics, not the database/relation lock.
          await admin.query('SELECT pg_stat_clear_snapshot()');
          blocked = (await admin.query(`SELECT pid,backend_xid::text,query_start::text FROM pg_stat_activity
            WHERE datname='p7_native' AND pid<>pg_backend_pid() AND wait_event_type='Lock'
              AND state='active' AND query ILIKE '%CREATE TABLE%'`)).rows[0];
          if (blocked) break;
          if (child.exitCode !== null) throw Error('UPGRADE_CHILD_EXITED_BEFORE_REAL_TRANSACTION_WINDOW');
          await new Promise(r => setTimeout(r, 50));
        }
        assert(blocked, 'Genuine migration transaction never reached its relation lock');
      } finally {
        child.kill('SIGKILL');
        await closed;
        await admin.query('ROLLBACK');
      }
      const terminated = await closed;
      assert.equal(terminated.signal, 'SIGKILL');
      assert.equal((await admin.query("SELECT count(*)::int n FROM finnor_os._migrations WHERE name='0161_p2_compute_search.sql'")).rows[0].n, 0);
      assert.equal((await admin.query("SELECT to_regclass('finnor_os.p2_requests')::text partial_table")).rows[0].partial_table, null);
      migrationStages.push({ stage: 'PHYSICAL_UPGRADE_INTERRUPTION', ownedPid: child.pid, blocked, terminated,
        uncommittedP2TableAndTrackerAbsent: true,
        committedTracker: (await admin.query('SELECT name FROM finnor_os._migrations ORDER BY name')).rows });
    }
    migrationStages.push({ stage: 'INSTALLED_FORWARD_AND_RESTART', applied: await migrate(adminUrl),
      restartApplied: await migrate(adminUrl),
      engine: (await admin.query('SELECT version(),current_setting(\'track_commit_timestamp\') commit_clock')).rows,
      completeTracker: (await admin.query('SELECT name FROM finnor_os._migrations ORDER BY name')).rows });
    assert.equal((migrationStages.at(-1) as any).restartApplied.length, 0, 'Migration restart applied duplicate files');
    assert.deepEqual((migrationStages.at(-1) as any).completeTracker.map((r: any) => r.name),
      (await readdir(join(repo, 'finnor-os/packages/db/migrations'))).filter(p => p.endsWith('.sql')).sort(),
      'Installed history does not match the complete release registry');
    await writeFile(join(out, 'migration-installation.json'), JSON.stringify({ startHistory, migrationStages,
      privateHistoriesReconciled: false, qualification: 'SELECTED_HISTORY_MECHANICS_NOT_FINAL_RELEASE' }, null, 2), { flag: 'wx' });
    await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'");
    await admin.query("SET app.test_vertical_mode='explicit'");
    await admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'P7 native development')",
      [tenant, randomUUID()]);
    await admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active'),($4,$2,$5,'owner','active')",
      [actor, tenant, actor + '@test.invalid', otherActor, otherActor + '@test.invalid']);
    await admin.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,'p7-native-company','P7 actual owner fixture','other')",
      [company, tenant]);
    await admin.query("INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,source) VALUES('native:p4',2,2,0,60,'Explicit disposable capacity, not protected funding')");
    process.env.DATABASE_URL = `postgres://finnor_app:finnor_app@127.0.0.1:${port}/p7_native`;
    const db = await import('@finnor/db'); await db.closePool();
    await db.configureTenantVertical({ tenantId: tenant, verticalKey: 'private_equity',
      expectedVersion: 0, createdBy: actor, sourceSystem: 'p7:native-development' });
    const owners = await import('@finnor/private-equity');
    const memory = await import('@finnor/memory');
    const evidenceSource = await memory.createEvidenceSource(tenant, {
      sourceKey: 'p7-native-original', sourceType: 'manual', title: 'Original financial constants',
    });
    const evidenceVersion = await memory.appendEvidenceVersion(tenant, evidenceSource.id, {
      content: 'Price120, EBITDA20, debt70, corrected debt60', snapshot: { price: 120, EBITDA: 20, debt: 70 },
      asOf: new Date('2025-01-01T00:00:00Z'),
    });
    const evidence = { evidenceSourceId: evidenceSource.id, evidenceVersionId: evidenceVersion.versionId };
    async function correctDebt(value: string) {
      const corrected = await owners.restateMetricObservation(ctx, {
        priorObservationId: debtObservation, expectedVersion: 1,
        replacement: { value: { type: 'number', value }, evidence },
      });
      debtObservation = String(corrected.row.id);
    }
    const periodStart = '2025-01-01T00:00:00.000Z', periodEnd = '2025-12-31T00:00:00.000Z';
    let debtObservation = '';
    for (const [key, value] of Object.entries({ price: '120', debt: '70', EBITDA: '20' })) {
      const series = await owners.createMetricSeries(ctx, { subjectType: root.entityType,
        subjectId: company, metricKey: key, name: key, unit: 'currency', currencyCode: 'USD', frequency: 'annual' });
      const row = await owners.recordMetricObservation(ctx, { metricSeriesId: String(series.row.id),
        periodStart: new Date(periodStart), periodEnd: new Date(periodEnd),
        value: { type: 'number', value }, evidence });
      if (key === 'debt') debtObservation = String(row.row.id);
    }
    const { submitHarnessProgram } = await import('../../packages/private-equity/src/program-synthesis/api');
    const { readCurrentProgram } = await import('../../packages/private-equity/src/program-synthesis/store');
    const { JobQueue } = await import('../../apps/worker/src/queue');
    const p4Worker = await import('../../packages/private-equity/src/evidence-execution/worker');
    const contracts = (await import('@finnor/db')).PRODUCTION_JOB_CONTRACTS;
    function queue(name: string) {
      const q = new JobQueue(name, 3);
      q.register('run_evidence_derivation_v1', p4Worker.runEvidenceDerivationJob, contracts.run_evidence_derivation_v1);
      return q;
    }
    const p1Worker = await import('../../packages/private-equity/src/program-synthesis/worker');
    const p7Worker = await import('../../packages/private-equity/src/live-recompilation/worker');
    function joinedQueue(name: string) {
      const q = queue(name);
      q.register('run_harness_program_v1', p1Worker.runHarnessProgramJob, contracts.run_harness_program_v1);
      q.register('run_programme_continuation_v1', p7Worker.runProgrammeContinuationJob,
        contracts.run_programme_continuation_v1);
      return q;
    }
    let worker = joinedQueue('completion-c-p7-first-worker');
    const normalEntry: { factory?: () => InstanceType<typeof JobQueue> } = {};
    await story('normal-worker-registration', async () => {
      const { createWorker } = await import('../../apps/worker/src/index');
      const normal = createWorker();
      for (const type of ['run_evidence_derivation_v1', 'run_harness_program_v1', 'run_programme_continuation_v1'])
        assert(normal.registeredTypes().includes(type), 'NORMAL_WORKER_CONTINUATION_HANDLER_MISSING');
      normalEntry.factory = createWorker; worker = normal;
      return { registered: normal.registeredTypes(), normalEntry: 'apps/worker/src/index.ts:createWorker' };
    });
    async function completed(id: string) {
      for (let i = 0; i < 60; i++) {
        await worker.tick();
        const value = await readCurrentProgram(ctx, id);
        if (['TESTED', 'FAILED', 'INVALIDATED', 'PARTIAL'].includes(value.status)) return value;
        await new Promise(r => setTimeout(r, 100));
      }
      throw Error('REAL_P1_QUEUE_DID_NOT_COMPLETE');
    }
    const input = (key: string) => ({ kind: 'input', key });
    const request = () => ({
      schema: 'finnor.harness-request.v1', instruction: 'Calculate source-bound equity and leverage in a draft. No approval or effect.',
      root, validAt: '2026-01-01T00:00:00.000Z', mode: 'ordinary_disposable',
      idempotencyKey: randomUUID(), limits: { maxAttempts: 8, maxCandidates: 8 },
      sources: ['price', 'debt', 'EBITDA'].map(key => ({ key, source: { kind: 'metric', subject: root,
        metricKey: key, periodStart, periodEnd, unit: 'currency', currencyCode: 'USD', frequency: 'annual',
        calendar: 'OWNER_RECORDED', consolidation: 'OWNER_SUBJECT_ONLY', instrument: 'UNSPECIFIED',
        scale: '1', sign: 'AS_RECORDED' } })),
      acceptance: { requiredSourceKeys: ['price', 'debt', 'EBITDA'], targets: [
        { key: 'equity', expression: { kind: 'subtract', left: input('price'), right: input('debt') }, unit: 'currency', currencyCode: 'USD' },
        { key: 'leverage', expression: { kind: 'ratio', left: input('debt'), right: input('EBITDA') }, unit: 'multiple', currencyCode: null },
      ], deliverable: { kind: 'analytical_draft', title: 'Current source-bound equity and leverage' } },
    });
    http=await nativeHttpFixture(admin,tenant,actor,otherActor);
    await story('authenticated-http-boundary',async()=>{
      const absent={continuationId:randomUUID()};
      const anonymous=await http!.call('continuation-read',absent,'anonymous');
      assert.equal(anonymous.status,401,JSON.stringify(anonymous));
      const invalid=await http!.call('continuation-read',absent,'invalid');
      assert.equal(invalid.status,401,JSON.stringify(invalid));
      const malformed=await http!.call('continuation-submit',{priorProgramId:randomUUID(),principalId:actor,claimFence:1});
      assert.equal(malformed.status,400,JSON.stringify(malformed));
      return {anonymous,invalid,malformed,transport: 'LOCAL_SIGNED_BEARER_ACTUAL_USER_LOOKUP_NOT_HOSTED_AUTH'};
    });
    await story('source-continuation', async () => {
      const first = await submitHarnessProgram(ctx, request()), original = await completed(first.programId);
      assert.equal(original.status, 'TESTED', JSON.stringify(original));
      assert.equal(original.program!.result!.values.equity!.value, '50');
      await correctDebt('60');
      const foreign=await http!.call('continuation-submit',{priorProgramId:first.programId},'other');
      assert.equal(foreign.status,404,JSON.stringify(foreign));
      const submitted=await http!.call('continuation-submit',{priorProgramId:first.programId});
      assert.equal(submitted.status,202,JSON.stringify(submitted));
      const accepted=submitted.body;
      const replay=await http!.call('continuation-submit',{priorProgramId:first.programId});
      assert.equal(replay.status,202,JSON.stringify(replay));
      const duplicate=replay.body;
      assert.equal(accepted.continuationId, duplicate.continuationId);
      const pending = await product.readContinuation(ctx, accepted.continuationId);
      assert.equal(pending.state, 'ACCEPTED');
      assert.equal(pending.affectedNodes.length, original.program!.graph.length);
      assert.equal((await readCurrentProgram(ctx, first.programId)).program, null);
      worker = normalEntry.factory ? normalEntry.factory() : joinedQueue('completion-c-p7-adopting-worker');
      let current: any;
      for (let i = 0; i < 90; i++) {
        await worker.tick(); current = await product.readContinuation(ctx, accepted.continuationId);
        if (['PUBLISHED', 'FAILED', 'SUPERSEDED'].includes(current.state)) break;
        await new Promise(r => setTimeout(r, 100));
      }
      if (current.state !== 'PUBLISHED') {
        const trace = (await admin!.query('SELECT kind,body FROM finnor_os.p7_events WHERE continuation_id=$1 ORDER BY created_at,id',
          [accepted.continuationId])).rows;
        await writeFile(join(out!, 'failed-continuation-trace.json'), JSON.stringify({ current, trace }, null, 2));
        throw Error(JSON.stringify({ state: current.state, reason: current.reason, trace }));
      }
      const next = await readCurrentProgram(ctx, current.nextProgramId);
      assert.equal(next.status, 'TESTED', JSON.stringify(next));
      const independent = (await admin!.query('SELECT 120::numeric-60::numeric equity,60::numeric/20::numeric leverage')).rows[0];
      assert.equal(next.program!.result!.values.equity!.value, independent.equity);
      assert.equal(Number(next.program!.result!.values.leverage!.value), Number(independent.leverage));
      assert.equal(next.program!.bounds.episodeId, original.program!.bounds.episodeId);
      assert.equal(next.program!.bounds.deadlineAt, original.program!.bounds.deadlineAt);
      const publications = (await admin!.query('SELECT count(*)::int n FROM finnor_os.p7_manifests WHERE continuation_id=$1',
        [accepted.continuationId])).rows[0].n;
      assert.equal(publications, 1);
      const reloaded=await http!.call('continuation-read',{continuationId:accepted.continuationId});
      assert.equal(reloaded.status,200,JSON.stringify(reloaded));
      assert.equal(reloaded.body.patch.publication.contentDigest,current.patch.publication.contentDigest);
      const projection=await http!.call('continuation-projection',{root,workId:first.workId});
      assert.equal(projection.status,200,JSON.stringify(projection));
      assert.equal(projection.body.continuations[0].continuationId,accepted.continuationId);
      return { first, accepted, duplicate, pending, current, independent,
        foreign,reloaded,projection,originalEpisode: original.program!.bounds, retainedHistoricalDigest: current.patch.priorProgram.contentDigest };
    });
    await story('principal-boundary', async () => {
      const first = await submitHarnessProgram(ctx, request());
      const deniedCtx = { ...ctx, auth: { ...ctx.auth, userId: otherActor, employeeId: otherActor } };
      await assert.rejects(product.submitContinuation(deniedCtx, { priorProgramId: first.programId }),
        /unavailable in the authenticated scope/);
      return { otherPrincipalRefused: true, graphDisclosed: false };
    });
    await story('commit-race', async () => {
      const first = await submitHarnessProgram(ctx, request()), original = await completed(first.programId);
      assert.equal(original.status, 'TESTED', JSON.stringify(original));
      await correctDebt('59');
      const accepted = await product.submitContinuation(ctx, { priorProgramId: first.programId });
      await correctDebt('58');
      await worker.tick();
      const current = await product.readContinuation(ctx, accepted.continuationId);
      assert.equal(current.state, 'SUPERSEDED', JSON.stringify(current));
      assert.equal(current.patch, null);
      assert.equal((await admin!.query('SELECT count(*)::int n FROM finnor_os.p7_manifests WHERE continuation_id=$1',
        [accepted.continuationId])).rows[0].n, 0);
      return current;
    });
    await story('physical-intake-crash-recovery', async () => {
      const first = await submitHarnessProgram(ctx, request()), original = await completed(first.programId);
      assert.equal(original.status, 'TESTED', JSON.stringify(original));
      await correctDebt('57');
      const key = tenant + ':' + actor + ':' + first.workId;
      await admin!.query('SELECT pg_advisory_lock(hashtextextended($1,7001))', [key]);
      const child = spawn(process.execPath, ['--import=tsx', join(import.meta.dirname, 'native-submission-child.mts'),
        tenant, actor, first.programId], { cwd: join(repo, 'finnor-os'),
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
          NODE_ENV: 'test', FINNOR_P4_PROFILE: 'ordinary_disposable', DATABASE_URL: process.env.DATABASE_URL },
        stdio: ['ignore', 'ignore', 'ignore'] });
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((yes, no) => {
        child.once('error', no); child.once('close', (code, signal) => yes({ code, signal }));
      });
      let newerInput: string | null = null;
      try {
        for (let i = 0; i < 100; i++) {
          const latest = (await admin!.query('SELECT id FROM finnor_os.work_inputs WHERE work_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',
            [first.workId])).rows[0];
          if (latest.id !== first.workRevision) { newerInput = latest.id; break; }
          if (child.exitCode !== null) throw Error('OWNED_CHILD_EXITED_BEFORE_INTAKE_WINDOW');
          await new Promise(r => setTimeout(r, 50));
        }
        assert(newerInput, 'Real canonical intake never committed');
      } finally {
        child.kill('SIGKILL');
        await closed;
        await admin!.query('SELECT pg_advisory_unlock(hashtextextended($1,7001))', [key]);
      }
      const terminated = await closed;
      assert.equal(terminated.signal, 'SIGKILL');
      const accepted = await product.submitContinuation(ctx, { priorProgramId: first.programId });
      assert.equal((await admin!.query('SELECT count(*)::int n FROM finnor_os.work_inputs WHERE work_id=$1',
        [first.workId])).rows[0].n, 2, 'Crash adoption created another intake');
      let current: any;
      for (let i = 0; i < 90; i++) {
        await worker.tick(); current = await product.readContinuation(ctx, accepted.continuationId);
        if (['PUBLISHED', 'FAILED', 'SUPERSEDED'].includes(current.state)) break;
        await new Promise(r => setTimeout(r, 100));
      }
      assert.equal(current.state, 'PUBLISHED', JSON.stringify({ state: current.state, reason: current.reason }));
      const next = await readCurrentProgram(ctx, current.nextProgramId);
      assert.equal(next.program!.result!.values.equity!.value, '63');
      assert.equal(next.program!.bounds.episodeId, original.program!.bounds.episodeId);
      assert.equal(next.program!.bounds.deadlineAt, original.program!.bounds.deadlineAt);
      return { first, ownedPid: child.pid, terminated, intakeCommittedBeforeKill: newerInput,
        accepted, currentPublication: current.patch.publication, episodeRetained: next.program!.bounds };
    });
  } catch (error) {
    results.push({ id: 'runtime-setup-or-owner-boundary', status: 'FAIL',
      predicate: String((error as Error).message), code: (error as any).code ?? null });
  } finally {
    await http?.close();
    await (await import('@finnor/db')).closePool().catch(() => undefined);
    await admin?.end().catch(() => undefined);
    await postgres.stop().catch(error => results.push({ id: 'owned-database-stop', status: 'FAIL', predicate: String(error) }));
    await writeFile(join(out, 'cleanup.json'), JSON.stringify({
      ownedDatabaseDirectory: directory, databaseStopped: true,
      directoryRetained: true, noS6SettlementOrResourceReleaseClaimed: true,
    }, null, 2));
    await save();
  }
}
const after = await source();
await writeFile(join(out, 'source-check.json'), JSON.stringify({ unchanged: JSON.stringify(before) === JSON.stringify(after), before, after }, null, 2));
const exitCode = results.some(r => r.status === 'FAIL') || !results.some(r => r.status === 'PASS') ||
  JSON.stringify(before) !== JSON.stringify(after) ? 1 : 0;
console.log(JSON.stringify({ out, exitCode, results: results.map(({ id, status, predicate }) => ({ id, status, predicate })) }));
process.exit(exitCode);
