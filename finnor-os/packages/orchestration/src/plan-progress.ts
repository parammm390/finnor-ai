import type { PlanGraph, PlanNode } from "@finnor/planning";
import type { RecoveryDecisionKind, VerificationResult } from "./orchestration-protocol";

export type PlanReplanCause = "observation" | "failure" | "stale" | "timeout";

export interface PlanProgressStep {
  id: string;
  stepNumber: number;
  planNodeId: string | null;
  queryExecutionId: string | null;
  domainActionId: string | null;
  iterationOutcome: string | null;
  failure: unknown;
  successVerification: unknown;
  completedAt: Date | string | null;
  attemptNumber?: number | null;
  objectiveRevision?: number | null;
  executionState?: string | null;
  claimOwner?: string | null;
  claimUntil?: Date | string | null;
  verificationResult?: unknown;
}

export interface PlanProgressInspection {
  actions: unknown[];
  businessEffects: unknown[];
  receipts: unknown[];
  eventWaits: unknown[];
  integrationEvents: unknown[];
}

export interface ReadyFrontierLimits {
  maxReady: number;
  maxConcurrent: number;
  activeClaims: number;
  remainingActions: number;
  remainingQueries: number;
  remainingWaits: number;
  remainingAttempts: number;
  remainingEstimatedCostMicros: number | null;
  planActive: boolean;
  workExecutable: boolean;
  cancelled: boolean;
  now: Date | string;
  deadlineAt: Date | string | null;
  objectiveRevision?: number;
  activeResourceKeys?: string[];
  invalidPreconditionRefs?: string[];
  forbiddenEffectHashes?: string[];
  /** Canonical cross-revision effect evidence. A VERIFIED irreversible effect is
   * reusable historical reality; an unresolved post-invocation effect is an
   * ambiguity fence. Neither may become a fresh execution attempt. */
  historicalIrreversibleEffects?: HistoricalIrreversibleEffectEvidence[];
}

export interface HistoricalIrreversibleEffectEvidence {
  nodeSemanticHash: string;
  sourcePlanRevisionId: string;
  sourcePlanNodeId: string;
  sourceObjectiveStepId: string | null;
  businessEffectId: string;
  state: "verified" | "unknown_outcome";
  effectStatus: string;
}

export interface PlanReadyUnit {
  node: PlanNode;
  attemptNumber: number;
  recoveryParentStepId: string | null;
  resourceKeys: string[];
  reservation: { kind: "query" | "action" | "wait" | "check"; estimatedCostMicros: number };
}

export type PlanFrontier =
  | { state: "ready"; ready: PlanReadyUnit[]; deferred: Array<{ nodeId: string; reason: string }>; observations: PlanNodeObservation[] }
  | { state: "waiting"; ready: []; waiting: Array<{ nodeId: string; reason: string }>; observations: PlanNodeObservation[] }
  | { state: "recovery"; ready: []; nodeId: string | null; cause: PlanReplanCause | "budget" | "deadline" | "cancellation"; recovery: RecoveryDecisionKind; reason: string; observations: PlanNodeObservation[] }
  | { state: "exhausted"; ready: []; reason: string; observations: PlanNodeObservation[] };

export type PlanProgress =
  | { state: "ready"; node: PlanNode }
  | { state: "waiting"; node: PlanNode; reason: string }
  | { state: "replan"; cause: PlanReplanCause; nodeId: string | null; reason: string };

export type PlanNodeObservation = {
  nodeId: string;
  state: "pending" | "claimed" | "satisfied" | "waiting" | "failed" | "unknown";
  reason?: string;
  cause?: PlanReplanCause | "unknown_outcome";
  stepId?: string;
  attemptNumber: number;
  verification?: VerificationResult | null;
  historicalEffect?: HistoricalIrreversibleEffectEvidence;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function hasFailure(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function rows(values: unknown[]): Record<string, unknown>[] {
  return values.map(record).filter((value): value is Record<string, unknown> => value !== null);
}

function nodeSteps(steps: PlanProgressStep[], nodeId: string): PlanProgressStep[] {
  return steps.filter((step) => step.planNodeId === nodeId)
    .sort((left, right) => (right.attemptNumber ?? 1) - (left.attemptNumber ?? 1) || right.stepNumber - left.stepNumber || right.id.localeCompare(left.id));
}

function attemptNumber(steps: PlanProgressStep[]): number {
  return Math.max(0, ...steps.map((step) => step.attemptNumber ?? 1));
}

function actionRecord(actionId: string, inspection: PlanProgressInspection): Record<string, unknown> | null {
  return rows(inspection.actions).find((item) => text(item.id) === actionId) ?? null;
}

function effectRecord(actionId: string, inspection: PlanProgressInspection): Record<string, unknown> | null {
  return rows(inspection.businessEffects).find((item) => text(item.domainActionId) === actionId) ?? null;
}

function receiptSatisfied(actionId: string, inspection: PlanProgressInspection): boolean {
  const receipt = rows(inspection.receipts).find((item) => text(item.domainActionId) === actionId);
  return Boolean(receipt?.finalizedAt && !hasFailure(receipt.failure));
}

function parseVerification(step: PlanProgressStep): VerificationResult | null {
  const candidate = record(step.verificationResult) ?? record(step.successVerification);
  if (!candidate || !["verified", "divergent", "inconclusive"].includes(String(candidate.state))) return null;
  return candidate as unknown as VerificationResult;
}

function observe(node: PlanNode, steps: PlanProgressStep[], inspection: PlanProgressInspection, now: Date): PlanNodeObservation {
  const history = nodeSteps(steps, node.id);
  const latest = history[0];
  const attempts = attemptNumber(history);
  if (!latest) return { nodeId: node.id, state: "pending", attemptNumber: 0 };
  if (latest.completedAt === null) {
    const claimUntil = latest.claimUntil ? new Date(latest.claimUntil) : null;
    if (!claimUntil || claimUntil > now || latest.executionState === "waiting") {
      return { nodeId: node.id, state: latest.executionState === "waiting" ? "waiting" : "claimed", reason: "The node already has a durable logical attempt.", stepId: latest.id, attemptNumber: attempts };
    }
    return { nodeId: node.id, state: "failed", cause: "stale", reason: "The node claim lease expired before its logical attempt reached a durable terminal state.", stepId: latest.id, attemptNumber: attempts };
  }
  const verification = parseVerification(latest);
  if (verification?.state === "verified") return { nodeId: node.id, state: "satisfied", stepId: latest.id, attemptNumber: attempts, verification };
  if (verification?.state === "divergent") return { nodeId: node.id, state: "failed", cause: "failure", reason: "Durable verification diverged from the node's expected effect.", stepId: latest.id, attemptNumber: attempts, verification };
  if (["blocked", "failed", "cancelled"].includes(latest.iterationOutcome ?? "") || hasFailure(latest.failure)) {
    return { nodeId: node.id, state: "failed", cause: "failure", reason: "The node's durable Objective attempt ended in failure.", stepId: latest.id, attemptNumber: attempts, verification };
  }
  if (node.kind === "query") {
    return latest.queryExecutionId
      ? { nodeId: node.id, state: "satisfied", stepId: latest.id, attemptNumber: attempts, verification }
      : { nodeId: node.id, state: "failed", cause: "failure", reason: "The query attempt completed without an Operational Query execution receipt.", stepId: latest.id, attemptNumber: attempts };
  }
  if (node.kind === "wait") {
    const wait = rows(inspection.eventWaits).find((item) => text(item.objectiveStepId) === latest.id);
    const status = text(wait?.status);
    if (status === "satisfied") return { nodeId: node.id, state: "satisfied", stepId: latest.id, attemptNumber: attempts, verification };
    if (status === "waiting") return { nodeId: node.id, state: "waiting", reason: "The exact durable event correlation is unresolved.", stepId: latest.id, attemptNumber: attempts };
    return { nodeId: node.id, state: "failed", cause: status === "timed_out" ? "timeout" : "stale", reason: `The durable wait is ${status ?? "missing"}.`, stepId: latest.id, attemptNumber: attempts };
  }
  if (node.kind === "check") {
    return latest.iterationOutcome === "completed"
      ? { nodeId: node.id, state: "satisfied", stepId: latest.id, attemptNumber: attempts, verification }
      : { nodeId: node.id, state: "failed", cause: "observation", reason: "The completion check did not produce VERIFIED objective truth.", stepId: latest.id, attemptNumber: attempts, verification };
  }
  if (!latest.domainActionId) return { nodeId: node.id, state: "failed", cause: "stale", reason: "The action attempt has no deterministic DomainAction.", stepId: latest.id, attemptNumber: attempts };
  const action = actionRecord(latest.domainActionId, inspection);
  const status = text(action?.status);
  if (!action) return { nodeId: node.id, state: "failed", cause: "stale", reason: "The attempt's DomainAction is absent from canonical Work state.", stepId: latest.id, attemptNumber: attempts };
  if (["pending", "approved", "executing", "needs_human_review", "blocked_integration_unavailable"].includes(status ?? "")) {
    return { nodeId: node.id, state: "waiting", reason: `The DomainAction is still ${status}.`, stepId: latest.id, attemptNumber: attempts };
  }
  if (["failed", "rejected"].includes(status ?? "")) return { nodeId: node.id, state: "failed", cause: "failure", reason: `The DomainAction ended in ${status}.`, stepId: latest.id, attemptNumber: attempts };
  if (status !== "completed") return { nodeId: node.id, state: "unknown", cause: "unknown_outcome", reason: `The DomainAction has unexpected state ${status ?? "unknown"}.`, stepId: latest.id, attemptNumber: attempts };
  const effect = effectRecord(latest.domainActionId, inspection);
  const effectStatus = text(effect?.status);
  if (node.observation.source === "decision_receipt") {
    return receiptSatisfied(latest.domainActionId, inspection)
      ? { nodeId: node.id, state: "satisfied", stepId: latest.id, attemptNumber: attempts, verification }
      : { nodeId: node.id, state: "failed", cause: "observation", reason: "The expected finalized DecisionReceipt is absent.", stepId: latest.id, attemptNumber: attempts };
  }
  if (node.observation.source === "integration_event") {
    const eventType = text(node.observation.assertion.eventType);
    const matched = rows(inspection.integrationEvents).some((event) => text(event.domainActionId) === latest.domainActionId && (!eventType || text(event.eventType) === eventType));
    return matched
      ? { nodeId: node.id, state: "satisfied", stepId: latest.id, attemptNumber: attempts, verification }
      : { nodeId: node.id, state: "failed", cause: "observation", reason: "The exact integration-event observation is absent.", stepId: latest.id, attemptNumber: attempts };
  }
  // Provider acknowledgement and worker completion never substitute for verified
  // external reality. provider_observation uses effect/readback state, never a
  // looser DecisionReceipt fallback.
  if (effectStatus === "verified") return { nodeId: node.id, state: "satisfied", stepId: latest.id, attemptNumber: attempts, verification };
  if (["compiled", "authorized", "executing", "executed", "partially_verified", "unverified"].includes(effectStatus ?? "")) {
    return { nodeId: node.id, state: "waiting", reason: `External reality is not verified; BusinessEffect is ${effectStatus}.`, stepId: latest.id, attemptNumber: attempts, verification };
  }
  if (effectStatus === "reconciliation_required" || (!effect && node.observation.source === "provider_observation")) {
    return { nodeId: node.id, state: "unknown", cause: "unknown_outcome", reason: "External mutation may have occurred but is not provable; reconciliation is required.", stepId: latest.id, attemptNumber: attempts, verification };
  }
  return { nodeId: node.id, state: "failed", cause: "observation", reason: `The required BusinessEffect verification is ${effectStatus ?? "missing"}.`, stepId: latest.id, attemptNumber: attempts, verification };
}

function resourceKeys(node: PlanNode): string[] {
  if (node.kind !== "action") return [];
  const keys = new Set<string>();
  for (const precondition of node.preconditions) {
    if (["entity_exists", "version_matches", "state_matches", "observation_satisfied"].includes(precondition.kind)) keys.add(`ref:${precondition.ref}`);
  }
  const visit = (value: unknown, path: string): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const next = path ? `${path}.${key}` : key;
      if (/^(?:id|.*Id|.*_id)$/i.test(key) && typeof item === "string" && item.length > 0) keys.add(`target:${next}:${item}`);
      else if (typeof item === "object") visit(item, next);
    }
  };
  visit(node.groundedPayload, "");
  return [...keys].sort();
}

function estimatedCost(node: PlanNode): number {
  const value = (node as PlanNode & { estimatedCostMicros?: number | null }).estimatedCostMicros;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function defaultLimits(): ReadyFrontierLimits {
  return {
    maxReady: 1,
    maxConcurrent: 1,
    activeClaims: 0,
    remainingActions: Number.MAX_SAFE_INTEGER,
    remainingQueries: Number.MAX_SAFE_INTEGER,
    remainingWaits: Number.MAX_SAFE_INTEGER,
    remainingAttempts: Number.MAX_SAFE_INTEGER,
    remainingEstimatedCostMicros: null,
    planActive: true,
    workExecutable: true,
    cancelled: false,
    now: new Date(0),
    deadlineAt: null,
  };
}

/** Deterministic, bounded executable frontier over canonical durable observations. */
export function resolvePlanFrontier(graph: PlanGraph, steps: PlanProgressStep[], inspection: PlanProgressInspection, limits: ReadyFrontierLimits): PlanFrontier {
  const now = new Date(limits.now);
  const historicalBySemanticHash = new Map<string, HistoricalIrreversibleEffectEvidence>();
  for (const evidence of [...(limits.historicalIrreversibleEffects ?? [])].sort((left, right) =>
    left.nodeSemanticHash.localeCompare(right.nodeSemanticHash)
      || left.sourcePlanRevisionId.localeCompare(right.sourcePlanRevisionId)
      || left.businessEffectId.localeCompare(right.businessEffectId))) {
    const current = historicalBySemanticHash.get(evidence.nodeSemanticHash);
    // Unknown outcome is the stronger safety fence. VERIFIED wins only when no
    // unresolved invocation of the same semantic irreversible effect exists.
    if (!current || (current.state === "verified" && evidence.state === "unknown_outcome")) {
      historicalBySemanticHash.set(evidence.nodeSemanticHash, evidence);
    }
  }
  const observations = graph.nodes.map((node) => {
    const historical = node.kind === "action" && node.irreversible
      ? historicalBySemanticHash.get(node.semanticHash)
      : undefined;
    if (historical?.state === "verified") return {
      nodeId: node.id,
      state: "satisfied" as const,
      reason: "A semantically identical irreversible BusinessEffect is already VERIFIED in canonical history.",
      stepId: historical.sourceObjectiveStepId ?? undefined,
      attemptNumber: 0,
      verification: null,
      historicalEffect: historical,
    };
    if (historical?.state === "unknown_outcome") return {
      nodeId: node.id,
      state: "unknown" as const,
      cause: "unknown_outcome" as const,
      reason: `A semantically identical irreversible BusinessEffect is ${historical.effectStatus}; reconcile before any replay.`,
      stepId: historical.sourceObjectiveStepId ?? undefined,
      attemptNumber: 0,
      verification: null,
      historicalEffect: historical,
    };
    return observe(node, steps, inspection, now);
  });
  if (!limits.planActive || !limits.workExecutable) return { state: "recovery", ready: [], nodeId: null, cause: "stale", recovery: "replan", reason: "The PlanRevision or Work is no longer executable.", observations };
  const ambiguous = graph.nodes.map((node) => ({ node, observation: observations.find((item) => item.nodeId === node.id)! }))
    .filter((entry) => entry.observation.state === "unknown" || entry.observation.cause === "unknown_outcome")
    .sort((left, right) => left.node.semanticHash.localeCompare(right.node.semanticHash))[0];
  if (limits.cancelled) return ambiguous
    ? { state: "recovery", ready: [], nodeId: ambiguous.node.id, cause: "cancellation", recovery: "reconcile", reason: ambiguous.observation.reason ?? "Cancellation raced an unknown external outcome; reconciliation is required.", observations }
    : { state: "recovery", ready: [], nodeId: null, cause: "cancellation", recovery: "cancel", reason: "Cancellation forbids new node execution.", observations };
  if (limits.deadlineAt && now >= new Date(limits.deadlineAt)) return ambiguous
    ? { state: "recovery", ready: [], nodeId: ambiguous.node.id, cause: "deadline", recovery: "reconcile", reason: ambiguous.observation.reason ?? "The deadline expired with an unknown external outcome; reconciliation is required.", observations }
    : { state: "recovery", ready: [], nodeId: null, cause: "deadline", recovery: "terminal_failure", reason: "The Objective deadline is exhausted.", observations };

  const byId = new Map(observations.map((observation) => [observation.nodeId, observation]));
  const failed = graph.nodes.map((node) => ({ node, observation: byId.get(node.id)! }))
    .filter((entry) => entry.observation.state === "failed" || entry.observation.state === "unknown")
    .sort((left, right) => left.node.semanticHash.localeCompare(right.node.semanticHash))[0];
  if (failed) {
    const unknown = failed.observation.state === "unknown" || failed.observation.cause === "unknown_outcome";
    const retryable = !unknown && failed.node.recovery.mode === "retry" && failed.observation.attemptNumber < failed.node.recovery.maxAttempts;
    if (!retryable) return {
      state: "recovery", ready: [], nodeId: failed.node.id,
      cause: failed.observation.cause === "unknown_outcome" ? "observation" : (failed.observation.cause ?? "failure"),
      recovery: unknown ? "reconcile" : failed.node.recovery.mode === "recover" ? "reconcile" : failed.node.recovery.mode,
      reason: failed.observation.reason ?? "The node requires deterministic recovery.", observations,
    };
  }

  const satisfied = new Set(observations.filter((item) => item.state === "satisfied").map((item) => item.nodeId));
  const priority: Record<PlanNode["kind"], number> = { query: 0, wait: 1, action: 2, check: 3 };
  const candidates = graph.nodes.filter((node) => {
    const observation = byId.get(node.id)!;
    const retry = observation.state === "failed" && node.recovery.mode === "retry" && observation.attemptNumber < node.recovery.maxAttempts;
    return (observation.state === "pending" || retry) && node.dependsOn.every((dependency) => satisfied.has(dependency));
  }).sort((left, right) => priority[left.kind] - priority[right.kind] || left.semanticHash.localeCompare(right.semanticHash));

  const slots = Math.max(0, Math.min(limits.maxReady, limits.maxConcurrent - limits.activeClaims));
  const occupied = new Set(limits.activeResourceKeys ?? []);
  const invalid = new Set(limits.invalidPreconditionRefs ?? []);
  const forbidden = new Set(limits.forbiddenEffectHashes ?? []);
  let actions = limits.remainingActions;
  let queries = limits.remainingQueries;
  let waits = limits.remainingWaits;
  let attempts = limits.remainingAttempts;
  let cost = limits.remainingEstimatedCostMicros;
  const ready: PlanReadyUnit[] = [];
  const deferred: Array<{ nodeId: string; reason: string }> = [];
  for (const node of candidates) {
    if (ready.length >= slots) { deferred.push({ nodeId: node.id, reason: "bounded concurrency frontier is full" }); continue; }
    if (attempts <= 0) { deferred.push({ nodeId: node.id, reason: "attempt budget exhausted" }); continue; }
    if (node.kind === "action" && actions <= 0) { deferred.push({ nodeId: node.id, reason: "action budget exhausted" }); continue; }
    if (node.kind === "query" && queries <= 0) { deferred.push({ nodeId: node.id, reason: "query budget exhausted" }); continue; }
    if (node.kind === "wait" && waits <= 0) { deferred.push({ nodeId: node.id, reason: "wait budget exhausted" }); continue; }
    const nodeCost = estimatedCost(node);
    if (cost !== null && nodeCost > cost) { deferred.push({ nodeId: node.id, reason: "estimated-cost budget exhausted" }); continue; }
    if (node.preconditions.some((precondition) => invalid.has(precondition.ref))) { deferred.push({ nodeId: node.id, reason: "a required precondition is no longer valid" }); continue; }
    if (node.kind === "action") {
      const effectHash = text((node.expectedEffects.find((effect) => effect.kind === "business_effect")?.assertion as Record<string, unknown> | undefined)?.semanticHash);
      if (forbidden.has(node.semanticHash) || (effectHash && forbidden.has(effectHash))) { deferred.push({ nodeId: node.id, reason: "a verified irreversible BusinessEffect forbids replay" }); continue; }
    }
    const keys = resourceKeys(node);
    if (keys.some((key) => occupied.has(key))) { deferred.push({ nodeId: node.id, reason: "resource conflict with an earlier deterministic frontier member" }); continue; }
    for (const key of keys) occupied.add(key);
    const history = nodeSteps(steps, node.id);
    ready.push({ node, attemptNumber: attemptNumber(history) + 1, recoveryParentStepId: history[0]?.id ?? null, resourceKeys: keys, reservation: { kind: node.kind, estimatedCostMicros: nodeCost } });
    attempts -= 1;
    if (node.kind === "action") actions -= 1;
    if (node.kind === "query") queries -= 1;
    if (node.kind === "wait") waits -= 1;
    if (cost !== null) cost -= nodeCost;
  }
  if (ready.length > 0) return { state: "ready", ready, deferred, observations };
  if (candidates.length > 0 && deferred.length > 0) return { state: "recovery", ready: [], nodeId: deferred[0]!.nodeId, cause: "budget", recovery: "terminal_failure", reason: deferred[0]!.reason, observations };
  const waiting = observations.filter((item) => item.state === "waiting" || item.state === "claimed").map((item) => ({ nodeId: item.nodeId, reason: item.reason ?? "A durable attempt is in progress." }));
  if (waiting.length > 0) return { state: "waiting", ready: [], waiting, observations };
  if (satisfied.size === graph.nodes.length) return { state: "exhausted", ready: [], reason: "The selected graph is exhausted without a verified CompletionProof transition.", observations };
  return { state: "recovery", ready: [], nodeId: null, cause: "observation", recovery: "replan", reason: "No node is causally ready under current durable observations.", observations };
}

/** Compatibility projection for existing single-step callers. */
export function resolvePlanProgress(graph: PlanGraph, steps: PlanProgressStep[], inspection: PlanProgressInspection): PlanProgress {
  const frontier = resolvePlanFrontier(graph, steps, inspection, defaultLimits());
  if (frontier.state === "ready") return { state: "ready", node: frontier.ready[0]!.node };
  if (frontier.state === "waiting") {
    const item = frontier.waiting[0]!;
    const node = graph.nodes.find((candidate) => candidate.id === item.nodeId)!;
    return { state: "waiting", node, reason: item.reason };
  }
  return {
    state: "replan",
    cause: frontier.state === "recovery" && ["observation", "failure", "stale", "timeout"].includes(frontier.cause)
      ? frontier.cause as PlanReplanCause
      : "observation",
    nodeId: frontier.state === "recovery" ? frontier.nodeId : null,
    reason: frontier.reason,
  };
}
