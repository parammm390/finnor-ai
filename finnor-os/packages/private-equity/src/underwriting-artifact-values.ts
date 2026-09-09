import { rangeAddresses } from "@finnor/spreadsheet-ir";
import { fail, type ModelValue } from "@finnor/underwriting";

export interface UnderwritingArtifactNode {
  id: string;
  hash: string;
  kind: string;
  data: Record<string, unknown>;
}

export interface UnderwritingWorkbookIr {
  kind: string;
  nodes: UnderwritingArtifactNode[];
  sheets?: Array<{ id: string; name: string }>;
}

export interface UnderwritingBindingAnchor {
  anchorId: string;
  anchorHash: string;
  valueSelector?: string | null;
}

export interface UnderwritingBoundCell {
  node: UnderwritingArtifactNode;
  sheetId: string;
  address: string;
  selector: string | null;
}

function parseDefinedName(node: UnderwritingArtifactNode, ir: UnderwritingWorkbookIr): { sheetId: string; addresses: string[] } {
  const raw = String(node.data.formula ?? "").replace(/^=/, "");
  let sheetName = typeof node.data.sheet === "string" ? node.data.sheet : null;
  let reference = raw;
  const separator = raw.lastIndexOf("!");
  if (separator >= 0) {
    const sheetText = raw.slice(0, separator);
    reference = raw.slice(separator + 1);
    sheetName = sheetText.startsWith("'") && sheetText.endsWith("'")
      ? sheetText.slice(1, -1).replaceAll("''", "'")
      : sheetText;
  }
  if (!sheetName || !/^\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?$/.test(reference)) {
    fail("ARTIFACT_VALUE_UNSUPPORTED", "Defined name is not a bounded single-sheet A1 range", { anchorId: node.id });
  }
  const sheet = ir.sheets?.find((item) => item.name === sheetName);
  if (!sheet) fail("ARTIFACT_VALUE_UNSUPPORTED", "Defined name references an unknown worksheet", { anchorId: node.id, sheetName });
  return { sheetId: sheet.id, addresses: rangeAddresses(reference.replaceAll("$", "")) };
}

/**
 * Resolve a P4 binding exclusively through P3's exact SpreadsheetIR identities.
 * This does not parse XLSX and never label-matches a workbook.
 */
export function boundUnderwritingCells(
  ir: UnderwritingWorkbookIr,
  binding: UnderwritingBindingAnchor,
  modelShape: "scalar" | "series",
  periods: readonly { id: string }[],
  options: { requireBoundHash: boolean; allowSeriesCellSelector: boolean },
): UnderwritingBoundCell[] {
  const anchor = ir.nodes.find((node) => node.id === binding.anchorId);
  if (!anchor || (options.requireBoundHash && anchor.hash !== binding.anchorHash)) {
    fail("ARTIFACT_ANCHOR_CONFLICT", "Artifact binding anchor is stale or missing", { anchorId: binding.anchorId });
  }
  if (anchor.kind === "cell") {
    if (modelShape === "series") {
      if (!options.allowSeriesCellSelector) {
        fail("ARTIFACT_VALUE_UNSUPPORTED", "A series input requires a bounded DefinedName covering the complete ModelVersion period set", { anchorId: anchor.id });
      }
      if (!binding.valueSelector || !periods.some((period) => period.id === binding.valueSelector)) {
        fail("ARTIFACT_VALUE_UNSUPPORTED", "A series output bound to one cell requires an exact modeled period selector", { anchorId: anchor.id });
      }
    } else if (binding.valueSelector) {
      fail("ARTIFACT_VALUE_UNSUPPORTED", "A scalar cell binding cannot declare a period selector", { anchorId: anchor.id });
    }
    return [{ node: anchor, sheetId: String(anchor.data.sheetId), address: String(anchor.data.address), selector: binding.valueSelector ?? null }];
  }
  if (anchor.kind !== "definedName") {
    fail("ARTIFACT_VALUE_UNSUPPORTED", "Underwriting bindings support exact cells or bounded DefinedName ranges", { anchorId: anchor.id, kind: anchor.kind });
  }
  if (binding.valueSelector) fail("ARTIFACT_VALUE_UNSUPPORTED", "DefinedName ranges use deterministic period order and cannot also use a selector");
  const parsed = parseDefinedName(anchor, ir);
  if (modelShape === "scalar" && parsed.addresses.length !== 1) fail("ARTIFACT_VALUE_UNSUPPORTED", "Scalar model node requires a one-cell DefinedName");
  if (modelShape === "series" && parsed.addresses.length !== periods.length) {
    fail("ARTIFACT_VALUE_UNSUPPORTED", "DefinedName range length does not match the exact ModelVersion period count", { rangeCells: parsed.addresses.length, periods: periods.length });
  }
  return parsed.addresses.map((address, index) => {
    const cell = ir.nodes.find((node) => node.id === `cell:${parsed.sheetId}!${address}`);
    if (!cell) fail("ARTIFACT_ANCHOR_CONFLICT", "A DefinedName range cell is absent from SpreadsheetIR", { address });
    return { node: cell, sheetId: parsed.sheetId, address, selector: modelShape === "series" ? periods[index]!.id : null };
  });
}

export function observedUnderwritingCell(node: UnderwritingArtifactNode, workbookCalculationStatus: string): {
  value: string | number | boolean | null;
  calculationStatus: "verified" | "stale" | "unknown" | "not_applicable" | "uncalculated";
  calculated: boolean;
} {
  const formula = node.data.formula;
  if (formula === null || formula === undefined) {
    const value = node.data.value;
    return {
      value: typeof value === "number" || typeof value === "string" || typeof value === "boolean" ? value : null,
      calculationStatus: "verified",
      calculated: false,
    };
  }
  const calculation = String(node.data.calculation ?? "unknown");
  if (calculation === "cached_stale" || workbookCalculationStatus === "stale") return { value: null, calculationStatus: "stale", calculated: true };
  if (calculation === "uncalculated") return { value: null, calculationStatus: "uncalculated", calculated: true };
  if (workbookCalculationStatus !== "verified") return { value: null, calculationStatus: "unknown", calculated: true };
  const cached = node.data.cached;
  return {
    value: typeof cached === "number" || typeof cached === "string" || typeof cached === "boolean" ? cached : null,
    calculationStatus: "verified",
    calculated: true,
  };
}

export function selectedUnderwritingValue(value: ModelValue, shape: "scalar" | "series", selector: string | null): string {
  if (shape === "scalar") return String(value);
  const selected = selector ? (value as Record<string, ModelValue>)[selector] : undefined;
  if (selected === undefined || typeof selected === "object") fail("ARTIFACT_VALUE_UNSUPPORTED", "Run series output is missing the exact bound period", { selector });
  return String(selected);
}
