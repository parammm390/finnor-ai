"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { jarvisGet, jarvisPost } from "../lib/api"
import { useJarvisAuth } from "../lib/jarvis-auth"
import { onBusinessInvalidation, type ProjectionTag } from "../lib/business-invalidation"
import { isCompanyBrainObjectRef, isInspectionTarget, isPeWorldRootRef, type CompanyBrainObjectRef, type CompanyBrainProjection, type CompanyBrainSearchResult, type PeWorldRootRef, type SemanticActivityProjection, type WorkforceStatusProjection } from "./contracts"

export type PeResourceStatus = "idle" | "loading" | "ready" | "error"

export interface PeResource<T> {
  data: T | null
  status: PeResourceStatus
  error: string | null
  reload: () => void
}

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

function useInvalidation(tag: ProjectionTag, reload: () => void): void {
  useEffect(() => onBusinessInvalidation((signal) => {
    if (signal.tags.includes(tag)) reload()
  }), [reload, tag])
}

export function useCompanyBrainRoots(): PeResource<CompanyBrainSearchResult[]> {
  const { session } = useJarvisAuth()
  const [data, setData] = useState<CompanyBrainSearchResult[] | null>(null)
  const [status, setStatus] = useState<PeResourceStatus>("idle")
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const reload = useCallback(() => setRevision((value) => value + 1), [])
  useInvalidation("company-brain", reload)

  useEffect(() => {
    if (!session) { setData(null); setStatus("idle"); setError(null); return }
    let active = true
    setStatus("loading"); setError(null)
    void jarvisPost<{ results: CompanyBrainSearchResult[] }>("company-brain/roots", { query: "", limit: 50 })
      .then((result) => {
        if (!active) return
        const roots = Array.isArray(result.results) ? result.results.filter(validRootResult) : []
        setData(roots); setStatus("ready")
      })
      .catch((cause) => { if (active) { setData(null); setError(message(cause)); setStatus("error") } })
    return () => { active = false }
  }, [revision, session])

  return useMemo(() => ({ data, status, error, reload }), [data, error, reload, status])
}

export function useCompanyBrainProjection(root: PeWorldRootRef | null): PeResource<CompanyBrainProjection> {
  const { session } = useJarvisAuth()
  const [data, setData] = useState<CompanyBrainProjection | null>(null)
  const [status, setStatus] = useState<PeResourceStatus>("idle")
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const reload = useCallback(() => setRevision((value) => value + 1), [])
  useInvalidation("company-brain", reload)
  const rootType = root?.entityType ?? null
  const rootId = root?.entityId ?? null

  useEffect(() => {
    if (!session || !rootType || !rootId) { setData(null); setStatus("idle"); setError(null); return }
    let active = true
    setStatus("loading"); setError(null)
    void jarvisPost<CompanyBrainProjection>("company-brain/projection", { root: { entityType: rootType, entityId: rootId } })
      .then((result) => {
        if (!active) return
        if (!isPeWorldRootRef(result.root) || !Array.isArray(result.nodes) || !Array.isArray(result.edges)) throw new Error("Company Brain returned an invalid projection contract.")
        setData(result); setStatus("ready")
      })
      .catch((cause) => { if (active) { setData(null); setError(message(cause)); setStatus("error") } })
    return () => { active = false }
  }, [revision, rootId, rootType, session])

  return useMemo(() => ({ data, status, error, reload }), [data, error, reload, status])
}

export function useSemanticActivity(root: PeWorldRootRef | null, limit = 180): PeResource<SemanticActivityProjection> {
  const { session } = useJarvisAuth()
  const [data, setData] = useState<SemanticActivityProjection | null>(null)
  const [status, setStatus] = useState<PeResourceStatus>("idle")
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const reload = useCallback(() => setRevision((value) => value + 1), [])
  useInvalidation("semantic-activity", reload)
  const rootType = root?.entityType ?? null
  const rootId = root?.entityId ?? null

  useEffect(() => {
    if (!session || !rootType || !rootId) { setData(null); setStatus("idle"); setError(null); return }
    let active = true
    setStatus("loading"); setError(null)
    void jarvisPost<SemanticActivityProjection>("semantic-activity", { root: { entityType: rootType, entityId: rootId }, limit })
      .then((result) => {
        if (!active) return
        if (result.schemaVersion !== "pe-semantic-activity.v1" || !Array.isArray(result.items)) throw new Error("Semantic Activity returned an invalid projection contract.")
        const items = result.items.filter((item) => isCompanyBrainObjectRef(item.subjectRef) && isInspectionTarget(item.inspectionTarget))
        setData({ ...result, items }); setStatus("ready")
      })
      .catch((cause) => { if (active) { setData(null); setError(message(cause)); setStatus("error") } })
    return () => { active = false }
  }, [limit, revision, rootId, rootType, session])

  return useMemo(() => ({ data, status, error, reload }), [data, error, reload, status])
}

export function useWorkforceStatus(enabled: boolean): PeResource<WorkforceStatusProjection> {
  const { session } = useJarvisAuth()
  const [data, setData] = useState<WorkforceStatusProjection | null>(null)
  const [status, setStatus] = useState<PeResourceStatus>("idle")
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const reload = useCallback(() => setRevision((value) => value + 1), [])
  useInvalidation("agents", reload)

  useEffect(() => {
    if (!session || !enabled) { setData(null); setStatus("idle"); setError(null); return }
    let active = true
    setStatus("loading"); setError(null)
    void jarvisGet<{ data: WorkforceStatusProjection }>("read-models/workforce-status")
      .then((result) => { if (active) { setData(result.data); setStatus("ready") } })
      .catch((cause) => { if (active) { setData(null); setError(message(cause)); setStatus("error") } })
    return () => { active = false }
  }, [enabled, revision, session])

  return useMemo(() => ({ data, status, error, reload }), [data, error, reload, status])
}

export async function loadCompanyBrainObject<T>(operation: "object" | "provenance" | "history" | "evidence-lineage" | "decision-lineage", root: PeWorldRootRef, ref: CompanyBrainObjectRef): Promise<T> {
  return jarvisPost<T>(`company-brain/${operation}`, { root, ref, ...(operation === "history" ? { limit: 50 } : {}) })
}
