import type { PoolClient } from 'pg';
import type { TenantContext } from '@finnor/shared-types';
import { randomUUID } from 'node:crypto';
import { actor, artifact, tx, workBasis } from './store';
import { fault, hash, LIMITS, WORK_LIMITS } from './contracts';

/** P3 usage linkage, not a new economic ledger or an S5/S7 settlement. */
export async function costOnce(c: PoolClient, ctx: TenantContext, workId: string, accountingId: string, body: Record<string, any>) {
  for (const key of ['elapsedMs', 'reservedLiabilityMs', 'inputBytes', 'outputBytes', 'storageBytes']) {
    if (body[key] != null && (!Number.isFinite(body[key]) || body[key] < 0)) fault('COST_METER_INVALID');
  }
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`p3-budget:${ctx.tenantId}:${actor(ctx)}:${workId}`]);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`p3-cost:${ctx.tenantId}:${actor(ctx)}:${accountingId}`]);
  const prior = (await c.query("SELECT id,work_id,body,content_digest FROM finnor_os.p3_artifacts WHERE tenant_id=$1 AND principal_id=$2 AND category='COST' AND body->>'accountingId'=$3", [ctx.tenantId, actor(ctx), accountingId])).rows[0];
  if (prior && (prior.work_id !== workId || hash(prior.body) !== prior.content_digest)) fault('COST_IDENTITY_OR_DIGEST_INVALID');
  return prior?.id ?? artifact(c, ctx, workId, 'COST', { schema: 'finnor.branch-cost.v1', ...body, accountingId, moneyUSD: null, reconciliation: 'UNRECONCILED', settlement: 'NOT_APPLICABLE' });
}
export async function workUsage(c: PoolClient, ctx: TenantContext, workId: string) {
  const scope = [ctx.tenantId, actor(ctx), workId];
  const costs = (await c.query(`SELECT coalesce(sum(coalesce((body->>'elapsedMs')::numeric,
    (body->>'reservedLiabilityMs')::numeric,$4)),0) AS charged
    FROM finnor_os.p3_artifacts WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND category='COST'`, [...scope, LIMITS.wallMs])).rows[0];
  const controls = (await c.query(`SELECT coalesce(sum(coalesce((a.body->>'reservedWallMs')::numeric,$4)),0) AS outstanding
    FROM finnor_os.p3_artifacts a WHERE a.tenant_id=$1 AND a.principal_id=$2 AND a.work_id=$3
    AND a.category='EVENT' AND a.body->>'type' IN ('CONTROL_INTENT','ACQUISITION_INTENT')
    AND NOT EXISTS(SELECT 1 FROM finnor_os.p3_artifacts b WHERE b.tenant_id=a.tenant_id AND b.principal_id=a.principal_id
      AND b.category='COST' AND (b.body->>'accountingId'=a.body->>'accountingId'
        OR b.body->>'accountingId'='acquisition:'||(a.body->>'acquisitionId')))`, [...scope, LIMITS.wallMs])).rows[0];
  const attempts = (await c.query(`SELECT coalesce(sum(coalesce((a.body->>'reservedWallMs')::numeric,$4)+5000),0) AS outstanding
    FROM finnor_os.p3_artifacts a WHERE a.tenant_id=$1 AND a.principal_id=$2 AND a.work_id=$3 AND a.category='ATTEMPT'
    AND NOT EXISTS(SELECT 1 FROM finnor_os.p3_artifacts b WHERE b.tenant_id=a.tenant_id AND b.principal_id=a.principal_id
      AND b.category='COST' AND b.body->>'attemptId'=a.id::text)`, [...scope, LIMITS.wallMs])).rows[0];
  const requests = (await c.query(`SELECT count(*) AS count,coalesce(sum(CASE WHEN status IN
    ('PREPARING','RUNNING','CHECKPOINTING','CHECKING','CANCEL_REQUESTED','INTERRUPTED') THEN $4 ELSE 0 END),0) AS reserved
    FROM finnor_os.p3_requests WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3`, [...scope, LIMITS.requestMs])).rows[0];
  const storage = (await c.query(`SELECT coalesce(sum(octet_length(body::text)),0) AS bytes
    FROM finnor_os.p3_artifacts WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3`, scope)).rows[0];
  const chargedWallMs = Number(costs.charged), outstandingControlLiabilityMs = Number(controls.outstanding);
  const outstandingAttemptLiabilityMs = Number(attempts.outstanding), activeRequestReservationMs = Number(requests.reserved);
  return {
    schema: 'finnor.p3.work-usage.v1', workId, chargedWallMs, outstandingControlLiabilityMs,
    outstandingAttemptLiabilityMs, activeRequestReservationMs,
    conservativeWallMs: chargedWallMs + outstandingControlLiabilityMs + outstandingAttemptLiabilityMs + activeRequestReservationMs,
    requests: Number(requests.count), retainedJsonBytes: Number(storage.bytes), limits: WORK_LIMITS,
    aggregateMoneyUSD: null, reconciliation: 'UNRECONCILED',
    qualification: 'CONSERVATIVE_INCLUSIVE_ADMISSION_BOUND_NOT_ADDITIVE_PHYSICAL_CPU_OR_FINANCIAL_FUNDING',
  };
}
export async function assertWorkBudget(c: PoolClient, ctx: TenantContext, workId: string, reserveMs = 0, newRequests = 0) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`p3-budget:${ctx.tenantId}:${actor(ctx)}:${workId}`]);
  const usage = await workUsage(c, ctx, workId);
  if (usage.conservativeWallMs + reserveMs > WORK_LIMITS.wallMs || usage.requests + newRequests > WORK_LIMITS.requests) fault('WORK_COMPUTE_BUDGET_EXHAUSTED');
  return usage;
}
export async function beginControl(ctx: TenantContext, workId: string, phase: string, reservedWallMs: number, detail: Record<string, any> = {}) {
  const accountingId = detail.accountingId ?? `control:${phase}:${randomUUID()}`;
  await tx(ctx, async c => {
    await workBasis(c, ctx, workId);
    await assertWorkBudget(c, ctx, workId, reservedWallMs);
    await artifact(c, ctx, workId, 'EVENT', { ...detail, type: 'CONTROL_INTENT', phase, accountingId, reservedWallMs, at: new Date().toISOString(), moneyUSD: null });
  });
  return { ctx, workId, accountingId, phase, began: performance.now(), before: process.resourceUsage() };
}
export async function finishControl(control: Awaited<ReturnType<typeof beginControl>>, detail: Record<string, any>) {
  return recordControlCost(control.ctx, control.workId, control.accountingId, { ...detail, phase: control.phase, ...measuredInterval(control.began, control.before) });
}
export function measuredInterval(start: number, before: NodeJS.ResourceUsage) {
  const after = process.resourceUsage();
  return { elapsedMs: performance.now() - start, parentCpuMicros: after.userCPUTime - before.userCPUTime + after.systemCPUTime - before.systemCPUTime, parentPeakRssBytes: after.maxRSS * 1024, scope: 'PARENT_INCLUSIVE_INTERVAL_MAY_OVERLAP_CHILD_AND_OTHER_REQUESTS_NOT_ADDITIVE' };
}
export async function recordControlCost(ctx: TenantContext, workId: string, accountingId: string, body: Record<string, any>) {
  return tx(ctx, c => costOnce(c, ctx, workId, accountingId, body));
}
export async function recoverAttemptLiabilities(c: PoolClient, ctx: TenantContext, workId: string, branchId: string, attempts: any[], costs: any[]) {
  for (const row of attempts) {
    const attempt = row.body;
    if (costs.some(r => r.body.attemptId === row.id)) continue;
    await costOnce(c, ctx, workId, `delivery:${attempt.deliveryAttemptId}`, {
      branchId, attemptId: row.id, deliveryAttemptId: attempt.deliveryAttemptId, generation: attempt.generation,
      elapsedMs: null, reservedLiabilityMs: (attempt.reservedWallMs ?? LIMITS.wallMs) + 5000,
      usage: [], failure: 'CONTROLLER_LOST_BEFORE_USAGE_COMMIT', meterStatus: 'PHYSICAL_USAGE_UNKNOWN_RESERVATION_RETAINED',
      phases: ['PREPARATION', 'LAUNCH', 'EXECUTION', 'CHECKING', 'PUBLICATION', 'RECOVERY', 'STORAGE'],
      resourceReleaseObserved: false, externalOutcome: 'NOT_ESTABLISHED', parentIntervalsMayOverlap: true,
    });
  }
}
