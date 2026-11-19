import type { PoolClient } from "pg";
import type { PeMutationContext } from "../../types";
import { principal } from "../../evidence-execution/store";
import { z3Fault, type ViabilityDelivery, type ViabilitySessionRow } from "./contracts";

/** Must run in the SAME transaction as the write. SHARE locks prevent lease
 * owner/token/fence/payload changes until commit. clock_timestamp checks the
 * actual lease, not the session overlay or a transaction-start timestamp. */
export async function assertViabilityJobLeaseTx(ctx: PeMutationContext,
  row: Pick<ViabilitySessionRow, "id" | "tenant_id" | "principal_id" | "work_id">,
  delivery: ViabilityDelivery, c: PoolClient): Promise<{ leaseExpiresAt: string; leaseRemainingMs: number }> {
  const job = delivery.physical;
  if (job.tenantId !== row.tenant_id || ctx.auth.tenantId !== row.tenant_id
    || principal(ctx) !== row.principal_id || job.protocolVersion !== 1
    || job.retrySafety !== "reconcilable" || !Number.isSafeInteger(job.claimFence) || job.claimFence < 1) {
    z3Fault("Z3_ACTUAL_DURABLE_DELIVERY_REQUIRED");
  }
  const found = (await c.query<{ lease_expires_at: Date; lease_remaining_ms: number }>(
    `SELECT j.lease_expires_at,
       (extract(epoch FROM (j.lease_expires_at-clock_timestamp()))*1000)::double precision lease_remaining_ms
     FROM finnor_os.jobs j
     JOIN finnor_os.job_delivery_attempts a ON a.job_id=j.id AND a.tenant_id=j.tenant_id
     WHERE j.tenant_id=$1 AND j.id=$2 AND j.type=$3 AND j.protocol_version=1
       AND j.retry_safety='reconcilable' AND j.status='running'
       AND j.claim_token=$4 AND j.claim_fence=$5 AND j.lease_owner=$6
       AND j.lease_expires_at>clock_timestamp()
       AND j.payload=$8::jsonb
       AND a.id=$7 AND a.claim_token=j.claim_token AND a.claim_fence=j.claim_fence
       AND a.worker_id=$6 AND a.protocol_version=1 AND a.retry_safety='reconcilable'
       AND a.outcome='running' AND a.finished_at IS NULL
     FOR SHARE OF j,a`,
    [row.tenant_id, job.jobId, delivery.jobType, job.claimToken, job.claimFence, job.workerId,
      job.deliveryAttemptId, JSON.stringify({ tenantId: row.tenant_id, principalId: row.principal_id,
        sessionId: row.id, workId: row.work_id })])).rows[0];
  if (!found || !Number.isFinite(found.lease_remaining_ms) || found.lease_remaining_ms <= 0) {
    z3Fault("Z3_ACTUAL_DURABLE_DELIVERY_EXPIRED_OR_CHANGED");
  }
  return { leaseExpiresAt: found.lease_expires_at.toISOString(), leaseRemainingMs: found.lease_remaining_ms };
}
