import { resolveProductRoute, type ProductMethod } from "@/lib/centropy/capability-manifest"

export type ProjectionTag = "preferences" | "company-brain" | "semantic-activity" | "work" | "agents" | "authority" |
  "underwriting" | "ic" | "artifact" | "source" | "thread" | "canvas" | "objective" | "workflow" | "workforce" |
  "workspace" | "preference" | "operating-profile" | "outcome-pack" | "receipt" | "m365" | "corrections" | "connections"

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

/** The same route manifest that guards the proxy owns targeted invalidation. */
export function mutationProjectionTags(path: string, method: ProductMethod = "POST"): ProjectionTag[] {
  const capability = resolveProductRoute(method, path.replace(/^\/+/, "").split("/"))
  if (!capability || capability.classification === "READ") return []
  return capability.invalidationTags as ProjectionTag[]
}

export function businessEventProjectionTags(eventType: string, entityType: string): ProjectionTag[] {
  const value = `${eventType}:${entityType}`.toLocaleLowerCase()
  const tags = new Set<ProjectionTag>(["company-brain", "semantic-activity"])
  if (/(work|plan|action|effect|receipt|proof)/.test(value)) tags.add("work")
  if (/(agent|assignment|learning)/.test(value)) tags.add("agents")
  if (/(approval|authority|decision)/.test(value)) tags.add("authority")
  return [...tags]
}
