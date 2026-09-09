import { deepFreeze, semanticHash } from "./canonical";
import { fail } from "./errors";
import { executeUnderwritingModel } from "./executor";
import { applyScenario } from "./snapshot";
import {
  UNDERWRITING_ENGINE_VERSION,
  UNDERWRITING_LIMITS,
  type CompiledUnderwritingModel,
  type ModelValue,
  type SensitivityCell,
  type SensitivityDefinition,
  type SensitivityResult,
  type UnderwritingInputSnapshot,
  type UnderwritingScenario,
} from "./types";

export function semanticRunIdentity(input: {
  investmentCaseId: string;
  modelSemanticHash: string;
  inputSemanticHash: string;
  scenarioSemanticHash?: string;
  worldAt: string;
  engineVersion?: string;
}): string {
  return semanticHash({ ...input, engineVersion: input.engineVersion ?? UNDERWRITING_ENGINE_VERSION });
}

export function executeSensitivity(
  model: CompiledUnderwritingModel,
  snapshot: UnderwritingInputSnapshot,
  definition: SensitivityDefinition,
): Readonly<SensitivityResult> {
  if (definition.schemaVersion !== "underwriting-sensitivity.v1" || !definition.name.trim()) fail("MODEL_SCHEMA_INVALID", "Sensitivity definition is invalid");
  if (!definition.rowAxis.values.length || (definition.columnAxis && !definition.columnAxis.values.length)) fail("MODEL_SCHEMA_INVALID", "Sensitivity axes cannot be empty");
  if (definition.columnAxis?.nodeId === definition.rowAxis.nodeId) fail("SCENARIO_INVALID_TARGET", "Two-way sensitivity axes must target different InputNodes");
  const cellCount = definition.rowAxis.values.length * (definition.columnAxis?.values.length ?? 1);
  if (cellCount > UNDERWRITING_LIMITS.sensitivityCells) fail("SENSITIVITY_LIMIT", "Sensitivity exceeds the cell limit", { cellCount });
  for (const axis of [definition.rowAxis, definition.columnAxis].filter(Boolean)) {
    const node = model.nodeById[axis!.nodeId];
    if (!node || node.kind !== "input") fail("SCENARIO_INVALID_TARGET", "Sensitivity axis target is not an InputNode", { nodeId: axis!.nodeId });
  }
  for (const outputNodeId of definition.outputNodeIds) {
    if (model.nodeById[outputNodeId]?.kind !== "output") fail("MISSING_DEPENDENCY", "Sensitivity output target is not an OutputNode", { nodeId: outputNodeId });
  }
  const definitionSemanticHash = semanticHash({
    schemaVersion: definition.schemaVersion,
    rowAxis: definition.rowAxis,
    columnAxis: definition.columnAxis,
    outputNodeIds: [...definition.outputNodeIds].sort(),
  });
  const cells: SensitivityCell[] = [];
  const columns = definition.columnAxis?.values ?? ([null] as const);
  for (let rowIndex = 0; rowIndex < definition.rowAxis.values.length; rowIndex += 1) {
    for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
      const overrides = [{ nodeId: definition.rowAxis.nodeId, value: definition.rowAxis.values[rowIndex]! }];
      if (definition.columnAxis) overrides.push({ nodeId: definition.columnAxis.nodeId, value: columns[columnIndex] as ModelValue });
      const scenario: UnderwritingScenario = {
        schemaVersion: "underwriting-scenario.v1",
        name: `${definition.name} [${rowIndex},${columnIndex}]`,
        overrides,
      };
      const applied = applyScenario(model, snapshot, scenario);
      const result = executeUnderwritingModel(model, snapshot, scenario);
      const outputs = Object.fromEntries(definition.outputNodeIds.flatMap((nodeId) => result.outputs[nodeId] ? [[nodeId, result.outputs[nodeId]!.value]] : []));
      cells.push({
        rowIndex,
        columnIndex,
        overrides,
        inputSemanticHash: applied.snapshot.semanticHash!,
        resultSemanticHash: result.resultSemanticHash,
        runSemanticIdentity: semanticRunIdentity({
          investmentCaseId: snapshot.investmentCaseId,
          modelSemanticHash: model.semanticHash,
          inputSemanticHash: applied.snapshot.semanticHash!,
          scenarioSemanticHash: applied.scenarioSemanticHash,
          worldAt: snapshot.worldAt,
        }),
        status: result.status,
        validity: result.validity,
        outputs,
        ...(result.failure ? { failureCode: result.failure.code } : {}),
      });
    }
  }
  const failed = cells.filter((cell) => cell.status === "FAILED").length;
  return deepFreeze({
    definitionSemanticHash,
    status: failed === 0 ? "SUCCEEDED" : failed === cells.length ? "FAILED" : "PARTIAL",
    cells,
  });
}
