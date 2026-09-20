import { businessEffects, withTenant, workflowSteps } from "@finnor/db";
import { and, eq, sql } from "drizzle-orm";
import { EXECUTION_COMPENSATABLE_STEP_TYPES, type BusinessEffectSet } from "@finnor/shared-types";
import { recordRuntimeOperatorControlTx, type RuntimeOperatorControlRequest } from "./operator-controls";

export type CompensationInitiationResult =
  | { initiated: true; compensationCaseId: string }
  | { initiated: false; reason: "not_found" | "version_conflict" | "illegal_state" | "unsupported_compensation" };

/**
 * Fail-closed compensation initiation boundary. The current production registry has
 * no typed compensation binding, so this records the authorized rejection instead of
 * creating a fantasy inverse or mutating original Effect truth. A future real binding
 * must create a new authorized BusinessEffect before this can return initiated=true.
 */
export async function initiateCompensation(
  tenantId: string,
  workflowStepId: string,
  request: RuntimeOperatorControlRequest,
): Promise<CompensationInitiationResult> {
  return withTenant(tenantId, async (db) => {
    await db.execute(sql`SELECT id FROM ${workflowSteps}
      WHERE ${workflowSteps.tenantId}=${tenantId}
        AND ${workflowSteps.id}=${workflowStepId}::uuid FOR UPDATE`);
    const [step] = await db.select({
      id: workflowSteps.id,
      status: workflowSteps.status,
      stepType: workflowSteps.stepType,
      businessEffectId: workflowSteps.businessEffectId,
      dispatchGeneration: workflowSteps.dispatchGeneration,
      claimFence: workflowSteps.claimFence,
    }).from(workflowSteps).where(and(
      eq(workflowSteps.tenantId, tenantId),
      eq(workflowSteps.id, workflowStepId),
    )).limit(1);
    const audit = (outcome: "conflict" | "rejected", reasonCode: string, effect?: BusinessEffectSet) => recordRuntimeOperatorControlTx(db, tenantId, {
      controlType: "compensation_initiation",
      targetType: "workflow_step",
      targetId: workflowStepId,
      expectedVersion: request.expectedVersion,
      observedFence: step?.claimFence ?? null,
      actorId: request.actorId,
      authorityDecisionId: request.authorityDecisionId,
      reason: request.reason,
      evidence: {
        reasonCode,
        stepType: step?.stepType ?? null,
        originalBusinessEffectId: step?.businessEffectId ?? null,
        reversibility: effect?.reversibility ?? null,
        registeredCompensationStepTypes: [...EXECUTION_COMPENSATABLE_STEP_TYPES],
      },
      outcome,
      controlKey: request.controlKey,
    });
    if (!step) {
      await audit("rejected", "not_found");
      return { initiated: false, reason: "not_found" };
    }
    if (step.dispatchGeneration !== request.expectedVersion) {
      await audit("conflict", "version_conflict");
      return { initiated: false, reason: "version_conflict" };
    }
    if (step.status !== "completed" || !step.businessEffectId) {
      await audit("rejected", "illegal_state");
      return { initiated: false, reason: "illegal_state" };
    }
    const [effectRow] = await db.select({ effect: businessEffects.effect, status: businessEffects.status }).from(businessEffects).where(and(
      eq(businessEffects.tenantId, tenantId),
      eq(businessEffects.id, step.businessEffectId),
    )).limit(1);
    const effect = effectRow?.effect as BusinessEffectSet | undefined;
    const declaredCompensatable = Boolean(effect
      && effect.reversibility.classification === "compensatable"
      && effect.reversibility.compensationCapability
      && (EXECUTION_COMPENSATABLE_STEP_TYPES as readonly string[]).includes(step.stepType));
    if (!effectRow || effectRow.status !== "verified" || !declaredCompensatable) {
      await audit("rejected", "unsupported_compensation", effect);
      return { initiated: false, reason: "unsupported_compensation" };
    }
    // Deliberately unreachable in the current tree. Merely declaring an inverse in a
    // payload is not a registered executable/verified compensation implementation.
    await audit("rejected", "no_typed_compensation_binding", effect);
    return { initiated: false, reason: "unsupported_compensation" };
  });
}
