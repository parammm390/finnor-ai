export type UnderwritingScalar = string | boolean;
export type UnderwritingValue = UnderwritingScalar | Record<string, UnderwritingScalar>;

export interface UnderwritingProvenance {
  kind: string;
  id: string;
  versionId?: string;
  anchorId?: string;
  semanticHash?: string;
  effectiveAt?: string;
  observedAt?: string;
  retrievedAt?: string;
}

export interface UnderwritingInput {
  nodeId: string;
  valueType: string;
  unit: string;
  currency?: string;
  shape: "scalar" | "series";
  value: UnderwritingValue | null;
  truthClass: string;
  status: string;
  provenance: UnderwritingProvenance[];
  reason?: string;
}

export interface UnderwritingNodeResult {
  nodeId: string;
  value: UnderwritingValue;
  valueType: string;
  unit: string;
  currency?: string;
  shape: "scalar" | "series";
  truthClass: string;
  directDependencies: string[];
  calculation: string;
}

export interface UnderwritingCheck {
  nodeId: string;
  passed: boolean;
  severity: "error" | "warning";
  code: string;
  message: string;
  difference?: string;
  tolerance?: string;
}

export interface UnderwritingRun {
  id: string;
  modelVersionId: string;
  scenarioId: string | null;
  workId: string | null;
  worldAt: string;
  computedAt: string;
  engineVersion: string;
  modelSemanticHash: string;
  inputHash: string;
  resultHash: string;
  status: "SUCCEEDED" | "FAILED";
  validity: "VALID" | "INVALID" | "INCOMPLETE" | "NON_CONVERGENT";
  failureCode: string | null;
  inputSnapshot: { schemaVersion: string; investmentCaseId: string; worldAt: string; semanticHash: string; values: Record<string, UnderwritingInput> };
  result: {
    status: "SUCCEEDED" | "FAILED";
    validity: "VALID" | "INVALID" | "INCOMPLETE" | "NON_CONVERGENT";
    engineVersion: string;
    modelSemanticHash: string;
    inputSemanticHash: string;
    scenarioSemanticHash?: string;
    resultSemanticHash: string;
    values: Record<string, UnderwritingNodeResult>;
    outputs: Record<string, UnderwritingNodeResult>;
    checks: UnderwritingCheck[];
    solverDiagnostics: Array<Record<string, unknown>>;
    sponsorCashFlows?: Array<{ amount: string; date: string; type: string; periodId?: string }>;
    failure?: { code: string; message: string; details: Record<string, unknown> };
  };
}

export interface UnderwritingWorkspace {
  investmentCase: { id: string; dealId: string; title: string; summary: string | null; state: string; version: number; createdAt: string; updatedAt: string };
  models: Array<{ id: string; investmentCaseId: string; modelKey: string; name: string; createdAt: string }>;
  modelVersions: Array<{ id: string; modelId: string; versionKey: string; semanticHash: string; schemaVersion: string; financialConventionVersion: string; minimumEngineVersion: string; parentVersionId: string | null; createdAt: string }>;
  modelInputBindings: Array<{ modelVersionId: string; inputNodeId: string; sourceKind: string; assumptionId: string | null; evidenceVersionId: string | null; documentId: string | null; documentVersionId: string | null; anchorId: string | null; anchorHash: string | null; valuePath: string | null; valueSelector: string | null; staleAfterDays: number | null }>;
  scenarios: Array<{ id: string; modelVersionId: string; parentScenarioId: string | null; name: string; semanticHash: string; definition: { overrides: Array<{ nodeId: string; value: UnderwritingValue; reason?: string }> }; createdAt: string }>;
  runs: UnderwritingRun[];
  sensitivities: Array<{ id: string; modelVersionId: string; baseRunId: string; name: string; definitionHash: string; definition: SensitivityDefinition; status: string; cellCount: number; createdAt: string }>;
  artifactBindings: Array<{ id: string; modelVersionId: string; documentId: string; documentVersionId: string; direction: "input" | "output"; bindingMode: string; modelNodeId: string; anchorId: string; anchorHash: string; valueSelector: string | null; comparisonPolicy: Record<string, unknown> | null; bindingVersion: number; supersedesBindingId: string | null }>;
  artifactProjections: Array<Record<string, unknown>>;
  complete: true;
}

export interface SensitivityDefinition {
  schemaVersion: "underwriting-sensitivity.v1";
  name: string;
  rowAxis: { nodeId: string; values: UnderwritingValue[]; label?: string };
  columnAxis?: { nodeId: string; values: UnderwritingValue[]; label?: string };
  outputNodeIds: string[];
}

export interface UnderwritingSensitivityDetail {
  id: string;
  name: string;
  definition: SensitivityDefinition;
  status: string;
  cellCount: number;
  complete: boolean;
  cells: Array<{
    rowIndex: number;
    columnIndex: number;
    coordinates: { overrides: Array<{ nodeId: string; value: UnderwritingValue }>; resultHash: string };
    runId: string;
    runStatus: string;
    runValidity: string;
    resultHash: string;
    result: UnderwritingRun["result"];
  }>;
}

export interface UnderwritingLineage {
  nodeId: string;
  calculation: string;
  value: UnderwritingValue;
  truthClass: string;
  directDependencies: string[];
  sourceProvenance: UnderwritingProvenance[];
  dependencies: UnderwritingLineage[];
}

export function shortIdentity(value: string | null | undefined, length = 12): string {
  if (!value) return "—";
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

export function renderExactValue(value: UnderwritingScalar, unit: string, currency?: string): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (unit === "money") return `${currency ?? "CUR"} ${value}`;
  if (unit === "multiple") return `${value}x`;
  if (unit === "rate") return `${value} (rate fraction)`;
  return value;
}

export function statusClassName(value: string): string {
  if (/^(VALID|SUCCEEDED|KNOWN|MATCH|CALCULATED|true)$/i.test(value)) return "uw-status good";
  if (/INVALID|FAILED|CONFLICT|MISMATCH|STALE|UNKNOWN|INCOMPLETE|NON_CONVERGENT|false/i.test(value)) return "uw-status bad";
  return "uw-status neutral";
}
