import { canonicalSerialize, deepFreeze, semanticHash } from "./canonical";
import { d, decimal } from "./decimal";
import { fail } from "./errors";
import { buildPeriods } from "./periods";
import {
  UNDERWRITING_ENGINE_VERSION,
  UNDERWRITING_LIMITS,
  UNDERWRITING_MODEL_SCHEMA_VERSION,
  type CircularBlock,
  type CompiledUnderwritingModel,
  type Expression,
  type ModelNode,
  type UnderwritingModelIR,
  type TruthClass,
  type ValueShape,
  type ValueType,
  type ValueUnit,
} from "./types";

const NODE_ID = /^[a-z][a-z0-9_.:-]{0,199}$/;
const MODEL_KEY = /^[a-z][a-z0-9_.:-]{0,99}$/;
const CURRENCY = /^[A-Z]{3}$/;

interface ExpressionType {
  valueType: ValueType;
  unit: ValueUnit;
  currency?: string;
  shape: ValueShape;
}

function sameType(left: ExpressionType, right: ExpressionType, code: "TYPE_MISMATCH" | "UNIT_MISMATCH" = "UNIT_MISMATCH"): void {
  if (left.valueType !== right.valueType || left.shape !== right.shape) fail("TYPE_MISMATCH", "Expression operand types or shapes do not match", { left, right });
  if (left.unit !== right.unit) fail(code, "Expression operand units do not match", { left: left.unit, right: right.unit });
  if (left.currency !== right.currency) fail("CURRENCY_MISMATCH", "Expression operand currencies do not match", { left: left.currency, right: right.currency });
}

function numeric(type: ExpressionType): void {
  if (type.valueType !== "decimal" || ["date", "boolean", "text", "period"].includes(type.unit)) {
    fail("TYPE_MISMATCH", "Expression requires numeric operands", { type });
  }
}

function combinedShape(types: readonly ExpressionType[]): ValueShape {
  return types.some((item) => item.shape === "series") ? "series" : "scalar";
}

function multiplication(left: ExpressionType, right: ExpressionType): ExpressionType {
  numeric(left);
  numeric(right);
  if (left.shape !== right.shape && left.shape !== "scalar" && right.shape !== "scalar") fail("TYPE_MISMATCH", "Incompatible multiplication shapes");
  if (left.unit === "money" && right.unit === "money") fail("UNIT_MISMATCH", "Money multiplied by money is not supported by the bounded unit system");
  if (left.currency && right.currency) fail("CURRENCY_MISMATCH", "Two currency-bearing operands cannot be multiplied");
  const money = left.unit === "money" ? left : right.unit === "money" ? right : null;
  if (money) {
    const factor = money === left ? right : left;
    if (!["rate", "multiple", "ratio", "count"].includes(factor.unit)) fail("UNIT_MISMATCH", "Money can only be multiplied by an explicit dimensionless factor", { factor: factor.unit });
    return { valueType: "decimal", unit: "money", currency: money.currency, shape: combinedShape([left, right]) };
  }
  const unit: ValueUnit = left.unit === "count" ? right.unit : right.unit === "count" ? left.unit : left.unit === right.unit ? left.unit : "ratio";
  return { valueType: "decimal", unit, shape: combinedShape([left, right]) };
}

function division(left: ExpressionType, right: ExpressionType): ExpressionType {
  numeric(left);
  numeric(right);
  if (right.unit === "money") {
    if (left.unit !== "money" || left.currency !== right.currency) fail("UNIT_MISMATCH", "Only same-currency money may be divided by money");
    return { valueType: "decimal", unit: "ratio", shape: combinedShape([left, right]) };
  }
  if (left.unit === "money") {
    if (!["rate", "multiple", "ratio", "count"].includes(right.unit)) fail("UNIT_MISMATCH", "Money divisor must be dimensionless", { divisor: right.unit });
    return { valueType: "decimal", unit: "money", currency: left.currency, shape: combinedShape([left, right]) };
  }
  if (left.currency || right.currency) fail("CURRENCY_MISMATCH", "Unsupported currency division");
  return { valueType: "decimal", unit: left.unit === right.unit ? "ratio" : left.unit, shape: combinedShape([left, right]) };
}

function expressionRefs(expression: Expression, depth = 0): string[] {
  if (depth > UNDERWRITING_LIMITS.expressionDepth) fail("AST_DEPTH_LIMIT", "Expression exceeds maximum depth");
  switch (expression.op) {
    case "literal": return [];
    case "ref":
    case "lag": return [expression.nodeId];
    case "negate": return expressionRefs(expression.arg, depth + 1);
    case "compare": return [...expressionRefs(expression.left, depth + 1), ...expressionRefs(expression.right, depth + 1)];
    case "if": return [...expressionRefs(expression.condition, depth + 1), ...expressionRefs(expression.then, depth + 1), ...expressionRefs(expression.else, depth + 1)];
    case "add":
    case "subtract":
    case "multiply":
    case "divide":
    case "min":
    case "max":
    case "sum": return expression.args.flatMap((item) => expressionRefs(item, depth + 1));
    default: fail("UNSUPPORTED_EXPRESSION", "Unsupported expression operation");
  }
}

function inferExpression(
  expression: Expression,
  nodes: Readonly<Record<string, ModelNode>>,
  seriesContext: boolean,
  depth = 0,
): ExpressionType {
  if (depth > UNDERWRITING_LIMITS.expressionDepth) fail("AST_DEPTH_LIMIT", "Expression exceeds maximum depth");
  switch (expression.op) {
    case "literal": {
      if (expression.valueType === "decimal") decimal(String(expression.value));
      if (expression.currency && (expression.unit !== "money" || !CURRENCY.test(expression.currency))) fail("CURRENCY_MISMATCH", "Literal currency is invalid");
      return { valueType: expression.valueType, unit: expression.unit, currency: expression.currency, shape: "scalar" };
    }
    case "ref": {
      const node = nodes[expression.nodeId];
      if (!node) fail("MISSING_DEPENDENCY", "Expression references a missing node", { nodeId: expression.nodeId });
      return { valueType: node.valueType, unit: node.unit, currency: node.currency, shape: seriesContext && node.shape === "series" ? "scalar" : node.shape };
    }
    case "lag": {
      const node = nodes[expression.nodeId];
      if (!node) fail("MISSING_DEPENDENCY", "Lag references a missing node", { nodeId: expression.nodeId });
      if (!seriesContext || node.shape !== "series" || !Number.isSafeInteger(expression.periods) || expression.periods < 1) {
        fail("PERIOD_MISMATCH", "Lag requires a positive offset inside a series expression", { nodeId: expression.nodeId, periods: expression.periods });
      }
      return { valueType: node.valueType, unit: node.unit, currency: node.currency, shape: "scalar" };
    }
    case "negate": {
      const type = inferExpression(expression.arg, nodes, seriesContext, depth + 1);
      numeric(type);
      return type;
    }
    case "compare": {
      const left = inferExpression(expression.left, nodes, seriesContext, depth + 1);
      const right = inferExpression(expression.right, nodes, seriesContext, depth + 1);
      sameType(left, right);
      return { valueType: "boolean", unit: "boolean", shape: combinedShape([left, right]) };
    }
    case "if": {
      const condition = inferExpression(expression.condition, nodes, seriesContext, depth + 1);
      if (condition.valueType !== "boolean") fail("TYPE_MISMATCH", "Conditional predicate must be boolean");
      const yes = inferExpression(expression.then, nodes, seriesContext, depth + 1);
      const no = inferExpression(expression.else, nodes, seriesContext, depth + 1);
      sameType(yes, no);
      return { ...yes, shape: combinedShape([condition, yes, no]) };
    }
    case "add":
    case "subtract":
    case "min":
    case "max":
    case "sum": {
      if (!expression.args.length || (expression.op === "subtract" && expression.args.length !== 2)) fail("MODEL_SCHEMA_INVALID", `${expression.op} has invalid arity`);
      const types = expression.args.map((item) => inferExpression(item, nodes, seriesContext, depth + 1));
      for (const type of types) numeric(type);
      for (const type of types.slice(1)) sameType(types[0]!, type);
      return { ...types[0]!, shape: combinedShape(types) };
    }
    case "multiply":
    case "divide": {
      if (expression.args.length !== 2) fail("MODEL_SCHEMA_INVALID", `${expression.op} requires exactly two operands`);
      const left = inferExpression(expression.args[0]!, nodes, seriesContext, depth + 1);
      const right = inferExpression(expression.args[1]!, nodes, seriesContext, depth + 1);
      return expression.op === "multiply" ? multiplication(left, right) : division(left, right);
    }
    default: fail("UNSUPPORTED_EXPRESSION", "Unsupported expression operation");
  }
}

function assertNodeMetadata(node: ModelNode): void {
  if (!NODE_ID.test(node.id)) fail("MODEL_SCHEMA_INVALID", "Invalid stable node ID", { nodeId: node.id });
  if (node.currency !== undefined && (node.unit !== "money" || !CURRENCY.test(node.currency))) {
    fail("CURRENCY_MISMATCH", "Only money nodes may declare an ISO-style currency", { nodeId: node.id, currency: node.currency });
  }
  if (node.unit === "money" && !node.currency) fail("CURRENCY_MISMATCH", "Money node is missing currency", { nodeId: node.id });
  if (node.valueType === "decimal" && ["date", "boolean", "text", "period"].includes(node.unit)) fail("TYPE_MISMATCH", "Decimal node has a nonnumeric unit", { nodeId: node.id });
  if (node.valueType === "date" && node.unit !== "date") fail("TYPE_MISMATCH", "Date node must use date unit", { nodeId: node.id });
  if (node.valueType === "boolean" && node.unit !== "boolean") fail("TYPE_MISMATCH", "Boolean node must use boolean unit", { nodeId: node.id });
  if (node.valueType === "text" && !["text", "period"].includes(node.unit)) fail("TYPE_MISMATCH", "Text node has an invalid unit", { nodeId: node.id });
  if (node.rounding) {
    if (node.valueType !== "decimal" || !Number.isSafeInteger(node.rounding.decimalPlaces) || node.rounding.decimalPlaces < 0 || node.rounding.decimalPlaces > 34) {
      fail("MODEL_SCHEMA_INVALID", "Invalid node rounding policy", { nodeId: node.id });
    }
  }
  const uniqueDependencies = [...new Set(node.dependencies)];
  if (uniqueDependencies.length !== node.dependencies.length) fail("MODEL_SCHEMA_INVALID", "Node dependencies must be unique", { nodeId: node.id });
  if (node.kind === "input") {
    if (typeof node.required !== "boolean" || (node.allowStale !== undefined && typeof node.allowStale !== "boolean")) {
      fail("MODEL_SCHEMA_INVALID", "Input policy flags must be boolean", { nodeId: node.id });
    }
    if (node.allowedTruthClasses) {
      const valid = new Set<TruthClass>([
        "OBSERVED_FACT", "CANONICAL_ASSUMPTION", "MODEL_PARAMETER", "SCENARIO_OVERRIDE",
        "DERIVED_VALUE", "EXTERNAL_CALCULATED_COMPARISON", "UNKNOWN",
      ]);
      if (!node.allowedTruthClasses.length || new Set(node.allowedTruthClasses).size !== node.allowedTruthClasses.length
        || node.allowedTruthClasses.some((item) => !valid.has(item))) {
        fail("MODEL_SCHEMA_INVALID", "Input allowedTruthClasses must be a nonempty unique truth-class list", { nodeId: node.id });
      }
    }
    if (node.minimum !== undefined) decimal(node.minimum);
    if (node.maximum !== undefined) decimal(node.maximum);
    if (node.minimum !== undefined && node.maximum !== undefined && d(node.minimum).gt(d(node.maximum))) {
      fail("MODEL_SCHEMA_INVALID", "Input minimum exceeds maximum", { nodeId: node.id });
    }
    if (node.source?.staleAfterDays !== undefined
      && (!Number.isSafeInteger(node.source.staleAfterDays) || node.source.staleAfterDays < 0 || node.source.staleAfterDays > 36_500)) {
      fail("MODEL_SCHEMA_INVALID", "Input staleness policy is outside the supported bounds", { nodeId: node.id });
    }
  }
}

function assertExpressionNode(node: ModelNode, nodes: Readonly<Record<string, ModelNode>>): void {
  let expression: Expression | null = null;
  if (node.kind === "expression" || node.kind === "series") expression = node.expression;
  if (node.kind === "check") expression = node.assertion;
  if (!expression) return;
  const inferred = inferExpression(expression, nodes, node.kind === "series");
  const actual: ExpressionType = { valueType: node.valueType, unit: node.unit, currency: node.currency, shape: node.shape };
  sameType(actual, { ...inferred, shape: node.shape });
  const declared = [...node.dependencies].sort();
  const referenced = [...new Set(expressionRefs(expression))].sort();
  if (canonicalSerialize(declared) !== canonicalSerialize(referenced)) {
    fail("MISSING_DEPENDENCY", "Declared dependencies do not exactly match expression references", { nodeId: node.id, declared, referenced });
  }
}

function assertSolverBlock(block: CircularBlock, nodes: Readonly<Record<string, ModelNode>>, membership: Map<string, string>): void {
  if (!NODE_ID.test(block.id) || block.nodeIds.length < 2) fail("INVALID_SOLVER_BLOCK", "Circular block must have a stable ID and at least two nodes", { blockId: block.id });
  const ids = [...new Set(block.nodeIds)];
  if (ids.length !== block.nodeIds.length || [...block.iterationOrder].sort().join("\0") !== [...ids].sort().join("\0")) {
    fail("INVALID_SOLVER_BLOCK", "Circular block iteration order must contain each member exactly once", { blockId: block.id });
  }
  for (const id of ids) {
    if (!nodes[id]) fail("INVALID_SOLVER_BLOCK", "Circular block references a missing node", { blockId: block.id, nodeId: id });
    if (membership.has(id)) fail("INVALID_SOLVER_BLOCK", "Node belongs to more than one circular block", { nodeId: id });
    membership.set(id, block.id);
  }
  if (block.settings.algorithm !== "fixed_point" || !["opening_balance", "zero"].includes(block.settings.initialState)) fail("INVALID_SOLVER_BLOCK", "Unsupported circular solver configuration", { blockId: block.id });
  if (!Number.isSafeInteger(block.settings.maxIterations) || block.settings.maxIterations < 1 || block.settings.maxIterations > UNDERWRITING_LIMITS.solverIterations) {
    fail("INVALID_SOLVER_BLOCK", "Circular solver iteration limit is invalid", { blockId: block.id });
  }
  if (d(block.settings.absoluteTolerance).isNegative() || d(block.settings.relativeTolerance).isNegative()) fail("INVALID_SOLVER_BLOCK", "Solver tolerances must be nonnegative");
}

function buildExecutionOrder(nodes: Readonly<Record<string, ModelNode>>, blocks: readonly CircularBlock[]): string[] {
  const membership = new Map<string, string>();
  for (const block of blocks) assertSolverBlock(block, nodes, membership);
  const components = new Set<string>();
  const componentOf = (id: string): string => membership.get(id) ? `block:${membership.get(id)}` : `node:${id}`;
  for (const id of Object.keys(nodes)) components.add(componentOf(id));
  const incoming = new Map<string, Set<string>>([...components].map((id) => [id, new Set()]));
  const outgoing = new Map<string, Set<string>>([...components].map((id) => [id, new Set()]));
  for (const node of Object.values(nodes)) {
    const target = componentOf(node.id);
    for (const dependency of node.dependencies) {
      const source = componentOf(dependency);
      if (source === target) {
        if (!membership.has(node.id)) fail("UNDECLARED_CYCLE", "Self-dependency is not inside a declared circular block", { nodeId: node.id });
        continue;
      }
      incoming.get(target)!.add(source);
      outgoing.get(source)!.add(target);
    }
  }
  const ready = [...components].filter((id) => incoming.get(id)!.size === 0).sort();
  const componentOrder: string[] = [];
  while (ready.length) {
    const current = ready.shift()!;
    componentOrder.push(current);
    for (const next of [...outgoing.get(current)!].sort()) {
      incoming.get(next)!.delete(current);
      if (incoming.get(next)!.size === 0) {
        ready.push(next);
        ready.sort();
      }
    }
  }
  if (componentOrder.length !== components.size) fail("UNDECLARED_CYCLE", "Model dependency graph contains an undeclared cycle");
  const byBlock = new Map(blocks.map((block) => [block.id, block]));
  return componentOrder.flatMap((component) => component.startsWith("node:")
    ? [component.slice(5)]
    : [...byBlock.get(component.slice(6))!.iterationOrder]);
}

function semanticModel(model: UnderwritingModelIR): unknown {
  return {
    schemaVersion: model.schemaVersion,
    financialConventionVersion: model.financialConventionVersion,
    minimumEngineVersion: model.minimumEngineVersion,
    periodDefinition: model.periodDefinition,
    nodes: model.nodes,
    circularBlocks: model.circularBlocks,
    runtime: model.runtime,
  };
}

export function compileUnderwritingModel(model: UnderwritingModelIR): CompiledUnderwritingModel {
  if (!model || model.schemaVersion !== UNDERWRITING_MODEL_SCHEMA_VERSION) fail("MODEL_SCHEMA_INVALID", "Unsupported underwriting ModelIR schema");
  if (!MODEL_KEY.test(model.modelKey) || typeof model.modelVersion !== "string" || !model.modelVersion.trim()) fail("MODEL_SCHEMA_INVALID", "Model identity is invalid");
  if (!model.minimumEngineVersion.startsWith("finnor-underwriting-engine/1.")) {
    fail("MODEL_SCHEMA_INVALID", "Model requires an incompatible engine", { required: model.minimumEngineVersion, actual: UNDERWRITING_ENGINE_VERSION });
  }
  const bytes = Buffer.byteLength(canonicalSerialize(model));
  if (bytes > UNDERWRITING_LIMITS.modelBytes) fail("MODEL_TOO_LARGE", "Canonical ModelVersion exceeds the byte limit", { bytes });
  if (!Array.isArray(model.nodes) || model.nodes.length === 0 || model.nodes.length > UNDERWRITING_LIMITS.modelNodes) {
    fail("MODEL_TOO_LARGE", "Model node count is outside the supported bounds", { count: model.nodes?.length });
  }
  const nodes: Record<string, ModelNode> = {};
  for (const node of model.nodes) {
    assertNodeMetadata(node);
    if (nodes[node.id]) fail("DUPLICATE_NODE", "Model contains a duplicate node ID", { nodeId: node.id });
    nodes[node.id] = node;
  }
  for (const node of model.nodes) {
    for (const dependency of node.dependencies) if (!nodes[dependency]) fail("MISSING_DEPENDENCY", "Node dependency does not exist", { nodeId: node.id, dependency });
    assertExpressionNode(node, nodes);
    if (node.kind === "constant" && node.valueType === "decimal") {
      if (node.shape === "scalar") decimal(String(node.value));
      else for (const value of Object.values(node.value as Record<string, unknown>)) decimal(String(value));
    }
    if (node.kind === "aggregate") {
      const source = nodes[node.sourceNodeId];
      if (!source || source.shape !== "series") fail("TYPE_MISMATCH", "Aggregate source must be a series", { nodeId: node.id });
      if (node.dependencies.length !== 1 || node.dependencies[0] !== node.sourceNodeId) fail("MISSING_DEPENDENCY", "Aggregate dependency must exactly match sourceNodeId", { nodeId: node.id });
      sameType(
        { valueType: node.valueType, unit: node.unit, currency: node.currency, shape: "scalar" },
        { valueType: source.valueType, unit: source.unit, currency: source.currency, shape: "scalar" },
      );
    }
    if (node.kind === "output") {
      const source = nodes[node.sourceNodeId];
      if (!source) fail("MISSING_DEPENDENCY", "Output source does not exist", { nodeId: node.id });
      if (node.dependencies.length !== 1 || node.dependencies[0] !== node.sourceNodeId) fail("MISSING_DEPENDENCY", "Output dependency must exactly match sourceNodeId", { nodeId: node.id });
      sameType(
        { valueType: node.valueType, unit: node.unit, currency: node.currency, shape: node.shape },
        { valueType: source.valueType, unit: source.unit, currency: source.currency, shape: source.shape },
      );
    }
  }
  if (model.runtime?.kind === "standard_lbo_v1") {
    if (!CURRENCY.test(model.runtime.currency)) fail("CURRENCY_MISMATCH", "Standard LBO runtime currency is invalid");
    if (model.runtime.debtTranches.length > UNDERWRITING_LIMITS.debtTranches) fail("MODEL_TOO_LARGE", "Debt tranche count exceeds the hard limit");
    const ids = new Set<string>();
    for (const tranche of model.runtime.debtTranches) {
      if (!NODE_ID.test(tranche.id) || ids.has(tranche.id)) fail("MODEL_SCHEMA_INVALID", "Debt tranche IDs must be unique and stable", { trancheId: tranche.id });
      if (!Number.isSafeInteger(tranche.seniority) || tranche.seniority < 0
        || !Number.isSafeInteger(tranche.sweepPriority) || tranche.sweepPriority < 0) {
        fail("MODEL_SCHEMA_INVALID", "Debt priority fields must be nonnegative structural integers", { trancheId: tranche.id });
      }
      if (!["term", "revolver", "seller_note"].includes(tranche.kind)
        || !["fixed", "floating"].includes(tranche.rateType)
        || !["beginning_balance", "average_balance"].includes(tranche.interestBasis)
        || !["original_principal_percent", "explicit_amount"].includes(tranche.amortization)
        || !["mandatory_repayment", "unsupported"].includes(tranche.maturityTreatment)
        || typeof tranche.cashSweepEligible !== "boolean") {
        fail("MODEL_SCHEMA_INVALID", "Debt tranche configuration is unsupported", { trancheId: tranche.id });
      }
      ids.add(tranche.id);
    }
  }
  const executionOrder = buildExecutionOrder(nodes, model.circularBlocks ?? []);
  const dependencyGraph: Record<string, readonly string[]> = {};
  const dependentsGraph: Record<string, string[]> = {};
  for (const id of Object.keys(nodes)) dependentsGraph[id] = [];
  for (const node of model.nodes) {
    dependencyGraph[node.id] = Object.freeze([...node.dependencies]);
    for (const dependency of node.dependencies) dependentsGraph[dependency]!.push(node.id);
  }
  for (const values of Object.values(dependentsGraph)) values.sort();
  return deepFreeze({
    model: deepFreeze(structuredClone(model)) as Readonly<UnderwritingModelIR>,
    periods: buildPeriods(model.periodDefinition),
    semanticHash: semanticHash(semanticModel(model)),
    executionOrder,
    nodeById: nodes,
    dependencyGraph,
    dependentsGraph,
  }) as CompiledUnderwritingModel;
}

export function affectedNodes(model: CompiledUnderwritingModel, changedNodeIds: readonly string[]): readonly string[] {
  const queue = [...new Set(changedNodeIds)].sort();
  const seen = new Set<string>();
  while (queue.length) {
    const current = queue.shift()!;
    if (!model.nodeById[current]) fail("MISSING_DEPENDENCY", "Changed node does not exist", { nodeId: current });
    if (seen.has(current)) continue;
    seen.add(current);
    queue.push(...(model.dependentsGraph[current] ?? []));
    queue.sort();
  }
  return Object.freeze([...seen].sort());
}
