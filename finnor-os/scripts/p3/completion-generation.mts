/** Registered before heartbeat synchronization changes. Real delivery only. */
import assert from 'node:assert/strict';
import { acquireComputeResourceLeases, releaseComputeResourceLeases } from '@finnor/db';
import { branchQueue } from '../../packages/private-equity/src/branch-fabric/worker';
import { tx, episodeTime } from '../../packages/private-equity/src/branch-fabric/store';

interface Support {
  owner: any; admin: any;
  prepared: (owner: any) => Promise<any>;
  submitted: (owner: any, prepared: any) => Promise<any>;
  sqlState: (owner: any, branchId: string) => Promise<any>;
  api: (owner: any, operation: string, body: unknown) => Promise<any>;
  tickBranch: (branchId: string, queue?: ReturnType<typeof branchQueue>) => Promise<boolean>;
  challenge: (id: string, steps: string[], expected: string, invoke: () => Promise<unknown>) => Promise<void>;
  save: (name: string, value: unknown) => Promise<void>;
}

export async function generationSecurity(s: Support) {
  await s.challenge('CB-P3-generation-heartbeat-interleaving', [
    'Signed Work/API submission and real held native capacity',
    'Actual deferred delivery retains its cost and logical attempt count',
    'Release only the exact held permit and select the real retry',
    'Pause its first heartbeat after the head read while intent generation advances',
    'Observe one current publication, original deadline and exact resource cleanup',
  ], 'A same-delivery generation transition cannot falsely cancel its live heartbeat; no deadline or cost is renewed', async () => {
    const accepted = await s.submitted(s.owner, await s.prepared(s.owner));
    const deadline = () => tx(s.owner.ctx, c => episodeTime(c, s.owner.ctx, accepted.branchId));
    const original = await deadline();
    const held = await acquireComputeResourceLeases({
      resourceKeys: ['native:p3-branch'], requiredResourceKeys: ['native:p3-branch'],
      tenantId: s.owner.ctx.tenantId, workloadClass: 'HEAVY', ownerId: 'p3-test:generation-interleaving',
    });
    try { assert.equal(await s.tickBranch(accepted.branchId), true); }
    finally { await releaseComputeResourceLeases(held, 'P3_GENERATION_CONTROL_HELD_PERMIT_FINISHED'); }
    const before = await s.sqlState(s.owner, accepted.branchId);
    const deferred = (await s.admin.query(
      'SELECT id,status,attempts,claim_fence,capacity_defer_count FROM finnor_os.jobs WHERE id=$1',
      [before.head.job_id])).rows[0];
    await s.save('generation-interleaving/before-retry.json', { accepted, original, before, deferred, usd: null });
    assert.equal(deferred.status, 'queued');
    assert.equal(deferred.attempts, 0);
    assert.equal(Number(deferred.capacity_defer_count), 1);
    assert.equal(before.head.status, 'INTERRUPTED');
    assert.equal(before.artifacts.filter((a: any) => a.category === 'ATTEMPT').length, 1);
    assert.equal(before.artifacts.filter((a: any) => a.category === 'COST').length, 1);

    let headSeen!: () => void, observed = false;
    const ready = new Promise<void>(yes => { headSeen = yes; });
    const observations: any[] = [];
    const queue = branchQueue({ boundary: async (name, detail) => {
      if (name === 'BEFORE_INTENT') {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([ready, new Promise<never>((_, no) => {
            timer = setTimeout(() => no(Error('ACTUAL_HEARTBEAT_HEAD_NOT_OBSERVED')), 3000);
          })]);
        } finally { if (timer) clearTimeout(timer); }
      }
      if (name === 'HEARTBEAT_HEAD_OBSERVED' && !observed) {
        observed = true;
        observations.push({ ...detail, observedAt: new Date().toISOString() });
        headSeen();
        await new Promise(yes => setTimeout(yes, 350));
      }
    } });
    // Disposable scheduling only. No running claim, lease or deadline is changed.
    await s.admin.query("UPDATE finnor_os.jobs SET run_at=clock_timestamp() WHERE id=$1 AND status='queued'",
      [deferred.id]);
    await s.tickBranch(accepted.branchId, queue);
    const after = await s.sqlState(s.owner, accepted.branchId), remaining = await deadline();
    const read = await s.api(s.owner, 'read', { branchId: accepted.branchId });
    const resources = (await s.admin.query(
      'SELECT id,kind,state,cleanup_observed FROM finnor_os.p3_resource_intents WHERE branch_id=$1 ORDER BY created_at,id',
      [accepted.branchId])).rows;
    const leases = (await s.admin.query(
      'SELECT id,resource_key,owner_id,fence,released_at,release_reason FROM finnor_os.compute_resource_leases WHERE owner_id LIKE $1',
      [`p3:${accepted.branchId}:%`])).rows;
    await s.save('generation-interleaving/after-retry.json', {
      accepted, original, remaining, deferred, observations, before, after, read, resources, leases,
      clocksChanged: false, runningLeaseChanged: false, nativeHoldMs: 350, usd: null,
      qualification: 'REAL_OWNED_DELIVERY_INTERLEAVING_NOT_ORIGINAL_OPAQUE_CAUSE_OR_GATE_PROOF',
    });
    assert(observed, 'Actual first retry heartbeat was not observed');
    assert.equal(observations[0].observedGeneration, before.head.generation);
    assert.equal(original.deadlineAt, remaining.deadlineAt);
    assert.equal(after.head.generation, before.head.generation + 1);
    assert.equal(read.status, 200);
    assert.equal(read.body.status, 'COMPLETE');
    assert.equal(after.artifacts.filter((a: any) => a.category === 'ATTEMPT').length, 2);
    assert.equal(after.artifacts.filter((a: any) => a.category === 'COST').length, 2);
    assert.equal(after.artifacts.filter((a: any) => a.category === 'EVENT' && a.body.type === 'RESULT_PUBLISHED').length, 1);
    assert(resources.length > 1 && resources.every((r: any) => r.state === 'CLEANED' && r.cleanup_observed));
    assert(leases.length === 1 && leases.every((r: any) => r.released_at !== null));
    return { accepted, original, remaining, deferred, observations, after, read, resources, leases };
  });
}
