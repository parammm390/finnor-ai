import { sql } from "drizzle-orm";
import type { Db } from "@finnor/db";
import { CapabilityEngineError } from "@finnor/tools/capabilities/python-runner";
import { z } from "zod";

export const CapabilityJobClaimSchema = z.object({ jobId: z.string().uuid(), claimToken: z.string().uuid(), claimFence: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER), workerId: z.string().min(1).max(512) });
export type CapabilityJobClaim = z.infer<typeof CapabilityJobClaimSchema>;

export async function assertCurrentClaim(db: Db, claim: CapabilityJobClaim, tenantId: string): Promise<void> {
  const result = await db.execute(sql`SELECT id FROM finnor_os.jobs WHERE id=${claim.jobId}::uuid AND tenant_id=${tenantId}::uuid
    AND status='running' AND claim_token=${claim.claimToken}::uuid AND claim_fence=${claim.claimFence}
    AND lease_owner=${claim.workerId} AND lease_expires_at>clock_timestamp() FOR SHARE`);
  if (!result.rows.length) throw new CapabilityEngineError("CAPABILITY_STALE_JOB_CLAIM");
}
