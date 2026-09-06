// B2.T6: terminal workflow-step failures are repaired asynchronously so the worker
// never performs a new business action inline. FinnorOrchestrator persists a new,
// lineaged plan and sends it through the normal confirmation gate.

import { FinnorOrchestrator } from "@finnor/orchestration";
import type { JobHandler } from "../queue";

let orchestrator: FinnorOrchestrator | null = null;

export const repairPlanAfterTerminalFailure: JobHandler = async (payload) => {
  const tenantId = String(payload.tenantId ?? "");
  const domainActionId = String(payload.domainActionId ?? "");
  const workflowStepId = String(payload.workflowStepId ?? "");
  if (!tenantId || !domainActionId || !workflowStepId) throw new Error("repair_plan_after_terminal_failure requires tenantId, domainActionId, and workflowStepId");
  orchestrator ??= new FinnorOrchestrator();
  await orchestrator.repairPlanAfterTerminalFailure(tenantId, domainActionId, workflowStepId);
};
