import type { PlanGraph, PlanNode } from "@finnor/planning";

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
}

export interface PlanProgressInspection {
  actions: unknown[];
  businessEffects: unknown[];
  receipts: unknown[];
  eventWaits: unknown[];
  integrationEvents: unknown[];
}

export type PlanProgress =
  | { state: "ready"; node: PlanNode }
  | { state: "waiting"; node: PlanNode; reason: string }
  | { state: "replan"; cause: PlanReplanCause; nodeId: string | null; reason: string };

type NodeObservation =
  | { state: "pending" }
  | { state: "satisfied" }
  | { state: "waiting"; reason: string }
  | { state: "replan"; cause: PlanReplanCause; reason: string };

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

function latestStep(steps: PlanProgressStep[], nodeId: string, requireAction = false): PlanProgressStep | null {
  const matches = steps
    .filter((step) => step.planNodeId === nodeId && step.completedAt !== null && (!requireAction || step.domainActionId !== null))
    .sort((left, right) => right.stepNumber - left.stepNumber || right.id.localeCompare(left.id));
  return matches[0] ?? null;
}

function failedStep(step: PlanProgressStep): NodeObservation | null {
  if (["blocked", "failed", "cancelled"].includes(step.iterationOutcome ?? "") || hasFailure(step.failure)) {
    return { state: "replan", cause: "failure", reason: "The node's durable Objective step ended in failure instead of its expected observation." };
  }
  return null;
}

function queryObservation(node: PlanNode, steps: PlanProgressStep[]): NodeObservation {
  const step = latestStep(steps, node.id);
  if (!step) return { state: "pending" };
  const failed = failedStep(step);
  if (failed) return failed;
  if (!step.queryExecutionId) {
    return { state: "replan", cause: "failure", reason: "The query node completed without a durable Operational Query execution receipt." };
  }
  return { state: "satisfied" };
}

function receiptObservation(actionId: string, inspection: PlanProgressInspection): NodeObservation {
  const receipt = rows(inspection.receipts).find((item) => text(item.domainActionId) === actionId);
  if (!receipt) return { state: "replan", cause: "observation", reason: "The action completed without the selected node's required DecisionReceipt observation." };
  if (hasFailure(receipt.failure)) return { state: "replan", cause: "failure", reason: "The selected node's DecisionReceipt records a failure." };
  if (!receipt.finalizedAt) return { state: "replan", cause: "observation", reason: "The selected node's DecisionReceipt is not finalized." };
  return { state: "satisfied" };
}

function effectObservation(actionId: string, inspection: PlanProgressInspection): NodeObservation {
  const effect = rows(inspection.businessEffects).find((item) => text(item.domainActionId) === actionId);
  if (!effect) return { state: "replan", cause: "observation", reason: "The action completed without the selected node's required BusinessEffect observation." };
  const status = text(effect.status);
  if (status === "verified") return { state: "satisfied" };
  if (["failed", "cancelled"].includes(status ?? "")) {
    return { state: "replan", cause: "failure", reason: `The selected node's BusinessEffect ended in ${status}.` };
  }
  return { state: "replan", cause: "observation", reason: `The selected node expected a verified BusinessEffect but observed ${status ?? "an unknown state"}.` };
}

function providerObservation(actionId: string, inspection: PlanProgressInspection): NodeObservation {
  const effect = effectObservation(actionId, inspection);
  if (effect.state === "satisfied") return effect;
  const receipt = receiptObservation(actionId, inspection);
  if (receipt.state === "satisfied") return receipt;
  return effect.state === "replan" && effect.cause === "failure" ? effect : receipt;
}

function actionObservation(node: Extract<PlanNode, { kind: "action" }>, steps: PlanProgressStep[], inspection: PlanProgressInspection): NodeObservation {
  const step = latestStep(steps, node.id, true) ?? latestStep(steps, node.id);
  if (!step) return { state: "pending" };
  const failed = failedStep(step);
  if (failed) return failed;
  if (!step.domainActionId) {
    return { state: "replan", cause: "stale", reason: "The action node completed without materializing its deterministic DomainAction." };
  }
  const actionId = step.domainActionId;
  const action = rows(inspection.actions).find((item) => text(item.id) === actionId);
  if (!action) return { state: "replan", cause: "stale", reason: "The selected node's DomainAction is absent from current canonical Work state." };
  const status = text(action.status);
  if (["pending", "approved", "executing", "needs_human_review", "blocked_integration_unavailable"].includes(status ?? "")) {
    return { state: "waiting", reason: `The selected node's DomainAction is still ${status}.` };
  }
  if (["failed", "rejected"].includes(status ?? "")) {
    return { state: "replan", cause: "failure", reason: `The selected node's DomainAction ended in ${status}.` };
  }
  if (status !== "completed") {
    return { state: "replan", cause: "observation", reason: `The selected node's DomainAction has unexpected state ${status ?? "unknown"}.` };
  }

  if (node.observation.source === "decision_receipt") return receiptObservation(actionId, inspection);
  if (node.observation.source === "business_effect") return effectObservation(actionId, inspection);
  if (node.observation.source === "provider_observation") return providerObservation(actionId, inspection);
  if (node.observation.source === "integration_event") {
    const eventType = text(node.observation.assertion.eventType);
    const matched = rows(inspection.integrationEvents).some((event) => text(event.domainActionId) === actionId && (!eventType || text(event.eventType) === eventType));
    return matched
      ? { state: "satisfied" }
      : { state: "replan", cause: "observation", reason: "The action completed without the selected integration-event observation." };
  }
  return { state: "replan", cause: "observation", reason: `Action nodes cannot satisfy a ${node.observation.source} observation contract.` };
}

function waitObservation(node: Extract<PlanNode, { kind: "wait" }>, steps: PlanProgressStep[], inspection: PlanProgressInspection): NodeObservation {
  const step = latestStep(steps, node.id);
  if (!step) return { state: "pending" };
  const failed = failedStep(step);
  if (failed) return failed;
  const wait = rows(inspection.eventWaits).find((item) => text(item.objectiveStepId) === step.id);
  if (!wait) return { state: "replan", cause: "failure", reason: "The wait node completed without its durable WorkEventWait correlation." };
  const status = text(wait.status);
  if (status === "satisfied") return { state: "satisfied" };
  if (status === "waiting") return { state: "waiting", reason: "The selected PlanGraph event correlation is still waiting." };
  if (status === "timed_out") return { state: "replan", cause: "timeout", reason: "The selected PlanGraph event wait timed out." };
  return { state: "replan", cause: "stale", reason: `The selected PlanGraph event wait is ${status ?? "missing"}.` };
}

function checkObservation(node: Extract<PlanNode, { kind: "check" }>, steps: PlanProgressStep[]): NodeObservation {
  const step = latestStep(steps, node.id);
  if (!step) return { state: "pending" };
  const failed = failedStep(step);
  if (failed) return failed;
  const verification = record(step.successVerification);
  if (verification?.state === "verified" || step.iterationOutcome === "completed") return { state: "satisfied" };
  return { state: "replan", cause: "observation", reason: "The completion check ran, but the accepted GoalSpec is not yet verified." };
}

function observe(node: PlanNode, steps: PlanProgressStep[], inspection: PlanProgressInspection): NodeObservation {
  if (node.kind === "query") return queryObservation(node, steps);
  if (node.kind === "action") return actionObservation(node, steps, inspection);
  if (node.kind === "wait") return waitObservation(node, steps, inspection);
  return checkObservation(node, steps);
}

/**
 * Pure execution-frontier resolver for an immutable selected PlanGraph.
 *
 * Runtime state remains in Objective steps, DomainAction, BusinessEffect,
 * DecisionReceipt, and WorkEventWait. This function only observes those owners and
 * chooses the next causally-ready immutable node, or requires a child revision.
 */
export function resolvePlanProgress(graph: PlanGraph, steps: PlanProgressStep[], inspection: PlanProgressInspection): PlanProgress {
  const observations = new Map(graph.nodes.map((node) => [node.id, observe(node, steps, inspection)]));
  const replan = graph.nodes
    .map((node) => ({ node, observation: observations.get(node.id)! }))
    .filter((entry): entry is { node: PlanNode; observation: Extract<NodeObservation, { state: "replan" }> } => entry.observation.state === "replan")
    .sort((left, right) => left.node.semanticHash.localeCompare(right.node.semanticHash))[0];
  if (replan) return { state: "replan", cause: replan.observation.cause, nodeId: replan.node.id, reason: replan.observation.reason };

  const satisfied = new Set(graph.nodes.filter((node) => observations.get(node.id)?.state === "satisfied").map((node) => node.id));
  const priority: Record<PlanNode["kind"], number> = { query: 0, wait: 1, action: 2, check: 3 };
  const ready = graph.nodes
    .filter((node) => observations.get(node.id)?.state === "pending" && node.dependsOn.every((dependency) => satisfied.has(dependency)))
    .sort((left, right) => priority[left.kind] - priority[right.kind] || left.semanticHash.localeCompare(right.semanticHash));
  if (ready[0]) return { state: "ready", node: ready[0] };

  const waiting = graph.nodes
    .map((node) => ({ node, observation: observations.get(node.id)! }))
    .filter((entry): entry is { node: PlanNode; observation: Extract<NodeObservation, { state: "waiting" }> } => entry.observation.state === "waiting")
    .sort((left, right) => left.node.semanticHash.localeCompare(right.node.semanticHash))[0];
  if (waiting) return { state: "waiting", node: waiting.node, reason: waiting.observation.reason };

  return {
    state: "replan",
    cause: "observation",
    nodeId: null,
    reason: satisfied.size === graph.nodes.length
      ? "The selected graph was exhausted without a verified CompletionProof."
      : "The selected graph has no causally ready node under current durable observations.",
  };
}
