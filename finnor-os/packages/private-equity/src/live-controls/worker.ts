import { z } from 'zod';
import { acquireComputeResourceLeases, renewComputeResourceLeases, releaseComputeResourceLeases,
  withDatabaseExecutionDeadline, DatabaseExecutionDeadlineError, ComputeCapacityUnavailableError } from '@finnor/db';
import type { PoolClient } from 'pg';
import type { JobExecutionContext } from '../../../../apps/worker/src/queue';
import type { PeMutationContext } from '../types';
import { peClientTransaction } from '../repository';
import { nativeConsequence } from './native';
import { publishedConsequence } from './projection';
import { resolveControlBudget, debitControlBudgetTx } from './budget';
import { LiveControlError, type ControlConsequence } from './contracts';
import { actor, appendHistory, assertActorActionTx, assertBranchUsableTx, assertVector, branchRow, controlTransaction, currentOwnerVectorTx, digest,
  sessionRow, type EvaluationRow } from './store';

const payloadSchema = z.object({ tenantId: z.string().uuid(), principalId: z.string().uuid(), sessionId: z.string().uuid(),
  branchId: z.string().uuid(), evaluationId: z.string().uuid(), workId: z.string().uuid(), originalDeadlineAt: z.string().datetime() }).strict();
async function evaluationRow(ctx: PeMutationContext, id: string, client: PoolClient) {
  const row = (await client.query<EvaluationRow>(`SELECT e.*,c.original_budget,c.delivery_session_id,c.owner_vector,
    c.claim_token,c.claim_fence,c.charged,c.cost_refs,c.result_private result
    FROM finnor_os.v5_evaluations e JOIN finnor_os.v5_evaluation_custody c ON c.tenant_id=e.tenant_id AND c.evaluation_id=e.id
    WHERE e.tenant_id=$1 AND e.principal_id=$2 AND e.id=$3 FOR UPDATE OF e,c`, [ctx.auth.tenantId, actor(ctx), id])).rows[0];
  if (!row) throw new LiveControlError('ORIGINAL_EVALUATION_UNAVAILABLE', 'The original accepted evaluation is unavailable');
  return row;
}
async function physicalClaim(ctx: PeMutationContext, x: Readonly<JobExecutionContext>, client: PoolClient) {
  if (!(await client.query(`SELECT id FROM finnor_os.jobs WHERE tenant_id=$1 AND id=$2 AND type='evaluate_live_control_v1'
    AND status='running' AND claim_token=$3 AND claim_fence=$4 AND lease_expires_at>clock_timestamp() FOR SHARE`,
  [ctx.auth.tenantId, x.jobId, x.claimToken, x.claimFence])).rowCount) throw new LiveControlError('PHYSICAL_EVALUATION_CLAIM_FENCED', 'The actual durable evaluation claim is no longer current', 409);
}
async function deliveryCurrent(ctx: PeMutationContext, row: EvaluationRow, client: PoolClient) {
  if (!(await client.query(`SELECT session_id FROM finnor_os.auth_delivery_sessions WHERE tenant_id=$1 AND principal_id=$2
    AND session_id=$3 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`,
  [ctx.auth.tenantId, actor(ctx), row.delivery_session_id])).rowCount) throw new LiveControlError('ORIGINAL_DELIVERY_ENDED', 'The original delivery session ended; cost and responsibility remain', 401);
}
async function currentEvaluator(ctx: PeMutationContext, session: import('./store').SessionRow, client: PoolClient) {
  await assertActorActionTx(ctx, { operation: 'action', capability: 'action:propose_control',
    resources: [{ type: 'work', id: session.work_id }, { type: session.root.entityType, id: session.root.entityId }, session.focus],
    risk: 'low', workId: session.work_id }, client);
}
export async function runLiveControlEvaluationJob(raw: Record<string, unknown>, x?: Readonly<JobExecutionContext>): Promise<void> {
  const input = payloadSchema.parse(raw);
  if (!x || x.protocolVersion !== 1 || x.tenantId !== input.tenantId) throw new Error('V5_ACTUAL_DURABLE_JOB_CONTEXT_REQUIRED');
  const deadline = Date.parse(input.originalDeadlineAt), monotone = performance.now() + Math.max(0, deadline - Date.now());
  return withDatabaseExecutionDeadline(monotone, () => evaluate(input, x));
}
async function evaluate(input: z.infer<typeof payloadSchema>, x: Readonly<JobExecutionContext>) {
  const ctx: PeMutationContext = { auth: { tenantId: input.tenantId, userId: input.principalId,
    employeeId: input.principalId, role: 'owner' }, provenance: { sourceSystem: 'V5:registered-native-consequence', createdBy: input.principalId } };
  const started = performance.now(), cpu = process.cpuUsage(), rss = process.memoryUsage().rss;
  let leases: Awaited<ReturnType<typeof acquireComputeResourceLeases>> = [], released = false;
  let admitted = false;
  try {
    const original = await controlTransaction(ctx, async client => {
      const session = await sessionRow(ctx, input.sessionId, client), branch = await branchRow(ctx, session, input.branchId, client);
      const row = await evaluationRow(ctx, input.evaluationId, client);
      if (session.work_id !== input.workId || row.branch_id !== branch.id || row.session_id !== session.id || row.job_id !== x.jobId)
        throw new LiveControlError('ORIGINAL_EVALUATION_BINDING_CHANGED', 'The accepted job does not bind this original control request', 409);
      if (['COMPLETE', 'PARTIAL', 'FAILED', 'INVALIDATED', 'BLOCKED'].includes(row.status)) return null;
      await currentEvaluator(ctx, session, client);
      await assertBranchUsableTx(ctx, branch, client);
      await physicalClaim(ctx, x, client);
      await deliveryCurrent(ctx, row, client);
      assertVector(row.owner_vector, await currentOwnerVectorTx(ctx, session, branch.resources, client));
      if (!row.original_budget || row.original_budget.deadlineAt !== input.originalDeadlineAt)
        throw new LiveControlError('ORIGINAL_NATIVE_BUDGET_CHANGED', 'The accepted original budget or deadline differs', 409);
      return { session, branch, row };
    }, { worker: true, financialFence: true });
    if (!original) return;
    const current = await resolveControlBudget(ctx, original.session, original.branch);
    if (!current || digest(current.grant) !== digest(original.row.original_budget!.grant)
      || current.binding.capacity < original.row.original_budget!.binding.capacity)
      throw new LiveControlError('ORIGINAL_NATIVE_GRANT_FENCED', 'The original native grant cannot be replaced or enlarged');
    leases = await acquireComputeResourceLeases({ resourceKeys: ['native:p2'], requiredResourceKeys: ['native:p2'],
      tenantId: ctx.auth.tenantId, workloadClass: 'INTERACTIVE', ownerId: 'v5:' + x.deliveryAttemptId });
    x.registerHeartbeat(async () => released || renewComputeResourceLeases(leases));
    await controlTransaction(ctx, async client => {
      const row = await evaluationRow(ctx, input.evaluationId, client);
      await physicalClaim(ctx, x, client);
      await deliveryCurrent(ctx, row, client);
      await currentEvaluator(ctx, original.session, client);
      await assertBranchUsableTx(ctx, original.branch, client);
      assertVector(row.owner_vector, await currentOwnerVectorTx(ctx, original.session, original.branch.resources, client));
      const debit = await debitControlBudgetTx(ctx, original.session, row.original_budget!, client, 'NATIVE_CONSEQUENCE', row.id);
      await client.query(`UPDATE finnor_os.v5_evaluation_custody SET charged=true,claim_token=$3,claim_fence=$4,
        cost_refs=cost_refs||$5::jsonb WHERE tenant_id=$1 AND evaluation_id=$2`,
      [ctx.auth.tenantId, row.id, x.claimToken, x.claimFence, JSON.stringify([{ ...debit, jobId: x.jobId, deliveryAttemptId: x.deliveryAttemptId }])]);
      await client.query("UPDATE finnor_os.v5_evaluations SET status='RUNNING',updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
        [ctx.auth.tenantId, row.id]);
      await appendHistory(ctx, original.session, original.branch, 'NATIVE_CONSEQUENCE_ATTEMPT', { evaluationId: row.id,
        originalGrantDebited: true, refundsPermitted: false, costUSD: null }, client);
    }, { worker: true, financialFence: true });
    admitted = true;
    const native = await nativeConsequence(ctx, original.session, original.branch);
    if (!await renewComputeResourceLeases(leases)) throw new LiveControlError('NATIVE_CAPACITY_LEASE_FENCED', 'The actual native compute lease is no longer current');
    const usage = { elapsedMs: performance.now() - started, cpu: process.cpuUsage(cpu),
      rssBeforeBytes: rss, rssAfterBytes: process.memoryUsage().rss,
      accountingScope: 'WORKER_PROCESS_INTERVAL_NOT_EXCLUSIVE_CONTAINER_PEAK', costUSD: null };
    const result: ControlConsequence = { ...native, result: { native: native.result, originalDeadlineAt: original.row.original_budget!.deadlineAt },
      costs: { status: 'LOCAL_COST_UNMETERED', refs: [], usage } };
    await controlTransaction(ctx, async client => {
      const row = await evaluationRow(ctx, input.evaluationId, client);
      await physicalClaim(ctx, x, client);
      await deliveryCurrent(ctx, row, client);
      await currentEvaluator(ctx, original.session, client);
      if (row.claim_token !== x.claimToken || Number(row.claim_fence) !== x.claimFence || row.status !== 'RUNNING'
        || Date.parse(row.original_budget!.deadlineAt) <= Date.now()) throw new LiveControlError('NATIVE_PUBLICATION_FENCED', 'The original producer publication fence changed', 409);
      await assertBranchUsableTx(ctx, original.branch, client);
      assertVector(row.owner_vector, await currentOwnerVectorTx(ctx, original.session, original.branch.resources, client));
      result.costs.refs = row.cost_refs;
      const published = publishedConsequence(result, false)!;
      const publicResult: ControlConsequence = { ...result, refs: [], result: { native: published.result,
        originalDeadlineAt: row.original_budget!.deadlineAt }, costs: { status: 'LOCAL_COST_UNMETERED', refs: [], usage: { privateOriginalCostCustody: true, costUSD: null } } };
      await client.query('UPDATE finnor_os.v5_evaluation_custody SET result_private=$3::jsonb WHERE tenant_id=$1 AND evaluation_id=$2',
        [ctx.auth.tenantId, row.id, JSON.stringify(result)]);
      await client.query('UPDATE finnor_os.v5_evaluations SET status=$3,result=$4::jsonb,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2',
        [ctx.auth.tenantId, row.id, result.status, JSON.stringify(publicResult)]);
      await appendHistory(ctx, original.session, original.branch, 'NATIVE_CONSEQUENCE_PUBLISHED', { evaluationId: row.id,
        status: result.status, modelRelative: true, reservesCapital: false, executionAuthorityGranted: false, materialCostMeterGap: true }, client);
    }, { worker: true, financialFence: true });
  } catch (error) {
    // The original queue defers temporary capacity without erasing the accepted
    // evaluation or treating a predecessor's live permit as a terminal refusal.
    if (error instanceof DatabaseExecutionDeadlineError || error instanceof ComputeCapacityUnavailableError) throw error;
    const code = error instanceof LiveControlError ? error.code : 'ORIGINAL_NATIVE_OWNER_PREDICATE_UNPASSED';
    // Retain custody without serving private result bytes after rights loss.
    await peClientTransaction(ctx, async client => {
      const row = await evaluationRow(ctx, input.evaluationId, client);
      await physicalClaim(ctx, x, client);
      if (['COMPLETE', 'PARTIAL', 'FAILED', 'INVALIDATED', 'BLOCKED'].includes(row.status)) return;
      const status = /FENCED|CHANGED|ENDED|EXPIRED|WITHDRAWN/.test(code) ? 'INVALIDATED' : admitted ? 'FAILED' : 'BLOCKED';
      await client.query('UPDATE finnor_os.v5_evaluations SET status=$3,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2',
        [ctx.auth.tenantId, row.id, status]);
    }).catch(() => undefined);
    throw error;
  } finally {
    released = true;
    if (leases.length) await releaseComputeResourceLeases(leases, 'v5_native_consequence_finished').catch(() => undefined);
  }
}
