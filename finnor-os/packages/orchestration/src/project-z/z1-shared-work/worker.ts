import { z } from 'zod';
import type { JobHandler } from '../../../../../apps/worker/src/queue';
import { runSharedWorkClaim, type Z1NativePorts } from '../../../../private-equity/src/project-z/z1-shared-work/owner';
import { requireZ1 } from '../../../../epistemic-runtime/src/project-z/z1-shared-work/contracts';

const PayloadSchema = z.object({
  tenantId: z.string().uuid(), principalId: z.string().uuid(), requestId: z.string().uuid(),
  generation: z.number().int().positive(), workIds: z.array(z.string().uuid()).min(2).max(1000),
}).strict();

/** Coordinator registration must bind real canonical ports. No fake default. */
export function createSharedWorkJobHandler(ports: Z1NativePorts): JobHandler {
  return async (value, claim) => {
    requireZ1(claim, 'ACTUAL_CANONICAL_JOB_CLAIM_REQUIRED', 'REVOKED');
    const parsed = PayloadSchema.safeParse(value);
    requireZ1(parsed.success && new Set(parsed.data.workIds).size === parsed.data.workIds.length,
      'CANONICAL_SHARED_WORK_JOB_PAYLOAD_REQUIRED');
    await runSharedWorkClaim(parsed.data, claim, ports);
  };
}
