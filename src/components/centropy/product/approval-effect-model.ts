interface EffectField { label: string; value: string }

export interface ApprovalEffectSummary {
  operation: string
  operationClass: string | null
  semanticHash: string
  targets: Array<{ type: string; id: string }>
  change: string
  values: EffectField[]
  before: Array<{ type: string; id: string; values: EffectField[] }>
  expectedObservation: string | null
  authority: string | null
  risk: string | null
  approvalSummary: string | null
  reversibility: string | null
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

function displayValue(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value)
  return "Structured value · inspect contract"
}

function fields(value: unknown): EffectField[] {
  const object = record(value)
  return object ? Object.entries(object).map(([label, field]) => ({ label, value: displayValue(field) })) : []
}

export function approvalEffectSummary(value: unknown): ApprovalEffectSummary | null {
  const effect = record(value)
  const operation = record(effect?.operation)
  const delta = record(effect?.delta)
  const hash = string(effect?.semanticHash)
  const operationName = string(operation?.name)
  const change = string(delta?.operation)
  if (!effect || !hash || !operationName || !change || !Array.isArray(effect.targets)) return null

  const targets = effect.targets.flatMap((value) => {
    const target = record(value)
    const type = string(target?.type)
    const id = string(target?.id)
    return type && id ? [{ type, id }] : []
  })
  const before = Array.isArray(effect.before) ? effect.before.flatMap((value) => {
    const snapshot = record(value)
    const target = record(snapshot?.target)
    const type = string(target?.type)
    const id = string(target?.id)
    return type && id ? [{ type, id, values: fields(snapshot?.values) }] : []
  }) : []
  const expected = record(effect.expected)
  const authority = record(effect.authority)
  const approval = record(effect.approval)
  const reversibility = record(effect.reversibility)

  return {
    operation: operationName,
    operationClass: string(operation?.class),
    semanticHash: hash,
    targets,
    change,
    values: fields(delta?.values),
    before,
    expectedObservation: string(expected?.observation),
    authority: string(authority?.capability),
    risk: string(authority?.risk),
    approvalSummary: string(approval?.summary),
    reversibility: string(reversibility?.classification),
  }
}
