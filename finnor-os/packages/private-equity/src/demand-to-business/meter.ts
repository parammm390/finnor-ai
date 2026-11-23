import type { PoolClient } from "pg";
import type { JobExecutionContext } from "../../../../apps/worker/src/queue";
import type { PeMutationContext } from "../types";
import { persistEconomicRecord, persistEconomicRecordTx } from "../economic-store";
import { hash, type BusinessProjection, type NativeRef } from "./contracts";
import type { GrowthRequestRow } from "./store";

export async function persistGrowthCompute(ctx: PeMutationContext, row: GrowthRequestRow,
  execution: Readonly<JobExecutionContext>, input: {
    startedAt: string; elapsedMs: number; cpuMicroseconds: number; stage: string; status: string;
    predicate: string | null; charge: NativeRef | null; rightsRef: string;
  }) {
  return persistEconomicRecord(ctx, {
    kind: "COMPUTE", rightsRef: input.rightsRef, idempotencyKey: "w4-physical:" + execution.deliveryAttemptId,
    validAt: new Date().toISOString(), horizon: "H0",
    uncertainty: "Actual process elapsed/CPU and sampled RSS. Provider billing, aggregate memory, human time and money are not measured.",
    dependencies: [row.parent_allocation, row.budget_obligation_ref, ...(input.charge ? [input.charge] : [])],
    ...(row.s7_estimand_id ? { estimandId: row.s7_estimand_id } : {}),
    payload: { schema: "finnor.w4.physical-compute.v1", workId: row.work_id, requestId: row.id,
      originalBusinessAssignmentId: row.business_assignment_id, originalBusinessAssignments: 1,
      generation: row.generation, jobId: execution.jobId, deliveryAttemptId: execution.deliveryAttemptId,
      claimFence: execution.claimFence, ...input, sampledProcessRssBytes: process.memoryUsage().rss,
      money: null, humanSeconds: null, aggregateMemoryByteSeconds: null,
      evidenceClass: "CONTROLLED", nativeResourceReleaseGranted: false },
  });
}
export async function persistGrowthProjection(ctx: PeMutationContext, row: GrowthRequestRow,
  input: { projection: BusinessProjection | null; gaps: string[]; artifactDigest: string | null; digest: string;
    rightsRef: string }, c: PoolClient) {
  const semanticInput = {
    kind: "MEASUREMENT" as const, rightsRef: input.rightsRef, idempotencyKey: "w4-observation:" + input.digest,
    horizon: "H0" as const, uncertainty: "Controlled authenticated source originals and original S6 readback. No causal increment, field validation, protected receipt, or qualified profit.",
    dependencies: [row.parent_allocation, row.budget_obligation_ref, ...(input.projection?.accounting.canonicalAccountingRefs ?? [])],
    ...(row.s7_estimand_id ? { estimandId: row.s7_estimand_id } : {}),
    payload: { schema: "finnor.w4.business-measurement.v1", workId: row.work_id, requestId: row.id,
      businessAssignmentId: row.business_assignment_id, originalBusinessAssignments: 1,
      artifactDigest: input.artifactDigest, projection: input.projection, gaps: input.gaps, evidenceClass: "CONTROLLED",
      fieldValidated: false, causalAttributionGranted: false, s7ProfitQualified: false, resourceReleaseGranted: false },
  };
  return persistEconomicRecordTx(ctx, { ...semanticInput, validAt: new Date().toISOString(),
    semanticRequestDigest: hash(semanticInput) }, c);
}
