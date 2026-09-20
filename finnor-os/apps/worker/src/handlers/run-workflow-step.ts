import { claimStep, failStep, heartbeatStepClaim, recoverStaleSteps, stepFence } from "@finnor/workflow-runtime";
import {
  executeAuthorizedEffectStep,
  FinnorOrchestrator,
  recordAuthorizedEffectIneligibility,
  revalidateAuthorizedEffectEligibility,
  resumeObjectiveForAction,
} from "@finnor/orchestration";
import { domainActions, reconcileWorkStatus, resolveTenantVertical, withTenant, workflowSteps } from "@finnor/db";
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
export const runWorkflowStep: JobHandler = async (payload, jobContext) => {
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

  // A stale/forged queue payload can name a tenant that no longer exists. Treat
  // that as a harmless no-op at the dispatch boundary; real database failures
  // still propagate so the queue can retry rather than silently losing work.
  try {
    await resolveTenantVertical(tenantId);
  } catch (error) {
    if (error instanceof Error && /^(Tenant not found|Tenant vertical identity is missing)$/.test(error.message)) return;
    throw error;
  }
  await recoverStaleSteps(tenantId);
  const [candidate] = await withTenant(tenantId, (db) => db.select({
    stepType: workflowSteps.stepType,
    domainActionId: workflowSteps.domainActionId,
    businessEffectId: workflowSteps.businessEffectId,
    protocolVersion: workflowSteps.protocolVersion,
  }).from(workflowSteps).where(and(
    eq(workflowSteps.tenantId, tenantId),
    eq(workflowSteps.id, stepId),
  )).limit(1));
  if (!candidate) return;
  let eligibilityEvidence: Record<string, unknown> = {
    version: 1,
    checkedAt: new Date().toISOString(),
    eligible: candidate.protocolVersion === 1,
    source: candidate.protocolVersion === 1 ? "legacy_protocol_1" : "runtime_preclaim",
  };
  if (candidate.protocolVersion >= 2) {
    // Direct handler invocation remains a test-only deterministic seam. Production
    // protocol-2 work must always arrive through JobQueue with a durable delivery
    // claim; the release gate separately proves that boundary with real DB sessions.
    const directTestInvocation = !jobContext && process.env.NODE_ENV === "test";
    if (!jobContext && !directTestInvocation) throw new Error("Protocol-2 workflow step requires job claim context");
    if (!candidate.domainActionId || !candidate.businessEffectId) {
      throw new Error("Protocol-2 consequential step lacks action/effect identity before claim");
    }
    if (!directTestInvocation) {
      const eligibility = await revalidateAuthorizedEffectEligibility(tenantId, candidate.domainActionId, candidate.businessEffectId);
      eligibilityEvidence = {
        version: 1,
        checkedAt: new Date().toISOString(),
        eligible: eligibility.allowed,
        source: "authority_policy_precondition_revalidation",
        ...(eligibility.allowed ? {} : { reason: eligibility.reason }),
      };
      if (!eligibility.allowed) {
        await recordAuthorizedEffectIneligibility({
          tenantId,
          workflowStepId: stepId,
          expectedDispatchGeneration: requestedGeneration,
          domainActionId: candidate.domainActionId,
          businessEffectId: candidate.businessEffectId,
          reason: eligibility.reason,
          evidence: eligibilityEvidence,
        });
        // Runtime records the failed eligibility fact and stops before claim. Scope 1
        // owns any later REPLAN / ESCALATE / CANCEL decision for the action/plan.
        await resumeBusinessControllers(tenantId, candidate.domainActionId);
        return;
      }
    }
  }
  const claimed = await claimStep(tenantId, stepId, requestedGeneration, jobContext ? {
    workerId: jobContext.workerId,
    jobDeliveryAttemptId: jobContext.deliveryAttemptId,
    jobProtocolVersion: jobContext.protocolVersion,
    eligibilityEvidence,
  } : undefined);
  if (!claimed) return;
  const fence = stepFence(claimed);
  jobContext?.registerHeartbeat(() => heartbeatStepClaim(tenantId, stepId, fence));

  if (claimed.stepType !== "execute_authorized_effect") {
    await failStep(
      tenantId,
      stepId,
      `Workflow step "${claimed.stepType}" is historical and retired; Phase 5 permits only execute_authorized_effect`,
      "conflict",
      fence,
    );
    return;
  }

  try {
    await executeAuthorizedEffectStep(tenantId, stepId, {}, fence);
    await resumeBusinessControllers(tenantId, claimed.domainActionId);
  } catch (error) {
    await failStep(
      tenantId,
      stepId,
      error instanceof Error ? error.message : "Authorized effect execution failed",
      "terminal",
      fence,
    );
  }
};
