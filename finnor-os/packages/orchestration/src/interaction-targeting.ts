import type { OperatingInteractionContext } from "@finnor/shared-types";
import { effectiveInteractionTargets } from "./interaction-context";

export interface PlannedInteractionAction {
  action_type: string;
  payload: Record<string, unknown>;
  reasoning?: string;
  depends_on?: number[];
}

function contextualReason(reasoning: string | undefined): string {
  const suffix = "The target was deterministically grounded from explicit current context.";
  return reasoning ? `${reasoning} ${suffix}` : suffix;
}

const PE_TARGET_FIELDS: Readonly<Record<string, string>> = {
  pe_deal: "dealId",
  pe_workstream: "workstreamId",
  pe_request: "requestId",
  pe_deliverable: "deliverableId",
  pe_finding: "findingId",
  pe_deal_risk: "dealRiskId",
  pe_dependency: "dependencyId",
  pe_milestone: "milestoneId",
  pe_closing_condition: "closingConditionId",
  pe_closing_item: "closingItemId",
};

/** Bind only active Core/PE references before schema validation and authority. */
export function applyOperatingInteractionTargets<T extends PlannedInteractionAction>(
  actions: T[],
  context: OperatingInteractionContext | null | undefined,
): T[] {
  if (!context) return actions;
  const targets = effectiveInteractionTargets(context);
  const selectedWork = targets.filter((ref) => ref.entityType === "work");
  return actions.map((action) => {
    let payload = action.payload;
    if (selectedWork.length === 1 && action.action_type === "handoff_work") {
      payload = { ...payload, workRef: { workId: selectedWork[0]!.entityId } };
    }
    for (const target of targets) {
      const field = PE_TARGET_FIELDS[target.entityType];
      if (field && !(field in payload)) payload = { ...payload, [field]: target.entityId };
    }
    return payload === action.payload
      ? action
      : { ...action, payload, reasoning: contextualReason(action.reasoning) } as T;
  });
}
