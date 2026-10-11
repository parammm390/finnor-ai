/** Registered, failure-first owner/HTTP/queue story. Synthetic preferences never
 * stand in for private truth, live acceptance, payment or independent admission. */
import { strict as assert } from 'node:assert';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, appendFile, readdir, rm } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { createUpstreamFixtureSupport } from '../s5/owner-fixture.mjs';
import { r3HttpFixture } from './http-fixture.mjs';
import { migrate } from '../../packages/db/migrate';
import { MIGRATIONS } from '../../packages/db/migrations-bundle';
import { closePool, receiveWork, beginWorkPlannerAttempt, persistSelectedWorkPlan, finishWorkPlannerAttempt, withTenantTransaction, getPool,
  createEmployeeConversationThread, updateEmployeeConversationThreadContext } from '@finnor/db';
import { createEvidenceSource, appendEvidenceVersion } from '@finnor/memory';
import { r3Digest } from '../../packages/epistemic-runtime/src/incentive-rule-synthesis/launcher';
import { r3Ref, r3PreparedExperienceEvent } from '../../packages/private-equity/src/r3/store';
import { createWorker } from '../../apps/worker/src/index';
import { R3WorkReviewSchema } from '../../packages/epistemic-runtime/src/incentive-rule-synthesis/output-contracts';
import { POST as interventionsPost } from '../../apps/api/app/api/interventions/[operation]/route';
import { POST as policiesPost } from '../../apps/api/app/api/policies/[operation]/route';
import { POST as obligationsPost } from '../../apps/api/app/api/obligations/[operation]/route';

const repo = resolve(import.meta.dirname, '../../..'), output = process.env.FINNOR_R3_EVIDENCE_DIR!;
await mkdir(output, { recursive: true });
const cases: any[] = [], fixtures: Record<string, any> = {}, children = new Set<ChildProcess>(), startedAt = new Date().toISOString();
const workCounts: Record<string, number> = {};
const administrativeFailures: unknown[] = [];
function observeAdmin(client: pg.Client) {
  client.on('error', error => {
    const observed = failureDetails(error); administrativeFailures.push(observed);
    void artifact('postgres/admin-error-' + Date.now() + '.json', observed).catch(() => undefined);
  });
  return client;
}
const selected = process.env.FINNOR_R3_CASES?.split(','), hash = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const q = (n = 0, d = 1) => ({ numerator: String(n), denominator: String(d) });
const sleep = (n: number) => new Promise<void>(r => setTimeout(r, n));
const ref = (owner: string, name: string) => ({ owner, id: name, version: 'r3-disposable-declared-v1', contentDigest: hash(name) });
async function artifact(name: string, body: unknown) { const p = join(output, name); await mkdir(dirname(p), { recursive: true }); await writeFile(p, JSON.stringify(body, null, 2) + '\n'); return p }
function failureDetails(error: unknown) {
  const causes: any[] = [];
  for (let e: any = error; e && causes.length < 8; e = e.cause)
    causes.push({ message: String(e.message ?? e), code: e.code ?? null, detail: e.detail ?? null, where: e.where ?? null, constraint: e.constraint ?? null });
  return { message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : null, causes };
}
async function save() { await artifact('results.json', { schema: 'finnor.r3.owner-e2e.v1', startedAt, finishedAt: new Date().toISOString(), cases,
  sourceCut: 'source-cut.json', rerun: 'python3 finnor-os/scripts/r3/run-local.py', qualification: 'SYNTHETIC_ORIGINALS_REAL_HTTP_AUTH_SQL_WORKER_ORDINARY_OWNERS',
  protectedAgreement: false, protectedEffect: false, usd: null, aggregateMemory: null }) }
async function story(id: string, fn: () => Promise<unknown>) {
  if (selected && !selected.includes(id) && id !== 'base-local-migration-upgrade-restart') return;
  const start = performance.now();
  try {
    const observed = await fn();
    assert.equal(administrativeFailures.length, 0, 'R3_UNEXPECTED_DISPOSABLE_ADMIN_CONNECTION_FAILURE');
    cases.push({ id, status: 'PASS', observed, elapsedMs: performance.now() - start });
  }
  catch (e) { cases.push({ id, status: 'FAIL', error: failureDetails(e), elapsedMs: performance.now() - start }); await save(); throw e }
  console.log(JSON.stringify({ id, status: cases.at(-1).status })); await save();
}
const files: Array<{ path: string; sha256: string }> = [];
async function scan(path: string) {
  for (const e of await readdir(join(repo, path), { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path + '/' + e.name;
    if (e.isDirectory()) await scan(p); else if (/\.(?:ts|tsx|mts|py|json|sql|lock)$/.test(p)) files.push({ path: p, sha256: hash(await readFile(join(repo, p))) });
  }
}
for (const p of ['finnor-os/packages', 'finnor-os/scripts/r3', 'finnor-os/apps/worker/src',
  ...['elicitation-protocols', 'interventions', 'policies', 'allocations', 'obligations'].map(name => 'finnor-os/apps/api/app/api/' + name)]) await scan(p);
for (const p of ['finnor-os/package-lock.json', 'package-lock.json', 'src/components/centropy/canvas/ElicitationProtocolReview.tsx',
  'src/components/centropy/canvas/elicitation-protocol-view.ts', 'src/components/centropy/canvas/CapitalProgramPanel.tsx',
  'scope-r/r3-incentive-rule-synthesis/verification-plan.json']) files.push({ path: p, sha256: hash(await readFile(join(repo, p))) });
await artifact('source-cut.json', { files, digest: r3Digest(files), node: process.version, base: '517003a4396bc8101a90be4b425ee01de9446740',
  nativeManifestDigest: hash(await readFile(process.env.FINNOR_R3_RUNTIME_MANIFEST!)), exactMode: 'NOT_AVAILABLE_FLOAT64_PROPOSALS_ONLY' });
const port = await new Promise<number>((yes, no) => {
  const s = createServer(); s.once('error', no); s.listen(0, '127.0.0.1', () => { const a = s.address(); if (!a || typeof a === 'string') return no(Error('PORT')); s.close(() => yes(a.port)) });
});
const scratch = process.env.FINNOR_R3_SCRATCH ?? join(repo, '.r3-scratch');
await mkdir(scratch, { recursive: true });
const dir = await mkdtemp(join(scratch, 'r3-postgres-'));
const postgres = new EmbeddedPostgres({ databaseDir: dir, user: 'finnor', password: 'finnor', port, persistent: true, onLog: line => { void appendFile(join(output, 'postgres-process.log'), String(line) + '\n').catch(() => undefined) } });
let admin: pg.Client, http: Awaited<ReturnType<typeof r3HttpFixture>>, primary: any, workerUrl = '';
function successful(r: any) { assert.equal(r.status, 200, JSON.stringify(r)); return r.body }
async function reviewProposedUse(f: any, requestId: string, reason: string) {
  const before = (await admin.query('SELECT deadline_at FROM finnor_os.r3_requests WHERE id=$1', [requestId])).rows[0];
  const stages: any[] = [];
  for (const operation of ['review', 'reserve', 'schedules']) {
    const input = operation === 'review' ? { requestId, decision: 'PROPOSE_USE', reason } : { requestId };
    const response = await http.call(f.principal, 'elicitation-protocols', operation, input);
    stages.push({ operation, input, response }); await artifact('review-stages/' + requestId + '.json', { before, stages });
    const result = successful(response);
    if (operation === 'review') {
      assert.equal(result.schema, 'finnor.r3.review-stage.v2'); assert.equal(result.requestId, requestId);
      assert.equal(result.status, 'S4_REVIEWED_OWNER_CONTINUATION_REQUIRED'); assert.equal(result.resourcesReservedByThisStage, false);
    }
    if (operation === 'reserve') { assert.equal(result.status, 'FEASIBLE'); assert(result.reservation) }
    if (operation === 'schedules') {
      assert.equal(result.schema, 'finnor.r3.schedule-stage.v1'); assert.equal(result.requestId, requestId);
      assert.deepEqual(result.operationPacket.schedulesRef, result.schedules.ref);
    }
  }
  const after = (await admin.query('SELECT deadline_at,use_policy_ref,allocation_ref,schedules_ref FROM finnor_os.r3_requests WHERE id=$1', [requestId])).rows[0];
  assert.deepEqual(after.deadline_at, before.deadline_at);
  const [review, allocation, prepared] = stages.map(s => s.response.body);
  assert.deepEqual(after.use_policy_ref, review.usePolicyRef); assert.deepEqual(after.allocation_ref, allocation.certificate.ref);
  assert.deepEqual(after.schedules_ref, prepared.schedules.ref);
  await artifact('review-stages/' + requestId + '.json', { before, after, stages, originalDeadlineRetained: true, noEffectAuthority: true });
  return { ...review, allocation, ...prepared, usePolicyRef: review.usePolicyRef };
}
async function api(f: any, operation: string, body: unknown, handler?: unknown) {
  const family = handler === interventionsPost ? 'interventions' :
    handler === policiesPost ? 'policies' : handler === obligationsPost ? 'obligations' : 'allocations';
  return http.call(f.principal, family, operation, body);
}
async function source(f: any, name: string, body: unknown, prior?: string, kind = 'R3_SUPPLIED_HYPOTHESIS') {
  const id = prior ?? (await createEvidenceSource(f.tenant, { sourceKey: 'r3:' + name + ':' + randomUUID(), sourceType: 'manual', title: name })).id;
  // Existing S1 lexical chunks have a hard storage bound. Whitespace gives
  // this complete structured declaration lawful chunks, without truncating it.
  const v = await appendEvidenceVersion(f.tenant, id, { content: JSON.stringify(body, null, 2), snapshot: { worldRoot: f.root, r3Kind: kind }, asOf: new Date() });
  return { sourceId: id, versionId: v.versionId, contentDigest: v.contentHash };
}
async function ensureReporters(f: any) {
  if (f.reportingPrincipalIds) return f.reportingPrincipalIds as string[];
  const principals = [f.principal];
  for (let i = 1; i < 4; i++) {
    const id = randomUUID();
    await admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')", [id, f.tenant, id + '@r3.test.invalid']);
    await http.register(id); principals.push(id);
  }
  f.reportingPrincipalIds = principals;
  return principals;
}
async function makeWork(f: any, name: string) {
  const work = await receiveWork({ tenantId: f.tenant, channel: 'text', instruction: 'Review supplied finite commercial mechanism ' + name,
    userId: f.principal, idempotencyKey: 'r3-work:' + randomUUID(), activeContext: { focusedEntity: f.root } });
  const attempt = await beginWorkPlannerAttempt({ tenantId: f.tenant, workId: work.workId, workInputId: work.workInputId, attemptKey: randomUUID() });
  const graphBody = { version: 1, schema: 'r3-disposable-owner-selected-plan.v1', nodes: [{ id: 'review-supplied-rule', kind: 'query', semanticHash: 'sha256:' + hash(name) }], edges: [] };
  const graph = { ...graphBody, semanticHash: 'sha256:' + hash(JSON.stringify(graphBody)) };
  const plan = await persistSelectedWorkPlan({ tenantId: f.tenant, workId: work.workId, workInputId: work.workInputId,
    plannerAttemptId: attempt.id, reason: 'initial', goalSpec: { version: 1, semanticHash: 'sha256:' + hash('goal:' + name), purpose: 'Owner supplied finite proposal review' },
    constraintSet: { version: 1, semanticHash: 'sha256:' + hash('constraints:' + name), noEffects: true }, planningSnapshot: { version: 1, semanticHash: 'sha256:' + hash('snapshot:' + name) },
    candidatePlans: [graph], compilationResult: { version: 1, selected: graph, sourceStanding: 'DISPOSABLE_OWNER_SELECTION_NOT_GENERATED_TRUTH' },
    planGraph: graph, score: { qualification: 'OWNER_SUPPLIED_NOT_OPTIMIZATION_PROOF' }, semanticHash: graph.semanticHash, compilerVersion: 'r3-disposable-plan-v1' });
  await finishWorkPlannerAttempt({ tenantId: f.tenant, attemptId: attempt.id, status: 'succeeded' });
  return { work, plan };
}
async function declaration(f: any, work: any, name: string, mutation?: (p: any) => void) {
  const generated = spawnSync(process.env.FINNOR_S3_PYTHON!, ['-I', '-c', 'import sys,json;sys.path.insert(0,sys.argv[1]);from fixtures import fixture;print(json.dumps(fixture()))',
    join(repo, 'finnor-os/scripts/r3')], { encoding: 'utf8', env: process.env });
  assert.equal(generated.status, 0, generated.stderr); const p = JSON.parse(generated.stdout);
  delete p.binding; delete p.resources; delete p.covenants; delete p.mandateLimits; delete p.schema;
  const h = f.mandate.horizon, length = h.periods + 1;
  p.money.ownerId = f.principal; p.money.valuationDate = h.startAt; p.money.ownerPeriodMultipliers = Array(length).fill(q(1));
  p.objective.minimumValue = q(f.mandate.risk.minimumUtility); p.objective.normalization = q(f.mandate.scoring.normalization);
  p.dates[0].at = h.startAt; p.objective.range = [q(-2000), q(2000)];
  for (const outcome of p.outcomes) {
    outcome.demands = { cash: Array(length).fill(q()), capacity: [q(outcome.id === 'wait' ? 0 : 1), ...Array(length - 1).fill(q())], compute: Array(length).fill(q()) };
    outcome.costs = Array(length).fill(q()); outcome.liabilities = Array(length).fill(q());
  }
  const principals = await ensureReporters(f);
  for (let i = 0; i < 4; i++) {
    const party = p.parties[i], entity = randomUUID();
    await admin.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,$4,'other')",
      [entity, f.tenant, name.toLowerCase() + '-party-' + i, name + '-party-' + i]);
    party.entityId = entity; party.reportingPrincipalId = principals[i]; party.rightsRef = f.mandate.rightsRef;
  }
  mutation?.(p);
  for (const party of p.parties) {
    const { sourceRef: _source, assumptionRef: _assumption, rightsRef: _rights, ...meaning } = party;
    const original = await source(f, name + '-' + party.id, { schema: 'finnor.r3.party-preference.v1', party: meaning });
    party.sourceRef = { owner: 'S1', id: original.versionId, version: 'evidence-source-version-v1', contentDigest: original.contentDigest };
  }
  const body = { ...p, schema: 'finnor.r3.preference-declaration.v1', workId: work.workId, workRevision: work.workInputId,
    root: f.root, mandateRef: f.policies[0].mandateRef, domainRef: ref('S3', 'r3-hypothetical-quasilinear-four-party'),
    paymentContractRef: p.dates[0].contractRef, rightsRef: f.mandate.rightsRef, asOf: new Date().toISOString(), validUntil: f.mandate.validUntil,
    provenance: 'OWNER_SUPPLIED_PREFERENCE_HYPOTHESIS_NOT_OBSERVED_PRIVATE_TRUTH', behavioralQualification: 'UNQUALIFIED', permittedReporting: 'EXACT_DECLARED_PRINCIPALS_ONLY' };
  const original = await source(f, name + '-declaration', body, undefined, 'PREFERENCE_DECLARATION');
  return { body, original, principals };
}
async function submit(f: any, name: string, mutation?: (p: any) => void) {
  const selectedWork = f.preparedWorks?.shift() ?? await makeWork(f, name), supplied = await declaration(f, selectedWork.work, name, mutation);
  const programTarget = name === 'positive' ? await publishedProgramTarget(f, selectedWork.work.workId) : undefined;
  const input = { envelope_inputs: { mode: 'ordinary_disposable' as const }, problem_ref: supplied.original,
    existing_work_revision: { workId: selectedWork.work.workId, revision: selectedWork.work.workInputId, root: f.root },
    domain_profile_ref: supplied.body.domainRef, budget_grant_ref: f.grant.certificate.ref, cancellation_ref: 'r3-cancel:' + name,
    incumbentPolicyRef: f.policies[0].ref, ...(programTarget ? { programTarget } : {}),
    idempotencyKey: randomUUID(), limits: { deadlineAt: new Date(Date.now() + 600000).toISOString(), maxAttempts: 8, childSeconds: 25 } };
  await artifact(name + '/original-submission.json', { selectedWork, supplied, input });
  const { resolveDecisionWork } = await import('../../packages/private-equity/src/decision-slice/adapters');
  const { readSourceObject } = await import('../../packages/private-equity/src/deliberation/store');
  const { validateEnterpriseContingentPolicy } = await import('../../packages/private-equity/src/enterprise-control');
  const { resolveR3ProgramTarget } = await import('../../packages/private-equity/src/r3/program-target');
  const { resolveR3Owners } = await import('../../packages/private-equity/src/r3/owners');
  const preflight: any[] = [];
  for (const [boundary, fn] of [
    ['EXISTING_WORK', () => resolveDecisionWork(f.ctx, selectedWork.work.workId)],
    ['ORIGINAL_PERMISSIONED_DECLARATION', () => readSourceObject(f.ctx, f.root, supplied.original.sourceId, supplied.original.versionId)],
    ['ORIGINAL_S4_CURRENTNESS', () => validateEnterpriseContingentPolicy(f.ctx, f.policies[0].ref)],
    ...(programTarget ? [['ORIGINAL_M3_TARGET', async () => resolveR3ProgramTarget(f.ctx, programTarget,
      await resolveDecisionWork(f.ctx, selectedWork.work.workId), f.policies[0].ref)] as [string, () => Promise<any>]] : []),
    ...(programTarget ? [['ORIGINAL_R3_OWNER_BINDING', () => resolveR3Owners(f.ctx, input)] as [string, () => Promise<any>]] : []),
  ] as Array<[string, () => Promise<any>]>) {
    try { const value = await fn(); preflight.push({ boundary, status: 'READ', value }); }
    catch (error) { preflight.push({ boundary, status: 'REFUSED', error: failureDetails(error) }); }
  }
  await artifact(name + '/owner-preflight.json', preflight);
  if (programTarget) {
    const wrongTarget = await http.call(f.principal, 'elicitation-protocols', 'submit', {
      ...input, idempotencyKey: randomUUID(), programTarget: { ...programTarget, candidateDigest: '0'.repeat(64) } });
    assert.equal(wrongTarget.status, 409, JSON.stringify(wrongTarget));
    assert.equal(wrongTarget.body.code, 'R3_ACTUAL_CURRENT_M3_CANDIDATE_AND_S4_POLICY_REQUIRED');
    await artifact('positive/mismatched-programme-target-refused.json', wrongTarget);
  }
  const result = successful(await http.call(f.principal, 'elicitation-protocols', 'submit', input));
  await artifact(name + '/input.json', { selectedWork, supplied, input, result });
  return { f, ...selectedWork, ...supplied, input, requestId: result.requestId };
}
async function publishedProgramTarget(f: any, workId: string) {
  const input = { schema: 'finnor.capital-program-request.v2', workId, idempotencyKey: randomUUID(),
    incumbentPolicyRef: f.policies[0].ref, purpose: 'COMMERCIAL',
    permitted: { actionId: 'programme-grant', exposureId: 'price', unit: 'fraction', terms: ['0.15'],
      startPeriods: [0], structures: ['IMMEDIATE'], stageFractions: [],
      resourceRule: 'SCALE_REGISTERED_ACTION_LINEAR', agreement: 'COUNTERPARTY_REQUIRED' },
    resource: { deadlineMs: 30000, maxAttempts: 8, maxGenerated: 8, maxExpansions: 50000,
      maxRefinementSteps: 4096, maxRefinementDepth: 6, maxModuleBytes: 65536, maxResultBytes: 8388608 } };
  const accepted = await http.call(f.principal, 'company-brain', 'capital-program-submit', input);
  assert.equal(accepted.status, 202, JSON.stringify(accepted));
  const apiUrl = process.env.DATABASE_URL;
  let current: any;
  try {
    const worker = createWorker();
    current = await waitFor(async () => {
      process.env.DATABASE_URL = workerUrl; await closePool();
      try { await worker.tick() } finally { await closePool(); process.env.DATABASE_URL = apiUrl }
      return successful(await http.call(f.principal, 'company-brain', 'capital-program-read',
        { queryId: accepted.body.queryId }));
    }, value => !['QUEUED', 'RUNNING'].includes(value.status));
  } finally { await closePool(); process.env.DATABASE_URL = apiUrl }
  await artifact('positive/original-m3-publication.json', { input, accepted, current });
  assert(current.program, JSON.stringify(current));
  const candidate = current.program.candidates.find((c: any) => c.structure === 'INCUMBENT' && c.finitePolicyComplete);
  assert(candidate && candidate.policyRef, JSON.stringify(current));
  const target = { grammar: 'r3-m3-report-extension-v1' as const, queryId: current.queryId,
    programRef: current.program.ref, candidateDigest: candidate.semanticDigest, policyRef: candidate.policyRef };
  await artifact('positive/actual-m3-programme-target.json', { input, accepted, current, target,
    earlierR2CertificatesChanged: false, authorityGranted: false });
  return target;
}
async function runJob(requestId: string) {
  const apiUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = workerUrl; await closePool();
  try {
    const worker = createWorker(); assert(worker.registeredTypes().includes('run_incentive_rule_synthesis_v1'));
    // Observe ordinary capacity deferral and the unchanged 60-second native
    // lease after a killed worker. Do not reset the accepted R3 deadline.
    const observationUntil = Date.now() + 90000;
    while (Date.now() < observationUntil) {
      await worker.tick();
      const row = (await admin.query('SELECT status,failure FROM finnor_os.r3_requests WHERE id=$1', [requestId])).rows[0];
      if (!['QUEUED', 'RUNNING'].includes(row.status)) return row;
      await sleep(200);
    }
    throw Error('R3_REGISTERED_WORKER_DID_NOT_COMPLETE');
  } finally { await closePool(); process.env.DATABASE_URL = apiUrl }
}
async function startWorker(seconds = 120) {
  const logs = join(output, 'physical-worker-' + randomUUID() + '.log');
  const child = spawn(process.execPath, ['--import=tsx', join(repo, 'finnor-os/scripts/r3/worker-child.mts'), String(seconds)], {
    cwd: join(repo, 'finnor-os'), env: { ...process.env, DATABASE_URL: workerUrl }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.stdout!.on('data', b => void appendFile(logs, b)); child.stderr!.on('data', b => void appendFile(logs, b));
  return { child, logs };
}
async function stopWorker(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((yes, no) => {
    const timer = setTimeout(() => no(Error('R3_PHYSICAL_WORKER_REAP_TIMEOUT')), 10000);
    child.once('exit', () => { clearTimeout(timer); yes() }); child.kill(signal);
  });
  children.delete(child);
}
async function waitFor<T>(read: () => Promise<T>, accepted: (value: T) => boolean, seconds = 40): Promise<T> {
  const until = Date.now() + seconds * 1000;
  for (;;) { const value = await read(); if (accepted(value)) return value; assert(Date.now() < until, 'R3_BOUNDED_OBSERVATION_NOT_REACHED'); await sleep(25) }
}
async function readback(item: any) {
  return withTenantTransaction(item.f.tenant, { userId: item.f.principal, readOnly: true }, async (_db, c) => ({
    role: (await c.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0],
    request: (await c.query('SELECT * FROM finnor_os.r3_requests WHERE id=$1', [item.requestId])).rows[0],
    attempts: (await c.query('SELECT * FROM finnor_os.r3_attempts WHERE request_id=$1 ORDER BY created_at', [item.requestId])).rows,
    jobs: (await c.query("SELECT id,type,status,claim_fence,protocol_version,attempts,payload FROM finnor_os.jobs WHERE payload->>'requestId'=$1", [item.requestId])).rows,
    events: (await c.query('SELECT event_id,kind,body FROM finnor_os.r3_events WHERE request_id=$1 ORDER BY created_at', [item.requestId])).rows,
    reservations: (await c.query('SELECT reservation_id,status,envelopes,revision FROM finnor_os.s5_reservations')).rows,
    usage: (await c.query('SELECT * FROM finnor_os.p2_grant_usage')).rows,
  }));
}
async function report(item: any, i: number, typeId: string, replacesEventId: string | null = null) {
  return successful(await http.call(item.principals[i], 'elicitation-protocols', 'report', {
    requestId: item.requestId, partyId: 'party-' + i, typeId, replacesEventId, idempotencyKey: randomUUID(),
  }));
}
async function observe(item: any, i: number, kind: 'DECLINE' | 'NO_RESPONSE' | 'OBSERVED_ACCEPTANCE' | 'OUT_OF_DOMAIN', closed?: any, extra = {}) {
  const protocol = item.review.protocol, selected = closed ? protocol.rule.table.find((r: any) => r.reports.every((t: string, j: number) => t === closed.reports[j])) : null;
  const observed = { schema: 'finnor.r3.observed-party-event.v1', protocolRef: protocol.ref, partyId: 'party-' + i, kind,
    attestingPrincipalId: item.principals[i], observerPrincipalId: item.principals[i], observedAt: new Date().toISOString(),
    reportEventId: closed?.reportEventIds['party-' + i] ?? null,
    outcomeId: kind === 'OBSERVED_ACCEPTANCE' ? selected?.outcomeId ?? null : null,
    scheduleDigest: kind === 'OBSERVED_ACCEPTANCE' ? r3Digest(selected?.schedule ?? null) : null,
    domainRef: protocol.problem.binding.domainRef, basis: 'DISPOSABLE_OBSERVED_DECLARATION_NOT_PROTECTED_AGREEMENT',
    executionAuthorityGranted: false, ...extra };
  const original = await source(item.f, item.requestId + '-observation-' + randomUUID(), observed, undefined, 'SEPARATE_DISPOSABLE_PARTY_OBSERVATION');
  const input = { requestId: item.requestId, partyId: 'party-' + i, kind, observation: original, idempotencyKey: randomUUID() };
  const result = await http.call(item.principals[i], 'elicitation-protocols', 'event', input);
  return { observed, original, input, result };
}
try {
  process.env.NODE_ENV = 'test'; process.env.FINNOR_TEST_MANAGED_EXTENSIONS = 'omit';
  await postgres.initialise(); await appendFile(join(dir, 'postgresql.conf'), '\ntrack_commit_timestamp=on\n');
  await postgres.start(); await postgres.createDatabase('r3_e2e');
  const url = `postgres://finnor:finnor@127.0.0.1:${port}/r3_e2e`;
  admin = observeAdmin(new pg.Client({ connectionString: url })); await admin.connect();
  await story('base-local-migration-upgrade-restart', async () => {
    const initial = await migrate(url, MIGRATIONS.filter(m => m.name < '0172'));
    const before = (await admin.query('SELECT name FROM finnor_os._migrations ORDER BY name')).rows;
    assert.equal(before.at(-1).name, '0171_runtime_database_role_isolation.sql');
    const applied = await migrate(url, MIGRATIONS), replay = await migrate(url, MIGRATIONS);
    assert.deepEqual(applied, ['0172_r3_incentive_rule_synthesis.sql']); assert.deepEqual(replay, []);
    await postgres.createDatabase('r3_fresh');
    const fresh = await migrate(url.replace(/r3_e2e$/, 'r3_fresh'), MIGRATIONS);
    assert.equal(fresh.length, MIGRATIONS.length);
    const beforeStart = (await admin.query('SELECT pg_postmaster_start_time() started')).rows[0].started;
    await admin.end(); await postgres.stop(); await postgres.start();
    admin = observeAdmin(new pg.Client({ connectionString: url })); await admin.connect();
    const afterStart = (await admin.query('SELECT pg_postmaster_start_time() started')).rows[0].started;
    assert(afterStart.getTime() > beforeStart.getTime());
    const restartReplay = await migrate(url, MIGRATIONS); assert.deepEqual(restartReplay, []);
    return { initial, before, applied, replay, fresh, physicalRestart: { beforeStart, afterStart, sameDataDirectory: dir },
      restartReplay, actualCatalog: (await admin.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace='finnor_os'::regnamespace AND relname LIKE 'r3_%' AND relkind='r' ORDER BY relname")).rows };
  });
  await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'; ALTER ROLE finnor_worker LOGIN PASSWORD 'finnor_worker'");
  await admin.query("SET app.test_vertical_mode='explicit'");
  // Fixture-only SQL publication gate. Its schema is installed before any
  // owner pin. No fault branch or sleep is added to the product worker.
  await admin.query(`CREATE TABLE finnor_os.r3_e2e_publication_gates(request_id uuid PRIMARY KEY,gate integer NOT NULL);
    CREATE FUNCTION finnor_os.r3_e2e_publication_gate() RETURNS trigger LANGUAGE plpgsql
    SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
    DECLARE g integer; BEGIN
      IF NEW.object_id LIKE 'elicitation-protocol:%' THEN
        SELECT gate INTO g FROM finnor_os.r3_e2e_publication_gates WHERE request_id=NEW.request_id;
        IF g IS NOT NULL THEN PERFORM pg_advisory_xact_lock(773399,g); END IF;
      END IF; RETURN NEW;
    END $$;
    CREATE TRIGGER r3_e2e_publication_gate BEFORE INSERT ON finnor_os.r3_objects FOR EACH ROW
      EXECUTE FUNCTION finnor_os.r3_e2e_publication_gate()`);
  workerUrl = `postgres://finnor_worker:finnor_worker@127.0.0.1:${port}/r3_e2e`;
  process.env.DATABASE_URL = `postgres://finnor_app:finnor_app@127.0.0.1:${port}/r3_e2e`; await closePool();
  process.env.FINNOR_M3_PROFILE = 'DISPOSABLE_NATIVE';
  process.env.FINNOR_M1_PROFILE = 'DISPOSABLE_NATIVE';
  process.env.FINNOR_M3_STORE = join(dir, 'm3-private');
  process.env.FINNOR_M1_STORE = join(dir, 'm1-private');
  await mkdir(process.env.FINNOR_M3_STORE, { mode: 0o700 });
  await mkdir(process.env.FINNOR_M1_STORE, { mode: 0o700 });
  http = await r3HttpFixture(admin);
  // The unchanged numeric owner has a strict 20-second child floor. Account
  // explicitly for cold scientific loading before its request, never extend
  // that request or an accepted R3 episode to hide installation/cache costs.
  const prepStarted = performance.now(), prep = spawnSync(process.env.FINNOR_S3_PYTHON!, ['-I', '-c',
    'import time,resource,json;start=time.monotonic();import numpy,scipy,statsmodels.api,arch;r=resource.getrusage(resource.RUSAGE_SELF);print(json.dumps({"elapsedSeconds":time.monotonic()-start,"peakRssBytes":r.ru_maxrss,"cpuUserSeconds":r.ru_utime,"cpuSystemSeconds":r.ru_stime}))'],
    { timeout: 60000, encoding: 'utf8', env: { PATH: process.env.PATH, NODE_ENV: 'test', PYTHONDONTWRITEBYTECODE: '1',
      OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1', LC_ALL: 'C' } });
  await artifact('upstream-preparation.json', { command: 'isolated pinned numpy/scipy/statsmodels/arch import', status: prep.status,
    elapsedMs: performance.now() - prepStarted, stdout: prep.stdout, stderr: prep.stderr, signal: prep.signal,
    lockDigest: hash(await readFile(join(repo, 'finnor-os/scripts/r3/upstream-requirements.lock'))),
    accounting: 'SEPARATE_UPSTREAM_OWNER_PREPARATION_INCLUDED_NOT_FREE_R3_WORK', usd: null,
    previousColdImportFailure: 'owner-2026-10-09T21-55-41', originalOwnerTimeoutMs: 20000 });
  assert.equal(prep.status, 0, prep.stderr);
  const day = 86400000, begin = new Date(Math.floor(Date.now() / day) * day - 128 * day).toISOString();
  const generated = spawnSync(process.env.FINNOR_S3_PYTHON!, [join(repo, 'finnor-os/scripts/s3/reference.py')], { input: '{"operation":"equivalent"}', encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const upstream = createUpstreamFixtureSupport({ admin: () => admin, generatedRows: JSON.parse(generated.stdout).rows, begin, day, fixtures,
    api: async (f: any, op: string, body: unknown, handler?: unknown) => {
      // New canonical users revise real authority. Provision the supplied
      // reporting actors before S3/S4 pins, rather than waive stale pin checks.
      if (op === 'fit') {
        await ensureReporters(f);
        if (f.name === 'r3-browser') {
          const { createDeal } = await import('@finnor/private-equity');
          const deal = await createDeal(f.ctx, { targetOrganizationId: f.root.entityId,
            name: 'Disposable finite mechanism review', dealLeadEmployeeId: f.principal,
            signedLoiAt: new Date(Date.now() - day), targetClosingAt: new Date(Date.now() + day) });
          f.canvasRoot = { entityType: 'pe_deal', entityId: String(deal.row.id) };
          await artifact('browser/original-linked-deal.json', { deal, companyRoot: f.root, canvasRoot: f.canvasRoot });
        }
        // Work/root history is part of S1's original model pin. Select the
        // authentic Work before fitting, not after issuing the policy/grant.
        f.preparedWorks = [];
        for (let i = 0; i < (workCounts[f.name] ?? 1); i++) f.preparedWorks.push(await makeWork(f, f.name + '-initial-' + i));
      }
      await http.register(f.principal); return api(f, op, body, handler);
    }, artifact });
  async function owner(name: string, grantUnits = 64, works = 1) {
    workCounts[name] = works;
    const f = await upstream.fixture(name, 1, [
      { id: 'cash', unit: 'USD', capacity: 100, totalLimit: 100 },
      { id: 'capacity', unit: 'unit', capacity: 1, totalLimit: 1 },
      { id: 'compute', unit: 'invocation', resourceClass: 'COMPUTE', capacity: 128, totalLimit: 128 },
    ]);
    await upstream.policy(f, 'grant', { compute: grantUnits });
    await upstream.resource(f, 'cash', 'USD', 'STOCK', ['100', '100']);
    await upstream.resource(f, 'capacity', 'unit', 'OCCUPANCY', ['1', '1']);
    await upstream.resource(f, 'compute', 'invocation', 'CUMULATIVE_EXPENDITURE', ['128', '128']);
    f.grant = successful(await api(f, 'clear', upstream.clearing(f, { grant: ['100'] })));
    assert.equal(f.grant.status, 'FEASIBLE', JSON.stringify(f.grant.reasons));
    return f;
  }
  await story('queued-original-and-r3-physical-restart', async () => {
    const f = await owner('r3-queued-restart'), item = await submit(f, 'queued-restart');
    const commit = process.env.FINNOR_R3_INSTALLED_SOURCE_COMMIT ??
      spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    assert(/^[0-9a-f]{40}$/.test(commit));
    process.env.FINNOR_COMMIT_SHA = commit;
    process.env.FINNOR_BUILD_ID = 'finnor-' + commit.slice(0, 12);
    process.env.FINNOR_VERSION = '0.1.0+' + commit.slice(0, 12);
    process.env.FINNOR_RELEASE_SOURCE = 'R3_DISPOSABLE_SOURCE_CUT_NOT_PROTECTED_RELEASE';
    const apiUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = workerUrl; await closePool();
    const queue = createWorker(), probeKey = 'r3-original-release-probe:' + randomUUID();
    await queue.enqueue('release_probe', { commitSha: commit }, probeKey);
    await closePool(); process.env.DATABASE_URL = apiUrl;
    const before = (await admin.query(`SELECT id,type,payload,protocol_version,status,attempts,run_at
      FROM finnor_os.jobs WHERE payload->>'requestId'=$1 OR idempotency_key=$2 ORDER BY id`, [item.requestId, probeKey])).rows;
    assert.equal(before.length, 2); assert(before.every(r => r.status === 'queued' && r.attempts === 0));
    const deadline = (await readback(item)).request.deadline_at;
    const beforeStart = (await admin.query('SELECT pg_postmaster_start_time() started')).rows[0].started;
    await http.close(); await closePool(); await admin.end(); await postgres.stop(); await postgres.start();
    admin = observeAdmin(new pg.Client({ connectionString: url })); await admin.connect();
    const afterStart = (await admin.query('SELECT pg_postmaster_start_time() started')).rows[0].started;
    assert(afterStart.getTime() > beforeStart.getTime());
    const after = (await admin.query(`SELECT id,type,payload,protocol_version,status,attempts,run_at
      FROM finnor_os.jobs WHERE payload->>'requestId'=$1 OR idempotency_key=$2 ORDER BY id`, [item.requestId, probeKey])).rows;
    assert.deepEqual(after, before);
    assert.deepEqual(await migrate(url, MIGRATIONS), []);
    http = await r3HttpFixture(admin);
    for (const actor of item.principals) await http.register(actor);
    assert.equal((await runJob(item.requestId)).status, 'COMPLETE');
    const originalJob = await waitFor(async () => {
      process.env.DATABASE_URL = workerUrl; await closePool();
      try { await createWorker().tick() } finally { await closePool(); process.env.DATABASE_URL = apiUrl }
      return (await admin.query('SELECT id,type,status,attempts,claim_fence,last_error FROM finnor_os.jobs WHERE idempotency_key=$1', [probeKey])).rows[0];
    }, row => row.status === 'completed');
    assert.equal(originalJob.attempts, 1); assert.equal(originalJob.last_error, null);
    const reviewed = successful(await http.call(f.principal, 'elicitation-protocols', 'read', { requestId: item.requestId }));
    R3WorkReviewSchema.parse(reviewed);
    const preserved = await readback(item); assert.deepEqual(preserved.request.deadline_at, deadline);
    assert.equal(preserved.attempts.length, 2);
    await artifact('queued-restart/boundaries.json', { before, after, beforeStart, afterStart, originalJob,
      reviewed, preserved, actualOriginalHandler: 'release_probe', sourceCut: 'source-cut.json',
      commitMetadataNotProtectedRelease: true });
    return { artifact: 'queued-restart/boundaries.json', originalAndR3Dispatched: true,
      sameDataDirectoryPhysicalRestart: true, originalGrantDeadlineRetained: true };
  });
  await story('authenticated-owner-positive', async () => {
    const f = await upstream.fixture('r3-positive', 1, [
      { id: 'cash', unit: 'USD', capacity: 100, totalLimit: 100 },
      { id: 'capacity', unit: 'unit', capacity: 1, totalLimit: 1 },
      { id: 'compute', unit: 'invocation', resourceClass: 'COMPUTE', capacity: 128, totalLimit: 128 },
    ]);
    // The real original numeric policy reserves the compute grant; it is not
    // an R3 mathematical prerequisite or a forged reservation.
    await upstream.policy(f, 'grant', { compute: 64 });
    await upstream.resource(f, 'cash', 'USD', 'STOCK', ['100', '100']);
    await upstream.resource(f, 'capacity', 'unit', 'OCCUPANCY', ['1', '1']);
    await upstream.resource(f, 'compute', 'invocation', 'CUMULATIVE_EXPENDITURE', ['128', '128']);
    f.grant = successful(await api(f, 'clear', upstream.clearing(f, { grant: ['100'] })));
    await artifact('positive/original-s5-grant.json', f.grant);
    assert.equal(f.grant.status, 'FEASIBLE', JSON.stringify(f.grant.reasons)); assert(f.grant.reservation);
    const item: any = await submit(f, 'positive'); primary = item;
    const anonymous = await http.call(null, 'elicitation-protocols', 'read', { requestId: item.requestId });
    const badSignature = await http.call(f.principal, 'elicitation-protocols', 'read', { requestId: item.requestId }, true);
    assert.equal(anonymous.status, 401); assert.equal(badSignature.status, 401);
    const partial = successful(await http.call(f.principal, 'elicitation-protocols', 'read', { requestId: item.requestId }));
    assert.equal(partial.provisional, true); assert.equal(partial.protocol, null);
    assert.equal((await runJob(item.requestId)).status, 'COMPLETE');
    const review = successful(await http.call(f.principal, 'elicitation-protocols', 'read', { requestId: item.requestId }));
    R3WorkReviewSchema.parse(review);
    assert.deepEqual(review.protocol.problem.binding.programTarget, item.input.programTarget);
    assert.deepEqual(review.protocol.rule.binding.programTarget, item.input.programTarget);
    assert.equal(review.protocol.check.accepted, true); assert.deepEqual(review.protocol.check.counts, { profiles: 81, deviations: 648, participation: 324 });
    assert(new Set(review.protocol.rule.table.map((r: any) => r.outcomeId)).size > 1); assert.equal(review.protocol.check.optimum, 'UNKNOWN');
    const ownerReview = await reviewProposedUse(f, item.requestId, 'Actual owner review of complete checked synthetic mechanism');
    assert.equal(ownerReview.allocation.status, 'FEASIBLE'); assert.equal(ownerReview.schedules.branches.length, 81);
    assert.deepEqual(ownerReview.operationPacket.schedulesRef, ownerReview.schedules.ref);
    assert.equal(ownerReview.schedules.branches.reduce((n: number, b: any) => n + b.obligations.length, 0), 324);
    const p = review.protocol.problem, finiteBody = { requestId: item.requestId, problem: p, behavioralQualification: 'UNQUALIFIED', sourceStandingNotPrivateTruth: true };
    const finite = successful(await http.call(f.principal, 'interventions', 'finite-preference', { modelRef: r3Ref('S3', 'r3-finite-model', finiteBody, 's3-finite-preference-v1') }));
    assert.equal(finite.behavioralQualification, 'UNQUALIFIED');
    const policy = successful(await http.call(f.principal, 'policies', 'read-mechanism', { policyRef: ownerReview.usePolicyRef }));
    assert.deepEqual(policy.protocol.rule.table, review.protocol.rule.table);
    const allocation = successful(await http.call(f.principal, 'allocations', 'read', { allocationRef: ownerReview.allocation.certificate.ref }));
    const validation = successful(await http.call(f.principal, 'allocations', 'validate', { allocationRef: allocation.certificate.ref }));
    assert.equal(validation.status, 'CURRENT');
    const choice = successful(await http.call(f.principal, 'policies', 'decide-mechanism', { policyRef: ownerReview.usePolicyRef }));
    assert.equal(choice.status, 'WAIT_REPORTS_OR_NO_AGREEMENT');
    const s6 = successful(await http.call(f.principal, 'obligations', 'prepare-elicitation', { requestId: item.requestId }));
    assert.equal(s6.semanticOwner, 'S6'); assert.equal(s6.schedules.branches.length, 81);
    assert.equal(s6.operationPacket.status, 'BLOCKED_EXTERNAL_PROTECTED_OPERATION_ADMISSION');
    assert.equal(s6.executionAuthorityGranted, false);
    item.review = review; item.ownerReview = ownerReview;
    const rows = await readback(item); assert.equal(rows.role.rolsuper, false); assert.equal(rows.role.rolbypassrls, false);
    assert.equal(rows.attempts.length, 2); assert(rows.attempts.every((a: any) => ['RETURNED', 'ACCEPTED'].includes(a.status)));
    assert.equal(rows.usage[0].spent, 2);
    await artifact('positive/boundaries.json', { anonymous, badSignature, partial, review, ownerReview, finite, policy, allocation, validation, choice, s6, rows, http: http.observed });
    return { artifact: 'positive/boundaries.json', coverage: review.protocol.check.counts, nontrivial: true, realAuthenticatedWorker: true, proposedSchedules: 324 };
  });
  await story('report-correction-close', async () => {
    const item = primary, before = r3Digest(item.review.protocol.rule), records = [];
    const impersonation = await http.call(item.f.principal, 'elicitation-protocols', 'report', {
      requestId: item.requestId, partyId: 'party-1', typeId: '2', replacesEventId: null, idempotencyKey: randomUUID() });
    assert.equal(impersonation.status, 403); assert.equal(impersonation.body.code, 'R3_ACTUAL_PARTY_REPORTING_PRINCIPAL_REQUIRED');
    const initial = await report(item, 0, '0'), correction = await report(item, 0, '2', initial.eventId);
    records.push(initial, correction);
    for (let i = 1; i < 4; i++) records.push(await report(item, i, '2'));
    const unreadable = await http.call(item.principals[1], 'elicitation-protocols', 'read', { requestId: item.requestId });
    assert.equal(unreadable.status, 404); // Reporting does not grant the owner's private whole-model view.
    const state = successful(await http.call(item.f.principal, 'elicitation-protocols', 'read', { requestId: item.requestId }));
    assert.equal(state.reportState.acceptanceComplete, false); assert.equal(state.agreementEstablished, false);
    const closed = successful(await http.call(item.f.principal, 'elicitation-protocols', 'close', { requestId: item.requestId }));
    assert.deepEqual(closed.reports, ['2', '2', '2', '2']); assert.equal(closed.noAgreement, false);
    const tooLate = await http.call(item.f.principal, 'elicitation-protocols', 'report', {
      requestId: item.requestId, partyId: 'party-0', typeId: '1', replacesEventId: correction.eventId, idempotencyKey: randomUUID() });
    assert.equal(tooLate.status, 409); assert.equal(tooLate.body.code, 'R3_CORRECTION_AFTER_CLOSURE_FORBIDDEN');
    assert.equal(r3Digest(state.protocol.rule), before);
    item.closed = closed;
    await artifact('reports/correction-close.json', { impersonation, records, unreadable, state, closed, tooLate, ruleDigest: before });
    return { artifact: 'reports/correction-close.json', authenticatedReportingPrincipals: 4, reportIsAgreement: false };
  });
  await story('separate-acceptance-exact-choice-consumption', async () => {
    const item = primary, input = { policyRef: item.ownerReview.usePolicyRef };
    const awaiting = successful(await http.call(item.f.principal, 'policies', 'decide-mechanism', input));
    assert.equal(awaiting.status, 'WAIT_SEPARATE_PARTY_ACCEPTANCE');
    const observations = [];
    for (let i = 0; i < 4; i++) {
      const observed = await observe(item, i, 'OBSERVED_ACCEPTANCE', item.closed);
      successful(observed.result); observations.push(observed);
    }
    const choice = successful(await http.call(item.f.principal, 'policies', 'decide-mechanism', input));
    assert.equal(choice.status, 'PROPOSED_CHECKED_MODEL_RELATIVE');
    const original = item.review.protocol.rule.table.find((r: any) => r.reports.every((t: string) => t === '2'));
    assert.deepEqual(choice.row, original); assert.equal(choice.agreementEstablished, false);
    const body = { requestId: item.requestId, idempotencyKey: 'r3-e2e-use:' + item.requestId };
    const use = successful(await http.call(item.f.principal, 'elicitation-protocols', 'use', body));
    const replay = successful(await http.call(item.f.principal, 'elicitation-protocols', 'use', body));
    assert.equal(use.status, 'INTENDED_PENDING_S6'); assert.equal(replay.semanticReplay, true);
    assert.deepEqual(use.consumption.envelope, item.ownerReview.allocation.reservation.envelopes);
    const rows = (await admin.query('SELECT co.body,st.status,st.effect_ref FROM finnor_os.s5_consumptions co JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id) WHERE co.tenant_id=$1 AND co.reservation_id=$2',
      [item.f.tenant, use.consumption.reservationRef.id])).rows;
    assert.equal(rows.length, 1); assert.equal(rows[0].effect_ref, null); assert.equal(rows[0].status, 'INTENDED_PENDING_S6');
    item.use = use;
    const s6 = successful(await http.call(item.f.principal, 'obligations', 'prepare-elicitation', {
      requestId: item.requestId, consumptionRef: use.consumption.ref }));
    assert.deepEqual(s6.selectedSchedule, original.schedule);
    assert.deepEqual(s6.consumptionRef, use.consumption.ref); assert.equal(s6.executionAuthorityGranted, false);
    await artifact('reports/acceptance-choice-use.json', { awaiting, observations, choice, use, replay, rows,
      s6, protectedAgreement: false, physicalPayment: false, fullContingentEnvelopeRetained: true });
    return { artifact: 'reports/acceptance-choice-use.json', exactRuleLookup: true, canonicalConsumptionCount: 1, consentQualification: 'DISPOSABLE_NOT_PROTECTED' };
  });
  await story('actual-fallback-matched-off-on', async () => {
    const item = primary, before = await readback(item), start = performance.now();
    const off = successful(await http.call(item.f.principal, 'elicitation-protocols', 'review', {
      requestId: item.requestId, decision: 'WAIT', reason: 'Preregistered current X native disposition under the same original envelope' }));
    assert(off.actualCalleeResult.ref); assert.equal(off.newEpisode, false); assert.equal(off.deadlineRenewed, false);
    assert.equal(off.inheritedTruthfulness, false);
    const after = await readback(item);
    assert.equal(after.usage[0].spent, before.usage[0].spent + 1);
    assert.equal(after.request.deadline_at.toISOString(), before.request.deadline_at.toISOString());
    const modeled = { objective: item.review.protocol.check.objective, maximumDeviationGain: item.review.protocol.check.maximumDeviationGain,
      minimumParticipationMargin: item.review.protocol.check.minimumParticipationMargin, optimum: 'UNKNOWN',
      actualAcceptedOwnerValue: 'UNKNOWN', acceptance: 'DISPOSABLE_DECLARATIONS_ONLY', resourceReceipts: item.review.protocol.envelope.resourceReceipts };
    await artifact('fallback/matched-diagnostic.json', { preregisteredCallee: off.contract, sameOriginalOwnerInput: item.input, off, on: modeled,
      before, after, offWallMs: performance.now() - start, protectedCompletedXComparator: 'UNAVAILABLE',
      costCoverage: 'RECORDED_CHILD_AND_OWNER_ATTEMPTS; MONEY_HUMAN_AGGREGATE_MEMORY_UNKNOWN', protectedGain: 'NOT_RUN' });
    return { artifact: 'fallback/matched-diagnostic.json', actualCallee: off.contract.callee, permittedDisposition: off.permittedDisposition,
      modeledValueNotProtectedGain: true };
  });
  await story('decline-no-response', async () => {
    const f = await owner('r3-decline-no-response', 64, 2), evidence = [];
    for (const kind of ['DECLINE', 'NO_RESPONSE'] as const) {
      const item: any = await submit(f, kind);
      assert.equal((await runJob(item.requestId)).status, 'COMPLETE');
      item.review = successful(await http.call(f.principal, 'elicitation-protocols', 'read', { requestId: item.requestId }));
      const observed = await observe(item, 0, kind); successful(observed.result);
      const closed = successful(await http.call(f.principal, 'elicitation-protocols', 'close', { requestId: item.requestId }));
      assert.equal(closed.noAgreement, true); assert.equal(closed.acceptanceComplete, false);
      const read = successful(await http.call(f.principal, 'elicitation-protocols', 'read', { requestId: item.requestId }));
      assert.equal(read.agreementEstablished, false); assert.equal(read.settlementEstablished, false);
      evidence.push({ kind, item, observed, closed, read });
    }
    await artifact('reports/no-agreement.json', evidence);
    return { artifact: 'reports/no-agreement.json', dispositions: ['DECLINE', 'NO_RESPONSE'], agreements: 0 };
  });
  await story('rational-original-owner-compatibility', async () => {
    const f = await owner('r3-rational-owner'), item: any = await submit(f, 'rational-owner', p => {
      p.parties[0].payments[0].minimum = q(1, 3); p.parties[0].payments[0].maximum = q(1, 3);
    });
    assert.equal((await runJob(item.requestId)).status, 'COMPLETE');
    item.review = successful(await http.call(f.principal, 'elicitation-protocols', 'read', { requestId: item.requestId }));
    assert(item.review.protocol.rule.table.every((r: any) => r.schedule[0].amount.numerator === '1' && r.schedule[0].amount.denominator === '3'));
    const proposed = await reviewProposedUse(f, item.requestId, 'Exact one-third owner compatibility');
    assert.equal(proposed.allocation.status, 'FEASIBLE');
    const issued = successful(await http.call(f.principal, 'allocations', 'read', { allocationRef: proposed.allocation.certificate.ref }));
    const native = await import('../../packages/epistemic-runtime/src/allocation-contracts');
    const cash = issued.reservation.envelopes.find((e: any) => e.resourceId === 'cash');
    assert(cash.quantities.some((s: string) => s.startsWith('r3q:')));
    for (const s of cash.quantities) assert.equal(native.allocationQuantity(native.allocationDecimal(native.allocationQuantity(s))).compare(native.allocationQuantity(s)), 0);
    const policy = successful(await http.call(f.principal, 'policies', 'read-mechanism', { policyRef: proposed.usePolicyRef }));
    assert.deepEqual(policy.protocol.rule.table, item.review.protocol.rule.table);
    assert(proposed.schedules.branches.every((b: any) => b.obligations[0].amount.denominator === '3'));
    await artifact('rational/owner-readers.json', { item, proposed, issued, policy, exactQuantityStrings: cash.quantities });
    return { artifact: 'rational/owner-readers.json', exactNonterminatingRational: '1/3', lossyProjection: false };
  });
  await story('shared-grant-concurrency', async () => {
    const f = await owner('r3-shared-grant', 2, 2), one = await submit(f, 'concurrent-one'), two = await submit(f, 'concurrent-two');
    const workers = await Promise.all([startWorker(), startWorker()]);
    try {
      const rows = await waitFor(() => admin.query('SELECT id,status,attempts_used,deadline_at,failure FROM finnor_os.r3_requests WHERE tenant_id=$1 ORDER BY id', [f.tenant]).then(r => r.rows),
        rows => rows.length === 2 && rows.every((r: any) => !['QUEUED', 'RUNNING'].includes(r.status)), 60);
      const usage = (await admin.query('SELECT * FROM finnor_os.p2_grant_usage WHERE tenant_id=$1', [f.tenant])).rows;
      const attempts = (await admin.query('SELECT id,request_id,phase,status,body FROM finnor_os.r3_attempts WHERE tenant_id=$1 ORDER BY created_at', [f.tenant])).rows;
      assert.equal(usage.length, 1); assert.equal(usage[0].spent, 2); assert.equal(attempts.length, 2);
      assert(rows.every((r: any) => r.attempts_used <= 2)); assert(rows.some((r: any) => r.status === 'UNKNOWN'));
      await artifact('faults/shared-grant.json', { one, two, rows, usage, attempts, physicalWorkers: workers.map(w => ({ pid: w.child.pid, log: w.logs })),
        capacity: 2, aggregateAdmittedNativeInvocations: 2, originalDeadlinesNotRenewed: true });
      return { artifact: 'faults/shared-grant.json', physicalWorkers: 2, actualWorks: 2, oneOriginalGrant: true, chargedInvocations: 2 };
    } finally { for (const w of workers) await stopWorker(w.child) }
  });
  await story('cancel-and-partial', async () => {
    const f = await owner('r3-cancel'), item = await submit(f, 'cancel-partial');
    const before = await readback(item), partial = successful(await http.call(f.principal, 'elicitation-protocols', 'read', { requestId: item.requestId }));
    assert.equal(partial.provisional, true); assert.equal(partial.protocol, null);
    const cancel = successful(await http.call(f.principal, 'elicitation-protocols', 'cancel', { requestId: item.requestId }));
    assert.equal((await runJob(item.requestId)).status, 'CANCELLED');
    const after = await readback(item);
    assert.equal(after.request.deadline_at.toISOString(), before.request.deadline_at.toISOString());
    assert.equal(after.request.protocol_ref, null); assert.equal(after.request.attempts_used, 0);
    const replay = successful(await http.call(f.principal, 'elicitation-protocols', 'submit', item.input));
    assert.equal(replay.requestId, item.requestId); assert.equal(replay.status, 'CANCELLED'); assert.equal(replay.semanticReplay, true);
    await artifact('faults/cancel-partial.json', { item, partial, cancel, before, after, replay });
    return { artifact: 'faults/cancel-partial.json', noUncheckedPublication: true, noDeadlineRenewal: true };
  });
  await story('sigkill-after-child-acceptance', async () => {
    const f = await owner('r3-physical-crash'), item = await submit(f, 'physical-crash'), gate = 1;
    const blocker = new pg.Client({ connectionString: url }); await blocker.connect();
    let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
    try {
      await blocker.query('SELECT pg_advisory_lock(773399,$1)', [gate]);
      await admin.query('INSERT INTO finnor_os.r3_e2e_publication_gates VALUES($1,$2)', [item.requestId, gate]);
      worker = await startWorker();
      await waitFor(() => admin.query("SELECT pid,wait_event,query FROM pg_stat_activity WHERE datname='r3_e2e' AND wait_event='advisory' AND query LIKE 'INSERT INTO finnor_os.r3_objects%'").then(r => r.rows),
        rows => rows.length > 0, 60);
      const before = await readback(item);
      const nativeLeases = (await admin.query("SELECT resource_key,tenant_key,owner_id,fence,expires_at,released_at FROM finnor_os.compute_resource_leases WHERE tenant_key=$1", [f.tenant])).rows;
      assert.deepEqual(before.attempts.map((a: any) => a.status), ['RETURNED', 'ACCEPTED']);
      assert.equal(before.request.protocol_ref, null); assert.equal(before.jobs[0].status, 'running');
      const pid = worker.child.pid; assert(pid); let osIdentity: string;
      if (process.platform === 'linux') {
        const [stat, status, command] = await Promise.all(['stat', 'status', 'cmdline']
          .map(name => readFile(`/proc/${pid}/${name}`, 'utf8')));
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
        const uid = status.match(/^Uid:\s+(\d+)/m); assert(uid);
        assert.equal(Number(stat.slice(0, stat.indexOf('(')).trim()), pid);
        assert.equal(Number(fields[1]), process.pid); assert.equal(Number(uid[1]), process.getuid!());
        assert.notEqual(fields[0], 'Z');
        osIdentity = JSON.stringify({ source: 'LINUX_PROCFS', pid, parentPid: Number(fields[1]),
          processGroup: Number(fields[2]), uid: Number(uid[1]), stat, status, command: command.replaceAll('\0', ' ') });
      } else {
        const identity = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'pid=,ppid=,pgid=,uid=,command='], { encoding: 'utf8' });
        assert.equal(identity.status, 0); osIdentity = identity.stdout;
      }
      await artifact('faults/physical-worker-os-identity-before-sigkill.json', { pid, osIdentity });
      await stopWorker(worker.child, 'SIGKILL'); assert.equal(worker.child.signalCode, 'SIGKILL');
      await blocker.query('SELECT pg_advisory_unlock(773399,$1)', [gate]);
      await admin.query('DELETE FROM finnor_os.r3_e2e_publication_gates WHERE request_id=$1', [item.requestId]);
      await waitFor(() => admin.query("SELECT lease_expires_at<clock_timestamp() expired FROM finnor_os.jobs WHERE payload->>'requestId'=$1", [item.requestId]).then(r => r.rows[0]), r => r.expired, 15);
      const apiUrl = process.env.DATABASE_URL; process.env.DATABASE_URL = workerUrl; await closePool();
      try { const queue = createWorker(); assert.equal(await queue.recoverExpiredRunningJobs(), 1) } finally { await closePool(); process.env.DATABASE_URL = apiUrl }
      assert.equal((await runJob(item.requestId)).status, 'COMPLETE');
      const after = await readback(item);
      assert.equal(after.attempts.length, 2); assert.equal(after.usage[0].spent, 2);
      assert.equal(after.request.deadline_at.toISOString(), before.request.deadline_at.toISOString());
      assert(Number(after.jobs[0].claim_fence) > Number(before.jobs[0].claim_fence));
      assert(after.events.some((e: any) => e.kind === 'RECOVER_ACCEPTED_NATIVE_CHILDREN'));
      await artifact('faults/physical-sigkill.json', { item, before, after, nativeLeases, physicalPid: pid, osIdentity,
        signal: worker.child.signalCode, physicalWorkerLog: worker.logs, faultBoundary: 'DURABLY_ACCEPTED_CHECKER_BEFORE_PROTOCOL_INSERT_AND_QUEUE_ACK',
        nativeReplayed: false, originalCostDeadlineAndGrantRetained: true });
      return { artifact: 'faults/physical-sigkill.json', signal: 'SIGKILL', noNewNativeInvocationsOnRecovery: true };
    } finally { if (worker) await stopWorker(worker.child); await blocker.end() }
  });
  await story('publication-row-lock-race', async () => {
    const f = await owner('r3-publication-race'), item = await submit(f, 'publication-race');
    const blocker = new pg.Client({ connectionString: url }); await blocker.connect();
    let worker: Awaited<ReturnType<typeof startWorker>> | undefined, locked = false;
    try {
      worker = await startWorker();
      await waitFor(() => admin.query("SELECT status FROM finnor_os.r3_attempts WHERE request_id=$1 AND phase='PRODUCER'", [item.requestId]).then(r => r.rows[0]),
        row => row?.status === 'SUBMITTED', 30);
      await blocker.query('BEGIN'); locked = true;
      const principalRow = (await blocker.query('SELECT id,role,status FROM finnor_os.users WHERE id=$1 FOR UPDATE', [f.principal])).rows[0];
      await waitFor(() => admin.query("SELECT pid,wait_event,query,pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE datname='r3_e2e' AND cardinality(pg_blocking_pids(pid))>0").then(r => r.rows),
        rows => rows.length > 0, 35);
      const waits = (await admin.query("SELECT pid,wait_event,query,pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE datname='r3_e2e' AND cardinality(pg_blocking_pids(pid))>0")).rows;
      await blocker.query("UPDATE finnor_os.users SET status='suspended' WHERE id=$1", [f.principal]);
      await blocker.query('COMMIT'); locked = false;
      const rows = await waitFor(() => admin.query('SELECT id,status,protocol_ref,attempts_used,failure FROM finnor_os.r3_requests WHERE id=$1', [item.requestId]).then(r => r.rows[0]),
        row => row.status === 'INVALIDATED', 30);
      assert.equal(rows.protocol_ref, null);
      const attempts = (await admin.query('SELECT phase,status,body FROM finnor_os.r3_attempts WHERE request_id=$1', [item.requestId])).rows;
      assert(attempts.length > 0); assert(attempts.every((a: any) => a.body.chargedInvocations === 1));
      const read = await http.call(f.principal, 'elicitation-protocols', 'read', { requestId: item.requestId }); assert(read.status >= 400);
      await artifact('faults/principal-row-lock-race.json', { item, principalRow, waits, afterRevocation: rows, attempts, read,
        realWorkerPid: worker.child.pid, physicalWorkerLog: worker.logs, principalRowLockAndActualRevocation: true });
      return { artifact: 'faults/principal-row-lock-race.json', staleProtocolPublished: false, retainedAttempts: attempts.length };
    } finally { if (locked) await blocker.query('ROLLBACK'); if (worker) await stopWorker(worker.child); await blocker.end() }
  });
  await story('currentness-and-p7', async () => {
    const evidence = [];
    for (const change of ['party-valuation', 'party-outside-option', 'declaration', 'rights', 'resource',
      'domain', 'mandate', 'payment-contract', 'method', 'checker', 'out-of-domain'] as const) {
      const f = await owner('r3-p7-' + change), item: any = await submit(f, 'p7-' + change);
      assert.equal((await runJob(item.requestId)).status, 'COMPLETE');
      item.review = successful(await http.call(f.principal, 'elicitation-protocols', 'read', { requestId: item.requestId }));
      // Keep actual report responsibility before every revision. The behavioral
      // refutation case also retains separately attested acceptance and S5 intent.
      const reported = await report(item, 0, '2');
      if (change === 'out-of-domain') {
        item.ownerReview = await reviewProposedUse(f, item.requestId, 'Retain responsibility through behavioral refutation');
        for (let i = 1; i < 4; i++) await report(item, i, '2');
        item.closed = successful(await http.call(f.principal, 'elicitation-protocols', 'close', { requestId: item.requestId }));
        for (let i = 0; i < 4; i++) successful((await observe(item, i, 'OBSERVED_ACCEPTANCE', item.closed)).result);
        item.use = successful(await http.call(f.principal, 'elicitation-protocols', 'use', {
          requestId: item.requestId, idempotencyKey: 'r3-p7-intent:' + item.requestId }));
        assert.equal(item.use.status, 'INTENDED_PENDING_S6');
      }
      const before = await readback(item), originals = (await admin.query(
        'SELECT object_id,digest FROM finnor_os.r3_objects WHERE request_id=$1 ORDER BY object_id', [item.requestId])).rows;
      let revision: unknown;
      if (change === 'party-valuation' || change === 'party-outside-option') {
        const p = item.body.parties[0], prior = (await admin.query(
          'SELECT source_id,content FROM finnor_os.evidence_source_versions WHERE id=$1', [p.sourceRef.id])).rows[0];
        const content = JSON.parse(prior.content);
        if (change === 'party-valuation') content.party.types[0].values.wait = q(1, 3);
        else content.party.types[0].outsideOptions[0].utility = q(1, 3);
        revision = await source(f, 'revised-' + change, content, prior.source_id);
      } else if (change === 'declaration') {
        revision = await source(f, 'revised-declaration', { ...item.body, assumptions: [...item.body.assumptions, 'Revised original supplied preference applicability'] },
          item.original.sourceId, 'PREFERENCE_DECLARATION');
      } else if (change === 'rights') {
        await admin.query("UPDATE finnor_os.users SET status='suspended' WHERE id=$1", [item.principals[1]]);
        revision = { revokedReportingPrincipalId: item.principals[1], ownerReadStillPermitted: true };
      } else if (change === 'resource') {
        const { ref: expectedRef, revision: _revision, priorRef: _prior, ...resource } = f.resources.find((r: any) => r.resourceId === 'cash');
        revision = successful(await http.call(f.principal, 'allocations', 'resource', {
          resource: { ...resource, knowledgeAt: new Date().toISOString(), availability: resource.availability.map((a: any) => ({ ...a, amount: '0' })) }, expectedRef }));
      } else if (change === 'out-of-domain') {
        revision = await observe(item, 0, 'OUT_OF_DOMAIN'); successful((revision as any).result);
      } else {
        const dependencies = (await admin.query('SELECT key,revision FROM finnor_os.r3_dependencies WHERE request_id=$1', [item.requestId])).rows;
        const prefix = 'r3:' + change + ':', selectedKey = dependencies.find((d: any) => d.key.startsWith(prefix));
        assert(selectedKey, 'No registered typed original-owner dependency for ' + change);
        // Ordinary revision-owner transaction, not a fabricated protected receipt.
        // Source-backed preferences/rights/resources are exercised separately above.
        await withTenantTransaction(f.tenant, { userId: f.principal }, async (_db, c) => {
          await c.query("INSERT INTO finnor_os.p4_source_revisions(tenant_id,key,revision) VALUES($1,$2,1) ON CONFLICT(tenant_id,key) DO UPDATE SET revision=finnor_os.p4_source_revisions.revision+1,changed_at=clock_timestamp()",
            [f.tenant, selectedKey.key]);
        });
        revision = { originalTypedKey: selectedKey, semanticOwnerRevisionObserved: true, noProtectedQualification: true };
      }
      const invalidated = (await admin.query('SELECT status,generation,failure FROM finnor_os.r3_requests WHERE id=$1', [item.requestId])).rows[0];
      const read = successful(await http.call(f.principal, 'elicitation-protocols', 'read', { requestId: item.requestId }));
      const history = successful(await http.call(f.principal, 'elicitation-protocols', 'history', { requestId: item.requestId }));
      const after = await readback(item), preserved = (await admin.query(
        'SELECT object_id,digest FROM finnor_os.r3_objects WHERE request_id=$1 ORDER BY object_id', [item.requestId])).rows;
      const proof = { change, item, reported, before, revision, invalidated, read, history, after, originals, preserved };
      await artifact('p7/' + change + '.json', proof);
      assert.equal(invalidated.status, 'INVALIDATED', 'Original ' + change + ' revision did not close R3 future use');
      assert.equal(read.protocol, null); assert.equal(read.status, 'INVALIDATED');
      assert.deepEqual(preserved, originals); assert.deepEqual(after.attempts, before.attempts);
      assert.equal(after.request.deadline_at.toISOString(), before.request.deadline_at.toISOString());
      assert(history.events.some((e: any) => e.event_id === reported.eventId));
      const use = await http.call(f.principal, 'elicitation-protocols', 'use', {
        requestId: item.requestId, idempotencyKey: 'forbidden-new-use:' + randomUUID() });
      assert(use.status >= 400, 'Invalidated original rule acquired a new use intent');
      if (change === 'out-of-domain') {
        assert.equal(history.events.filter((e: any) => e.kind === 'OBSERVED_ACCEPTANCE').length, 4);
        assert(history.events.some((e: any) => e.kind === 'OUT_OF_DOMAIN'));
        const responsibilities = (await admin.query(`SELECT st.status,st.effect_ref,r.envelopes,r.status AS reservation_status
          FROM finnor_os.s5_consumptions co JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id)
          JOIN finnor_os.s5_reservations r USING(tenant_id,reservation_id) WHERE co.tenant_id=$1`, [f.tenant])).rows;
        assert.equal(responsibilities.length, 1); assert.equal(responsibilities[0].effect_ref, null);
        assert.equal(responsibilities[0].status, 'INTENDED_PENDING_S6');
        assert.deepEqual(responsibilities[0].envelopes, item.use.consumption.envelope);
        await artifact('p7/out-of-domain-responsibility.json', { responsibilities, history, noPhysicalPayment: true });
      }
      evidence.push({ change, artifact: 'p7/' + change + '.json', invalidated, preservedAttempts: after.attempts.length });
    }
    return { changes: evidence, historyAndContingentResponsibilityRetained: true };
  });
  await story('native-experience-delivery', async () => {
    const f = await owner('r3-native-ledger'), principals = await ensureReporters(f);
    const owners = [...new Set(['BUSINESS_OWNER', 'SUPPLIED',
      ...(await admin.query('SELECT DISTINCT writable_owner FROM finnor_os.canonical_truth_registry WHERE active')).rows.map(r => r.writable_owner),
      'S1', 'S2', 'S3', 'S4', 'S5', 'S6'])];
    const scopes = [...owners.map(semanticOwner => ({ semanticOwner, tenantId: f.tenant, principalId: f.principal })),
      ...principals.slice(1).map(principalId => ({ semanticOwner: 'S6', tenantId: f.tenant, principalId }))];
    const rights = [...new Set([f.mandate.rightsRef, ...f.model.beliefBindings.map((b: any) => b.rightsRef),
      ...f.policies.flatMap((p: any) => p.bindings.beliefPins.map((pin: any) => `authority:${f.tenant}:${pin.rightsRevision}`))])] as string[];
    const ledger = await (await import('./native-ledger-fixture.mjs')).nativeLedgerFixture(repo, scopes, rights);
    try {
      const item = await submit(f, 'native-ledger');
      assert.equal((await runJob(item.requestId)).status, 'COMPLETE');
      const current = successful(await http.call(f.principal, 'elicitation-protocols', 'read', { requestId: item.requestId }));
      assert.equal(current.status, 'COMPLETE'); assert.deepEqual(current.protocol.check.counts,
        { profiles: 81, deviations: 648, participation: 324 });
      assert.equal(current.protocol.rule.table.length, 81);
      await artifact('native-ledger/current-owner-rule-before-proposed-use.json', current);
      const review = await reviewProposedUse(f, item.requestId, 'Authentic native delivery compatibility proof');
      assert.deepEqual(review.operationPacket.schedulesRef, review.schedules.ref);
      const reported = await report(item, 1, '2'), rows = await readback(item);
      const { deliverOwnerTransportBatch } = await import('../../packages/governed-execution/src/owner-delivery-store');
      const { readOwnerTransportReference, readOwnerTransportEvent } = await import('../../packages/governed-execution/src/owner-transport');
      const deliveries = [];
      const until = Date.now() + 120000;
      for (let round = 0; round < 16; round++) {
        for (const scope of scopes) for (let n = 0; n < 8; n++) {
          const delivered = await deliverOwnerTransportBatch(scope, { limit: 32 }); deliveries.push({ scope, delivered });
          if (!delivered.inspected) break;
        }
        const pending = (await admin.query(`SELECT status,last_error,next_attempt_at FROM finnor_os.s6_owner_delivery_states
          WHERE tenant_id=$1 AND status<>'ACCEPTED' ORDER BY next_attempt_at`, [f.tenant])).rows;
        if (!pending.length) break;
        assert(pending.every(p => ['PENDING', 'RETRY'].includes(p.status)), JSON.stringify(pending));
        assert(Date.now() < until, 'Native owner dependencies did not reach accepted delivery in the registered observation bound');
        await sleep(Math.max(25, Math.min(2000, pending[0].next_attempt_at.getTime() - Date.now() + 25)));
      }
      const origins = (await admin.query(`SELECT o.semantic_owner,o.principal_id,o.kind,o.identity,o.envelope,d.status,d.receipt
        FROM finnor_os.s6_owner_delivery_origins o JOIN finnor_os.s6_owner_delivery_states d
        USING(tenant_id,principal_id,semantic_owner,kind,identity) WHERE o.tenant_id=$1 ORDER BY o.created_at,o.identity`, [f.tenant])).rows;
      assert(origins.length > 20); assert(origins.every(o => o.status === 'ACCEPTED'));
      const events: any[] = [];
      for (const r of rows.events) {
        const body = r.body, expected = r3PreparedExperienceEvent(body, r.event_id);
        const scope = { semanticOwner: body.semanticOwner, tenantId: f.tenant, principalId: body.principalId };
        const event = await readOwnerTransportEvent(scope, expected.eventId);
        assert.deepEqual(event.event, expected); assert.equal(event.receipt.protectedExecution, false);
        assert.equal(event.event.appendAuthorityGranted, false); events.push(event);
      }
      const objects = (await admin.query('SELECT owner,object_id,version,digest,body FROM finnor_os.r3_objects WHERE request_id=$1 ORDER BY object_id', [item.requestId])).rows;
      const references = [];
      for (const object of objects) {
        const accepted = await readOwnerTransportReference({ semanticOwner: object.owner, tenantId: f.tenant, principalId: f.principal }, object.object_id);
        assert.deepEqual(accepted.reference, { owner: object.owner, id: object.object_id, version: object.version,
          contentDigest: object.digest, content: object.body }); references.push(accepted);
      }
      const original = objects[0]!;
      const changed = { ...original.body, alteredReplay: true };
      const { enqueueNativeReferences, nativeReference } = await import('../../packages/private-equity/src/native-experience-transport');
      await assert.rejects(() => enqueueNativeReferences(f.ctx,
        [nativeReference(original.owner, original.object_id, changed, original.version)], [f.mandate.rightsRef]),
        /NATIVE_OWNER_REFERENCE_CONFLICT/);
      assert(events.some(e => e.event.semanticOwner === 'S3'));
      assert(events.some(e => e.event.semanticOwner === 'S4'));
      assert(events.some(e => e.event.semanticOwner === 'S5'));
      assert(events.some(e => e.event.semanticOwner === 'S6' && e.event.principalId === principals[1]));
      const before = await ledger.journal();
      for (const scope of scopes) assert.equal((await deliverOwnerTransportBatch(scope, { limit: 32 })).inspected, 0);
      assert.deepEqual(await ledger.journal(), before);
      await assert.rejects(() => readOwnerTransportEvent({ ...scopes[0]!, tenantId: randomUUID() }, events[0]!.event.eventId));
      await artifact('native-ledger/boundaries.json', { item, review, reported, rows, deliveries, origins, events, references,
        journal: before, ...ledger.publicEvidence, replayCreatedCommitments: 0, alteredOriginalPreimageRefused: true,
        agreementEstablished: false, executionAuthorityGranted: false });
      return { artifact: 'native-ledger/boundaries.json', separateLedgerPid: ledger.child.pid,
        acceptedOriginals: origins.length, canonicalPreparedEvents: events.length, noAuthorityAmplification: true };
    } finally {
      try { await artifact('native-ledger/receiver-diagnostics.json', await ledger.diagnostics()) }
      finally { await ledger.close() }
    }
  });
  await story('s6-supported-recovery', async () => {
    const f = await upstream.fixture('r3-s6-supported', 2, [
      { id: 'cash', unit: 'USD', capacity: 100, totalLimit: 100 },
      { id: 'execution', unit: 'request', capacity: 200, totalLimit: 200, resourceClass: 'COMPUTE' },
      { id: 'human', unit: 'seconds', capacity: 4, totalLimit: 4, resourceClass: 'HUMAN_ATTENTION' },
    ]);
    const policy = await upstream.policy(f, 'price', { cash: 25, execution: 130, human: 4 });
    await upstream.resource(f, 'cash', 'USD', 'STOCK', ['100', '100', '100']);
    await upstream.resource(f, 'execution', 'request', 'CUMULATIVE_EXPENDITURE', ['200', '200', '200']);
    await upstream.resource(f, 'human', 'seconds', 'CUMULATIVE_EXPENDITURE', ['4', '4', '4']);
    const allocated = successful(await api(f, 'clear', upstream.clearing(f, { price: ['100'] })));
    assert.equal(allocated.status, 'FEASIBLE');
    const handoff = successful(await http.call(f.principal, 'policies', 'handoff', {
      policyRef: policy.ref, allocationRef: allocated.certificate.ref, decision: upstream.decision(f, allocated.certificate.ref) }));
    const obligation = successful(await http.call(f.principal, 'obligations', 'prepare', {
      preparationRef: handoff.preparationRef, allocationRef: handoff.allocationRef, consumptionRef: handoff.consumptionRef }));
    assert.equal(obligation.executionAuthorityGranted, false);
    await artifact('s6-supported/original-owners.json', { f, policy, allocated, handoff, obligation,
      r3MonetaryExecution: false, supportedOperation: 'CONDITIONAL_JSON_FIELDS_REPLACE' });
    const proof = await (await import('../s6/governed-dispatch-proof.mjs')).proveGovernedDispatch(f, obligation,
      (actor: any, operation: string, input: unknown) => http.call(actor.principal,
        ['resource', 'settle'].includes(operation) ? 'allocations' : 'obligations', operation, input),
      admin, (name: string, body: unknown) => artifact('s6-supported/' + name, body), false, undefined, false,
      { ownerCall: (operation, input) => http.call(f.principal, 'obligations', operation, input), workerDatabaseUrl: workerUrl });
    assert.equal(proof.requests.filter((r: any) => r.method === 'PATCH').length, 1);
    assert(proof.authorityCalls.every((r: any) => r.authentication === 'SIGNED_BEARER_REAL_HTTP'));
    return { artifact: 's6-supported/governed-dispatch.json', noDuplicatePhysicalAttempt: true,
      unknownRetainedUntilExactReadback: true, actualColdLedgerInterruption: true, bankPaymentEstablished: false };
  });
  await story('mounted-work-reload-switch', async () => {
    const f = await owner('r3-browser', 64, 2), item = await submit(f, 'browser');
    assert.equal((await runJob(item.requestId)).status, 'COMPLETE');
    await reviewProposedUse(f, item.requestId, 'Mounted existing Work proof, no effect authority');
    const row = await readback(item), protocol = successful(await http.call(f.principal,
      'elicitation-protocols', 'read', { requestId: item.requestId })).protocol;
    async function thread(workId: string) {
      assert.equal(f.canvasRoot?.entityType, 'pe_deal');
      const created = await createEmployeeConversationThread({ tenantId: f.tenant, ownerEmployeeId: f.principal, title: 'Finite rule review' });
      await updateEmployeeConversationThreadContext({ tenantId: f.tenant, ownerEmployeeId: f.principal,
        threadId: created.id, activeWorkId: workId, activeReferences: [f.canvasRoot] });
      return created;
    }
    const own = await thread(item.work.workId), alternate = await thread(f.preparedWorks[0].work.workId);
    const foreign = await owner('r3-browser-foreign');
    const email = async (id: string) => (await admin.query('SELECT email FROM finnor_os.users WHERE id=$1', [id])).rows[0].email;
    const directory = join(output, 'browser'); await mkdir(directory, { recursive: true });
    const browserDriver = process.env.FINNOR_R3_BROWSER_DRIVER === 'tools'
      ? (await import('./browser-tool-proof.mjs')).proveMountedWorkWithTools
      : (await import('./browser-proof.mjs')).proveMountedWork;
    const proof = await browserDriver({
      repo, output: directory, apiOrigin: http.origin, authOrigin: http.authOrigin,
      ownerEmail: await email(f.principal), foreignEmail: await email(foreign.principal),
      threadId: own.id, alternateThreadId: alternate.id, requestId: item.requestId, rule: protocol.rule,
      objective: JSON.stringify(protocol.check.objective),
      delayRead: () => http.delayRead(item.requestId),
      revise: () => source(f, 'browser-authentic-preference-revision', { ...item.body, assumptions: [...item.body.assumptions, 'Owner revised this supplied assumption'] },
        item.original.sourceId, 'PREFERENCE_DECLARATION'),
    });
    const preserved = await readback(item);
    assert.equal(preserved.request.status, 'INVALIDATED'); assert.equal(preserved.attempts.length, 2);
    assert.deepEqual(preserved.request.deadline_at, row.request.deadline_at);
    await artifact('browser/proof.json', { item, own, alternate, foreignTenant: foreign.tenant, proof, preserved });
    return { artifact: 'browser/proof.json', exactRows: 81, durableReload: true, delayedWorkReplyCleared: true,
      foreignTenantCleared: true, revisionCleared: true, costsAndOriginalDeadlineRetained: true };
  });
  await save();
} catch (e) {
  await artifact('failure.json', { ...failureDetails(e),
    m3Queries: admin! ? (await admin.query('SELECT id,tenant_id,principal_id,work_id,work_input_id,work_input_digest,status,failure,result_digest,acceptance,generation FROM finnor_os.m3_queries').catch(() => ({ rows: [] }))).rows : [],
    m3Publications: admin! ? (await admin.query('SELECT query_id,result_digest FROM finnor_os.m3_publications').catch(() => ({ rows: [] }))).rows : [],
    sql: admin! ? (await admin.query("SELECT pid,state,wait_event_type,wait_event,left(query,1000) query,pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE datname='r3_e2e'").catch(() => ({ rows: [] }))).rows : [],
    requests: admin! ? (await admin.query('SELECT id,status,failure,generation,deadline_at,attempts_used FROM finnor_os.r3_requests').catch(() => ({ rows: [] }))).rows : [],
    attempts: admin! ? (await admin.query('SELECT * FROM finnor_os.r3_attempts ORDER BY created_at').catch(() => ({ rows: [] }))).rows : [],
    jobs: admin! ? (await admin.query('SELECT id,type,status,last_error,claim_fence,attempts,lease_expires_at FROM finnor_os.jobs').catch(() => ({ rows: [] }))).rows : [] });
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill('SIGTERM');
  if (http!) { await artifact('http-observations.json', http.observed); await http.close() }
  await closePool(); if (admin!) await admin.end(); await postgres.stop();
  // This new directory was created by this driver and contains only its
  // disposable database. Retained SQL/process evidence lives outside it.
  await rm(dir, { recursive: true, force: true });
}
if (!cases.length || cases.some(c => c.status !== 'PASS')) process.exitCode = 1;
