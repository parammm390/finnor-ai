import type { businessEffects, workflowRuns, workflowSteps } from "@finnor/db";
import type { WorkflowRetryBlocker } from "@finnor/shared-types";

export const WORKFLOW_CONTROL_VERBS = ["pause", "resume", "cancel", "retry", "escalate"] as const;
export type RunControlVerb = (typeof WORKFLOW_CONTROL_VERBS)[number];
type RunStatus = (typeof workflowRuns.$inferSelect)["status"];

export interface TransitionSpec {
  verb: RunControlVerb;
  fromStatuses: RunStatus[];
  toStatus: RunStatus;
}

export const RUN_CONTROL_TRANSITIONS: Readonly<Record<RunControlVerb, TransitionSpec>> = {
  pause: { verb: "pause", fromStatuses: ["running"], toStatus: "paused" },
  resume: { verb: "resume", fromStatuses: ["paused"], toStatus: "running" },
  cancel: { verb: "cancel", fromStatuses: ["running", "paused"], toStatus: "cancelled" },
  retry: { verb: "retry", fromStatuses: ["failed"], toStatus: "running" },
  escalate: { verb: "escalate", fromStatuses: ["running", "failed"], toStatus: "escalated" },
};

type RetryStep = Pick<typeof workflowSteps.$inferSelect, "status" | "executionState" | "effectCommitAt" | "businessEffectId">;
type EffectStatus = (typeof businessEffects.$inferSelect)["status"];

export function workflowRetryBlocker(input: {
  steps: readonly RetryStep[];
  effectStatuses: ReadonlyMap<string, EffectStatus>;
  truncated?: boolean;
  unresolvedEffect: boolean;
}): WorkflowRetryBlocker | null {
  if (input.truncated) return { code: "incomplete_steps", reason: "The workflow step history is incomplete." };
  if (input.unresolvedEffect) return { code: "unresolved_effect", reason: "Resolve the unverified effect before retrying." };
  const failed = input.steps.filter((step) => step.status === "failed");
  if (!failed.length) return { code: "no_failed_step", reason: "There is no failed workflow step to retry." };
  for (const step of failed) {
    if (step.executionState !== "authorized" && step.executionState !== "failed_before_effect"
      && !(step.executionState === "claimed" && !step.effectCommitAt)) {
      return { code: "step_not_retryable", reason: "The failed step is blocked or requires reconciliation before retrying." };
    }
    if (step.businessEffectId && input.effectStatuses.get(step.businessEffectId) !== "failed") {
      return { code: "effect_not_retryable", reason: "A recorded failure is required for every effect linked to a failed step." };
    }
  }
  return null;
}
