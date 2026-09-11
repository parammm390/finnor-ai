import { describe, expect, it } from "vitest";
import type { PlanGraph, PlanNode, PlanNodeKind } from "@finnor/planning";
import {
  resolvePlanProgress,
  type PlanProgressInspection,
  type PlanProgressStep,
} from "@finnor/orchestration";

function common(id: string, kind: PlanNodeKind, dependsOn: string[] = []) {
  return {
    id,
    kind,
    dependsOn,
    supports: ["criterion:done"],
    preconditions: [],
    expectedEffects: [],
    recovery: {
      version: 1 as const,
      on: ["failure" as const, "stale" as const, "timeout" as const, "divergence" as const],
      mode: "replan" as const,
      maxAttempts: 1,
      neverReplayVerifiedIrreversibleEffect: true as const,
    },
    semanticHash: `hash:${id}`,
  };
}

const query: PlanNode = {
  ...common("query", "query"),
  kind: "query",
  request: { intent: "work_list" },
  observation: { version: 1, source: "operational_query", assertion: { status: "ok" }, freshness: "current" },
};
const action: PlanNode = {
  ...common("action", "action", ["query"]),
  kind: "action",
  actionType: "send_message",
  payload: { body: "status" },
  groundedPayload: { body: "status" },
  predictedReceipt: null,
  authority: "allowed",
  risk: "high",
  irreversible: true,
  observation: { version: 1, source: "business_effect", assertion: { state: "verified" }, freshness: "current" },
};
const wait: PlanNode = {
  ...common("wait", "wait", ["action"]),
  kind: "wait",
  waitFor: { eventType: "provider.completed", correlationId: "corr-1" },
  observation: { version: 1, source: "integration_event", assertion: { eventType: "provider.completed" }, freshness: "event_bound" },
};
const check: PlanNode = {
  ...common("check", "check", ["wait"]),
  kind: "check",
  criterionId: "criterion:done",
  assertion: { satisfied: true },
  observation: { version: 1, source: "objective_success", assertion: { satisfied: true }, freshness: "current" },
};

function graph(nodes: PlanNode[] = [query, action, wait, check]): PlanGraph {
  return {
    version: 1,
    goalHash: "goal",
    constraintHash: "constraints",
    snapshotHash: "snapshot",
    nodes,
    edges: nodes.flatMap((node) => node.dependsOn.map((dependency) => ({ from: dependency, to: node.id, kind: "causal_prerequisite" as const, semanticHash: `${dependency}:${node.id}` }))),
    completionCoverage: [{ criterionId: "criterion:done", checkNodeId: "check" }],
    semanticHash: "graph",
  };
}

function step(input: Partial<PlanProgressStep> & Pick<PlanProgressStep, "id" | "stepNumber" | "planNodeId">): PlanProgressStep {
  return {
    queryExecutionId: null,
    domainActionId: null,
    iterationOutcome: "continue",
    failure: null,
    successVerification: null,
    completedAt: "2026-09-10T00:00:00.000Z",
    ...input,
  };
}

function inspection(overrides: Partial<PlanProgressInspection> = {}): PlanProgressInspection {
  return { actions: [], businessEffects: [], receipts: [], eventWaits: [], integrationEvents: [], ...overrides };
}

const actionReplanCases: Array<[string, Partial<PlanProgressInspection>, "failure" | "observation"]> = [
  ["failed action", { actions: [{ id: "domain-action", status: "failed" }], businessEffects: [] }, "failure"],
  ["divergent effect", { actions: [{ id: "domain-action", status: "completed" }], businessEffects: [{ domainActionId: "domain-action", status: "divergent" }] }, "observation"],
];

describe("Phase 6 immutable PlanGraph execution frontier", () => {
  it("advances query -> action -> wait -> check only after each dependency's owned observation", () => {
    expect(resolvePlanProgress(graph(), [], inspection())).toMatchObject({ state: "ready", node: { id: "query" } });

    const afterQuery = [step({ id: "step-query", stepNumber: 1, planNodeId: "query", queryExecutionId: "query-execution" })];
    expect(resolvePlanProgress(graph(), afterQuery, inspection())).toMatchObject({ state: "ready", node: { id: "action" } });

    const afterAction = [...afterQuery, step({ id: "step-action", stepNumber: 2, planNodeId: "action", domainActionId: "domain-action" })];
    const actionInspection = inspection({
      actions: [{ id: "domain-action", status: "completed" }],
      businessEffects: [{ domainActionId: "domain-action", status: "verified" }],
    });
    expect(resolvePlanProgress(graph(), afterAction, actionInspection)).toMatchObject({ state: "ready", node: { id: "wait" } });

    const afterWait = [...afterAction, step({ id: "step-wait", stepNumber: 3, planNodeId: "wait", iterationOutcome: "waiting" })];
    expect(resolvePlanProgress(graph(), afterWait, {
      ...actionInspection,
      eventWaits: [{ objectiveStepId: "step-wait", status: "satisfied" }],
    })).toMatchObject({ state: "ready", node: { id: "check" } });
  });

  it("holds the same immutable graph while an exact durable wait is unresolved", () => {
    const steps = [
      step({ id: "step-query", stepNumber: 1, planNodeId: "query", queryExecutionId: "query-execution" }),
      step({ id: "step-action", stepNumber: 2, planNodeId: "action", domainActionId: "domain-action" }),
      step({ id: "step-wait", stepNumber: 3, planNodeId: "wait", iterationOutcome: "waiting" }),
    ];
    expect(resolvePlanProgress(graph(), steps, inspection({
      actions: [{ id: "domain-action", status: "completed" }],
      businessEffects: [{ domainActionId: "domain-action", status: "verified" }],
      eventWaits: [{ objectiveStepId: "step-wait", status: "waiting" }],
    }))).toMatchObject({ state: "waiting", node: { id: "wait" } });
  });

  it.each(actionReplanCases)("creates a child revision after %s", (_label, observed, cause) => {
    const steps = [
      step({ id: "step-query", stepNumber: 1, planNodeId: "query", queryExecutionId: "query-execution" }),
      step({ id: "step-action", stepNumber: 2, planNodeId: "action", domainActionId: "domain-action" }),
    ];
    expect(resolvePlanProgress(graph(), steps, inspection(observed))).toMatchObject({ state: "replan", cause, nodeId: "action" });
  });

  it("creates a timeout child revision instead of treating a timed-out wait as satisfied", () => {
    const steps = [
      step({ id: "step-query", stepNumber: 1, planNodeId: "query", queryExecutionId: "query-execution" }),
      step({ id: "step-action", stepNumber: 2, planNodeId: "action", domainActionId: "domain-action" }),
      step({ id: "step-wait", stepNumber: 3, planNodeId: "wait", iterationOutcome: "waiting" }),
    ];
    expect(resolvePlanProgress(graph(), steps, inspection({
      actions: [{ id: "domain-action", status: "completed" }],
      businessEffects: [{ domainActionId: "domain-action", status: "verified" }],
      eventWaits: [{ objectiveStepId: "step-wait", status: "timed_out" }],
    }))).toMatchObject({ state: "replan", cause: "timeout", nodeId: "wait" });
  });

  it("accepts a finalized, non-failing DecisionReceipt when that is the compiled observation contract", () => {
    const receiptAction: PlanNode = {
      ...action,
      id: "receipt-action",
      dependsOn: [],
      semanticHash: "hash:receipt-action",
      risk: "low",
      irreversible: false,
      observation: { version: 1, source: "decision_receipt", assertion: { finalized: true }, freshness: "current" },
    };
    const receiptCheck: PlanNode = { ...check, dependsOn: ["receipt-action"] };
    const steps = [step({ id: "receipt-step", stepNumber: 1, planNodeId: "receipt-action", domainActionId: "domain-action" })];
    expect(resolvePlanProgress(graph([receiptAction, receiptCheck]), steps, inspection({
      actions: [{ id: "domain-action", status: "completed" }],
      receipts: [{ domainActionId: "domain-action", finalizedAt: "2026-09-10T00:00:00.000Z", failure: null }],
    }))).toMatchObject({ state: "ready", node: { id: "check" } });
  });

  it("replans after an unsatisfied check and never mistakes graph exhaustion for completion", () => {
    const onlyCheck = graph([{ ...check, dependsOn: [] }]);
    const result = resolvePlanProgress(onlyCheck, [step({
      id: "check-step",
      stepNumber: 1,
      planNodeId: "check",
      successVerification: { state: "not_verified" },
    })], inspection());
    expect(result).toMatchObject({ state: "replan", cause: "observation", nodeId: "check" });
  });

  it("selects equally ready nodes by kind and semantic hash, never array position", () => {
    const q2: PlanNode = { ...query, id: "query-b", semanticHash: "hash:b" };
    const q1: PlanNode = { ...query, id: "query-a", semanticHash: "hash:a" };
    const forward = resolvePlanProgress(graph([q2, q1]), [], inspection());
    const reverse = resolvePlanProgress(graph([q1, q2]), [], inspection());
    expect(forward).toMatchObject({ state: "ready", node: { id: "query-a" } });
    expect(reverse).toMatchObject({ state: "ready", node: { id: "query-a" } });
  });
});
