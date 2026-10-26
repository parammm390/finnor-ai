import { strict as assert } from 'node:assert';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { createNativeOwnerDatabase } from '../s7/native-owner-database.mjs';

assert.equal(process.env.FINNOR_LIVE_NANGO_PUBLIC_SYNC, '1', 'EXPLICIT_PUBLIC_SYNC_AUTHORIZATION_REQUIRED');
const provider = z.string().regex(/^finnor-public-[a-f0-9]{8}$/).parse(process.env.FINNOR_LIVE_NANGO_INTEGRATION);
const output = resolve(z.string().min(1).parse(process.env.FINNOR_CAPABILITY_EVIDENCE_DIR));
await mkdir(output, { recursive: true });
for (const line of (await readFile(resolve('.env.capabilities.local'), 'utf8')).split('\n')) {
  const match = /^([A-Z_][A-Z_0-9]*)=(.*)$/.exec(line);
  if (match) process.env[match[1]!] = match[2]!;
}
const apiKey = z.string().min(1).parse(process.env.NANGO_API_KEY);
const localSigningKey = randomUUID();
Object.assign(process.env, { FINNOR_NANGO_ENABLED: '1', NANGO_WEBHOOK_SIGNING_KEY: localSigningKey,
  FINNOR_NANGO_PROVIDER_CATALOG: JSON.stringify([{ providerConfigKey: provider, models: ['FinnorPublicRepository'], readOnly: true }]) });
delete process.env.FINNOR_NANGO_BASE_URL;
const paths = ['scripts/release/run-nango-public-live-e2e.mts', 'integrations/nango/public-repository.ts',
  'packages/tools/src/nango.ts', 'packages/tools/src/capabilities/provider-json.ts',
  'packages/orchestration/src/capabilities/nango-bindings.ts', 'packages/orchestration/src/capabilities/nango-execution.ts',
  'packages/orchestration/src/capabilities/nango-webhook.ts', 'packages/orchestration/src/capabilities/nango-lifecycle.ts',
  'packages/orchestration/src/capabilities/repository.ts', 'packages/orchestration/src/capabilities/execution.ts',
  'packages/orchestration/src/capabilities/job-claim.ts', 'packages/orchestration/src/capabilities/policy.ts',
  'apps/api/app/api/capabilities/nango/connect/route.ts', 'apps/api/app/api/capabilities/nango/sources/route.ts',
  'apps/api/app/api/webhooks/nango/route.ts', 'apps/worker/src/handlers/run-capability-provider.ts'];
const cut = () => Promise.all(paths.map(async path => ({ path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') })));
const before = await cut(), database = await createNativeOwnerDatabase(), { admin, db } = database;
const tenantId = randomUUID(), userId = randomUUID(), connectionId = 'finnor-qualification-' + randomUUID();
const headers = { 'content-type': 'application/json', 'x-tenant-id': tenantId, 'x-user-id': userId, 'x-user-role': 'owner' };
const cases: Array<{ id: string; status: 'PASS' | 'FAIL'; observed?: unknown; failure?: string }> = [];
const facts: Record<string, unknown> = { provider, connectionId, connectionCreationRequested: false, upstreamWrites: false,
  webhookQualification: 'LOCALLY_GENERATED_HMAC_TEST_NOTIFICATION_NOT_PROVIDER_ORIGIN_DELIVERY', before };
const save = () => writeFile(join(output, 'checkpoint.json'), JSON.stringify({ ...facts, cases }, null, 2));
async function providerRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch('https://api.nango.dev' + path, { method, headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error('NANGO_HTTP_' + response.status); }
  if (response.status === 204) return null;
  return response.json();
}
async function check(id: string, operation: () => Promise<unknown>) {
  try { cases.push({ id, status: 'PASS', observed: await operation() }); }
  catch (error) { cases.push({ id, status: 'FAIL', failure: error instanceof Error ? error.name + ':' + error.message.slice(0, 500) : 'UnknownError' }); }
  await save(); console.log(JSON.stringify({ id, status: cases.at(-1)?.status }));
}
const connectRoute = await import('../../apps/api/app/api/capabilities/nango/connect/route');
const sourceRoute = await import('../../apps/api/app/api/capabilities/nango/sources/route');
const webhookRoute = await import('../../apps/api/app/api/webhooks/nango/route');
const runsRoute = await import('../../apps/api/app/api/capabilities/runs/route');
const runRoute = await import('../../apps/api/app/api/capabilities/runs/[id]/route');
const { NangoReadOnlyClient } = await import('../../packages/tools/src/nango');
const client = new NangoReadOnlyClient({ apiKey });
const { JobQueue } = await import('../../apps/worker/src/queue');
const { runCapabilityProvider } = await import('../../apps/worker/src/handlers/run-capability-provider');
const queue = new JobQueue('live-nango:' + randomUUID(), 300, 'HEAVY');
queue.register('run_capability_provider_v1', runCapabilityProvider, db.PRODUCTION_JOB_CONTRACTS.run_capability_provider_v1);
let intentId: string | undefined, runId: string | undefined, bound = false;
async function notification(payload: unknown) {
  const raw = JSON.stringify(payload);
  return webhookRoute.POST(new Request('http://localhost/api/webhooks/nango', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nango-hmac-sha256': createHmac('sha256', localSigningKey).update(raw).digest('hex') }, body: raw }));
}
const runSchema = z.object({ run: z.object({ id: z.string().uuid(), status: z.string(), failureCode: z.string().nullable(), result: z.unknown() }) });
async function readRun(id: string) {
  const response = await runRoute.GET(new Request('http://localhost/api/capabilities/runs/' + id, { headers }), { params: Promise.resolve({ id }) });
  assert.equal(response.status, 200); return runSchema.parse(await response.json()).run;
}
try {
  await admin.query("UPDATE finnor_os.compute_plane_cutover SET state='authoritative',accepted_job_epoch=3,minimum_claim_epoch=3,enforce_known_job_types=true,legacy_tenant_writes_allowed=false,activated_release_sha=$1,activated_at=clock_timestamp() WHERE singleton", [createHash('sha1').update(JSON.stringify(before)).digest('hex')]);
  await admin.query("INSERT INTO finnor_os.tenants(id,name)VALUES($1,'Nango public synthetic qualification')", [tenantId]);
  await admin.query('SELECT finnor_os.ensure_legacy_authority($1)', [tenantId]);
  await admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status)VALUES($1,$2,$3,'owner','active')", [userId, tenantId, userId + '@qualification.invalid']);
  await admin.query("INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id,resource_scope)SELECT $1,$2,id,'{\"kind\":\"tenant\"}'::jsonb FROM finnor_os.employee_roles WHERE tenant_id=$1 AND key='owner' ON CONFLICT DO NOTHING", [tenantId, userId]);
  await check('real-connect-session-and-prepared-intent', async () => {
    const response = await connectRoute.POST(new Request('http://localhost/api/capabilities/nango/connect', { method: 'POST', headers,
      body: JSON.stringify({ idempotencyKey: 'public-qualification', providerConfigKey: provider }) }));
    assert.equal(response.status, 201);
    const value = z.object({ intentId: z.string().uuid(), session: z.object({ token: z.string().min(1) }) }).parse(await response.json());
    intentId = value.intentId; facts.intentId = intentId; return { intentId, sessionIssued: true, sessionTokenPersisted: false };
  });
  if (intentId) await check('real-tagged-public-connection-and-local-notification-binding', async () => {
    const tags = { organization_id: tenantId, end_user_id: userId, finnor_binding_intent: intentId };
    facts.connectionCreationRequested = true; await save();
    await providerRequest('POST', '/connections', { provider_config_key: provider, connection_id: connectionId, credentials: { type: 'NONE' }, tags });
    facts.connectionImported = true; await save();
    const health = await client.connectionStatus({ providerConfigKey: provider, connectionId, deadlineAt: Date.now() + 15_000 });
    assert.equal(health.state, 'HEALTHY'); assert.deepEqual(health.tags, tags);
    const response = await notification({ type: 'auth', operation: 'creation', success: true, providerConfigKey: provider, connectionId, tags });
    assert.equal(response.status, 202); bound = true;
    return { provider, connectionId, providerIdentityChecked: true, notificationOrigin: 'LOCAL_TEST', credentials: 'NONE' };
  });
  if (bound) await check('real-fixed-public-sync-and-native-evidence-publication', async () => {
    facts.syncTriggerRequested = true; await save();
    await providerRequest('POST', '/sync/trigger', { provider_config_key: provider, connection_id: connectionId, syncs: ['public-repository'] });
    const query = new URLSearchParams({ provider_config_key: provider, connection_id: connectionId, syncs: 'public-repository' });
    const statusSchema = z.object({ syncs: z.array(z.object({ status: z.string(), recordCount: z.record(z.number()).optional(), latestResult: z.unknown().optional() })) });
    const end = Date.now() + 120_000;
    for (;;) {
      const status = statusSchema.parse(await providerRequest('GET', '/sync/status?' + query));
      facts.syncObservation = status; await save();
      assert(!status.syncs.some(sync => sync.status === 'ERROR'), 'REMOTE_SYNC_ERROR');
      if (status.syncs.some(sync => (sync.recordCount?.FinnorPublicRepository ?? 0) >= 1)) break;
      assert(Date.now() < end, 'REMOTE_SYNC_DEADLINE_RECONCILE_WITHOUT_RETRIGGER');
      await new Promise(done => setTimeout(done, 2_000));
    }
    const sourcesResponse = await sourceRoute.GET(new Request('http://localhost/api/capabilities/nango/sources', { headers }));
    assert.equal(sourcesResponse.status, 200);
    const source = z.object({ sources: z.array(z.object({ integration_id: z.string().uuid(), source_scope_id: z.string().uuid(), model: z.string() })).length(1) }).parse(await sourcesResponse.json()).sources[0]!;
    const response = await runsRoute.POST(new Request('http://localhost/api/capabilities/runs', { method: 'POST', headers, body: JSON.stringify({ kind: 'nango_sync',
      idempotencyKey: 'real-public-cache', timeoutMs: 120_000, integrationId: source.integration_id, sourceScopeId: source.source_scope_id, model: source.model }) }));
    assert.equal(response.status, 202); runId = runSchema.parse(await response.json()).run.id; facts.runId = runId; await save();
    const runEnd = Date.now() + 125_000;
    let run;
    for (;;) {
      await queue.tick(); run = await readRun(runId);
      if (['SUCCEEDED', 'FAILED', 'UNKNOWN', 'CANCELLED'].includes(run.status)) break;
      assert(Date.now() < runEnd, 'NATIVE_SYNC_DEADLINE'); await new Promise(done => setTimeout(done, 1_000));
    }
    assert.equal(run.status, 'SUCCEEDED', run.failureCode ?? undefined);
    const result = z.object({ recordsObserved: z.number().int().positive(), canonicalTruthEstablished: z.literal(false), executionAuthorityGranted: z.literal(false), checkpoint: z.object({ cursor: z.string().min(1) }) }).parse(run.result);
    const records = (await admin.query("SELECT external_id,canonical_entity_id,evidence_source_id,evidence_version_id FROM finnor_os.external_ref_observations WHERE tenant_id=$1 AND source_scope_id=$2", [tenantId, source.source_scope_id])).rows;
    assert.equal(records.length, 1); assert.equal(records[0].canonical_entity_id, null); assert(records[0].evidence_source_id && records[0].evidence_version_id);
    return { runId, result, observations: records, notificationOrigin: 'LOCAL_TEST', remoteRecords: 'ACTUAL_NANGO_PUBLIC_SYNC_CACHE' };
  });
} finally {
  if (facts.connectionCreationRequested) await check('owned-remote-connection-cleanup-and-native-cache-revocation', async () => {
    await providerRequest('POST', '/sync/pause', { provider_config_key: provider, connection_id: connectionId, syncs: ['public-repository'] });
    await providerRequest('DELETE', '/connections/' + encodeURIComponent(connectionId) + '?' + new URLSearchParams({ provider_config_key: provider }));
    const health = await client.connectionStatus({ providerConfigKey: provider, connectionId, deadlineAt: Date.now() + 15_000 });
    assert.equal(health.state, 'MISSING'); facts.connectionDeleted = true;
    if (bound) {
      const response = await notification({ type: 'auth', operation: 'deletion', providerConfigKey: provider, connectionId }); assert.equal(response.status, 202);
      const visible = await db.withTenant(tenantId, async connection => {
        const sources = await connection.execute(sql`SELECT id FROM finnor_os.evidence_sources WHERE source_type='nango_record'`);
        const observations = await connection.execute(sql`SELECT id FROM finnor_os.external_ref_observations WHERE provider='nango'`);
        return { sources: sources.rows.length, observations: observations.rows.length };
      }, userId);
      assert.deepEqual(visible, { sources: 0, observations: 0 });
    }
    return { connectionId, independentProviderState: health.state, oldCacheReadable: false, recurringSyncRemaining: false };
  });
  await database.stop();
}
const after = await cut(), sourcesUnchanged = JSON.stringify(before) === JSON.stringify(after);
const status = cases.length === 4 && sourcesUnchanged && cases.every(row => row.status === 'PASS') ? 'PASS' : 'FAIL';
await writeFile(join(output, 'results.json'), JSON.stringify({ schema: 'finnor.nango-public-live-e2e.v1', status, before, after, sourcesUnchanged, cases, facts,
  qualification: 'REAL_PUBLIC_REMOTE_SYNC_AND_RECORDS_NATIVE_NEXT_HANDLERS_ORDINARY_FORCED_RLS_DB_QUEUE_WORKER_LOCAL_TEST_HMAC_NOTIFICATION_NOT_EXTERNAL_WEBHOOK',
  rerun: 'FINNOR_LIVE_NANGO_PUBLIC_SYNC=1 FINNOR_LIVE_NANGO_INTEGRATION=<owned-deployed-integration> FINNOR_CAPABILITY_EVIDENCE_DIR=<fresh-dir> node --import=tsx scripts/release/run-nango-public-live-e2e.mts' }, null, 2));
console.log(JSON.stringify({ status, sourcesUnchanged, output, cases: cases.map(({ id, status }) => ({ id, status })) }));
process.exitCode = status === 'PASS' ? 0 : 1;
