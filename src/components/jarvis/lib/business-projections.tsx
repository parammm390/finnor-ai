"use client"

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { useJarvisAuth } from "./jarvis-auth"
import { BusinessInvalidationBatcher, onBusinessInvalidation, publishBusinessInvalidation, type BusinessInvalidationSignal } from "./business-invalidation"
import { JarvisApiError, jarvisGet } from "./api"
import {
  ALL_REALTIME_TAGS,
  parseOperationalCursor,
  reduceOperationalDelta,
  type OperationalCursorState,
  type OperationalDelta,
  type OperationalDeltaPage,
} from "./operational-delta"
import {
  BusinessProjectionCache,
  serializeProjectionKey,
  type ProjectionDefinition,
  type ProjectionMetrics,
  type ProjectionSnapshot,
  type ProjectionTag,
} from "./business-projection-cache"

const BROADCAST_CHANNEL = "jarvis-business-projections-v1"

interface ProjectionClient {
  fetch<T>(definition: ProjectionDefinition<T>, force?: boolean): Promise<T | null>
  prime<T>(definition: ProjectionDefinition<T>, data: T, updatedAt?: number): void
  invalidate(tags: readonly ProjectionTag[], source?: BusinessInvalidationSignal["source"]): void
  metrics(): ProjectionMetrics
}

interface ProjectionContextValue {
  cache: BusinessProjectionCache
  client: ProjectionClient
  online: boolean
  visible: boolean
}

const ProjectionContext = createContext<ProjectionContextValue | null>(null)

function publishMetricsToBrowser(metrics: ProjectionMetrics): void {
  if (typeof window === "undefined") return
  ;(window as unknown as { __JARVIS_PROJECTION_METRICS__?: ProjectionMetrics }).__JARVIS_PROJECTION_METRICS__ = metrics
  window.dispatchEvent(new CustomEvent("jarvis:projection-metrics", { detail: metrics }))
}

function publishRealtimeStatus(status: "connecting" | "live" | "polling" | "paused", cursor: string | null, error?: string): void {
  if (typeof window === "undefined") return
  const detail = { status, cursor, error: error ?? null, at: Date.now() }
  ;(window as unknown as { __JARVIS_REALTIME_STATUS__?: typeof detail }).__JARVIS_REALTIME_STATUS__ = detail
  window.dispatchEvent(new CustomEvent("jarvis:realtime-status", { detail }))
}

async function consumeSse(
  response: Response,
  signal: AbortSignal,
  onFrame: (event: string, data: unknown, id: string | null) => void,
): Promise<void> {
  if (!response.body) throw new Error("Realtime stream has no response body")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n")
      const frames = buffer.split("\n\n")
      buffer = frames.pop() ?? ""
      for (const frame of frames) {
        if (!frame.trim() || frame.startsWith(":")) continue
        let event = "message"
        let id: string | null = null
        const dataLines: string[] = []
        for (const line of frame.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7)
          else if (line.startsWith("id: ")) id = line.slice(4)
          else if (line.startsWith("data: ")) dataLines.push(line.slice(6))
        }
        if (dataLines.length === 0) continue
        let data: unknown
        try { data = JSON.parse(dataLines.join("\n")) } catch { continue }
        onFrame(event, data, id)
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

export function BusinessProjectionProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const { session } = useJarvisAuth()
  const sessionBoundary = session ? `${session.user.id}:${session.access_token}` : "signed-out"
  const cache = useMemo(() => {
    void sessionBoundary
    return new BusinessProjectionCache(publishMetricsToBrowser)
  }, [sessionBoundary])
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine)
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden")
  useEffect(() => () => cache.reset(), [cache])

  useEffect(() => {
    const onVisibility = () => {
      const next = document.visibilityState !== "hidden"
      setVisible(next)
      cache.setVisible(next)
    }
    const onOnline = () => {
      setOnline(true)
      cache.setOnline(true)
    }
    const onOffline = () => {
      setOnline(false)
      cache.setOnline(false)
    }
    onVisibility()
    cache.setOnline(typeof navigator === "undefined" || navigator.onLine)
    window.addEventListener("online", onOnline)
    window.addEventListener("offline", onOffline)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      window.removeEventListener("online", onOnline)
      window.removeEventListener("offline", onOffline)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [cache])

  useEffect(() => {
    if (!session) return
    const scope = session.user.id
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(BROADCAST_CHANNEL)
    const unsubscribe = onBusinessInvalidation((signal) => {
      cache.invalidate(signal.tags)
      if (signal.source !== "broadcast") channel?.postMessage({ scope, tags: signal.tags, at: signal.at })
    })
    if (channel) {
      channel.onmessage = (event: MessageEvent<unknown>) => {
        const value = event.data
        if (!value || typeof value !== "object" || Array.isArray(value)) return
        const message = value as { scope?: unknown; tags?: unknown }
        if (message.scope !== scope || !Array.isArray(message.tags)) return
        publishBusinessInvalidation({
          tags: message.tags.filter((tag): tag is ProjectionTag => typeof tag === "string") as ProjectionTag[],
          source: "broadcast",
        })
      }
    }
    return () => {
      unsubscribe()
      channel?.close()
    }
  }, [cache, session])

  useEffect(() => {
    if (!session || !online || !visible) {
      cache.setRealtimeMode("polling")
      publishRealtimeStatus("paused", null)
      return
    }
    let cancelled = false
    let controller: AbortController | null = null
    const realtimeInvalidations = new BusinessInvalidationBatcher()
    const storageKey = `jarvis-operational-cursor:${session.user.id}`
    let state: OperationalCursorState | null = null
    try {
      const stored = window.localStorage.getItem(storageKey)
      state = stored ? parseOperationalCursor(stored) : null
      if (stored && !state) window.localStorage.removeItem(storageKey)
    } catch { state = null }

    const persist = (next: OperationalCursorState) => {
      state = next
      try { window.localStorage.setItem(storageKey, next.cursor) } catch { /* storage is an optimization */ }
    }
    const resync = (cursor: string) => {
      const next = parseOperationalCursor(cursor)
      if (next) persist(next)
      realtimeInvalidations.push(ALL_REALTIME_TAGS, "resync")
    }
    const applyDelta = (delta: OperationalDelta): boolean => {
      if (!state) return false
      const reduction = reduceOperationalDelta(state, delta)
      if (reduction.kind === "ignore") return true
      if (reduction.kind === "resync") return false
      persist(reduction.state)
      if (reduction.tags.length > 0) realtimeInvalidations.push(reduction.tags, "realtime")
      if (reduction.highPriority) window.dispatchEvent(new CustomEvent("jarvis:operational-attention", { detail: { cursor: delta.cursor, changeType: delta.changeType, entityRefs: delta.entityRefs, workId: delta.workId } }))
      return true
    }
    const applyPage = (page: OperationalDeltaPage): boolean => {
      if (page.status === "resync_required") { resync(page.cursor); return true }
      for (const delta of page.deltas) if (!applyDelta(delta)) return false
      const end = parseOperationalCursor(page.cursor)
      if (end && (!state || end.scope === state.scope) && (!state || end.seq >= state.seq)) persist(end)
      return true
    }
    const replay = async () => {
      for (let pageCount = 0; pageCount < 4 && !cancelled; pageCount += 1) {
        let page: OperationalDeltaPage
        try {
          page = await jarvisGet<OperationalDeltaPage>("operational-deltas", state ? { cursor: state.cursor, limit: "250" } : undefined)
        } catch (error) {
          if (!(error instanceof JarvisApiError) || (error.status !== 400 && error.status !== 409)) throw error
          // A malformed/stale-scope local cursor is not reusable. Establish inside
          // the newly authenticated tenant and refetch every active projection.
          state = null
          try { window.localStorage.removeItem(storageKey) } catch { /* storage is an optimization */ }
          const current = await jarvisGet<OperationalDeltaPage>("operational-deltas")
          resync(current.cursor)
          return
        }
        if (!state) {
          const established = parseOperationalCursor(page.cursor)
          if (!established) throw new Error("Backend returned an invalid operational cursor")
          persist(established)
        }
        if (!applyPage(page)) { resync(page.cursor); return }
        if (!page.hasMore) return
      }
      // More than 1,000 retained changes is intentionally not replayed in one
      // browser turn. Refresh all active projections once and establish high-water.
      const current = await jarvisGet<OperationalDeltaPage>("operational-deltas")
      resync(current.cursor)
    }

    void (async () => {
      let retry = 0
      while (!cancelled) {
        try {
          // Replay is part of the same bounded recovery loop as stream setup. An
          // initial API outage must not terminate realtime until this effect remounts.
          await replay()
          if (cancelled) break
          controller = new AbortController()
          publishRealtimeStatus("connecting", state?.cursor ?? null)
          const response = await fetch("/api/jarvis/operational-stream", {
            cache: "no-store",
            headers: {
              authorization: `Bearer ${session.access_token}`,
              ...(state ? { "last-event-id": state.cursor } : {}),
            },
            signal: controller.signal,
          })
          if (!response.ok) throw new Error(`Realtime gateway returned ${response.status}`)
          retry = 0
          cache.setRealtimeMode("live")
          publishRealtimeStatus("live", state?.cursor ?? null)
          await consumeSse(response, controller.signal, (event, data, id) => {
            if (event === "resync") {
              const cursor = data && typeof data === "object" && "cursor" in data ? String((data as { cursor: unknown }).cursor) : id
              if (cursor) resync(cursor)
              return
            }
            if (event !== "operational_delta" || !data || typeof data !== "object") return
            const delta = data as OperationalDelta
            if (id !== delta.cursor || !applyDelta(delta)) throw new Error("Operational delta ordering gap")
          })
          if (!cancelled) throw new Error("Realtime gateway disconnected")
        } catch (error) {
          if (cancelled || controller?.signal.aborted) break
          cache.setRealtimeMode("polling")
          publishRealtimeStatus("polling", state?.cursor ?? null, error instanceof Error ? error.message : String(error))
          retry += 1
          const delay = Math.min(15_000, 1_000 * 2 ** Math.min(retry, 4))
          await new Promise((resolve) => window.setTimeout(resolve, delay))
        }
      }
    })()
    return () => {
      cancelled = true
      controller?.abort()
      realtimeInvalidations.cancel()
    }
  }, [cache, online, session, visible])

  const client = useMemo<ProjectionClient>(() => ({
    fetch: async <T,>(definition: ProjectionDefinition<T>, force = false) => {
      const id = cache.register(definition)
      return cache.ensure<T>(id, force)
    },
    prime: <T,>(definition: ProjectionDefinition<T>, data: T, updatedAt?: number) => cache.prime(definition, data, updatedAt),
    invalidate: (tags, source = "manual") => publishBusinessInvalidation({ tags, source }),
    metrics: () => cache.metricsSnapshot(),
  }), [cache])

  const value = useMemo(() => ({ cache, client, online, visible }), [cache, client, online, visible])
  return <ProjectionContext.Provider value={value}>{children}</ProjectionContext.Provider>
}

function useProjectionContext(): ProjectionContextValue {
  const context = useContext(ProjectionContext)
  if (!context) throw new Error("Business projections require <BusinessProjectionProvider>")
  return context
}

export interface UseBusinessProjectionOptions<T> {
  enabled?: boolean
  initialData?: T
  initialUpdatedAt?: number
}

export interface BusinessProjectionResult<T> extends ProjectionSnapshot<T> {
  online: boolean
  visible: boolean
  refresh: () => Promise<T | null>
}

export function useBusinessProjection<T>(definition: ProjectionDefinition<T>, options: UseBusinessProjectionOptions<T> = {}): BusinessProjectionResult<T> {
  const { cache, online, visible } = useProjectionContext()
  const enabled = options.enabled ?? true
  const id = cache.register(definition)
  const subscribe = useCallback((listener: () => void) => enabled ? cache.subscribe(id, listener) : () => undefined, [cache, enabled, id])
  const getSnapshot = useCallback(() => cache.snapshot<T>(id), [cache, id])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  useEffect(() => {
    if (!enabled) return
    if (options.initialData !== undefined) cache.prime(definition, options.initialData, options.initialUpdatedAt)
    void cache.ensure<T>(id).catch(() => undefined)
  }, [cache, definition, enabled, id, options.initialData, options.initialUpdatedAt])

  const refresh = useCallback(() => cache.ensure<T>(id, true), [cache, id])
  return useMemo(() => ({ ...snapshot, online, visible, refresh }), [online, refresh, snapshot, visible])
}

export function useBusinessProjectionClient(): ProjectionClient {
  return useProjectionContext().client
}

export function useBusinessProjectionMetrics(): ProjectionMetrics {
  const { cache } = useProjectionContext()
  return useSyncExternalStore(
    useCallback((listener: () => void) => cache.subscribeMetrics(listener), [cache]),
    useCallback(() => cache.metricsSnapshot(), [cache]),
    useCallback(() => cache.metricsSnapshot(), [cache]),
  )
}

export function projectionKeyId(definition: ProjectionDefinition<unknown>): string {
  return serializeProjectionKey(definition.key)
}
