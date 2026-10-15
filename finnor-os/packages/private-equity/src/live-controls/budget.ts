import type { PoolClient } from 'pg';
import type { PeMutationContext } from '../types';
import { resolveNativeComputeGrant } from '../compute-search/owners';
import { debitNativeComputeAttemptTx } from '../compute-search/admission';
import { assertProgramCurrent, requestRow, trace } from '../program-synthesis/store';
import { LiveControlError } from './contracts';
import { actor, digest, type BranchRow, type SessionRow } from './store';
import { peClientTransaction } from '../repository';

export interface OriginalControlBudget {
  schema: 'finnor.v5.original-native-budget.v1';
  grant: NonNullable<BranchRow['consequence_grant']>;
  binding: Awaited<ReturnType<typeof resolveNativeComputeGrant>>;
  deadlineAt: string;
  programme: { requestId: string; episodeId: string; workInputId: string; planRevisionId: string } | null;
  steps: number;
  accounting: 'ORIGINAL_NATIVE_ATTEMPT_AND_OPTIONAL_P1_COUNTERS_NO_USD_CONVERSION';
}
/** The original installed owners resolve the grant. No session or browser can
 * manufacture an episode, default dollar budget or renewed deadline. */
export async function resolveControlBudget(ctx: PeMutationContext, session: SessionRow, branch: BranchRow): Promise<OriginalControlBudget | null> {
  if (!branch.consequence_grant) return null;
  const grant = branch.consequence_grant;
  const binding = await resolveNativeComputeGrant(ctx, grant.policyRef, grant.allocationRef);
  let deadlineAt = binding.validUntil, programme: OriginalControlBudget['programme'] = null;
  let steps = 1 + branch.resources.length;
  if (branch.intent.kind === 'UNDERWRITING_ASSUMPTIONS') {
    const count = await peClientTransaction(ctx, async c => (await c.query<{ n: number }>(
      "SELECT jsonb_array_length(model_definition->'nodes') n FROM finnor_os.underwriting_model_versions WHERE tenant_id=$1 AND id=$2",
      [ctx.auth.tenantId, branch.intent.kind === 'UNDERWRITING_ASSUMPTIONS' ? branch.intent.modelVersionId : null])).rows[0]?.n);
    if (!count) throw new LiveControlError('NATIVE_MODEL_BOUND_UNAVAILABLE', 'The installed native model bound is unavailable');
    steps += count * 3 + branch.intent.overrides.length;
  } else if (branch.intent.kind === 'S5_ALLOCATION') {
    steps += branch.intent.request.policyRefs.length * branch.intent.request.jointModel.scenarios.length;
  }
  if (grant.programmeRef) {
    const q = await requestRow(ctx, grant.programmeRef);
    await assertProgramCurrent(ctx, q);
    if (q.work_id !== session.work_id) throw new LiveControlError('ORIGINAL_WORK_GRANT_MISMATCH', 'The original P1 programme belongs to another Work');
    const episode = await peClientTransaction(ctx, async c => (await c.query<{ deadline_at: Date }>(
      'SELECT deadline_at FROM finnor_os.p1_episodes WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',
      [ctx.auth.tenantId, actor(ctx), q.episode_id])).rows[0]);
    if (!episode) throw new LiveControlError('ORIGINAL_EPISODE_UNAVAILABLE', 'The original accepted P1 episode is unavailable');
    deadlineAt = new Date(Math.min(Date.parse(deadlineAt), episode.deadline_at.getTime())).toISOString();
    programme = { requestId: q.id, episodeId: q.episode_id, workInputId: q.work_input_id, planRevisionId: q.plan_revision_id };
  }
  if (Date.parse(deadlineAt) <= Date.now()) throw new LiveControlError('ORIGINAL_DEADLINE_EXPIRED', 'The original native grant deadline expired');
  return { schema: 'finnor.v5.original-native-budget.v1', grant, binding, deadlineAt, programme, steps,
    accounting: 'ORIGINAL_NATIVE_ATTEMPT_AND_OPTIONAL_P1_COUNTERS_NO_USD_CONVERSION' };
}
export async function assertControlBudgetTx(ctx: PeMutationContext, session: SessionRow, budget: OriginalControlBudget, client: PoolClient) {
  if (Date.parse(budget.deadlineAt) <= Date.now()) throw new LiveControlError('ORIGINAL_DEADLINE_EXPIRED', 'The original native grant deadline expired');
  const horizon = budget.binding.resourceEnvelope.horizon, period = Math.floor((Date.now() - Date.parse(horizon.startAt)) / horizon.periodMs);
  if (period < 0 || period >= horizon.periods
    || budget.binding.resourceEnvelope.quantities.slice(0, period + 1).reduce((n, v) => n + Number(v), 0) !== budget.binding.capacity)
    throw new LiveControlError('ORIGINAL_NATIVE_HORIZON_FENCED', 'Transport and time cannot renew the accepted original compute horizon');
  const resource = (await client.query<{ body: { ref: unknown; revoked: boolean; validUntil: string } }>(
    `SELECT r.body FROM finnor_os.s5_resources r JOIN finnor_os.s5_resource_heads h USING(tenant_id,resource_id,revision)
     WHERE r.tenant_id=$1 AND r.resource_id=$2 FOR SHARE OF h`, [ctx.auth.tenantId, budget.binding.resourceId])).rows[0]?.body;
  if (!resource || resource.revoked || Date.parse(resource.validUntil) <= Date.now()
    || digest(resource.ref) !== digest(budget.binding.resourceRef)) throw new LiveControlError('ORIGINAL_NATIVE_RESOURCE_FENCED', 'The original native funding resource changed');
  const row = (await client.query(`SELECT r.status,r.revocation_reason,p.certificate
    FROM finnor_os.s5_proposals p JOIN finnor_os.s5_reservations r ON r.tenant_id=p.tenant_id AND r.allocation_digest=p.content_digest
    WHERE p.tenant_id=$1 AND p.principal_id=$2 AND p.content_digest=$3 FOR SHARE OF r`,
  [ctx.auth.tenantId, actor(ctx), budget.grant.allocationRef.contentDigest])).rows[0];
  if (!row || row.status === 'RELEASED' || row.revocation_reason
    || digest(row.certificate.ref) !== digest(budget.grant.allocationRef)
    || Date.parse(row.certificate.validUntil) <= Date.now()) throw new LiveControlError('ORIGINAL_NATIVE_GRANT_FENCED', 'The original S5 native compute reservation is no longer current');
  if (budget.programme) {
    const q = await requestRow(ctx, budget.programme.requestId, client, true);
    if (q.episode_id !== budget.programme.episodeId || q.work_id !== session.work_id
      || q.work_input_id !== budget.programme.workInputId || q.plan_revision_id !== budget.programme.planRevisionId)
      throw new LiveControlError('ORIGINAL_WORK_GRANT_MISMATCH', 'The original P1 programme binding changed');
    await assertProgramCurrent(ctx, q, client, true);
  }
}
export async function debitControlBudgetTx(ctx: PeMutationContext, session: SessionRow, budget: OriginalControlBudget, client: PoolClient,
  operation: string, identity: string) {
  await assertControlBudgetTx(ctx, session, budget, client);
  const debit = await debitNativeComputeAttemptTx(client, { tenantId: ctx.auth.tenantId, principalId: actor(ctx),
    grantDigest: budget.grant.allocationRef.contentDigest, resourceId: budget.binding.resourceId, capacity: budget.binding.capacity });
  if (budget.programme) {
    const admitted = await client.query(`UPDATE finnor_os.p1_episodes SET attempts_used=attempts_used+1,steps_used=steps_used+$4
      WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND attempts_used+1<=max_attempts
        AND steps_used+$4<=max_steps AND deadline_at>clock_timestamp() RETURNING attempts_used,steps_used`,
    [ctx.auth.tenantId, actor(ctx), budget.programme.episodeId, budget.steps]);
    if (!admitted.rowCount) throw new LiveControlError('ORIGINAL_P1_ENVELOPE_EXHAUSTED', 'The original P1 attempts/steps/deadline cannot fund this native operation');
    const q = await requestRow(ctx, budget.programme.requestId, client);
    await trace(ctx, q, 'OWNER_OPERATION_ATTEMPT', { operation, identity, originalEpisode: q.episode_id,
      nativeInvocations: [{ owner: 'V5/NATIVE', operation, evaluationOrProposalId: identity, costUSD: null,
        originalNativeGrantDebit: debit, accounting: 'ADMITTED_BEFORE_NATIVE_WORK_NOT_A_COMPLETED_INVOCATION' }] }, client);
  }
  return { ...debit, operation, identity, originalDeadlineAt: budget.deadlineAt, steps: budget.steps,
    usd: null, materialDollarMeterGap: true };
}
