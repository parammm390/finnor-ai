"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { jarvisGet, jarvisPost } from "../lib/api"
import { useJarvisAuth } from "../lib/jarvis-auth"
import { onBusinessInvalidation, type ProjectionTag } from "../lib/business-invalidation"
import type { AttentionQueueResult, FirmDealProjectionSet, ProductResource } from "../product/contracts"
import { unavailableState, type ProductTruthState } from "../product/source-health"
import {
  isCompanyBrainObjectRef,
  isInspectionTarget,
  isPeWorldRootRef,
  type CompanyBrainObjectRef,
  type CompanyBrainProjection,
  type CompanyBrainSearchResult,
  type PeWorldRootRef,
  type SemanticActivityProjection,
  type WorkforceStatusProjection,
} from "./contracts"

export type PeResourceStatus = ProductResource<unknown>["status"]
export type PeResource<T> = ProductResource<T>

function message(error: unknown): string {
  return error instanceof Error ? error.message : "The source projection is unavailable."
}

function validRootResult(value: CompanyBrainSearchResult): boolean {
  return isCompanyBrainObjectRef(value.ref)
    && Array.isArray(value.rootRefs)
    && value.rootRefs.every(isPeWorldRootRef)
    && isInspectionTarget(value.inspectionTarget)
    && typeof value.label === "string"
}

interface RetainedOptions<T> {
  enabled: boolean
  resourceKey: string
  tag?: ProjectionTag
  load: () => Promise<T>
  stateFor: (data: T) => ProductTruthState
  confirmedAt?: (data: T) => string | null
}

function useRetainedResource<T>({ enabled, resourceKey, tag, load, stateFor, confirmedAt }: RetainedOptions<T>): ProductResource<T> {
  const [data, setData] = useState<T | null>(null)
  const [dataKey, setDataKey] = useState<string | null>(null)
  const [status, setStatus] = useState<ProductResource<T>["status"]>("idle")
  const [error, setError] = useState<string | null>(null)
  const [errorValue, setErrorValue] = useState<unknown>(null)
  const [truthState, setTruthState] = useState<ProductTruthState>("UNKNOWN")
  const [lastConfirmedAt, setLastConfirmedAt] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const dataRef = useRef<{ key: string; value: T } | null>(null)
  const reload = useCallback(() => setRevision((value) => value + 1), [])

  useEffect(() => tag ? onBusinessInvalidation((signal) => {
    if (signal.tags.includes(tag)) reload()
  }) : undefined, [reload, tag])

  useEffect(() => {
    if (!enabled) {
      dataRef.current = null
      setData(null)
      setDataKey(null)
      setStatus("idle")
      setError(null)
      setErrorValue(null)
      setTruthState("UNKNOWN")
      setLastConfirmedAt(null)
      return
    }
    const retained = dataRef.current?.key === resourceKey ? dataRef.current.value : null
    if (!retained) {
      setData(null)
      setDataKey(null)
      setLastConfirmedAt(null)
    }
    let active = true
    setStatus("loading")
    setError(null)
    setErrorValue(null)
    void load()
      .then((value) => {
        if (!active) return
        dataRef.current = { key: resourceKey, value }
        setData(value)
        setDataKey(resourceKey)
        setStatus("ready")
        setTruthState(stateFor(value))
        setLastConfirmedAt(confirmedAt?.(value) ?? new Date().toISOString())
      })
      .catch((cause) => {
        if (!active) return
        const current = dataRef.current?.key === resourceKey ? dataRef.current.value : null
        setData(current)
        setDataKey(current ? resourceKey : null)
        setStatus("error")
        setError(message(cause))
        setErrorValue(cause)
        setTruthState(unavailableState(cause, Boolean(current)))
      })
    return () => { active = false }
  }, [confirmedAt, enabled, load, resourceKey, revision, stateFor])

  return useMemo(() => ({
    data: dataKey === resourceKey ? data : null,
    status,
    error,
    errorValue,
    truthState,
    lastConfirmedAt,
    reload,
  }), [data, dataKey, error, errorValue, lastConfirmedAt, reload, resourceKey, status, truthState])
}

const rootsState = (data: CompanyBrainSearchResult[]): ProductTruthState => data.length ? "KNOWN" : "KNOWN_EMPTY"
const projectionState = (data: CompanyBrainProjection): ProductTruthState => {
  if (data.nodes.some((node) => node.epistemicState === "CONFLICTING")) return "CONFLICTING"
  if (data.sourceStatus.some((source) => source.status !== "complete") || data.temporal.completeness !== "complete") return "PARTIAL"
  return data.nodes.length ? "KNOWN" : "KNOWN_EMPTY"
}
const activityState = (data: SemanticActivityProjection): ProductTruthState => {
  if (data.sourceStatus.some((source) => source.status !== "complete")) return "PARTIAL"
  return data.items.length ? "KNOWN" : "KNOWN_EMPTY"
}
const workforceState = (data: WorkforceStatusProjection): ProductTruthState => {
  if (data.status === "unavailable") return "UNAVAILABLE"
  if (data.status === "partial" || data.sourceStatus.status === "partial") return "PARTIAL"
  return data.workers.length ? "KNOWN" : "KNOWN_EMPTY"
}
const attentionState = (data: AttentionQueueResult): ProductTruthState => {
  if (data.status === "unavailable" || data.sourceStatus.status === "unavailable") return "UNAVAILABLE"
  if (data.status === "partial" || data.sourceStatus.status === "partial") return "PARTIAL"
  return data.items.length ? "KNOWN" : "KNOWN_EMPTY"
}

export function useCompanyBrainRoots(): PeResource<CompanyBrainSearchResult[]> {
  const { session } = useJarvisAuth()
  const load = useCallback(async () => {
    const result = await jarvisPost<{ results: CompanyBrainSearchResult[] }>("company-brain/roots", { query: "", limit: 50 })
    return Array.isArray(result.results) ? result.results.filter(validRootResult) : []
  }, [])
  return useRetainedResource({ enabled: Boolean(session), resourceKey: session?.user.id ?? "signed-out", tag: "company-brain", load, stateFor: rootsState })
}

export function useCompanyBrainProjection(root: PeWorldRootRef | null): PeResource<CompanyBrainProjection> {
  const { session } = useJarvisAuth()
  const rootType = root?.entityType ?? null
  const rootId = root?.entityId ?? null
  const load = useCallback(async () => {
    const result = await jarvisPost<CompanyBrainProjection>("company-brain/projection", { root: { entityType: rootType, entityId: rootId } })
    if (!isPeWorldRootRef(result.root) || !Array.isArray(result.nodes) || !Array.isArray(result.edges)) throw new Error("Company Brain returned an invalid projection contract.")
    return result
  }, [rootId, rootType])
  const confirmedAt = useCallback((value: CompanyBrainProjection) => value.asOf, [])
  return useRetainedResource({
    enabled: Boolean(session && rootType && rootId),
    resourceKey: `${session?.user.id ?? "signed-out"}:${rootType ?? "none"}:${rootId ?? "none"}`,
    tag: "company-brain",
    load,
    stateFor: projectionState,
    confirmedAt,
  })
}

export function useSemanticActivity(root: PeWorldRootRef | null, limit = 180): PeResource<SemanticActivityProjection> {
  const { session } = useJarvisAuth()
  const rootType = root?.entityType ?? null
  const rootId = root?.entityId ?? null
  const load = useCallback(async () => {
    const result = await jarvisPost<SemanticActivityProjection>("semantic-activity", { root: { entityType: rootType, entityId: rootId }, limit })
    if (result.schemaVersion !== "pe-semantic-activity.v1" || !Array.isArray(result.items)) throw new Error("Semantic Activity returned an invalid projection contract.")
    return { ...result, items: result.items.filter((item) => isCompanyBrainObjectRef(item.subjectRef) && isInspectionTarget(item.inspectionTarget)) }
  }, [limit, rootId, rootType])
  const confirmedAt = useCallback((value: SemanticActivityProjection) => value.asOf, [])
  return useRetainedResource({
    enabled: Boolean(session && rootType && rootId),
    resourceKey: `${session?.user.id ?? "signed-out"}:${rootType ?? "none"}:${rootId ?? "none"}:${limit}`,
    tag: "semantic-activity",
    load,
    stateFor: activityState,
    confirmedAt,
  })
}

export function useWorkforceStatus(enabled: boolean): PeResource<WorkforceStatusProjection> {
  const { session } = useJarvisAuth()
  const load = useCallback(async () => (await jarvisGet<{ data: WorkforceStatusProjection }>("read-models/workforce-status")).data, [])
  const confirmedAt = useCallback((value: WorkforceStatusProjection) => value.asOf, [])
  return useRetainedResource({
    enabled: Boolean(session && enabled),
    resourceKey: session?.user.id ?? "signed-out",
    tag: "agents",
    load,
    stateFor: workforceState,
    confirmedAt,
  })
}

export function useAttentionQueue(): PeResource<AttentionQueueResult> {
  const { session } = useJarvisAuth()
  const load = useCallback(async () => (await jarvisGet<{ data: AttentionQueueResult }>("read-models/attention", { limit: "100" })).data, [])
  const confirmedAt = useCallback((value: AttentionQueueResult) => value.asOf, [])
  return useRetainedResource({
    enabled: Boolean(session),
    resourceKey: session?.user.id ?? "signed-out",
    tag: "company-brain",
    load,
    stateFor: attentionState,
    confirmedAt,
  })
}

export function useFirmDealProjections(roots: CompanyBrainSearchResult[] | null): PeResource<FirmDealProjectionSet> {
  const { session } = useJarvisAuth()
  const dealRoots = useMemo(() => [...new Map((roots ?? []).flatMap((result) => result.rootRefs)
    .filter((root) => root.entityType === "pe_deal")
    .map((root) => [root.entityId, root])).values()], [roots])
  const ids = dealRoots.map((root) => root.entityId).sort().join(",")
  const load = useCallback(async (): Promise<FirmDealProjectionSet> => {
    const results = await Promise.allSettled(dealRoots.map(async (root) => {
      const [projection, activity] = await Promise.allSettled([
        jarvisPost<CompanyBrainProjection>("company-brain/projection", { root }),
        jarvisPost<SemanticActivityProjection>("semantic-activity", { root, limit: 1 }),
      ])
      if (projection.status === "rejected") throw projection.reason
      return { root, projection: projection.value, activity: activity.status === "fulfilled" ? activity.value : null }
    }))
    const items = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : [])
    const failedRoots = results.flatMap((result, index) => result.status === "rejected" ? [dealRoots[index]!] : [])
    const failedActivityRoots = items.filter((item) => !item.activity).map((item) => item.root)
    if (items.length === 0 && dealRoots.length > 0) throw new Error("Every canonical Deal projection is unavailable.")
    return { items, requested: dealRoots.length, failedRoots, failedActivityRoots }
  }, [dealRoots])
  const stateFor = useCallback((value: FirmDealProjectionSet): ProductTruthState => value.failedRoots.length || value.failedActivityRoots.length
    ? "PARTIAL"
    : value.items.length ? "KNOWN" : "KNOWN_EMPTY", [])
  return useRetainedResource({
    enabled: Boolean(session && roots),
    resourceKey: `${session?.user.id ?? "signed-out"}:${ids}`,
    tag: "company-brain",
    load,
    stateFor,
  })
}

export async function loadCompanyBrainObject<T>(operation: "object" | "provenance" | "history" | "evidence-lineage" | "decision-lineage" | "traverse", root: PeWorldRootRef, ref: CompanyBrainObjectRef): Promise<T> {
  return jarvisPost<T>(`company-brain/${operation}`, { root, ref, ...(operation === "history" ? { limit: 50 } : {}), ...(operation === "traverse" ? { depth: 4, direction: "both", limit: 250 } : {}) })
}
