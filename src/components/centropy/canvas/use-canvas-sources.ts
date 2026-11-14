"use client"

import { useEffect, useState } from "react"
import { CentropyApiError, centropyGet, centropyPost } from "@/components/centropy/lib/api"
import type { PeWorldRootRef, CompanyBrainProjection } from "@/components/centropy/pe/contracts"
import type { IcWorkspace, UnderwritingWorkspace, WorkAggregateView } from "@/components/centropy/product/contracts"
import { verifiedWorkDeck, verifiedWorkIcCase } from "./work-deck-model"
import { usePrivateRequestScope } from "../lib/use-private-request-scope"

interface SourceState<T> { data: T | null; status: "idle" | "loading" | "ready" | "error"; error: string | null; key: string | null; scope?: string }
const idle = <T,>(): SourceState<T> => ({ data: null, status: "idle", error: null, key: null })

/** Loads only sources relevant to the selected Investigation. Previous data is never shown for a different identity. */
export function useCanvasSources(workId: string | null, root: PeWorldRootRef | null, enabled: boolean, revision: number, underwritingRevision = 0, icCaseOverride: string | null = null) {
  const { key: scopeKey, isCurrent, allowed } = usePrivateRequestScope(`${workId ?? "none"}:${root?.entityType ?? "none"}:${root?.entityId ?? "none"}`)
  const { key: workScopeKey, isCurrent: isWorkCurrent, allowed: workAllowed } = usePrivateRequestScope(workId ?? "no-work")
  enabled = enabled && allowed
  const workEnabled = enabled && workAllowed
  const [work, setWork] = useState<SourceState<WorkAggregateView>>(idle)
  const [projection, setProjection] = useState<SourceState<CompanyBrainProjection>>(idle)
  const [underwriting, setUnderwriting] = useState<SourceState<UnderwritingWorkspace>>(idle)
  const [ic, setIc] = useState<SourceState<IcWorkspace>>(idle)
  const rootKey = root ? `${root.entityType}:${root.entityId}` : null
  const dealId = root?.entityType === "pe_deal" ? root.entityId : null
  const caseId = projection.key === rootKey && projection.scope === scopeKey ? projection.data?.nodes.find((node) => node.type === "pe_investment_case")?.ref.id ?? null : null
  const currentWork = workEnabled && work.key === workId && work.scope === workScopeKey ? work : idle<WorkAggregateView>()
  const workDeck = verifiedWorkDeck(currentWork.data, dealId)
  const workIcCaseId = verifiedWorkIcCase(currentWork.data, dealId)
  const icCaseId = dealId && icCaseOverride ? icCaseOverride : workIcCaseId
    ?? workDeck?.caseId
    ?? (projection.key === rootKey && projection.scope === scopeKey ? projection.data?.nodes.find((node) => node.type === "pe_ic_case")?.ref.id ?? null : null)

  useEffect(() => {
    if (!workEnabled || !workId) { setWork(idle()); return }
    let active = true
    let timer: number | null = null
    setWork((previous) => ({ data: previous.key === workId && previous.scope === workScopeKey ? previous.data : null, key: workId, scope: workScopeKey, status: "loading", error: null }))
    const load = () => {
      void centropyGet<{ work: WorkAggregateView }>(`works/${workId}`).then((result) => {
        if (!active || !isWorkCurrent(workScopeKey)) return
        if (!result.work || result.work.work.id !== workId) throw new Error("Work response did not match the selected Investigation")
        setWork({ data: result.work, status: "ready", error: null, key: workId, scope: workScopeKey })
        if (!["completed", "failed", "cancelled"].includes(result.work.work.status)) timer = window.setTimeout(load, 5000)
      }).catch((cause) => {
        if (!active || !isWorkCurrent(workScopeKey)) return
        setWork(previous => ({ data: cause instanceof CentropyApiError && cause.retryable
          && previous.key === workId && previous.scope === workScopeKey ? previous.data : null,
          status: "error", error: cause instanceof Error ? cause.message : "Work unavailable", key: workId, scope: workScopeKey }))
        timer = window.setTimeout(load, 10000)
      })
    }
    load()
    return () => { active = false; if (timer !== null) window.clearTimeout(timer) }
  }, [workEnabled, revision, workId, workScopeKey, isWorkCurrent])

  useEffect(() => {
    if (!enabled || !root || !rootKey) { setProjection(idle()); return }
    let active = true
    setProjection((previous) => ({ data: previous.key === rootKey && previous.scope === scopeKey ? previous.data : null, key: rootKey, scope: scopeKey, status: "loading", error: null }))
    void centropyPost<CompanyBrainProjection>("company-brain/projection", { root: { entityType: root.entityType, entityId: root.entityId } }).then((result) => {
      if (!active || !isCurrent(scopeKey)) return
      if (result.root?.entityType !== root.entityType || result.root?.entityId !== root.entityId || !Array.isArray(result.nodes)) throw new Error("Company Brain response did not match the selected context")
      setProjection({ data: result, status: "ready", error: null, key: rootKey, scope: scopeKey })
    }).catch((cause) => {
      if (active && isCurrent(scopeKey)) setProjection({ data: null, status: "error", error: cause instanceof Error ? cause.message : "Company Brain unavailable", key: rootKey, scope: scopeKey })
    })
    return () => { active = false }
  }, [enabled, revision, rootKey, root, scopeKey, isCurrent])

  useEffect(() => {
    if (!enabled || !caseId) { setUnderwriting(idle()); return }
    let active = true
    setUnderwriting((previous) => ({ data: previous.key === caseId && previous.scope === scopeKey ? previous.data : null, key: caseId, scope: scopeKey, status: "loading", error: null }))
    void centropyGet<UnderwritingWorkspace>(`investment-cases/${caseId}/underwriting`).then((result) => {
      if (!active || !isCurrent(scopeKey)) return
      if (result.investmentCase?.id !== caseId || (dealId && result.investmentCase.dealId !== dealId) || result.complete !== true || !Array.isArray(result.runs) || !Array.isArray(result.models)) throw new Error("Underwriting response did not match the selected Deal and Investment Case")
      setUnderwriting({ data: result, status: "ready", error: null, key: caseId, scope: scopeKey })
    }).catch((cause) => {
      if (active && isCurrent(scopeKey)) setUnderwriting({ data: null, status: "error", error: cause instanceof Error ? cause.message : "Underwriting unavailable", key: caseId, scope: scopeKey })
    })
    return () => { active = false }
  }, [enabled, revision, underwritingRevision, caseId, dealId, scopeKey, isCurrent])

  useEffect(() => {
    if (!enabled || !icCaseId) { setIc(idle()); return }
    let active = true
    setIc((previous) => ({ data: previous.key === icCaseId && previous.scope === scopeKey ? previous.data : null, key: icCaseId, scope: scopeKey, status: "loading", error: null }))
    void centropyGet<IcWorkspace>(`private-equity/ic/cases/${icCaseId}`).then((result) => {
      if (!active || !isCurrent(scopeKey)) return
      if (result.case?.id !== icCaseId || (dealId && result.case.dealId !== dealId) || !result.readiness || !Array.isArray(result.readiness.blockers) || !Array.isArray(result.questions)) throw new Error("IC response did not match the selected Deal and case")
      setIc({ data: result, status: "ready", error: null, key: icCaseId, scope: scopeKey })
    }).catch((cause) => {
      if (active && isCurrent(scopeKey)) setIc({ data: null, status: "error", error: cause instanceof Error ? cause.message : "IC unavailable", key: icCaseId, scope: scopeKey })
    })
    return () => { active = false }
  }, [enabled, revision, icCaseId, dealId, scopeKey, isCurrent])

  return {
    work: currentWork,
    projection: enabled && projection.scope === scopeKey && projection.key === rootKey ? projection : idle<CompanyBrainProjection>(),
    underwriting: enabled && underwriting.scope === scopeKey && underwriting.key === caseId ? underwriting : idle<UnderwritingWorkspace>(),
    ic: enabled && ic.scope === scopeKey && ic.key === icCaseId ? ic : idle<IcWorkspace>(),
  }
}
