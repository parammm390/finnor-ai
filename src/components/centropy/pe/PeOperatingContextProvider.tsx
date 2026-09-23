"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useCentropyAuth } from "../lib/centropy-auth"
import { centropyPost } from "../lib/api"
import { contextForInspection, inspectionHref, readInspectionTarget, readPeOperatingContext, rootFromDealPath, withPeOperatingContext } from "./context-routing"
import type { CompanyBrainObjectRef, InspectionTarget, PeOperatingContext, PeWorldRootRef } from "./contracts"

type ValidationStatus = "idle" | "validating" | "valid" | "invalid"

interface PeOperatingContextState {
  context: PeOperatingContext
  inspection: InspectionTarget | null
  validationStatus: ValidationStatus
  validationError: string | null
  selectRoot: (root: PeWorldRootRef) => void
  inspect: (target: InspectionTarget, subjectRef?: CompanyBrainObjectRef, rootOverride?: PeWorldRootRef) => boolean
  setWork: (workId: string | null) => void
  clearInspection: () => void
  clearContext: () => void
}

const Context = createContext<PeOperatingContextState | null>(null)

export function PeOperatingContextProvider({ children }: { children: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const { session } = useCentropyAuth()
  const context = useMemo(() => {
    const fromQuery = readPeOperatingContext(params)
    const fromPath = rootFromDealPath(pathname)
    if (!fromPath) return fromQuery
    const sameRoot = fromQuery.root?.entityType === fromPath.entityType && fromQuery.root.entityId === fromPath.entityId
    return {
      root: fromPath,
      selectedObject: sameRoot ? fromQuery.selectedObject : null,
      workId: sameRoot ? fromQuery.workId : null,
    }
  }, [params, pathname])
  const inspection = useMemo(() => readInspectionTarget(params), [params])
  const [validationStatus, setValidationStatus] = useState<ValidationStatus>("idle")
  const [validationError, setValidationError] = useState<string | null>(null)

  useEffect(() => {
    if (!session || !context.root) {
      setValidationStatus("idle")
      setValidationError(null)
      return
    }
    let active = true
    setValidationStatus("validating")
    setValidationError(null)
    void centropyPost<{ context: PeOperatingContext }>("company-brain/context", context)
      .then(() => { if (active) setValidationStatus("valid") })
      .catch((error) => {
        if (!active) return
        setValidationStatus("invalid")
        setValidationError(error instanceof Error ? error.message : "The selected Private Equity context is unavailable.")
      })
    return () => { active = false }
  }, [context, session])

  const replaceContext = useCallback((next: PeOperatingContext, target: InspectionTarget | null = null, path = pathname) => {
    const href = withPeOperatingContext(`${path}?${params.toString()}`, next, target)
    // Root/object/Work/Inspector selection is URL state, not a new server page.
    // Commit same-path transitions synchronously so a rapid close-then-open cannot
    // let an older async flight response erase the newer InspectionTarget. Next's
    // native-history integration keeps useSearchParams and browser back/forward in
    // sync while the mounted shell and providers remain intact.
    if (typeof window !== "undefined" && path === pathname) window.history.pushState(null, "", href)
    else router.push(href, { scroll: false })
  }, [params, pathname, router])

  const selectRoot = useCallback((root: PeWorldRootRef) => {
    const path = pathname.startsWith("/centropy/deals/") && root.entityType === "pe_deal"
      ? `/centropy/deals/${root.entityId}/overview`
      : pathname.startsWith("/centropy/deals/") ? "/centropy/deals" : pathname
    replaceContext({ root, selectedObject: null, workId: null }, null, path)
  }, [pathname, replaceContext])

  const inspect = useCallback((target: InspectionTarget, subjectRef?: CompanyBrainObjectRef, rootOverride?: PeWorldRootRef): boolean => {
    const rootChanged = rootOverride && (context.root?.entityType !== rootOverride.entityType || context.root.entityId !== rootOverride.entityId)
    const base = rootOverride
      ? { root: rootOverride, selectedObject: rootChanged ? null : context.selectedObject, workId: rootChanged ? null : context.workId }
      : context
    const href = inspectionHref(base, target, subjectRef, pathname)
    if (!href) return false
    const nextPathname = new URL(href, window.location.href).pathname
    if (nextPathname === pathname) window.history.pushState(null, "", href)
    else router.push(href, { scroll: false })
    return true
  }, [context, pathname, router])

  const setWork = useCallback((workId: string | null) => {
    replaceContext({ ...context, workId })
  }, [context, replaceContext])

  const clearInspection = useCallback(() => replaceContext(context), [context, replaceContext])
  const clearContext = useCallback(() => replaceContext({ root: null, selectedObject: null, workId: null }), [replaceContext])
  const value = useMemo<PeOperatingContextState>(() => ({
    context,
    inspection,
    validationStatus,
    validationError,
    selectRoot,
    inspect,
    setWork,
    clearInspection,
    clearContext,
  }), [clearContext, clearInspection, context, inspect, inspection, selectRoot, setWork, validationError, validationStatus])

  return <Context.Provider value={value}>{children}</Context.Provider>
}

export function usePeOperatingContext(): PeOperatingContextState {
  const value = useContext(Context)
  if (!value) throw new Error("usePeOperatingContext must be used inside PeOperatingContextProvider")
  return value
}

export function contextForTarget(context: PeOperatingContext, target: InspectionTarget, subjectRef?: CompanyBrainObjectRef): PeOperatingContext {
  return contextForInspection(context, target, subjectRef)
}
