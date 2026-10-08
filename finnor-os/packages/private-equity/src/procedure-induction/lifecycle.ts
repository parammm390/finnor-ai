import type { PeMutationContext } from '../types';
import { principal, revisions, sha, stable, tx } from '../evidence-execution/store';
import { CounterexampleSchema, boundedJson, componentRef } from './contracts';
import { appendProcedureEvent, authorizeInduction, capsuleRow, inductionRow } from './store';

export const capsuleDependencyKey = (principalId: string, capsuleId: string) => 'p6-capsule:' + principalId + ':' + capsuleId;
export async function recordProcedureCounterexample(ctx: PeMutationContext, body: unknown) {
  boundedJson(body, 8192);
  const input = CounterexampleSchema.parse(body), capsule = await capsuleRow(ctx, input.capsuleId);
  const row = await inductionRow(ctx, capsule.induction_id);
  await authorizeInduction(ctx, row);
  const notice = {
    schema: 'finnor.p6.counterexample.v1', tenantId: ctx.auth.tenantId, principalId: principal(ctx),
    capsuleId: capsule.id, capsuleDigest: capsule.digest, moduleRef: capsule.body.module,
    type: input.type, reason: input.reason, qualification: 'AUTHENTICATED_HUMAN_NOTICE_NOT_AUTOMATIC_SCIENTIFIC_TRUTH',
    admissionChanged: false, moduleChanged: false,
  };
  const ref = componentRef('counterexample', notice), key = capsuleDependencyKey(principal(ctx), capsule.id);
  return tx(ctx, async c => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7601))',
      [ctx.auth.tenantId + ':' + principal(ctx) + ':' + capsule.id]);
    const eventKey = 'counterexample:' + input.idempotencyKey;
    const existing = (await c.query<{ body: unknown; digest: string }>(
      `SELECT body,digest FROM finnor_os.p6_events WHERE tenant_id=$1 AND principal_id=$2
       AND induction_id=$3 AND idempotency_key=$4`, [row.tenant_id, principal(ctx), row.id, eventKey])).rows[0];
    if (existing) {
      if (sha(existing.body) !== existing.digest || stable(existing.body) !== stable(notice))
        throw Error('P6_COUNTEREXAMPLE_IDEMPOTENCY_CONFLICT');
      return { ref, replayed: true, dependentInvalidationKey: key, executionAuthorityGranted: false };
    }
    await appendProcedureEvent(ctx, row, 'COUNTEREXAMPLE', notice, eventKey, c, capsule.id);
    await c.query(`INSERT INTO finnor_os.p6_invalidations(tenant_id,principal_id,capsule_id,ref,reason)
      VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT DO NOTHING`,
    [row.tenant_id, principal(ctx), capsule.id, stable(ref), input.type]);
    await revisions(ctx, [key], c, true);
    await c.query('UPDATE finnor_os.p4_source_revisions SET revision=revision+1 WHERE tenant_id=$1 AND key=$2',
      [row.tenant_id, key]);
    return { ref, replayed: false, dependentInvalidationKey: key, executionAuthorityGranted: false };
  });
}
