import { canonicalSerialize } from "./canonical";
import { add, cmp, decimal, div, max, min, mul, neg, round, sub, type DecimalString } from "./decimal";
import { UnderwritingError, fail } from "./errors";
import { finalizeRunResult } from "./result";
import { applyScenario, assertSnapshotMatchesModel, inputSnapshotHash } from "./snapshot";
import type {
  CheckResult,
  CompiledUnderwritingModel,
  Expression,
  ModelNode,
  ModelValue,
  NodeExecutionResult,
  ScalarValue,
  UnderwritingInputSnapshot,
  UnderwritingRunResult,
  UnderwritingScenario,
} from "./types";
import { executeStandardLboModel } from "./standard-lbo";

interface EvaluationContext {
  model: CompiledUnderwritingModel;
  values: Record<string, NodeExecutionResult>;
  periodIndex?: number;
}

function scalarAt(result: NodeExecutionResult, context: EvaluationContext, lag = 0): ScalarValue {
  if (result.shape === "scalar") {
    if (lag) fail("PERIOD_MISMATCH", "Cannot lag a scalar node", { nodeId: result.nodeId });
    return result.value as ScalarValue;
  }
  if (context.periodIndex === undefined) fail("PERIOD_MISMATCH", "Series reference requires a period context", { nodeId: result.nodeId });
  const index = context.periodIndex - lag;
  const period = context.model.periods[index];
  if (!period) fail("MISSING_REQUIRED_INPUT", "Lag refers before the modeled forecast", { nodeId: result.nodeId, lag });
  const value = (result.value as Record<string, ScalarValue>)[period.id];
  if (value === undefined) fail("MISSING_REQUIRED_INPUT", "Series is missing a modeled period", { nodeId: result.nodeId, periodId: period.id });
  return value;
}

function referenced(expression: Expression, context: EvaluationContext, lag = 0): ScalarValue {
  if (expression.op !== "ref" && expression.op !== "lag") fail("MODEL_SCHEMA_INVALID", "Internal expression reference error");
  const result = context.values[expression.nodeId];
  if (!result) fail("MISSING_DEPENDENCY", "Dependency has not been evaluated", { nodeId: expression.nodeId });
  return scalarAt(result, context, expression.op === "lag" ? expression.periods : lag);
}

function evaluateExpression(expression: Expression, context: EvaluationContext): ScalarValue {
  switch (expression.op) {
    case "literal": return expression.valueType === "decimal" ? decimal(String(expression.value)) : expression.value;
    case "ref":
    case "lag": return referenced(expression, context);
    case "negate": return neg(String(evaluateExpression(expression.arg, context)));
    case "add": return add(...expression.args.map((item) => String(evaluateExpression(item, context))));
    case "subtract": return sub(String(evaluateExpression(expression.args[0]!, context)), String(evaluateExpression(expression.args[1]!, context)));
    case "multiply": return mul(String(evaluateExpression(expression.args[0]!, context)), String(evaluateExpression(expression.args[1]!, context)));
    case "divide": return div(String(evaluateExpression(expression.args[0]!, context)), String(evaluateExpression(expression.args[1]!, context)));
    case "min": return min(...expression.args.map((item) => String(evaluateExpression(item, context))));
    case "max": return max(...expression.args.map((item) => String(evaluateExpression(item, context))));
    case "sum": return add(...expression.args.map((item) => String(evaluateExpression(item, context))));
    case "compare": {
      const left = evaluateExpression(expression.left, context);
      const right = evaluateExpression(expression.right, context);
      const comparison = typeof left === "string" && typeof right === "string" ? cmp(left, right) : left === right ? 0 : String(left).localeCompare(String(right));
      switch (expression.comparison) {
        case "eq": return comparison === 0;
        case "ne": return comparison !== 0;
        case "lt": return comparison < 0;
        case "lte": return comparison <= 0;
        case "gt": return comparison > 0;
        case "gte": return comparison >= 0;
      }
    }
    case "if": {
      const predicate = evaluateExpression(expression.condition, context);
      if (typeof predicate !== "boolean") fail("TYPE_MISMATCH", "Conditional predicate did not evaluate to boolean");
      return evaluateExpression(predicate ? expression.then : expression.else, context);
    }
    default: fail("UNSUPPORTED_EXPRESSION", "Unsupported expression operation");
  }
}

function resultFor(node: ModelNode, value: ModelValue, truthClass: NodeExecutionResult["truthClass"], calculation: string): NodeExecutionResult {
  let normalized = value;
  if (node.valueType === "decimal") {
    if (node.shape === "scalar") normalized = node.rounding ? round(String(value), node.rounding.decimalPlaces) : decimal(String(value));
    else {
      normalized = Object.fromEntries(Object.entries(value as Record<string, ScalarValue>).map(([period, item]) => [
        period,
        node.rounding ? round(String(item), node.rounding.decimalPlaces) : decimal(String(item)),
      ]));
    }
  }
  return {
    nodeId: node.id,
    value: normalized,
    valueType: node.valueType,
    unit: node.unit,
    ...(node.currency ? { currency: node.currency } : {}),
    shape: node.shape,
    truthClass,
    directDependencies: [...node.dependencies],
    calculation,
  };
}

function aggregate(node: Extract<ModelNode, { kind: "aggregate" }>, source: NodeExecutionResult, model: CompiledUnderwritingModel): ScalarValue {
  const series = source.value as Record<string, ScalarValue>;
  const values = model.periods.map((period) => {
    const value = series[period.id];
    if (value === undefined) fail("MISSING_REQUIRED_INPUT", "Aggregate source is missing a modeled period", { nodeId: source.nodeId, periodId: period.id });
    return value;
  });
  if (!values.length) fail("INVALID_PERIOD", "Aggregate has no periods");
  if (node.aggregation === "first") return values[0]!;
  if (node.aggregation === "last") return values.at(-1)!;
  if (node.valueType !== "decimal") fail("TYPE_MISMATCH", "Only first/last aggregation supports non-decimal series");
  if (node.aggregation === "sum") return add(...values.map(String));
  if (node.aggregation === "min") return min(...values.map(String));
  return max(...values.map(String));
}

function executeGeneric(
  model: CompiledUnderwritingModel,
  snapshot: UnderwritingInputSnapshot,
  scenarioSemanticHash?: string,
): Readonly<UnderwritingRunResult> {
  const values: Record<string, NodeExecutionResult> = {};
  const outputs: Record<string, NodeExecutionResult> = {};
  const checks: CheckResult[] = [];
  try {
    assertSnapshotMatchesModel(model, snapshot);
    for (const nodeId of model.executionOrder) {
      const node = model.nodeById[nodeId]!;
      if (node.kind === "input") {
        const input = snapshot.values[node.id];
        if (!input || input.value === null) {
          if (node.required) fail("MISSING_REQUIRED_INPUT", "Required InputNode has no value", { nodeId: node.id });
          continue;
        }
        values[node.id] = resultFor(node, input.value, input.truthClass, `input:${input.status}`);
      } else if (node.kind === "constant") {
        values[node.id] = resultFor(node, node.value, "MODEL_PARAMETER", "constant");
      } else if (node.kind === "expression") {
        values[node.id] = resultFor(node, evaluateExpression(node.expression, { model, values }), "DERIVED_VALUE", canonicalSerialize(node.expression));
      } else if (node.kind === "series") {
        const series: Record<string, ScalarValue> = {};
        for (let index = 0; index < model.periods.length; index += 1) {
          series[model.periods[index]!.id] = evaluateExpression(node.expression, { model, values, periodIndex: index });
        }
        values[node.id] = resultFor(node, series, "DERIVED_VALUE", canonicalSerialize(node.expression));
      } else if (node.kind === "aggregate") {
        const source = values[node.sourceNodeId];
        if (!source) fail("MISSING_DEPENDENCY", "Aggregate source has not been evaluated", { nodeId: node.id });
        values[node.id] = resultFor(node, aggregate(node, source, model), "DERIVED_VALUE", `${node.aggregation}(${node.sourceNodeId})`);
      } else if (node.kind === "check") {
        const passed = evaluateExpression(node.assertion, { model, values });
        if (typeof passed !== "boolean") fail("TYPE_MISMATCH", "Check assertion did not evaluate to boolean", { nodeId: node.id });
        values[node.id] = resultFor(node, passed, "DERIVED_VALUE", canonicalSerialize(node.assertion));
        checks.push({ nodeId: node.id, passed, severity: node.severity, code: node.failureCode, message: passed ? "Check passed" : "Check failed" });
      } else if (node.kind === "output") {
        const source = values[node.sourceNodeId];
        if (!source) fail("MISSING_DEPENDENCY", "Output source has not been evaluated", { nodeId: node.id });
        values[node.id] = resultFor(node, source.value, "DERIVED_VALUE", `output(${node.sourceNodeId})`);
        outputs[node.id] = values[node.id]!;
      } else {
        fail("UNSUPPORTED_CAPABILITY", "Generic executor cannot execute a specialized schedule", { nodeId: node.id });
      }
    }
    const invalid = checks.some((check) => !check.passed && check.severity === "error");
    return finalizeRunResult({
      status: "SUCCEEDED",
      validity: invalid ? "INVALID" : "VALID",
      modelSemanticHash: model.semanticHash,
      inputSemanticHash: snapshot.semanticHash!,
      scenarioSemanticHash,
      values,
      outputs,
      checks,
    });
  } catch (error) {
    return finalizeRunResult({
      status: "FAILED",
      validity: error instanceof UnderwritingError && error.code === "NON_CONVERGENT" ? "NON_CONVERGENT" : "INCOMPLETE",
      modelSemanticHash: model.semanticHash,
      inputSemanticHash: snapshot.semanticHash ?? inputSnapshotHash(snapshot),
      scenarioSemanticHash,
      values,
      outputs,
      checks,
      failure: error,
    });
  }
}

export function executeUnderwritingModel(
  model: CompiledUnderwritingModel,
  sourceSnapshot: UnderwritingInputSnapshot,
  scenario?: UnderwritingScenario,
): Readonly<UnderwritingRunResult> {
  let applied: ReturnType<typeof applyScenario>;
  try {
    applied = applyScenario(model, sourceSnapshot, scenario);
  } catch (error) {
    return finalizeRunResult({
      status: "FAILED",
      validity: error instanceof UnderwritingError && error.code === "NON_CONVERGENT" ? "NON_CONVERGENT" : "INCOMPLETE",
      modelSemanticHash: model.semanticHash,
      inputSemanticHash: inputSnapshotHash(sourceSnapshot),
      scenarioSemanticHash: scenario?.semanticHash,
      failure: error,
    });
  }
  return model.model.runtime?.kind === "standard_lbo_v1"
    ? executeStandardLboModel(model, applied.snapshot, applied.scenarioSemanticHash)
    : executeGeneric(model, applied.snapshot, applied.scenarioSemanticHash);
}
