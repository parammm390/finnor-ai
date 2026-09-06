export type OperationalSurface = "home" | "work" | "customers" | "schedule" | "money" | "agents"

export interface HouseholdContext {
  id: string
  label: string
}

export const SURFACES: Array<{ key: OperationalSurface; label: string; href: string }> = [
  { key: "home", label: "Home", href: "/jarvis" },
  { key: "work", label: "Work", href: "/jarvis/work" },
  { key: "customers", label: "Customers", href: "/jarvis/customers" },
  { key: "schedule", label: "Schedule", href: "/jarvis/schedule" },
  { key: "money", label: "Money", href: "/jarvis/money" },
  { key: "agents", label: "Agents", href: "/jarvis/agents" },
]

export const MOBILE_SURFACES = SURFACES.filter((surface) => surface.key !== "customers" && surface.key !== "agents")

export function withHouseholdContext(href: string, context: HouseholdContext | undefined): string {
  return withOperationalContext(href, context)
}

export function withOperationalContext(href: string, context?: HouseholdContext, workCaseId?: string | null): string {
  if (!context && !workCaseId) return href
  const [withoutHash, hash] = href.split("#", 2)
  const [path, query] = withoutHash!.split("?", 2)
  const params = new URLSearchParams(query ?? "")
  if (context) params.set("householdId", context.id)
  if (workCaseId) params.set("workCaseId", workCaseId)
  const suffix = params.size > 0 ? `?${params.toString()}` : ""
  return `${path}${suffix}${hash ? `#${hash}` : ""}`
}

export function withHouseholdId(href: string, householdId: string | null): string {
  return withHouseholdContext(href, householdId ? { id: householdId, label: "" } : undefined)
}
