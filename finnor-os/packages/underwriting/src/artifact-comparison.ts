import { abs, decimal, round, sub, withinTolerance, ZERO, type DecimalString } from "./decimal";
import { fail } from "./errors";
import type { ArtifactValueComparison, ComparisonPolicy } from "./types";

export function compareArtifactValue(input: {
  modelValue: DecimalString | string;
  artifactValue: string | number | null;
  calculationStatus: "verified" | "stale" | "unknown" | "not_applicable" | "uncalculated";
  policy: ComparisonPolicy;
}): Readonly<ArtifactValueComparison> {
  const modelValue = decimal(String(input.modelValue));
  if (input.calculationStatus === "stale") return Object.freeze({ modelValue, artifactValue: null, difference: null, policy: input.policy, status: "EXCEL_STALE" });
  if (input.calculationStatus === "unknown" || input.calculationStatus === "not_applicable") return Object.freeze({ modelValue, artifactValue: null, difference: null, policy: input.policy, status: "UNKNOWN" });
  if (input.calculationStatus === "uncalculated") return Object.freeze({ modelValue, artifactValue: null, difference: null, policy: input.policy, status: "EXCEL_UNCALCULATED" });
  if (input.artifactValue === null || typeof input.artifactValue === "boolean") return Object.freeze({ modelValue, artifactValue: null, difference: null, policy: input.policy, status: "UNSUPPORTED" });
  let artifactValue: DecimalString;
  try { artifactValue = decimal(String(input.artifactValue)); } catch { return Object.freeze({ modelValue, artifactValue: null, difference: null, policy: input.policy, status: "UNSUPPORTED" }); }
  const difference = abs(sub(modelValue, artifactValue));
  let match = false;
  switch (input.policy.mode) {
    case "EXACT_DECIMAL": match = difference === ZERO; break;
    case "DECLARED_ROUNDED_VALUE": {
      if (!Number.isSafeInteger(input.policy.decimalPlaces) || input.policy.decimalPlaces < 0 || input.policy.decimalPlaces > 34) fail("MODEL_SCHEMA_INVALID", "Artifact rounding policy is invalid");
      match = round(modelValue, input.policy.decimalPlaces) === round(artifactValue, input.policy.decimalPlaces);
      break;
    }
    case "EXPLICIT_ABSOLUTE_TOLERANCE": match = withinTolerance(modelValue, artifactValue, input.policy.tolerance); break;
    case "EXPLICIT_RELATIVE_TOLERANCE": match = withinTolerance(modelValue, artifactValue, ZERO, input.policy.tolerance); break;
  }
  return Object.freeze({ modelValue, artifactValue, difference, policy: input.policy, status: match ? "MATCH" : "MISMATCH" });
}
