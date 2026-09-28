import generated from "./capability-manifest.generated.json"

export type ProductMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
export type ProductClassification = "READ" | "MUTATION" | "CONTROL" | "ADMIN" | "STREAM"

export interface ProductCapability {
  capabilityId: string
  family: string
  owner: string
  transport: "http" | "planner"
  method: ProductMethod | null
  routePattern: string | null
  routeDepth: number
  classification: ProductClassification
  kind: "read" | "mutation" | "control"
  userProduct: boolean
  agentProduct: boolean
  modelCallable: boolean
  humanOnly: boolean
  adminOnly: boolean
  systemOnly: boolean
  requiredContext: string[]
  authorityClass: string
  effectClass: string | null
  verificationClass: string
  presentationTargets: string[]
  invalidationTags: string[]
  timeoutClass: "READ" | "WRITE" | "STREAM" | "RUNTIME"
  tests: string[]
  source: string
}

export const PRODUCT_CAPABILITIES: readonly ProductCapability[] = generated.capabilities as ProductCapability[]

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SAFE_SEGMENT = /^[a-zA-Z0-9_-]{1,160}$/

function matches(pattern: string, segments: string[]): boolean {
  const parts = pattern.split("/")
  if (parts.length !== segments.length) return false
  return parts.every((part, index) => {
    const segment = segments[index]
    if (!segment || !SAFE_SEGMENT.test(segment)) return false
    if (!part.startsWith(":")) return part === segment
    return part === ":ref" || part === ":actionType" || part === ":key" ? true : UUID.test(segment)
  })
}

/** Explicit generated route catalogue. Unknown paths and methods are denied. */
export function resolveProductRoute(method: ProductMethod, segments: string[]): ProductCapability | null {
  if (segments.length === 0 || segments.length > 8) return null
  return PRODUCT_CAPABILITIES.find((capability) => capability.transport === "http" &&
    capability.userProduct && capability.method === method && capability.routePattern &&
    matches(capability.routePattern, segments)) ?? null
}

export function capabilityForId(capabilityId: string): ProductCapability | null {
  return PRODUCT_CAPABILITIES.find((capability) => capability.capabilityId === capabilityId) ?? null
}
