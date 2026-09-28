import { isCompanyBrainObjectRef, isPeWorldRootRef } from "../pe/contracts"

type Query = Record<string, string | string[] | undefined>
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const parse = (value: string | null): unknown => { try { return value ? JSON.parse(value) : null } catch { return null } }

/** Compatibility redirects carry identifiers into WORLD; they never create Work. */
export function legacyWorldHref(query: Query, dealId?: string): string {
  const params = new URLSearchParams()
  for (const [key, raw] of Object.entries(query)) if (typeof raw === "string") params.set(key, raw)
  if (dealId && UUID.test(dealId)) params.set("root", JSON.stringify({ entityType: "pe_deal", entityId: dealId }))
  const root = parse(params.get("root"))
  if (!isPeWorldRootRef(root)) { params.delete("root"); params.delete("object") }
  const inspect = parse(params.get("inspect")) as Record<string, unknown> | null
  const workId = params.get("workId") ?? (typeof inspect?.workId === "string" ? inspect.workId : null)
  if (workId && UUID.test(workId) && isPeWorldRootRef(root)) params.set("object", JSON.stringify({ namespace: "core", owner: "@finnor/db", type: "work", id: workId }))
  else if (!isCompanyBrainObjectRef(parse(params.get("object")))) params.delete("object")
  for (const key of ["inspect", "inspectorTab", "surface"]) params.delete(key)
  return `/centropy/world${params.size ? `?${params.toString()}` : ""}`
}
