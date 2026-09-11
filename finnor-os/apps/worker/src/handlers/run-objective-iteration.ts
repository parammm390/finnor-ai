import { FinnorOrchestrator, recoverRunnableObjectives } from "@finnor/orchestration";
import type { JobHandler } from "../queue";

let orchestrator: FinnorOrchestrator | null = null;

export const runObjectiveIteration: JobHandler = async (payload) => {
  const tenantId = String(payload.tenantId ?? "");
  const workId = String(payload.workId ?? "");
  const objectiveLoopId = String(payload.objectiveLoopId ?? "");
  if (!tenantId || !workId || !objectiveLoopId) throw new Error("run_objective_iteration requires tenantId, workId, and objectiveLoopId");
  orchestrator ??= new FinnorOrchestrator();
  await orchestrator.runObjectiveIteration({
    tenantId,
    workId,
    objectiveLoopId,
    ...(Number.isInteger(payload.expectedRevision) ? { expectedRevision: Number(payload.expectedRevision) } : {}),
    ...(Number.isInteger(payload.expectedStepNumber) ? { expectedStepNumber: Number(payload.expectedStepNumber) } : {}),
    deferToWorkforceJob: true,
  });
};

export const recoverObjectives: JobHandler = async (payload) => {
  const tenantId = String(payload.tenantId ?? "");
  if (!tenantId) throw new Error("recover_objectives requires tenantId");
  await recoverRunnableObjectives(tenantId);
};
