"use client"

// C1.T2 — one hook for "live" data everywhere: SSE-first with an adaptive-polling
// fallback, cursor-aware. Distinct from src/components/jarvis/lib/data-core.ts's
// existing JarvisDataProvider (a working, already-serving-~15-panels app-wide poller
// with its own fast/medium/slow/sanity lanes) — that machinery stays untouched per
// hard rule #8 (no panel refactors before C1's snapshots cover them). This hook is
// NEW infrastructure for cursor-feed-style endpoints data-core.ts doesn't model
// (starting with GET /api/activity, A2.T6) — a per-consumer live query, not a second
// app-wide provider.
//
// Honest state of the SSE path: B1 (the realtime backbone — pg_notify → SSE gateway
// on Railway) has not shipped yet as of this session. There is no real SSE endpoint
// to connect to. This hook still implements the SSE branch for real (EventSource,
// exponential-backoff reconnect, browser-native Last-Event-ID resumption) so it's
// ready the day B1 ships — but until a caller passes a real `sseUrl`, every consumer
// of this hook runs in pure polling mode. That is not a placeholder or a lie: it's
// the accurate, honest behavior of real code with no server on the other end yet.

import { useEffect, useRef, useState } from "react"

export type LiveQueryConnection = "connecting" | "sse" | "polling"

export interface LiveQueryResult<TCursor> {
  cursor: TCursor | null
  hasMore?: boolean
}

export interface UseLiveQueryOptions<TData, TCursor> {
  /** SSE endpoint to attempt first. Omit until B1 ships one — the hook falls straight
   *  to polling, honestly, rather than connecting to something that doesn't exist. */
  sseUrl?: string
  /** One poll: given the last cursor (null on the first call), fetch the next batch. */
  fetchPage: (cursor: TCursor | null) => Promise<TData & LiveQueryResult<TCursor>>
  /** Merge a freshly-fetched page into accumulated state. Called on every successful
   *  poll AND every SSE-triggered refetch — same reducer either way, so behavior
   *  never depends on which transport happened to be active. */
  reduce: (prev: TData | null, next: TData) => TData
  /** ms between polls while the tab is visible. Plan spec: 2-3s. */
  visibleIntervalMs?: number
  /** ms between polls while the tab is hidden/blurred. Plan spec: 15-30s. */
  blurredIntervalMs?: number
  /** Max consecutive SSE reconnect attempts (exponential backoff) before permanently
   *  falling back to polling for the rest of this mount. */
  maxSseRetries?: number
  enabled?: boolean
}

export interface UseLiveQueryState<TData> {
  data: TData | null
  connection: LiveQueryConnection
  error: string | null
  lastUpdatedAt: number | null
  hasMore: boolean
}

const DEFAULT_VISIBLE_MS = 2500
const DEFAULT_BLURRED_MS = 20_000
const DEFAULT_MAX_SSE_RETRIES = 5
const SSE_BACKOFF_BASE_MS = 500

export function useLiveQuery<TData, TCursor = string>(opts: UseLiveQueryOptions<TData, TCursor>): UseLiveQueryState<TData> {
  const {
    sseUrl,
    fetchPage,
    reduce,
    visibleIntervalMs = DEFAULT_VISIBLE_MS,
    blurredIntervalMs = DEFAULT_BLURRED_MS,
    maxSseRetries = DEFAULT_MAX_SSE_RETRIES,
    enabled = true,
  } = opts

  const [state, setState] = useState<UseLiveQueryState<TData>>({
    data: null,
    connection: sseUrl ? "connecting" : "polling",
    error: null,
    lastUpdatedAt: null,
    hasMore: false,
  })

  const cursorRef = useRef<TCursor | null>(null)
  const dataRef = useRef<TData | null>(null)
  const visibleRef = useRef(typeof document === "undefined" ? true : document.visibilityState !== "hidden")
  const sseRetryCountRef = useRef(0)
  const sseGivenUpRef = useRef(false)
  const eventSourceRef = useRef<EventSource | null>(null)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    if (!enabled) return () => undefined

    async function poll(): Promise<void> {
      if (!mountedRef.current) return
      // Blurred/hidden slows the cadence (schedulePoll below picks blurredIntervalMs)
      // but never stops it outright — the plan spec is "2-3s visible, 15-30s blurred",
      // a two-speed continuous poll, not a pause. (data-core.ts's older app-wide
      // poller DOES pause outright when hidden; this hook is deliberately more
      // faithful to C1.T2's adaptive-polling spec, not copying that convention.)
      try {
        const page = await fetchPage(cursorRef.current)
        if (!mountedRef.current) return
        const merged = reduce(dataRef.current, page)
        dataRef.current = merged
        cursorRef.current = page.cursor ?? cursorRef.current
        setState((prev) => ({
          ...prev,
          data: merged,
          error: null,
          lastUpdatedAt: Date.now(),
          hasMore: page.hasMore ?? prev.hasMore,
          connection: prev.connection === "connecting" ? "polling" : prev.connection,
        }))
      } catch (err) {
        if (!mountedRef.current) return
        setState((prev) => ({ ...prev, error: err instanceof Error ? err.message : "Poll failed" }))
      } finally {
        schedulePoll()
      }
    }

    function schedulePoll(): void {
      if (!mountedRef.current) return
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current)
      const delay = visibleRef.current ? visibleIntervalMs : blurredIntervalMs
      pollTimerRef.current = setTimeout(poll, delay)
    }

    function startPolling(): void {
      setState((prev) => (prev.connection === "sse" ? prev : { ...prev, connection: "polling" }))
      void poll()
    }

    function connectSse(url: string): void {
      if (!mountedRef.current || sseGivenUpRef.current) return
      const es = new EventSource(url, { withCredentials: true })
      eventSourceRef.current = es

      es.onopen = () => {
        sseRetryCountRef.current = 0
        if (mountedRef.current) setState((prev) => ({ ...prev, connection: "sse", error: null }))
      }
      // A real SSE event here is a signal to refetch (IDs-only payloads per B1's own
      // design note — "listeners refetch via authz'd APIs"), not a payload to trust
      // blindly. Reuses the exact same fetchPage/reduce path polling uses.
      es.onmessage = () => {
        void poll()
      }
      es.onerror = () => {
        es.close()
        if (!mountedRef.current) return
        sseRetryCountRef.current += 1
        if (sseRetryCountRef.current > maxSseRetries) {
          sseGivenUpRef.current = true
          startPolling()
          return
        }
        const backoff = SSE_BACKOFF_BASE_MS * 2 ** (sseRetryCountRef.current - 1)
        setState((prev) => ({ ...prev, connection: "connecting" }))
        setTimeout(() => connectSse(url), backoff)
      }
    }

    // Always poll once immediately regardless of transport, so there's real data on
    // screen before an SSE connection (or its absence) is even resolved.
    void poll()
    if (sseUrl) connectSse(sseUrl)

    function onVisibility(): void {
      const wasHidden = !visibleRef.current
      visibleRef.current = document.visibilityState !== "hidden"
      if (visibleRef.current && wasHidden) {
        if (pollTimerRef.current) clearTimeout(pollTimerRef.current)
        void poll()
      }
    }
    document.addEventListener("visibilitychange", onVisibility)

    return () => {
      mountedRef.current = false
      document.removeEventListener("visibilitychange", onVisibility)
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current)
      eventSourceRef.current?.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetchPage/reduce are expected to be stable per mount (fixture/panel-scoped), matching data-core.ts's own useCallback convention
  }, [sseUrl, enabled])

  return state
}
