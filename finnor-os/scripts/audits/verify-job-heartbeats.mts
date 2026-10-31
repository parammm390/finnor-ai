import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createNativeOwnerDatabase } from '../s7/native-owner-database.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const index = process.argv.indexOf('--out');
assert(index >= 0 && process.argv[index + 1], '--out requires an external evidence directory');
const output = resolve(process.argv[index + 1]!);
assert(relative(root, output).startsWith('..') || isAbsolute(relative(root, output)), 'Evidence must be outside the repository');
await mkdir(output, { recursive: true });
process.env.FINNOR_CAPABILITY_NATIVE_WORKER_ROLE = "1";
const db = await createNativeOwnerDatabase();
const role = (await db.db.getPool().query("SELECT current_user AS role")).rows[0];
assert.equal(role.role, "finnor_worker");
const { JobQueue } = await import('../../apps/worker/src/queue');
const sourcePaths = ['finnor-os/apps/worker/src/queue.ts', 'finnor-os/apps/worker/src/job-heartbeat.ts', 'finnor-os/packages/db/compute-governor.ts', 'finnor-os/packages/private-equity/src/r3/worker.ts', 'finnor-os/scripts/audits/verify-job-heartbeats.mts'];
const sources = await Promise.all(sourcePaths.map(async path => ({ path, sha256: createHash('sha256').update(await readFile(resolve(root, path))).digest('hex') })));
const results: { id: string; status: 'PASS' | 'FAIL'; observed: unknown }[] = [];
const save = async () => writeFile(resolve(output, 'job-heartbeats.json'), JSON.stringify({ schema: 'finnor.job-heartbeats-e2e.v1', generatedAt: new Date().toISOString(), sources, results, qualification: 'Actual PostgreSQL job queue, job delivery rows, compute permit acquisition/renewal and real wall-clock timer periods. Fixture-only policy updates and explicit expiry/fence challenges; no provider effects or R3 numerical child.', rerun: 'From finnor-os: node --import=tsx scripts/audits/verify-job-heartbeats.mts --out <external directory>' }, null, 2));
const check = async (id: string, run: () => Promise<unknown>) => {
  try { results.push({ id, status: 'PASS', observed: await run() }); }
  catch (error) { results.push({ id, status: 'FAIL', observed: error instanceof Error ? error.message : String(error) }); }
  await save();
};
const pure = { protocolVersions: [1], retrySafety: 'pure' } as const;
const status = async (type: string) => (await db.admin.query('SELECT status,lease_owner,claim_token,claim_fence FROM finnor_os.jobs WHERE type=$1', [type])).rows[0];
try {
  const tenant = randomUUID(), actor = randomUUID();
  await db.admin.query("SET app.test_vertical_mode='explicit'");
  await db.admin.query("INSERT INTO finnor_os.tenants(id,name) VALUES($1,'Heartbeat fixture')", [tenant]);
  await db.admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')", [actor, tenant, actor + '@fixture.invalid']);
  await db.db.configureTenantVertical({ tenantId: tenant, verticalKey: 'private_equity', expectedVersion: 0, createdBy: actor, sourceSystem: 'heartbeat:fixture' });
  await db.admin.query("UPDATE finnor_os.compute_resource_policies SET lease_seconds=15 WHERE resource_key='native:r3'");
  await check('long-job-short-resource-through-two-expiries', async () => {
    const type = 'audit_resource_heartbeat';
    const queue = new JobQueue('heartbeat-e2e', 600, null);
    let renewals = 0, minimumRemainingMs = Infinity, handlerError = '';
    queue.register(type, async (_payload, context) => {
      assert(context);
      const leases = await db.db.acquireComputeResourceLeases({ resourceKeys: ['native:r3'], requiredResourceKeys: ['native:r3'], tenantId: tenant, workloadClass: 'INTERACTIVE', ownerId: context.deliveryAttemptId });
      const retire = context.registerHeartbeat(async () => { renewals += 1; return db.db.renewComputeResourceLeases(leases); }, { leaseSeconds: leases[0]!.leaseSeconds });
      try {
        for (let sample = 0; sample < 16; sample += 1) {
          await delay(2000);
          const row = (await db.admin.query('SELECT extract(epoch FROM expires_at-clock_timestamp())*1000 remaining FROM finnor_os.compute_resource_leases WHERE lease_token=$1', [leases[0]!.token])).rows[0];
          minimumRemainingMs = Math.min(minimumRemainingMs, Number(row.remaining));
          assert(Number(row.remaining) > 0, 'Compute reservation expired while its job was running');
        }
      } catch (error) { handlerError = String(error); throw error; }
      finally { retire(); await db.db.releaseComputeResourceLeases(leases, 'heartbeat-fixture-finished'); }
    }, pure);
    await queue.enqueue(type, { tenantId: tenant });
    await queue.tick();
    assert.equal((await status(type)).status, 'completed', handlerError);
    assert(renewals >= 5, `Only ${renewals} resource renewals`);
    return { jobLeaseSeconds: 600, resourceLeaseSeconds: 15, wallClockSeconds: 32, renewals, minimumRemainingMs };
  });
  await check('slow-renewals-are-serialized-and-drained', async () => {
    const type = 'audit_slow_heartbeat', queue = new JobQueue('heartbeat-slow', 600, null);
    let active = 0, maxActive = 0, calls = 0;
    queue.register(type, async (_payload, context) => {
      assert(context);
      context.registerHeartbeat(async () => {
        calls += 1; active += 1; maxActive = Math.max(maxActive, active);
        await delay(1500); active -= 1; return true;
      }, { leaseSeconds: 3 });
      await delay(4500);
    }, pure);
    await queue.enqueue(type, {}); await queue.tick();
    const after = calls;
    await delay(1500);
    assert(calls >= 2, 'Shorter heartbeat did not run');
    assert.equal(maxActive, 1);
    assert.equal(active, 0);
    assert.equal(calls, after);
    assert.equal((await status(type)).status, 'completed');
    return { calls, maxActive, activeAfterCompletion: active };
  });
  await check('retiring-in-flight-failure-does-not-poison-completion', async () => {
    const type = 'audit_retired_heartbeat', queue = new JobQueue('heartbeat-retire', 600, null);
    let calls = 0;
    queue.register(type, async (_payload, context) => {
      assert(context);
      const retire = context.registerHeartbeat(async () => { calls += 1; await delay(350); return false; }, { leaseSeconds: 1 });
      await delay(450); retire(); await delay(400);
    }, pure);
    await queue.enqueue(type, {}); await queue.tick();
    assert.equal(calls, 1);
    assert.equal((await status(type)).status, 'completed');
    return { calls, status: 'completed' };
  });
  await check('expired-job-cannot-renew-or-complete', async () => {
    const type = 'audit_expired_job', queue = new JobQueue('heartbeat-expire', 600, null);
    let callbacks = 0;
    queue.register(type, async (_payload, context) => {
      assert(context);
      context.registerHeartbeat(async () => { callbacks += 1; return true; }, { leaseSeconds: 1 });
      await db.admin.query("UPDATE finnor_os.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [context.jobId]);
      await delay(750);
    }, pure);
    await queue.enqueue(type, {}); await queue.tick();
    const row = await status(type);
    assert.notEqual(row.status, 'completed');
    assert.equal(callbacks, 0);
    return { status: row.status, callbacksAfterJobExpiry: callbacks };
  });
  await check('successor-job-fence-is-untouched', async () => {
    const type = 'audit_successor_job', queue = new JobQueue('heartbeat-stale', 600, null), successor = randomUUID();
    queue.register(type, async (_payload, context) => {
      assert(context);
      context.registerHeartbeat(async () => true, { leaseSeconds: 1 });
      await db.admin.query("UPDATE finnor_os.jobs SET claim_token=$2,claim_fence=claim_fence+1,lease_owner='successor',lease_expires_at=clock_timestamp()+interval '600 seconds' WHERE id=$1", [context.jobId, successor]);
      await delay(750);
    }, pure);
    await queue.enqueue(type, {}); await queue.tick();
    const row = await status(type);
    assert.equal(row.status, 'running'); assert.equal(row.claim_token, successor); assert.equal(row.lease_owner, 'successor');
    return { successorPreserved: true };
  });
} finally { await db.stop(); await save(); }
console.log(JSON.stringify({ output, results }));
assert(results.length === 5 && results.every(row => row.status === 'PASS'), 'Job heartbeat end-to-end cases failed; inspect job-heartbeats.json');
