"use client"

import { usePathname } from "next/navigation"
import { X } from "lucide-react"
import type { ReactNode } from "react"
import { CommandRail } from "./bridge/CommandRail"
import { useKernel } from "./kernel/store"
import { projectKernelLiveFrame } from "./kernel/liveframe"
import { useOperatingInteraction } from "./kernel/operating-interaction"
import { useJarvisAuth } from "./lib/jarvis-auth"
import { useVapiSession } from "./lib/useVapiSession"
import "./operating-canvas.css"

const OPERATING_SURFACES = new Set(["/jarvis/customers", "/jarvis/money", "/jarvis/work", "/jarvis/schedule", "/jarvis/agents"])

function short(value: string): string { return value.length > 18 ? `${value.slice(0, 12)}…` : value }

function OperatingContextBar() {
  const interaction = useOperatingInteraction()
  const focused = interaction.focusedEntity
  const selected = interaction.selectedEntities
  const hasContext = Boolean(focused || selected.length || interaction.excludedEntities.length || interaction.cohort || interaction.activeWorkId)
  if (!hasContext) return null
  const focusLabel = focused ? interaction.labels[`${focused.entityType}:${focused.entityId}`] ?? `${focused.entityType} ${short(focused.entityId)}` : null
  return (
    <aside className="pointer-events-auto fixed left-1/2 top-3 z-[72] flex max-w-[calc(100vw-1.5rem)] -translate-x-1/2 items-center gap-2 overflow-x-auto rounded-full border border-cyan-200/20 bg-[#05090f]/95 px-3 py-2 text-[11px] text-slate-300 shadow-[0_10px_36px_rgba(0,0,0,.42)] backdrop-blur-xl" aria-label="Current operating context" data-operating-context-bar>
      <span className="shrink-0 font-black uppercase tracking-[.16em] text-cyan-200">Context</span>
      {focusLabel && <span className="shrink-0 rounded-full bg-cyan-300/10 px-2 py-1 text-cyan-50" data-context-focus>{focusLabel}</span>}
      {selected.length > 0 && <span className="shrink-0 rounded-full bg-white/5 px-2 py-1" data-context-selected>{selected.length} selected</span>}
      {interaction.excludedEntities.length > 0 && <span className="shrink-0 rounded-full bg-amber-300/10 px-2 py-1 text-amber-100" data-context-excluded>{interaction.excludedEntities.length} excluded</span>}
      {interaction.cohort && <span className="shrink-0 rounded-full bg-violet-300/10 px-2 py-1 text-violet-100" data-context-cohort={interaction.cohort.executionId}>{interaction.cohort.count} in cohort</span>}
      {interaction.activeWorkId && <span className="shrink-0 rounded-full bg-white/5 px-2 py-1" data-context-work={interaction.activeWorkId}>Work {short(interaction.activeWorkId)}</span>}
      <button type="button" onClick={interaction.clearSelection} className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-slate-400 hover:bg-white/10 hover:text-white" aria-label="Clear selected operating context" title="Clear selection"><X size={13} /></button>
    </aside>
  )
}

/** One persistent interaction canvas. LIVEFRAME/Scene Director remain derived
 * presentation; the kernel and operating context stay mounted across routes. */
export function OperatingCanvas({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const auth = useJarvisAuth()
  const kernel = useKernel()
  const voice = useVapiSession()
  const showPersistentRail = Boolean(auth.session && auth.role === "owner" && OPERATING_SURFACES.has(pathname))
  const liveframe = projectKernelLiveFrame(kernel, voice.localVolumeLevel)
  return (
    <div data-operating-canvas data-operating-surface={pathname} data-operating-persistent-rail={showPersistentRail ? "true" : undefined}>
      {children}
      {auth.session && <OperatingContextBar />}
      {showPersistentRail && <CommandRail liveframe={liveframe} />}
    </div>
  )
}
