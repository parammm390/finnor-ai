import { z } from "zod"
import { approvalEffectSummary } from "@/components/centropy/product/approval-effect-model"
import type { WorkAggregateView } from "@/components/centropy/product/contracts"

const ActionSchema = z.object({
  id: z.string().uuid(), workId: z.string().uuid().nullable(), actionType: z.string().min(1),
  status: z.string().min(1), summary: z.string().nullable(), createdAt: z.string().datetime(),
  groundedPayload: z.unknown(), predicted: z.unknown(), businessEffect: z.unknown(),
  businessEffectStatus: z.string().nullable(), canCurrentEmployeeApprove: z.boolean(),
  critic: z.object({ flagged: z.boolean(), reason: z.string() }).nullable(),
  receipt: z.object({ id: z.string().uuid(), objective: z.string(), evidence: z.unknown(), policyApplied: z.unknown(), riskTier: z.string(), createdAt: z.string().datetime() }).nullable(),
}).passthrough()
export const PendingEffectPageSchema = z.object({ actions: z.array(ActionSchema), page: z.object({ limit: z.number().int(), hasMore: z.boolean(), complete: z.boolean(), nextCursor: z.string().nullable() }).passthrough() }).passthrough()
export type PendingEffect = z.infer<typeof ActionSchema>

const HASH = /^[a-f0-9]{64}$/
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null }
function scalar(value: unknown): string | null { return typeof value === "string" && value.trim() && value !== "Structured value · inspect contract" && value.length <= 10_000 ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : null }
function field(value: unknown, keys: string[]): string | null {
  const root = record(value)
  const nested = record(root?.message) ?? record(root?.email) ?? record(root?.payload)
  for (const source of [root, nested]) for (const key of keys) {
    const found = scalar(source?.[key])
    if (found) return found
  }
  return null
}

function exactStructuredFields(value: unknown): Array<{ label: string; value: string }> {
  const delta = record(record(value)?.delta)
  const values = record(delta?.values)
  if (!values) return []
  return Object.entries(values).flatMap(([label, field]) => field && typeof field === "object"
    ? [{ label, value: JSON.stringify(field, null, 2) }] : [])
}

export function pendingEffectReview(action: PendingEffect, aggregate: WorkAggregateView) {
  const effect = approvalEffectSummary(action.businessEffect)
  const structuredFields = exactStructuredFields(action.businessEffect)
  const workEffect = aggregate.businessEffects.find((item) => item.domainActionId === action.id)
  const hashMatches = Boolean(effect && HASH.test(effect.semanticHash) && workEffect?.semanticHash === effect.semanticHash)
  const communication = /email|message|communicat|notify|send/i.test(`${action.actionType} ${effect?.operation ?? ""}`)
  const valueRecord = Object.fromEntries(effect?.values.map((item) => [item.label, item.value]) ?? [])
  const rawEffect = record(action.businessEffect)
  const deltaValues = record(record(rawEffect?.delta)?.values)
  const party = record(deltaValues?.recipient)
  const before = Array.isArray(rawEffect?.before) ? rawEffect.before.map(record) : []
  const frozenParty = before.find((snapshot) => { const target = record(snapshot?.target); return target?.kind === "party" && target.type === party?.partyType && target.id === party?.partyId })
  const frozenValues = record(frozenParty?.values)
  const channel = scalar(deltaValues?.channel)
  const frozenAddress = channel === "email" ? scalar(frozenValues?.businessEmail) : channel === "sms" ? scalar(frozenValues?.phoneNumber) : scalar(frozenValues?.name)
  const recipient = frozenAddress ? `${scalar(frozenValues?.name) ? `${scalar(frozenValues?.name)} · ` : ""}${frozenAddress}` : field(valueRecord, ["recipient", "to", "email", "recipientEmail"]) ?? field(action.groundedPayload, ["recipient", "to", "email", "recipientEmail"])
  const subject = field(valueRecord, ["subject", "title"]) ?? field(action.groundedPayload, ["subject", "title"])
  const body = field(valueRecord, ["body", "message", "content", "text"]) ?? field(action.groundedPayload, ["body", "message", "content", "text"])
  const bindings = Array.isArray(rawEffect?.bindings) ? rawEffect.bindings.map(record) : []
  const provider = scalar(bindings.find((binding) => binding?.provider)?.provider) ?? field(valueRecord, ["provider", "channel"]) ?? field(action.groundedPayload, ["provider", "channel"])
  const requiresSubject = channel === "email" || /email/i.test(action.actionType)
  const missingCommunication = communication && (!recipient || !body || (requiresSubject && !subject))
  const canConfirm = action.workId === aggregate.work.id && ["pending", "needs_human_review"].includes(action.status) && action.canCurrentEmployeeApprove && hashMatches && Boolean(effect?.targets.length) && !missingCommunication
  const canReject = action.workId === aggregate.work.id && ["pending", "needs_human_review"].includes(action.status)
  const canEscalate = action.workId === aggregate.work.id && action.status === "pending"
  return { effect, structuredFields, hashMatches, communication, recipient, subject, body, provider, requiresSubject, missingCommunication, canConfirm, canReject, canEscalate }
}
