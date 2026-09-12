export type ProjectionTag = "preferences" | "company-brain" | "semantic-activity" | "work" | "agents" | "authority"

export interface BusinessInvalidationSignal {
  tags: readonly ProjectionTag[]
  source: "mutation" | "business-event" | "trace" | "manual" | "broadcast" | "realtime" | "resync"
  path?: string
  at: number
}

const listeners = new Set<(signal: BusinessInvalidationSignal) => void>()

export function onBusinessInvalidation(listener: (signal: BusinessInvalidationSignal) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function publishBusinessInvalidation(signal: Omit<BusinessInvalidationSignal, "at">): void {
  if (!signal.tags.length) return
  const event = { ...signal, at: Date.now() }
  listeners.forEach((listener) => listener(event))
}

/** POST is also used by the read-only Company Brain projection. Those reads do
 * not publish a false mutation signal. Real writes invalidate only active PE
 * projections; the server remains the source of truth on the next read. */
export function mutationProjectionTags(path: string): ProjectionTag[] {
  const clean = path.replace(/^\/+/, "")
  if (clean === "workspace-config") return ["preferences"]
  if (clean.startsWith("company-brain/") || clean === "semantic-activity" || clean === "queries") return []
  if (clean === "actions") return ["work", "company-brain", "semantic-activity", "authority"]
  if (/^actions\/[^/]+\/(confirm|reject|escalate|revert)$/.test(clean)) return ["work", "company-brain", "semantic-activity", "authority"]
  if (/^works\/[^/]+\/(retry|handoff)$/.test(clean) || /^instructions\/[^/]+\/cancel$/.test(clean)) return ["work", "company-brain", "semantic-activity"]
  return ["company-brain", "semantic-activity"]
}

export function businessEventProjectionTags(eventType: string, entityType: string): ProjectionTag[] {
  const value = `${eventType}:${entityType}`.toLocaleLowerCase()
  const tags = new Set<ProjectionTag>(["company-brain", "semantic-activity"])
  if (/(work|plan|action|effect|receipt|proof)/.test(value)) tags.add("work")
  if (/(agent|assignment|learning)/.test(value)) tags.add("agents")
  if (/(approval|authority|decision)/.test(value)) tags.add("authority")
  return [...tags]
}
