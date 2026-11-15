import type { PeMutationContext } from "../types";
import { persistEconomicRecord, persistEconomicRecordTx } from "../economic-store";
import type { NativeRef, ServiceProjection } from "./contracts";
import { hash } from "./contracts";
import type { ServiceRequestRow } from "./store";
import type { JobExecutionContext } from "../../../../apps/worker/src/queue";
import type { PoolClient } from "pg";

export async function persistServiceCompute(ctx: PeMutationContext, row: ServiceRequestRow,
  execution: Readonly<JobExecutionContext>, input: {
    startedAt: string; elapsedMs: number; cpuMicroseconds: number; stage: string; status: string;
    charge: NativeRef | null; predicate: string | null; rightsRef: string;
  }) {
  return persistEconomicRecord(ctx, {
    kind: "COMPUTE", rightsRef: input.rightsRef,
    idempotencyKey: `w3-physical:${execution.deliveryAttemptId}`,
    validAt: new Date().toISOString(), horizon: "H0",
    uncertainty: "Measured process time and sampled RSS only. Aggregate memory, money, provider billing and human labor remain unknown.",
    dependencies: [row.parent_allocation, row.budget_obligation_ref, ...(input.charge ? [input.charge] : [])],
    ...(row.s7_estimand_id ? { estimandId: row.s7_estimand_id } : {}),
    payload: {
      schema: "finnor.w3.physical-compute.v1", workId: row.work_id,
      originalBusinessAssignmentId: row.business_assignment_id, originalBusinessAssignments: 1, requestId: row.id,
      generation: row.generation, jobId: execution.jobId, deliveryAttemptId: execution.deliveryAttemptId,
      claimFence: execution.claimFence, ...input, sampledProcessRssBytes: process.memoryUsage().rss,
      money: null, humanSeconds: null, aggregateMemoryByteSeconds: null,
      evidenceClass: "CONTROLLED", nativeResourceReleaseGranted: false,
    },
  });
}
export async function persistServiceProjection(ctx: PeMutationContext, row: ServiceRequestRow,
  input: { projection: ServiceProjection | null; gaps: string[]; artifactDigest: string | null; digest: string;
    rightsRef: string }, c: PoolClient) {
  const semanticInput = {
    kind: "MEASUREMENT" as const, rightsRef: input.rightsRef, idempotencyKey: "w3-observation:" + input.digest,
    horizon: "H0" as const,
    uncertainty: "Original authenticated observations and protected S6 readback. No causal, sensory, professional, economic or field qualification is conferred.",
    dependencies: [row.parent_allocation, row.budget_obligation_ref],
    ...(row.s7_estimand_id ? { estimandId: row.s7_estimand_id } : {}),
    payload: { schema: "finnor.w3.service-measurement.v1", requestId: row.id, workId: row.work_id,
      businessAssignmentId: row.business_assignment_id, originalBusinessAssignments: 1,
      artifactDigest: input.artifactDigest, projection: input.projection, gaps: input.gaps,
      evidenceClass: "CONTROLLED", elapsedFieldServiceEstablished: false,
      causalAttributionGranted: false, resourceReleaseGranted: false, fieldValidated: false },
  };
  // Publication time is sampled only for the first immutable record. Replaying
  // the same owner request returns that original record and both original times.
  // Bind every semantic field, not just the caller's projection identity.
  return persistEconomicRecordTx(ctx, { ...semanticInput,
    validAt: new Date().toISOString(), semanticRequestDigest: hash(semanticInput) }, c);
}
