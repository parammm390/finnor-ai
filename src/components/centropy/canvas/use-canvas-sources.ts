"use client"

import { useEffect, useState } from "react"
import { centropyGet, centropyPost } from "@/components/centropy/lib/api"
import type { PeWorldRootRef, CompanyBrainProjection } from "@/components/centropy/pe/contracts"
import type { IcWorkspace, UnderwritingWorkspace, WorkAggregateView } from "@/components/centropy/product/contracts"
import { verifiedWorkDeck, verifiedWorkIcCase } from "./work-deck-model"

interface SourceState<T> { data: T | null; status: "idle" | "loading" | "ready" | "error"; error: string | null; key: string | null }
const idle = <T,>(): SourceState<T> => ({ data: null, status: "idle", error: null, key: null })

/** Loads only sources relevant to the selected Investigation. Previous data is never shown for a different identity. */
export function useCanvasSources(workId: string | null, root: PeWorldRootRef | null, enabled: boolean, revision: number, underwritingRevision = 0, icCaseOverride: string | null = null) {
  const [work, setWork] = useState<SourceState<WorkAggregateView>>(idle)
  const [projection, setProjection] = useState<SourceState<CompanyBrainProjection>>(idle)
  const [underwriting, setUnderwriting] = useState<SourceState<UnderwritingWorkspace>>(idle)
  const [ic, setIc] = useState<SourceState<IcWorkspace>>(idle)
  const rootKey = root ? `${root.entityType}:${root.entityId}` : null
  const dealId = root?.entityType === "pe_deal" ? root.entityId : null
  const caseId = projection.key === rootKey ? projection.data?.nodes.find((node) => node.type === "pe_investment_case")?.ref.id ?? null : null
  const workDeck = work.key === workId ? verifiedWorkDeck(work.data, dealId) : null
  const workIcCaseId = work.key === workId ? verifiedWorkIcCase(work.data, dealId) : null
  const icCaseId = dealId && icCaseOverride ? icCaseOverride : workIcCaseId
    ?? workDeck?.caseId
    ?? (projection.key === rootKey ? projection.data?.nodes.find((node) => node.type === "pe_ic_case")?.ref.id ?? null : null)

  useEffect(() => {
    if (!enabled || !workId) { setWork(idle()); return }
    let active = true
    let timer: number | null = null
    setWork((previous) => ({ data: previous.key === workId ? previous.data : null, key: workId, status: "loading", error: null }))
    const load = () => {
      void centropyGet<{ work: WorkAggregateView }>(`works/${workId}`).then((result) => {
        if (!active) return
        if (!result.work || result.work.work.id !== workId) throw new Error("Work response did not match the selected Investigation")
        setWork({ data: result.work, status: "ready", error: null, key: workId })
        if (!["completed", "failed", "cancelled"].includes(result.work.work.status)) timer = window.setTimeout(load, 5000)
      }).catch((cause) => {
        if (!active) return
        setWork((previous) => ({ data: previous.key === workId ? previous.data : null, status: "error", error: cause instanceof Error ? cause.message : "Work unavailable", key: workId }))
        timer = window.setTimeout(load, 10000)
      })
    }
    load()
    return () => { active = false; if (timer !== null) window.clearTimeout(timer) }
  }, [enabled, revision, workId])

  useEffect(() => {
    if (!enabled || !root || !rootKey) { setProjection(idle()); return }
    let active = true
    setProjection((previous) => ({ data: previous.key === rootKey ? previous.data : null, key: rootKey, status: "loading", error: null }))
    void centropyPost<CompanyBrainProjection>("company-brain/projection", { root: { entityType: root.entityType, entityId: root.entityId } }).then((result) => {
      if (!active) return
      if (result.root?.entityType !== root.entityType || result.root?.entityId !== root.entityId || !Array.isArray(result.nodes)) throw new Error("Company Brain response did not match the selected context")
      setProjection({ data: result, status: "ready", error: null, key: rootKey })
    }).catch((cause) => {
      if (active) setProjection((previous) => ({ data: previous.key === rootKey ? previous.data : null, status: "error", error: cause instanceof Error ? cause.message : "Company Brain unavailable", key: rootKey }))
    })
    return () => { active = false }
  }, [enabled, revision, rootKey, root])

  useEffect(() => {
    if (!enabled || !caseId) { setUnderwriting(idle()); return }
    let active = true
    setUnderwriting((previous) => ({ data: previous.key === caseId ? previous.data : null, key: caseId, status: "loading", error: null }))
    void centropyGet<UnderwritingWorkspace>(`investment-cases/${caseId}/underwriting`).then((result) => {
      if (!active) return
      if (result.investmentCase?.id !== caseId || (dealId && result.investmentCase.dealId !== dealId) || result.complete !== true || !Array.isArray(result.runs) || !Array.isArray(result.models)) throw new Error("Underwriting response did not match the selected Deal and Investment Case")
      setUnderwriting({ data: result, status: "ready", error: null, key: caseId })
    }).catch((cause) => {
      if (active) setUnderwriting((previous) => ({ data: previous.key === caseId ? previous.data : null, status: "error", error: cause instanceof Error ? cause.message : "Underwriting unavailable", key: caseId }))
    })
    return () => { active = false }
  }, [enabled, revision, underwritingRevision, caseId, dealId])

  useEffect(() => {
    if (!enabled || !icCaseId) { setIc(idle()); return }
    let active = true
    setIc((previous) => ({ data: previous.key === icCaseId ? previous.data : null, key: icCaseId, status: "loading", error: null }))
    void centropyGet<IcWorkspace>(`private-equity/ic/cases/${icCaseId}`).then((result) => {
      if (!active) return
      if (result.case?.id !== icCaseId || (dealId && result.case.dealId !== dealId) || !result.readiness || !Array.isArray(result.readiness.blockers) || !Array.isArray(result.questions)) throw new Error("IC response did not match the selected Deal and case")
      setIc({ data: result, status: "ready", error: null, key: icCaseId })
    }).catch((cause) => {
      if (active) setIc((previous) => ({ data: previous.key === icCaseId ? previous.data : null, status: "error", error: cause instanceof Error ? cause.message : "IC unavailable", key: icCaseId }))
    })
    return () => { active = false }
  }, [enabled, revision, icCaseId, dealId])

  return {
    work: work.key === workId ? work : idle<WorkAggregateView>(),
    projection: projection.key === rootKey ? projection : idle<CompanyBrainProjection>(),
    underwriting: underwriting.key === caseId ? underwriting : idle<UnderwritingWorkspace>(),
    ic: ic.key === icCaseId ? ic : idle<IcWorkspace>(),
  }
}
