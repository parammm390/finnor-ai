import type { AttentionItem } from "@finnor/shared-types";

export interface WorkSummary {
  id: string;
  status: string;
  initialInstruction: string;
  executionModel: string | null;
  currentOwnerId: string | null;
  assignedTo: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkPlanRevisionView {
  id: string;
  revision: number;
  parentRevisionId: string | null;
  reason: string;
  status: string;
  goalSpec: unknown;
  constraintSet: unknown;
  planningSnapshot: unknown;
  validation: unknown;
  planGraph: unknown;
  score: unknown;
  graphHash: string;
  semanticHash: string;
  completionProof: unknown;
  selectedAt: string;
  completedAt: string | null;
}

export interface WorkActionView {
  id: string;
  actionType: string;
  status: string;
  planRevisionId: string | null;
  planNodeId: string | null;
  groundedPayload: unknown;
  predictedReceipt: unknown;
  createdAt: string;
}

export interface WorkEffectView {
  id: string;
  domainActionId: string | null;
  status: string;
  effect: unknown;
  observedResult: unknown;
  verification: unknown;
  semanticHash: string;
}

export interface WorkObjectiveStepView {
  id: string;
  stepNumber: number;
  phase: string;
  decisionKind: string | null;
  planRevisionId: string | null;
  planNodeId: string | null;
  observation: unknown;
  recoveryKind: string | null;
  failure: unknown;
  iterationOutcome: string | null;
  completedAt: string | null;
}

export interface WorkAggregateView {
  work: WorkSummary & {
    failure: unknown;
    recovery: unknown;
    finalOutcome: unknown;
  };
  planRevisions: WorkPlanRevisionView[];
  actions: WorkActionView[];
  businessEffects: WorkEffectView[];
  objectiveSteps: WorkObjectiveStepView[];
  queryExecutions: Array<{ id: string; status: string; intent: string; resultSummary: unknown }>;
  eventWaits: Array<{ id: string; status: string; eventType: string; deadlineAt: string | null; matchedEventId: string | null }>;
  receipts: Array<{ id: string; domainActionId: string | null; actualResult: unknown; failure: unknown; finalizedAt: string | null }>;
}

/** The backend rank is canonical. Returning the exact input reference makes any
 * accidental copy/sort/filter in this decision boundary observable in tests. */
export function attentionItemsInServerOrder(items: readonly AttentionItem[]): readonly AttentionItem[] {
  return items;
}

export function selectedPlanRevision(revisions: readonly WorkPlanRevisionView[]): WorkPlanRevisionView | null {
  const active = revisions.find((revision) => revision.status === "active");
  if (active) return active;
  for (let index = revisions.length - 1; index >= 0; index -= 1) {
    const revision = revisions[index];
    if (revision?.status === "completed") return revision;
  }
  return revisions.at(-1) ?? null;
}

export function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
