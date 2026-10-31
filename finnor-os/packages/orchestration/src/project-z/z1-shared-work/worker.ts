import { z } from 'zod';
import type { JobHandler } from '../../../../../apps/worker/src/queue';
import { runSharedWorkClaim } from '../../../../private-equity/src/project-z/z1-shared-work/owner';
import { nativeSharedWorkPorts, runNativeProjectionClaim } from '../../../../private-equity/src/project-z/z1-shared-work/native';
import { RefSchema } from '../../../../private-equity/src/project-z/z1-shared-work/native-contracts';
import { requireZ1 } from '../../../../epistemic-runtime/src/project-z/z1-shared-work/contracts';

const PayloadSchema = z.object({
  tenantId: z.string().uuid(), principalId: z.string().uuid(), requestId: z.string().uuid(),
  generation: z.number().int().positive(), workIds: z.array(z.string().uuid()).min(2).max(1000),
}).strict();

/** Concrete native bindings, never an optional caller-supplied implementation. */
export function createSharedWorkJobHandler(): JobHandler {
  return async (value, claim) => {
    requireZ1(claim, 'ACTUAL_CANONICAL_JOB_CLAIM_REQUIRED', 'REVOKED');
    const parsed = PayloadSchema.safeParse(value);
    requireZ1(parsed.success && new Set(parsed.data.workIds).size === parsed.data.workIds.length,
      'CANONICAL_SHARED_WORK_JOB_PAYLOAD_REQUIRED');
    await runSharedWorkClaim(parsed.data, claim, nativeSharedWorkPorts);
  };
}
export function createSharedWorkProjectionJobHandler(): JobHandler {
  const schema = PayloadSchema.extend({ workIds: z.array(z.string().uuid()).min(1).max(1000),
    workId: z.string().uuid(), publication: RefSchema }).strict();
  return async (value, claim) => {
    requireZ1(claim, 'ACTUAL_CANONICAL_JOB_CLAIM_REQUIRED', 'REVOKED');
    const parsed = schema.safeParse(value);
    requireZ1(parsed.success && parsed.data.workIds.includes(parsed.data.workId), 'CANONICAL_ORIGINAL_PROJECTION_JOB_REQUIRED');
    await runNativeProjectionClaim(parsed.data, claim);
  };
}
