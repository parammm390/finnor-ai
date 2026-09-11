import { randomUUID } from "node:crypto";
import {
  enqueueAssignmentRecovery,
  finalizeWorkforceAssignment,
  FinnorOrchestrator,
  recordLearningObservationForAssignment,
  renewWorkforceAssignmentLease,
} from "@finnor/orchestration";
import type { JobHandler } from "../queue";

let orchestrator: FinnorOrchestrator | null = null;

/** The only P7 execution job. It resumes the exact unfinished P6 ObjectiveStep;
 * it never dispatches plugins/actions directly. */
export const runWorkforceAssignment: JobHandler = async (payload) => {
  const tenantId = String(payload.tenantId ?? "");
  const workId = String(payload.workId ?? "");
  const objectiveLoopId = String(payload.objectiveLoopId ?? "");
  const workforceAssignmentId = String(payload.workforceAssignmentId ?? "");
  if (!tenantId || !workId || !objectiveLoopId || !workforceAssignmentId) {
    throw new Error("run_workforce_assignment requires tenantId, workId, objectiveLoopId, and workforceAssignmentId");
  }
  const leaseOwner = randomUUID();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  orchestrator ??= new FinnorOrchestrator();
  try {
    heartbeat = setInterval(() => {
      void renewWorkforceAssignmentLease(tenantId, workforceAssignmentId, leaseOwner).catch(() => undefined);
    }, 10_000);
    heartbeat.unref?.();
    const outcome = await orchestrator.runObjectiveIteration({
      tenantId,
      workId,
      objectiveLoopId,
      workforceAssignmentId,
      workforceLeaseOwner: leaseOwner,
      ...(Number.isInteger(payload.expectedRevision) ? { expectedRevision: Number(payload.expectedRevision) } : {}),
      ...(Number.isInteger(payload.expectedStepNumber) ? { expectedStepNumber: Number(payload.expectedStepNumber) } : {}),
    });
    await finalizeWorkforceAssignment({ tenantId, assignmentId: workforceAssignmentId, leaseOwner, objectiveOutcome: outcome });
    await recordLearningObservationForAssignment(tenantId, workforceAssignmentId);
  } catch (error) {
    await finalizeWorkforceAssignment({ tenantId, assignmentId: workforceAssignmentId, leaseOwner, thrownFailure: error });
    await enqueueAssignmentRecovery(tenantId, workforceAssignmentId);
    throw error;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
};
