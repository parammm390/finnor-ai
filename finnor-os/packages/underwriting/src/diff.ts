import { canonicalSerialize, deepFreeze, semanticHash } from "./canonical";
import { compileUnderwritingModel } from "./compiler";
import type { ModelNode, UnderwritingModelIR, UnderwritingRunResult } from "./types";

export interface ModelDiff {
  leftSemanticHash: string;
  rightSemanticHash: string;
  addedNodeIds: readonly string[];
  removedNodeIds: readonly string[];
  changedNodeIds: readonly string[];
  calculationChangedNodeIds: readonly string[];
  dependencyChangedNodeIds: readonly string[];
  unitChangedNodeIds: readonly string[];
  inputPolicyChangedNodeIds: readonly string[];
  checkChangedNodeIds: readonly string[];
  outputChangedNodeIds: readonly string[];
  solverChanged: boolean;
  periodDefinitionChanged: boolean;
  financialConventionChanged: boolean;
  runtimeConventionChanged: boolean;
}

export function diffModels(left: UnderwritingModelIR, right: UnderwritingModelIR): Readonly<ModelDiff> {
  const a = compileUnderwritingModel(left);
  const b = compileUnderwritingModel(right);
  const ids = [...new Set([...Object.keys(a.nodeById), ...Object.keys(b.nodeById)])].sort();
  const addedNodeIds: string[] = [];
  const removedNodeIds: string[] = [];
  const changedNodeIds: string[] = [];
  const calculationChangedNodeIds: string[] = [];
  const dependencyChangedNodeIds: string[] = [];
  const unitChangedNodeIds: string[] = [];
  const inputPolicyChangedNodeIds: string[] = [];
  const checkChangedNodeIds: string[] = [];
  const outputChangedNodeIds: string[] = [];
  for (const id of ids) {
    const leftNode = a.nodeById[id];
    const rightNode = b.nodeById[id];
    if (!leftNode) addedNodeIds.push(id);
    else if (!rightNode) removedNodeIds.push(id);
    else if (canonicalSerialize(leftNode as ModelNode) !== canonicalSerialize(rightNode as ModelNode)) {
      changedNodeIds.push(id);
      if (canonicalSerialize(leftNode.dependencies) !== canonicalSerialize(rightNode.dependencies)) dependencyChangedNodeIds.push(id);
      if (leftNode.valueType !== rightNode.valueType || leftNode.unit !== rightNode.unit
        || leftNode.currency !== rightNode.currency || leftNode.shape !== rightNode.shape
        || canonicalSerialize(leftNode.rounding) !== canonicalSerialize(rightNode.rounding)) unitChangedNodeIds.push(id);
      if (leftNode.kind === "input" || rightNode.kind === "input") {
        const policy = (node: ModelNode) => node.kind === "input" ? {
          required: node.required, source: node.source, allowStale: node.allowStale,
          allowedTruthClasses: node.allowedTruthClasses, minimum: node.minimum, maximum: node.maximum,
        } : { kind: node.kind };
        if (canonicalSerialize(policy(leftNode)) !== canonicalSerialize(policy(rightNode))) inputPolicyChangedNodeIds.push(id);
      }
      if (leftNode.kind === "check" || rightNode.kind === "check") checkChangedNodeIds.push(id);
      if (leftNode.kind === "output" || rightNode.kind === "output") outputChangedNodeIds.push(id);
      const calculation = (node: ModelNode) => {
        if (node.kind === "expression" || node.kind === "series") return node.expression;
        if (node.kind === "aggregate") return { aggregation: node.aggregation, sourceNodeId: node.sourceNodeId };
        if (node.kind === "schedule") return node.schedule;
        if (node.kind === "constant") return node.value;
        if (node.kind === "check") return { assertion: node.assertion, failureCode: node.failureCode, severity: node.severity };
        if (node.kind === "output") return node.sourceNodeId;
        return null;
      };
      if (canonicalSerialize(calculation(leftNode)) !== canonicalSerialize(calculation(rightNode))) calculationChangedNodeIds.push(id);
    }
  }
  return deepFreeze({
    leftSemanticHash: a.semanticHash, rightSemanticHash: b.semanticHash, addedNodeIds, removedNodeIds, changedNodeIds,
    calculationChangedNodeIds, dependencyChangedNodeIds, unitChangedNodeIds, inputPolicyChangedNodeIds,
    checkChangedNodeIds, outputChangedNodeIds,
    solverChanged: canonicalSerialize(left.circularBlocks) !== canonicalSerialize(right.circularBlocks),
    periodDefinitionChanged: canonicalSerialize(left.periodDefinition) !== canonicalSerialize(right.periodDefinition),
    financialConventionChanged: left.financialConventionVersion !== right.financialConventionVersion,
    runtimeConventionChanged: canonicalSerialize(left.runtime) !== canonicalSerialize(right.runtime),
  });
}

export interface RunDiff {
  leftResultHash: string;
  rightResultHash: string;
  changedOutputs: Readonly<Record<string, { left: unknown; right: unknown }>>;
  changedChecks: readonly string[];
  sponsorCashFlowsChanged: boolean;
  solverBehaviorChanged: boolean;
  scenarioChanged: boolean;
  semanticHash: string;
}

export function diffRuns(left: UnderwritingRunResult, right: UnderwritingRunResult): Readonly<RunDiff> {
  const changedOutputs: Record<string, { left: unknown; right: unknown }> = {};
  for (const id of [...new Set([...Object.keys(left.outputs), ...Object.keys(right.outputs)])].sort()) {
    const a = left.outputs[id]?.value;
    const b = right.outputs[id]?.value;
    if (canonicalSerialize(a) !== canonicalSerialize(b)) changedOutputs[id] = { left: a ?? null, right: b ?? null };
  }
  const rightChecks = new Map(right.checks.map((check) => [check.nodeId, check]));
  const changedChecks = left.checks.filter((check) => canonicalSerialize(check) !== canonicalSerialize(rightChecks.get(check.nodeId))).map((check) => check.nodeId);
  for (const check of right.checks) if (!left.checks.some((row) => row.nodeId === check.nodeId)) changedChecks.push(check.nodeId);
  changedChecks.sort();
  const body = {
    leftResultHash: left.resultSemanticHash,
    rightResultHash: right.resultSemanticHash,
    changedOutputs,
    changedChecks,
    sponsorCashFlowsChanged: canonicalSerialize(left.sponsorCashFlows ?? []) !== canonicalSerialize(right.sponsorCashFlows ?? []),
    solverBehaviorChanged: canonicalSerialize(left.solverDiagnostics) !== canonicalSerialize(right.solverDiagnostics),
    scenarioChanged: left.scenarioSemanticHash !== right.scenarioSemanticHash,
  };
  return deepFreeze({ ...body, semanticHash: semanticHash(body) });
}
