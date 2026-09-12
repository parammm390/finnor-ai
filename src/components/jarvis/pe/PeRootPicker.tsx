"use client"

import { ArrowUpRight, CircleDot, RefreshCw } from "lucide-react"
import { usePeOperatingContext } from "./PeOperatingContextProvider"
import { humanize } from "./contracts"
import { useCompanyBrainRoots } from "./use-pe-data"
import { PeSourceState } from "./PeSurfaceFrame"

export function PeRootPicker({ compact = false }: { compact?: boolean }) {
  const roots = useCompanyBrainRoots()
  const { context, selectRoot, clearContext } = usePeOperatingContext()
  if (roots.status === "error") return <PeSourceState title="Company Brain roots unavailable" detail={roots.error ?? "The canonical root query failed."} retry={roots.reload} />
  if (roots.status === "loading" && !roots.data) return <div className="pe-root-picker pe-root-picker--loading"><span className="pe-state__pulse" /> Loading tenant-scoped PE roots…</div>
  const results = roots.data ?? []
  if (results.length === 0) return <PeSourceState title="No canonical PE roots" detail="The authenticated tenant has no Strategy, Opportunity, or Deal root. This is a known-empty result, not an inferred pipeline." retry={roots.reload} />
  return (
    <section className="pe-root-picker" data-compact={compact ? "true" : "false"} aria-label="Select Private Equity context">
      <header><span>CANONICAL CONTEXT</span><button type="button" onClick={roots.reload} aria-label="Refresh canonical roots"><RefreshCw size={13} /></button></header>
      <div className="pe-root-picker__list">
        {results.map((result) => {
          const root = result.rootRefs[0]
          if (!root) return null
          const active = context.root?.entityType === root.entityType && context.root.entityId === root.entityId
          return <button key={`${root.entityType}:${root.entityId}`} type="button" data-active={active ? "true" : "false"} onClick={() => selectRoot(root)}><CircleDot size={12} /><span><strong>{result.label}</strong><small>{humanize(root.entityType)} · {result.state ?? "state unknown"}</small></span><ArrowUpRight size={13} /></button>
        })}
      </div>
      {context.root ? <button className="pe-root-picker__clear" type="button" onClick={clearContext}>Clear current context</button> : null}
    </section>
  )
}
