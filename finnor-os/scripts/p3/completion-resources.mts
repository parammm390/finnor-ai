/** Registered before durable acquisition/preparation changes. */
import assert from 'node:assert/strict';
import { chmod, lstat } from 'node:fs/promises';
import { branchQueue } from '../../packages/private-equity/src/branch-fabric/worker';
interface Support {
  owner: any; admin: any;
  prepared: (f: any) => Promise<any>; submitted: (f: any, input: any) => Promise<any>;
  sqlState: (f: any, id: string) => Promise<any>;
  api: (f: any, operation: string, body: unknown) => Promise<any>;
  controllerProof: (boundary: string, branchId: string) => Promise<any>;
  stoppedNativeGroups: (state: any) => Promise<any>;
  tickBranch: (branchId: string, queue?: ReturnType<typeof branchQueue>) => Promise<boolean>;
  challenge: (id: string, steps: string[], expected: string, invoke: () => Promise<unknown>) => Promise<void>;
  save: (name: string, value: unknown) => Promise<void>;
  cleanupDiagnostics?: boolean;
}
export async function resourceSecurity(s: Support) {
  if (s.cleanupDiagnostics) await s.challenge('CB-P3-cleanup-refusal-durable-replay', [
    'Actual signed native branch publishes before an owned POSIX cleanup refusal',
    'Retain precise durable failed-resource cause and still-held native capacity',
    'Restore only the agent-created directory permission, then wait for the real queue schedule',
    'Canonical replay reconciles exact old resources without another programme or allowance',
  ], 'Owned cleanup failure remains diagnosable and charged; later real cleanup settles once without replaying a published result', async () => {
    const root = process.env.FINNOR_P3_RESOURCE_ROOT!;
    const descriptor = await lstat(root);
    assert(descriptor.isDirectory() && !descriptor.isSymbolicLink() && descriptor.uid === process.getuid?.());
    assert.equal(descriptor.mode & 0o777, 0o700);
    assert.notEqual(process.getuid?.(), 0, 'POSIX permission-refusal control requires an ordinary host user');
    const accepted = await s.submitted(s.owner, await s.prepared(s.owner));
    let injected = false;
    try {
      await s.tickBranch(accepted.branchId, branchQueue({ boundary: async (name) => {
        if (name === 'AFTER_POINTER_BEFORE_ACK') { await chmod(root, 0o500); injected = true; }
      } }));
    } finally { await chmod(root, 0o700); }
    assert(injected, 'Actual publication boundary was not reached');
    const snapshot = async () => ({
      branch: await s.sqlState(s.owner, accepted.branchId),
      resources: (await s.admin.query(`SELECT id,kind,path,descriptor,state,cleanup_observed,reason,
        process_group,job_id,delivery_attempt_id,claim_fence FROM finnor_os.p3_resource_intents
        WHERE branch_id=$1 ORDER BY created_at,id`, [accepted.branchId])).rows,
      leases: (await s.admin.query(`SELECT id,resource_key,owner_id,fence,acquired_at,expires_at,released_at,release_reason
        FROM finnor_os.compute_resource_leases WHERE owner_id LIKE $1 ORDER BY acquired_at,id`,
        [`p3:${accepted.branchId}:%`])).rows,
      job: (await s.admin.query(`SELECT id,status,attempts,run_at,claim_fence,lease_owner,
        clock_timestamp() server_now,greatest(0,extract(epoch FROM(run_at-clock_timestamp()))*1000)::float8 remaining_ms
        FROM finnor_os.jobs WHERE id=(SELECT job_id FROM finnor_os.p3_requests WHERE id=$1)`, [accepted.branchId])).rows[0],
    });
    const failed = await snapshot();
    await s.save('cleanup-diagnostic/after-owned-refusal.json', { accepted, injected, failed, usd: null });
    assert.equal(failed.branch.head.status, 'COMPLETE');
    assert.equal(failed.job.status, 'queued');
    assert(failed.resources.some((r: any) => r.kind !== 'NATIVE_PERMIT' && r.state !== 'CLEANED'));
    assert(failed.leases.some((r: any) => r.resource_key === 'native:p3-branch' && r.released_at === null),
      'Cleanup failure prematurely released the native permit');
    assert(failed.job.remaining_ms >= 0 && failed.job.remaining_ms <= 120000, 'Unexpected canonical retry schedule');
    const waitStarted = performance.now();
    await new Promise(ok => setTimeout(ok, Math.ceil(failed.job.remaining_ms) + 1));
    await s.tickBranch(accepted.branchId, branchQueue());
    const settled = await snapshot(), current = await s.api(s.owner, 'read', { branchId: accepted.branchId });
    await s.save('cleanup-diagnostic/after-canonical-replay.json', { accepted, failed, settled, current,
      actualScheduleWaitMs: performance.now() - waitStarted, runAtChangedByControl: false, leaseExpiryChangedByControl: false,
      programmeReplayPermitted: false, usd: null });
    assert.equal(settled.job.status, 'completed');
    assert.equal(settled.branch.head.result_id, failed.branch.head.result_id);
    assert.equal(settled.branch.head.generation, failed.branch.head.generation);
    assert.equal(settled.branch.artifacts.filter((r: any) => r.category === 'ATTEMPT').length,
      failed.branch.artifacts.filter((r: any) => r.category === 'ATTEMPT').length);
    assert(settled.resources.every((r: any) => r.state === 'CLEANED' && r.cleanup_observed));
    assert(settled.leases.every((r: any) => r.released_at !== null));
    for (const r of settled.resources.filter((r: any) => r.path)) await assert.rejects(() => lstat(r.path), { code: 'ENOENT' });
    const diagnostic = failed.branch.artifacts.find((r: any) => r.category === 'CLEANUP' &&
      r.body.type === 'RESOURCE_CLEANUP_FAILED' && r.body.cause === 'EACCES');
    assert(diagnostic, 'Precise owned P3 cleanup failure cause is not durably retained');
    assert(failed.resources.some((r: any) => r.id === diagnostic.body.resourceId && r.reason === 'EACCES'));
    return { accepted, failed, settled, current, diagnostic, actualScheduleWaitMs: performance.now() - waitStarted,
      originalClocksAndPublishedResultUnchanged: true, originalUnknownCleanupCauseNotInferred: true, usd: null };
  });
  await s.challenge('CB-P3-no-lease-before-durable-intent', [
    'Signed real prepare and queue submission', 'SIGKILL actual separate controller before launch intent',
    'Ordinary ownership artifacts and independent actual lease SQL',
  ], 'No native capacity lease is acquired before durable intent; unknown physical usage remains chargeable', async () => {
    const accepted = await s.submitted(s.owner, await s.prepared(s.owner));
    let before: any, crash: any, leases: any[];
    try {
      crash = await s.controllerProof('BEFORE_INTENT', accepted.branchId); assert.equal(crash.signal, 'SIGKILL');
      before = await s.sqlState(s.owner, accepted.branchId);
      leases = (await s.admin.query("SELECT resource_key,owner_id,released_at FROM finnor_os.compute_resource_leases WHERE owner_id LIKE $1 AND released_at IS NULL",
        [`p3:${accepted.branchId}:%`])).rows;
      assert.equal(leases.length, 0, 'A native lease was acquired before durable launch ownership');
      return { accepted, crash, before, leases };
    } finally { if (before) await restoreDelivery(before, accepted.branchId, true); }
  });
  await s.challenge('CB-P3-durable-scratch-and-lease-reconciliation', [
    'SIGKILL actual controller after native process start',
    'Independent pipe-death/process-group observer',
    'Durable owned scratch/preparation/acquisition records precede physical creation',
    'Recover queue with still-unexpired old native permit, without manufacturing its expiry',
    'Fresh controller enumerates and removes exact owned resources; immutable failed attempt/cost retained',
  ], 'A real retry reconciles old scratch and permit before any new execution, with zero unknown-cost refund', async () => {
    const accepted = await s.submitted(s.owner, await s.prepared(s.owner));
    let before: any, recovered = false;
    try {
      const crash = await s.controllerProof('EXECUTION_PROCESS_STARTED', accepted.branchId); assert.equal(crash.signal, 'SIGKILL');
      before = await s.sqlState(s.owner, accepted.branchId);
      const stopped = await s.stoppedNativeGroups(before);
      const intents = before.artifacts.filter((r: any) => r.category === 'EVENT' && r.body.type === 'RESOURCE_INTENT');
      assert(intents.some((r: any) => r.body.kind === 'NATIVE_STATE' && r.body.path), 'Native scratch ownership is not durable before process launch');
      assert(intents.some((r: any) => r.body.kind === 'PUBLIC_PREPARATION' && r.body.path), 'Preparation ownership is not durable');
      await restoreDelivery(before, accepted.branchId, false);
      recovered = true;
      const after = await s.sqlState(s.owner, accepted.branchId), r = await s.api(s.owner, 'read', { branchId: accepted.branchId });
      assert.equal(r.status, 200); assert.equal(r.body.status, 'COMPLETE', JSON.stringify(r));
      const old = (await s.admin.query('SELECT id,kind,path,state,cleanup_observed FROM finnor_os.p3_resource_intents WHERE branch_id=$1 AND delivery_attempt_id<>$2',
        [accepted.branchId, after.artifacts.filter((v: any) => v.category === 'ATTEMPT').at(-1).body.deliveryAttemptId])).rows;
      assert(old.length >= 3); assert(old.every((v: any) => v.state === 'CLEANED' && v.cleanup_observed === true));
      for (const resource of old.filter((v: any) => v.path)) await assert.rejects(() => lstat(resource.path), { code: 'ENOENT' });
      const outstanding = (await s.admin.query("SELECT owner_id FROM finnor_os.compute_resource_leases WHERE owner_id LIKE $1 AND released_at IS NULL",
        [`p3:${accepted.branchId}:%`])).rows; assert.equal(outstanding.length, 0);
      assert(after.artifacts.some((v: any) => v.category === 'COST' && v.body.failure === 'CONTROLLER_LOST_BEFORE_USAGE_COMMIT' &&
        v.body.reservedLiabilityMs > 0 && v.body.moneyUSD === null));
      return { accepted, crash, before, stopped, after, old, outstanding, recoveryWithoutLeaseExpiryAdvance: true };
    } finally { if (before && !recovered) await restoreDelivery(before, accepted.branchId, true); }
  });
  async function restoreDelivery(state: any, branchId: string, advanceOwnedNativeExpiry: boolean) {
    await s.stoppedNativeGroups(state);
    if (advanceOwnedNativeExpiry) await s.admin.query("UPDATE finnor_os.compute_resource_leases SET expires_at=acquired_at+interval '1 microsecond' WHERE owner_id LIKE $1", [`p3:${branchId}:%`]);
    await s.admin.query("UPDATE finnor_os.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1 AND status='running'", [state.head.job_id]);
    const queue = branchQueue(); await queue.recoverExpiredRunningJobs();
    await s.admin.query("UPDATE finnor_os.jobs SET run_at=clock_timestamp() WHERE id=$1 AND status='queued'", [state.head.job_id]);
    await s.tickBranch(branchId, queue);
  }
}
