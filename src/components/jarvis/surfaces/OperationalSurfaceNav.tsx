"use client"

import Link from "next/link"
import { Bot, BriefcaseBusiness, Home, Workflow } from "lucide-react"
import { useWorkspaceConfig } from "../WorkspaceConfigProvider"
import { useJarvisAuth } from "../lib/jarvis-auth"
import { orderedWorkspaceItems } from "../lib/workspace-config"
import { usePeOperatingContext } from "../pe/PeOperatingContextProvider"
import type { PeOperatingContext } from "../pe/contracts"
import { SURFACES, withOperationalContext, type OperationalSurface } from "./surface-routes"

export type { OperationalSurface } from "./surface-routes"
export { MOBILE_SURFACES, SURFACES, withOperationalContext } from "./surface-routes"

const ICONS = {
  home: Home,
  deals: BriefcaseBusiness,
  work: Workflow,
  agents: Bot,
} satisfies Record<OperationalSurface, typeof Home>

export function OperationalSurfaceNav({ active, context: contextOverride }: { active: OperationalSurface; context?: PeOperatingContext }) {
  const { config } = useWorkspaceConfig()
  const { role } = useJarvisAuth()
  const operating = usePeOperatingContext()
  const context = contextOverride ?? operating.context
  const surfaces = orderedWorkspaceItems(SURFACES, config, role === "owner" ? "owner" : undefined)

  return <nav className="pw-primary-nav" aria-label="Private Equity operating surfaces">
    {surfaces.map((surface) => {
      const Icon = ICONS[surface.key]
      const label = config.terminology[surface.key]
      return <Link key={surface.key} href={withOperationalContext(surface.href, context)} aria-label={label} data-active={active === surface.key ? "true" : "false"} aria-current={active === surface.key ? "page" : undefined}><Icon size={15} aria-hidden /><span>{label}</span></Link>
    })}
  </nav>
}
