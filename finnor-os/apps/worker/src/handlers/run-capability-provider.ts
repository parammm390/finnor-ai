import { z } from "zod";
import { executeCapabilityRun } from "../../../../packages/orchestration/src/capabilities/execution";
import type { JobHandler } from "../queue";

const payloadSchema = z.object({ tenantId: z.string().uuid(), principalId: z.string().uuid(), runId: z.string().uuid(), _correlationId: z.string().optional() });
export const runCapabilityProvider: JobHandler = async (payload, context) => {
  const parsed = payloadSchema.parse(payload);
  if (!context || context.tenantId !== parsed.tenantId) throw new Error("CAPABILITY_TRUSTED_JOB_CONTEXT_REQUIRED");
  await executeCapabilityRun({ tenantId: parsed.tenantId, userId: parsed.principalId, employeeId: parsed.principalId, role: "owner", correlationId: parsed._correlationId }, parsed.runId, context);
};
