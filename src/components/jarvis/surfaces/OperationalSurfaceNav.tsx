"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { ChevronUp, MoreHorizontal, X } from "lucide-react"
import {
  SURFACES,
  withHouseholdContext,
  withOperationalContext,
  type HouseholdContext,
  type OperationalSurface,
} from "./surface-routes"
import { WorkspaceSettingsButton, useWorkspaceConfig } from "../WorkspaceConfigProvider"
import { orderedWorkspaceItems } from "../lib/workspace-config"
import { useJarvisAuth } from "../lib/jarvis-auth"
import { TenantBrandMark } from "../experience/TenantBrandMark"
import type { ExperienceRole } from "../lib/workspace-config"

export type { HouseholdContext, OperationalSurface } from "./surface-routes"
export { MOBILE_SURFACES, SURFACES, withHouseholdContext, withOperationalContext } from "./surface-routes"

export function OperationalSurfaceNav({ active, context, workCaseId, roleOverride }: { active: OperationalSurface; context?: HouseholdContext; workCaseId?: string | null; roleOverride?: ExperienceRole }) {
  const { config } = useWorkspaceConfig()
  const { role } = useJarvisAuth()
  const [moreOpen, setMoreOpen] = useState(false)
  const moreButtonRef = useRef<HTMLButtonElement>(null)
  const moreCloseRef = useRef<HTMLButtonElement>(null)
  const moreActive = active === "customers" || active === "agents"
  const surfaces = orderedWorkspaceItems(SURFACES, config, roleOverride ?? role ?? undefined)
  const mobileSurfaces = surfaces.filter((surface) => surface.key !== "customers" && surface.key !== "agents")
  const moreSurfaces = surfaces.filter((surface) => surface.key === "customers" || surface.key === "agents")

  useEffect(() => {
    if (!moreOpen) return
    const focusFrame = window.requestAnimationFrame(() => moreCloseRef.current?.focus({ preventScroll: true }))
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      setMoreOpen(false)
      window.requestAnimationFrame(() => moreButtonRef.current?.focus({ preventScroll: true }))
    }
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [moreOpen])

  return (
    <header className="jarvis-surface-nav" data-jarvis-surface-nav data-more-open={moreOpen ? "true" : "false"}>
      <Link className="jarvis-surface-nav__brand" href={withOperationalContext("/jarvis", context, workCaseId)} prefetch={false} aria-label="FINNOR JARVIS home">
        <b><TenantBrandMark size={24} /></b> FINNOR <span>JARVIS</span>
      </Link>
      <nav className="jarvis-surface-nav__links" aria-label="Operational surfaces">
        {surfaces.map((surface) => (
          <Link
            key={surface.key}
            href={withOperationalContext(surface.href, context, workCaseId)}
            prefetch={false}
            className="jarvis-surface-nav__link"
            data-active={active === surface.key ? "true" : "false"}
            aria-current={active === surface.key ? "page" : undefined}
          >
            {config.terminology[surface.key]}
          </Link>
        ))}
      </nav>
      <nav className="jarvis-surface-nav__mobile-links" aria-label="Mobile operational surfaces">
        {mobileSurfaces.map((surface) => (
          <Link
            key={surface.key}
            href={withOperationalContext(surface.href, context, workCaseId)}
            prefetch={false}
            className="jarvis-surface-nav__mobile-link"
            data-active={active === surface.key ? "true" : "false"}
            aria-current={active === surface.key ? "page" : undefined}
          >
            {config.terminology[surface.key]}
          </Link>
        ))}
        {moreSurfaces.length > 0 && <button ref={moreButtonRef} type="button" className="jarvis-surface-nav__mobile-link jarvis-surface-nav__more-button" data-active={moreOpen || moreActive ? "true" : "false"} aria-expanded={moreOpen} aria-controls="jarvis-more-surfaces" onClick={() => setMoreOpen((open) => !open)}>
          <MoreHorizontal size={14} aria-hidden />
          More
          {moreOpen ? <ChevronUp size={12} aria-hidden /> : null}
        </button>}
      </nav>
      {moreOpen ? (
        <div id="jarvis-more-surfaces" className="jarvis-surface-nav__more-sheet" role="dialog" aria-label="More JARVIS surfaces">
          <div className="jarvis-surface-nav__more-heading"><span>MORE</span><button ref={moreCloseRef} type="button" onClick={() => setMoreOpen(false)} aria-label="Close more surfaces"><X size={15} /></button></div>
          {moreSurfaces.map((surface) => <Link key={surface.key} href={withOperationalContext(surface.href, context, workCaseId)} prefetch={false} onClick={() => setMoreOpen(false)}>{config.terminology[surface.key]}</Link>)}
          <Link href={withOperationalContext("/jarvis#jarvis-diagnostics", context, workCaseId)} prefetch={false} onClick={() => setMoreOpen(false)}>Diagnostics</Link>
        </div>
      ) : null}
      <WorkspaceSettingsButton compact />
      {context ? (
        <span className="jarvis-context-capsule" data-jarvis-context-capsule data-context-household-id={context.id}>
          <span className="jarvis-context-capsule__eyebrow">Context</span>
          <span className="jarvis-context-capsule__label">{context.label}</span>
          <span className="jarvis-context-capsule__id">{context.id.slice(0, 8)}…</span>
        </span>
      ) : null}
    </header>
  )
}
