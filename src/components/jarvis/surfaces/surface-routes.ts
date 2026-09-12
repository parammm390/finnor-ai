import { withPeOperatingContext } from "../pe/context-routing"
import type { PeOperatingContext } from "../pe/contracts"

export type OperationalSurface = "home" | "deals" | "work" | "agents"

export const SURFACES: Array<{ key: OperationalSurface; label: string; href: string }> = [
  { key: "home", label: "Home", href: "/jarvis" },
  { key: "deals", label: "Deals", href: "/jarvis/deals" },
  { key: "work", label: "Work", href: "/jarvis/work" },
  { key: "agents", label: "Agents", href: "/jarvis/agents" },
]

export const MOBILE_SURFACES = SURFACES

export function withOperationalContext(href: string, context?: PeOperatingContext): string {
  return context ? withPeOperatingContext(href, context) : href
}
