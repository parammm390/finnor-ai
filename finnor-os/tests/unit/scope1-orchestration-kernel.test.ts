import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import type { PlanGraph, PlanNode } from "@finnor/planning";
import {
  decideRecovery,
  resolvePlanFrontier,
  verificationResult,
  type PlanProgressInspection,
  type PlanProgressStep,
  type ReadyFrontierLimits,
} from "@finnor/orchestration";

function queryNode(id: string, dependsOn: string[] = [], recovery: "retry" | "replan" = "replan"): PlanNode {
  return {
    id,
    kind: "query",
    dependsOn,
    supports: ["criterion:done"],
    preconditions: [],
    expectedEffects: [],
    recovery: {
      version: 1,
      on: ["failure", "stale", "timeout", "divergence"],
      mode: recovery,
      maxAttempts: recovery === "retry" ? 2 : 1,
      neverReplayVerifiedIrreversibleEffect: true,
    },
    request: { intent: "work_list", node: id },
    observation: { version: 1, source: "operational_query", assertion: { status: "ok" }, freshness: "current" },
    semanticHash: `sha256:${id.padStart(64, "0").slice(-64)}`,
    estimatedCostMicros: 10,
    estimatedLatencyMs: 1,
  };
}

function actionNode(id: string, payload: Record<string, unknown> = { targetId: "target-a" }): PlanNode {
  return {
    id,
    kind: "action",
    dependsOn: [],
    supports: ["criterion:done"],
    preconditions: [],
    expectedEffects: [{ kind: "business_effect", assertion: { semanticHash: `effect:${id}` } }],
    recovery: {
      version: 1,
      on: ["failure", "stale", "timeout", "divergence"],
      mode: "retry",
      maxAttempts: 3,
      neverReplayVerifiedIrreversibleEffect: true,
    },
    actionType: "send_message",
    payload,
    groundedPayload: payload,
    predictedReceipt: null,
    authority: "allowed",
    risk: "high",
    irreversible: true,
    observation: { version: 1, source: "provider_observation", assertion: { delivered: true }, freshness: "current" },
    semanticHash: `sha256:${id.padStart(64, "a").slice(-64)}`,
    estimatedCostMicros: 25,
    estimatedLatencyMs: 5,
  };
}

function waitNode(id: string): PlanNode {
  return {
    id,
    kind: "wait",
    dependsOn: [],
    supports: ["criterion:done"],
    preconditions: [],
    expectedEffects: [{ kind: "event", assertion: { eventType: `event.${id}` } }],
    recovery: {
      version: 1,
      on: ["failure", "stale", "timeout", "divergence"],
      mode: "replan",
      maxAttempts: 1,
      neverReplayVerifiedIrreversibleEffect: true,
    },
    waitFor: { eventType: `event.${id}` },
    observation: { version: 1, source: "integration_event", assertion: { eventType: `event.${id}` }, freshness: "event_bound" },
    semanticHash: `sha256:${id.padStart(64, "b").slice(-64)}`,
    estimatedCostMicros: 0,
    estimatedLatencyMs: null,
  };
}

function graph(nodes: PlanNode[]): PlanGraph {
  return {
    version: 1,
    goalHash: "goal",
    constraintHash: "constraints",
    snapshotHash: "snapshot",
    nodes,
    edges: nodes.flatMap((node) => node.dependsOn.map((from) => ({ from, to: node.id, kind: "causal_prerequisite" as const, semanticHash: `${from}:${node.id}` }))),
    completionCoverage: [],
    semanticHash: "graph",
  };
}

function limits(overrides: Partial<ReadyFrontierLimits> = {}): ReadyFrontierLimits {
  return {
    maxReady: 8,
    maxConcurrent: 8,
    activeClaims: 0,
    remainingActions: 100,
    remainingQueries: 100,
    remainingWaits: 100,
    remainingAttempts: 100,
    remainingEstimatedCostMicros: 1_000_000,
    planActive: true,
    workExecutable: true,
    cancelled: false,
    now: "2026-09-17T00:00:00.000Z",
    deadlineAt: "2026-09-18T00:00:00.000Z",
    objectiveRevision: 7,
    activeResourceKeys: [],
    ...overrides,
  };
}

function inspection(overrides: Partial<PlanProgressInspection> = {}): PlanProgressInspection {
  return { actions: [], businessEffects: [], receipts: [], eventWaits: [], integrationEvents: [], ...overrides };
}

function completedQuery(nodeId: string, attemptNumber = 1): PlanProgressStep {
  return {
    id: `step:${nodeId}:${attemptNumber}`,
    stepNumber: attemptNumber,
    planNodeId: nodeId,
    queryExecutionId: `query:${nodeId}:${attemptNumber}`,
    domainActionId: null,
    iterationOutcome: "continue",
    failure: null,
    successVerification: null,
    verificationResult: verificationResult({
      state: "verified",
      planRevisionId: "plan",
      planNodeId: nodeId,
      attemptNumber,
      subject: { kind: "query", id: `query:${nodeId}:${attemptNumber}` },
      observationRefs: [{ type: "work_query_execution", id: `query:${nodeId}:${attemptNumber}` }],
      verifier: { kind: "deterministic_rule", rule: "query_receipt_v1" },
      establishedAt: "2026-09-17T00:00:00.000Z",
      evidence: { rowCount: 1 },
    }),
    completedAt: "2026-09-17T00:00:00.000Z",
    attemptNumber,
    objectiveRevision: 7,
    executionState: "completed",
  };
}

describe("Scope 1 deterministic ready frontier and recovery protocol", () => {
  it("returns a bounded, stable subset for 100 independent ready nodes", () => {
    const nodes = Array.from({ length: 100 }, (_, index) => queryNode(`node-${String(index).padStart(3, "0")}`));
    const forward = resolvePlanFrontier(graph(nodes), [], inspection(), limits({ maxReady: 12, maxConcurrent: 12 }));
    const reverse = resolvePlanFrontier(graph([...nodes].reverse()), [], inspection(), limits({ maxReady: 12, maxConcurrent: 12 }));
    expect(forward.state).toBe("ready");
    expect(reverse.state).toBe("ready");
    if (forward.state !== "ready" || reverse.state !== "ready") return;
    expect(forward.ready).toHaveLength(12);
    expect(forward.ready.map((item) => item.node.id)).toEqual(reverse.ready.map((item) => item.node.id));
    expect(forward.deferred).toHaveLength(88);
  });

  it("never releases a dependent node before every causal prerequisite is verified", () => {
    const nodes = [queryNode("left"), queryNode("right"), queryNode("fan-in", ["left", "right"])];
    const initial = resolvePlanFrontier(graph(nodes), [], inspection(), limits());
    expect(initial.state === "ready" ? initial.ready.map((item) => item.node.id).sort() : []).toEqual(["left", "right"]);
    const partial = resolvePlanFrontier(graph(nodes), [completedQuery("left")], inspection(), limits());
    expect(partial.state === "ready" ? partial.ready.map((item) => item.node.id) : []).toEqual(["right"]);
    const complete = resolvePlanFrontier(graph(nodes), [completedQuery("left"), completedQuery("right")], inspection(), limits());
    expect(complete).toMatchObject({ state: "ready", ready: [{ node: { id: "fan-in" } }] });
  });

  it("reserves one member of a deterministic resource-conflict set", () => {
    const nodes = [actionNode("write-b", { targetId: "same" }), actionNode("write-a", { targetId: "same" })];
    const result = resolvePlanFrontier(graph(nodes), [], inspection(), limits());
    expect(result.state).toBe("ready");
    if (result.state !== "ready") return;
    expect(result.ready).toHaveLength(1);
    expect(result.deferred).toEqual([{ nodeId: result.ready[0]!.node.id === "write-a" ? "write-b" : "write-a", reason: "resource conflict with an earlier deterministic frontier member" }]);
  });

  it("consumes shared concurrency, action, attempt, and estimated-cost budgets atomically in frontier order", () => {
    const nodes = [actionNode("a"), actionNode("b", { targetId: "target-b" }), actionNode("c", { targetId: "target-c" })];
    const result = resolvePlanFrontier(graph(nodes), [], inspection(), limits({ maxReady: 10, maxConcurrent: 10, remainingActions: 2, remainingAttempts: 2, remainingEstimatedCostMicros: 50 }));
    expect(result.state).toBe("ready");
    if (result.state !== "ready") return;
    expect(result.ready).toHaveLength(2);
    expect(result.ready.reduce((sum, item) => sum + item.reservation.estimatedCostMicros, 0)).toBe(50);
    expect(result.deferred).toHaveLength(1);
  });

  it("creates a distinct attributable logical attempt only for an explicit retry", () => {
    const node = queryNode("retry-me", [], "retry");
    const failed: PlanProgressStep = {
      ...completedQuery(node.id),
      queryExecutionId: null,
      verificationResult: null,
      iterationOutcome: "failed",
      failure: { code: "READ_FAILED" },
    };
    const result = resolvePlanFrontier(graph([node]), [failed], inspection(), limits());
    expect(result).toMatchObject({
      state: "ready",
      ready: [{ node: { id: "retry-me" }, attemptNumber: 2, recoveryParentStepId: failed.id }],
    });
  });

  it("treats duplicate in-flight delivery as one claimed logical attempt", () => {
    const node = queryNode("claimed");
    const active: PlanProgressStep = {
      ...completedQuery(node.id),
      queryExecutionId: null,
      verificationResult: null,
      completedAt: null,
      executionState: "running",
      claimOwner: "worker-1",
      claimUntil: "2026-09-17T00:10:00.000Z",
    };
    const result = resolvePlanFrontier(graph([node]), [active], inspection(), limits());
    expect(result).toMatchObject({ state: "waiting", waiting: [{ nodeId: "claimed" }] });
  });

  it("does not collapse provider acknowledgement into verified external reality", () => {
    const node = actionNode("provider-effect");
    const step: PlanProgressStep = {
      id: "step:provider",
      stepNumber: 1,
      planNodeId: node.id,
      queryExecutionId: null,
      domainActionId: "action-1",
      iterationOutcome: "continue",
      failure: null,
      successVerification: null,
      completedAt: "2026-09-17T00:00:00.000Z",
      attemptNumber: 1,
      objectiveRevision: 7,
      executionState: "completed",
    };
    const result = resolvePlanFrontier(graph([node]), [step], inspection({
      actions: [{ id: "action-1", status: "completed" }],
      receipts: [{ domainActionId: "action-1", finalizedAt: "2026-09-17T00:00:00.000Z", failure: null }],
    }), limits());
    expect(result).toMatchObject({ state: "recovery", recovery: "reconcile", observations: [{ state: "unknown", cause: "unknown_outcome" }] });
  });

  it("gives ambiguous or verified irreversible effects precedence over cancellation and retry", () => {
    const node = actionNode("irreversible");
    const decision = decideRecovery({
      workId: "work",
      objectiveRevision: 7,
      planRevisionId: "plan",
      node,
      objectiveStepId: "step",
      attemptNumber: 1,
      cause: "cancellation",
      reason: "Cancellation raced an externally invoked operation.",
      cancelled: true,
      unknownExternalOutcome: true,
      verifiedIrreversibleEffect: true,
    });
    expect(decision.kind).toBe("reconcile");
    expect(decision.next).toMatchObject({ mayExecute: false, requiresReconciliation: true });
  });

  it("preserves VERIFIED irreversible history and reconciles unresolved cross-revision effects", () => {
    const node = actionNode("historical-effect");
    const verified = resolvePlanFrontier(graph([node]), [], inspection(), limits({
      historicalIrreversibleEffects: [{
        nodeSemanticHash: node.semanticHash,
        sourcePlanRevisionId: "plan-parent",
        sourcePlanNodeId: "parent-node",
        sourceObjectiveStepId: "parent-step",
        businessEffectId: "verified-effect",
        state: "verified",
        effectStatus: "verified",
      }],
    }));
    expect(verified).toMatchObject({
      state: "exhausted",
      observations: [{ nodeId: node.id, state: "satisfied", historicalEffect: { businessEffectId: "verified-effect" } }],
    });

    const unknown = resolvePlanFrontier(graph([node]), [], inspection(), limits({
      cancelled: true,
      historicalIrreversibleEffects: [{
        nodeSemanticHash: node.semanticHash,
        sourcePlanRevisionId: "plan-parent",
        sourcePlanNodeId: "parent-node",
        sourceObjectiveStepId: "parent-step",
        businessEffectId: "ambiguous-effect",
        state: "unknown_outcome",
        effectStatus: "executing",
      }],
    }));
    expect(unknown).toMatchObject({
      state: "recovery",
      nodeId: node.id,
      cause: "cancellation",
      recovery: "reconcile",
      observations: [{ state: "unknown", cause: "unknown_outcome" }],
    });
  });

  it("emits durable-recovery classifications for cancellation, deadline, and stale authority", () => {
    const node = actionNode("bounded");
    expect(resolvePlanFrontier(graph([node]), [], inspection(), limits({ cancelled: true }))).toMatchObject({ state: "recovery", cause: "cancellation", recovery: "cancel" });
    expect(resolvePlanFrontier(graph([node]), [], inspection(), limits({ now: "2026-09-19T00:00:00.000Z" }))).toMatchObject({ state: "recovery", cause: "deadline", recovery: "terminal_failure" });
    expect(decideRecovery({ workId: "work", objectiveRevision: 7, planRevisionId: "plan", node, attemptNumber: 1, cause: "stale", reason: "Authority revision changed.", authorityState: "stale" })).toMatchObject({ kind: "replan", next: { mayExecute: false, requiresFreshAuthority: true } });
  });

  it("resolves a 100-node frontier within a bounded local scheduling envelope", () => {
    const nodes = Array.from({ length: 100 }, (_, index) => queryNode(`perf-${String(index).padStart(3, "0")}`));
    const started = performance.now();
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const result = resolvePlanFrontier(graph(nodes), [], inspection(), limits({ maxReady: 32, maxConcurrent: 32 }));
      expect(result.state).toBe("ready");
    }
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("keeps deep chains, wide fan-out/fan-in, and many durable waits bounded", () => {
    const chain = Array.from({ length: 100 }, (_, index) => queryNode(`chain-${String(index).padStart(3, "0")}`, index === 0 ? [] : [`chain-${String(index - 1).padStart(3, "0")}`]));
    const chainSteps = chain.slice(0, -1).map((node, index) => completedQuery(node.id, index + 1));
    expect(resolvePlanFrontier(graph(chain), chainSteps, inspection(), limits({ maxReady: 100, maxConcurrent: 100 })))
      .toMatchObject({ state: "ready", ready: [{ node: { id: "chain-099" } }] });

    const root = queryNode("fan-root");
    const leaves = Array.from({ length: 98 }, (_, index) => queryNode(`fan-leaf-${String(index).padStart(3, "0")}`, [root.id]));
    const join = queryNode("fan-join", leaves.map((node) => node.id));
    const fanOut = resolvePlanFrontier(graph([root, ...leaves, join]), [completedQuery(root.id)], inspection(), limits({ maxReady: 32, maxConcurrent: 32 }));
    expect(fanOut.state === "ready" ? fanOut.ready.length : 0).toBe(32);
    const fanIn = resolvePlanFrontier(graph([root, ...leaves, join]), [completedQuery(root.id), ...leaves.map((node, index) => completedQuery(node.id, index + 1))], inspection(), limits({ maxReady: 32, maxConcurrent: 32 }));
    expect(fanIn).toMatchObject({ state: "ready", ready: [{ node: { id: "fan-join" } }] });

    const waits = Array.from({ length: 100 }, (_, index) => waitNode(`wait-${String(index).padStart(3, "0")}`));
    const waitingSteps: PlanProgressStep[] = waits.map((node, index) => ({
      id: `step:${node.id}`,
      stepNumber: index + 1,
      planNodeId: node.id,
      queryExecutionId: null,
      domainActionId: null,
      iterationOutcome: "waiting",
      failure: null,
      successVerification: null,
      completedAt: null,
      attemptNumber: 1,
      objectiveRevision: 7,
      executionState: "waiting",
    }));
    const manyWaits = resolvePlanFrontier(graph(waits), waitingSteps, inspection(), limits({ maxReady: 100, maxConcurrent: 100, activeClaims: 100 }));
    expect(manyWaits.state === "waiting" ? manyWaits.waiting.length : 0).toBe(100);
  });
});
