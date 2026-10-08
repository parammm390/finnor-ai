/** Preimplementation owner story. Expected values are separately formulated;
 * product receives no planted capsules, results, admission or ordering hooks. */
import { strict as assert } from 'node:assert';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, appendFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { nativeHttpFixture } from '../p7/native-http-fixture.mjs';
import { target } from '../p5/test-support.mjs';

const repo = resolve(import.meta.dirname, '../../..');
const out = process.env.FINNOR_P6_EVIDENCE_DIR;
if (!out?.startsWith('/')) throw Error('Absolute fresh FINNOR_P6_EVIDENCE_DIR required');
await mkdir(out, { recursive: true });
const results: any[] = [];
const profile=process.env.FINNOR_P6_CASE_PROFILE;
if(profile&&profile!=='induction-crash')throw Error('REGISTERED_P6_DIAGNOSTIC_PROFILE_REQUIRED');
const crashSelection=new Set(['native-baseline-and-adverse-episodes',
  'physical-crash-before-publication-and-original-grant-exhaustion',
  'physical-crash-after-publication-and-idempotent-ack-recovery',
  'original-deadline-expires-while-actual-publication-is-blocked']);
async function sources() {
  const paths: string[] = [];
  async function walk(relative: string) {
    for (const entry of await readdir(join(repo, relative), { withFileTypes: true }).catch(() => [])) {
      const path = relative + '/' + entry.name;
      if (entry.isDirectory() && !['node_modules', '.next'].includes(entry.name)) await walk(path);
      else if (entry.isFile() && /\.(ts|tsx|mts|mjs|py|sql|json)$/.test(path)) paths.push(path);
    }
  }
  for (const path of ['finnor-os/packages/private-equity/src/procedure-induction', 'finnor-os/scripts/p6',
    'scope-pm/phase-12-p6-procedure-induction/handoff']) await walk(path);
  paths.push('finnor-os/packages/private-equity/src/program-synthesis/contracts.ts',
    'finnor-os/packages/private-equity/src/program-synthesis/worker.ts',
    'finnor-os/apps/api/app/api/company-brain/[operation]/route.ts',
    'finnor-os/apps/worker/src/index.ts', 'finnor-os/packages/db/compute-contract.ts',
    'package-lock.json', 'finnor-os/package-lock.json');
  return Promise.all([...new Set(paths)].sort().map(async path =>
    ({ path, digest: createHash('sha256').update(await readFile(join(repo, path))).digest('hex') })));
}
const before = await sources();
await writeFile(join(out, 'freeze.json'), JSON.stringify({
  schema: 'finnor.p6.public-native-freeze.v1', before, node: process.version,
  startedAt: new Date().toISOString(), oracle: 'SEPARATE_SQL_BUSINESS_FORMULA_AND_PYTHON_FRACTION',
  sourceClass: 'SYNTHETIC_NATIVE_OWNER_HISTORY_NOT_PROTECTED_ANALYTICAL_EXPERIENCE',
  split: 'PUBLIC_DEVELOPMENT_HELD_APART_NOT_INDEPENDENTLY_SEALED', usd: null,
}, null, 2), { flag: 'wx' });
async function save() {
  await writeFile(join(out!, 'results.json'), JSON.stringify({
    qualification: 'PUBLIC_NATIVE_SELECTED_CONTRACTS_NOT_ORIGINAL_GATE_P6',
    results, usd: null, causalCreditGranted: false, executionAuthorityGranted: false,
  }, null, 2), { mode: 0o600 });
}
async function story(id: string, fn: () => Promise<unknown>) {
  if(profile&&!crashSelection.has(id)){
    results.push({id,status:'NOT_RUN',selection:profile});await save();return;
  }
  const started = Date.now();
  try { results.push({ id, status: 'PASS', observed: await fn(), elapsedMs: Date.now() - started }); }
  catch (error) {
    results.push({ id, status: 'FAIL', predicate: String((error as Error).message),
      code: (error as any).code ?? (error as any).cause?.code ?? null, elapsedMs: Date.now() - started });
  }
  await save();
  console.log(JSON.stringify({ id, status: results.at(-1).status, predicate: results.at(-1).predicate }));
}
let product: any;
try { product = await import('../../packages/private-equity/src/procedure-induction/api'); }
catch {
  results.push({ id: 'native-procedure-entrypoint', status: 'FAIL', predicate: 'P6_NOT_IMPLEMENTED' });
  await save(); process.exitCode = 1;
}
if (product) {
  const directory = await mkdtemp(join(tmpdir(), 'p6-native-development-'));
  const port = await new Promise<number>((yes, no) => {
    const server = createServer(); server.once('error', no);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return no(Error('OWNED_PORT_REQUIRED'));
      server.close(() => yes(address.port));
    });
  });
  const postgres = new EmbeddedPostgres({
    databaseDir: directory, user: 'finnor', password: 'finnor', port,
    persistent: true, onLog: () => undefined,
  });
  let admin: pg.Client | undefined;
  let http: Awaited<ReturnType<typeof nativeHttpFixture>> | undefined;
  let interfaceTarget: Awaited<ReturnType<typeof target>> | undefined;
  const physicalWorkers:Array<{child:ReturnType<typeof spawn>;closed:Promise<any>}>=[];
  const tenant = randomUUID(), actor = randomUUID(), otherActor = randomUUID();
  const ctx = {
    auth: { tenantId: tenant, userId: actor, employeeId: actor, role: 'owner' as const },
    provenance: { sourceSystem: 'p6:public-native-development', createdBy: actor },
  };
  try {
    await postgres.initialise();
    await appendFile(join(directory, 'postgresql.conf'), '\ntrack_commit_timestamp=on\n');
    await postgres.start(); await postgres.createDatabase('p6_native');
    const adminUrl = `postgres://finnor:finnor@127.0.0.1:${port}/p6_native`;
    admin = new pg.Client({ connectionString: adminUrl }); await admin.connect();
    const { migrate } = await import('../../packages/db/migrate');
    await migrate(adminUrl);
    const proposalPath = join(repo, 'scope-pm/phase-12-p6-procedure-induction/handoff/schema.proposed.sql');
    const proposal = await readFile(proposalPath, 'utf8');
    const registered='0170_p6_procedure_induction.sql';
    assert.equal((await admin.query('SELECT name FROM finnor_os._migrations WHERE name=$1',[registered])).rowCount,1);
    await writeFile(join(out, 'migration-proposal-install.json'), JSON.stringify({
      engine: (await admin.query('SELECT version()')).rows,
      proposalDigest: createHash('sha256').update(proposal).digest('hex'),
      numberedMigrationApplied: registered, serialIntegratorAdoption: true,
      originalRegistry: (await admin.query('SELECT name FROM finnor_os._migrations ORDER BY name')).rows,
    }, null, 2));
    await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'");
    await admin.query("SET app.test_vertical_mode='explicit'");
    await admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'P6 native development')",
      [tenant, randomUUID()]);
    await admin.query(`INSERT INTO finnor_os.users(id,tenant_id,email,role,status)
      VALUES($1,$2,$3,'owner','active'),($4,$2,$5,'owner','active')`,
    [actor, tenant, actor + '@test.invalid', otherActor, otherActor + '@test.invalid']);
    await admin.query(`INSERT INTO finnor_os.compute_resource_policies
      (resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,source)
      VALUES('native:p4',2,2,0,60,'Disposable test capacity, not protected funding')`);
    await admin.query(`INSERT INTO finnor_os.compute_resource_policies
      (resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,source)
      VALUES('native:p5',2,2,0,60,'Disposable test capacity, not protected funding')`);
    process.env.DATABASE_URL = `postgres://finnor_app:finnor_app@127.0.0.1:${port}/p6_native`;
    const db = await import('@finnor/db'); await db.closePool();
    await db.configureTenantVertical({ tenantId: tenant, verticalKey: 'private_equity',
      expectedVersion: 0, createdBy: actor, sourceSystem: 'p6:public-native-development' });
    const owners = await import('@finnor/private-equity');
    const memory = await import('@finnor/memory');
    const p1 = await import('../../packages/private-equity/src/program-synthesis/api');
    const p1Store = await import('../../packages/private-equity/src/program-synthesis/store');
    const {codeIdentity}=await import('../../packages/private-equity/src/evidence-execution/store');
    const { createWorker } = await import('../../apps/worker/src/index');
    let worker = createWorker();
    async function preparedPhysicalWorker(leaseSeconds:10|60) {
      const begun=Date.now(), child=spawn(process.execPath,
        ['--import=tsx',join(import.meta.dirname,'worker-child.mts')],{
          cwd:join(repo,'finnor-os'),env:{PATH:process.env.PATH,HOME:process.env.HOME,
            TMPDIR:process.env.TMPDIR,NODE_ENV:'test',FINNOR_P4_PROFILE:'ordinary_disposable',
            DATABASE_URL:process.env.DATABASE_URL,FINNOR_P6_TEST_LEASE_SECONDS:String(leaseSeconds),
            FINNOR_P6_AWAIT_START:'1'},stdio:['ignore','pipe','pipe','ipc'],
        });
      let stdout='',stderr='';
      child.stdout!.on('data',bytes=>{stdout=(stdout+bytes).slice(-16384)});
      child.stderr!.on('data',bytes=>{stderr=(stderr+bytes).slice(-16384)});
      const closed=new Promise<any>((yes,no)=>{child.once('error',no);child.once('close',(code,signal)=>yes({code,signal}))});
      physicalWorkers.push({child,closed});
      const ready=await new Promise<any>((yes,no)=>{
        const timer=setTimeout(()=>{child.kill('SIGKILL');no(Error('PHYSICAL_WORKER_READINESS_BOUND_EXHAUSTED'))},30000);
        child.once('error',error=>{clearTimeout(timer);no(error)});
        child.once('close',()=>{clearTimeout(timer);no(Error('PHYSICAL_WORKER_EXITED_BEFORE_READY:'+stderr))});
        child.once('message',message=>{clearTimeout(timer);yes(message)});
      }).catch(async error=>{if(child.exitCode===null)child.kill('SIGKILL');await closed;throw error});
      try{
        assert.equal(ready.schema,'finnor.p6.physical-worker-ready.v1');
        assert.equal(ready.pid,child.pid);assert.equal(ready.leaseSeconds,leaseSeconds);
        assert.equal(ready.codeDigest,(await codeIdentity()).digest);
        const preparation={...ready,elapsedMs:Date.now()-begun,dollars:null,
          qualification:'MEASURED_WORKER_PREPARATION_NOT_FREE_OR_COLD_TRANSFER_QUALIFICATION'};
        await writeFile(join(out!,'prepared-worker-'+child.pid+'.json'),JSON.stringify(preparation,null,2));
        return {child,closed,preparation,diagnostics:()=>({stdout,stderr})};
      }catch(error){if(child.exitCode===null)child.kill('SIGKILL');await closed;throw error}
    }
    http = await nativeHttpFixture(admin, tenant, actor, otherActor);
    const cases: any[] = JSON.parse(await readFile(join(import.meta.dirname, 'public-cases.json'), 'utf8'));
    const reference: any[] = JSON.parse(execFileSync('python3',
      [join(import.meta.dirname, 'reference.py'), join(import.meta.dirname, 'public-cases.json')],
      { encoding: 'utf8' }));
    await writeFile(join(out, 'independent-reference.json'), JSON.stringify(reference, null, 2), { flag: 'wx' });
    const inputs = new Map<string, any>();
    const beforeHeads = new Date().toISOString();
    async function fixture(c: any, aliases = false, larger = false) {
      const company = randomUUID(), root = { entityType: 'external_organization' as const, entityId: company };
      await admin!.query(`INSERT INTO finnor_os.external_organizations
        (id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,$4,'other')`,
      [company, tenant, 'p6-' + c.id, c.company]);
      const source = await memory.createEvidenceSource(tenant, {
        sourceKey: 'p6-' + c.id, sourceType: 'manual', title: 'Public independent financial inputs',
      });
      const version = await memory.appendEvidenceVersion(tenant, source.id, {
        content: JSON.stringify(c), snapshot: c, asOf: new Date('2025-01-01T00:00:00Z'),
      });
      const periodStart = aliases ? '2026-01-01T00:00:00.000Z' : '2025-01-01T00:00:00.000Z';
      const periodEnd = aliases ? '2026-12-31T00:00:00.000Z' : '2025-12-31T00:00:00.000Z';
      const fields = larger ? ['price', 'debt', 'ebitda', 'fee', 'liability'] : ['price', 'debt', 'ebitda', 'fee'];
      const names = aliases ? { price: 'purchase', debt: 'balance', ebitda: 'annual_profit',
        fee: 'closing_cost', liability: 'retained_obligation' } : Object.fromEntries(fields.map(k => [k, k]));
      for (const field of fields) {
        const series = await owners.createMetricSeries(ctx, { subjectType: root.entityType, subjectId: company,
          metricKey: names[field]!, name: names[field]!, unit: 'currency', currencyCode: c.currency,
          frequency: c.frequency });
        await owners.recordMetricObservation(ctx, {
          metricSeriesId: String(series.row.id), periodStart: new Date(periodStart), periodEnd: new Date(periodEnd),
          value: { type: 'number', value: c[field] },
          evidence: { evidenceSourceId: source.id, evidenceVersionId: version.versionId },
        });
      }
      const input = (key: string) => ({ kind: 'input', key: names[key] });
      const equity: any = { kind: 'subtract', left: { kind: 'subtract', left: input('price'), right: input('debt') },
        right: input('fee') };
      const request: any = {
        schema: 'finnor.harness-request.v1', instruction: 'Compute exact source-bound arithmetic, no investment choice or effect.',
        root, validAt: '2027-01-01T00:00:00.000Z', mode: 'ordinary_disposable', idempotencyKey: randomUUID(),
        limits: { maxSteps: 4096, maxAttempts: 8, maxCandidates: 8, deadlineMs: 300000 },
        sources: fields.map(key => ({ key: names[key], source: {
          kind: 'metric', subject: root, metricKey: names[key], periodStart, periodEnd,
          unit: 'currency', currencyCode: c.currency, frequency: c.frequency, calendar: 'OWNER_RECORDED',
          consolidation: 'OWNER_SUBJECT_ONLY', instrument: 'UNSPECIFIED', scale: '1', sign: 'AS_RECORDED',
        } })),
        acceptance: { requiredSourceKeys: fields.map(k => names[k]), targets: [
          { key: 'equity', expression: larger ? { kind: 'subtract', left: equity, right: input('liability') } : equity,
            unit: 'currency', currencyCode: c.currency },
          { key: 'leverage', expression: { kind: 'ratio', left: { kind: 'add', left: input('debt'), right: input('fee') },
            right: input('ebitda') }, unit: 'multiple', currencyCode: null },
        ], deliverable: { kind: 'analytical_draft', title: 'Public source-bound arithmetic' } },
      };
      const value = { c, root, request };
      inputs.set(c.id, value); return value;
    }
    async function complete(programId: string) {
      for (let i = 0; i < 100; i++) {
        await worker.tick();
        const state = await p1Store.readCurrentProgram(ctx, programId);
        if (['TESTED', 'FAILED', 'INVALIDATED', 'PARTIAL', 'CANCELLED'].includes(state.status)) return state;
        await new Promise(r => setTimeout(r, 75));
      }
      throw Error('REAL_NATIVE_PROGRAM_DID_NOT_COMPLETE');
    }
    const training: any[] = [];
    await story('native-baseline-and-adverse-episodes', async () => {
      for (const c of cases.filter(c => ['induction', 'adverse'].includes(c.split))) {
        const f = await fixture(c), submitted = await p1.submitHarnessProgram(ctx, f.request);
        const current = await complete(submitted.programId);
        if (c.split === 'induction') {
          assert.equal(current.status, 'TESTED', JSON.stringify(current));
          const oracle = reference.find(r => r.id === c.id);
          assert.equal(current.program!.result!.values.equity!.value, oracle.equity.value);
          assert.equal(current.program!.result!.values.leverage!.value, oracle.leverage.value);
        } else {
          assert.equal(current.status, 'FAILED', JSON.stringify(current));
          assert(current.incurredCosts.nativeInvocations.length > 0, 'FAILED_ATTEMPT_COST_DROPPED');
        }
        training.push({ ...submitted, current, root: f.root });
      }
      return { training: training.map(t => ({ programId: t.programId, status: t.current.status,
        costs: t.current.incurredCosts })), baseline: 'C_OWN_NATIVE_P1_P4_NOT_QUALIFIED_BASE10' };
    });
    let capsuleId: string | undefined, inductionId: string | undefined;
    let transferredProgramId: string | undefined;
    for (const afterPublication of [false, true]) await story(afterPublication
      ? 'physical-crash-after-publication-and-idempotent-ack-recovery'
      : 'physical-crash-before-publication-and-original-grant-exhaustion', async () => {
      const prepared=await preparedPhysicalWorker(10);
      const accepted = await http!.call('procedure-induce', {
        schema: 'finnor.p6.induction-request.v1', root: training[1].root, workId: training[1].workId,
        programIds: training.map(t => t.programId), knowledgeCut: new Date().toISOString(),
        idempotencyKey: 'physical-crash-' + afterPublication, mode: 'ordinary_disposable',
      });
      assert.equal(accepted.status, 202, JSON.stringify(accepted));
      const id = accepted.body.inductionId;
      const blocker = new pg.Client({ connectionString: adminUrl });await blocker.connect();
      const ackBlocker = new pg.Client({ connectionString: adminUrl });await ackBlocker.connect();
      const {child,closed}=prepared;
      let blocked: any;
      try {
        await blocker.query('BEGIN');await blocker.query('LOCK TABLE finnor_os.p6_capsules IN SHARE MODE');
        child.send({kind:'start-native-polling'});
        for (let i = 0; i < 480; i++) {
          blocked = (await admin!.query(`SELECT pid,wait_event_type,pg_blocking_pids(pid) blockers
            FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
            AND query ILIKE '%INSERT INTO finnor_os.p6_capsules%'`)).rows[0];
          if (blocked) break;
          if (child.exitCode !== null) throw Error('PHYSICAL_CHILD_EXITED_BEFORE_PUBLICATION_WINDOW');
          await new Promise(r => setTimeout(r, 50));
        }
        if (!blocked) {
          const diagnostic = (await http!.call('procedure-induction-read', { inductionId: id })).body;
          await writeFile(join(out, 'crash-window-' + afterPublication + '-failure.json'),
            JSON.stringify({induction:diagnostic,preparation:prepared.preparation,worker:prepared.diagnostics()},null,2));
          assert.fail('ACTUAL_UNCOMMITTED_CAPSULE_PUBLICATION_WINDOW_NOT_REACHED:' + JSON.stringify(diagnostic));
        }
        if (afterPublication) {
          await ackBlocker.query('BEGIN');await ackBlocker.query('LOCK TABLE finnor_os.job_delivery_attempts IN SHARE MODE');
          await blocker.query('COMMIT');
          let acknowledgmentBlocked: any;
          for (let i = 0; i < 240; i++) {
            acknowledgmentBlocked = (await admin!.query(`SELECT pid,wait_event_type,pg_blocking_pids(pid) blockers
              FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
              AND query ILIKE '%UPDATE job_delivery_attempts SET outcome=''completed''%'`)).rows[0];
            if (acknowledgmentBlocked) break;
            if (child.exitCode !== null) throw Error('PHYSICAL_CHILD_EXITED_BEFORE_ACK_WINDOW');
            await new Promise(r => setTimeout(r, 50));
          }
          assert(acknowledgmentBlocked, 'ACTUAL_DURABLE_PUBLICATION_BEFORE_ACK_WINDOW_NOT_REACHED');
          blocked = { publication: blocked, acknowledgment: acknowledgmentBlocked };
        }
      } finally {
        if (child?.exitCode === null) child.kill('SIGKILL');
        if (closed) await closed;
        if (afterPublication && blocked?.acknowledgment?.pid) {
          // A dead client does not imply its accepted SQL was rolled back.
          // Interrupt the actual still-uncommitted server connection as this
          // separate transport-loss window, never by editing a durable row.
          const terminated = await admin!.query('SELECT pg_terminate_backend($1) terminated',
            [blocked.acknowledgment.pid]);
          blocked.acknowledgment.terminated = terminated.rows[0].terminated;
        }
        await blocker.query('ROLLBACK');await blocker.end();
        await ackBlocker.query('ROLLBACK');await ackBlocker.end();
      }
      const died = await closed!, before = (await admin!.query(
        'SELECT state,attempts_used,deadline_at FROM finnor_os.p6_inductions WHERE id=$1', [id])).rows[0];
      if (afterPublication) assert.equal(blocked.acknowledgment.terminated, true, 'ACTUAL_UNCOMMITTED_ACK_CONNECTION_REQUIRED');
      assert.equal(died.signal, 'SIGKILL');assert.equal(before.state, afterPublication ? 'TESTED' : 'RUNNING');
      assert.equal((await admin!.query('SELECT count(*)::int n FROM finnor_os.p6_capsules WHERE induction_id=$1', [id])).rows[0].n, afterPublication ? 1 : 0);
      const { JobQueue } = await import('../../apps/worker/src/queue');
      const { runProcedureInductionJob } = await import('../../packages/private-equity/src/procedure-induction/worker');
      const contracts = (await import('../../packages/db/compute-contract')).PRODUCTION_JOB_CONTRACTS;
      const recovery = new JobQueue('p6-real-recovery:' + randomUUID(), 3);
      recovery.register('run_procedure_induction_v1', runProcedureInductionJob, contracts.run_procedure_induction_v1);
      const job = async () => (await admin!.query(`SELECT id,status,run_at,lease_expires_at,claim_fence,attempts
        FROM finnor_os.jobs WHERE type='run_procedure_induction_v1' AND payload->>'inductionId'=$1`, [id])).rows[0];
      const abandoned = await job();
      assert.equal(abandoned.status, 'running');
      const leaseObservations = [];
      let reclaimed = 0;
      for (let i = 0; i < 20 && !reclaimed; i++) {
        const currentLease = await job();leaseObservations.push(currentLease);
        await new Promise(r => setTimeout(r, Math.max(0, currentLease.lease_expires_at.getTime() - Date.now()) + 100));
        reclaimed = await recovery.recoverExpiredRunningJobs();
      }
      await writeFile(join(out, 'crash-' + afterPublication + '-recovery.json'),
        JSON.stringify({ before, abandoned, leaseObservations, reclaimed, blocked, died }, null, 2));
      assert.equal(reclaimed, 1, 'ACTUAL_EXPIRED_CLAIM_MUST_BE_RECLAIMED');
      const scheduled = await job();assert.equal(scheduled.status, 'queued');
      await new Promise(r => setTimeout(r, Math.max(0, scheduled.run_at.getTime() - Date.now()) + 50));
      assert.equal(await recovery.tick(), true);
      const recovered = (await http!.call('procedure-induction-read', { inductionId: id })).body;
      assert.equal(recovered.state, afterPublication ? 'TESTED' : 'FAILED', JSON.stringify(recovered));
      assert.equal(recovered.capsuleIds.length, afterPublication ? 1 : 0);
      assert.equal(recovered.costs.dollars, null);
      assert.equal(recovered.costs.deliveries.length, 2);
      if (afterPublication) {
        const recoveredCapsule = await http!.call('procedure-read', { capsuleId: recovered.capsuleIds[0] });
        assert.equal(recoveredCapsule.body.capsule.work.id, training[1].workId,
          'INDUCED_ENVELOPE_MUST_BIND_ORIGINAL_INDUCTION_WORK_NOT_FIRST_SOURCE_EPISODE');
      } else assert.equal(recovered.reason, 'P6_ORIGINAL_INDUCTION_GRANT_EXHAUSTED');
      assert.equal(recovered.originalDeadlineAt, before.deadline_at.toISOString());
      const after = (await admin!.query('SELECT attempts_used FROM finnor_os.p6_inductions WHERE id=$1', [id])).rows[0];
      // Recovery delivery is charged separately. An expired original grant
      // cannot authorize another synthesis attempt, and a durable result
      // cannot spend one just to acknowledge its replay.
      assert.equal(after.attempts_used, before.attempts_used, 'ORIGINAL_SYNTHESIS_ATTEMPTS_MUST_NOT_RENEW');
      await recovery.tick();
      assert.equal((await admin!.query('SELECT count(*)::int n FROM finnor_os.p6_capsules WHERE induction_id=$1', [id])).rows[0].n, afterPublication ? 1 : 0);
      const delivery = (await admin!.query('SELECT id,outcome,claim_fence FROM finnor_os.job_delivery_attempts WHERE job_id=$1 ORDER BY claim_fence', [abandoned.id])).rows;
      assert.equal(delivery.length, 2);assert.equal(delivery[0].outcome, 'lease_lost');
      assert.equal(delivery[1].outcome, 'completed');
      assert(Number(delivery[1].claim_fence) > Number(delivery[0].claim_fence));
      return { accepted, blocked, killedChild: child!.pid, died, before, abandoned, scheduled, recovered, after,
        delivery, preparation:prepared.preparation,
        committedCapsulesAfterCrash: afterPublication ? 1 : 0, grantRenewed: false };
    });
    await story('original-deadline-expires-while-actual-publication-is-blocked', async () => {
      const prepared=await preparedPhysicalWorker(60);
      const accepted = await http!.call('procedure-induce', {
        schema: 'finnor.p6.induction-request.v1', root: training[1].root, workId: training[1].workId,
        programIds: training.map(t => t.programId), knowledgeCut: new Date().toISOString(),
        idempotencyKey: 'blocked-original-deadline', mode: 'ordinary_disposable',
      });
      assert.equal(accepted.status, 202);
      const id = accepted.body.inductionId, blocker = new pg.Client({ connectionString: adminUrl });
      await blocker.connect();
      const {child,closed}=prepared;let blocked:any;
      try {
        await blocker.query('BEGIN');await blocker.query('LOCK TABLE finnor_os.p6_capsules IN SHARE MODE');
        child.send({kind:'start-native-polling'});
        for (let i = 0; i < 240; i++) {
          blocked = (await admin!.query(`SELECT pid,wait_event_type FROM pg_stat_activity
            WHERE datname=current_database() AND wait_event_type='Lock'
              AND query ILIKE '%INSERT INTO finnor_os.p6_capsules%'`)).rows[0];
          if (blocked) break;
          if (child.exitCode !== null) throw Error('DEADLINE_CHILD_EXITED_BEFORE_ACTUAL_PUBLICATION_WINDOW');
          await new Promise(r => setTimeout(r, 50));
        }
        assert(blocked, 'ACTUAL_PUBLICATION_WINDOW_REQUIRED');
        const before = (await http!.call('procedure-induction-read', { inductionId: id })).body;
        await new Promise(r => setTimeout(r, Math.max(0, Date.parse(before.originalDeadlineAt) - Date.now()) + 250));
        await blocker.query('COMMIT');
        const ended = await closed;assert.equal(ended.code, 0);
        const after = (await http!.call('procedure-induction-read', { inductionId: id })).body;
        assert.equal(after.state, 'FAILED', JSON.stringify(after));
        assert.match(after.reason, /DEADLINE|GRANT|FENCED|PROGRAM_OWNER_OR_CHECK_PREDICATE_UNPASSED/);
        assert.equal(after.originalDeadlineAt, before.originalDeadlineAt);
        assert.equal((await admin!.query('SELECT count(*)::int n FROM finnor_os.p6_capsules WHERE induction_id=$1', [id])).rows[0].n, 0);
        return { accepted, before, blocked, ended, after, preparation:prepared.preparation,deadlineRenewed: false,
          qualification: 'NO_LATE_PUBLICATION_WITH_NATIVE_SQL_TIMEOUT_OR_EXACT_FINAL_DEADLINE_FENCE' };
      } finally {
        if (child?.exitCode === null) child.kill('SIGKILL');
        if (closed) await closed;
        await blocker.query('ROLLBACK');await blocker.end();
      }
    });
    await story('authenticated-procedure-and-complete-knowledge-cut', async () => {
      const absent = { capsuleId: randomUUID() };
      assert.equal((await http!.call('procedure-read', absent, 'anonymous')).status, 401);
      assert.equal((await http!.call('procedure-read', absent, 'invalid')).status, 401);
      const foreign = await http!.call('procedure-experience',
        { programIds: training.map(t => t.programId), knowledgeCut: new Date().toISOString(), mode: 'ordinary_disposable' }, 'other');
      assert.equal(foreign.status, 404, JSON.stringify(foreign));
      const early = await http!.call('procedure-experience',
        { programIds: training.map(t => t.programId), knowledgeCut: beforeHeads, mode: 'ordinary_disposable' });
      assert.equal(early.status, 200, JSON.stringify(early));
      assert.equal(early.body.records.length, 0, 'FUTURE_REQUESTS_OR_HEADS_LEAKED');
      assert.equal(early.body.episodes.length, 0, 'FUTURE_ORIGINAL_EPISODE_GRANT_LEAKED');
      assert(early.body.futureKnowledgeExcluded.length > 0);
      const current = await http!.call('procedure-experience',
        { programIds: training.map(t => t.programId), knowledgeCut: new Date().toISOString(), mode: 'ordinary_disposable' });
      assert.equal(current.status, 200, JSON.stringify(current));
      assert.equal(current.body.episodes.length, 3);
      assert(current.body.records.some((r: any) => r.kind === 'FAILED_OR_FENCED'));
      assert.equal(current.body.protectedReceipt, null);
      const protectedRead = await http!.call('procedure-experience',
        { programIds: training.map(t => t.programId), knowledgeCut: new Date().toISOString(), mode: 'protected' });
      assert.equal(protectedRead.status, 422, JSON.stringify(protectedRead));
      assert.equal(protectedRead.body.predicate, 'P6_COMPLETE_PROTECTED_ANALYTICAL_EPISODE_PORT_REQUIRED');
      return { early, counts: current.body.counts, foreign, protectedRead, auth: http!.observed };
    });
    await story('structural-induction-durable-idempotence', async () => {
      const request = {
        schema: 'finnor.p6.induction-request.v1', root: training[0].root, workId: training[0].workId,
        programIds: training.map(t => t.programId), knowledgeCut: new Date().toISOString(),
        idempotencyKey: 'public-induction', mode: 'ordinary_disposable',
      };
      const [first, duplicate] = await Promise.all([
        http!.call('procedure-induce', request), http!.call('procedure-induce', request),
      ]);
      assert.equal(first.status, 202, JSON.stringify(first));
      assert.equal(duplicate.status, 202, JSON.stringify(duplicate));
      assert.equal(first.body.inductionId, duplicate.body.inductionId);
      inductionId = first.body.inductionId;
      let current: any;
      for (let i = 0; i < 30; i++) {
        await worker.tick();
        current = (await http!.call('procedure-induction-read', { inductionId })).body;
        if (['TESTED', 'FAILED', 'CANCELLED'].includes(current.state)) break;
      }
      assert.equal(current.state, 'TESTED', JSON.stringify(current));
      assert.equal(current.capsuleIds.length, 1, JSON.stringify(current));
      capsuleId = current.capsuleIds[0];
      const read = await http!.call('procedure-read', { capsuleId });
      assert.equal(read.status, 200, JSON.stringify(read));
      assert.equal(read.body.capsule.admission, null);
      assert.equal(read.body.capsule.status, 'PROPOSED');
      assert.equal(read.body.capsule.support.episodes.length, 2);
      assert(read.body.capsule.support.adverseRecords.length > 0);
      assert.equal(read.body.capsule.fallback.admitted, null);
      assert.equal(read.body.capsule.runtime.imageDigest, null);
      const module = JSON.stringify(read.body.capsule.components.module);
      assert(!training.some(t => module.includes(t.root.entityId)), 'EPISODE_IDENTITY_EMBEDDED_IN_EXECUTABLE');
      return { first: first.body, duplicate: duplicate.body, current, capsule: read.body.capsule };
    });
    await story('new-input-transfer-and-larger-native-composition', async () => {
      assert(capsuleId, 'CAPSULE_REQUIRED');
      const observations = [];
      for (const c of cases.filter(c => c.split === 'held-apart')) {
        const f = await fixture(c, true, c.liability !== '0');
        const submitted = await p1.submitHarnessProgram(ctx, {
          ...f.request, procedure: { capsuleId, mode: 'ordinary_disposable' },
        });
        const current = await complete(submitted.programId);
        assert.equal(current.status, 'TESTED', JSON.stringify(current));
        const oracle = reference.find(r => r.id === c.id);
        assert.equal(current.program!.result!.values.equity!.value, oracle.equity.value);
        assert.equal(current.program!.result!.values.leverage!.value, oracle.leverage.value);
        const events = (await admin!.query(`SELECT kind,body FROM finnor_os.p1_events
          WHERE request_id=$1 AND kind LIKE 'P6_%' ORDER BY created_at,id`, [submitted.programId])).rows;
        assert(events.some(r => r.kind === 'P6_EXECUTABLE_TRANSFER'), JSON.stringify(events));
        assert(events.some(r => r.body.fabricInvocationId), 'ACTUAL_ISOLATED_FABRIC_RECEIPT_REQUIRED');
        observations.push({ case: c.id, submitted, values: current.program!.result!.values, events,
          costs: current.incurredCosts, originalGrant: current.program!.bounds });
        if (c.id === 'held-apart-alias') transferredProgramId = submitted.programId;
      }
      return { observations, qualification: 'PUBLIC_HELD_APART_NOT_INDEPENDENT_SEALED_TRANSFER' };
    });
    await story('frozen-public-matched-fresh-baseline-and-total-cost-ledger', async () => {
      assert(capsuleId, 'CAPSULE_REQUIRED');
      const frozen = (await http!.call('procedure-read', { capsuleId })).body.capsule;
      const observations = [];
      for (const c of cases.filter(c => c.split === 'held-apart')) {
        const f = inputs.get(c.id), submitted = await p1.submitHarnessProgram(ctx, {
          ...f.request, idempotencyKey: randomUUID(),
        });
        const current = await complete(submitted.programId), oracle = reference.find(r => r.id === c.id);
        assert.equal(current.status, 'TESTED', JSON.stringify(current));
        assert.equal(current.program!.result!.values.equity!.value, oracle.equity.value);
        assert.equal(current.program!.result!.values.leverage!.value, oracle.leverage.value);
        observations.push({ case: c.id, fresh: submitted, values: current.program!.result!.values,
          costs: current.incurredCosts, equippedBaseline: 'EXACT_C_NATIVE_P1_P4_WITH_REGISTERED_COMPILER_NOT_QUALIFIED_COMPLETED_BASELINE' });
      }
      const costs = await http!.call('procedure-costs', { capsuleId });
      assert.equal(costs.status, 200, JSON.stringify(costs));
      assert.equal(costs.body.dollars, null);
      assert(costs.body.missing.includes('REAL_REUSE_HORIZON'));
      const after = (await http!.call('procedure-read', { capsuleId })).body.capsule;
      assert.deepEqual(after, frozen, 'CAPSULE_CHANGED_AFTER_HELD_APART_OUTPUTS');
      const comparison = { frozenCapsule: frozen.id, module: frozen.module, observations, costs: costs.body,
        dollars: null, realReuseHorizon: null, independence: 'PUBLIC_DIAGNOSTIC_PAIRED_CASES_NOT_SAMPLES',
        gainClaim: null, gate: 'UNQUALIFIED', baselineQualified: false };
      await writeFile(join(out, 'diagnostic-comparison.json'), JSON.stringify(comparison, null, 2));
      return comparison;
    });
    await story('native-P5-bound-dependency-without-effect-discharge', async () => {
      assert(capsuleId && transferredProgramId, 'TRANSFERRED_PROGRAMME_REQUIRED');
      interfaceTarget = await target(out);
      const p = await p1Store.readCurrentProgram(ctx, transferredProgramId);
      assert.equal(p.status, 'TESTED');
      const accessId = randomUUID(), operationId = randomUUID(), f = inputs.get('held-apart-alias');
      await admin!.query(`INSERT INTO finnor_os.p5_test_access
        (id,tenant_id,principal_id,work_id,origin,account,document_path,rights_ref,valid_until,permit_practice)
        VALUES($1,$2,$3,$4,$5,'test-account','/docs','EXPLICIT_DISPOSABLE_TEST_ACCESS',clock_timestamp()+interval '3 minutes',true)`,
      [accessId, tenant, actor, p.workId, interfaceTarget.origin]);
      const request = { schema: 'finnor.p5.acquisition-request.v1', root: f.root, workId: p.workId,
        sourceAccessId: accessId, programId: transferredProgramId, substrate: 'API', mode: 'ordinary_disposable',
        idempotencyKey: randomUUID(), operation: { meaning: 'set-record-field', account: 'test-account',
          entity: 'C_01', field: 'price', unit: 'currency', currency: 'USD', value: '140.00',
          tolerance: '0', priorRevision: '"v1"', operationId } };
      const accepted = await http!.call('interface-acquire', request);
      assert.equal(accepted.status, 202, JSON.stringify(accepted));
      let practiced: any;
      for (let i = 0; i < 20; i++) {
        await worker.tick();
        practiced = await http!.call('interface-read', { acquisitionId: accepted.body.acquisitionId });
        if (['PRACTICED', 'UNKNOWN', 'FAILED'].includes(practiced.body.status)) break;
      }
      assert.equal(practiced.body.status, 'PRACTICED', JSON.stringify(practiced));
      const loaded = await http!.call('procedure-interface', {
        capsuleId, programId: transferredProgramId, acquisitionId: accepted.body.acquisitionId, outputKey: 'equity',
      });
      assert.equal(loaded.status, 200, JSON.stringify(loaded));
      assert.equal(loaded.body.responsibilityDischarged, false);
      const before = await interfaceTarget.reference();
      const rehearsal = await (await import('../../packages/private-equity/src/branch-fabric/interface'))
        .rehearseProgrammeInterface(loaded.body.interfaceModule, new AbortController().signal);
      const after = await interfaceTarget.reference();
      assert.equal(after.records.C_01.price, 14000);
      assert.equal(after.records.C_010.price, 1000);
      assert.equal(after.writes.length, 1);
      assert.equal(after.requests.length, before.requests.length, 'PURE_DEPENDENCY_PERFORMED_TARGET_IO');
      assert.equal(rehearsal.protectedEligible, false);
      await interfaceTarget.control({ mode: 'no-observer' });
      const unknown = await http!.call('interface-acquire', { ...request, idempotencyKey: randomUUID(),
        operation: { ...request.operation, value: '144.00', priorRevision: '"v2"', operationId: randomUUID() } });
      assert.equal(unknown.status, 202);
      let uncertain: any;
      for (let i = 0; i < 20; i++) {
        await worker.tick(); uncertain = await http!.call('interface-read', { acquisitionId: unknown.body.acquisitionId });
        if (['UNKNOWN', 'FAILED'].includes(uncertain.body.status)) break;
      }
      assert.equal(uncertain.body.status, 'UNKNOWN', JSON.stringify(uncertain));
      const refused = await http!.call('procedure-interface', { capsuleId, programId: transferredProgramId,
        acquisitionId: unknown.body.acquisitionId, outputKey: 'equity' });
      assert.equal(refused.status, 422);
      const history = await http!.call('procedure-experience', { programIds: [transferredProgramId],
        knowledgeCut: new Date().toISOString(), mode: 'ordinary_disposable' });
      assert(history.body.records.some((r: any) => r.ref.owner === 'P5' &&
        (r.kind.includes('UNKNOWN') || JSON.stringify(r.body).includes('"UNKNOWN"'))));
      return { loaded, rehearsal, independentlyObservedTarget: after, uncertain, refused, historyCounts: history.body.counts };
    });
    await story('schema-forged-admission-and-component-substitution-refusals', async () => {
      assert(capsuleId, 'CAPSULE_REQUIRED');
      const read = await http!.call('procedure-read', { capsuleId });
      const forged = await http!.call('procedure-read', { capsuleId, admission: { id: randomUUID(), expiresAt: '2099-01-01' } });
      assert.equal(forged.status, 400);
      const substituted = await http!.call('procedure-component', { capsuleId,
        ref: { ...read.body.capsule.module, contentDigest: '0'.repeat(64) } });
      assert.equal(substituted.status, 422);
      const component = await http!.call('procedure-component', { capsuleId, ref: read.body.capsule.module });
      assert.equal(component.status, 200);
      const duplicate = await http!.call('procedure-experience', { programIds: [training[0].programId, training[0].programId],
        knowledgeCut: new Date().toISOString(), mode: 'ordinary_disposable' });
      assert.equal(duplicate.status, 400);
      const f = inputs.get('held-apart-alias');
      const illegal = await http!.call('program-submit', { ...f.request, idempotencyKey: randomUUID(),
        procedure: { capsuleId, mode: 'ordinary_disposable', admission: { id: randomUUID() } } });
      assert.equal(illegal.status, 400);
      return { forged, substituted, duplicate, illegal, exactPreimageResolved: true };
    });
    await story('concurrent-publication-and-invalidation-owner-lock', async () => {
      const request = {
        schema: 'finnor.p6.induction-request.v1', root: training[1].root, workId: training[1].workId,
        programIds: training.map(t => t.programId), knowledgeCut: new Date().toISOString(),
        idempotencyKey: 'race-capsule', mode: 'ordinary_disposable',
      };
      const accepted = await http!.call('procedure-induce', request);
      assert.equal(accepted.status, 202);
      let induced: any;
      for (let i = 0; i < 30; i++) {
        await worker.tick();induced = (await http!.call('procedure-induction-read', { inductionId: accepted.body.inductionId })).body;
        if (induced.state === 'TESTED') break;
      }
      assert.equal(induced.state, 'TESTED', JSON.stringify(induced));
      const raceCapsule = induced.capsuleIds[0], f = inputs.get('held-apart-alias');
      const next = await p1.submitHarnessProgram(ctx, { ...f.request, idempotencyKey: randomUUID(),
        procedure: { capsuleId: raceCapsule, mode: 'ordinary_disposable' } });
      const originalDeadline = Date.parse((await p1Store.requestRow(ctx, next.programId)).proposed.bounds.deadlineAt);
      const blocker = new pg.Client({ connectionString: adminUrl });await blocker.connect();
      let child: ReturnType<typeof spawn> | undefined, closed: Promise<any> | undefined;
      let waiting: any, notice: Promise<any> | undefined;
      try {
        await blocker.query('BEGIN');await blocker.query('LOCK TABLE finnor_os.p1_programs IN SHARE MODE');
        child = spawn(process.execPath, ['--import=tsx', join(import.meta.dirname, 'worker-child.mts')], {
          cwd: join(repo, 'finnor-os'), env: { PATH: process.env.PATH, HOME: process.env.HOME,
            TMPDIR: process.env.TMPDIR, NODE_ENV: 'test', FINNOR_P4_PROFILE: 'ordinary_disposable',
            DATABASE_URL: process.env.DATABASE_URL, FINNOR_P6_CHILD_PROGRAMME: '1',
            FINNOR_P6_TEST_LEASE_SECONDS: '60' },
          stdio: ['ignore', 'ignore', 'ignore'],
        });
        closed = new Promise((yes, no) => { child!.once('error', no);child!.once('close', (code, signal) => yes({ code, signal })); });
        const observationDeadline = Math.min(originalDeadline, Date.now() + 60000);
        while (Date.now() < observationDeadline) {
          waiting = (await admin!.query(`SELECT pid,pg_blocking_pids(pid) blockers FROM pg_stat_activity
            WHERE datname=current_database() AND wait_event_type='Lock'
            AND query ILIKE '%INSERT INTO finnor_os.p1_programs%'`)).rows[0];
          if (waiting) break;
          if (child.exitCode !== null) throw Error('RACE_CHILD_EXITED_BEFORE_PUBLICATION_WINDOW');
          await new Promise(r => setTimeout(r, 50));
        }
        assert(waiting, 'ACTUAL_P1_PUBLICATION_WINDOW_NOT_REACHED');
        notice = http!.call('procedure-counterexample', { capsuleId: raceCapsule, type: 'REVOKED',
          reason: 'Concurrent exact domain reassessment', idempotencyKey: 'race-notice' });
        void notice.catch(() => undefined);
        let serialized: any;
        for (let i = 0; i < 100; i++) {
          serialized = (await admin!.query(`SELECT pid,pg_blocking_pids(pid) blockers FROM pg_stat_activity
            WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%7601%'`)).rows[0];
          if (serialized) break;
          await new Promise(r => setTimeout(r, 30));
        }
        assert(serialized, 'COUNTEREXAMPLE_DID_NOT_SERIALIZE_AGAINST_PUBLICATION_USE_LOCK');
      } catch (error) {
        if (child?.exitCode === null) child.kill('SIGKILL');
        if (closed) await closed;
        throw error;
      } finally {
        await blocker.query('ROLLBACK');await blocker.end();
      }
      try {
        const recorded = await notice!;assert.equal(recorded.status, 200, JSON.stringify(recorded));
        const current = await p1Store.readCurrentProgram(ctx, next.programId);
        assert.equal(current.status, 'INVALIDATED', JSON.stringify(current));
        const head = (await admin!.query('SELECT body,digest FROM finnor_os.p1_programs WHERE request_id=$1', [next.programId])).rows;
        assert.equal(head.length, 1);assert(head[0].body.result);
        return { next, waiting, notice: recorded, currentStatus: current.status,
          historicalHeadRetained: true, ownerLockSerialized: true };
      } finally {
        if (child?.exitCode === null) child.kill('SIGTERM');
        if (closed) await closed;
      }
    });
    await story('semantic-mismatch-real-fresh-fallback', async () => {
      assert(capsuleId, 'CAPSULE_REQUIRED');
      const observations = [];
      for (const c of cases.filter(c => c.split === 'mismatch')) {
        const f = await fixture(c, true), submitted = await p1.submitHarnessProgram(ctx, {
          ...f.request, procedure: { capsuleId, mode: 'ordinary_disposable' },
        });
        const current = await complete(submitted.programId);
        assert.equal(current.status, 'TESTED', JSON.stringify(current));
        const oracle = reference.find(r => r.id === c.id);
        assert.equal(current.program!.result!.values.equity!.value, oracle.equity.value);
        const events = (await admin!.query(`SELECT kind,body FROM finnor_os.p1_events WHERE request_id=$1
          AND (kind LIKE 'P6_%' OR kind='ISOLATED_MODULE_EXECUTION') ORDER BY created_at,id`,
        [submitted.programId])).rows;
        assert(events.some(r => r.kind === 'P6_FRESH_FALLBACK'));
        assert.equal(events.filter(r => r.kind === 'P6_EXECUTABLE_TRANSFER').length, 0);
        assert(events.filter(r => r.kind === 'ISOLATED_MODULE_EXECUTION').length >= 2,
          'FALLBACK_DID_NOT_PERFORM_ACTUAL_FRESH_BASELINE_EXECUTIONS');
        observations.push({ case: c.id, values: current.program!.result!.values, events,
          costs: current.incurredCosts, originalGrant: current.program!.bounds });
      }
      return observations;
    });
    await story('immutable-counterexample-and-dependent-currentness', async () => {
      assert(capsuleId, 'CAPSULE_REQUIRED');
      const prior = await http!.call('procedure-read', { capsuleId });
      const dependent = (await admin!.query(`SELECT r.id,p.digest,p.body->'result' result
        FROM finnor_os.p1_requests r JOIN finnor_os.p1_programs p ON p.id=r.head_id
        WHERE r.tenant_id=$1 AND r.request->'procedure'->>'capsuleId'=$2 AND r.status='TESTED' ORDER BY r.created_at`,
      [tenant, capsuleId])).rows;
      assert(dependent.length > 0);
      const notice = await http!.call('procedure-counterexample', {
        capsuleId, type: 'CORRECTION', reason: 'Public adversary: changed liability convention requires reevaluation',
        idempotencyKey: 'public-counterexample',
      });
      assert.equal(notice.status, 200, JSON.stringify(notice));
      const repeated = await http!.call('procedure-counterexample', {
        capsuleId, type: 'CORRECTION', reason: 'Public adversary: changed liability convention requires reevaluation',
        idempotencyKey: 'public-counterexample',
      });
      assert.equal(notice.body.ref.contentDigest, repeated.body.ref.contentDigest);
      const resolvedNotice = await http!.call('procedure-component', { capsuleId, ref: notice.body.ref });
      assert.equal(resolvedNotice.status, 200, JSON.stringify(resolvedNotice));
      assert.equal(resolvedNotice.body.body.moduleChanged, false);
      const current = await http!.call('procedure-read', { capsuleId });
      assert.equal(current.body.state, 'INVALIDATED');
      assert.equal(current.body.capsule.module.contentDigest, prior.body.capsule.module.contentDigest);
      assert.equal(current.body.capsule.admission, null);
      const state = await p1Store.readCurrentProgram(ctx, dependent[0].id);
      assert.equal(state.status, 'INVALIDATED', JSON.stringify(state));
      const immutable = (await admin!.query('SELECT digest,body->\'result\' result FROM finnor_os.p1_programs WHERE digest=$1',
        [dependent[0].digest])).rows[0];
      assert.deepEqual(immutable.result, dependent[0].result);
      const changed = await admin!.query(`UPDATE finnor_os.p6_capsules SET body=body||'{"status":"ADMITTED"}'
        WHERE id=$1`, [capsuleId]).then(() => 'MUTATED', () => 'IMMUTABLE');
      assert.equal(changed, 'IMMUTABLE');
      return { notice: notice.body, current: current.body, dependentState: state.status,
        immutableHistoricalResult: immutable, mutationRefused: true };
    });
    await story('P7-real-dependent-revision-and-fresh-fallback-publication', async () => {
      assert(transferredProgramId, 'TRANSFERRED_PROGRAMME_REQUIRED');
      const prior = (await admin!.query(`SELECT episode_id FROM finnor_os.p1_requests WHERE id=$1`,
        [transferredProgramId])).rows[0];
      const before = (await admin!.query(`SELECT max_steps,max_attempts,deadline_at,attempts_used
        FROM finnor_os.p1_episodes WHERE id=$1`, [prior.episode_id])).rows[0];
      const accepted = await http!.call('continuation-submit', { priorProgramId: transferredProgramId });
      assert.equal(accepted.status, 202, JSON.stringify(accepted));
      let current: any;
      for (let i = 0; i < 80; i++) {
        await worker.tick();
        current = await http!.call('continuation-read', { continuationId: accepted.body.continuationId });
        if (['PUBLISHED', 'FAILED', 'SUPERSEDED'].includes(current.body.state)) break;
        await new Promise(r => setTimeout(r, 100));
      }
      assert.equal(current.body.state, 'PUBLISHED', JSON.stringify(current));
      const next = (await admin!.query('SELECT next_request_id FROM finnor_os.p7_continuations WHERE id=$1',
        [accepted.body.continuationId])).rows[0].next_request_id;
      const output = await p1Store.readCurrentProgram(ctx, next);
      assert.equal(output.status, 'TESTED');
      assert.equal(output.program!.bounds.episodeId, prior.episode_id);
      assert.equal(output.program!.result!.values.equity!.value, '140');
      const after = (await admin!.query(`SELECT max_steps,max_attempts,deadline_at,attempts_used
        FROM finnor_os.p1_episodes WHERE id=$1`, [prior.episode_id])).rows[0];
      assert.equal(after.max_steps, before.max_steps);assert.equal(after.max_attempts, before.max_attempts);
      assert.equal(after.deadline_at.toISOString(), before.deadline_at.toISOString());
      assert(after.attempts_used > before.attempts_used);
      const fallback = (await admin!.query(`SELECT kind,body FROM finnor_os.p1_events
        WHERE request_id=$1 AND kind IN('P6_FRESH_FALLBACK','ISOLATED_MODULE_EXECUTION')`, [next])).rows;
      assert(fallback.some(r => r.kind === 'P6_FRESH_FALLBACK'));
      assert(fallback.filter(r => r.kind === 'ISOLATED_MODULE_EXECUTION').length >= 2);
      return { accepted, current: current.body, nextProgramId: next, originalGrant: before, after, fallback };
    });
    await story('revoked-selection-fallback-protected-refusal-and-cancellation', async () => {
      assert(capsuleId, 'CAPSULE_REQUIRED');
      const f = inputs.get('held-apart-alias');
      const renewed = await p1.submitHarnessProgram(ctx, {
        ...f.request, idempotencyKey: randomUUID(), procedure: { capsuleId, mode: 'ordinary_disposable' },
      });
      const current = await complete(renewed.programId);
      assert.equal(current.status, 'TESTED', JSON.stringify(current));
      const events = (await admin!.query(`SELECT kind,body FROM finnor_os.p1_events WHERE request_id=$1 AND kind LIKE 'P6_%'`,
        [renewed.programId])).rows;
      assert(events.some(r => r.kind === 'P6_FRESH_FALLBACK'));
      const denied = await http!.call('program-submit', {
        ...f.request, idempotencyKey: randomUUID(), procedure: { capsuleId, mode: 'protected' },
      });
      assert.equal(denied.status, 422, JSON.stringify(denied));
      const cancelled = await http!.call('procedure-induce', {
        schema: 'finnor.p6.induction-request.v1', root: training[0].root, workId: training[0].workId,
        programIds: training.map(t => t.programId), knowledgeCut: new Date().toISOString(),
        mode: 'ordinary_disposable', idempotencyKey: 'public-cancel',
      });
      assert.equal(cancelled.status, 202, JSON.stringify(cancelled));
      assert.equal((await http!.call('procedure-induction-cancel', { inductionId: cancelled.body.inductionId })).status, 200);
      worker = createWorker(); await worker.tick();
      const stopped = await http!.call('procedure-induction-read', { inductionId: cancelled.body.inductionId });
      assert.equal(stopped.body.state, 'CANCELLED');
      assert.equal(stopped.body.capsuleIds.length, 0);
      return { fallback: events, denied, stopped: stopped.body };
    });
    await story('physical-worker-restart-and-capsule-readback', async () => {
      const child = spawn(process.execPath, ['--import=tsx', join(import.meta.dirname, 'readback-child.mts'),
        tenant, actor, capsuleId!], {
        cwd: join(repo, 'finnor-os'), env: { PATH: process.env.PATH, HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR, NODE_ENV: 'test', FINNOR_P4_PROFILE: 'ordinary_disposable',
          DATABASE_URL: process.env.DATABASE_URL }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
      const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
      const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((yes, no) => {
        child.once('error', no); child.once('close', (code, signal) => yes({ code, signal }));
      }).finally(() => clearTimeout(timer));
      assert.equal(closed.code, 0, stderr);
      const observed = JSON.parse(stdout.trim().split('\n').at(-1)!);
      assert.equal(observed.state, 'INVALIDATED');
      assert.equal(observed.admission, null);
      assert(observed.historyCount > 0);
      return { ownedPid: child.pid, closed, observed, actualNewProcess: true };
    });
  } catch (error) {
    results.push({ id: 'native-setup-or-owner-boundary', status: 'FAIL',
      predicate: String((error as Error).message), code: (error as any).code ?? null });
  } finally {
    for(const item of physicalWorkers){
      if(item.child.exitCode===null&&item.child.signalCode===null)item.child.kill('SIGKILL');
      await item.closed.catch(()=>undefined);
    }
    await interfaceTarget?.close();
    await http?.close();
    await (await import('@finnor/db')).closePool().catch(() => undefined);
    await admin?.end().catch(() => undefined);
    await postgres.stop().catch(error => results.push({ id: 'owned-db-stop', status: 'FAIL', predicate: String(error) }));
    await writeFile(join(out, 'cleanup.json'), JSON.stringify({
      ownedDatabaseDirectory: directory, stopped: true, directoryRetained: true,
      protectedActivation: false, realBusinessEffects: 0,
    }, null, 2));
    await save();
  }
}
const after = await sources();
await writeFile(join(out, 'source-check.json'), JSON.stringify({
  unchanged: JSON.stringify(before) === JSON.stringify(after), before, after,
}, null, 2));
process.exit(results.some(r => r.status === 'FAIL') || !results.some(r => r.status === 'PASS') ||
  JSON.stringify(before) !== JSON.stringify(after) ? 1 : 0);
