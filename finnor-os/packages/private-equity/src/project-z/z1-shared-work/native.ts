import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { ExperimentRef } from '@finnor/shared-types';
import type { PeMutationContext } from '../../types';
import type { JobExecutionContext } from '../../../../../apps/worker/src/queue';
import { principal, tx } from '../../owner-context';
import { withGovernedProviderInvocation } from '../../../../db/compute-governor';
import { withDatabaseExecutionDeadline } from '../../../../db/execution-deadline';
import { digest, requireZ1, type Production } from '../../../../epistemic-runtime/src/project-z/z1-shared-work/contracts.js';
import { quantity } from '../../../../epistemic-runtime/src/project-z/z1-shared-work/relational.js';
import { originalProjectionDeliveries } from './deliveries.js';
import { nativeRef, same, assertOriginalBudget, developmentOnly, type NativeRow } from './native-contracts.js';
import {
  artifactTx, eventTx, rowTx, assertRowCurrentTx, fenceTx, contextForNativeClaim, loadNativeClaim,
  readPublishedTx, recordNativeCostTx, refuseExhaustedEpisodeTx, assertProjectionDeliveryBatchTx,
} from './native-store.js';
import { assertBudgetCurrentTx, assertBudgetsCurrentTx, chargeOriginalBudgetTx, holdOriginalCpuTx, withNativeTransaction as withS5PortfolioTransaction } from './resources.js';
import { currentSharedWorkAdmissionTx } from './admission.js';
import { consumeOriginalOwnerTx } from './owners.js';
import { assertNativePortfolioContextTx } from './portfolio-store.js';
import { consumeSharedWorkProjectionTx, type ClaimPayload, type ClaimedSnapshot, type Z1NativePorts, type PublishedProgram } from './owner.js';
import type { ProcessReceipt } from './processes.js';

interface AttemptRow {
  id: string; request_id: string; reference: ExperimentRef; generation: number; delivery_id: string;
  reserved_wall_ms: number; status: string; costs_unknown: boolean; created_at: Date;
}
const transaction = <T>(ctx: PeMutationContext, invoke: (c: PoolClient) => Promise<T>) =>
  withDatabaseExecutionDeadline(performance.now() + 30000, () => withS5PortfolioTransaction(ctx, invoke));
const ceiling = (value: string) => {
  const q = quantity(value); requireZ1(q.n >= 0n, 'Z1_NONNEGATIVE_ORIGINAL_CHARGE_REQUIRED');
  const n = (q.n + q.d - 1n) / q.d;
  requireZ1(n <= 1000000000n, 'Z1_ORIGINAL_CHARGE_BOUND', 'INCOMPLETE'); return Number(n);
};
async function claimRowTx(ctx: PeMutationContext, c: PoolClient, claim: Readonly<JobExecutionContext>, snapshot?: ClaimedSnapshot, originalWorkId?: string) {
  const job = (await c.query<{ request_id: string }>(
    'SELECT payload->>\'requestId\' request_id FROM finnor_os.jobs WHERE tenant_id=$1 AND id=$2', [ctx.auth.tenantId, claim.jobId])).rows[0];
  requireZ1(job?.request_id, 'Z1_CANONICAL_JOB_REQUEST_REQUIRED', 'REVOKED');
  const row = await rowTx(ctx, c, job.request_id, true, originalWorkId);
  await fenceTx(ctx, c, row, claim);
  if (snapshot) requireZ1(same(row.request, snapshot.request), 'Z1_ORIGINAL_SNAPSHOT_FENCED', 'STALE');
  return row;
}
async function attemptTx(ctx: PeMutationContext, c: PoolClient, reference: ExperimentRef) {
  const attempt = (await c.query<AttemptRow>(
    'SELECT * FROM finnor_os.z1_attempts WHERE tenant_id=$1 AND principal_id=$2 AND reference->>\'id\'=$3 FOR UPDATE',
    [ctx.auth.tenantId, principal(ctx), reference.id])).rows[0];
  requireZ1(attempt && same(attempt.reference, reference), 'Z1_OWNED_NATIVE_ATTEMPT_REQUIRED', 'REVOKED');
  return attempt;
}
async function deliveryAttemptTx(ctx: PeMutationContext, c: PoolClient, claim: Readonly<JobExecutionContext>) {
  const row = (await c.query<AttemptRow>(
    'SELECT * FROM finnor_os.z1_attempts WHERE tenant_id=$1 AND principal_id=$2 AND delivery_id=$3 FOR UPDATE',
    [ctx.auth.tenantId, principal(ctx), claim.deliveryAttemptId])).rows[0];
  requireZ1(row, 'Z1_ACTUAL_DURABLE_ATTEMPT_REQUIRED'); return row;
}
async function physicalTx(ctx: PeMutationContext, c: PoolClient, attempt: AttemptRow) {
  return (await c.query<{ body: { receipt: ProcessReceipt } }>(
    "SELECT body FROM finnor_os.z1_events WHERE tenant_id=$1 AND principal_id=$2 AND attempt_id=$3 AND event_key LIKE 'process:%'",
    [ctx.auth.tenantId, principal(ctx), attempt.id])).rows.map(item => item.body.receipt);
}
async function assertNativeMemoryTx(ctx: PeMutationContext, c: PoolClient, row: NativeRow,
  claim: Readonly<JobExecutionContext>, reserveChild = false, originalWorkId?: string) {
  const cuts = row.cuts.filter(cut => originalWorkId ? cut.workId === originalWorkId :
    !row.request.works.find(work => work.id === cut.workId)!.withdrawn);
  let maximum = 0;
  await assertBudgetsCurrentTx(ctx, c, cuts.map(cut => cut.parent), budget => { maximum += budget.original.maximumMemoryBytes; });
  const attempt = (await c.query<AttemptRow>(
    'SELECT * FROM finnor_os.z1_attempts WHERE tenant_id=$1 AND principal_id=$2 AND delivery_id=$3',
    [ctx.auth.tenantId, principal(ctx), claim.deliveryAttemptId])).rows[0];
  const receipts = attempt ? await physicalTx(ctx, c, attempt) : [];
  const childUpper = receipts.reduce((peak, receipt) => Math.max(peak,
    (receipt.peakRSSBytes ?? 0) + (receipt.supervisorPeakRSSBytes ?? 0)), 0);
  const parentHighWater = process.resourceUsage().maxRSS * 1024;
  requireZ1(maximum >= parentHighWater + Math.max(childUpper, reserveChild ? 2684354560 + 67108864 : 0),
    'Z1_ORIGINAL_SHARED_MEMORY_ENVELOPE_EXHAUSTED', 'INCOMPLETE');
  return { maximum, parentHighWater, childUpper, trueAggregatePeak: 'UNKNOWN',
    scope: 'CONSERVATIVE_WORKER_LIFETIME_HIGH_WATER_PLUS_MAX_SEQUENTIAL_WAIT4_CHILD_AND_SUPERVISOR' };
}

/** The registered worker always uses these concrete canonical bindings. */
export const nativeSharedWorkPorts: Z1NativePorts = {
  contract: 'z1-per-original-work-v1',
  contextForClaim: contextForNativeClaim,
  loadClaimed: loadNativeClaim,
  async assertCurrent(ctx, claim, snapshot) {
    await transaction(ctx, async c => { const row = await claimRowTx(ctx, c, claim, snapshot); await assertRowCurrentTx(ctx, c, row);
      await assertNativeMemoryTx(ctx, c, row, claim); });
  },
  async beginAttempt(ctx, claim, snapshot) {
    const outcome = await transaction(ctx, async c => {
      const row = await claimRowTx(ctx, c, claim, snapshot); await assertRowCurrentTx(ctx, c, row);
      await assertNativeMemoryTx(ctx, c, row, claim, !row.publication);
      const prior = (await c.query<AttemptRow>(
        'SELECT * FROM finnor_os.z1_attempts WHERE tenant_id=$1 AND principal_id=$2 AND delivery_id=$3 FOR UPDATE',
        [ctx.auth.tenantId, principal(ctx), claim.deliveryAttemptId])).rows[0];
      if (prior) return { reference: prior.reference, refusal: null };
      // A durable PID can precede private input, but its absence of a checkpoint
      // cannot prove that input or logical work never ran. Do not spend that
      // original headroom again. Known pre-PID loss and committed checkpoints
      // remain recoverable without inventing a logical reconciliation.
      const unresolved = (await c.query<AttemptRow>(
        `SELECT a.* FROM finnor_os.z1_attempts a WHERE a.tenant_id=$1 AND a.principal_id=$2
         AND a.request_id=$3 AND a.delivery_id<>$4
         AND EXISTS(SELECT 1 FROM finnor_os.z1_events e WHERE e.tenant_id=a.tenant_id AND e.attempt_id=a.id
           AND e.event_key='pid:'||a.id::text||':PRODUCER')
         AND NOT EXISTS(SELECT 1 FROM finnor_os.z1_events e WHERE e.tenant_id=a.tenant_id AND e.attempt_id=a.id
           AND e.body->>'kind'='DURABLE_CHECKPOINT') ORDER BY a.created_at,a.id LIMIT 16 FOR UPDATE OF a`,
        [ctx.auth.tenantId, principal(ctx), row.id, claim.deliveryAttemptId])).rows;
      if (unresolved.length) {
        for (const orphan of unresolved) {
          await eventTx(ctx, c, row.id, orphan.id, `logical-unknown:${orphan.id}`, {
            kind: 'PRIOR_PRODUCER_LOGICAL_EXPOSURE_UNRESOLVED', originalAttempt: orphan.reference,
            originalWorkIds: row.cuts.map(cut => cut.workId), originalDeadline: row.request.limits.deadlineAt,
            logicalCost: 'UNKNOWN', logicalHeadroomAvailable: false, originalParentsAndCpuWallHoldsRetained: true,
            reconciliationObserved: false, newComputationAuthorized: false });
          await c.query(`UPDATE finnor_os.z1_attempts SET costs_unknown=true,
            status=CASE WHEN status='STARTED' THEN 'LOST_UNKNOWN' ELSE status END WHERE tenant_id=$1 AND id=$2`,
          [ctx.auth.tenantId, orphan.id]);
        }
        await c.query("UPDATE finnor_os.z1_requests SET status='INCOMPLETE' WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
          [ctx.auth.tenantId, principal(ctx), row.id]);
        return { reference: null, refusal: 'Z1_UNRECONCILED_ORIGINAL_LOGICAL_EXPOSURE' };
      }
      if (await refuseExhaustedEpisodeTx(ctx, c, row, claim))
        return { reference: null, refusal: 'Z1_ORIGINAL_NATIVE_ATTEMPT_OR_WALL_BUDGET_EXHAUSTED' };
      const lost = (await c.query<AttemptRow>(
        "SELECT * FROM finnor_os.z1_attempts WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3 AND status='STARTED' FOR UPDATE",
        [ctx.auth.tenantId, principal(ctx), row.id])).rows;
      for (const orphan of lost) {
        await eventTx(ctx, c, row.id, orphan.id, `lost:${orphan.id}`, { kind: 'PRIOR_CLAIM_LOST', finalPhysicalCost: 'UNKNOWN',
          originalCpuHoldsAndWallReservationRetained: true, originalDeadline: row.request.limits.deadlineAt });
        await c.query("UPDATE finnor_os.z1_attempts SET status='LOST_UNKNOWN',costs_unknown=true WHERE tenant_id=$1 AND id=$2",
          [ctx.auth.tenantId, orphan.id]);
      }
      const id = randomUUID(), reserved = Math.min(snapshot.remainingWallMs, 120000 - row.wall_used_ms - row.wall_reserved_ms);
      const body = { schema: 'finnor.z1.native-attempt-start.v1', id, tenantId: ctx.auth.tenantId, principalId: principal(ctx),
        requestId: row.id, generation: row.generation, deliveryAttemptId: claim.deliveryAttemptId, jobId: claim.jobId,
        claimFence: claim.claimFence, workerId: claim.workerId, parentPid: process.pid,
        originalDeadline: row.request.limits.deadlineAt, reservedWallMs: reserved, createdAt: new Date().toISOString(),
        physicalCost: 'UNKNOWN_UNTIL_DURABLE_FINISH', executionAuthorityGranted: false };
      const reference = nativeRef('S3', 'z1-native-attempt', body);
      await c.query(`INSERT INTO finnor_os.z1_attempts
        (tenant_id,principal_id,id,request_id,generation,delivery_id,reference,body,reserved_wall_ms)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`,
        [ctx.auth.tenantId, principal(ctx), id, row.id, row.generation, claim.deliveryAttemptId, JSON.stringify(reference), JSON.stringify(body), reserved]);
      await c.query("UPDATE finnor_os.z1_requests SET attempts_used=attempts_used+1,wall_reserved_ms=wall_reserved_ms+$4,status='RUNNING' WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
        [ctx.auth.tenantId, principal(ctx), row.id, reserved]);
      await eventTx(ctx, c, row.id, id, `start:${id}`, body);
      const active = row.cuts.filter(cut => !row.request.works.find(work => work.id === cut.workId)!.withdrawn);
      requireZ1(active.length > 0, 'Z1_ACTIVE_ORIGINAL_WORK_REQUIRED');
      for (const cut of active) {
        await holdOriginalCpuTx(ctx, c, cut.parent, id, Math.ceil(60000000 / active.length));
        await holdOriginalCpuTx(ctx, c, cut.parent, `${id}:meter-tail`, Math.ceil(6000000 / active.length));
      }
      return { reference, refusal: null };
    });
    // Throw after commit so the conservative refusal is itself durable.
    requireZ1(outcome.reference, outcome.refusal ?? 'Z1_ORIGINAL_NATIVE_ATTEMPT_OR_WALL_BUDGET_EXHAUSTED', 'INCOMPLETE');
    return outcome.reference;
  },
  async recordChildPid(ctx, attemptRef, kind, pid) {
    await transaction(ctx, async c => {
      const attempt = await attemptTx(ctx, c, attemptRef);
      requireZ1(Number.isSafeInteger(pid) && pid > 1 && attempt.status === 'STARTED', 'Z1_OWNED_RUNNING_CHILD_REQUIRED');
      await eventTx(ctx, c, attempt.request_id, attempt.id, `pid:${attempt.id}:${kind}`,
        { kind: 'ACTUAL_CHILD_PID_DURABLE_BEFORE_PRIVATE_INPUT', executable: kind, pid, observedAt: new Date().toISOString() });
    });
  },
  async recordProcess(ctx, attemptRef, receipt) {
    // Append after loss of the claim too. This cannot publish a result.
    await transaction(ctx, async c => {
      const attempt = await attemptTx(ctx, c, attemptRef), row = await rowTx(ctx, c, attempt.request_id);
      await eventTx(ctx, c, row.id, attempt.id, `process:${attempt.id}:${receipt.executable}:${receipt.pid}`, { receipt });
      await recordNativeCostTx(ctx, c, row, `process:${attempt.id}:${receipt.executable}:${receipt.pid}`, {
        attemptRef, receipt, scope: 'COMPLETE_OBSERVED_CHILD_EXIT_OR_EXPLICIT_INTERRUPTED_UNKNOWN',
        billing: 'UNKNOWN', originalHoldsRetainedUntilCompleteParentSettlement: true });
    });
  },
  async retainFailure(ctx, attemptRef, code, costsUnknown) {
    await transaction(ctx, async c => {
      const attempt = await attemptTx(ctx, c, attemptRef);
      await eventTx(ctx, c, attempt.request_id, attempt.id, `failure:${attempt.id}`, {
        kind: 'NATIVE_OWNER_ATTEMPT_FAILED', code, costsUnknown, originalParentsAndUnknownRetained: true });
      await c.query("UPDATE finnor_os.z1_attempts SET status='FAILED',costs_unknown=costs_unknown OR $3 WHERE tenant_id=$1 AND id=$2",
        [ctx.auth.tenantId, attempt.id, costsUnknown]);
      await c.query(`UPDATE finnor_os.z1_requests SET status='INCOMPLETE'
        WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND status NOT IN('CANCELLED','INVALIDATED')`,
      [ctx.auth.tenantId, principal(ctx), attempt.request_id]);
    });
  },
  async withOriginalComputePermit(ctx, claim, snapshot, invoke) {
    requireZ1(process.env.P3_GOVERNORS === '1', 'Z1_ACTUAL_SHARED_COMPUTE_POLICY_REQUIRED');
    const started = performance.now(), cpu = process.cpuUsage(), rssBefore = process.memoryUsage().rss;
    return withDatabaseExecutionDeadline(performance.now() + snapshot.remainingWallMs, () =>
      withGovernedProviderInvocation({ provider: 'z1-shared-work-native', tenantId: ctx.auth.tenantId, ownerId: claim.deliveryAttemptId },
      async signal => {
        const held = await transaction(ctx, async c => {
          const row = await claimRowTx(ctx, c, claim, snapshot), attempt = await deliveryAttemptTx(ctx, c, claim);
          const active = row.cuts.filter(cut => !row.request.works.find(work => work.id === cut.workId)!.withdrawn);
          requireZ1(active.length > 0, 'Z1_ACTIVE_ORIGINAL_WORK_REQUIRED');
          const holds: Array<{ parent: ExperimentRef; hold: ExperimentRef; tailHold: ExperimentRef }> = [];
          for (const cut of active) holds.push({ parent: cut.parent,
            hold: await holdOriginalCpuTx(ctx, c, cut.parent, attempt.id, Math.ceil(60000000 / active.length)),
            tailHold: await holdOriginalCpuTx(ctx, c, cut.parent, `${attempt.id}:meter-tail`, Math.ceil(6000000 / active.length)) });
          return { row, attempt, holds };
        });
        let completed = false;
        const lost = new AbortController();
        let probing: Promise<void> | null = null;
        const probe = setInterval(() => {
          if (probing) return;
          probing = withDatabaseExecutionDeadline(performance.now() + 2000, () =>
            nativeSharedWorkPorts.assertCurrent(ctx, claim, snapshot, 'CLAIM'))
            .catch(() => lost.abort()).finally(() => { probing = null; });
        }, 1000);
        try { const result = await invoke(AbortSignal.any([signal, lost.signal])); completed = !signal.aborted && !lost.signal.aborted; return result; }
        finally {
          clearInterval(probe); if (probing) await probing;
          const elapsedMs = Math.ceil(performance.now() - started), usage = process.cpuUsage(cpu), rssAfter = process.memoryUsage().rss;
          await transaction(ctx, async c => {
            const attempt = await attemptTx(ctx, c, held.attempt.reference), row = await rowTx(ctx, c, held.row.id);
            const receipts = await physicalTx(ctx, c, attempt);
            const observed = receipts.every(receipt => receipt.cpuMicros !== null &&
              receipt.supervisorCpuMicros !== null && receipt.lifetimeScope === 'WAIT4_COMPLETE_EXITED_CHILD_AND_SEPARATE_SUPERVISOR');
            const totalCpu = usage.user + usage.system + receipts.reduce((sum, receipt) =>
              sum + (receipt.cpuMicros ?? 0) + (receipt.supervisorCpuMicros ?? 0), 0);
            const settled = completed && observed && elapsedMs <= held.attempt.reserved_wall_ms &&
              totalCpu <= 60000000 && receipts.length <= 2;
            const allocation = { scope: 'PARENT_PROCESS_INTERVAL_INCLUSIVE_PLUS_WAIT4_CHILDREN_AND_SUPERVISORS',
              totalCpuMicros: totalCpu, originalConsumers: held.holds.length, exactPerWorkCpuMicros: `${totalCpu}/${held.holds.length}`,
              elapsedMs, rssBeforeBytes: rssBefore, rssAfterBytes: rssAfter,
              conservativeMemoryUpperBytes: process.resourceUsage().maxRSS * 1024 + receipts.reduce((peak, receipt) =>
                Math.max(peak, (receipt.peakRSSBytes ?? 0) + (receipt.supervisorPeakRSSBytes ?? 0)), 0),
              trueAggregatePeak: 'UNKNOWN', concurrentParentWorkAttribution: 'INCLUSIVE_CONSERVATIVE_NOT_EXCLUSIVE',
              databaseWalIndexesCompactionAndBilling: 'UNKNOWN', settlementTailCpu: 'UNKNOWN',
              retainedTailHolds: held.holds.map(item => item.tailHold), tailHoldMaximumCpuMicros: 6000000,
              settled, originalCpuHoldsRetained: !settled };
            const { retainedTailHolds, ...perOriginalAllocation } = allocation;
            const tailInventory = { requestId: row.id, attemptRef: attempt.reference, eventKey: `parent-finish:${attempt.id}`,
              digest: digest(retainedTailHolds), count: retainedTailHolds.length };
            if (settled) for (const item of held.holds) await chargeOriginalBudgetTx(ctx, c, item.parent, {
              key: `physical:${attempt.id}`, role: 'cpu', units: Math.ceil(totalCpu / held.holds.length),
              cpuHold: item.hold, exactAllocation: { ...perOriginalAllocation, tailInventory,
                originalTailHold: item.tailHold }, recovery: true });
            await eventTx(ctx, c, row.id, attempt.id, `parent-finish:${attempt.id}`, allocation);
            await recordNativeCostTx(ctx, c, row, `parent:${attempt.id}`,
              { attemptRef: attempt.reference, ...perOriginalAllocation, tailInventory });
            if (settled) {
              await c.query(`UPDATE finnor_os.z1_requests SET wall_reserved_ms=wall_reserved_ms-$4,
                wall_used_ms=wall_used_ms+$5 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3`,
              [ctx.auth.tenantId, principal(ctx), row.id, attempt.reserved_wall_ms, elapsedMs]);
              await c.query("UPDATE finnor_os.z1_attempts SET status='FINISHED',costs_unknown=true WHERE tenant_id=$1 AND id=$2",
                [ctx.auth.tenantId, attempt.id]);
            }
          });
        }
      }));
  },
  async saveCheckpoint(ctx, claim, snapshot, production: Production) {
    return transaction(ctx, async c => {
      const row = await claimRowTx(ctx, c, claim, snapshot);
      await assertRowCurrentTx(ctx, c, row);
      requireZ1(row.version === snapshot.version, 'Z1_CHECKPOINT_VERSION_FENCED', 'STALE');
      const attempt = await deliveryAttemptTx(ctx, c, claim), version = row.version + 1;
      const checkpoint = production.checkpoint;
      requireZ1(!checkpoint || same(checkpoint.request, row.request), 'Z1_CHECKPOINT_ORIGINAL_BINDING_REQUIRED', 'COUNTEREXAMPLE');
      for (const cut of row.cuts) {
        const old = ceiling(row.checkpoint?.charges[cut.workId] ?? '0'), next = ceiling(checkpoint?.charges[cut.workId] ?? String(old));
        requireZ1(next >= old, 'Z1_CUMULATIVE_ORIGINAL_TICKS_CANNOT_DECREASE', 'COUNTEREXAMPLE');
        await chargeOriginalBudgetTx(ctx, c, cut.parent, { key: `logical:${row.id}:${row.generation}:${version}`,
          role: 'logical', units: next - old, exactAllocation: { exactLogicalTicks: production.costs.byWork[cut.workId] ?? '0',
            sharedTotal: production.costs.totalTicks, originalAllocationDigest: digest(production.costs.charges),
            originalCumulative: checkpoint?.charges[cut.workId] ?? row.checkpoint?.charges[cut.workId] ?? '0' } });
      }
      await c.query('UPDATE finnor_os.z1_requests SET checkpoint=$4::jsonb,version=$5,status=$6 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND version=$7',
        [ctx.auth.tenantId, principal(ctx), row.id, JSON.stringify(checkpoint), version, production.program ? 'CHECKING' : production.disposition, row.version]);
      await eventTx(ctx, c, row.id, attempt.id, `checkpoint:${attempt.id}:${version}`, { kind: 'DURABLE_CHECKPOINT',
        version, disposition: production.disposition, reason: production.reason, logicalCosts: production.costs });
      return version;
    });
  },
  async retainCheck(ctx, claim, snapshot, check) {
    return transaction(ctx, async c => {
      const row = await claimRowTx(ctx, c, claim, snapshot); await assertRowCurrentTx(ctx, c, row);
      return artifactTx(ctx, c, row.id, 'S3', 'z1-independent-original-check', check);
    });
  },
  async publishChecked(ctx, claim, snapshot, checkpointVersion, body) {
    return transaction(ctx, async c => {
      const row = await claimRowTx(ctx, c, claim, snapshot); await assertRowCurrentTx(ctx, c, row);
      await assertNativeMemoryTx(ctx, c, row, claim);
      requireZ1(row.version === checkpointVersion && row.checkpoint?.program &&
        same(row.checkpoint.program, body.candidate), 'Z1_CHECKED_CHECKPOINT_PUBLICATION_FENCED', 'STALE');
      const checkRef = body.envelope.checkerIdentityAndResultReferences.resultReference;
      const stored = (await c.query<{ body: unknown; reference: ExperimentRef }>(
        'SELECT body,reference FROM finnor_os.z1_artifacts WHERE tenant_id=$1 AND principal_id=$2 AND artifact_id=$3 AND kind=$4',
        [ctx.auth.tenantId, principal(ctx), checkRef.id, 'z1-independent-original-check'])).rows[0];
      requireZ1(stored && same(stored.reference, checkRef) && same(stored.body, body.check), 'Z1_CANONICAL_INDEPENDENT_CHECK_PREIMAGE_REQUIRED');
      const reference = await artifactTx(ctx, c, row.id, 'S3', 'z1-checked-publication', body);
      const publication = { reference, body };
      await c.query("UPDATE finnor_os.z1_requests SET publication=$4::jsonb,status='CHECKED_AWAITING_S8' WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
        [ctx.auth.tenantId, principal(ctx), row.id, JSON.stringify(publication)]);
      return publication;
    });
  },
  async enqueueOriginalProjections(ctx, claim, snapshot, publication) {
    return transaction(ctx, async c => {
      const row = await claimRowTx(ctx, c, claim, snapshot); await assertRowCurrentTx(ctx, c, row);
      requireZ1(row.publication && same(row.publication, publication), 'Z1_DELIVERY_CURRENT_PUBLICATION_REQUIRED', 'STALE');
      const records = originalProjectionDeliveries(publication, row.cuts);
      await c.query(`INSERT INTO finnor_os.z1_artifacts(tenant_id,principal_id,request_id,artifact_id,kind,reference,body)
        SELECT $1,$2,$3,r.reference->>'id','z1-original-projection-delivery',r.reference,r.body
        FROM jsonb_to_recordset($4::jsonb) r(reference jsonb,body jsonb)
        ON CONFLICT(tenant_id,artifact_id) DO NOTHING`,
      [ctx.auth.tenantId, principal(ctx), row.id, JSON.stringify(records)]);
      await c.query(`INSERT INTO finnor_os.z1_deliveries(tenant_id,principal_id,request_id,publication_id,work_id,reference)
        SELECT $1,$2,$3,$4,r."workId"::uuid,r.reference
        FROM jsonb_to_recordset($5::jsonb) r("workId" text,reference jsonb)
        ON CONFLICT(tenant_id,publication_id,work_id) DO NOTHING`,
      [ctx.auth.tenantId, principal(ctx), row.id, publication.reference.id, JSON.stringify(records)]);
      await assertProjectionDeliveryBatchTx(ctx, c, row, publication);
      return records.map(record => record.reference);
    });
  },
  async finishAttempt(ctx, attemptRef, publication) {
    await transaction(ctx, async c => {
      const attempt = await attemptTx(ctx, c, attemptRef);
      await eventTx(ctx, c, attempt.request_id, attempt.id, `artifact-finish:${attempt.id}`,
        { publicationRef: publication, physicalParentFinishStillRequired: true });
    });
  },
  async loadPublishedTx(ctx, c, reference, workId) { return readPublishedTx(ctx, c, reference, workId); },
  async assertOriginalCapacityTx(ctx, c, projection) {
    await assertNativePortfolioContextTx(ctx, c);
    const ref = (await c.query<{ body: { ref: ExperimentRef } }>(
      'SELECT body FROM finnor_os.s5_reservation_origins WHERE tenant_id=$1 AND principal_id=$2 AND reservation_id=$3',
      [ctx.auth.tenantId, principal(ctx), projection.binding.original.resources.parentReservationRef])).rows[0]?.body.ref;
    requireZ1(ref, 'Z1_ORIGINAL_S5_PARENT_REQUIRED');
    assertOriginalBudget(projection.binding.original, await assertBudgetCurrentTx(ctx, c, ref));
  },
  async assertExistingS8ConsumptionAdmissionTx(ctx, c, publication, _projection, row) {
    await currentSharedWorkAdmissionTx(ctx, c, row, publication);
  },
  async consumeS3OrS4Tx(ctx, c, publication, projection, row) {
    return consumeOriginalOwnerTx(ctx, c, row, publication, projection);
  },
  async recordS7AndConsumptionTx(ctx, c, publication, receipt, row) {
    await recordNativeCostTx(ctx, c, row, `owner:${digest(receipt)}`, { originalWorkId: receipt.workId,
      ownerReceipt: receipt, logicalAllocation: publication.body.candidate.costs.byWork[receipt.workId] ?? '0',
      observation: 'UNKNOWN_NO_BUSINESS_COMPLETION', effectPrepared: false }, receipt.workId);
    const acknowledged = await c.query(`UPDATE finnor_os.z1_deliveries SET status='CONSUMED',receipt=$5::jsonb
      WHERE tenant_id=$1 AND principal_id=$2 AND publication_id=$3 AND work_id=$4 AND request_id=$6
      AND (status='PENDING_S8' AND receipt IS NULL OR status='CONSUMED' AND receipt=$5::jsonb)`,
      [ctx.auth.tenantId, principal(ctx), publication.reference.id, receipt.workId, JSON.stringify(receipt), row.id]);
    requireZ1(acknowledged.rowCount === 1, 'Z1_CANONICAL_ORIGINAL_DELIVERY_REQUIRED', 'COUNTEREXAMPLE');
  },
};

export async function runNativeProjectionClaim(payload: ClaimPayload & { workId: string; publication: ExperimentRef }, claim: Readonly<JobExecutionContext>) {
  developmentOnly(); const ctx = await contextForNativeClaim(payload, claim);
  requireZ1(process.env.P3_GOVERNORS === '1', 'Z1_ACTUAL_SHARED_COMPUTE_POLICY_REQUIRED');
  const start = performance.now(), cpu = process.cpuUsage();
  await withGovernedProviderInvocation({ provider: 'z1-shared-work-native', tenantId: ctx.auth.tenantId, ownerId: claim.deliveryAttemptId },
    async signal => {
      requireZ1(!signal.aborted, 'Z1_CONSUMER_COMPUTE_PERMIT_LOST', 'INCOMPLETE');
      const original = await transaction(ctx, async c => {
        const row = await claimRowTx(ctx, c, claim, undefined, payload.workId), cut = row.cuts.find(item => item.workId === payload.workId);
        requireZ1(cut, 'Z1_ORIGINAL_CONSUMER_WORK_REQUIRED');
        await assertNativeMemoryTx(ctx, c, row, claim, false, payload.workId);
        const hold = await holdOriginalCpuTx(ctx, c, cut.parent, `owner:${claim.deliveryAttemptId}`, 6000000);
        const tailHold = await holdOriginalCpuTx(ctx, c, cut.parent, `owner:${claim.deliveryAttemptId}:meter-tail`, 1000000);
        return { parent: cut.parent, hold, tailHold, row };
      });
      let complete = false;
      try {
        await withDatabaseExecutionDeadline(start + 6000, () => withS5PortfolioTransaction(ctx, async c => {
          const row = await claimRowTx(ctx, c, claim, undefined, payload.workId); await assertRowCurrentTx(ctx, c, row, payload.workId);
          requireZ1(!signal.aborted, 'Z1_CONSUMER_COMPUTE_PERMIT_LOST', 'INCOMPLETE');
          await consumeSharedWorkProjectionTx(ctx, c, payload.publication, payload.workId, nativeSharedWorkPorts);
          await fenceTx(ctx, c, row, claim);
          requireZ1(!signal.aborted, 'Z1_CONSUMER_COMPUTE_PERMIT_LOST', 'INCOMPLETE');
        }));
        complete = !signal.aborted;
      } finally {
        const usage = process.cpuUsage(cpu), cpuMicros = usage.user + usage.system, wallMs = Math.ceil(performance.now() - start);
        await transaction(ctx, async c => {
          const row = await rowTx(ctx, c, original.row.id, true, payload.workId),
            settled = complete && cpuMicros <= 6000000 && wallMs <= 6000;
          if (settled) await chargeOriginalBudgetTx(ctx, c, original.parent, { key: `owner:${claim.deliveryAttemptId}`, role: 'cpu',
            units: cpuMicros, cpuHold: original.hold, recovery: true, exactAllocation: { cpuMicros, wallMs, scope: 'PARENT_PROCESS_INTERVAL_INCLUSIVE' } });
          await recordNativeCostTx(ctx, c, row, `owner-physical:${claim.deliveryAttemptId}`, {
            workId: payload.workId, cpuMicros, wallMs, settled, originalHoldRetained: !settled,
            settlementAndMeterTail: 'UNKNOWN', retainedTailHold: original.tailHold,
            scope: 'ORIGINAL_OWNER_PARENT_PROCESS_INTERVAL_INCLUSIVE_NOT_EXCLUSIVE', money: null }, payload.workId);
        });
      }
    });
}
