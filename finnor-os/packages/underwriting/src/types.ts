import type { DecimalString } from "./decimal";
import type { UnderwritingFailureCode } from "./errors";

export const UNDERWRITING_ENGINE_VERSION = "finnor-underwriting-engine/1.0.0" as const;
export const UNDERWRITING_MODEL_SCHEMA_VERSION = "underwriting-model-ir.v1" as const;
export const FINANCIAL_CONVENTION_VERSION = "finnor-pe-lbo/1.0.0" as const;

export const UNDERWRITING_LIMITS = Object.freeze({
  modelNodes: 10_000,
  forecastPeriods: 240,
  debtTranches: 32,
  scenarioOverrides: 100,
  sensitivityCells: 2_500,
  solverIterations: 200,
  expressionDepth: 64,
  modelBytes: 5 * 1024 * 1024,
  resultBytes: 10 * 1024 * 1024,
  provenanceRefsPerInput: 32,
});

export type TruthClass =
  | "OBSERVED_FACT"
  | "CANONICAL_ASSUMPTION"
  | "MODEL_PARAMETER"
  | "SCENARIO_OVERRIDE"
  | "DERIVED_VALUE"
  | "EXTERNAL_CALCULATED_COMPARISON"
  | "UNKNOWN";

export type InputTruthStatus = "KNOWN" | "UNKNOWN" | "STALE" | "CONFLICTING" | "UNSUPPORTED";
export type ValueType = "decimal" | "date" | "boolean" | "text";
export type ValueUnit = "money" | "rate" | "multiple" | "ratio" | "count" | "date" | "period" | "boolean" | "text";
export type ValueShape = "scalar" | "series";
export type PeriodFrequency = "annual" | "quarterly" | "monthly";

export interface FinancialPeriod {
  id: string;
  ordinal: number;
  startDate: string;
  endDate: string;
  fiscalLabel: string;
}

export interface PeriodDefinition {
  frequency: PeriodFrequency;
  forecastStart: string;
  count: number;
  fiscalYearStartMonth?: number;
}

export type ScalarValue = DecimalString | string | boolean;
export type SeriesValue = Readonly<Record<string, ScalarValue>>;
export type ModelValue = ScalarValue | SeriesValue;

export interface InputProvenanceRef {
  kind: "p1_assumption" | "evidence_version" | "model_parameter" | "human_input" | "artifact_anchor";
  id: string;
  versionId?: string;
  anchorId?: string;
  semanticHash?: string;
  effectiveAt?: string;
  observedAt?: string;
  retrievedAt?: string;
}

export interface ResolvedInput {
  nodeId: string;
  valueType: ValueType;
  unit: ValueUnit;
  currency?: string;
  shape: ValueShape;
  value: ModelValue | null;
  truthClass: TruthClass;
  status: InputTruthStatus;
  provenance: readonly InputProvenanceRef[];
  reason?: string;
}

export interface UnderwritingInputSnapshot {
  schemaVersion: "underwriting-input-snapshot.v1";
  investmentCaseId: string;
  worldAt: string;
  values: Readonly<Record<string, ResolvedInput>>;
  semanticHash?: string;
}

export interface InputSourceBinding {
  kind: "p1_assumption" | "evidence_version" | "artifact_anchor" | "explicit" | "model_parameter";
  assumptionId?: string;
  evidenceVersionId?: string;
  documentId?: string;
  documentVersionId?: string;
  anchorId?: string;
  anchorHash?: string;
  valuePath?: string;
  valueSelector?: string;
  staleAfterDays?: number;
}

export interface NodeBase {
  id: string;
  label?: string;
  kind: "input" | "constant" | "expression" | "series" | "schedule" | "aggregate" | "check" | "output";
  valueType: ValueType;
  unit: ValueUnit;
  currency?: string;
  shape: ValueShape;
  dependencies: readonly string[];
  rounding?: { decimalPlaces: number };
}

export interface InputNode extends NodeBase {
  kind: "input";
  required: boolean;
  source?: InputSourceBinding;
  /** Exact ModelVersion policy. STALE remains fail-closed unless this is true. */
  allowStale?: boolean;
  /** If present, resolved truth must be one of these classes. */
  allowedTruthClasses?: readonly TruthClass[];
  minimum?: DecimalString;
  maximum?: DecimalString;
}

export interface ConstantNode extends NodeBase {
  kind: "constant";
  value: ModelValue;
  truthClass: "MODEL_PARAMETER";
}

export type ComparisonOperator = "eq" | "ne" | "lt" | "lte" | "gt" | "gte";

export type Expression =
  | { op: "literal"; value: ScalarValue; valueType: ValueType; unit: ValueUnit; currency?: string }
  | { op: "ref"; nodeId: string }
  | { op: "lag"; nodeId: string; periods: number }
  | { op: "add" | "subtract" | "multiply" | "divide" | "min" | "max"; args: readonly Expression[] }
  | { op: "sum"; args: readonly Expression[] }
  | { op: "negate"; arg: Expression }
  | { op: "compare"; comparison: ComparisonOperator; left: Expression; right: Expression }
  | { op: "if"; condition: Expression; then: Expression; else: Expression };

export interface ExpressionNode extends NodeBase {
  kind: "expression";
  shape: "scalar";
  expression: Expression;
}

export interface SeriesNode extends NodeBase {
  kind: "series";
  shape: "series";
  expression: Expression;
}

export interface ScheduleNode extends NodeBase {
  kind: "schedule";
  schedule: {
    kind: "standard_lbo_v1";
    line: string;
  };
}

export interface AggregateNode extends NodeBase {
  kind: "aggregate";
  shape: "scalar";
  aggregation: "sum" | "min" | "max" | "first" | "last";
  sourceNodeId: string;
}

export interface CheckNode extends NodeBase {
  kind: "check";
  valueType: "boolean";
  unit: "boolean";
  shape: "scalar";
  assertion: Expression;
  failureCode: UnderwritingFailureCode;
  severity: "error" | "warning";
}

export interface OutputNode extends NodeBase {
  kind: "output";
  sourceNodeId: string;
}

export type ModelNode = InputNode | ConstantNode | ExpressionNode | SeriesNode | ScheduleNode | AggregateNode | CheckNode | OutputNode;

export interface SolverSettings {
  algorithm: "fixed_point";
  initialState: "opening_balance" | "zero";
  absoluteTolerance: DecimalString;
  relativeTolerance: DecimalString;
  maxIterations: number;
}

export interface CircularBlock {
  id: string;
  nodeIds: readonly string[];
  iterationOrder: readonly string[];
  settings: SolverSettings;
}

export interface StandardLboRuntimeDefinition {
  kind: "standard_lbo_v1";
  currency: string;
  entryValuationMethod: "direct_enterprise_value" | "metric_multiple";
  revenueMethod: "explicit" | "growth";
  ebitdaMethod: "explicit" | "margin";
  dAndATreatment: "explicit" | "ebitda_equals_ebit";
  capexMethod: "explicit" | "percent_revenue";
  workingCapitalMethod: "explicit_nwc" | "percent_revenue";
  debtTranches: readonly StandardDebtTrancheDefinition[];
  solver: SolverSettings;
}

export interface UnderwritingModelIR {
  schemaVersion: typeof UNDERWRITING_MODEL_SCHEMA_VERSION;
  modelKey: string;
  modelVersion: string;
  financialConventionVersion: string;
  minimumEngineVersion: string;
  periodDefinition: PeriodDefinition;
  nodes: readonly ModelNode[];
  circularBlocks: readonly CircularBlock[];
  runtime?: StandardLboRuntimeDefinition;
  metadata?: Readonly<Record<string, string | boolean | number>>;
}

export interface CompiledUnderwritingModel {
  model: Readonly<UnderwritingModelIR>;
  periods: readonly FinancialPeriod[];
  semanticHash: string;
  executionOrder: readonly string[];
  nodeById: Readonly<Record<string, ModelNode>>;
  dependencyGraph: Readonly<Record<string, readonly string[]>>;
  dependentsGraph: Readonly<Record<string, readonly string[]>>;
}

export interface StandardDebtTrancheDefinition {
  id: string;
  name: string;
  kind: "term" | "revolver" | "seller_note";
  seniority: number;
  sweepPriority: number;
  rateType: "fixed" | "floating";
  interestBasis: "beginning_balance" | "average_balance";
  amortization: "original_principal_percent" | "explicit_amount";
  cashSweepEligible: boolean;
  maturityTreatment: "mandatory_repayment" | "unsupported";
}

export interface NodeExecutionResult {
  nodeId: string;
  value: ModelValue;
  valueType: ValueType;
  unit: ValueUnit;
  currency?: string;
  shape: ValueShape;
  truthClass: TruthClass;
  directDependencies: readonly string[];
  calculation: string;
}

export interface CheckResult {
  nodeId: string;
  passed: boolean;
  severity: "error" | "warning";
  code: UnderwritingFailureCode;
  message: string;
  difference?: DecimalString;
  tolerance?: DecimalString;
}

export interface SolverDiagnostic {
  blockId: string;
  periodId?: string;
  algorithm: "fixed_point";
  iterations: number;
  converged: boolean;
  absoluteError: DecimalString;
  relativeError: DecimalString;
}

export interface SponsorCashFlow {
  amount: DecimalString;
  date: string;
  type: "initial_investment" | "subsequent_contribution" | "interim_distribution" | "exit_distribution";
  periodId?: string;
}

export type UnderwritingRunValidity = "VALID" | "INVALID" | "INCOMPLETE" | "NON_CONVERGENT";

export interface UnderwritingRunResult {
  status: "SUCCEEDED" | "FAILED";
  validity: UnderwritingRunValidity;
  engineVersion: typeof UNDERWRITING_ENGINE_VERSION;
  modelSemanticHash: string;
  inputSemanticHash: string;
  scenarioSemanticHash?: string;
  resultSemanticHash: string;
  values: Readonly<Record<string, NodeExecutionResult>>;
  outputs: Readonly<Record<string, NodeExecutionResult>>;
  checks: readonly CheckResult[];
  solverDiagnostics: readonly SolverDiagnostic[];
  sponsorCashFlows?: readonly SponsorCashFlow[];
  failure?: {
    code: UnderwritingFailureCode;
    message: string;
    details: Readonly<Record<string, unknown>>;
  };
}

export interface ScenarioOverride {
  nodeId: string;
  value: ModelValue;
  reason?: string;
}

export interface UnderwritingScenario {
  schemaVersion: "underwriting-scenario.v1";
  id?: string;
  name: string;
  parentScenarioId?: string;
  overrides: readonly ScenarioOverride[];
  semanticHash?: string;
}

export interface SensitivityAxis {
  nodeId: string;
  values: readonly ModelValue[];
  label?: string;
}

export interface SensitivityDefinition {
  schemaVersion: "underwriting-sensitivity.v1";
  name: string;
  rowAxis: SensitivityAxis;
  columnAxis?: SensitivityAxis;
  outputNodeIds: readonly string[];
}

export interface SensitivityCell {
  rowIndex: number;
  columnIndex: number;
  overrides: readonly ScenarioOverride[];
  inputSemanticHash: string;
  resultSemanticHash: string;
  runSemanticIdentity: string;
  status: "SUCCEEDED" | "FAILED";
  validity: UnderwritingRunValidity;
  outputs: Readonly<Record<string, ModelValue>>;
  failureCode?: UnderwritingFailureCode;
}

export interface OutputExplanationNode {
  nodeId: string;
  calculation: string;
  value: ModelValue;
  truthClass: TruthClass;
  directDependencies: readonly string[];
  sourceProvenance: readonly InputProvenanceRef[];
  dependencies: readonly OutputExplanationNode[];
}

export interface SensitivityResult {
  definitionSemanticHash: string;
  status: "SUCCEEDED" | "PARTIAL" | "FAILED";
  cells: readonly SensitivityCell[];
}

export type ComparisonPolicy =
  | { mode: "EXACT_DECIMAL" }
  | { mode: "DECLARED_ROUNDED_VALUE"; decimalPlaces: number }
  | { mode: "EXPLICIT_ABSOLUTE_TOLERANCE"; tolerance: DecimalString }
  | { mode: "EXPLICIT_RELATIVE_TOLERANCE"; tolerance: DecimalString };

export type ArtifactComparisonStatus =
  | "MATCH"
  | "MISMATCH"
  | "EXCEL_STALE"
  | "EXCEL_UNCALCULATED"
  | "ANCHOR_CONFLICT"
  | "VERSION_CONFLICT"
  | "UNSUPPORTED"
  | "UNKNOWN";

export interface ArtifactValueComparison {
  modelValue: DecimalString;
  artifactValue: DecimalString | null;
  difference: DecimalString | null;
  policy: ComparisonPolicy;
  status: ArtifactComparisonStatus;
}
