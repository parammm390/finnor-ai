"use client"

import { createContext, useContext, useMemo, type ReactNode } from "react"
import { usePeOperatingContext } from "../pe/PeOperatingContextProvider"
import { useAttentionQueue, useCompanyBrainProjection, useCompanyBrainRoots, useSemanticActivity, useWorkforceStatus } from "../pe/use-pe-data"
import type { PeProductData, ProductResource } from "./contracts"
import type { SourceHealthSnapshot } from "./source-health"

function source<T>(key: string, label: string, resource: ProductResource<T>, detail: string): SourceHealthSnapshot {
  return {
    key,
    label,
    state: resource.truthState,
    detail: resource.error ?? detail,
    lastConfirmedAt: resource.lastConfirmedAt,
  }
}

const Context = createContext<PeProductData | null>(null)

export function PeProductDataProvider({ children }: { children: ReactNode }) {
  const operating = usePeOperatingContext()
  const roots = useCompanyBrainRoots()
  const brain = useCompanyBrainProjection(operating.context.root)
  const activity = useSemanticActivity(operating.context.root)
  const workforce = useWorkforceStatus(Boolean(operating.context.root))
  const attention = useAttentionQueue()

  const sources = useMemo<SourceHealthSnapshot[]>(() => {
    const values = [
      source("roots", "PE roots", roots, roots.data ? `${roots.data.length} authenticated root${roots.data.length === 1 ? "" : "s"}` : "Root discovery has not confirmed data."),
      source("attention", "Firm attention", attention, attention.data ? `${attention.data.items.length} server-ranked condition${attention.data.items.length === 1 ? "" : "s"}` : "Attention has not confirmed data."),
    ]
    if (operating.context.root) {
      values.push(
        source("brain", "Company Brain", brain, brain.data ? `${brain.data.nodes.length} objects · ${brain.data.edges.length} persisted edges` : "The active root has not confirmed a projection."),
        source("activity", "Semantic Activity", activity, activity.data ? `${activity.data.items.length} causal events` : "The active root has not confirmed Activity."),
        source("workforce", "Governed workforce", workforce, workforce.data ? `${workforce.data.workers.length} configured workers` : "The active root has not confirmed workforce state."),
      )
    }
    return values
  }, [activity, attention, brain, operating.context.root, roots, workforce])

  const value = useMemo<PeProductData>(() => ({
    sources,
    roots,
    brain,
    activity,
    workforce,
    attention,
    refreshAll: () => {
      roots.reload()
      attention.reload()
      if (operating.context.root) {
        brain.reload()
        activity.reload()
        workforce.reload()
      }
    },
  }), [activity, attention, brain, operating.context.root, roots, sources, workforce])

  return <Context.Provider value={value}>{children}</Context.Provider>
}

export function usePeProductData(): PeProductData {
  const value = useContext(Context)
  if (!value) throw new Error("usePeProductData must be used inside PeProductDataProvider")
  return value
}
