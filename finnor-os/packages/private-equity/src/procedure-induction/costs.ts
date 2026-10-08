import type { PeMutationContext } from '../types';
import { principal, sha, tx } from '../evidence-execution/store';
import { capsuleRow, inductionRow, authorizeInduction } from './store';

/** Failed inductions without a capsule still retain their charged deliveries. */
export async function inductionCostHistory(ctx: PeMutationContext, inductionId: string) {
  const row = await inductionRow(ctx, inductionId);
  await authorizeInduction(ctx, row);
  const records = await tx(ctx, async c => ({
    events: (await c.query(`SELECT kind,body,digest FROM finnor_os.p6_events
      WHERE tenant_id=$1 AND principal_id=$2 AND induction_id=$3 ORDER BY created_at,id LIMIT 513`,
    [ctx.auth.tenantId, principal(ctx), row.id])).rows,
    deliveries: (await c.query(`SELECT a.id,a.job_id,a.claim_fence,a.outcome,a.started_at,a.finished_at,a.failure_kind
      FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts a ON a.job_id=j.id AND a.tenant_id=j.tenant_id
      WHERE j.tenant_id=$1 AND j.type='run_procedure_induction_v1'
        AND j.payload->>'principalId'=$2 AND j.payload->>'inductionId'=$3
      ORDER BY a.started_at,a.id LIMIT 129`,
    [ctx.auth.tenantId, principal(ctx), row.id])).rows,
  }), true);
  if (records.events.length > 512 || records.deliveries.length > 128) throw Error('P6_COST_HISTORY_BOUND');
  for (const event of records.events) if (sha(event.body) !== event.digest)
    throw Error('P6_COST_EVENT_PREIMAGE_INVALID');
  return { ...records, synthesisAttemptsUsed: row.attempts_used, dollars: null,
    status: 'OBSERVED_RECORDS_NOT_COMPLETE_BILLING', economicCreditGranted: false };
}

/** Complete observed local records, not a pricebook or an economic estimator.
 * Unknown build/maintenance/correction dollars can never become zero. */
export async function procedureCostLedger(ctx: PeMutationContext, capsuleId: string) {
  const capsule = await capsuleRow(ctx, capsuleId), induction = await inductionRow(ctx, capsule.induction_id);
  await authorizeInduction(ctx, induction);
  const records = await tx(ctx, async c => ({
    induction: (await c.query(`SELECT kind,body,digest FROM finnor_os.p6_events
      WHERE tenant_id=$1 AND principal_id=$2 AND induction_id=$3 ORDER BY created_at,id`,
    [ctx.auth.tenantId, principal(ctx), induction.id])).rows,
    uses: (await c.query(`SELECT e.request_id,e.kind,e.body FROM finnor_os.p1_events e
      JOIN finnor_os.p1_requests r ON r.id=e.request_id AND r.tenant_id=e.tenant_id AND r.principal_id=e.principal_id
      WHERE e.tenant_id=$1 AND e.principal_id=$2 AND r.request->'procedure'->>'capsuleId'=$3
        AND (e.kind LIKE 'P6_%' OR e.kind IN('ISOLATED_MODULE_EXECUTION','P4_CURRENT_PRODUCER_COST','FAILED_OR_FENCED'))
      ORDER BY e.created_at,e.id`, [ctx.auth.tenantId, principal(ctx), capsuleId])).rows,
  }), true);
  for (const event of records.induction) if (sha(event.body) !== event.digest)
    throw Error('P6_COST_EVENT_PREIMAGE_INVALID');
  return {
    schema: 'finnor.p6.observed-cost-ledger.v1', capsuleId, records,
    inductionDeliveryHistory: await inductionCostHistory(ctx, induction.id),
    retainedSourceEpisodeCosts: capsule.body.costs, dollars: null, status: 'UNQUALIFIED_TOTAL_COST',
    missing: ['COMPLETE_INDUCTION_PREPARATION_HUMAN_TIME', 'COMPILER_BUILD_PRICING',
      'INDEPENDENT_TESTING_COST', 'CORRECTION_TIME', 'FUTURE_MAINTENANCE_AND_RECOVERY',
      'REAL_REUSE_HORIZON', 'RECONCILED_PRICEBOOK_AND_BILLING'],
    localInvocationsAreNotIndependentSamples: true, economicCreditGranted: false,
  };
}
