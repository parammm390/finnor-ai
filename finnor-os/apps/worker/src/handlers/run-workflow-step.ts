import { claimStep, failStep, recoverStaleSteps } from "@finnor/workflow-runtime";
import {
  executeAuthorizedEffectStep,
  FinnorOrchestrator,
  resumeObjectiveForAction,
} from "@finnor/orchestration";
import { domainActions, reconcileWorkStatus, resolveTenantVertical, withTenant } from "@finnor/db";
import { and, eq } from "drizzle-orm";
import type { JobHandler } from "../queue";

async function resumeBusinessControllers(
  tenantId: string,
  domainActionId: string | null,
): Promise<void> {
  if (!domainActionId) return;
  const [action] = await withTenant(tenantId, (db) =>
    db
      .select({ workId: domainActions.workId })
      .from(domainActions)
      .where(and(eq(domainActions.tenantId, tenantId), eq(domainActions.id, domainActionId)))
      .limit(1),
  );
  if (action?.workId) await reconcileWorkStatus(tenantId, action.workId);
  await resumeObjectiveForAction(tenantId, domainActionId).catch(() => false);
  await new FinnorOrchestrator().resumePlanForAction(domainActionId, tenantId).catch(() => false);
}

/**
 * The only active Phase 5 workflow step is the generic, authority-frozen
 * BusinessEffect executor. Legacy Water capability step names remain readable in
 * history but can never be dispatched.
 */
export const runWorkflowStep: JobHandler = async (payload) => {
  const tenantId = String(payload.tenantId ?? "");
  const stepId = String(payload.workflowStepId ?? "");
  const rawGeneration = payload.workflowStepGeneration;
  const requestedGeneration =
    typeof rawGeneration === "number" &&
    Number.isSafeInteger(rawGeneration) &&
    rawGeneration >= 0
      ? rawGeneration
      : 0;
  if (!tenantId || !stepId) {
    throw new Error("run_workflow_step requires tenantId and workflowStepId");
  }

  await resolveTenantVertical(tenantId);
  await recoverStaleSteps(tenantId);
  const claimed = await claimStep(tenantId, stepId, requestedGeneration);
  if (!claimed) return;

  if (claimed.stepType !== "execute_authorized_effect") {
    await failStep(
      tenantId,
      stepId,
      `Workflow step "${claimed.stepType}" is historical and retired; Phase 5 permits only execute_authorized_effect`,
      "conflict",
    );
    return;
  }

  try {
    await executeAuthorizedEffectStep(tenantId, stepId);
    await resumeBusinessControllers(tenantId, claimed.domainActionId);
  } catch (error) {
    await failStep(
      tenantId,
      stepId,
      error instanceof Error ? error.message : "Authorized effect execution failed",
    );
  }
};
