import { withPeOperatingContext } from "../pe/context-routing"
import type { PeOperatingContext } from "../pe/contracts"

export type OperationalSurface = "home" | "deals" | "work" | "agents"

export const SURFACES: Array<{ key: OperationalSurface; label: string; href: string }> = [
  { key: "home", label: "Home", href: "/centropy" },
  { key: "deals", label: "Deals", href: "/centropy/deals" },
  { key: "work", label: "Work", href: "/centropy/work" },
  { key: "agents", label: "Agents", href: "/centropy/agents" },
]

export const MOBILE_SURFACES = SURFACES

export function withOperationalContext(href: string, context?: PeOperatingContext): string {
  return context ? withPeOperatingContext(href, context) : href
}
