import type { UnderwritingInput, UnderwritingValue } from "./contracts"
import { parseScenarioValue } from "./scenario-branch-model"

export function parseSensitivityAxis(input: UnderwritingInput, raw: string): UnderwritingValue[] {
  if (input.shape !== "scalar" || input.valueType !== "decimal") throw new Error("Choose a scalar decimal input for this sweep.")
  if (raw.length > 2_000) throw new Error("Enter at most 2,000 characters of sweep values.")
  const tokens = raw.split(",").map((value) => value.trim())
  if (!tokens.length || tokens.length > 20 || tokens.some((value) => !value)) throw new Error("Enter 1–20 comma-separated decimal values.")
  const values = tokens.map((value) => parseScenarioValue(input, value))
  if (new Set(values.map(String)).size !== values.length) throw new Error("Each sweep value must be distinct.")
  return values
}
