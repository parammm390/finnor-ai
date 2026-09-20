import { createHash } from "node:crypto";
import type { PlanNode, RecoverySpec } from "@finnor/planning";

/**
 * The orchestration layer does not own external truth. This record is the
 * compact semantic boundary between evidence owned by the effect/runtime
 * system and advancement owned by the Objective/Plan scheduler.
 */
export interface VerificationResult {
  version: 1;
  state: "verified" | "divergent" | "inconclusive";
  planRevisionId: string;
  planNodeId: string;
  attemptNumber: number;
  subject: {
    kind: "query" | "action" | "wait" | "objective";
    id: string;
    businessEffectId?: string;
  };
  observationRefs: Array<{ type: string; id: string }>;
  verifier: { kind: "deterministic_rule" | "provider_readback" | "objective_condition"; rule: string };
  evidenceHash: string;
  establishedAt: string;
}

export type RecoveryDecisionKind =
  | "retry"
  | "wait"
  | "reconcile"
  | "replan"
  | "escalate"
  | "compensate"
  | "cancel"
  | "terminal_failure"
  | "continue";

/** Append-only durable decision body. The database row supplies its id/time. */
export interface RecoveryDecision {
  version: 1;
  decisionKey: string;
  kind: RecoveryDecisionKind;
  cause: "failure" | "stale" | "timeout" | "divergence" | "unknown_outcome" | "budget" | "deadline" | "cancellation" | "observation";
  workId: string;
  objectiveRevision: number;
  planRevisionId: string;
  planNodeId: string;
  objectiveStepId: string | null;
  attemptNumber: number;
  recoveryParentStepId: string | null;
  effectReversibility: "reversible" | "irreversible" | "not_applicable";
  verificationState: VerificationResult["state"] | null;
  retryHistory: { attempted: number; maximum: number };
  authorityState: "current" | "stale" | "denied" | "unknown";
  deadlineState: "available" | "exhausted";
  budgetState: "available" | "exhausted";
  reason: string;
  next: { mayExecute: boolean; requiresFreshAuthority: boolean; requiresReconciliation: boolean };
}

export interface RecoveryDecisionInput {
  workId: string;
  objectiveRevision: number;
  planRevisionId: string;
  node: PlanNode;
  objectiveStepId?: string | null;
  recoveryParentStepId?: string | null;
  attemptNumber: number;
  cause: RecoveryDecision["cause"];
  reason: string;
  verificationState?: VerificationResult["state"] | null;
  authorityState?: RecoveryDecision["authorityState"];
  deadlineExhausted?: boolean;
  budgetExhausted?: boolean;
  cancelled?: boolean;
  unknownExternalOutcome?: boolean;
  verifiedIrreversibleEffect?: boolean;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

export function orchestrationSemanticHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function recoveryKind(spec: RecoverySpec, input: RecoveryDecisionInput): RecoveryDecisionKind {
  // A stop request cannot erase uncertainty about an external side effect. Once
  // invocation may have happened (or an irreversible effect is verified), the
  // only safe transition is reconciliation; cancellation applies only to work
  // that is still provably pre-invocation.
  if (input.unknownExternalOutcome || input.verifiedIrreversibleEffect) return "reconcile";
  if (input.cancelled) return "cancel";
  if (input.deadlineExhausted || input.budgetExhausted) return spec.mode === "escalate" ? "escalate" : "terminal_failure";
  if (input.cause === "stale" || input.authorityState === "stale") return "replan";
  if (input.attemptNumber >= spec.maxAttempts && spec.mode === "retry") return "escalate";
  if (spec.mode === "recover") return "reconcile";
  return spec.mode;
}

/**
 * Pure recovery classifier. Ambiguity and verified irreversible history take
 * precedence over a node's declared retry preference.
 */
export function decideRecovery(input: RecoveryDecisionInput): RecoveryDecision {
  const kind = recoveryKind(input.node.recovery, input);
  const body = {
    version: 1 as const,
    kind,
    cause: input.cause,
    workId: input.workId,
    objectiveRevision: input.objectiveRevision,
    planRevisionId: input.planRevisionId,
    planNodeId: input.node.id,
    objectiveStepId: input.objectiveStepId ?? null,
    attemptNumber: input.attemptNumber,
    recoveryParentStepId: input.recoveryParentStepId ?? input.objectiveStepId ?? null,
    effectReversibility: input.node.kind === "action" ? (input.node.irreversible ? "irreversible" as const : "reversible" as const) : "not_applicable" as const,
    verificationState: input.verificationState ?? null,
    retryHistory: { attempted: input.attemptNumber, maximum: input.node.recovery.maxAttempts },
    authorityState: input.authorityState ?? "unknown" as const,
    deadlineState: input.deadlineExhausted ? "exhausted" as const : "available" as const,
    budgetState: input.budgetExhausted ? "exhausted" as const : "available" as const,
    reason: input.reason,
    next: {
      mayExecute: kind === "retry" || kind === "continue",
      requiresFreshAuthority: input.node.kind === "action" && (kind === "retry" || kind === "replan" || input.authorityState !== "current"),
      requiresReconciliation: kind === "reconcile",
    },
  };
  return { ...body, decisionKey: orchestrationSemanticHash(body) };
}

export function verificationResult(input: Omit<VerificationResult, "version" | "evidenceHash"> & { evidence: unknown }): VerificationResult {
  const body = {
    state: input.state,
    planRevisionId: input.planRevisionId,
    planNodeId: input.planNodeId,
    attemptNumber: input.attemptNumber,
    subject: input.subject,
    observationRefs: [...input.observationRefs].sort((left, right) => `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`)),
    verifier: input.verifier,
    establishedAt: input.establishedAt,
  };
  return { version: 1, ...body, evidenceHash: orchestrationSemanticHash({ ...body, evidence: input.evidence }) };
}
