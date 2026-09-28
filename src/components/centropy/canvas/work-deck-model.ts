import type { WorkAggregateView } from "@/components/centropy/product/contracts"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type WorkDeck = { workId: string; workStatus: string; actionId: string; caseId: string; documentId: string; versionId: string; templateKey: string; templateVersionId: string }

/** A Work-linked IC case must come from its verified, finalized domain mutation. */
export function verifiedWorkIcCase(work: WorkAggregateView | null | undefined, dealId: string | null | undefined): string | null {
  if (!work || !dealId || !UUID.test(dealId)) return null
  for (const actionType of ["request_ic_memo_review", "open_ic_case"]) {
    for (const action of work.actions) {
      if (action.actionType !== actionType || action.status !== "completed") continue
      const effect = work.businessEffects.find((item) => item.domainActionId === action.id && item.status === "verified" && item.verification && item.semanticHash)
      const receipt = work.receipts.find((item) => item.domainActionId === action.id && item.finalizedAt && !item.failure)
      if (!effect || !receipt || !effect.observedResult || typeof effect.observedResult !== "object" || Array.isArray(effect.observedResult)) continue
      const observed = effect.observedResult as Record<string, unknown>
      const entity = observed.entity
      const state = observed.canonicalState
      if (!entity || typeof entity !== "object" || Array.isArray(entity) || !state || typeof state !== "object" || Array.isArray(state)) continue
      const resultEntity = entity as Record<string, unknown>
      const canonical = state as Record<string, unknown>
      const caseId = String(resultEntity.entityId ?? "")
      if (resultEntity.entityType !== "pe_ic_case" || !UUID.test(caseId) || canonical.id !== caseId || canonical.dealId !== dealId) continue
      if (actionType === "request_ic_memo_review" && canonical.state !== "READY_FOR_REVIEW") continue
      return caseId
    }
  }
  return null
}

export function verifiedWorkDeck(work: WorkAggregateView | null | undefined, dealId: string | null | undefined): WorkDeck | null {
  if (!work || !dealId || !UUID.test(dealId)) return null
  for (const action of work.actions) {
    if (action.actionType !== "create_ic_deck_draft" || action.status !== "completed") continue
    const effect = work.businessEffects.find((item) => item.domainActionId === action.id && item.status === "verified" && item.verification && item.semanticHash)
    const receipt = work.receipts.find((item) => item.domainActionId === action.id && item.finalizedAt && !item.failure)
    if (!effect || !receipt || !effect.observedResult || typeof effect.observedResult !== "object" || Array.isArray(effect.observedResult)) continue
    const observed = effect.observedResult as Record<string, unknown>
    const entity = observed.entity
    const state = observed.canonicalState
    if (!entity || typeof entity !== "object" || Array.isArray(entity) || !state || typeof state !== "object" || Array.isArray(state)) continue
    const resultEntity = entity as Record<string, unknown>
    const link = state as Record<string, unknown>
    if (resultEntity.entityType !== "pe_document_link" || link.draftKind !== "IC_DECK_DRAFT" || link.dealId !== dealId
      || !UUID.test(String(link.entityId ?? "")) || !UUID.test(String(link.documentId ?? ""))
      || !UUID.test(String(link.documentVersionId ?? "")) || !UUID.test(String(link.templateVersionId ?? ""))
      || typeof link.templateKey !== "string" || !link.templateKey) continue
    return { workId: work.work.id, workStatus: work.work.status, actionId: action.id, caseId: String(link.entityId), documentId: String(link.documentId), versionId: String(link.documentVersionId), templateKey: link.templateKey, templateVersionId: String(link.templateVersionId) }
  }
  return null
}
