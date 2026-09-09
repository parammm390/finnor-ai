import { canonicalSerialize, deepFreeze, semanticHash } from "./canonical";
import { cmp, decimal } from "./decimal";
import { fail } from "./errors";
import {
  UNDERWRITING_LIMITS,
  type CompiledUnderwritingModel,
  type ModelValue,
  type ResolvedInput,
  type UnderwritingInputSnapshot,
  type UnderwritingScenario,
} from "./types";

export function inputSnapshotHash(snapshot: Omit<UnderwritingInputSnapshot, "semanticHash"> | UnderwritingInputSnapshot): string {
  const { semanticHash: _ignored, ...body } = snapshot as UnderwritingInputSnapshot;
  return semanticHash(body);
}

function normalizeValue(value: ModelValue, input: ResolvedInput): ModelValue {
  if (input.shape === "scalar") {
    if (value !== null && typeof value === "object") fail("TYPE_MISMATCH", "Scalar input received a series", { nodeId: input.nodeId });
    if (input.valueType === "decimal") return decimal(String(value));
    if (input.valueType === "boolean" && typeof value !== "boolean") fail("TYPE_MISMATCH", "Boolean input received a non-boolean", { nodeId: input.nodeId });
    if ((input.valueType === "date" || input.valueType === "text") && typeof value !== "string") fail("TYPE_MISMATCH", "Text/date input received a non-string", { nodeId: input.nodeId });
    return value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("TYPE_MISMATCH", "Series input received a scalar", { nodeId: input.nodeId });
  const output: Record<string, string | boolean> = {};
  for (const [periodId, item] of Object.entries(value)) {
    if (item !== null && typeof item === "object") fail("TYPE_MISMATCH", "Nested input series are unsupported", { nodeId: input.nodeId });
    if (input.valueType === "decimal") output[periodId] = decimal(String(item));
    else if (input.valueType === "boolean") {
      if (typeof item !== "boolean") fail("TYPE_MISMATCH", "Boolean series contains a non-boolean", { nodeId: input.nodeId, periodId });
      output[periodId] = item;
    } else {
      if (typeof item !== "string") fail("TYPE_MISMATCH", "Text/date series contains a non-string", { nodeId: input.nodeId, periodId });
      output[periodId] = item;
    }
  }
  return output;
}

export function sealInputSnapshot(snapshot: Omit<UnderwritingInputSnapshot, "semanticHash"> | UnderwritingInputSnapshot): Readonly<UnderwritingInputSnapshot> {
  const suppliedSemanticHash = (snapshot as UnderwritingInputSnapshot).semanticHash;
  const values: Record<string, ResolvedInput> = {};
  for (const [nodeId, input] of Object.entries(snapshot.values)) {
    if (input.nodeId !== nodeId) fail("MODEL_SCHEMA_INVALID", "Input snapshot key and node identity differ", { nodeId, embeddedNodeId: input.nodeId });
    if (input.provenance.length > UNDERWRITING_LIMITS.provenanceRefsPerInput) fail("MODEL_SCHEMA_INVALID", "Input provenance exceeds the hard limit", { nodeId });
    values[nodeId] = {
      ...structuredClone(input),
      value: input.value === null ? null : normalizeValue(input.value, input),
      provenance: [...input.provenance],
    };
  }
  const body = { schemaVersion: snapshot.schemaVersion, investmentCaseId: snapshot.investmentCaseId, worldAt: snapshot.worldAt, values } as const;
  const hash = inputSnapshotHash(body);
  if (suppliedSemanticHash && suppliedSemanticHash !== hash) fail("INPUT_SEMANTIC_HASH_MISMATCH", "InputSnapshot semantic hash does not match its contents", { expected: suppliedSemanticHash, actual: hash });
  return deepFreeze({ ...body, semanticHash: hash });
}

export function scenarioHash(scenario: UnderwritingScenario): string {
  const normalized = [...scenario.overrides]
    .map(({ nodeId, value }) => ({ nodeId, value }))
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  return semanticHash({ schemaVersion: scenario.schemaVersion, parentScenarioId: scenario.parentScenarioId, overrides: normalized });
}

export function applyScenario(
  model: CompiledUnderwritingModel,
  sourceSnapshot: UnderwritingInputSnapshot,
  scenario?: UnderwritingScenario,
): { snapshot: Readonly<UnderwritingInputSnapshot>; scenarioSemanticHash?: string } {
  const baseline = sealInputSnapshot(sourceSnapshot);
  if (!scenario) return { snapshot: baseline };
  if (scenario.schemaVersion !== "underwriting-scenario.v1" || !scenario.name.trim()) fail("MODEL_SCHEMA_INVALID", "Scenario identity is invalid");
  if (scenario.overrides.length > UNDERWRITING_LIMITS.scenarioOverrides) fail("SCENARIO_LIMIT", "Scenario exceeds the override limit", { count: scenario.overrides.length });
  const hash = scenarioHash(scenario);
  if (scenario.semanticHash && scenario.semanticHash !== hash) fail("MODEL_SEMANTIC_HASH_MISMATCH", "Scenario semantic hash does not match its overrides");
  const values = structuredClone(baseline.values) as Record<string, ResolvedInput>;
  const seen = new Set<string>();
  for (const override of scenario.overrides) {
    if (seen.has(override.nodeId)) fail("SCENARIO_INVALID_TARGET", "Scenario contains duplicate targets", { nodeId: override.nodeId });
    seen.add(override.nodeId);
    const node = model.nodeById[override.nodeId];
    const current = values[override.nodeId];
    if (!node || node.kind !== "input" || !current) fail("SCENARIO_INVALID_TARGET", "Scenario target is not an existing resolved InputNode", { nodeId: override.nodeId });
    values[override.nodeId] = {
      ...current,
      value: normalizeValue(override.value, current),
      truthClass: "SCENARIO_OVERRIDE",
      status: "KNOWN",
      reason: override.reason,
      provenance: current.provenance,
    };
  }
  return {
    snapshot: sealInputSnapshot({
      schemaVersion: baseline.schemaVersion,
      investmentCaseId: baseline.investmentCaseId,
      worldAt: baseline.worldAt,
      values,
    }),
    scenarioSemanticHash: hash,
  };
}

export function assertSnapshotMatchesModel(model: CompiledUnderwritingModel, snapshot: UnderwritingInputSnapshot): void {
  for (const node of Object.values(model.nodeById)) {
    if (node.kind !== "input") continue;
    const input = snapshot.values[node.id];
    if (!input) {
      if (node.required) fail("MISSING_REQUIRED_INPUT", "Required InputNode is absent", { nodeId: node.id });
      continue;
    }
    if (input.valueType !== node.valueType || input.unit !== node.unit || input.shape !== node.shape) fail("TYPE_MISMATCH", "Resolved input metadata differs from its InputNode", { nodeId: node.id });
    if (input.currency !== node.currency) fail("CURRENCY_MISMATCH", "Resolved input currency differs from its InputNode", { nodeId: node.id });
    if (node.allowedTruthClasses && !node.allowedTruthClasses.includes(input.truthClass)) {
      fail("UNSUPPORTED_INPUT", "Resolved input truth class is forbidden by the exact ModelVersion policy", { nodeId: node.id, truthClass: input.truthClass });
    }
    if (input.status === "UNKNOWN") fail("UNKNOWN_INPUT", input.reason ?? "Required input truth is unknown", { nodeId: node.id });
    if (input.status === "STALE" && !node.allowStale) fail("STALE_INPUT", input.reason ?? "Input is stale under the ModelVersion policy", { nodeId: node.id });
    if (input.status === "CONFLICTING") fail("CONFLICTING_INPUT", input.reason ?? "Input has unresolved conflicting truth", { nodeId: node.id });
    if (input.status === "UNSUPPORTED") fail("UNSUPPORTED_INPUT", input.reason ?? "Input source is unsupported", { nodeId: node.id });
    if (input.value === null && node.required) fail("MISSING_REQUIRED_INPUT", "Required input has no value", { nodeId: node.id });
    if (node.shape === "series" && input.value !== null) {
      const actualPeriods = Object.keys(input.value as Record<string, unknown>).sort();
      const expectedPeriods = model.periods.map((period) => period.id).sort();
      if (canonicalSerialize(actualPeriods) !== canonicalSerialize(expectedPeriods)) {
        fail("PERIOD_MISMATCH", "Input series must contain every and only the exact ModelVersion periods", { nodeId: node.id, expectedPeriods, actualPeriods });
      }
      if (node.valueType === "decimal") {
        for (const [periodId, raw] of Object.entries(input.value as Record<string, unknown>)) {
          const value = decimal(String(raw));
          if (node.minimum !== undefined && cmp(value, node.minimum) < 0) fail("MODEL_SCHEMA_INVALID", "Series input item is below its declared minimum", { nodeId: node.id, periodId });
          if (node.maximum !== undefined && cmp(value, node.maximum) > 0) fail("MODEL_SCHEMA_INVALID", "Series input item exceeds its declared maximum", { nodeId: node.id, periodId });
        }
      }
    }
    if (node.valueType === "decimal" && node.shape === "scalar" && input.value !== null) {
      const value = decimal(String(input.value));
      if (node.minimum !== undefined && cmp(value, node.minimum) < 0) fail("MODEL_SCHEMA_INVALID", "Input is below its declared minimum", { nodeId: node.id });
      if (node.maximum !== undefined && cmp(value, node.maximum) > 0) fail("MODEL_SCHEMA_INVALID", "Input exceeds its declared maximum", { nodeId: node.id });
    }
  }
}

export function snapshotsEqual(left: UnderwritingInputSnapshot, right: UnderwritingInputSnapshot): boolean {
  return canonicalSerialize(sealInputSnapshot(left)) === canonicalSerialize(sealInputSnapshot(right));
}
