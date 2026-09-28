import type { UnderwritingInput, UnderwritingRun, UnderwritingValue, UnderwritingWorkspace } from "./contracts"

const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/
const DAY = /^\d{4}-\d{2}-\d{2}$/

export function editableScenarioInputs(run: UnderwritingRun | null): UnderwritingInput[] {
  if (!run) return []
  return Object.values(run.inputSnapshot.values)
    .filter((input) => input.shape === "scalar" && ["decimal", "date", "boolean", "text"].includes(input.valueType))
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId))
}

export function editableCanvasScenarioInputs(run: UnderwritingRun | null): UnderwritingInput[] {
  if (!run) return []
  return Object.values(run.inputSnapshot.values)
    .filter((input) => ["scalar", "series"].includes(input.shape) && ["decimal", "date", "boolean", "text"].includes(input.valueType) && input.value !== null)
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId))
}

export function parseCanvasScenarioValue(input: UnderwritingInput, raw: string): UnderwritingValue {
  if (input.shape === "scalar") return parseScenarioValue(input, raw)
  if (!input.value || typeof input.value !== "object" || Array.isArray(input.value)) throw new Error("A resolved base series is required.")
  if (raw.length > 16_384) throw new Error("The proposed period series is too large.")
  let proposed: unknown
  try { proposed = JSON.parse(raw) } catch { throw new Error("Enter a JSON object with every exact base period.") }
  if (!proposed || typeof proposed !== "object" || Array.isArray(proposed)) throw new Error("Enter a JSON object with every exact base period.")
  const expected = Object.keys(input.value).sort()
  const actual = Object.keys(proposed).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("The proposed series must contain every and only the exact base periods.")
  const result: Record<string, string | boolean> = {}
  for (const periodId of expected) {
    const item = (proposed as Record<string, unknown>)[periodId]
    if (input.valueType === "boolean") {
      if (typeof item !== "boolean") throw new Error(`Period ${periodId} requires a boolean value.`)
      result[periodId] = item
    } else {
      if (typeof item !== "string") throw new Error(`Period ${periodId} requires an exact string value.`)
      result[periodId] = parseScenarioValue({ ...input, shape: "scalar" }, item) as string
    }
  }
  return result
}

export function parseScenarioValue(input: UnderwritingInput, raw: string): UnderwritingValue {
  if (input.shape !== "scalar") throw new Error("This branch editor supports scalar inputs only.")
  const value = raw.trim()
  if (input.valueType === "decimal") {
    if (!value || value.length > 128 || !DECIMAL.test(value)) throw new Error("Enter an exact decimal string, up to 128 characters.")
    return value
  }
  if (input.valueType === "boolean") {
    if (value !== "true" && value !== "false") throw new Error("Choose true or false.")
    return value === "true"
  }
  if (input.valueType === "date") {
    if (!DAY.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
      throw new Error("Enter a valid date as YYYY-MM-DD.")
    }
    return value
  }
  if (input.valueType === "text") {
    if (!value || value.length > 4_096) throw new Error("Enter text up to 4,096 characters.")
    return value
  }
  throw new Error("This model input type cannot be edited here.")
}

export function formatUnderwritingValue(value: UnderwritingValue | null | undefined): string {
  if (value === null || value === undefined) return "UNKNOWN"
  return typeof value === "object" ? Object.entries(value).map(([period, amount]) => `${underwritingPeriodLabel(period)}: ${String(amount)}`).join("; ") : String(value)
}

export function formatUnderwritingDisplayValue(value: UnderwritingValue | null | undefined, unit?: string): string {
  if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value)) return formatUnderwritingValue(value)
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return value
  if (unit === "rate") return `${(numeric * 100).toFixed(1)}%`
  if (unit === "multiple") return `${numeric.toFixed(2)}×`
  return numeric.toLocaleString(undefined, { maximumFractionDigits: unit === "money" ? 2 : 4 })
}

export function matchingBaseRun(runs: UnderwritingRun[], branch: UnderwritingRun, preferredBaseId?: string | null): UnderwritingRun | null {
  const eligible = runs.filter((run) => !run.scenarioId && !run.sensitivityCell && run.modelVersionId === branch.modelVersionId && run.worldAt === branch.worldAt)
  return preferredBaseId ? eligible.find((run) => run.id === preferredBaseId) ?? null : eligible[0] ?? null
}

export function resolveScenarioBranch(workspace: UnderwritingWorkspace, requestedRunId?: string | null, requestedBaseId?: string | null, requestedScenarioId?: string | null): { base: UnderwritingRun; branch: UnderwritingRun } | null {
  const branches = workspace.runs.filter((run) => run.scenarioId && (!requestedScenarioId || run.scenarioId === requestedScenarioId) && workspace.scenarios.some((scenario) => scenario.id === run.scenarioId && scenario.modelVersionId === run.modelVersionId))
  const branch = requestedRunId ? branches.find((run) => run.id === requestedRunId) : branches.find((run) => matchingBaseRun(workspace.runs, run))
  if (!branch) return null
  const base = matchingBaseRun(workspace.runs, branch, requestedBaseId)
  return base ? { base, branch } : null
}

export function underwritingPeriodLabel(period: string): string {
  const dates = period.split(":").filter((part) => /^\d{4}-\d{2}-\d{2}$/.test(part))
  return dates.length === 2 ? dates.join(" to ") : period
}
