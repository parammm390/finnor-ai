export type ProjectionTag =
  | "actions"
  | "activity"
  | "agents"
  | "approvals"
  | "comms"
  | "computer"
  | "customers"
  | "events"
  | "inventory"
  | "money"
  | "preferences"
  | "queries"
  | "receipts"
  | "schedule"
  | "system"
  | "work"
  | "workflows"

export type ProjectionKey = readonly (string | number | boolean | null | undefined)[]

export interface ProjectionDefinition<T> {
  key: ProjectionKey
  owner: string
  staleMs: number
  pollMs?: number
  /** Poll interval used for selected active projections while realtime is down. */
  fallbackPollMs?: number
  tags: readonly ProjectionTag[]
  load: () => Promise<T>
}

export type ProjectionStatus = "idle" | "loading" | "ready" | "error"

export interface ProjectionSnapshot<T> {
  data: T | null
  status: ProjectionStatus
  error: Error | null
  updatedAt: number | null
  invalidatedAt: number | null
  stale: boolean
  refreshing: boolean
}

export interface ProjectionMetrics {
  requestsStarted: number
  requestsCompleted: number
  requestsFailed: number
  requestsDeduped: number
  invalidations: number
  staleReads: number
  staleResponsesDiscarded: number
  reconnects: number
  totalRefreshLatencyMs: number
  lastRefreshLatencyMs: number | null
  lastRefreshAt: number | null
}

interface Entry<T = unknown> {
  id: string
  definition: ProjectionDefinition<T>
  snapshot: ProjectionSnapshot<T>
  listeners: Set<() => void>
  inFlight: Promise<T> | null
  revision: number
  timer: ReturnType<typeof setTimeout> | null
}

const EMPTY_SNAPSHOT: ProjectionSnapshot<never> = Object.freeze({
  data: null,
  status: "idle",
  error: null,
  updatedAt: null,
  invalidatedAt: null,
  stale: false,
  refreshing: false,
})

const EMPTY_METRICS: ProjectionMetrics = Object.freeze({
  requestsStarted: 0,
  requestsCompleted: 0,
  requestsFailed: 0,
  requestsDeduped: 0,
  invalidations: 0,
  staleReads: 0,
  staleResponsesDiscarded: 0,
  reconnects: 0,
  totalRefreshLatencyMs: 0,
  lastRefreshLatencyMs: null,
  lastRefreshAt: null,
})

export function serializeProjectionKey(key: ProjectionKey): string {
  return JSON.stringify(key)
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error("Projection refresh failed")
}

export class BusinessProjectionCache {
  private entries = new Map<string, Entry>()
  private generation = 0
  private visible = true
  private online = true
  private realtimeMode: "live" | "polling" = "live"
  private metrics: ProjectionMetrics = { ...EMPTY_METRICS }
  private metricsListeners = new Set<() => void>()
  private onMetrics?: (metrics: ProjectionMetrics) => void

  constructor(onMetrics?: (metrics: ProjectionMetrics) => void) {
    this.onMetrics = onMetrics
  }

  register<T>(definition: ProjectionDefinition<T>): string {
    const id = serializeProjectionKey(definition.key)
    const existing = this.entries.get(id) as Entry<T> | undefined
    if (existing) {
      existing.definition = definition
      return id
    }
    this.entries.set(id, {
      id,
      definition,
      snapshot: { ...EMPTY_SNAPSHOT },
      listeners: new Set(),
      inFlight: null,
      revision: 0,
      timer: null,
    })
    return id
  }

  snapshot<T>(id: string): ProjectionSnapshot<T> {
    return (this.entries.get(id)?.snapshot ?? EMPTY_SNAPSHOT) as ProjectionSnapshot<T>
  }

  metricsSnapshot(): ProjectionMetrics {
    return this.metrics
  }

  subscribe(id: string, listener: () => void): () => void {
    const entry = this.entries.get(id)
    if (!entry) return () => undefined
    entry.listeners.add(listener)
    this.schedule(entry)
    return () => {
      entry.listeners.delete(listener)
      if (entry.listeners.size === 0) this.clearTimer(entry)
    }
  }

  subscribeMetrics(listener: () => void): () => void {
    this.metricsListeners.add(listener)
    return () => this.metricsListeners.delete(listener)
  }

  async ensure<T>(id: string, force = false): Promise<T | null> {
    const entry = this.entries.get(id) as Entry<T> | undefined
    if (!entry) return null
    const age = entry.snapshot.updatedAt === null ? Number.POSITIVE_INFINITY : Date.now() - entry.snapshot.updatedAt
    const staleByAge = age >= entry.definition.staleMs
    if (staleByAge && entry.snapshot.data !== null && !entry.snapshot.stale) {
      entry.snapshot = { ...entry.snapshot, stale: true }
      this.bumpMetric("staleReads")
      this.notify(entry)
    }
    if (!force && entry.snapshot.data !== null && !entry.snapshot.stale && !staleByAge) return entry.snapshot.data
    // navigator.onLine is only a connectivity hint. Browsers can report false
    // while same-origin requests still work; suppressing the request here leaves
    // every empty projection permanently stuck in its loading state. Always let
    // the bounded API request determine whether the source is reachable.
    if (!this.visible) return entry.snapshot.data
    if (entry.inFlight) {
      this.bumpMetric("requestsDeduped")
      return entry.inFlight
    }

    const requestGeneration = this.generation
    const requestRevision = entry.revision
    const started = Date.now()
    this.clearTimer(entry)
    entry.snapshot = {
      ...entry.snapshot,
      status: entry.snapshot.data === null ? "loading" : entry.snapshot.status,
      refreshing: true,
      error: null,
    }
    this.bumpMetric("requestsStarted")
    this.notify(entry)

    const request = entry.definition.load()
    entry.inFlight = request
    try {
      const data = await request
      if (requestGeneration !== this.generation || this.entries.get(id) !== entry) return null
      if (requestRevision !== entry.revision) {
        this.bumpMetric("staleResponsesDiscarded")
        entry.snapshot = { ...entry.snapshot, stale: true, refreshing: false }
        this.notify(entry)
        return entry.snapshot.data
      }
      const finished = Date.now()
      entry.snapshot = {
        data,
        status: "ready",
        error: null,
        updatedAt: finished,
        invalidatedAt: null,
        stale: false,
        refreshing: false,
      }
      this.setMetrics({
        ...this.metrics,
        requestsCompleted: this.metrics.requestsCompleted + 1,
        totalRefreshLatencyMs: this.metrics.totalRefreshLatencyMs + (finished - started),
        lastRefreshLatencyMs: finished - started,
        lastRefreshAt: finished,
      })
      this.notify(entry)
      return data
    } catch (cause) {
      if (requestGeneration !== this.generation || this.entries.get(id) !== entry) return null
      entry.snapshot = {
        ...entry.snapshot,
        status: "error",
        error: asError(cause),
        stale: entry.snapshot.data !== null,
        refreshing: false,
      }
      this.bumpMetric("requestsFailed")
      this.notify(entry)
      throw cause
    } finally {
      if (this.entries.get(id) === entry) {
        entry.inFlight = null
        if (requestRevision !== entry.revision && this.visible && this.online && entry.listeners.size > 0) {
          void this.ensure(id, true).catch(() => undefined)
        } else {
          this.schedule(entry)
        }
      }
    }
  }

  prime<T>(definition: ProjectionDefinition<T>, data: T, updatedAt = Date.now()): void {
    const id = this.register(definition)
    const entry = this.entries.get(id) as Entry<T>
    if (entry.snapshot.updatedAt !== null && entry.snapshot.updatedAt >= updatedAt) return
    entry.snapshot = {
      data,
      status: "ready",
      error: null,
      updatedAt,
      invalidatedAt: null,
      stale: false,
      refreshing: false,
    }
    this.notify(entry)
    this.schedule(entry)
  }

  invalidate(tags: readonly ProjectionTag[]): string[] {
    if (tags.length === 0) return []
    const wanted = new Set(tags)
    const invalidated: string[] = []
    const now = Date.now()
    for (const entry of this.entries.values()) {
      if (!entry.definition.tags.some((tag) => wanted.has(tag))) continue
      entry.revision += 1
      entry.snapshot = { ...entry.snapshot, stale: entry.snapshot.data !== null, invalidatedAt: now }
      invalidated.push(entry.id)
      this.notify(entry)
      if (entry.listeners.size > 0 && this.visible && this.online) void this.ensure(entry.id, true).catch(() => undefined)
    }
    if (invalidated.length > 0) this.setMetrics({ ...this.metrics, invalidations: this.metrics.invalidations + invalidated.length })
    return invalidated
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return
    this.visible = visible
    for (const entry of this.entries.values()) {
      this.clearTimer(entry)
      if (visible && entry.listeners.size > 0) {
        const expired = entry.snapshot.updatedAt === null || Date.now() - entry.snapshot.updatedAt >= entry.definition.staleMs
        if (entry.snapshot.stale || expired) void this.ensure(entry.id, true).catch(() => undefined)
        else this.schedule(entry)
      }
    }
  }

  setOnline(online: boolean): void {
    if (this.online === online) return
    this.online = online
    if (!online) {
      for (const entry of this.entries.values()) this.clearTimer(entry)
      return
    }
    this.bumpMetric("reconnects")
    for (const entry of this.entries.values()) {
      if (entry.listeners.size > 0 && this.visible) void this.ensure(entry.id, true).catch(() => undefined)
    }
  }

  setRealtimeMode(mode: "live" | "polling"): void {
    if (this.realtimeMode === mode) return
    this.realtimeMode = mode
    for (const entry of this.entries.values()) {
      this.clearTimer(entry)
      if (!this.visible || !this.online || entry.listeners.size === 0) continue
      if (mode === "polling" && entry.definition.fallbackPollMs) {
        void this.ensure(entry.id, true).catch(() => undefined)
      } else {
        this.schedule(entry)
      }
    }
  }

  reset(): void {
    this.generation += 1
    for (const entry of this.entries.values()) this.clearTimer(entry)
    this.entries.clear()
    this.metrics = { ...EMPTY_METRICS }
    this.publishMetrics()
  }

  private schedule(entry: Entry): void {
    this.clearTimer(entry)
    const pollMs = this.realtimeMode === "polling"
      ? entry.definition.fallbackPollMs ?? entry.definition.pollMs
      : entry.definition.pollMs
    if (!this.visible || !this.online || entry.listeners.size === 0 || !pollMs) return
    const elapsed = entry.snapshot.updatedAt === null ? pollMs : Date.now() - entry.snapshot.updatedAt
    const delay = Math.max(0, pollMs - elapsed)
    entry.timer = setTimeout(() => {
      entry.timer = null
      void this.ensure(entry.id, true).catch(() => undefined)
    }, delay)
  }

  private clearTimer(entry: Entry): void {
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.timer = null
  }

  private notify(entry: Entry): void {
    entry.listeners.forEach((listener) => listener())
  }

  private bumpMetric(key: keyof ProjectionMetrics): void {
    const value = this.metrics[key]
    if (typeof value !== "number") return
    this.setMetrics({ ...this.metrics, [key]: value + 1 })
  }

  private setMetrics(next: ProjectionMetrics): void {
    this.metrics = next
    this.publishMetrics()
  }

  private publishMetrics(): void {
    this.metricsListeners.forEach((listener) => listener())
    this.onMetrics?.(this.metrics)
  }
}
