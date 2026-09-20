import {
  decisionReceipts,
  domainActions,
  workflowSteps,
  withTenant,
} from "@finnor/db";
import { executeAuthorizedEffectStep } from "@finnor/orchestration";
import type { ToolRegistry } from "@finnor/tools";
import { claimStep, stepFence } from "@finnor/workflow-runtime";
import { runWorkflowStep } from "../../../apps/worker/src/handlers/run-workflow-step";
import { and, asc, desc, eq } from "drizzle-orm";
import type { ExecutionResult } from "@finnor/shared-types";

/** Drive every currently runnable step causally owned by one DomainAction. Tests call
 * this only after asserting that approval itself caused no mutation. Production uses
 * the job queue; this helper deterministically invokes the exact same worker handler. */
export async function driveDurableAction(
  tenantId: string,
  domainActionId: string,
  tools?: ToolRegistry,
): Promise<ExecutionResult> {
  for (let pass = 0; pass < 64; pass++) {
    const pending = await withTenant(tenantId, (db) => db.select().from(workflowSteps).where(and(
      eq(workflowSteps.tenantId, tenantId),
      eq(workflowSteps.domainActionId, domainActionId),
      eq(workflowSteps.status, "pending"),
    )).orderBy(asc(workflowSteps.createdAt), asc(workflowSteps.sequence)));
    if (pending.length === 0) break;
    for (const step of pending) {
      if (tools && step.stepType === "execute_authorized_effect") {
        const claimed = await claimStep(tenantId, step.id);
        if (claimed) await executeAuthorizedEffectStep(tenantId, step.id, { tools }, stepFence(claimed));
      } else {
        await runWorkflowStep({ tenantId, workflowStepId: step.id });
      }
    }
  }

  const [action] = await withTenant(tenantId, (db) => db.select({ status: domainActions.status }).from(domainActions).where(and(
    eq(domainActions.tenantId, tenantId), eq(domainActions.id, domainActionId),
  )).limit(1));
  const [receipt] = await withTenant(tenantId, (db) => db.select().from(decisionReceipts).where(and(
    eq(decisionReceipts.tenantId, tenantId), eq(decisionReceipts.domainActionId, domainActionId),
  )).orderBy(desc(decisionReceipts.createdAt)).limit(1));
  const actual = (receipt?.actualResult ?? {}) as Record<string, unknown>;
  const output = (actual.output && typeof actual.output === "object" ? actual.output : actual) as Record<string, unknown>;
  if (action?.status === "completed") return { status: "success", output };
  const failure = (receipt?.failure ?? {}) as Record<string, unknown>;
  if (action?.status === "blocked_integration_unavailable") {
    return { status: "integration_unavailable", output, error: String(failure.message ?? "Integration unavailable"), errorKind: "provider_down" };
  }
  if (action?.status === "needs_human_review") {
    return { status: "failure", output, error: String(failure.message ?? "Execution needs human review"), errorKind: "unknown_outcome" };
  }
  return { status: "failure", output, error: String(failure.message ?? `Action remained ${action?.status ?? "unknown"}`), errorKind: "terminal" };
}
