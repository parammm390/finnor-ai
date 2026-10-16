import { randomUUID } from 'node:crypto';
import { chooseEnterpriseControlBranch, readEnterpriseContingentPolicy } from '../enterprise-control';
import { tx } from '../evidence-execution/store';
import { r3Digest } from '../../../epistemic-runtime/src/incentive-rule-synthesis/launcher';
import { assertR3Current } from './owners';
import type { PeMutationContext } from '../types';
import { r3Event, r3Request, type R3RequestRow } from './store';

/** Preregistered actual X callee. No invented negotiation method or new grant. */
export const R3_FALLBACK_CONTRACT = Object.freeze({
  version: 'r3-existing-s4-disposition-v1', callee: 'chooseEnterpriseControlBranch',
  source: 'finnor-os/packages/private-equity/src/enterprise-control.ts',
  domain: 'CURRENT_ORIGINAL_NUMERIC_CONTINGENT_POLICY_INITIAL_NODE_NO_PRIVATE_REPORTS',
  compatibleNegotiationMethod: 'NO_S8_ADMITTED_MECHANISM_OR_NEGOTIATION_ROUTE_PRESENT_IN_PINNED_OWNER_CONTEXT',
  grant: 'ORIGINAL_R3_REQUEST_S5_COMPUTE_GRANT', deadline: 'ORIGINAL_ABSOLUTE_DEADLINE',
  resultBasis: 'EXISTING_S4_NUMERIC_OWNER_DISPOSITION_NOT_R3_DSIC',
});
export async function executeR3Fallback(ctx: PeMutationContext, row: R3RequestRow, requested: 'INQUIRE' | 'WAIT' | 'STOP') {
  if (Date.now() >= row.deadline_at.getTime()) return { status: 'UNKNOWN', reason: 'ORIGINAL_DEADLINE_EXHAUSTED_NO_FALLBACK_CHILD_STARTED', contract: R3_FALLBACK_CONTRACT };
  await assertR3Current(ctx, row, undefined, false, true);
  const native = await readEnterpriseContingentPolicy(ctx, row.binding.incumbentPolicyRef);
  if (native.problem.continuation) throw Error('R3_REGISTERED_FALLBACK_INITIAL_DOMAIN_ONLY');
  const id = randomUUID(), original = { contract: R3_FALLBACK_CONTRACT, requestedDisposition: requested,
    originalGrant: row.request.budget_grant_ref, originalEpisode: row.id, originalDeadlineAt: row.deadline_at.toISOString(),
    inputDigest: r3Digest(row.problem), chargedInvocations: 1, costs: { usd: null, basis: 'UNMETERED_OWNER_OPERATION' } };
  await tx(ctx, async c => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['s5-portfolio:' + row.tenant_id]);
    const locked = await r3Request(ctx, row.id, c, true);
    if (locked.generation !== row.generation || ['CANCELLED','INVALIDATED'].includes(locked.status) ||
      Date.now() >= locked.deadline_at.getTime()) throw Error('R3_ORIGINAL_FALLBACK_ADMISSION_FENCED');
    const grant = (await c.query("SELECT envelopes FROM finnor_os.s5_reservations WHERE tenant_id=$1 AND reservation_id=$2 AND status<>'RELEASED' AND revocation_reason IS NULL FOR SHARE", [row.tenant_id, row.binding.grant.reservationRef.id])).rows[0];
    if (!grant || r3Digest(grant.envelopes.find((e: {resourceId:string}) => e.resourceId === row.binding.grant.resourceId)) !== r3Digest(row.binding.grant.envelope))
      throw Error('R3_ORIGINAL_COMPUTE_GRANT_CHANGED');
    await c.query('INSERT INTO finnor_os.p2_grant_usage(tenant_id,principal_id,grant_digest,resource_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [row.tenant_id,row.principal_id,row.binding.grant.ref.contentDigest,row.binding.grant.resourceId]);
    if (!(await c.query('UPDATE finnor_os.p2_grant_usage SET spent=spent+1 WHERE tenant_id=$1 AND principal_id=$2 AND grant_digest=$3 AND resource_id=$4 AND spent+1<=$5 RETURNING spent',
      [row.tenant_id,row.principal_id,row.binding.grant.ref.contentDigest,row.binding.grant.resourceId,row.binding.grant.capacity])).rowCount)
      throw Error('R3_SHARED_ORIGINAL_S5_NATIVE_GRANT_EXHAUSTED');
    if (!(await c.query('UPDATE finnor_os.r3_requests SET attempts_used=attempts_used+1 WHERE tenant_id=$1 AND id=$2 AND attempts_used<$3 AND deadline_at>clock_timestamp() RETURNING attempts_used',
      [row.tenant_id,row.id,row.request.limits.maxAttempts])).rowCount) throw Error('R3_ORIGINAL_FALLBACK_ATTEMPT_BOUND');
    await c.query("INSERT INTO finnor_os.r3_attempts(id,tenant_id,principal_id,request_id,delivery_id,phase,status,claim_fence,body,digest) VALUES($1,$2,$3,$4,$1,'FALLBACK','SUBMITTED',0,$5::jsonb,$6)",
      [id,row.tenant_id,row.principal_id,row.id,JSON.stringify(original),r3Digest(original)]);
    await r3Event(ctx, locked, 'FALLBACK_ATTEMPT_CHARGED_BEFORE_CALLEE', { attemptId:id,...original }, c);
  });
  const started = performance.now();
  let result;
  try { result = await chooseEnterpriseControlBranch(ctx, { policyRef: native.ref,
    decision: { knowledgeAt: new Date().toISOString(), period: 0, actionHistory: [], observations: [],
      rightsRef: native.bindings.rightsRef, obligations: native.problem.obligations, allocationRefs: [] } });
  } catch (error) {
    await tx(ctx, async c => {
      const body = { ...original, failure: error instanceof Error ? error.message : 'R3_FALLBACK_UNKNOWN', elapsedMs:performance.now()-started,
        originalChargeRetained:true, newEpisode:false };
      await c.query("UPDATE finnor_os.r3_attempts SET status='UNKNOWN',body=$3::jsonb,digest=$4 WHERE tenant_id=$1 AND id=$2",
        [row.tenant_id,id,JSON.stringify(body),r3Digest(body)]);
      await r3Event(ctx,row,'FALLBACK_FAILURE_RETAINED',{attemptId:id,...body},c);
    }); throw error;
  }
  const selected = native.problem.actions.find(a => a.id === result.actionId);
  const disposition = selected && ['INQUIRE', 'WAIT', 'STOP'].includes(selected.kind)
    ? selected.kind : 'ESCALATE_OWNER';
  const output = { contract: R3_FALLBACK_CONTRACT, actualCalleeResult: result, requestedDisposition: requested,
    permittedDisposition: disposition, negotiationAbsent: R3_FALLBACK_CONTRACT.compatibleNegotiationMethod,
    elapsedMs: performance.now() - started, newEpisode: false, deadlineRenewed: false,
    inheritedTruthfulness: false, costs: { usd: null, basis: 'UNMETERED_OWNER_OPERATION' }, executionAuthorityGranted: false };
  await tx(ctx, async c => {
    const locked = await r3Request(ctx, row.id, c, true);
    const current = locked.generation === row.generation && !['CANCELLED','INVALIDATED'].includes(locked.status) && Date.now() < locked.deadline_at.getTime();
    const body = { ...original, ...output, current };
    await c.query("UPDATE finnor_os.r3_attempts SET status=$3,body=$4::jsonb,digest=$5 WHERE tenant_id=$1 AND id=$2",
      [row.tenant_id,id,current?'RETURNED':'LATE',JSON.stringify(body),r3Digest(body)]);
    await r3Event(ctx, locked, current?'ACTUAL_EXISTING_X_FALLBACK':'FALLBACK_LATE_RESULT_RETAINED', { attemptId: id, ...body }, c);
    if (!current) output.permittedDisposition = 'ESCALATE_OWNER';
  });
  return output;
}
