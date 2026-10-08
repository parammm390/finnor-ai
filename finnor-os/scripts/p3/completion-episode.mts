/** Failure-first durable queue/ancestry clock and cancellation stories. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { branchQueue } from '../../packages/private-equity/src/branch-fabric/worker';
import { resume } from '../../packages/private-equity/src/branch-fabric/service';
import { inBranchEpisode } from '../../packages/private-equity/src/branch-fabric/budget';

interface Support {
  owner: any; admin: any;
  prepared: (f: any, source?: any, kind?: string) => Promise<any>;
  submitted: (f: any, input: any) => Promise<any>;
  run: (f: any, input: any, hooks?: any) => Promise<any>;
  sqlState: (f: any, id: string) => Promise<any>;
  api: (f: any, operation: string, body: unknown) => Promise<any>;
  tickBranch: (branchId: string, queue?: ReturnType<typeof branchQueue>) => Promise<boolean>;
  save: (name: string, value: unknown) => Promise<void>;
  challenge: (id: string, steps: string[], expected: string, invoke: () => Promise<unknown>) => Promise<void>;
}
export async function episodeSecurity(s: Support) {
  // Only the independent disposable observer advances the accepted timestamp.
  // The application role cannot change this immutable field or disable guards.
  async function expire(id: string) {
    await s.admin.query('BEGIN');
    try {
      await s.admin.query('ALTER TABLE finnor_os.p3_requests DISABLE TRIGGER p3_head_guard');
      await s.admin.query("UPDATE finnor_os.p3_requests SET created_at=clock_timestamp()-interval '121 seconds' WHERE id=$1", [id]);
      await s.admin.query('ALTER TABLE finnor_os.p3_requests ENABLE TRIGGER p3_head_guard');
      await s.admin.query('COMMIT');
    } catch (e) { await s.admin.query('ROLLBACK'); throw e; }
  }
  await s.challenge('CB-P3-current-restore-SQL-ancestry', [
    'Current private application positive control and independently decoded sealed checkpoint',
    'Actual signed restore API and ordinary-role ancestry deadline query',
    'Fresh child execution preserves the exact state and original accepted ancestor clock',
  ], 'A valid current restore succeeds without renewing its ancestor deadline', async () => {
    const input = await s.prepared(s.owner, { kind: 'financing_fixture', steps: [
      { operation: 'autosave', target: 'C_01', feeCents: 2000, effectId: randomUUID() },
    ] }, 'application_fixture');
    const ran = await s.run(s.owner, input); assert.equal(ran.branch.status, 'COMPLETE');
    const cp = await s.api(s.owner, 'checkpoint', { branchId: ran.s.branchId }); assert.equal(cp.status, 200);
    const restored = await s.api(s.owner, 'resume', { branchId: ran.s.branchId,
      checkpointId: cp.body.checkpointId, idempotencyKey: randomUUID() });
    if (restored.status !== 202) {
      let fault: unknown;
      try { await inBranchEpisode(30000, () => resume(s.owner.ctx, ran.s.branchId, cp.body.checkpointId, randomUUID())); }
      catch (error) { fault = { message: String(error), code: (error as any).code, detail: (error as any).detail }; }
      await s.save('episode/current-restore-fault.json', { ran, cp, restored, ordinaryOwnerDiagnostic: fault });
    }
    assert.equal(restored.status, 202, JSON.stringify(restored));
    await s.tickBranch(restored.body.branchId);
    const child = await s.api(s.owner, 'read', { branchId: restored.body.branchId });
    assert.equal(child.status, 200); assert.equal(child.body.status, 'COMPLETE');
    assert.deepEqual(child.body.result.candidate.state, ran.branch.result.candidate.state);
    assert.equal(restored.body.episodeDeadlineAt, ran.s.episodeDeadlineAt);
    const nextCp = await s.api(s.owner, 'checkpoint', { branchId: restored.body.branchId }); assert.equal(nextCp.status, 200);
    const grandchild = await s.api(s.owner, 'resume', { branchId: restored.body.branchId,
      checkpointId: nextCp.body.checkpointId, idempotencyKey: randomUUID() });
    assert.equal(grandchild.status, 202); assert.equal(grandchild.body.episodeDeadlineAt, ran.s.episodeDeadlineAt);
    await s.tickBranch(grandchild.body.branchId);
    const next = await s.api(s.owner, 'read', { branchId: grandchild.body.branchId });
    assert.equal(next.body.status, 'COMPLETE'); assert.deepEqual(next.body.result.candidate.state, ran.branch.result.candidate.state);
    await expire(ran.s.branchId);
    const expiredAncestor = await s.api(s.owner, 'resume', { branchId: restored.body.branchId,
      checkpointId: nextCp.body.checkpointId, idempotencyKey: randomUUID() });
    assert.equal(expiredAncestor.status, 409); assert.equal(expiredAncestor.body.code, 'BRANCH_EPISODE_DEADLINE_EXHAUSTED');
    return { ran, cp, restored, child, nextCp, grandchild, next, expiredAncestor, originalAcceptedClockPreserved: true };
  });
  await s.challenge('CB-P3-queue-wait-original-deadline', [
    'Real signed API submission and immutable queue record',
    'Independent disposable observer advances only the accepted request clock',
    'Actual worker dispatch cannot start a new physical intent after 120 seconds',
  ], 'Queue waiting consumes the original episode; expired request has no native attempt or capacity acquisition', async () => {
    const accepted = await s.submitted(s.owner, await s.prepared(s.owner));
    await expire(accepted.branchId);
    await s.tickBranch(accepted.branchId);
    const after = await s.sqlState(s.owner, accepted.branchId);
    assert.equal(after.head.status, 'FAILED', 'Queue waiting acquired a fresh execution deadline');
    assert.equal(after.head.reason, 'BRANCH_EPISODE_DEADLINE_EXHAUSTED');
    assert.equal(after.head.result_id, null);
    assert.equal(after.artifacts.filter((r: any) => r.category === 'ATTEMPT').length, 0);
    assert.equal((await s.admin.query("SELECT id FROM finnor_os.compute_resource_leases WHERE owner_id LIKE $1 AND released_at IS NULL",
      [`p3:${accepted.branchId}:%`])).rowCount, 0);
    return { accepted, after, clockFault: 'Only agent-created disposable request timestamp, no sleep or renewed product clock' };
  });
  await s.challenge('CB-P3-publication-original-deadline', [
    'Real native execution and independent checker',
    'Expire original request after immutable result bytes, before current publication',
    'Read request pointer, historical result, cost and owned-resource cleanup',
  ], 'A checked blob cannot publish after the original accepted clock, and all physical work remains charged', async () => {
    const cut = await s.prepared(s.owner), accepted = await s.submitted(s.owner, cut);
    await s.tickBranch(accepted.branchId, branchQueue({ boundary: async name => {
      if (name === 'AFTER_BLOB_BEFORE_POINTER') await expire(accepted.branchId);
    } }));
    const after = await s.sqlState(s.owner, accepted.branchId);
    assert.equal(after.head.result_id, null, 'Publication ignored the original accepted request deadline');
    assert.equal(after.head.status, 'FAILED');
    assert(after.artifacts.some((r: any) => r.category === 'RESULT'), 'Checked historical blob was erased');
    assert(after.artifacts.some((r: any) => r.category === 'COST' && r.body.moneyUSD === null));
    const outstanding = (await s.admin.query("SELECT id FROM finnor_os.p3_resource_intents WHERE branch_id=$1 AND state<>'CLEANED'",
      [accepted.branchId])).rows; assert.equal(outstanding.length, 0);
    return { accepted, after, outstanding };
  });
  await s.challenge('CB-P3-restore-retains-ancestor-deadline', [
    'Current private application positive control and encrypted checkpoint',
    'Expire the ancestor original episode, retaining current rights and immutable audit',
    'Signed restore cannot renew the old episode by creating another request',
  ], 'Restoration needs an unspent original ancestor clock, not a new execution grant', async () => {
    const input = await s.prepared(s.owner, { kind: 'financing_fixture', steps: [
      { operation: 'autosave', target: 'C_01', feeCents: 2000, effectId: randomUUID() },
    ] }, 'application_fixture');
    const ran = await s.run(s.owner, input);
    assert.equal(ran.branch.status, 'COMPLETE');
    const cp = await s.api(s.owner, 'checkpoint', { branchId: ran.s.branchId }); assert.equal(cp.status, 200);
    await expire(ran.s.branchId);
    const before = Number((await s.admin.query('SELECT count(*) AS n FROM finnor_os.p3_requests')).rows[0].n);
    const refused = await s.api(s.owner, 'resume', { branchId: ran.s.branchId,
      checkpointId: cp.body.checkpointId, idempotencyKey: randomUUID() });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'BRANCH_EPISODE_DEADLINE_EXHAUSTED');
    assert.equal(Number((await s.admin.query('SELECT count(*) AS n FROM finnor_os.p3_requests')).rows[0].n), before);
    return { ran, cp, refused, historicalResultRetained: (await s.sqlState(s.owner, ran.s.branchId)).head.result_id !== null };
  });
}
