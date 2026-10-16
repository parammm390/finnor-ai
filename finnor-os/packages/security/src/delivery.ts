import type { PoolClient } from 'pg';
import type { TenantContext } from '@finnor/shared-types';
import { withTenantClientTransaction } from '@finnor/db';
import { AuthVerificationError } from './auth';

/** Server-verified JWT facts only. Refreshing transport never renews an episode,
 * financial reservation, approval or original external operation. */
export async function assertDeliverySessionTx(ctx: TenantContext, client: PoolClient, register = false) {
  const witness = ctx.deliverySession;
  if (!witness || Date.parse(witness.expiresAt) <= Date.now()) throw new AuthVerificationError('Verified delivery session is unavailable or expired', 401);
  if (register) await client.query(
    `INSERT INTO finnor_os.auth_delivery_sessions(tenant_id,session_id,principal_id,subject,expires_at)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,session_id)
      DO UPDATE SET expires_at=greatest(auth_delivery_sessions.expires_at,excluded.expires_at)
       WHERE auth_delivery_sessions.principal_id=excluded.principal_id
         AND auth_delivery_sessions.subject=excluded.subject AND auth_delivery_sessions.revoked_at IS NULL`,
    [ctx.tenantId, witness.sessionId, ctx.employeeId ?? ctx.userId, witness.subject, witness.expiresAt]);
  const row = (await client.query(
    `SELECT session_id FROM finnor_os.auth_delivery_sessions WHERE tenant_id=$1 AND session_id=$2
      AND principal_id=$3 AND subject=$4 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`,
    [ctx.tenantId, witness.sessionId, ctx.employeeId ?? ctx.userId, witness.subject])).rows[0];
  if (!row) throw new AuthVerificationError('Verified delivery session is unavailable or expired', 401);
  return witness;
}

export async function endDeliverySession(ctx: TenantContext) {
  const witness = ctx.deliverySession;
  if (!witness) throw new AuthVerificationError('Verified delivery session is required', 401);
  await withTenantClientTransaction(ctx.tenantId, { userId: ctx.userId }, async client => {
    // First-use sign-out also installs the tombstone. A late request cannot
    // register this same provider session as active again.
    await client.query(`INSERT INTO finnor_os.auth_delivery_sessions
      (tenant_id,session_id,principal_id,subject,expires_at,revoked_at) VALUES($1,$2,$3,$4,$5,clock_timestamp())
      ON CONFLICT(tenant_id,session_id) DO UPDATE SET revoked_at=coalesce(auth_delivery_sessions.revoked_at,clock_timestamp())
       WHERE auth_delivery_sessions.principal_id=excluded.principal_id AND auth_delivery_sessions.subject=excluded.subject`,
    [ctx.tenantId,witness.sessionId,ctx.userId,witness.subject,witness.expiresAt]);
  });
  return { deliveryEnded: true, effectsCancelled: false, responsibilityRetained: true };
}
