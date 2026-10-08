/** Failure-first P3 real auth/SQL/queue/native/checker/app/consumer challenges. */
import { strict as assert } from 'node:assert';
import { randomUUID, generateKeyPairSync, sign, createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir, mkdtemp, appendFile, rm, realpath } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { spawnSync, spawn, type ChildProcess } from 'node:child_process';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { closePool, getPool, acquireComputeResourceLeases, releaseComputeResourceLeases, COMPUTE_CUTOVER_EPOCH } from '@finnor/db';
import { migrate } from '../../packages/db/migrate';
import { assertDisposableDatabaseTarget } from '../../packages/db/production-target-guard';
import { POST } from '../../apps/api/app/api/branches/[operation]/route';
import { branchQueue } from '../../packages/private-equity/src/branch-fabric/worker';
import { actor, tx, head, inputFor, readArtifact, artifact } from '../../packages/private-equity/src/branch-fabric/store';
import { baselineState, createFixtureApp, fixtureRequest } from '../../packages/private-equity/src/branch-fabric/fixture';
import { verifyCleanCell, cleanNativePreparation } from '../../packages/private-equity/src/branch-fabric/preparation';
import { capability } from '../../packages/private-equity/src/branch-fabric/runtime';
import { hash, decode, PrepareSchema, canonical, type InputArtifact } from '../../packages/private-equity/src/branch-fabric/contracts';
import { checkCandidate } from '../../packages/private-equity/src/branch-fabric/checker';
import { createDeal } from '../../packages/private-equity/src/repository';
import { createInvestmentCase } from '../../packages/private-equity/src/world-repository';
import { createUnderwritingModel, createUnderwritingModelVersion, createUnderwritingRun } from '../../packages/private-equity/src/underwriting-repository';
import { createMetricSeries, attachCanonicalEvidenceToWorld, restateMetricObservation } from '@finnor/private-equity';
import { createEvidenceSource } from '@finnor/memory';
import { fitEnterpriseInterventionModel } from '../../packages/private-equity/src/enterprise-interventions';
import type { TenantContext } from '@finnor/shared-types';
import { GET as identityGet } from '../../apps/api/app/api/me/route';
import { requireContext } from '../../apps/api/lib/auth';
import { ownerChallenges, ownerHandlers } from './owner-e2e.mjs';
import { costOnce, workUsage } from '../../packages/private-equity/src/branch-fabric/accounting';
import { runPerformance } from './performance.mjs';
import { checkpointSecurity, deadlineSecurity } from './completion-security.mjs';
import { resourceSecurity } from './completion-resources.mjs';
import { generationSecurity } from './completion-generation.mjs';
import { episodeSecurity } from './completion-episode.mjs';
import { selectedBranch } from './disposable-queue.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
if (process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING) throw Error('AMBIENT_DATABASE_REFUSED');
process.env.NODE_ENV = 'test';
process.env.AUTH_DEV_BYPASS = '0';
process.env.FINNOR_TEST_MANAGED_EXTENSIONS = 'omit';
process.env.RATE_LIMIT_PER_MINUTE = '100000'; // Disposable runner, not product defaults.
process.env.RATE_LIMIT_IP_PER_MINUTE = '100000';
const phase = join(root, 'scope-pm/phase-03-p3-branch-fabric');
const browserMode = process.argv.includes('--browser');
const performanceMode = process.argv.includes('--performance');
const joinMode = process.argv.includes('--join');
const selectedCases = process.argv.find(a => a.startsWith('--cases='))?.slice('--cases='.length).split(',');
assert([browserMode, performanceMode, joinMode].filter(Boolean).length <= 1, 'EXCLUSIVE_RUN_MODE_REQUIRED');
let joinSuite: any;
if (joinMode) { const url = new URL('./join/owner-join.mts', import.meta.url).href; joinSuite = await import(url); }
const output = join(phase, 'scope-evidence', 'run-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
await mkdir(output, { recursive: true });
const custodyDirectory = await realpath(await mkdtemp(join(tmpdir(), 'p3-ephemeral-custody-')));
await mkdir(join(custodyDirectory, 'keys'), { mode: 0o700 });
const checkpointKey = randomBytes(32);
await writeFile(join(custodyDirectory, 'keys/disposable-p3-v1.key'), checkpointKey, { flag: 'wx', mode: 0o600 });
checkpointKey.fill(0);
await writeFile(join(custodyDirectory, 'current.json'), JSON.stringify({ schema: 'finnor.p3.local-keyring.v1',
  activeKeyId: 'disposable-p3-v1', maxRetentionMs: 86400000 }), { flag: 'wx', mode: 0o600 });
process.env.FINNOR_P3_CHECKPOINT_KEYRING = custodyDirectory;
const resourceRoot = await realpath(await mkdtemp(join(tmpdir(), 'p3-owned-resources-')));
process.env.FINNOR_P3_RESOURCE_ROOT = resourceRoot;
process.env.FINNOR_M1_PROFILE = 'DISPOSABLE_NATIVE';
process.env.FINNOR_M1_STORE = join(output, 'ordinary-m1-store');
process.env.FINNOR_P4_PROFILE = 'ordinary_disposable';
process.env.FINNOR_P4_EVIDENCE_DIR = join(output, 'ordinary-p4-store');
const digestBytes = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const protocol = JSON.parse(await readFile(join(phase, 'performance-protocol.json'), 'utf8'));
const sources: any[] = [];
async function snapshot(directory: string) {
  for (const name of (await readdir(directory, { withFileTypes: true }))) {
    const path = join(directory, name.name);
    if (name.isDirectory()) await snapshot(path);
    else if (/\.(ts|mts|json|sql|py|mjs|md)$/.test(name.name)) {
      const bytes = await readFile(path);
      sources.push({ path: path.slice(root.length + 1), sha256: digestBytes(bytes) });
    }
  }
}
await snapshot(join(root, 'finnor-os/packages/private-equity/src/branch-fabric'));
await snapshot(join(root, 'finnor-os/scripts/p3'));
for (const path of ['scope-pm/phase-03-p3-branch-fabric/failure-model.md', 'scope-pm/phase-03-p3-branch-fabric/migration.sql', 'scope-pm/phase-03-p3-branch-fabric/performance-protocol.json', 'finnor-os/packages/db/compute-contract.ts', 'finnor-os/apps/worker/src/queue.ts', 'finnor-os/apps/api/app/api/branches/[operation]/route.ts', 'src/components/centropy/canvas/BranchRehearsalPanel.tsx']) sources.push({ path, sha256: digestBytes(await readFile(join(root, path))) });
const cases: any[] = [], calls: any[] = [], acknowledgements: number[] = [], startedAt = new Date().toISOString();
let admin: pg.Client | undefined, postgres: EmbeddedPostgres | undefined, apiServer: Server | undefined, authServer: Server | undefined;
let frontend: ChildProcess | undefined;
let browserOwner: Fixture | undefined, browserOther: Fixture | undefined, browserDone = false, pauseQueue = false;
async function save(name: string, value: unknown) { const path = join(output, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value, null, 2) + '\n'); }
async function report() {
  await save('results.json', { schema: 'finnor.p3.e2e.v1', startedAt, observedAt: new Date().toISOString(), cases, calls, acknowledgementsMs: acknowledgements, sourceManifest: sources, protocolDigest: hash(protocol), protocol, qualification: 'PUBLIC_H0_REAL_SIGNED_LOCAL_JWT_ORDINARY_POSTGRES_QUEUE_NODE_SQLITE_CHECKER_NOT_LINUX_OR_PROTECTED_ADMISSION', rerun: 'env -u DATABASE_URL -u POSTGRES_URL -u POSTGRES_URL_NON_POOLING node --import=tsx finnor-os/scripts/p3/run-e2e.mts' });
}
async function challenge(id: string, steps: string[], expected: string, fn: () => Promise<unknown>) {
  if (selectedCases && !selectedCases.includes(id)) { cases.push({ id, status: 'NOT_RUN_EXCLUDED', reason: 'EXPLICIT_SELECTION', countedAsPass: false }); return; }
  const began = performance.now(), caseRecord: any = { id, steps, expected, input: { protocolDigest: hash(protocol), sourceDigest: hash(sources) }, status: 'RUNNING' };
  cases.push(caseRecord); await report();
  try { caseRecord.observed = await fn(); caseRecord.status = 'PASS_LOCAL'; }
  catch (e) { caseRecord.status = 'FAIL'; caseRecord.observed = e instanceof Error ? { message: e.message, stack: e.stack } : String(e);
    console.error(JSON.stringify({ id, status: 'FAIL', observed: caseRecord.observed })); }
  caseRecord.elapsedMs = performance.now() - began;
  await save(`cases/${id}.json`, caseRecord); await report();
  console.log(JSON.stringify({ id, status: caseRecord.status }));
}
async function listen(server: Server): Promise<number> {
  await new Promise<void>((ok, no) => { server.once('error', no); server.listen(0, '127.0.0.1', ok); });
  const a = server.address(); assert(a && typeof a !== 'string'); return a.port;
}
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = { ...rsa.publicKey.export({ format: 'jwk' }), kid: 'p3-local-rsa-v1', alg: 'RS256', use: 'sig' };
let authOrigin = '', apiOrigin = '';
function token(email: string, principalId: string, expires = 3600) {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url'), now = Math.floor(Date.now() / 1000);
  const body = part({ alg: 'RS256', typ: 'JWT', kid: publicJwk.kid }) + '.' + part({ sub: principalId, email, aud: 'authenticated', role: 'authenticated', iss: authOrigin + '/auth/v1', iat: now, exp: now + expires });
  return body + '.' + sign('RSA-SHA256', Buffer.from(body), rsa.privateKey).toString('base64url');
}
interface Fixture { ctx: TenantContext; workId: string; rootId: string; email: string; token: string }
async function fixture(label: string): Promise<Fixture> {
  const ctx: TenantContext = { tenantId: randomUUID(), userId: randomUUID(), role: 'owner' }; ctx.employeeId = ctx.userId;
  const workId = randomUUID(), rootId = randomUUID(), email = label + '@p3.example.test';
  await admin!.query("INSERT INTO finnor_os.tenants(id,name,client_key) VALUES($1,$2,$3)", [ctx.tenantId, label, randomUUID()]);
  await admin!.query("INSERT INTO finnor_os.tenant_vertical_assignments(tenant_id,vertical_key,version,effective_from,source_system,created_by) VALUES($1,'private_equity',1,now(),'p3:e2e','fixture-authority')", [ctx.tenantId]);
  await admin!.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')", [ctx.userId, ctx.tenantId, email]);
  await admin!.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,$3,'other')", [rootId, ctx.tenantId, label]);
  await admin!.query("INSERT INTO finnor_os.works(id,tenant_id,status,initial_channel,initial_instruction,created_by,current_owner_id) VALUES($1,$2,'received','text','Registered public P3 fixture',$3,$3)", [workId, ctx.tenantId, ctx.userId]);
  const instruction = randomUUID();
  await admin!.query("INSERT INTO finnor_os.work_inputs(id,tenant_id,work_id,instruction_id,channel,instruction_text,created_by) VALUES($1,$2,$3,$4,'text','Registered public P3 fixture',$5)", [randomUUID(), ctx.tenantId, workId, instruction, ctx.userId]);
  return { ctx, workId, rootId, email, token: token(email, ctx.userId) };
}
async function api(f: Fixture, op: string, body: unknown, bearer = f.token) {
  const began = performance.now();
  const response = await fetch(apiOrigin + '/api/branches/' + op, { method: 'POST', headers: { authorization: 'Bearer ' + bearer, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result: any = { status: response.status, body: await response.json(), elapsedMs: performance.now() - began };
  calls.push({ op, tenant: f.ctx.tenantId, principal: actor(f.ctx), status: result.status, elapsedMs: result.elapsedMs });
  await save(`calls/${String(calls.length).padStart(4, '0')}-${op}.json`, { op, tenant: f.ctx.tenantId, principal: actor(f.ctx), request: body, response: result });
  if (op === 'submit') acknowledgements.push(result.elapsedMs);
  return result;
}
function successful(r: any) { assert(r.status >= 200 && r.status < 300, JSON.stringify(r)); return r.body; }
const pureSource = (leverageTenths = 35, reserve = 0) => ({ kind: 'public_fixture', fixture: 'allocation-abc-v1', parameters: { equity: 95, leverageTenths, reserve } });
async function prepared(f: Fixture, source: any = pureSource(), kind = 'pure') {
  return successful(await api(f, 'prepare', { workId: f.workId, root: { entityType: 'external_organization', entityId: f.rootId }, kind, profile: 'TRUSTED_NATIVE_H0', source }));
}
async function submitted(f: Fixture, p: any, mode = 'COLD_BUILD', extra: any = {}) {
  return successful(await api(f, 'submit', { schema: 'finnor.branch-request.v1', workId: f.workId, inputId: p.inputId, programme: p.programme, mode, idempotencyKey: randomUUID(), ...extra }));
}
async function run(f: Fixture, p: any, hooks = {}, mode = 'COLD_BUILD') {
  const s = await submitted(f, p, mode);
  assert.equal(await tickBranch(s.branchId, branchQueue(hooks)), true);
  const branch = successful(await api(f, 'read', { branchId: s.branchId }));
  await save(`branches/${s.branchId}.json`, await sqlState(f, s.branchId));
  return { s, branch };
}
async function tickBranch(branchId: string, queue = branchQueue()) {
  return selectedBranch(admin!, branchId, async () => {
    const target = (await admin!.query('SELECT job_id FROM finnor_os.p3_requests WHERE id=$1', [branchId])).rows[0];
    const before = (await admin!.query('SELECT id,status,run_at,attempts,claim_fence FROM finnor_os.jobs WHERE id=$1',
      [target.job_id])).rows[0];
    const ticked = await queue.tick();
    const after = (await admin!.query('SELECT id,status,run_at,attempts,claim_fence FROM finnor_os.jobs WHERE id=$1',
      [target.job_id])).rows[0];
    await save(`queue-selection/${branchId}-${randomUUID()}.json`, { branchId, before, after, ticked,
      qualification: 'REAL_JOBQUEUE_EXACT_AGENT_CREATED_DISPOSABLE_DELIVERY' });
    return ticked;
  });
}
async function sqlState(f: Fixture, id: string) {
  return tx(f.ctx, async c => ({
    role: (await c.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0],
    head: await head(c, f.ctx, id), artifacts: (await c.query("SELECT id,category,content_digest,body FROM finnor_os.p3_artifacts WHERE tenant_id=$1 AND principal_id=$2 AND body->>'branchId'=$3 ORDER BY recorded_at,id", [f.ctx.tenantId, actor(f.ctx), id])).rows,
  }));
}
async function controllerProof(boundary: string, branchId: string) {
  const target = (await admin!.query('SELECT job_id,tenant_id,principal_id FROM finnor_os.p3_requests WHERE id=$1', [branchId])).rows[0];
  assert(target?.job_id, 'Crash observer requires its exact submitted job');
  const deferred = (await admin!.query(`SELECT id,run_at FROM finnor_os.jobs
    WHERE status='queued' AND type='run_branch_fabric_v1' AND id<>$1`, [target.job_id])).rows;
  // Other agent-created jobs retain their state and remain retryable. This is
  // disposable test scheduling, not an alternate production queue or claim.
  await save(`physical-crashes/${branchId}-${boundary}-selection.json`, { branchId, targetJobId: target.job_id,
    deferredJobs: deferred.map(r => r.id), scope: 'THIS_NEW_DISPOSABLE_CLUSTER_ONLY' });
  return selectedBranch(admin!, branchId, async () => {
  const began = performance.now(), startedAt = new Date().toISOString();
  const child = spawn(process.execPath, ['--import=tsx', join(root,'finnor-os/scripts/p3/controller-worker.mts'), boundary], {
    cwd:join(root,'finnor-os'), stdio:['ignore','pipe','pipe'],
    env:{PATH:process.env.PATH,NODE_ENV:'test',DATABASE_URL:process.env.DATABASE_URL,LOG_LEVEL:'silent',FINNOR_P3_DISPOSABLE_CONTROLLER_PROOF:'1',AUTH_DEV_BYPASS:'0',
      FINNOR_P3_RESOURCE_ROOT:resourceRoot,FINNOR_P3_CHECKPOINT_KEYRING:custodyDirectory},
  });
  let stdout='', stderr='', outputOverflow=false, deadlineReached=false, spawnError=false;
  let forceStop: ReturnType<typeof setTimeout> | undefined;
  const stopOwnedController = () => {
    child.kill('SIGTERM');
    forceStop ??= setTimeout(() => { child.kill('SIGKILL'); }, 250);
  };
  const appendOutput = (prior: string, chunk: Buffer) => {
    const next = prior + chunk.toString();
    if (next.length >= 131072) { outputOverflow = true; stopOwnedController(); }
    return next.slice(0, 131072);
  };
  child.stdout!.on('data',b=>{stdout=appendOutput(stdout,b);});
  child.stderr!.on('data',b=>{stderr=appendOutput(stderr,b);});
  const observations: any[] = [];
  let observing: Promise<void> | null = null;
  const observe = () => {
    if (observing || observations.length >= 12) return;
    observing = (async () => {
      const observedAt = new Date().toISOString(), elapsedMs = performance.now() - began;
      try {
        const state = await tx({ tenantId: target.tenant_id, userId: target.principal_id, role: 'owner' }, async c => {
          await c.query('SET LOCAL statement_timeout=1000');
          return {
            role: (await c.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0],
            head: (await c.query('SELECT id,status,generation,epoch,attempt_id,result_id,reason FROM finnor_os.p3_requests WHERE id=$1', [branchId])).rows[0],
            job: (await c.query('SELECT id,status,attempts,claim_fence,lease_expires_at,clock_timestamp() server_now FROM finnor_os.jobs WHERE id=$1', [target.job_id])).rows[0],
            resources: (await c.query('SELECT id,kind,state,cleanup_observed,process_group,reason FROM finnor_os.p3_resource_intents WHERE branch_id=$1 ORDER BY created_at,id', [branchId])).rows,
            artifacts: (await c.query("SELECT category,count(*)::int count FROM finnor_os.p3_artifacts WHERE body->>'branchId'=$1 GROUP BY category ORDER BY category", [branchId])).rows,
          };
        });
        const waits = (await admin!.query(`SELECT pid,state,wait_event_type,wait_event,pg_blocking_pids(pid) blocking
          FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()`)).rows;
        observations.push({ observedAt, elapsedMs, state, waits });
      } catch { observations.push({ observedAt, elapsedMs, observationUnavailable: true }); }
    })().finally(() => { observing = null; });
  };
  const closed = new Promise<void>(yes => child.once('close', () => yes()));
  observe();
  const observationTimer = setInterval(observe, 1000);
  const exit = await new Promise<{code:number|null;signal:NodeJS.Signals|null}>(yes=>{
    const timer=setTimeout(()=>{deadlineReached=true;stopOwnedController();},10000);
    child.once('error',()=>{spawnError=true;clearTimeout(timer);yes({code:null,signal:null});});
    child.once('exit',(code,signal)=>{clearTimeout(timer);yes({code,signal});});
  });
  clearInterval(observationTimer); if (forceStop) clearTimeout(forceStop);
  await closed;
  if (observing) await observing;
  observe(); if (observing) await observing;
  const proof = {controllerPid:child.pid,boundary,branchId,targetJobId:target.job_id,...exit,stdout,stderr,
    startedAt, elapsedMs:performance.now()-began, originalProofDeadlineMs:10000,
    deadlineReached, outputOverflow, spawnError, observations};
  await save(`physical-crashes/${branchId}-${boundary}-controller.json`, proof);
  if (deadlineReached) throw Error('CONTROLLER_PROOF_DEADLINE');
  assert(!spawnError, 'CONTROLLER_SPAWN_FAILED'); assert(!outputOverflow, 'CONTROLLER_OUTPUT_BOUND');
  if (exit.signal === 'SIGKILL') {
    const marker = stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })
      .find(row => row.boundary === boundary && row.event === undefined);
    assert.equal(marker?.branchId, branchId, 'Controller died at a different branch boundary');
    assert.equal(marker?.controllerPid, child.pid, 'Crash marker names a different controller');
  }
  return proof;
  });
}
async function stoppedNativeGroups(state: any) {
  const groups:number[] = [...new Set<number>(state.artifacts.filter((r:any)=>r.category==='EVENT'&&r.body.processGroup).map((r:any)=>Number(r.body.processGroup)))];
  const deadline=Date.now()+3000, observations:any[]=[];
  for(;;) {
    const remaining=groups.filter(group=>{try{process.kill(-group,0);return true;}catch{return false;}});
    observations.push({at:new Date().toISOString(),remaining});
    if(!remaining.length) return {groups,observations,observedStopped:true};
    assert(Date.now()<deadline,'Native descendants survived controller death');
    await new Promise(r=>setTimeout(r,50));
  }
}
try {
  const dbDir = await mkdtemp(join(tmpdir(), 'finnor-p3-postgres-'));
  const reservation = createServer((_req, res) => res.end()), dbPort = await listen(reservation); await new Promise<void>(ok => reservation.close(() => ok()));
  postgres = new EmbeddedPostgres({ databaseDir: dbDir, user: 'finnor', password: 'finnor', port: dbPort, persistent: false, onLog: () => undefined });
  await postgres.initialise(); await appendFile(join(dbDir, 'postgresql.conf'),
    '\ntrack_commit_timestamp=on\nmax_wal_size=64MB\nmin_wal_size=32MB\ncheckpoint_timeout=30s\n');
  await postgres.start(); await postgres.createDatabase('p3_e2e');
  const ownerUrl = `postgres://finnor:finnor@127.0.0.1:${dbPort}/p3_e2e`;
  assertDisposableDatabaseTarget(ownerUrl, 'P3 independent cluster');
  const baseMigrations = await migrate(ownerUrl);
  const candidateSql = await readFile(join(phase, 'migration.sql'), 'utf8');
  const phaseMigrations = baseMigrations.filter(name=>[
    '0158_completion_p3_branch_fabric_candidate.sql','0167_p3_checkpoint_lifecycle.sql',
    '0168_p3_resource_ownership.sql','0169_p3_episode_deadline.sql',
  ].includes(name));
  assert.equal(phaseMigrations.length,4,'Canonical P3 base and lifecycle migrations must each install once');
  admin = new pg.Client({ connectionString: ownerUrl }); await admin.connect();
  await save('database.json', { schema: 'finnor.p3.disposable-database.v1', directory: dbDir, port: dbPort, database: 'p3_e2e', baseMigrations, phaseMigrations, phaseSqlDigest: digestBytes(candidateSql), ordinaryRole: 'finnor_app', qualification: 'NEW_AGENT_CREATED_DISPOSABLE_LOOPBACK_CLUSTER_NO_AMBIENT_TARGET', runtime: (await admin.query('SELECT version() AS version')).rows[0] });
  await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'p3_disposable_app'");
  await admin.query("SET app.test_vertical_mode='explicit'");
  if (process.env.P3_GOVERNORS === '1') await admin.query(
    "INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,enabled,source) VALUES('provider:m1-native',2,2,0,120,true,'P3 disposable missing-record owner prerequisite') ON CONFLICT(resource_key) DO NOTHING");
  await admin.query("UPDATE finnor_os.compute_plane_cutover SET state='authoritative',accepted_job_epoch=$1,minimum_claim_epoch=$1,enforce_known_job_types=true,legacy_tenant_writes_allowed=false,activated_release_sha=$2,activated_at=clock_timestamp() WHERE singleton=true", [COMPUTE_CUTOVER_EPOCH, '3'.repeat(40)]);
  process.env.DATABASE_URL = `postgres://finnor_app:p3_disposable_app@127.0.0.1:${dbPort}/p3_e2e`;
  await closePool();
  authServer = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json'); res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'authorization,content-type,apikey,x-client-info');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.url?.includes('/.well-known/jwks.json')) { res.end(JSON.stringify({ keys: [publicJwk] })); return; }
    const parsed = new URL(req.url ?? '/', authOrigin || 'http://127.0.0.1');
    if (browserMode && parsed.pathname === '/__p3/session') {
      const owner = parsed.searchParams.get('identity') === 'other' ? browserOther : browserOwner;
      if (!owner) { res.writeHead(503); res.end('{"code":"FIXTURE_NOT_READY"}'); return; }
      const expires = parsed.searchParams.get('identity') === 'expired' ? -1 : 1200;
      res.end(JSON.stringify({ access_token: token(owner.email, owner.ctx.userId, expires), refresh_token: 'disposable-fixture-nonrefreshing', token_type: 'bearer', expires_in: expires, expires_at: Math.floor(Date.now()/1000)+expires, user: { id: owner.ctx.userId, email: owner.email, aud: 'authenticated', role: 'authenticated', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, created_at: new Date().toISOString() } }));
      return;
    }
    if (browserMode && parsed.pathname === '/__p3/control' && req.method === 'POST') {
      try {
        assert(browserOwner);
        const chunks: Buffer[] = []; let size = 0; for await (const raw of req) { size += raw.length; assert(size <= 1024); chunks.push(Buffer.from(raw)); }
        const command = JSON.parse(Buffer.concat(chunks).toString());
        assert.deepEqual(Object.keys(command), ['operation']);
        switch(command.operation) {
          case 'pause': pauseQueue = true; break;
          case 'unpause': pauseQueue = false; break;
          case 'revise': await admin!.query("INSERT INTO finnor_os.work_inputs(id,tenant_id,work_id,instruction_id,channel,instruction_text,created_by) VALUES($1,$2,$3,$4,'text','Browser material Work change',$5)", [randomUUID(), browserOwner.ctx.tenantId, browserOwner.workId, randomUUID(), browserOwner.ctx.userId]); break;
          case 'suspend': await admin!.query("UPDATE finnor_os.users SET status='suspended' WHERE id=$1", [browserOwner.ctx.userId]); break;
          case 'reactivate': await admin!.query("UPDATE finnor_os.users SET status='active' WHERE id=$1", [browserOwner.ctx.userId]); break;
          case 'finish': browserDone = true; break;
          default: throw Error('UNKNOWN_FIXTURE_CONTROL');
        }
        res.end('{"fixtureControlApplied":true}'); return;
      } catch { res.writeHead(400); res.end('{"code":"FIXTURE_CONTROL_REFUSED"}'); return; }
    }
    res.writeHead(404); res.end('{"error":"fixture authority endpoint unavailable"}');
  });
  authOrigin = 'http://127.0.0.1:' + await listen(authServer);
  process.env.SUPABASE_URL = authOrigin; process.env.SUPABASE_SERVICE_ROLE_KEY = 'p3-local-public-test-key-not-production';
  apiServer = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const raw of req) chunks.push(Buffer.from(raw));
      const op = req.url?.split('/').at(-1) ?? '';
      const request = new Request(apiOrigin + req.url, { method: req.method, headers: req.headers as any, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
      const domain = req.url?.split('/')[2] ?? '';
      const handler = domain === 'branches' ? POST : domain === 'company-brain' && joinMode ? joinSuite.joinHandler : ownerHandlers[domain];
      let response: Response;
      if (req.url === '/api/me') response = await identityGet(request);
      else { assert(handler, 'FINITE_LOCAL_OWNER_ROUTE_REQUIRED'); response = await handler(request, { params: Promise.resolve({ operation: op }) }); }
      const headers: Record<string, string> = {}; response.headers.forEach((value, key) => { headers[key] = value; });
      res.writeHead(response.status, headers); res.end(await response.text());
    } catch { res.writeHead(500); res.end('{"code":"LOCAL_HTTP_FAILED"}'); }
  });
  apiOrigin = 'http://127.0.0.1:' + await listen(apiServer);
  const f = await fixture('p3-owner'), other = await fixture('p3-other');
  await save('database.json', { schema: 'finnor.p3.disposable-database.v1', directory: dbDir, port: dbPort, database: 'p3_e2e', baseMigrations, phaseMigrations, phaseSqlDigest: digestBytes(candidateSql), ordinaryRole: 'finnor_app', qualification: 'NEW_AGENT_CREATED_DISPOSABLE_LOOPBACK_CLUSTER_NO_AMBIENT_TARGET', runtime: (await admin.query('SELECT version() AS version')).rows[0] });
  await save('authorities.json', { schema: 'finnor.p3.test-authority.v1', authOrigin, apiOrigin, publicJwk, owner: { tenantId: f.ctx.tenantId, principalId: actor(f.ctx), workId: f.workId, rootId: f.rootId }, other: { tenantId: other.ctx.tenantId, principalId: actor(other.ctx) }, domain: 'SIGNED_DISPOSABLE_TEST_AUTHORITY_NOT_PRODUCTION_SUPABASE' });
  if (browserMode) {
    browserOwner = f; browserOther = other;
    const reservation = createServer((_req,res)=>res.end()), frontendPort = await listen(reservation);
    await new Promise<void>(ok=>reservation.close(()=>ok()));
    const frontendOrigin = 'http://127.0.0.1:' + frontendPort;
    frontend = spawn(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', String(frontendPort), '--webpack'], {
      cwd: root, detached: true, stdio: ['ignore','pipe','pipe'],
      env: { PATH: process.env.PATH, HOME: root, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', NEXT_PUBLIC_SUPABASE_URL: authOrigin, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'p3-public-disposable-test-authority', NEXT_PUBLIC_OS_API_URL: apiOrigin, FINNOR_BUILD_ID: 'p3-disposable-native-browser', AUTH_DEV_BYPASS: '0' },
    });
    frontend.stdout!.on('data', b=>void appendFile(join(output,'frontend.log'),b));
    frontend.stderr!.on('data', b=>void appendFile(join(output,'frontend.log'),b));
    const url = `${frontendOrigin}/branches?workId=${f.workId}&rootId=${f.rootId}`;
    await save('browser-ready.json', { url, frontendOrigin, authOrigin, apiOrigin, output, workId:f.workId, rootId:f.rootId, qualification:'REAL_MOUNTED_NEXT_SUPABASE_CLIENT_PROXY_SIGNED_FIXTURE_JWT_NO_AUTH_BYPASS_NO_PRODUCTION_CREDENTIALS' });
    console.log(JSON.stringify({ browserReady: join(output,'browser-ready.json'), url }));
    await challenge('S-mounted-browser', ['Actual Next app and existing Supabase client','Signed JWT/JWKS through real frontend proxy and requireContext','Real ordinary SQL/queue/native/checker','Browser assertions retained separately'], 'Real mounted workflow, historical class retained, no cross-principal or stale numbers; independently asserted browser proof required', async()=>{
      const queue = branchQueue();
      const deadline = Date.now()+10*60*1000;
      while(!browserDone && Date.now()<deadline) {
        if(!pauseQueue) await queue.tick();
        await new Promise(r=>setTimeout(r,100));
      }
      assert(browserDone,'Browser deadline exhausted');
      const proof = JSON.parse(await readFile(join(output,'browser-proof.json'),'utf8'));
      assert.equal(proof.status,'PASS_LOCAL'); assert(proof.assertions.length>=10 && proof.assertions.every((v:any)=>v.passed===true));
      const heads = await tx(f.ctx,c=>c.query('SELECT id,status,result_id,checkpoint_id FROM finnor_os.p3_requests WHERE tenant_id=$1 AND principal_id=$2',[f.ctx.tenantId,actor(f.ctx)]));
      await save('browser-sql-after.json',heads.rows);
      return { proof, heads:heads.rows, controllerObservedFinished:true };
    });
  } else if (performanceMode) {
    await runPerformance({ owner: f, output, protocol, sources, prepared, run, api, queue: branchQueue, sqlState, save, challenge });
  } else if (joinMode) {
    assert(baseMigrations.includes('0155_p4_evidence_execution.sql'));
    assert(baseMigrations.includes('0165_m3_capital_program.sql'));
    await joinSuite.joinChallenges({ root, output, admin, other, fixture, apiOrigin, save, challenge, api, prepared, submitted, run, sqlState, migrationCount: baseMigrations.length });
  } else {
  let p: any, first: any, appRun: any, cp: any;
  await challenge('A-isolation-auth-target', ['New cluster/migrations', 'Signed RS256 token through requireContext', 'Foreign/expired token', 'Ordinary-role SQL'], 'Independent packages, real verified JWT, no superuser/BYPASSRLS or non-loopback target', async () => {
    assert(baseMigrations.length >= 153);
    assert.equal(new Set(baseMigrations).size, baseMigrations.length);
    assert.deepEqual(phaseMigrations, ['0158_completion_p3_branch_fabric_candidate.sql', '0167_p3_checkpoint_lifecycle.sql', '0168_p3_resource_ownership.sql', '0169_p3_episode_deadline.sql']);
    const applied = (await admin!.query('SELECT name FROM finnor_os._migrations ORDER BY name')).rows.map(r => r.name);
    assert.deepEqual(applied, [...baseMigrations, ...phaseMigrations].sort());
    const role = (await getPool().query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]; assert.equal(role.rolsuper, false); assert.equal(role.rolbypassrls, false);
    assert.throws(() => assertDisposableDatabaseTarget('postgres://fixture:fixture@203.0.113.1/p3', 'P3'));
    p = await prepared(f);
    assert.equal((await api(f, 'prepare', { workId: f.workId, root: { entityType: 'external_organization', entityId: f.rootId }, kind: 'pure', profile: 'TRUSTED_NATIVE_H0', source: pureSource() }, token(f.email, f.ctx.userId, -1))).status, 401);
    const forged = f.token.slice(0, -8) + 'forged00'; assert.equal((await api(f, 'list', { workId: f.workId }, forged)).status, 401);
    return { role, prepared: p, sourceManifestDigest: hash(sources), capability: await capability() };
  });
  await challenge('B-native-34-32-20', ['Immutable public fixture ingestion', 'Real existing decimal compiler/executor', 'Durable queue→native child→independent checker→SQL result'], 'A+C34, B+C32, A20; exact lineage and no isolated/admitted/settled label', async () => {
    const observations = [];
    for (const [leverage, reserve, ids, value] of [[35, 0, ['A', 'C'], 34], [30, 0, ['B', 'C'], 32], [30, 25, ['A'], 20]] as const) {
      const preparedCut = await prepared(f, pureSource(leverage, reserve)), executed = await run(f, preparedCut);
      assert.equal(executed.branch.status, 'COMPLETE'); assert.deepEqual(executed.branch.result.result.selected, ids); assert.equal(executed.branch.result.result.registeredPayoff, value);
      assert.equal(executed.branch.result.evidenceClass, 'COMPUTATION'); assert.equal(executed.branch.result.accepted, false); assert.equal(executed.branch.result.externalSettlement, 'NOT_APPLICABLE'); assert.equal(executed.branch.result.check.passed, true);
      const persisted = await sqlState(f, executed.s.branchId); assert.equal(persisted.role.rolbypassrls, false); observations.push({ preparedCut, executed, persisted });
      first ??= executed;
    }
    return observations;
  });
  await challenge('B-strict-identity-and-schema', ['Unknown fields', 'Nonfinite/cyclic/null/ambiguous programme', 'Exact idempotency replay/conflict'], 'Strict refusal; caller authority/URL/shell never admitted', async () => {
    assert.throws(() => decode(PrepareSchema, { extra: true }));
    const cyclic: any = {}; cyclic.self = cyclic; assert.throws(() => decode(PrepareSchema, cyclic), /CYCLIC/);
    const source = pureSource(); source.parameters.equity = NaN; assert.throws(() => decode(PrepareSchema, { workId: f.workId, root: { entityType: 'external_organization', entityId: f.rootId }, kind: 'pure', profile: 'TRUSTED_NATIVE_H0', source }), /NON_FINITE/);
    const bad = await api(f, 'submit', { schema: 'finnor.branch-request.v1', workId: f.workId, inputId: p.inputId, programme: { ...p.programme, id: 'shell' }, mode: 'COLD_BUILD', idempotencyKey: 'invalid-programme', command: 'touch /tmp/escape' }); assert.equal(bad.status, 400);
    const request = { schema: 'finnor.branch-request.v1', workId: f.workId, inputId: p.inputId, programme: p.programme, mode: 'COLD_BUILD', idempotencyKey: randomUUID() };
    const created = successful(await api(f, 'submit', request)), replay = successful(await api(f, 'submit', request)); assert.equal(created.branchId, replay.branchId); assert.equal(replay.semanticReplay, true);
    const conflict = await api(f, 'submit', { ...request, mode: 'CLEAN_WARM_IMAGE' }); assert.equal(conflict.status, 409);
    successful(await api(f, 'cancel', { branchId: created.branchId })); await tickBranch(created.branchId);
    return { bad, replay, conflict };
  });
  await challenge('C-equal-answer-tenant-theft', ['Equal fixture inputs in different tenant', 'Foreign read/input/checkpoint/ref', 'Forced RLS raw SQL'], 'Generic unavailable, zero foreign metadata/rows', async () => {
    const equal = await run(other, await prepared(other)); assert.deepEqual(equal.branch.result.result.selected, first.branch.result.result.selected); assert.equal(equal.branch.result.result.registeredPayoff, first.branch.result.result.registeredPayoff);
    const foreignRead = await api(other, 'read', { branchId: first.s.branchId }); assert.equal(foreignRead.status, 404); assert.deepEqual(foreignRead.body, { code: 'PERMITTED_BRANCH_UNAVAILABLE' });
    const stolen = await api(other, 'submit', { schema: 'finnor.branch-request.v1', workId: other.workId, inputId: p.inputId, programme: p.programme, mode: 'COLD_BUILD', idempotencyKey: randomUUID() }); assert.equal(stolen.status, 404);
    const resultId = (await sqlState(f, first.s.branchId)).head.result_id;
    const raw = await tx(other.ctx, c => c.query('SELECT id,body FROM finnor_os.p3_artifacts WHERE id=$1', [resultId])); assert.equal(raw.rows.length, 0);
    const list = await api(other, 'list', { workId: f.workId }); assert.equal(list.status, 404);
    const deniedMutation = await tx(f.ctx, async c => { try { await c.query("UPDATE finnor_os.p3_artifacts SET body='{}'::jsonb WHERE category='INPUT'"); return false; } catch { return true; } }); assert(deniedMutation);
    return { equalResultPositiveControl: equal, foreignRead, stolen, list, rawRows: raw.rows, appendOnlyDenied: deniedMutation };
  });
  await challenge('D-dirty-public-warm-cell', ['Prepare public clean manifest', 'Inject private cookie', 'Reassignment cleanliness check'], 'Dirty cache quarantined; no assigned identity/data in clean positive control', async () => {
    const input = await inputFor(f.ctx, p.inputId), preparation = await cleanNativePreparation(input, 'CLEAN_WARM_IMAGE');
    await verifyCleanCell(preparation.directory, preparation.publicManifest);
    await writeFile(join(preparation.directory, 'cookie.txt'), 'prior-tenant-marker');
    await assert.rejects(() => cleanNativePreparation(input, 'CLEAN_WARM_IMAGE'), /DIRTY_WARM_CELL/);
    await rm(join(preparation.directory, 'cookie.txt'));
    return { preparation, refusedDirty: true };
  });
  await challenge('G-H-private-financing-three-branches', ['Three actual private SQLite/file applications', 'Autosave/null clear/navigation/background/submit', 'Independent full-state observer'], 'Only C_01 feeUSD20; C_010 remainsUSD200; baseline and other branch differ only privately', async () => {
    const before = baselineState(), observations = [];
    for (let i = 0; i < 3; i++) {
      const steps = [{ operation: 'autosave', target: 'C_01', feeCents: 2000, memo: null, effectId: randomUUID() }, { operation: 'navigate', target: 'C_01', effectId: randomUUID() }, { operation: 'submit', target: 'C_01', effectId: randomUUID() }];
      const appPrepared = await prepared(f, { kind: 'financing_fixture', steps }, 'application_fixture'), result = await run(f, appPrepared, {}, i ? 'PRIVATE_STATE_CLONE' : 'COLD_BUILD');
      assert.equal(result.branch.status, 'COMPLETE'); const state = result.branch.result.candidate.state;
      assert.equal(state.rows.find((r: any) => r.id === 'C_01').feeCents, 2000); assert.equal(state.rows.find((r: any) => r.id === 'C_010').feeCents, 20000); assert.equal(state.rows[0].memo, null); assert.equal(state.effects.length, 3);
      assert.equal(result.branch.result.evidenceClass, 'APPLICATION_FIXTURE'); observations.push(result); appRun ??= { ...result, prepared: appPrepared };
    }
    assert.deepEqual(baselineState(), before); assert.equal(new Set(observations.map(o => o.branch.result.result.identity)).size, 3);
    return { baselineBefore: before, baselineAfter: baselineState(), branches: observations, linuxEgressProof: 'BLOCKED_EXTERNAL_NOT_COUNTED_AS_PASS' };
  });
  await challenge('B-fixture-post-accept-ack-loss', ['Real app commit then socket interruption', 'No mutation retry', 'Read back exact effect identity', 'Omitted/null/zero'], 'Committed effect once, exact C_010 unchanged, nullable clear distinct from omission/zero', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'p3-ack-loss-'));
    let app: any, effectId = randomUUID(), failed = false;
    app = await createFixtureApp(baselineState(), directory, { afterCommit: async id => { if (id === effectId && !failed) { failed = true; app.server.closeAllConnections(); } } });
    try {
      await assert.rejects(() => fixtureRequest(app, '/step', { operation: 'autosave', target: 'C_01', feeCents: 2000, memo: null, effectId }));
      const readback = await fixtureRequest(app, '/effects/' + effectId); assert.equal(readback.effectId, effectId);
      await fixtureRequest(app, '/step', { operation: 'autosave', target: 'C_01', feeCents: 0, effectId: randomUUID() });
      const state = await app.state(); assert.equal(state.rows[0]!.feeCents, 0); assert.equal(state.rows[0]!.memo, null); assert.equal(state.rows[1]!.feeCents, 20000); assert.equal(state.effects.length, 2);
      return { effectId, readback, state, mutationsAfterAckLoss: 'NO_REPEAT_READBACK_ONLY' };
    } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
  });
  await challenge('H-I-checkpoint-private-restore', ['Commit logical DB/file snapshot', 'Ordinary private checkpoint policy', 'Fresh branch restore', 'Corruption/foreign refusal'], 'Exact complete state restored with fresh identity; invalid snapshot refused', async () => {
    cp = successful(await api(f, 'checkpoint', { branchId: appRun.s.branchId }));
    const resumed = successful(await api(f, 'resume', { branchId: appRun.s.branchId, checkpointId: cp.checkpointId, idempotencyKey: randomUUID() }));
    assert.equal(await tickBranch(resumed.branchId), true);
    const result = successful(await api(f, 'read', { branchId: resumed.branchId })); assert.equal(result.status, 'COMPLETE');
    assert.deepEqual(result.result.candidate.state, appRun.branch.result.candidate.state); assert.notEqual(result.result.result.identity, appRun.branch.result.result.identity);
    const stolen = await api(other, 'resume', { branchId: appRun.s.branchId, checkpointId: cp.checkpointId, idempotencyKey: randomUUID() }); assert.equal(stolen.status, 404);
    const corrupt = await tx(f.ctx, async c => { const body = await readArtifact<any>(c, f.ctx, cp.checkpointId, 'CHECKPOINT');
      if (body.schema === 'finnor.branch-checkpoint-sealed.v2') body.binding.inputDigest = '0'.repeat(64);
      else body.state.rows[0].feeCents = 2001;
      return artifact(c, f.ctx, f.workId, 'CHECKPOINT', body); });
    const rejected = await api(f, 'resume', { branchId: appRun.s.branchId, checkpointId: corrupt, idempotencyKey: randomUUID() }); assert.equal(rejected.status, 409);
    return { cp, resumed, result, stolen, rejected };
  });
  await checkpointSecurity({ owner: f, other, appRun, admin, custodyDirectory, api, challenge, tickBranch, save });
  await challenge('J-publication-crash-matrix', ['Failure after durable launch intent/blob/pointer', 'Real queue redelivery/restart', 'Independent SQL before/after'], 'One live result per generation; no duplicate ACK launch or lost attempt/cost; orphans discoverable', async () => {
    const observations = [];
    for (const boundary of ['AFTER_INTENT', 'BEFORE_CHECK', 'AFTER_BLOB_BEFORE_POINTER', 'AFTER_POINTER_BEFORE_ACK']) {
      const cut = await prepared(f), s = await submitted(f, cut); let injected = false;
      await tickBranch(s.branchId, branchQueue({ boundary: async name => { if (name === boundary && !injected) { injected = true; throw Error('INJECTED_CONTROLLER_INTERRUPTION:' + name); } } }));
      const before = await sqlState(f, s.branchId);
      await admin!.query("UPDATE finnor_os.jobs SET run_at=clock_timestamp() WHERE id=$1 AND status='queued'", [before.head.job_id]);
      await tickBranch(s.branchId);
      const after = await sqlState(f, s.branchId), result = successful(await api(f, 'read', { branchId: s.branchId }));
      await save(`faults/${boundary}.json`, { boundary, before, after, result });
      assert.equal(result.status, 'COMPLETE');
      const published = after.artifacts.filter((r: any) => r.category === 'EVENT' && r.body.type === 'RESULT_PUBLISHED'); assert.equal(published.length, 1);
      const attempts = after.artifacts.filter((r: any) => r.category === 'ATTEMPT'), costs = after.artifacts.filter((r: any) => r.category === 'COST'); assert.equal(attempts.length, boundary === 'AFTER_POINTER_BEFORE_ACK' ? 1 : 2); assert.equal(new Set(costs.map((r: any) => r.body.deliveryAttemptId)).size, costs.length);
      observations.push({ boundary, before, after, result });
    }
    return observations;
  });
  await challenge('J-Q-physical-controller-SIGKILL', ['Separate actual JobQueue controller','SIGKILL at intent/execution/check/blob/pointer boundaries','Independent process-group and SQL observations','Actual expired-claim recovery and fresh controller'], 'Stopped registered descendants, one published result, every physical intent charged or conservatively retained, no false settlement', async()=>{
    const observations=[];
    for(const boundary of ['BEFORE_INTENT','AFTER_INTENT','EXECUTION_PROCESS_STARTED','BEFORE_CHECK','CHECKER_PROCESS_STARTED','AFTER_BLOB_BEFORE_POINTER','AFTER_POINTER_BEFORE_ACK']) {
      const cut=await prepared(f), s=await submitted(f,cut), crash=await controllerProof(boundary, s.branchId);
      assert.equal(crash.signal,'SIGKILL');
      const before=await sqlState(f,s.branchId), teardown=await stoppedNativeGroups(before);
      const jobBefore=(await admin!.query('SELECT status,claim_fence,lease_expires_at FROM finnor_os.jobs WHERE id=$1',[before.head.job_id])).rows[0];
      await save(`physical-crashes/${boundary}-before-recovery.json`,{crash,before,teardown,jobBefore});
      // The observer has confirmed this agent-owned native tree stopped. Advance
      // only the disposable cluster's expiry clock fields, never a live lease.
      await admin!.query("UPDATE finnor_os.compute_resource_leases SET expires_at=acquired_at+interval '1 microsecond' WHERE owner_id LIKE $1",[ `p3:${s.branchId}:%` ]);
      await admin!.query("UPDATE finnor_os.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1 AND status='running'",[before.head.job_id]);
      const queue=branchQueue();assert.equal(await queue.recoverExpiredRunningJobs(),1);
      await admin!.query("UPDATE finnor_os.jobs SET run_at=clock_timestamp() WHERE id=$1 AND status='queued'",[before.head.job_id]);
      assert.equal(await tickBranch(s.branchId, queue),true);
      const after=await sqlState(f,s.branchId), result=successful(await api(f,'read',{branchId:s.branchId}));
      await save(`physical-crashes/${boundary}.json`,{crash,before,teardown,jobBefore,after,result,expiryAdvance:'DISPOSABLE_ONLY_AFTER_OS_GROUP_ABSENCE'});
      assert.equal(result.status,'COMPLETE');
      assert.equal(after.artifacts.filter((r:any)=>r.category==='EVENT'&&r.body.type==='RESULT_PUBLISHED').length,1);
      const attempts=after.artifacts.filter((r:any)=>r.category==='ATTEMPT'), costs=after.artifacts.filter((r:any)=>r.category==='COST');
      assert.equal(attempts.length,boundary==='BEFORE_INTENT'||boundary==='AFTER_POINTER_BEFORE_ACK'?1:2);
      for(const attempt of attempts)assert.equal(costs.filter((r:any)=>r.body.attemptId===attempt.id).length,1);
      assert(costs.every((r:any)=>r.body.moneyUSD===null&&r.body.reconciliation==='UNRECONCILED'&&r.body.settlement==='NOT_APPLICABLE'));
      observations.push({boundary,crash,before,teardown,jobBefore,after,result});
    }
    return observations;
  });
  await challenge('K-real-capacity-deferral', ['Hold actual native capacity permit', 'Real JobQueue tick', 'Read delivery attempt/queue counter', 'Release then run'], 'Physical deferral does not burn logical attempt', async () => {
    const cut = await prepared(f), s = await submitted(f, cut);
    const leases = await acquireComputeResourceLeases({ resourceKeys: ['native:p3-branch'], requiredResourceKeys: ['native:p3-branch'], tenantId: f.ctx.tenantId, workloadClass: 'HEAVY', ownerId: 'p3-test:capacity' });
    try { assert.equal(await tickBranch(s.branchId), true); } finally { await releaseComputeResourceLeases(leases, 'P3_TEST_FINISHED'); }
    const state = await sqlState(f, s.branchId), job = (await admin!.query('SELECT status,attempts FROM finnor_os.jobs WHERE id=$1', [state.head.job_id])).rows[0];
    assert.equal(job.status, 'queued'); assert.equal(job.attempts, 0);
    await admin!.query('UPDATE finnor_os.jobs SET run_at=now() WHERE id=$1', [state.head.job_id]); await tickBranch(s.branchId);
    const completed = successful(await api(f, 'read', { branchId: s.branchId }));
    await save('capacity/released-permit-retry.json', { branchId: s.branchId, job, state,
      after: await sqlState(f, s.branchId), completed });
    assert.equal(completed.status, 'COMPLETE');
    return { job, state, completed };
  });
  await challenge('L-cancel-check-publication', ['Request cancellation before check publication', 'Heartbeat/epoch and observed stopped', 'Reject late output'], 'CANCEL_REQUESTED not complete; terminal CANCELLED with no result pointer', async () => {
    const cut = await prepared(f), s = await submitted(f, cut);
    const q = branchQueue({ boundary: async name => { if (name === 'AFTER_EXECUTION') { const response = successful(await api(f, 'cancel', { branchId: s.branchId })); assert.equal(response.observedStopped, false); } } });
    await tickBranch(s.branchId, q);
    const state = await sqlState(f, s.branchId); assert.equal(state.head.status, 'CANCELLED'); assert.equal(state.head.result_id, null);
    return { state, read: successful(await api(f, 'read', { branchId: s.branchId })) };
  });
  await challenge('O-independent-checker-corruption', ['Candidate changes exact answer and settlement claim', 'Separate checker process', 'Consumer pointer readback'], 'Quarantine, never a default check pass or accepted result', async () => {
    const cut = await prepared(f), s = await submitted(f, cut);
    await tickBranch(s.branchId, branchQueue({ boundary: async (name, detail) => { if (name === 'AFTER_EXECUTION') { detail.candidate.result.registeredPayoff = 999; detail.candidate.result.settled = true; } } }));
    const state = await sqlState(f, s.branchId); assert.equal(state.head.status, 'QUARANTINED'); assert.equal(state.head.result_id, null);
    return state;
  });
  await challenge('B-authentic-underwriting-generic', ['Real PE deal/case/model/version/run owners under ordinary role', 'Pinned base run source acquisition', 'Existing native compiler/executor', 'Separate BigInt numerical/lineage reference'], 'USD20 output and every material ancestor checked; hidden decimal/units corruption rejected', async () => {
    const owner = await fixture('p3-underwriting'), mutation = { auth: owner.ctx, provenance: { sourceSystem: 'p3:public-e2e', createdBy: owner.ctx.userId } };
    const deal = await createDeal(mutation, { targetOrganizationId: owner.rootId, name: 'P3 owner-bound public underwriting', dealLeadEmployeeId: owner.ctx.userId, signedLoiAt: new Date(Date.now() - 86400000), targetClosingAt: new Date(Date.now() + 86400000) });
    const investmentCaseId = String((await createInvestmentCase(mutation, { dealId: String(deal.row.id), title: 'Public exact generic model' })).row.id);
    const metadata = { valueType: 'decimal' as const, unit: 'money' as const, currency: 'USD', shape: 'scalar' as const };
    const definition: any = { schemaVersion: 'underwriting-model-ir.v1', modelKey: 'p3-exact', modelVersion: '1', financialConventionVersion: 'finnor-pe-lbo/1.0.0', minimumEngineVersion: 'finnor-underwriting-engine/1.0.0', periodDefinition: { frequency: 'annual', forecastStart: '2026-01-01', count: 1 }, circularBlocks: [], nodes: [
      { id: 'amount', kind: 'input', ...metadata, dependencies: [], required: true },
      { id: 'ten', kind: 'constant', valueType: 'decimal', unit: 'ratio', shape: 'scalar', dependencies: [], value: '10', truthClass: 'MODEL_PARAMETER' },
      { id: 'fee', kind: 'expression', ...metadata, dependencies: ['amount','ten'], expression: { op: 'divide', args: [{ op: 'ref', nodeId: 'amount' }, { op: 'ref', nodeId: 'ten' }] } },
      { id: 'required.fee', kind: 'output', ...metadata, dependencies: ['fee'], sourceNodeId: 'fee' },
    ] };
    const logical = await createUnderwritingModel(mutation, { investmentCaseId, modelKey: 'p3-exact', name: 'P3 exact generic' }), modelVersion = await createUnderwritingModelVersion(mutation, { modelId: String(logical.id), definition });
    const worldAt = new Date(Date.now() - 10).toISOString();
    const base = await createUnderwritingRun(mutation, { investmentCaseId, modelVersionId: String(modelVersion.id), worldAt, idempotencyKey: randomUUID(), explicitInputs: { amount: { value: '200', truthClass: 'MODEL_PARAMETER', status: 'KNOWN', provenance: [{ kind: 'model_parameter', id: 'p3-public-dollar-amount' }] } } });
    const cut = await prepared(owner, { kind: 'underwriting', investmentCaseId, modelVersionId: String(modelVersion.id), baseRunId: base.id, worldAt });
    const branch = await run(owner, cut); assert.equal(branch.branch.status, 'COMPLETE');
    assert.equal(branch.branch.result.result.outputs['required.fee'].value, '20'); assert.equal(branch.branch.result.check.domain, 'ACYCLIC_GENERIC_UNDERWRITING_BIGINT34_TIES_EVEN');
    const wrong = await run(owner, cut, { boundary: async (name: string, detail: any) => { if (name === 'AFTER_EXECUTION') detail.candidate.result.values.amount.currency = 'EUR'; } });
    assert.equal(wrong.branch.status, 'QUARANTINED');
    return { deal, investmentCaseId, modelVersion, base, cut, branch, wrong };
  });
  await challenge('M-authentic-S3-retained-joint-kernel', ['Independent frozen generated history', 'Real S1 metric/evidence owners', 'Real S3 fit and kernel preparation', 'Retained shared shocks in fresh native/checker processes', 'Currentness after restatement'], 'Joint numerical replay within1e-8, model-relative only; wrong regime and revised source refused', async () => {
    const owner = await fixture('p3-s3'), ctx = { auth: owner.ctx }, python = process.env.FINNOR_S3_PYTHON ?? join(root, '.runtime/s3-python/bin/python');
    process.env.FINNOR_S3_PYTHON = python; process.env.FINNOR_S3_MODEL_STORE = join(output, 'ordinary-s3-model-store');
    const generated = spawnSync('/usr/bin/python3', [join(root, 'finnor-os/scripts/s3/reference.py')], { input: '{"operation":"generate"}', encoding: 'utf8', timeout: 5000 });
    assert.equal(generated.status, 0, generated.stderr); const rows = JSON.parse(generated.stdout);
    const periodMs = 86400000, startAt = new Date(Math.floor(Date.now() / periodMs) * periodMs - 129 * periodMs).toISOString(), source = await createEvidenceSource(owner.ctx.tenantId, { sourceKey: 'p3-s3-' + randomUUID(), sourceType: 'pe_document_claim', title: 'Public generated P3 numerical history, not field evidence' });
    const version = randomUUID(), series: Record<string, string> = {}; let lastObservation = '';
    await admin!.query("INSERT INTO finnor_os.evidence_source_versions(id,source_id,scope,tenant_id,version_number,content_hash,content,snapshot,as_of,retrieved_at,created_at) VALUES($1,$2,'tenant',$3,1,$4,'P3 generated numerical history',$5::jsonb,$6,clock_timestamp(),clock_timestamp())", [version,source.id,owner.ctx.tenantId,hash(rows),JSON.stringify({worldRoot:{entityType:'external_organization',entityId:owner.rootId},claims:[]}),startAt]);
    const rootRef = { entityType: 'external_organization' as const, entityId: owner.rootId };
    for (const id of ['revenue','inventory','actor','peer','price','disclosure']) {
      const exposure = ['price','disclosure'].includes(id), s = await createMetricSeries(ctx, { subjectType: 'external_organization', subjectId: owner.rootId, metricKey: 'p3-' + id, name: 'P3 generated ' + id, unit: exposure ? 'fraction' : 'normalized-value', frequency: 'daily' }); series[id] = String(s.row.id);
      await attachCanonicalEvidenceToWorld(ctx, { worldRoot: rootRef, entity: { entityType: 'pe_metric_series', entityId: series[id]! }, evidenceSourceId: source.id, evidenceVersionId: version, relationship: 'supports' });
      for (const row of rows) {
        const observation = randomUUID(), at = new Date(Date.parse(startAt) + row.period * periodMs).toISOString(); if (id === 'revenue' && row.period === 127) lastObservation = observation;
        await admin!.query("INSERT INTO finnor_os.pe_metric_observations(id,tenant_id,metric_series_id,period_start,period_end,value_type,value_numeric,evidence_source_id,evidence_version_id,source_system,created_by) VALUES($1,$2,$3,$4,$5,'number',$6,$7,$8,'p3:public-generated',$9)", [observation,owner.ctx.tenantId,series[id],at,new Date(Date.parse(at)+periodMs).toISOString(),String(row[exposure?'exposures':'states'][id]),source.id,version,owner.ctx.userId]);
      }
    }
    const ref = (id: string) => ({ owner: 'SUPPLIED', id, version: 'p3-public-h0', contentDigest: hash(id) }), f = (kind: string, id: string, lag: number) => ({ kind,id,lag }), constant = { kind:'CONSTANT' };
    const request: any = { schema:'finnor.s3.fit-request.v1', modelKey:'p3-retained-joint-public',episodeId:'p3-public-s3',roots:[rootRef],
      stateVariables:['revenue','inventory','actor','peer'].map(id=>({id,root:rootRef,seriesId:series[id],unit:'normalized-value',range:[-6,6],role:id==='actor'?'COUNTERPARTY':'ENTERPRISE_STATE'})),
      exposures:['price','disclosure'].map(id=>({id,root:rootRef,seriesId:series[id],unit:'fraction',operation:id==='price'?'PRICE_CHANGE':'DISCLOSURE',measurement:{status:'MEASURED_ACTUAL',methodRef:ref('generated-measurement'),qualification:'SUPPLIED_OWNER_MEASUREMENT_UNVERIFIED'}})),
      time:{startAt,endAt:new Date(Date.parse(startAt)+128*periodMs).toISOString(),periodMs,trainingThrough:new Date(Date.parse(startAt)+96*periodMs).toISOString()},
      validity:{validUntil:new Date(Date.now()+3600000).toISOString(),maxBeliefAgeMs:3600000,regimes:['operating-v1'],contexts:['public-price'],maximumHorizon:24},
      measurementPolicy:{selection:'COMPLETE_RECORDED_GRID_ASSUMED',missingness:'NONE',instrumentError:'ASSUMED_NEGLIGIBLE'},
      mechanisms:[{id:'public-joint-lagged',meaning:'Generated lagged joint dynamics with shared residual blocks',origin:'SUPPLIED_HYPOTHESIS',assumptions:['SEQUENTIAL_EXCHANGEABILITY','POSITIVITY','CONSISTENCY','MEASUREMENT','SELECTION','INTERFERENCE','STATIONARITY','FUNCTIONAL_FORM','ACTOR_INFORMATION'].map(category=>({id:category,category,status:'DECLARED',meaning:'Supplied public generated-law assumption, not field evidence',evidenceRefs:[ref(category)]})),equations:[
        {variableId:'revenue',features:[constant,f('STATE','revenue',1),f('EXPOSURE','price',0),f('EXPOSURE','price',2),f('STATE','actor',1),f('STATE','inventory',1),{kind:'PRODUCT',left:f('EXPOSURE','price',0),right:f('STATE','inventory',1)}]},
        {variableId:'inventory',features:[constant,f('STATE','inventory',1),f('EXPOSURE','price',1),f('STATE','revenue',1)]},
        {variableId:'actor',features:[constant,f('STATE','actor',1),f('EXPOSURE','price',1),f('EXPOSURE','disclosure',0),f('EXPOSURE','price',2)]},
        {variableId:'peer',features:[constant,f('STATE','peer',1),f('EXPOSURE','price',0),f('STATE','actor',1)]},
      ],counterparties:[{variableId:'actor',actorRef:ref('public-actor'),objectives:['Public supplied mechanism'],informationExposureIds:['price','disclosure'],constraints:['Generated observation range'],responseAssumption:'LEARNED_LAGGED_RESPONSE'}]}],
      numerical:{bootstrapDraws:64,blockLength:4,seed:20261003},
    };
    const fitted = await fitEnterpriseInterventionModel(ctx, request); await save('s3/fit.json', fitted); assert(fitted.model);
    const sourceRequest = { kind:'s3',modelRef:fitted.model.ref,context:'public-price',regime:'operating-v1',horizon:1,pathsPerMechanism:2,seed:20261003,exposures:{price:[0],disclosure:[0]} };
    const cut = await prepared(owner, sourceRequest, 'intervention_simulation'), one = await run(owner, cut), two = await run(owner, cut);
    assert.equal(one.branch.status,'COMPLETE'); assert.equal(two.branch.status,'COMPLETE'); assert.deepEqual(one.branch.result.result,two.branch.result.result); assert.equal(one.branch.result.evidenceClass,'MODEL_RELATIVE'); assert.equal(one.branch.result.accepted,false);
    const wrongRegime = await api(owner,'prepare',{workId:owner.workId,root:rootRef,kind:'intervention_simulation',profile:'TRUSTED_NATIVE_H0',source:{...sourceRequest,regime:'unseen-regime'}}); assert.equal(wrongRegime.status,424);
    await restateMetricObservation(ctx,{priorObservationId:lastObservation,expectedVersion:1,replacement:{value:{type:'number',value:'1.5'},evidence:{evidenceSourceId:source.id,evidenceVersionId:version}}});
    const invalidated = await api(owner,'read',{branchId:one.s.branchId}); assert(invalidated.status>=400);
    await save('s3/input.json',{request,rows,sourceRequest,pythonIdentity:spawnSync(python,['-I','-c','import sys,importlib.metadata as m,json;print(json.dumps({"python":sys.version,**{p:m.version(p) for p in ["numpy","scipy","statsmodels","arch","pandas"]}}))'],{encoding:'utf8'}).stdout.trim()});
    return {modelRef:fitted.model.ref,cut,one,two,wrongRegime,invalidated,truthClass:'SUPPORTED_GENERATED_MODEL_RELATIVE_NO_FIELD_OR_CALIBRATION_CLAIM'};
  });
  await challenge('R-matched-comparison-continuation', ['Matched pure branches', 'Mismatched app branch', 'No fixture transcript live execution'], 'Typed exact comparison retains class/no winner; fresh owner authority required', async () => {
    const second = await run(f, await prepared(f, pureSource(30, 0)));
    const comparison = successful(await api(f, 'compare', { branchIds: [first.s.branchId, second.s.branchId] })); assert.equal(comparison.winner, null); assert.equal(comparison.evidenceClass, 'COMPUTATION');
    const mismatch = await api(f, 'compare', { branchIds: [first.s.branchId, appRun.s.branchId] }); assert.equal(mismatch.status, 409);
    const continuation = successful(await api(f, 'continue', { branchId: appRun.s.branchId })); assert.equal(continuation.executionAuthorityGranted, false); assert.equal(continuation.reusableRequestTranscript, false);
    return { comparison, mismatch, continuation };
  });
  await ownerChallenges({ root, output, admin, other, token, apiOrigin, save, challenge, api, prepared, run, sqlState });
  await challenge('Q-aggregate-budget-checkpoint-accounting', [
    'Signed HTTP and ordinary-role private application/checkpoint/restore',
    'Durable checkpoint control intents and byte-metered once-only costs',
    'Concurrent identical accounting identity and cumulative Work admission',
    'Accounting-only inspection after Work invalidation, no old numerical output',
  ], 'Checkpoint usage retained, one cost per identity; explicit exhausted reservation refuses before acquisition or launch', async () => {
    const owner = await fixture('p3-accounting');
    const cut = await prepared(owner, { kind: 'financing_fixture', steps: [{ operation: 'autosave', target: 'C_01', feeCents: 2000, effectId: randomUUID() }] }, 'application_fixture');
    const one = await run(owner, cut);
    const cp = successful(await api(owner, 'checkpoint', { branchId: one.s.branchId }));
    const resumed = successful(await api(owner, 'resume', { branchId: one.s.branchId, checkpointId: cp.checkpointId, idempotencyKey: randomUUID() }));
    await tickBranch(resumed.branchId);
    const restored = successful(await api(owner, 'read', { branchId: resumed.branchId }));
    assert.equal(restored.status, 'COMPLETE');
    const accountingId = 'negative-fixture:' + randomUUID();
    const costIds = await Promise.all([0, 1].map(() => tx(owner.ctx, c => costOnce(c, owner.ctx, owner.workId, accountingId, {
      phase: 'EXPLICIT_NEGATIVE_ACCOUNTING_FIXTURE', reservedLiabilityMs: 3600000,
      elapsedMs: null, meterStatus: 'SYNTHETIC_RESERVATION_NOT_OBSERVED_USAGE',
    }))));
    assert.equal(costIds[0], costIds[1]);
    const before = await tx(owner.ctx, c => workUsage(c, owner.ctx, owner.workId));
    assert(before.chargedWallMs >= 3600000);
    const refused = await api(owner, 'prepare', { workId: owner.workId, root: { entityType: 'external_organization', entityId: owner.rootId }, kind: 'pure', profile: 'TRUSTED_NATIVE_H0', source: pureSource() });
    assert.equal(refused.status, 409); assert.equal(refused.body.code, 'WORK_COMPUTE_BUDGET_EXHAUSTED');
    const ledger = await tx(owner.ctx, async c => (await c.query("SELECT id,body,content_digest FROM finnor_os.p3_artifacts WHERE work_id=$1 AND category='COST' ORDER BY recorded_at,id", [owner.workId])).rows);
    assert.equal(ledger.filter((r: any) => r.body.accountingId === accountingId).length, 1);
    assert(ledger.some((r: any) => r.body.phase === 'CHECKPOINT_WRITE' && r.body.outputBytes > 0));
    assert(ledger.some((r: any) => r.body.phase === 'CHECKPOINT_READ_VERIFY' && r.body.inputBytes > 0));
    assert(ledger.every((r: any) => r.body.moneyUSD === null && r.body.reconciliation === 'UNRECONCILED'));
    await admin!.query("INSERT INTO finnor_os.work_inputs(id,tenant_id,work_id,instruction_id,channel,instruction_text,created_by) VALUES($1,$2,$3,$4,'text','Accounting remains inspectable after current question changes',$5)", [randomUUID(), owner.ctx.tenantId, owner.workId, randomUUID(), owner.ctx.userId]);
    const oldRead = await api(owner, 'read', { branchId: one.s.branchId }); assert.equal(oldRead.status, 409);
    const inspection = successful(await api(owner, 'inspect', { branchId: one.s.branchId }));
    assert.equal(inspection.currentness, 'INVALIDATED_ACCOUNTING_ONLY');
    assert(inspection.artifacts.every((r: any) => r.category === 'COST' || r.category === 'CLEANUP'));
    assert.equal((await api(other, 'inspect', { branchId: one.s.branchId })).status, 404);
    return { cut, one, cp, resumed, restored, costIds, before, refused, ledger, oldRead, inspection };
  });
  await challenge('P-Work-currentness-clears-old-results', ['Complete current branch', 'Actual new Work input', 'Reload/read/restore'], 'Old numeric result refused regardless of same answer', async () => {
    const instruction = randomUUID();
    await admin!.query("INSERT INTO finnor_os.work_inputs(id,tenant_id,work_id,instruction_id,channel,instruction_text,created_by) VALUES($1,$2,$3,$4,'text','Material Work change',$5)", [randomUUID(), f.ctx.tenantId, f.workId, instruction, f.ctx.userId]);
    const rejected = await api(f, 'read', { branchId: first.s.branchId }); assert.equal(rejected.status, 409);
    const restored = await api(f, 'resume', { branchId: appRun.s.branchId, checkpointId: cp.checkpointId, idempotencyKey: randomUUID() }); assert.equal(restored.status, 409);
    const list = successful(await api(f, 'list', { workId: f.workId })); assert(list.branches.every((b: any) => b.result === null)); return { rejected, restored, list };
  });
  await challenge('T-P1-P4-M1-pending-real-ports', ['Request nonexistent exact producer records', 'No synthetic successful responder'], 'Current P4/M1 readers refuse missing records; absent P1 remains pending', async () => {
    const statuses = [], metering = [];
    const state = async () => (await admin!.query(
      `SELECT (SELECT count(*) FROM finnor_os.p3_artifacts WHERE tenant_id=$1 AND category='INPUT')::int inputs,
        (SELECT count(*) FROM finnor_os.p3_requests WHERE tenant_id=$1)::int requests,
        (SELECT count(*) FROM finnor_os.jobs WHERE tenant_id=$1)::int jobs`, [f.ctx.tenantId])).rows[0];
    for (const source of [{ kind: 'p4', derivationId: randomUUID(), output: 'fee' }, { kind: 'm1', sliceRef: { owner: 'M1', id: 'slice:' + '1'.repeat(64), version: 'm1-exact-dependency-v1', contentDigest: '1'.repeat(64) } }, { kind: 'p1', programRef: { owner: 'P1', id: 'decoding-only', version: 'v1', contentDigest: '1'.repeat(64) } }]) {
      const before = await state();
      const result = await api(f, 'prepare', { workId: f.workId, root: { entityType: 'external_organization', entityId: f.rootId }, kind: 'pure', profile: 'TRUSTED_NATIVE_H0', source });
      assert.equal(result.status, source.kind === 'p1' ? 424 : 404);
      assert.equal(result.body.code, source.kind === 'p1' ? 'PENDING_DEPENDENCY' : 'BRANCH_UNAVAILABLE');
      assert.deepEqual(await state(), before, 'Missing producer must not publish P3 inputs, requests or jobs');
      if (source.kind === 'm1') {
        const policies = (await admin!.query(
          "SELECT resource_key,capacity,enabled FROM finnor_os.compute_resource_policies WHERE resource_key='provider:m1-native'")).rows;
        const leases = (await admin!.query(
          "SELECT resource_key,owner_id,released_at,release_reason FROM finnor_os.compute_resource_leases WHERE tenant_key=$1 AND resource_key='provider:m1-native'",
          [f.ctx.tenantId])).rows;
        if (process.env.P3_GOVERNORS === '1') {
          assert.equal(policies.length, 1); assert.equal(policies[0].enabled, true);
          assert(leases.length > 0 && leases.every(row => row.released_at !== null));
        }
        const attempts = join(process.env.FINNOR_M1_STORE!, f.ctx.tenantId, actor(f.ctx), 'attempts');
        const costs = [];
        for (const name of await readdir(attempts)) {
          const record = JSON.parse(await readFile(join(attempts, name), 'utf8'));
          if (record.body?.schema === 'finnor.m1.native-invocation-finish.v1')
            costs.push({ ref: record.ref, status: record.body.status, failure: record.body.failure, usage: record.body.usage });
        }
        assert(costs.some(row => row.status === 'FAILED' && row.failure === 'UNAVAILABLE' && row.usage.elapsedMs >= 0));
        metering.push({ policies, leases, costs, guard: 'ACTUAL_MISSING_OWNER_RECORD_AFTER_CONFIGURED_CAPACITY' });
      }
      statuses.push(result);
    }
    return { statuses, metering, actualJoins: 'PENDING_DEPENDENCY_NOT_PASSED' };
  });
  await deadlineSecurity({ owner: await fixture('p3-deadline'), other, appRun, admin, custodyDirectory, api, challenge, tickBranch, save,
    expiredBodyDiagnostics: selectedCases?.includes('CB-P3-expired-before-body-acquisition') === true });
  await resourceSecurity({ owner: await fixture('p3-resources'), admin, prepared, submitted, sqlState, api, controllerProof, stoppedNativeGroups, challenge, tickBranch, save,
    cleanupDiagnostics: selectedCases?.includes('CB-P3-cleanup-refusal-durable-replay') });
  if (selectedCases?.includes('CB-P3-generation-heartbeat-interleaving'))
    await generationSecurity({ owner: await fixture('p3-generation'), admin, prepared, submitted, sqlState, api, challenge, tickBranch, save });
  await episodeSecurity({ owner: await fixture('p3-episode'), admin, prepared, submitted, sqlState, api, run, challenge, tickBranch, save });
  }
  const changedSources = [];
  for (const pin of sources) if (digestBytes(await readFile(join(root, pin.path))) !== pin.sha256) changedSources.push(pin.path);
  assert.deepEqual(changedSources, []);
  await save('source-after.json', { changes: changedSources, manifestDigest: hash(sources) });
  for (const [id, reason] of [['E-Linux-host-resource-escape', 'NO_AUTHORIZED_LINUX_RUNNER'], ['F-G-Linux-egress-tripwire', 'NATIVE_PROFILE_NOT_OS_CONFINED'], ['N-production-provider-live-read', 'HISTORICAL_SIGNED_OWNER_READ_IS_NOT_ADMITTED_NEW_PROVIDER_READ'], ...(!browserMode?[['S-mounted-browser', 'SEPARATE_BROWSER_RUN_REQUIRED']]:[]), ...(!joinMode?[['T-authentic-joins', 'SEPARATE_EXACT_COMMITTED_JOIN_RUN_REQUIRED']]:[]), ['P3-original-comparative', 'LINUX_SEALED_COMPARISON_AND_COST_PREDICATES_UNPASSED']]) cases.push({ id, status: 'BLOCKED_EXTERNAL_UNPASSED', reason, countedAsPass: false });
  await report();
} catch (e) {
  cases.push({ id: 'HARNESS_SETUP_OR_INTEGRITY', status: 'FAIL', observed: e instanceof Error ? { message: e.message, stack: e.stack } : String(e) });
  console.error(e instanceof Error ? e.stack : String(e)); await report();
} finally {
  if(frontend?.pid) try { process.kill(-frontend.pid,'SIGTERM'); } catch {}
  await closePool();
  await admin?.end();
  if (apiServer) await new Promise<void>(ok => apiServer!.close(() => ok()));
  if (authServer) await new Promise<void>(ok => authServer!.close(() => ok()));
  await postgres?.stop().catch(() => undefined);
  await rm(custodyDirectory, { recursive: true, force: true });
  await save('resource-root-after.json', { root: resourceRoot, retained: await readdir(resourceRoot),
    qualification: 'Only agent-owned roots; nonempty resources remain private reconciliation evidence, not silently deleted' });
  if (!(await readdir(resourceRoot)).length) await rm(resourceRoot, { recursive: true });
  await save('evidence-manifest.json', { schema: 'finnor.p3.evidence-manifest.v1', files: await evidenceFiles(output) });
  console.log(JSON.stringify({ output, passed: cases.filter(c => c.status === 'PASS_LOCAL').length, failed: cases.filter(c => c.status === 'FAIL').length, unpassed: cases.filter(c => c.status === 'BLOCKED_EXTERNAL_UNPASSED').length }));
  process.exit(cases.some(c => c.status === 'FAIL') ? 1 : 0);
}
async function evidenceFiles(directory: string): Promise<any[]> {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await evidenceFiles(path));
    else if (entry.name !== 'evidence-manifest.json') { const bytes = await readFile(path); result.push({ path: path.slice(output.length + 1), sha256: digestBytes(bytes), bytes: bytes.length }); }
  }
  return result;
}
