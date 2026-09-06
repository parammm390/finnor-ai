// LangGraph state for the gate pipeline — mirrors GatedExecutor's local variables
// exactly (validation, draft, result), plus alreadyApproved which replaces the old
// `action.status !== "approved"` check (see executor.ts for why).

import { Annotation } from "@langchain/langgraph";
import type { DomainPolicy, ValidationResult, DraftAction, ExecutionResult } from "@finnor/shared-types";

export const GateStateAnnotation = Annotation.Root({
  actionId: Annotation<string>,
  tenantId: Annotation<string>,
  actionType: Annotation<string>,
  payload: Annotation<Record<string, unknown>>,
  policy: Annotation<DomainPolicy>,
  alreadyApproved: Annotation<boolean>,
  validation: Annotation<ValidationResult | undefined>,
  draft: Annotation<DraftAction | undefined>,
  groundingError: Annotation<{ code: string; message: string; details: Record<string, unknown> } | undefined>,
  decision: Annotation<"approve" | "reject" | undefined>,
  result: Annotation<ExecutionResult | undefined>,
  // Phase 16(e): threaded from DomainAction.correlationId at invoke time (see
  // graph/executor.ts) so the gate node's voice_confirm_request/voice_notify_failure
  // enqueues can tag it too — optional, so existing checkpointed runs without it
  // (started before this field existed) simply resume with it undefined.
  correlationId: Annotation<string | undefined>,
  workId: Annotation<string | undefined>,
  initiatedBy: Annotation<string | undefined>,
  approvedBy: Annotation<string | undefined>,
  authorityOutcome: Annotation<"allowed" | "denied" | "approval_required" | undefined>,
  authorityDecisionId: Annotation<string | undefined>,
  authorityReasonCode: Annotation<string | undefined>,
  requiresGate: Annotation<boolean | undefined>,
});

export type GateState = typeof GateStateAnnotation.State;
