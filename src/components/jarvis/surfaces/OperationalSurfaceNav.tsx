"use client"

import Link from "next/link"
import { BriefcaseBusiness, Bot, BrainCircuit, Home, Workflow } from "lucide-react"
import { WorkspaceSettingsButton, useWorkspaceConfig } from "../WorkspaceConfigProvider"
import { useJarvisAuth } from "../lib/jarvis-auth"
import { orderedWorkspaceItems } from "../lib/workspace-config"
import { usePeOperatingContext } from "../pe/PeOperatingContextProvider"
import { humanize, type PeOperatingContext } from "../pe/contracts"
import { SURFACES, withOperationalContext, type OperationalSurface } from "./surface-routes"

export type { OperationalSurface } from "./surface-routes"
export { MOBILE_SURFACES, SURFACES, withOperationalContext } from "./surface-routes"

const ICONS = {
  home: Home,
  deals: BriefcaseBusiness,
  work: Workflow,
  agents: Bot,
} satisfies Record<OperationalSurface, typeof Home>

function ContextCapsule({ context }: { context: PeOperatingContext }) {
  if (!context.root) return null
  const selected = context.selectedObject
  return (
    <span className="pe-context-capsule" data-pe-context-capsule data-root-type={context.root.entityType}>
      <BrainCircuit size={13} aria-hidden />
      <span>
        <b>{selected ? humanize(selected.type) : humanize(context.root.entityType)}</b>
        <small>{(selected?.id ?? context.root.entityId).slice(0, 8)}…{context.workId ? ` · Work ${context.workId.slice(0, 8)}…` : ""}</small>
      </span>
    </span>
  )
}

export function OperationalSurfaceNav({ active, context: contextOverride }: { active: OperationalSurface; context?: PeOperatingContext }) {
  const { config } = useWorkspaceConfig()
  const { role } = useJarvisAuth()
  const operating = usePeOperatingContext()
  const context = contextOverride ?? operating.context
  const surfaces = orderedWorkspaceItems(SURFACES, config, role === "owner" ? "owner" : undefined)

  return (
    <header className="pe-nav" data-jarvis-surface-nav>
      <Link className="pe-nav__brand" href={withOperationalContext("/jarvis", context)} prefetch={false} aria-label="FINNOR JARVIS home">
        <span className="pe-nav__mark" aria-hidden>F</span>
        <span>FINNOR <b>JARVIS</b></span>
      </Link>
      <nav className="pe-nav__links" aria-label="Private Equity operating surfaces">
        {surfaces.map((surface) => {
          const Icon = ICONS[surface.key]
          return (
            <Link key={surface.key} href={withOperationalContext(surface.href, context)} prefetch={false} data-active={active === surface.key ? "true" : "false"} aria-current={active === surface.key ? "page" : undefined}>
              <Icon size={14} aria-hidden />
              <span>{config.terminology[surface.key]}</span>
            </Link>
          )
        })}
      </nav>
      <div className="pe-nav__context"><ContextCapsule context={context} /><WorkspaceSettingsButton compact /></div>
    </header>
  )
}
