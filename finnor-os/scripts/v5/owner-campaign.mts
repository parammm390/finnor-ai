import { strict as assert } from 'node:assert';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type pg from 'pg';
import { ownedHttp } from './owned-http.mts';

type Context = { repo: string; out: string; directory: string; port: number; admin: pg.Client; adminUrl: string;
  selected: string; story: (id: string, run: () => Promise<unknown>) => Promise<void> };
export async function runOwners(c: Context) {
  const { repo, out, admin, port, story } = c;
  const artifact = async (name: string, value: unknown) => {
    const path = join(out, name); await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 }); return path;
  };
  const store = join(c.directory, 'owner-artifacts');
  Object.assign(process.env, { FINNOR_S3_MODEL_STORE: join(store, 's3'), FINNOR_S4_POLICY_STORE: join(store, 's4'),
    FINNOR_ENVIRONMENT: 'staging', P3_DISABLE_PROACTIVE_SCHEDULER: '1', FINNOR_WORKLOAD_CLASS: 'INTERACTIVE', PG_POOL_MAX: '1',
    FINNOR_TEST_MANAGED_EXTENSIONS: 'omit', LOG_LEVEL: 'silent', AUTH_DEV_BYPASS: '0', FINNOR_ALLOW_STAGING_COMPUTE_CAPACITY: '1' });
  const python = process.env.FINNOR_S5_PYTHON ?? process.env.FINNOR_S3_PYTHON ?? 'python3';
  process.env.FINNOR_S3_PYTHON = python; process.env.FINNOR_S5_PYTHON = python; process.env.FINNOR_S4_PYTHON = python;
  const { closePool } = await import('../../packages/db');
  await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'v5-app-disposable'");
  await admin.query("CREATE ROLE v5_worker LOGIN PASSWORD 'v5-worker-disposable' INHERIT");
  await admin.query('GRANT finnor_app,finnor_worker TO v5_worker');
  await admin.query('ALTER ROLE v5_worker SET search_path=finnor_os,public');
  await admin.query("ALTER ROLE v5_worker SET statement_timeout='10s'");
  const { COMPUTE_CUTOVER_EPOCH } = await import('../../packages/db/compute-contract');
  const base = JSON.parse(await readFile(join(repo, 'scope-v/v5-living-investment-firm/baseline.json'), 'utf8'));
  await admin.query(`UPDATE finnor_os.compute_plane_cutover SET state='authoritative',accepted_job_epoch=$1,
    minimum_claim_epoch=$1,enforce_known_job_types=true,legacy_tenant_writes_allowed=false,
    activated_release_sha=$2,activated_at=clock_timestamp() WHERE singleton=true`,
    [COMPUTE_CUTOVER_EPOCH, base.B_live.commit]);
  await admin.query(`INSERT INTO finnor_os.compute_resource_policies
    (resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,enabled,source)
    VALUES('native:p2',1,1,0,120,true,
      'V5 disposable serial native consequence capacity; unmetered engineering setup, not S5 funding')`);
  await artifact('disposable-compute-runtime.json', { computeCutoverEpoch: COMPUTE_CUTOVER_EPOCH,
    codeBase: base.B_live, sourceOverlay: 'freeze.json',
    resourcePolicies: (await admin.query(`SELECT resource_key,capacity,per_tenant_capacity,interactive_reserve,
      lease_seconds,enabled,source FROM finnor_os.compute_resource_policies WHERE resource_key='native:p2'`)).rows,
    profile: 'LOCAL_QUEUE_CLASS_CONFIGURATION_NOT_DEPLOYMENT_OR_S8_ACTIVATION' });
  process.env.DATABASE_URL = `postgres://finnor_app:v5-app-disposable@127.0.0.1:${port}/v5_development`;
  await closePool();
  const http = await ownedHttp(repo, admin);
  const actors = { partner: '', finance: randomUUID(), analyst: randomUUID(), compliance: randomUUID(), service: randomUUID(), temporal: randomUUID(),
    ...(c.selected === 'rights' ? { agent: randomUUID() } : {}),
    ...(c.selected === 'privacy' ? { scoped: randomUUID() } : {}) };
  const assignments = new Map<string, string>();
  const delegationId = randomUUID(), temporalExpiry = new Date(Date.now() + 120000);
  const canonicalFixture = new Map<string, { dealA: any; dealB: any; openA: any; openB: any; dates: { signedLoiAt: Date; targetClosingAt: Date } }>();
  const scopedTargets = new Map<string, any>();
  const tenants = new Set<string>(), children: ChildProcess[] = [];
  let worker: ChildProcess | undefined;
  async function startWorker(name: string) {
    const log = await open(join(out, name), 'w', 0o600);
    const child = spawn(process.execPath, ['--import=tsx', 'apps/worker/src/index.ts'], { cwd: join(repo, 'finnor-os'),
      env: { ...process.env, LOG_LEVEL: 'info',
        ...(c.selected === 'recovery' ? { WORKER_JOB_LEASE_SECONDS: '30' } : {}),
        DATABASE_URL: `postgres://v5_worker:v5-worker-disposable@127.0.0.1:${port}/v5_development` },
      stdio: ['ignore', log.fd, log.fd] });
    children.push(child); await log.close(); return child;
  }
  const ref = (id: string, owner = 'SUPPLIED') => ({ id, owner, version: 'v5-local-source-v1', contentDigest: createHash('sha256').update(id).digest('hex') });
  async function seedActors(f: any) {
    if (tenants.has(f.tenant)) return;
    tenants.add(f.tenant); actors.partner = f.principal;
    for (const [name, id] of Object.entries(actors).filter(([name]) => name !== 'partner')) {
      await admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')",
        [id, f.tenant, name + '@v5.local.test']);
    }
    for (const [name, id] of Object.entries(actors)) {
      const role = randomUUID(), assignment = randomUUID();
      assignments.set(name, assignment);
      // Remove the fixture's default presentation-role assignment before
      // assigning independent functional grants. No production identity changes.
      await admin.query('DELETE FROM finnor_os.employee_role_assignments WHERE tenant_id=$1 AND employee_id=$2', [f.tenant, id]);
      await admin.query("INSERT INTO finnor_os.employee_roles(id,tenant_id,key,name,active) VALUES($1,$2,$3,$3,true)", [role, f.tenant, 'v5-' + name]);
      await admin.query(`INSERT INTO finnor_os.employee_role_assignments(id,tenant_id,employee_id,role_id,resource_scope,active)
        VALUES($1,$2,$3,$4,'{"kind":"tenant"}',true)`, [assignment, f.tenant, id, role]);
      if (c.selected === 'rights' && name === 'temporal') await admin.query(
        'UPDATE finnor_os.employee_role_assignments SET expires_at=$2 WHERE id=$1', [assignment, temporalExpiry]);
      await admin.query(`INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect,max_risk,approval_required)
        VALUES($1,$2,'query:*','*','allow','high',false)`, [f.tenant, role]);
      if (!['compliance', 'service', 'scoped'].includes(name)) {
        const capability = ['analyst', 'agent', 'temporal'].includes(name) ? 'action:propose_control' : 'action:*';
        const chain = ['rights', 'native', 'native-sibling'].includes(c.selected) && name === 'partner' ? randomUUID() : null;
        if (chain) {
          await admin.query(`INSERT INTO finnor_os.approval_chains(id,tenant_id,key,name)
            VALUES($1,$2,'v5-human-capital-review','Independently configured human capital review')`, [chain, f.tenant]);
          await admin.query(`INSERT INTO finnor_os.approval_chain_steps(tenant_id,approval_chain_id,sequence,approver_capability,min_approvals)
            VALUES($1,$2,1,'approve:$action',1)`, [f.tenant, chain]);
        }
        await admin.query(`INSERT INTO finnor_os.role_authority_grants
          (tenant_id,role_id,capability,resource_type,effect,max_amount_usd,max_risk,approval_required,approval_chain_id)
          VALUES($1,$2,$3,'*','allow',$4,'high',false,$5)`,
        [f.tenant, role, capability, c.selected === 'rights' && chain ? '0' : name === 'finance' ? '25000000' : '50000000', chain]);
      }
      if (name === 'compliance') await admin.query(`INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect,max_amount_usd,max_risk,approval_required)
        VALUES($1,$2,'approve:*','*','allow','25000000','high',false)`, [f.tenant, role]);
      if (name !== 'agent') await admin.query('INSERT INTO finnor_os.employee_actor_profiles(tenant_id,principal_id,actor_kind) VALUES($1,$2,$3)',
        [f.tenant, id, name === 'service' ? 'SERVICE' : 'HUMAN']);
    }
    if (actors.agent) {
      const domainAction = randomUUID();
      await admin.query(`INSERT INTO finnor_os.domain_actions(id,tenant_id,action_type,payload,status,initiated_by)
        VALUES($1,$2,'delegate_work',$3::jsonb,'draft',$4)`,
      [domainAction, f.tenant, JSON.stringify({ targetRef: { partyType: 'employee', partyId: actors.agent },
        objective: 'Bounded independently administered development proposal delegation' }), actors.partner]);
      await admin.query(`INSERT INTO finnor_os.delegations
        (id,tenant_id,domain_action_id,created_by,target_type,target_id,objective,status,accepted_at,completion_deadline)
        VALUES($1,$2,$3,$4,'employee',$5,'Development proposal delegation','accepted',clock_timestamp(),$6)`,
      [delegationId, f.tenant, domainAction, actors.partner, actors.agent, temporalExpiry]);
      await admin.query(`INSERT INTO finnor_os.employee_actor_profiles
        (tenant_id,principal_id,actor_kind,delegated_by,authority_assignment_id,delegation_id)
        VALUES($1,$2,'AGENT',$3,$4,$5)`, [f.tenant, actors.agent, actors.partner, assignments.get('agent'), delegationId]);
    }
  }
  const { POST: s3Post } = await import('../../apps/api/app/api/interventions/[operation]/route');
  const { POST: s4Post } = await import('../../apps/api/app/api/policies/[operation]/route');
  const api = async (f: any, op: string, body: unknown, handler?: unknown) => {
    await seedActors(f);
    if (!canonicalFixture.has(f.tenant)) {
      // Complete the canonical graph before native model/rights pins are frozen.
      // A later Deal or Work insertion legitimately invalidates those pins.
      const pe = await import('../../packages/private-equity/src');
      const dates = { signedLoiAt: new Date(), targetClosingAt: new Date(Date.now() + 86400000) };
      const dealA = await pe.createDeal(f.ctx, { name: 'Deal A, controlled local experiment', targetOrganizationId: f.root.entityId, dealLeadEmployeeId: actors.partner, ...dates });
      const dealB = await pe.createDeal(f.ctx, { name: 'Deal B, controlled local experiment', targetOrganizationId: f.root.entityId, dealLeadEmployeeId: actors.finance, ...dates });
      const openA = ok(await control(actors.partner, 'begin', { root: f.root, focus: { type: 'pe_deal', id: String(dealA.row.id) }, idempotencyKey: randomUUID() }));
      const openB = ok(await control(actors.finance, 'begin', { root: f.root, focus: { type: 'pe_deal', id: String(dealB.row.id) }, idempotencyKey: randomUUID() }));
      if (c.selected === 'native-sibling') {
        const target = await pe.createWorkstream(f.ctx, { dealId: String(dealA.row.id), kind: 'financial_diligence',
          name: 'Pinned sibling native prerequisite', owner: { partyType: 'employee', partyId: actors.partner } },
        { workId: openA.workId });
        scopedTargets.set(f.tenant, target.row);
      }
      if (actors.scoped) {
        const target = await pe.createWorkstream(f.ctx, { dealId: String(dealA.row.id), kind: 'financial_diligence',
          name: 'Scoped canonical metadata subject', owner: { partyType: 'employee', partyId: actors.partner } });
        scopedTargets.set(f.tenant, target.row);
        await admin.query('UPDATE finnor_os.employee_role_assignments SET resource_scope=$2::jsonb WHERE id=$1',
          [assignments.get('scoped'), JSON.stringify({ kind: 'resources', resourceIds: [f.root.entityId, openA.workId, target.row.id] })]);
      }
      if (actors.agent) await admin.query('UPDATE finnor_os.delegations SET work_id=$2 WHERE id=$1', [delegationId, openA.workId]);
      canonicalFixture.set(f.tenant, { dealA, dealB, openA, openB, dates });
      await story('A-exact-direct-intake-idempotency-and-collision', async () => {
        const original = (await admin.query(`SELECT id,work_id,instruction_id,idempotency_key,created_by,context_snapshot
          FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2`, [f.tenant, openA.workId])).rows[0];
        assert(original && original.created_by === actors.partner);
        const focus = { type: 'pe_deal', id: String(dealA.row.id) };
        const exact = { root: f.root, focus, idempotencyKey: original.idempotency_key };
        const originalLinks = (await admin.query(`SELECT id,work_id,entity_type,entity_id,relationship,source
          FROM finnor_os.work_entity_links WHERE tenant_id=$1 AND work_id=$2 AND entity_type='pe_deal' AND entity_id=$3`,
        [f.tenant, original.work_id, focus.id])).rows;
        assert.equal(originalLinks.length, 1);
        const repeated = ok(await control(actors.partner, 'begin', exact));
        assert.equal(repeated.workId, original.work_id); assert.equal(repeated.sessionId, openA.sessionId);
        assert.deepEqual((await admin.query(`SELECT id,work_id,entity_type,entity_id,relationship,source
          FROM finnor_os.work_entity_links WHERE tenant_id=$1 AND work_id=$2 AND entity_type='pe_deal' AND entity_id=$3`,
        [f.tenant, original.work_id, focus.id])).rows, originalLinks);
        const collisions = [
          await control(actors.finance, 'begin', exact),
          await control(actors.partner, 'begin', { ...exact, focus: { type: 'pe_deal', id: String(dealB.row.id) } }),
          await control(actors.partner, 'begin', { ...exact, root: { entityType: 'pe_deal', entityId: String(dealA.row.id) } }),
        ];
        assert(collisions.every(r => r.status === 409 && r.body.code === 'EXACT_WORK_INTAKE_CONFLICT'), JSON.stringify(collisions));
        const retained = (await admin.query(`SELECT id,work_id,instruction_id,idempotency_key,created_by,context_snapshot
          FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2`, [f.tenant, openA.workId])).rows;
        assert.deepEqual(retained, [original]);
        const legacyKey = randomUUID(), legacyWork = randomUUID();
        await admin.query(`INSERT INTO finnor_os.works
          (id,tenant_id,status,initial_channel,initial_instruction,created_by,current_owner_id,idempotency_key)
          VALUES($1,$2,'received','console','Pre-existing legacy Work with no input claim',$3,$3,$4)`,
        [legacyWork, f.tenant, actors.finance, legacyKey]);
        const legacy = await control(actors.partner, 'begin', { ...exact, idempotencyKey: legacyKey });
        assert.equal(legacy.status, 409); assert.equal(legacy.body.code, 'EXACT_WORK_INTAKE_CONFLICT');
        const legacyInputs = (await admin.query('SELECT count(*)::int n FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2',
          [f.tenant, legacyWork])).rows[0].n;
        assert.equal(legacyInputs, 0);
        const concurrentKey = randomUUID();
        const contenders = await Promise.all([actors.partner, actors.finance].map(principal =>
          control(principal, 'begin', { ...exact, idempotencyKey: concurrentKey })));
        assert.deepEqual(contenders.map(r => r.status).sort(), [200, 409]);
        const claimed = (await admin.query('SELECT id,work_id,created_by FROM finnor_os.work_inputs WHERE tenant_id=$1 AND idempotency_key=$2',
          [f.tenant, concurrentKey])).rows;
        assert.equal(claimed.length, 1);
        assert.equal(claimed[0].created_by, [actors.partner, actors.finance][contenders.findIndex(r => r.status === 200)]);
        return { original, originalNativeLinks: originalLinks, repeatedWorkId: repeated.workId, collisions, legacy: { status: legacy.status, inputCount: legacyInputs },
          concurrent: { statuses: contenders.map(r => r.status), canonicalClaim: claimed[0] },
          qualification: 'ACTUAL_AUTHENTICATED_INTAKE_NOT_FINANCIAL_EFFECT_OR_PROTECTED_AUTHORITY' };
      });
      if (process.exitCode) throw Error('NATIVE_FIXTURE_NOT_PINNED_AFTER_INTAKE_FAILURE');
    }
    return http.call(f.principal, (handler === s3Post ? 'interventions/' : handler === s4Post ? 'policies/' : 'allocations/') + op, body);
  };
  const ok = (response: any) => { assert.equal(response.status, 200, JSON.stringify(response)); return response.body; };
  const control = async (principal: string, operation: string, input: unknown) => http.call(principal, 'live-controls', { operation, input });
  const sleep = (ms: number) => new Promise<void>(yes => setTimeout(yes, ms));
  async function waitFor<T>(read: () => Promise<T | undefined>, label: string, ms = 60000): Promise<T> {
    const deadline = performance.now() + ms;
    while (performance.now() < deadline) { const value = await read(); if (value !== undefined) return value; await sleep(100); }
    throw Error('REGISTERED_OBSERVATION_TIMEOUT:' + label);
  }
  try {
    const generated = spawnSync(python, [join(repo, 'finnor-os/scripts/s3/reference.py')], {
      input: JSON.stringify({ operation: 'equivalent' }), encoding: 'utf8', timeout: 45000 });
    assert.equal(generated.status, 0, generated.stderr);
    const rows = JSON.parse(generated.stdout).rows, day = 86400000;
    const { createUpstreamFixtureSupport } = await import('../s5/owner-fixture.mts');
    const fixtures: Record<string, any> = {};
    const support = createUpstreamFixtureSupport({ admin: () => admin, generatedRows: rows,
      begin: new Date(Math.floor(Date.now() / day) * day - 128 * day).toISOString(), day, fixtures, api, artifact });
    const f = await support.fixture('v5-shared-fund', 2, [{ id: 'cash', unit: 'USD', capacity: 20000000, totalLimit: 20000000 },
      { id: 'native', unit: 'native-attempt', resourceClass: 'COMPUTE', capacity: 512, totalLimit: 512 }]);
    const financeA = await support.policy(f, 'deal-A', { cash: 20000000 });
    const computeA = await support.policy(f, 'compute-A', { native: 128 });
    await support.resource(f, 'cash', 'USD', 'STOCK', ['20000000', '20000000', '20000000']);
    await support.resource(f, 'native', 'native-attempt', 'CUMULATIVE_EXPENDITURE', ['512', '512', '512'], undefined, [], { resourceClass: 'COMPUTE' });
    const scientific = JSON.parse(await readFile(join(out, f.name, 'scientific-input.json'), 'utf8'));
    const fitB = ok(await http.call(actors.finance, 'interventions/fit', { request: { ...scientific.request, modelKey: 'v5-finance-B', episodeId: 'v5-finance-B' } }));
    const { allocationRef } = await import('../../packages/epistemic-runtime/src');
    const { ref: oldRef, ...mandateA } = f.mandate;
    const mandateB = { ...mandateA, principalId: actors.finance, episodeId: 'v5-finance-B', businessOwnerRef: ref(actors.finance, 'BUSINESS_OWNER') };
    const b = { ...f, name: 'v5-finance-B', principal: actors.finance, ctx: { auth: { ...f.ctx.auth, userId: actors.finance, employeeId: actors.finance } },
      model: fitB.model, policies: [], labels: {}, mandate: { ...mandateB, ref: allocationRef('BUSINESS_OWNER', 'mandate', mandateB, 'economic-mandate-v1') } };
    const financeB = await support.policy(b, 'deal-B', { cash: 20000000 }), computeB = await support.policy(b, 'compute-B', { native: 128 });
    const budgetA = ok(await api(f, 'clear', support.clearing(f, { 'compute-A': ['1'] }, [], [], [computeA])));
    const budgetB = ok(await api(b, 'clear', support.clearing(b, { 'compute-B': ['1'] }, [], [], [computeB])));
    assert(budgetA.certificate && budgetB.certificate, 'ACTUAL_ORIGINAL_NATIVE_COMPUTE_GRANTS_REQUIRED');
    const grantA = { allocationRef: budgetA.certificate.ref, policyRef: computeA.ref, programmeRef: null };
    const grantB = { allocationRef: budgetB.certificate.ref, policyRef: computeB.ref, programmeRef: null };
    await artifact('original-grants.json', { grantA, grantB, qualification: 'ACTUAL_NATIVE_OWNER_PRODUCERS_UNADMITTED_HYPOTHETICAL_INPUTS' });
    const seed = canonicalFixture.get(f.tenant)!;
    const { dealA, dealB, dates: syntheticDates } = seed;
    const root = f.root;
    const openA = ok(await control(actors.partner, 'snapshot', { sessionId: seed.openA.sessionId }));
    const openB = ok(await control(actors.finance, 'snapshot', { sessionId: seed.openB.sessionId }));
    const quantity = (who: any) => ({ semantics: { entityType: 'external_organization', entityId: root.entityId,
      unit: 'currency', currencyCode: 'USD', periodStart: who.mandate.horizon.startAt,
      periodEnd: new Date(Date.parse(who.mandate.horizon.startAt) + who.mandate.horizon.periodMs * who.mandate.horizon.periods).toISOString(),
      frequency: 'daily', calendar: 'OWNER_RECORDED', consolidation: 'STANDALONE', instrument: 'CAPITAL_ALLOCATION',
      scale: '1', sign: 'AS_RECORDED' }, legalEntityRef: { type: root.entityType, id: root.entityId },
      ownerShare: { numerator: '1', denominator: '1' }, valuationAt: f.mandate.knowledgeAt, rounding: 'EXACT_NO_EXECUTION_ROUNDING' });
    const intentA = { kind: 'S5_ALLOCATION', request: support.clearing(f, { 'deal-A': ['1'] }, [], [], [financeA]),
      selectedPolicyIds: [financeA.ref.id], quantityContext: quantity(f), handoff: null };
    const intentB = { kind: 'S5_ALLOCATION', request: support.clearing(b, { 'deal-B': ['1'] }, [], [], [financeB]),
      selectedPolicyIds: [financeB.ref.id], quantityContext: quantity(b), handoff: null };
    const branchA = ok(await control(actors.partner, 'branch', { sessionId: openA.sessionId, expectedOwnerVector: openA.ownerVector,
      intent: intentA, consequenceGrant: grantA, visibility: 'PRIVATE', idempotencyKey: randomUUID() }));
    const branchB = ok(await control(actors.finance, 'branch', { sessionId: openB.sessionId, expectedOwnerVector: openB.ownerVector,
      intent: intentB, consequenceGrant: grantB, visibility: 'PRIVATE', idempotencyKey: randomUUID() }));
    await artifact('registered-original-inputs.json', { actors, root, dealA: dealA.row.id, dealB: dealB.row.id,
      workA: openA.workId, workB: openB.workId, intentA, intentB, originalBudgetUSD: null,
      syntheticFixtureDates: { ...syntheticDates, legalSignatureOrProfessionalReceipt: 'NONE, UNVERIFIED_DEVELOPMENT_INPUT_ONLY' },
      independentConstraint: { USD: '20000000', stock: true, ownership: '1/1', noBorrowingOrUncertainProceeds: true } });
    worker = await startWorker('production-worker.log');
    const acceptedA = ok(await control(actors.partner, 'evaluate', { sessionId: openA.sessionId, branchId: branchA.branchId, idempotencyKey: randomUUID() }));
    const acceptedB = ok(await control(actors.finance, 'evaluate', { sessionId: openB.sessionId, branchId: branchB.branchId, idempotencyKey: randomUUID() }));
    let previewsPassed = false;
    await story('B-real-two-private-previews', async () => {
      const evaluations = await waitFor(async () => {
        const rows = (await admin.query('SELECT id,status,result FROM finnor_os.v5_evaluations WHERE id=ANY($1::uuid[]) ORDER BY id',
          [[acceptedA.evaluationId, acceptedB.evaluationId]])).rows;
        return rows.length === 2 && rows.every(r => ['COMPLETE', 'PARTIAL', 'FAILED', 'INVALIDATED', 'BLOCKED'].includes(r.status)) ? rows : undefined;
      }, 'actual registered producer publication');
      assert(evaluations.every(e => e.status === 'COMPLETE'), JSON.stringify(evaluations));
      const jobs = (await admin.query(`SELECT j.id,j.type,j.status,j.claim_fence,j.attempts,a.id delivery_attempt_id
        FROM finnor_os.jobs j LEFT JOIN finnor_os.job_delivery_attempts a ON a.job_id=j.id AND a.claim_fence=j.claim_fence
        WHERE j.id=ANY($1::uuid[])`,
        [[acceptedA.jobId, acceptedB.jobId]])).rows;
      const costs = (await admin.query('SELECT evaluation_id,charged,cost_refs FROM finnor_os.v5_evaluation_custody WHERE evaluation_id=ANY($1::uuid[])',
        [[acceptedA.evaluationId, acceptedB.evaluationId]])).rows;
      assert(costs.every(x => x.charged && x.cost_refs.length));
      previewsPassed = true;
      return { evaluations, jobs, costs, physicalWorkerPid: worker!.pid };
    });
    if (!previewsPassed) throw Error('DEPENDENT_RACE_NOT_RUN_PREVIEW_PREREQUISITE_FAILED');
    await story('C-withdrawn-prepared-proposal-cannot-dispatch', async () => {
      const base = ok(await control(actors.partner, 'snapshot', { sessionId: openA.sessionId }));
      const branch = ok(await control(actors.partner, 'branch', { sessionId: openA.sessionId, expectedOwnerVector: base.ownerVector,
        intent: intentA, consequenceGrant: grantA, visibility: 'PRIVATE', idempotencyKey: randomUUID() }));
      const accepted = ok(await control(actors.partner, 'evaluate', { sessionId: openA.sessionId, branchId: branch.branchId, idempotencyKey: randomUUID() }));
      const result = await waitFor(async () => {
        const row = (await admin.query('SELECT status FROM finnor_os.v5_evaluations WHERE id=$1', [accepted.evaluationId])).rows[0];
        return row && ['COMPLETE', 'PARTIAL', 'FAILED', 'INVALIDATED', 'BLOCKED'].includes(row.status) ? row : undefined;
      }, 'withdrawal case real native preview');
      assert.equal(result.status, 'COMPLETE');
      const view = ok(await control(actors.partner, 'snapshot', { sessionId: openA.sessionId }));
      const proposal = ok(await control(actors.partner, 'propose', { sessionId: openA.sessionId, branchId: branch.branchId,
        expectedOwnerVector: view.scenarios.find((b: any) => b.branchId === branch.branchId).ownerVector, idempotencyKey: randomUUID() }));
      const withdrawal = ok(await control(actors.partner, 'withdraw', { sessionId: openA.sessionId, branchId: branch.branchId,
        reason: 'Explicit withdrawal before any native dispatch', idempotencyKey: randomUUID() }));
      const fresh = ok(await control(actors.partner, 'snapshot', { sessionId: openA.sessionId }));
      const p = fresh.scenarios.find((b: any) => b.branchId === branch.branchId).proposals.find((p: any) => p.proposalId === proposal.proposalId);
      const denied = await control(actors.partner, 'dispatch', { sessionId: openA.sessionId, proposalId: p.proposalId,
        proposalDigest: p.proposalDigest, expectedOwnerVector: p.ownerVector, idempotencyKey: randomUUID() });
      assert.equal(denied.status, 409); assert.equal(denied.body.code, 'WITHDRAWN_BRANCH');
      const count = (await admin.query('SELECT count(*)::int n FROM finnor_os.v5_dispatch_refs WHERE tenant_id=$1 AND proposal_id=$2',
        [f.tenant, p.proposalId])).rows[0].n;
      assert.equal(count, 0); assert.equal(withdrawal.effectsCancelled, false);
      return { originalEvaluationId: accepted.evaluationId, originalProposalId: p.proposalId,
        realNativePreviewStatus: result.status, actualDispatchRefusal: denied, noNewDispatch: count === 0, withdrawal };
    });
    assert(!process.exitCode, 'DEPENDENT_RACE_NOT_RUN_WITHDRAWAL_PREREQUISITE_FAILED');
    const snapshotA = ok(await control(actors.partner, 'snapshot', { sessionId: openA.sessionId }));
    const snapshotB = ok(await control(actors.finance, 'snapshot', { sessionId: openB.sessionId }));
    const proposalA = ok(await control(actors.partner, 'propose', { sessionId: openA.sessionId, branchId: branchA.branchId,
      expectedOwnerVector: snapshotA.scenarios.find((b: any) => b.branchId === branchA.branchId).ownerVector, idempotencyKey: randomUUID() }));
    const proposalB = ok(await control(actors.finance, 'propose', { sessionId: openB.sessionId, branchId: branchB.branchId,
      expectedOwnerVector: snapshotB.scenarios.find((b: any) => b.branchId === branchB.branchId).ownerVector, idempotencyKey: randomUUID() }));
    if (c.selected === 'rights') await story('E-valid-delegation-and-exact-human-approval-chain', async () => {
      assert(actors.agent);
      const authorView = ok(await control(actors.partner, 'snapshot', { sessionId: openA.sessionId }));
      ok(await control(actors.partner, 'share', { sessionId: openA.sessionId, branchId: branchA.branchId,
        expectedOwnerVector: authorView.scenarios.find((b: any) => b.branchId === branchA.branchId).currentOwnerVector,
        visibility: 'SHARED', idempotencyKey: randomUUID() }));
      const agentView = ok(await control(actors.agent, 'open', { workId: openA.workId, root, focus: openA.focus }));
      const temporal = ok(await control(actors.temporal, 'open', { workId: openA.workId, root, focus: openA.focus }));
      assert.equal(temporal.principal.validUntil, temporalExpiry.toISOString());
      assert.equal(agentView.principal.actorKind, 'AGENT'); assert.equal(agentView.principal.delegationRef, delegationId);
      assert.equal(agentView.principal.delegationWorkId, openA.workId);
      const native = { kind: 'NATIVE_ACTION', actionType: 'open_workstream', payload: { dealId: dealA.row.id,
        kind: 'financial_diligence', name: 'Explicit permitted agent proposal', owner: { partyType: 'employee', partyId: actors.agent } },
        quantityContext: null, professionalAuthorityRef: null };
      const agentBranch = ok(await control(actors.agent, 'branch', { sessionId: openA.sessionId,
        expectedOwnerVector: agentView.ownerVector, intent: native, consequenceGrant: null,
        visibility: 'PRIVATE', idempotencyKey: randomUUID() }));
      const service = await control(actors.service, 'begin', { root, focus: openA.focus, idempotencyKey: randomUUID() });
      assert.equal(service.status, 403); assert.equal(service.body.code, 'ACTOR_KIND_OR_PROFESSIONAL_AUTHORITY_UNAVAILABLE');
      const professional = await control(actors.agent, 'branch', { sessionId: openA.sessionId, expectedOwnerVector: agentView.ownerVector,
        intent: { kind: 'NATIVE_ACTION', actionType: 'waive_closing_condition', payload: { dealId: dealA.row.id,
          closingConditionId: randomUUID(), expectedVersion: 1, reason: 'No qualified professional attestation supplied' },
          quantityContext: null, professionalAuthorityRef: null },
        consequenceGrant: null, visibility: 'PRIVATE', idempotencyKey: randomUUID() });
      assert.equal(professional.status, 422); assert.equal(professional.body.code, 'QUALIFIED_PROFESSIONAL_OWNER_PORT_UNAVAILABLE');
      const source = ok(await control(actors.partner, 'snapshot', { sessionId: openA.sessionId }));
      const p = source.scenarios.find((b: any) => b.branchId === branchA.branchId).proposals.find((p: any) => p.proposalId === proposalA.proposalId);
      const missing = await control(actors.partner, 'dispatch', { sessionId: openA.sessionId, proposalId: p.proposalId,
        proposalDigest: p.proposalDigest, expectedOwnerVector: p.ownerVector, idempotencyKey: randomUUID() });
      assert.equal(missing.status, 409); assert.equal(missing.body.code, 'EXACT_CURRENT_APPROVAL_CHAIN_INCOMPLETE');
      assert.equal((await admin.query('SELECT count(*)::int n FROM finnor_os.v5_dispatch_refs WHERE proposal_id=$1', [p.proposalId])).rows[0].n, 0);
      const reviewer = ok(await control(actors.compliance, 'open', { workId: openA.workId, root, focus: openA.focus }));
      const rp = reviewer.scenarios.find((b: any) => b.branchId === branchA.branchId).proposals.find((p: any) => p.proposalId === proposalA.proposalId);
      assert.equal(rp.nativeRequest, null); assert.equal(rp.permittedReview.kind, 'S5_RESERVATION_REVIEW');
      assert(rp.permittedReview.resourceEnvelopes.some((e: any) => e.resourceId === 'cash' && e.quantities[0] === '20000000'));
      assert.equal(reviewer.scenarios.find((b: any) => b.branchId === branchA.branchId).evaluation.incurredCosts.length, 0);
      const approvalInput = { sessionId: openA.sessionId, proposalId: rp.proposalId, proposalDigest: rp.proposalDigest,
        expectedOwnerVector: rp.ownerVector, expiresAt: rp.expiresAt, idempotencyKey: randomUUID() };
      const changed = await control(actors.compliance, 'approve', { ...approvalInput, proposalDigest: '0'.repeat(64) });
      assert.equal(changed.status, 409); assert.equal(changed.body.code, 'EXACT_PROPOSAL_MISMATCH');
      const av = ok(await control(actors.agent, 'snapshot', { sessionId: openA.sessionId }));
      const ap = av.scenarios.find((b: any) => b.branchId === branchA.branchId).proposals.find((p: any) => p.proposalId === proposalA.proposalId);
      const impersonation = await control(actors.agent, 'approve', { ...approvalInput, proposalDigest: ap.proposalDigest,
        expectedOwnerVector: ap.ownerVector, idempotencyKey: randomUUID() });
      assert.equal(impersonation.status, 403); assert.equal(impersonation.body.code, 'ACTOR_KIND_OR_PROFESSIONAL_AUTHORITY_UNAVAILABLE');
      const decision = ok(await control(actors.compliance, 'approve', approvalInput));
      const original = (await admin.query('SELECT employee_id,operation,capability,outcome,evidence FROM finnor_os.authority_decisions WHERE id=$1',
        [decision.decisionRef])).rows[0];
      assert.equal(original.employee_id, actors.compliance); assert.equal(original.operation, 'approval');
      assert.equal(original.capability, 'approve:allocate_resource'); assert.equal(original.outcome, 'allowed');
      assert.equal(original.evidence.controlBinding.proposalId, proposalA.proposalId);
      assert.equal(original.evidence.exactAmountUsd, '20000000');
      return { agent: agentView.principal, temporal: temporal.principal, agentBranch, service, professional, missing, changed, impersonation, decision, original,
        permittedReview: rp.permittedReview, qualification: 'DEVELOPMENT_IDENTITY_AND_S1_APPROVAL_NOT_PROFESSIONAL_OR_S6_ADMISSION' };
    });
    assert(!process.exitCode, 'DEPENDENT_RACE_NOT_RUN_RIGHTS_PREREQUISITE_FAILED');
    await story('B-last-USD20m-owner-commit-race', async () => {
      const a = ok(await control(actors.partner, 'snapshot', { sessionId: openA.sessionId }));
      const bview = ok(await control(actors.finance, 'snapshot', { sessionId: openB.sessionId }));
      const ap = a.scenarios.find((b: any) => b.branchId === branchA.branchId).proposals.find((p: any) => p.proposalId === proposalA.proposalId);
      const bp = bview.scenarios.find((b: any) => b.branchId === branchB.branchId).proposals.find((p: any) => p.proposalId === proposalB.proposalId);
      const dispatches = await Promise.all([
        control(actors.partner, 'dispatch', { sessionId: openA.sessionId, proposalId: ap.proposalId, proposalDigest: ap.proposalDigest,
          expectedOwnerVector: ap.ownerVector, idempotencyKey: randomUUID() }),
        control(actors.finance, 'dispatch', { sessionId: openB.sessionId, proposalId: bp.proposalId, proposalDigest: bp.proposalDigest,
          expectedOwnerVector: bp.ownerVector, idempotencyKey: randomUUID() }),
      ]);
      const holdings = (await admin.query(`SELECT r.reservation_id,r.status,(e->'quantities'->>0)::numeric amount
        FROM finnor_os.s5_reservations r CROSS JOIN LATERAL jsonb_array_elements(r.envelopes) e
        WHERE r.tenant_id=$1 AND r.status<>'RELEASED' AND e->>'resourceId'='cash'
          AND (e->'quantities'->>0)::numeric>0`, [f.tenant])).rows;
      assert.equal(holdings.length, 1, JSON.stringify({ dispatches, holdings }));
      const independent = (await admin.query(`SELECT sum((e->'quantities'->>0)::numeric)::text used,
        (20000000::numeric-sum((e->'quantities'->>0)::numeric))::text remaining
        FROM finnor_os.s5_reservations r CROSS JOIN LATERAL jsonb_array_elements(r.envelopes) e
        WHERE r.tenant_id=$1 AND r.status<>'RELEASED' AND e->>'resourceId'='cash'`, [f.tenant])).rows[0];
      assert.equal(independent.used, '20000000'); assert.equal(independent.remaining, '0');
      const views = [ok(await control(actors.partner, 'snapshot', { sessionId: openA.sessionId })),
        ok(await control(actors.finance, 'snapshot', { sessionId: openB.sessionId }))];
      assert(views.every(v => v.confirmed.capacity.find((r: any) => r.resourceId === 'cash').aggregateHeld[0] === '20000000'));
      await artifact('B-race.json', { dispatches, holdings, independent, views, originalProposalIds: [ap.proposalId, bp.proposalId] });
      return { dispatches, independent, retainedHolds: 1, bothAuthorizedViewsConverged: true, externalSettlement: 'UNESTABLISHED' };
    });
    await story('E-real-bearer-header-spoof-and-private-custody', async () => {
      const anonymous = await http.call(actors.partner, 'live-controls', { operation: 'snapshot', input: { sessionId: openA.sessionId } }, { anonymous: true });
      const invalid = await http.call(actors.partner, 'live-controls', { operation: 'snapshot', input: { sessionId: openA.sessionId } }, { invalid: true });
      assert.equal(anonymous.status, 401); assert.equal(invalid.status, 401);
      const other = await http.call(actors.finance, 'live-controls', { operation: 'snapshot', input: { sessionId: openA.sessionId } }, { spoof: actors.partner });
      assert.equal(other.status, 200); assert.equal(other.body.principal.principalId, actors.finance);
      assert(other.body.scenarios.every((b: any) => b.visibility === 'SHARED' && b.isAuthor === false));
      assert.equal(other.body.scenarios.length, c.selected === 'rights' ? 1 : 0);
      const app = new (await import('pg')).default.Client({ connectionString: process.env.DATABASE_URL }); await app.connect();
      try {
        await app.query('BEGIN'); await app.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)", [f.tenant, actors.finance]);
        const forbidden = (await app.query(`SELECT (SELECT count(*) FROM finnor_os.v5_branch_custody WHERE principal_id=$1)::int branches,
          (SELECT count(*) FROM finnor_os.v5_evaluation_custody WHERE principal_id=$1)::int evaluations,
          (SELECT count(*) FROM finnor_os.v5_consequence_grants WHERE principal_id=$1)::int grants`, [actors.partner])).rows[0];
        assert.deepEqual(forbidden, { branches: 0, evaluations: 0, grants: 0 }); await app.query('ROLLBACK');
        await app.query('BEGIN');
        await app.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)", [f.tenant, actors.finance]);
        await assert.rejects(app.query('SELECT owner_vectors FROM finnor_os.v5_cursors'), (e: any) => e.code === '42501');
        await app.query('ROLLBACK');
        await app.query('BEGIN');
        await app.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.user_id',$2,true)", [f.tenant, actors.finance]);
        const subsetOracle = (await app.query(`SELECT finnor_os.v5_control_cut_matches($1,$2,$3,'session','{}'::jsonb,true) matches`,
          [other.body.cursor, openA.sessionId, http.sessions.get(actors.finance)])).rows[0];
        assert.equal(subsetOracle.matches, false);
        await assert.rejects(app.query("UPDATE finnor_os.v5_cursors SET owner_vectors='{}'::jsonb WHERE id=$1", [other.body.cursor]),
          (e: any) => e.code === '42501');
        await app.query('ROLLBACK');
        return { anonymous: anonymous.status, invalid: invalid.status, headerSpoofPrincipal: other.body.principal.principalId,
          forbidden, directPrivateCursorColumn: '42501', privateSubsetOracle: subsetOracle, cursorUpdate: '42501' };
      } finally { await app.end(); }
    });
    await story('G-recipient-cursor-gap-and-no-replay', async () => {
      const before = (await admin.query('SELECT proposal_id,status FROM finnor_os.v5_dispatch_refs WHERE tenant_id=$1 ORDER BY proposal_id', [f.tenant])).rows;
      const base = ok(await control(actors.partner, 'snapshot', { sessionId: openA.sessionId }));
      const foreign = ok(await control(actors.finance, 'events', { sessionId: openA.sessionId, cursor: base.cursor, projectionDigest: base.projectionDigest }));
      assert.equal(foreign.kind, 'RESYNC');
      const future = ok(await control(actors.partner, 'events', { sessionId: openA.sessionId, cursor: randomUUID(), projectionDigest: base.projectionDigest }));
      assert.equal(future.kind, 'RESYNC'); assert.equal(future.mutationReplayPermitted, false);
      const after = (await admin.query('SELECT proposal_id,status FROM finnor_os.v5_dispatch_refs WHERE tenant_id=$1 ORDER BY proposal_id', [f.tenant])).rows;
      assert.deepEqual(after, before);
      assert.equal(after.length, 2); assert.equal(after.filter(r => r.status === 'OWNER_ACCEPTED').length, 1);
      assert.equal(after.filter(r => r.status === 'BLOCKED').length, 1);
      return { foreign: foreign.kind, future: future.kind, originalOperations: after, acceptedCount: 1, blockedCount: 1,
        originalIdentitiesRetained: true, note: 'A retained blocked dispatch is not another accepted allocation' };
    });
    if (c.selected === 'privacy') {
      assert(!process.exitCode, 'SCOPED_PRIVACY_NOT_RUN_AFTER_OWNER_PREREQUISITE_FAILURE');
      await story('F-scoped-focus-composite-FK-metadata', async () => {
        assert(actors.scoped);
        const target = scopedTargets.get(f.tenant);
        const fixture = (await admin.query(`SELECT u.id,u.status,a.resource_scope,g.capability,g.resource_type
          FROM finnor_os.users u JOIN finnor_os.employee_role_assignments a ON a.employee_id=u.id AND a.tenant_id=u.tenant_id
          JOIN finnor_os.role_authority_grants g ON g.role_id=a.role_id AND g.tenant_id=a.tenant_id WHERE u.id=$1`,
        [actors.scoped])).rows;
        const foreignKeys = (await admin.query(`SELECT conname,pg_get_constraintdef(oid) definition FROM pg_constraint
          WHERE conrelid='finnor_os.pe_workstreams'::regclass AND contype='f'`)).rows;
        assert(foreignKeys.some(row => row.definition.includes('FOREIGN KEY (tenant_id, deal_id)')),
          'ORIGINAL_TENANT_COMPOSITE_FOREIGN_KEY_REQUIRED');
        const denied = await control(actors.scoped, 'open', { workId: openA.workId, root, focus: openA.focus });
        assert.equal(denied.status, 404);
        const deniedNarrowOpen = await control(actors.scoped, 'open', { workId: openA.workId, root,
          focus: { type: 'pe_workstream', id: target.id } });
        assert.equal(deniedNarrowOpen.status, 404);
        const deliveryRegistration = ok(await control(actors.scoped, 'open', { workId: openA.workId, root,
          focus: { type: root.entityType, id: root.entityId } }));
        const permitted = ok(await control(actors.partner, 'open', { workId: openA.workId, root,
          focus: { type: 'pe_workstream', id: target.id } }));
        const view = ok(await control(actors.scoped, 'snapshot', { sessionId: permitted.sessionId }));
        const observed = JSON.parse(view.confirmed.focus.exactProjectionJson);
        await artifact('scoped-focus-observation.json', { fixture, foreignKeys, target: { id: target.id, forbiddenDealId: dealA.row.id },
          denied, deniedNarrowOpen, deliveryRegistration, permittedProjection: observed, snapshot: view });
        assert.equal(observed.id, target.id); assert.equal(observed.name, target.name);
        assert.equal(observed.deal_id, undefined, 'FORBIDDEN_COMPOSITE_FOREIGN_KEY_METADATA');
        assert(!JSON.stringify(view).includes(String(dealA.row.id)), 'FORBIDDEN_PARENT_ID_IN_CONTROL_WIRE');
        assert.equal(view.confirmed.focus.coverage, 'PERMITTED_FIELDS_ONLY');
        return { fixture, foreignKeys, forbiddenParentRefused: denied, deniedNarrowOpen, deliveryRegistration, permittedProjection: observed,
          forbiddenParentMetadataAbsent: true, earlierPrerequisitesValid: true };
      });
      assert(!process.exitCode, 'SCOPED_PRIVACY_STORY_FAILED');
    }
    if (['native', 'native-sibling'].includes(c.selected)) {
      assert(!process.exitCode, 'NATIVE_ACTION_NOT_RUN_AFTER_OWNER_PREREQUISITE_FAILURE');
      await story('A-native-grounded-action-original-confirmation-and-canonical-effect', async () => {
        const nativeDeadline = performance.now() + 240000;
        const remaining = () => {
          const ms = nativeDeadline - performance.now();
          assert(ms > 0, 'REGISTERED_NATIVE_STORY_DEADLINE'); return ms;
        };
        const { controlTransaction } = await import('../../packages/private-equity/src/live-controls/store');
        const { assertNativeControlActionTx } = await import('../../packages/private-equity/src/live-controls/service');
        const { assertLiveControlBoundaryTx } = await import('../../packages/orchestration/src/live-control-boundary');
        const { transactionDb } = await import('../../packages/db');
        const { createWorkstream, createFinding, attachWorkToDealGraph, withPeMutationTransaction } =
          await import('../../packages/private-equity/src/repository');
        const { resolveTenantFromBearerToken } = await import('../../packages/security/src/auth');
        const ctx = { auth: await resolveTenantFromBearerToken(await http.issue(actors.partner)),
          provenance: { sourceSystem: 'v5-independent-native-campaign', createdBy: actors.partner } };
        const caller = { auth: await resolveTenantFromBearerToken(await http.issue(actors.finance)),
          provenance: { sourceSystem: 'v5-independent-native-boundary-caller', createdBy: actors.finance } };
        const siblingCase = c.selected === 'native-sibling', createdTable = siblingCase ? 'pe_findings' : 'pe_workstreams';
        const input = siblingCase ? { kind: 'NATIVE_ACTION', actionType: 'record_finding', payload: { dealId: dealA.row.id,
          workstreamId: scopedTargets.get(f.tenant).id, statement: 'Independently registered internal non-material diagnostic finding',
          severity: 'low', materiality: 'non_material', owner: { partyType: 'employee', partyId: actors.partner } },
        quantityContext: null, professionalAuthorityRef: null } : { kind: 'NATIVE_ACTION', actionType: 'open_workstream', payload: { dealId: dealA.row.id,
          kind: 'financial_diligence', name: 'Exact independently specified native workstream',
          owner: { partyType: 'employee', partyId: actors.partner } }, quantityContext: null, professionalAuthorityRef: null };
        const absentWorkResult = randomUUID(), absentWork = randomUUID();
        const revisions = () => admin.query('SELECT key,revision::text FROM finnor_os.p4_source_revisions WHERE tenant_id=$1 ORDER BY key', [f.tenant]);
        const sourceBefore = (await revisions()).rows;
        await assert.rejects(createWorkstream(ctx, { id: absentWorkResult, dealId: String(dealA.row.id),
          kind: 'financial_diligence', name: 'Atomic missing Work rollback subject',
          owner: { partyType: 'employee', partyId: actors.partner } }, { workId: absentWork }),
        (error: any) => error.code === 'PE_WORK_NOT_FOUND');
        assert.equal((await admin.query('SELECT count(*)::int n FROM finnor_os.pe_workstreams WHERE tenant_id=$1 AND id=$2',
          [f.tenant, absentWorkResult])).rows[0].n, 0);
        assert.deepEqual((await revisions()).rows, sourceBefore);
        if (siblingCase) {
          await assert.rejects(withPeMutationTransaction(ctx, async () => {
            const result = await createFinding(ctx, { id: absentWorkResult, dealId: String(dealA.row.id),
              workstreamId: String(input.payload.workstreamId), statement: 'Atomic missing Work finding rollback',
              severity: 'low', materiality: 'non_material', owner: { partyType: 'employee', partyId: actors.partner } });
            await attachWorkToDealGraph(ctx, { dealId: String(dealA.row.id), workId: absentWork,
              entities: [{ entityType: 'pe_finding', entityId: String(result.row.id), relationship: 'result' }] });
          }), (error: any) => error.code === 'PE_WORK_NOT_FOUND');
          assert.equal((await admin.query('SELECT count(*)::int n FROM finnor_os.pe_findings WHERE tenant_id=$1 AND id=$2',
            [f.tenant, absentWorkResult])).rows[0].n, 0);
          assert.deepEqual((await revisions()).rows, sourceBefore);
        }
        const atomicRollback = { missingWork: absentWork, absentResult: absentWorkResult, reason: 'PE_WORK_NOT_FOUND',
          workstreamAbsent: true, findingAbsent: siblingCase ? true : null, sourceRevisionsUnchanged: true };
        const before = ok(await control(actors.partner, 'snapshot', { sessionId: openA.sessionId }));
        const branch = ok(await control(actors.partner, 'branch', { sessionId: openA.sessionId,
          expectedOwnerVector: before.ownerVector, intent: input, consequenceGrant: grantA,
          visibility: 'PRIVATE', idempotencyKey: randomUUID() }));
        const accepted = ok(await control(actors.partner, 'evaluate', { sessionId: openA.sessionId,
          branchId: branch.branchId, idempotencyKey: randomUUID() }));
        const evaluation = await waitFor(async () => {
          const row = (await admin.query('SELECT status FROM finnor_os.v5_evaluations WHERE id=$1', [accepted.evaluationId])).rows[0];
          return row && ['COMPLETE', 'PARTIAL', 'FAILED', 'INVALIDATED', 'BLOCKED'].includes(row.status) ? row : undefined;
        }, 'native schema-only charged consequence publication', remaining());
        assert.equal(evaluation.status, 'PARTIAL');
        const preview = ok(await control(actors.partner, 'snapshot', { sessionId: openA.sessionId }));
        const scenario = preview.scenarios.find((b: any) => b.branchId === branch.branchId);
        assert.equal(scenario.evaluation.consequence.result.valueForecast, null);
        assert.equal(scenario.evaluation.consequence.reservesCapital, false);
        assert.equal(scenario.evaluation.consequence.executionAuthorityGranted, false);
        const proposed = ok(await control(actors.partner, 'propose', { sessionId: openA.sessionId, branchId: branch.branchId,
          expectedOwnerVector: scenario.ownerVector, idempotencyKey: randomUUID() }));
        const review = ok(await control(actors.partner, 'snapshot', { sessionId: openA.sessionId }));
        const p = review.scenarios.find((b: any) => b.branchId === branch.branchId).proposals.find((p: any) => p.proposalId === proposed.proposalId);
        const dispatched = ok(await control(actors.partner, 'dispatch', { sessionId: openA.sessionId, proposalId: p.proposalId,
          proposalDigest: p.proposalDigest, expectedOwnerVector: p.ownerVector, idempotencyKey: randomUUID() }));
        await artifact('native-dispatch-observation.json', { dispatched, originalOwnerLog: (await admin.query(
          'SELECT step,output FROM finnor_os.action_log WHERE tenant_id=$1 AND domain_action_id=$2 ORDER BY timestamp,id',
          [f.tenant, p.proposalId])).rows });
        assert.equal(dispatched.status, 'OWNER_ACCEPTED', JSON.stringify(dispatched));
        const action = (await admin.query('SELECT id,action_type,payload,status,work_id,initiated_by,business_effect_id FROM finnor_os.domain_actions WHERE id=$1',
          [p.proposalId])).rows[0];
        assert(action?.business_effect_id); assert.equal(action.status, 'pending');
        const { grounding, ...payload } = action.payload;
        assert.deepEqual(payload, { ...input.payload, [siblingCase ? 'findingId' : 'workstreamId']: action.id, workId: openA.workId });
        assert.equal(grounding.deal.entityId, dealA.row.id); assert.equal(grounding.work.entityId, openA.workId);
        assert.equal(action.initiated_by, actors.partner); assert.equal(action.work_id, openA.workId);
        const effect = (await admin.query('SELECT id,effect,semantic_hash,status FROM finnor_os.business_effects WHERE id=$1',
          [action.business_effect_id])).rows[0];
        assert.equal(effect.effect.source.domainActionId, action.id);
        assert.equal(effect.effect.source.workId, openA.workId); assert.equal(effect.effect.operation.name, input.actionType);
        assert.equal(effect.effect.operation.external, false); assert.deepEqual(effect.effect.delta.values, action.payload);
        if (!siblingCase) assert.deepEqual(effect.effect.bindings, []);
        const guard = await controlTransaction(ctx, client => assertNativeControlActionTx(ctx, action.id, client), { financialFence: true });
        assert(guard);
        const retained = async () => ({
          payload: (await admin.query('SELECT payload FROM finnor_os.domain_actions WHERE id=$1', [action.id])).rows[0].payload,
          debit: (await admin.query('SELECT principal_id,grant_digest,resource_id,spent FROM finnor_os.p2_grant_usage WHERE tenant_id=$1 ORDER BY principal_id,grant_digest,resource_id', [f.tenant])).rows,
          reservations: (await admin.query('SELECT reservation_id,status,envelopes FROM finnor_os.s5_reservations WHERE tenant_id=$1 ORDER BY reservation_id', [f.tenant])).rows,
        });
        const original = await retained(), refusals = [];
        const mutations = [
          { ...action.payload, ...(siblingCase ? { statement: 'Unreviewed replacement finding' } : { name: 'Unreviewed replacement name' }) },
          { ...action.payload, ...(siblingCase ? { severity: 'critical' } : { kind: 'legal' }) },
          { ...action.payload, owner: { partyType: 'employee', partyId: actors.finance } },
          { ...action.payload, unreviewedExtraField: 'Not in the exact original input' },
        ];
        for (const changed of mutations) {
          remaining();
          await assert.rejects(controlTransaction(ctx, async client => {
            await client.query('UPDATE finnor_os.domain_actions SET payload=$2::jsonb WHERE tenant_id=$3 AND id=$1',
              [action.id, JSON.stringify(changed), f.tenant]);
            await assertNativeControlActionTx(ctx, action.id, client);
          }, { financialFence: true }), (error: any) => error.code === 'EXACT_NATIVE_REQUEST_CHANGED');
          assert.deepEqual(await retained(), original);
          refusals.push({ changedKeys: Object.keys(changed).filter(key => JSON.stringify(changed[key]) !== JSON.stringify(action.payload[key])),
            guard: 'EXACT_NATIVE_REQUEST_CHANGED', originalActionAndLiabilityRetained: true });
        }
        await assert.rejects(controlTransaction(ctx, async client => {
          await client.query(`UPDATE finnor_os.business_effects SET effect=jsonb_set(effect,'{delta,values,name}',$2::jsonb)
            WHERE tenant_id=$3 AND id=$1`, [effect.id, JSON.stringify('Unreviewed effect'), f.tenant]);
        }), (error: any) => error.code === 'P0001' && error.message === 'Business Effect semantic intent is immutable');
        assert.deepEqual(await retained(), original);
        const restoration = await controlTransaction(caller, async client => {
          const prior = (await client.query("SELECT current_setting('app.user_id',true) principal")).rows[0].principal;
          await assertLiveControlBoundaryTx(transactionDb(client), f.tenant, action.id, actors.partner);
          const after = (await client.query("SELECT current_setting('app.user_id',true) principal")).rows[0].principal;
          assert.equal(prior, actors.finance); assert.equal(after, prior); return { prior, after, author: actors.partner };
        }, { financialFence: true });
        const noEffect = (await admin.query(`SELECT count(*)::int n FROM finnor_os.${createdTable} WHERE id=$1`, [action.id])).rows[0].n;
        assert.equal(noEffect, 0);
        const missingHash = await http.call(actors.compliance, `actions/${action.id}/confirm`, { typedConfirmation: true });
        assert.equal(missingHash.status, 400);
        const wrongHash = await http.call(actors.compliance, `actions/${action.id}/confirm`, { expectedEffectHash: '0'.repeat(64), typedConfirmation: true });
        assert.equal(wrongHash.status, 409);
        assert.equal((await admin.query('SELECT status FROM finnor_os.domain_actions WHERE id=$1', [action.id])).rows[0].status, 'pending');
        remaining();
        const confirmation = ok(await http.call(actors.compliance, `actions/${action.id}/confirm`,
          { expectedEffectHash: effect.semantic_hash, typedConfirmation: true }));
        const canonical = await waitFor(async () => {
          const row = (await admin.query(`SELECT * FROM finnor_os.${createdTable} WHERE tenant_id=$1 AND id=$2`, [f.tenant, action.id])).rows[0];
          return row;
        }, 'actual original durable native PE mutation', remaining());
        assert.equal(canonical.deal_id, input.payload.dealId);
        if (siblingCase) {
          assert.equal(canonical.statement, input.payload.statement); assert.equal(canonical.workstream_id, input.payload.workstreamId);
          assert.equal(canonical.severity, input.payload.severity); assert.equal(canonical.materiality, input.payload.materiality);
        } else { assert.equal(canonical.name, input.payload.name); assert.equal(canonical.kind, input.payload.kind); }
        assert.equal(canonical.owner_party_id, actors.partner);
        assert.equal(canonical.owner_party_type, 'employee'); assert.equal(canonical.created_by, actors.partner);
        assert.equal((await admin.query(`SELECT count(*)::int n FROM finnor_os.${createdTable} WHERE tenant_id=$1 AND id=$2`, [f.tenant, action.id])).rows[0].n, 1);
        const terminal = await waitFor(async () => {
          const rows = (await admin.query(`SELECT d.status action_status,e.status effect_status,r.status workflow_status,
            s.status step_status,s.terminal_reason FROM finnor_os.domain_actions d
            JOIN finnor_os.business_effects e ON e.tenant_id=d.tenant_id AND e.id=d.business_effect_id
            JOIN finnor_os.workflow_steps s ON s.tenant_id=e.tenant_id AND s.business_effect_id=e.id
            JOIN finnor_os.workflow_runs r ON r.tenant_id=s.tenant_id AND r.id=s.workflow_run_id WHERE d.tenant_id=$1 AND d.id=$2`,
          [f.tenant, action.id])).rows;
          const row = rows[0];
          if (siblingCase && row?.step_status === 'failed') return row;
          assert(!row || row.step_status !== 'failed', 'ORIGINAL_NATIVE_TERMINAL_FAILURE:' + row?.terminal_reason);
          return row?.action_status === 'completed' && row.effect_status === 'verified' && row.workflow_status === 'completed'
            && row.step_status === 'completed' ? row : undefined;
        }, 'original native action effect workflow and step terminal completion', Math.min(60000, remaining()));
        await artifact('native-terminal-disposition.json', { actionId: action.id, createdTable, canonical, terminal,
          funding: 'UNCHANGED_ORIGINAL_GRANT_NO_RENEWAL', workerPid: worker!.pid });
        assert.equal(terminal.action_status, 'completed'); assert.equal(terminal.effect_status, 'verified');
        assert.equal(terminal.workflow_status, 'completed'); assert.equal(terminal.step_status, 'completed');
        const repeated = ok(await http.call(actors.compliance, `actions/${action.id}/confirm`,
          { expectedEffectHash: effect.semantic_hash, typedConfirmation: true }));
        assert.equal(repeated.idempotent, true);
        assert.equal((await admin.query(`SELECT count(*)::int n FROM finnor_os.${createdTable} WHERE tenant_id=$1 AND id=$2`,
          [f.tenant, action.id])).rows[0].n, 1);
        assert.equal((await admin.query(`SELECT count(*)::int n FROM finnor_os.work_entity_links
          WHERE tenant_id=$1 AND work_id=$2 AND entity_id=$3 AND relationship='result'`, [f.tenant, openA.workId, action.id])).rows[0].n, 1);
        const observed = ok(await control(actors.partner, 'snapshot', { sessionId: openA.sessionId }));
        const operation = observed.scenarios.find((b: any) => b.branchId === branch.branchId).proposals.find((p: any) => p.proposalId === action.id).operation;
        assert.equal(operation.originalAction.id, action.id); assert.equal(operation.originalEffect.id, effect.id);
        assert.equal(operation.independentlyReadFromCanonicalOwners, true); assert.equal(operation.settlementEstablished, false);
        assert.equal(operation.originalAction.status, 'completed'); assert.equal(operation.originalEffect.status, 'verified');
        assert.equal(operation.originalWorkflow.status, 'completed');
        const workflows = (await admin.query(`SELECT r.id,r.status,s.id step_id,s.status step_status,s.business_effect_id
          FROM finnor_os.workflow_runs r JOIN finnor_os.workflow_steps s ON s.tenant_id=r.tenant_id AND s.workflow_run_id=r.id
          WHERE s.tenant_id=$1 AND s.business_effect_id=$2`, [f.tenant, effect.id])).rows;
        const proof = { input, branch, accepted, evaluation, proposed, dispatched, action, effect, refusals,
          effectSemanticUpdate: 'ORIGINAL_SQL_IMMUTABILITY_REFUSAL_P0001', restoration,
          missingHash, wrongHash, confirmation, repeated, canonical, workflows, operation, terminal, atomicRollback, workerPid: worker!.pid,
          originalBudgetAndReservations: original, qualification: 'ACTUAL_INTERNAL_NATIVE_EFFECT_NOT_FINANCIAL_OR_EXTERNAL_SETTLEMENT' };
        await artifact('native-action-effect.json', proof); return proof;
      });
      assert(!process.exitCode, 'NATIVE_OWNER_STORY_FAILED');
    }
    if (c.selected === 'recovery') {
      assert(!process.exitCode, 'PHYSICAL_RECOVERY_NOT_RUN_AFTER_OWNER_PREREQUISITE_FAILURE');
      await story('H-physical-worker-kill-restart-original-budget-and-unknown', async () => {
        const recoveryDeadline = performance.now() + 240000;
        const before = (await admin.query('SELECT reservation_id,revision,status,envelopes FROM finnor_os.s5_reservations WHERE tenant_id=$1 ORDER BY reservation_id',
          [f.tenant])).rows;
        const originalUsage = (await admin.query(`SELECT spent FROM finnor_os.p2_grant_usage
          WHERE tenant_id=$1 AND principal_id=$2 AND grant_digest=$3`,
          [f.tenant, actors.partner, grantA.allocationRef.contentDigest])).rows[0].spent;
        const base = ok(await control(actors.partner, 'snapshot', { sessionId: openA.sessionId }));
        const branch = ok(await control(actors.partner, 'branch', { sessionId: openA.sessionId, expectedOwnerVector: base.ownerVector,
          intent: intentA, consequenceGrant: grantA, visibility: 'PRIVATE', idempotencyKey: randomUUID() }));
        const accepted = ok(await control(actors.partner, 'evaluate', { sessionId: openA.sessionId, branchId: branch.branchId, idempotencyKey: randomUUID() }));
        const charged = await waitFor(async () => {
          const row = (await admin.query(`SELECT e.status,c.original_budget,c.cost_refs FROM finnor_os.v5_evaluations e
            JOIN finnor_os.v5_evaluation_custody c ON c.evaluation_id=e.id WHERE e.id=$1 AND c.charged`, [accepted.evaluationId])).rows[0];
          return row?.status === 'RUNNING' && row.cost_refs.length === 1 ? row : undefined;
        }, 'original committed debit before physical kill');
        const killed = worker!;
        assert(killed.pid && killed.exitCode === null && killed.signalCode === null);
        const exit = new Promise<void>(yes => killed.once('exit', () => yes()));
        assert(killed.kill('SIGKILL')); await exit; assert.equal(killed.signalCode, 'SIGKILL');
        const afterKill = (await admin.query('SELECT status,result FROM finnor_os.v5_evaluations WHERE id=$1', [accepted.evaluationId])).rows[0];
        assert.equal(afterKill.status, 'RUNNING'); assert.equal(afterKill.result, null);
        await artifact('physical-kill-original-acceptance.json', { workerPid: killed.pid, signal: killed.signalCode,
          accepted, charged, afterKill, originalReservations: before, noFixtureLeaseExpiryOrRefund: true });
        await waitFor(async () => {
          const row = (await admin.query('SELECT lease_expires_at<=clock_timestamp() expired FROM finnor_os.jobs WHERE id=$1',
            [accepted.jobId])).rows[0];
          return row.expired ? row : undefined;
        }, 'real original durable lease expiry', 45000);
        const unknown = ok(await control(actors.partner, 'snapshot', { sessionId: openA.sessionId }));
        const retained = unknown.scenarios.find((b: any) => b.branchId === branch.branchId).evaluation;
        assert.equal(retained.status, 'UNKNOWN'); assert.equal(retained.incurredCosts.length, 1);
        await artifact('physical-recovery-unknown-readback.json', { evaluation: retained,
          permittedHeldCapacity: unknown.confirmed.capacity, originalJobId: accepted.jobId });
        worker = await startWorker('restarted-production-worker.log');
        const finished = await waitFor(async () => {
          const row = (await admin.query(`SELECT e.status,c.original_budget,c.cost_refs,c.result_private,j.status job_status,
            j.claim_fence,j.capacity_defer_count FROM finnor_os.v5_evaluations e
            JOIN finnor_os.v5_evaluation_custody c ON c.evaluation_id=e.id JOIN finnor_os.jobs j ON j.id=e.job_id WHERE e.id=$1`,
          [accepted.evaluationId])).rows[0];
          return row.job_status === 'completed' || ['FAILED', 'BLOCKED', 'INVALIDATED'].includes(row.status) ? row : undefined;
        }, 'same original job native publication after real capacity expiry', Math.max(1, recoveryDeadline - performance.now()));
        assert.equal(finished.job_status, 'completed'); assert.equal(finished.status, 'COMPLETE');
        assert.equal(finished.result_private.result.native.check.feasible, false);
        assert.deepEqual(finished.original_budget, charged.original_budget);
        assert.equal(finished.cost_refs.length, 2); assert(finished.cost_refs.every((cost: any) => cost.refundGranted === false));
        assert.equal(Number(finished.cost_refs[1].spent) - Number(finished.cost_refs[0].spent), 1);
        const finalUsage = (await admin.query(`SELECT spent FROM finnor_os.p2_grant_usage
          WHERE tenant_id=$1 AND principal_id=$2 AND grant_digest=$3`,
          [f.tenant, actors.partner, grantA.allocationRef.contentDigest])).rows[0].spent;
        assert.equal(Number(finalUsage) - Number(originalUsage), 2);
        assert(new Set(finished.cost_refs.map((cost: any) => cost.deliveryAttemptId)).size === 2);
        const deliveries = (await admin.query(`SELECT id,claim_fence,outcome,started_at,finished_at,failure_kind
          FROM finnor_os.job_delivery_attempts WHERE job_id=$1 ORDER BY claim_fence`, [accepted.jobId])).rows;
        assert.equal(deliveries[0].outcome, 'lease_lost'); assert.equal(deliveries.at(-1).outcome, 'completed');
        assert(Number(finished.claim_fence) > Number(deliveries[0].claim_fence));
        const current = ok(await control(actors.partner, 'snapshot', { sessionId: openA.sessionId }));
        const denied = await control(actors.partner, 'propose', { sessionId: openA.sessionId, branchId: branch.branchId,
          expectedOwnerVector: current.scenarios.find((b: any) => b.branchId === branch.branchId).ownerVector,
          idempotencyKey: randomUUID() });
        assert.equal(denied.status, 422); assert.equal(denied.body.code, 'JOINT_ALLOCATION_INFEASIBLE_OR_PARTIAL');
        const after = (await admin.query('SELECT reservation_id,revision,status,envelopes FROM finnor_os.s5_reservations WHERE tenant_id=$1 ORDER BY reservation_id',
          [f.tenant])).rows;
        assert.deepEqual(after, before);
        const observed = { originalJobId: accepted.jobId, originalEvaluationId: accepted.evaluationId,
          killedWorkerPid: killed.pid, killedSignal: killed.signalCode, replacementWorkerPid: worker.pid,
          unknownReadback: retained, finished, deliveries, unchangedReservations: after,
          originalGrantUsage: { before: originalUsage, after: finalUsage, chargedPhysicalInvocations: 2 },
          infeasibleProposalRefusal: denied,
          qualification: 'ACTUAL_NONCONSEQUENTIAL_WORKER_RECOVERY_NOT_EXTERNAL_EFFECT_SETTLEMENT_OR_PROTECTED_ADMISSION' };
        await artifact('physical-recovery-final.json', observed); return observed;
      });
    }
    if (c.selected === 'rights') {
      assert(!process.exitCode, 'PHYSICAL_RIGHTS_PROOF_NOT_RUN_AFTER_PREREQUISITE_FAILURE');
      await story('F-physical-principal-lock-revocation-before-native-publication', async () => {
        const deadline = performance.now() + 240000;
        const reservations = (await admin.query('SELECT reservation_id,revision,status,envelopes FROM finnor_os.s5_reservations WHERE tenant_id=$1 ORDER BY reservation_id',
          [f.tenant])).rows;
        const base = ok(await control(actors.finance, 'snapshot', { sessionId: openB.sessionId }));
        const branch = ok(await control(actors.finance, 'branch', { sessionId: openB.sessionId, expectedOwnerVector: base.ownerVector,
          intent: intentB, consequenceGrant: grantB, visibility: 'PRIVATE', idempotencyKey: randomUUID() }));
        const accepted = ok(await control(actors.finance, 'evaluate', { sessionId: openB.sessionId, branchId: branch.branchId,
          idempotencyKey: randomUUID() }));
        const charged = await waitFor(async () => {
          const row = (await admin.query(`SELECT e.status,e.result,c.charged,c.cost_refs FROM finnor_os.v5_evaluations e
            JOIN finnor_os.v5_evaluation_custody c ON c.evaluation_id=e.id WHERE e.id=$1`, [accepted.evaluationId])).rows[0];
          return row?.status === 'RUNNING' && row.charged && row.cost_refs.length === 1 ? row : undefined;
        }, 'committed native debit before current-principal lock');
        const locker = new (await import('pg')).default.Client({ connectionString: c.adminUrl }); await locker.connect();
        let lock: unknown, waits: unknown;
        try {
          await locker.query('BEGIN'); await locker.query("SET LOCAL statement_timeout='10s'");
          lock = (await locker.query('SELECT id,status,pg_backend_pid() locker FROM finnor_os.users WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
            [f.tenant, actors.finance])).rows[0];
          assert.equal((lock as any).status, 'active');
          waits = await waitFor(async () => {
            const rows = (await admin.query(`SELECT pid,state,wait_event_type,wait_event,pg_blocking_pids(pid) blockers
              FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))`, [(lock as any).locker])).rows;
            return rows.length ? rows : undefined;
          }, 'actual worker blocked by canonical principal row lock', 15000);
          const beforeRevoke = (await admin.query('SELECT status,result FROM finnor_os.v5_evaluations WHERE id=$1', [accepted.evaluationId])).rows[0];
          assert.equal(beforeRevoke.status, 'RUNNING'); assert.equal(beforeRevoke.result, null);
          assert(worker!.pid && worker!.exitCode === null && worker!.signalCode === null);
          await locker.query("UPDATE finnor_os.users SET status='suspended' WHERE tenant_id=$1 AND id=$2", [f.tenant, actors.finance]);
          await locker.query('COMMIT');
        } finally { await locker.query('ROLLBACK').catch(() => undefined); await locker.end(); }
        const refused = await waitFor(async () => {
          const row = (await admin.query(`SELECT j.status job_status,j.last_error,e.status,e.result,c.charged,c.cost_refs,c.result_private
            FROM finnor_os.jobs j JOIN finnor_os.v5_evaluations e ON e.job_id=j.id
            JOIN finnor_os.v5_evaluation_custody c ON c.evaluation_id=e.id WHERE j.id=$1`, [accepted.jobId])).rows[0];
          return row.last_error ? row : undefined;
        }, 'actual native worker current-principal refusal', Math.max(1, deadline - performance.now()));
        assert.equal(refused.result, null); assert.equal(refused.result_private, null);
        assert.equal(refused.charged, true); assert.deepEqual(refused.cost_refs, charged.cost_refs);
        assert(refused.cost_refs.every((cost: any) => cost.refundGranted === false));
        const unauthorized = await control(actors.finance, 'snapshot', { sessionId: openB.sessionId });
        assert([401, 403, 404].includes(unauthorized.status), JSON.stringify(unauthorized));
        const after = (await admin.query('SELECT reservation_id,revision,status,envelopes FROM finnor_os.s5_reservations WHERE tenant_id=$1 ORDER BY reservation_id',
          [f.tenant])).rows;
        assert.deepEqual(after, reservations);
        const witness = { workerPid: worker!.pid, accepted, charged, principalLock: lock, actualBlockedSql: waits,
          revokedPrincipal: actors.finance, refused, unauthorized, originalReservationsRetained: after,
          noGrantRenewalOrReactivation: true, qualification: 'ACTUAL_NATIVE_PUBLICATION_RIGHTS_FENCE_NOT_WIRE_SPANNING_REVOCATION' };
        await artifact('physical-rights-revocation.json', witness); return witness;
      });
      await story('E-natural-delegation-and-role-expiry', async () => {
        await sleep(Math.max(0, temporalExpiry.getTime() - Date.now() + 100));
        const expiredAgent = await control(actors.agent!, 'snapshot', { sessionId: openA.sessionId });
        const expiredRole = await control(actors.temporal, 'snapshot', { sessionId: openA.sessionId });
        assert([401, 403, 404].includes(expiredAgent.status), JSON.stringify(expiredAgent));
        assert([401, 403, 404].includes(expiredRole.status), JSON.stringify(expiredRole));
        const original = (await admin.query(`SELECT d.completion_deadline,a.expires_at FROM finnor_os.delegations d
          JOIN finnor_os.employee_role_assignments a ON a.id=$2 WHERE d.id=$1`, [delegationId, assignments.get('temporal')])).rows[0];
        assert.equal(original.completion_deadline.toISOString(), temporalExpiry.toISOString());
        assert.equal(original.expires_at.toISOString(), temporalExpiry.toISOString());
        return { originalDeadlines: original, observedAt: new Date().toISOString(), expiredAgent, expiredRole, noFixtureExpiryUpdate: true };
      });
    }
    if (c.selected !== 'mounted') await story('F-sign-out-tombstone-not-cancellation', async () => {
      const ended = ok(await control(actors.partner, 'end-delivery', {}));
      const old = await control(actors.partner, 'open', { workId: openA.workId, root, focus: openA.focus });
      assert.equal(old.status, 401); assert.equal(ended.effectsCancelled, false);
      const retained = (await admin.query('SELECT count(*)::int n FROM finnor_os.s5_reservations WHERE tenant_id=$1 AND status<>\'RELEASED\'', [f.tenant])).rows[0].n;
      assert(retained >= 2);
      return { oldDeliveryRefused: old.status, effectsCancelled: false, retainedNativeReservations: retained };
    });
    await artifact('owner-final.json', { actors, tenant: f.tenant, sharedRoot: root, workA: openA.workId, workB: openB.workId,
      branchA: branchA.branchId, branchB: branchB.branchId, proposals: [proposalA.proposalId, proposalB.proposalId],
      traffic: http.traffic, workerPid: worker.pid, measuredOnly: 'DEVELOPMENT_NATIVE_OWNER_BOUNDARIES_NOT_MOUNTED_OR_PROTECTED' });
    if (c.selected === 'mounted') {
      assert(!process.exitCode, 'MOUNTED_PROOF_NOT_RUN_AFTER_OWNER_PREREQUISITE_FAILURE');
      const { mountedCampaign } = await import('./mounted-campaign.mts');
      await mountedCampaign({ ...c, http, actors, root, openA, openB, branchA, branchB });
    }
  } finally {
    await artifact('queue-and-evaluation-final.json', {
      physicalWorker: worker ? { pid: worker.pid, exitCode: worker.exitCode, signalCode: worker.signalCode } : null,
      computePlane: (await admin.query('SELECT * FROM finnor_os.compute_plane_cutover')).rows,
      evaluations: (await admin.query('SELECT id,status,job_id,updated_at FROM finnor_os.v5_evaluations ORDER BY created_at')).rows,
      jobs: (await admin.query(`SELECT id,type,status,workload_class,protocol_version,retry_safety,attempts,
        claim_fence,lease_owner,lease_expires_at,last_error FROM finnor_os.jobs ORDER BY accepted_at LIMIT 128`)).rows,
      waits: (await admin.query(`SELECT pid,state,wait_event_type,wait_event,pg_blocking_pids(pid) blockers
        FROM pg_stat_activity WHERE datname=current_database()`)).rows,
    });
    await artifact('owner-http-observations.json', http.traffic);
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(yes => {
        const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
        child.once('exit', () => { clearTimeout(deadline); yes(); });
        child.kill('SIGTERM');
      });
    }
    await artifact('owned-worker-shutdown.json', children.map(child => ({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode })));
    await http.close(); await closePool();
  }
}
