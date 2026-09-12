"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useJarvisAuth } from "../lib/jarvis-auth"
import { jarvisPost } from "../lib/api"
import { contextForInspection, inspectionHref, readInspectionTarget, readPeOperatingContext, withPeOperatingContext } from "./context-routing"
import type { CompanyBrainObjectRef, InspectionTarget, PeOperatingContext, PeWorldRootRef } from "./contracts"

type ValidationStatus = "idle" | "validating" | "valid" | "invalid"

interface PeOperatingContextState {
  context: PeOperatingContext
  inspection: InspectionTarget | null
  validationStatus: ValidationStatus
  validationError: string | null
  selectRoot: (root: PeWorldRootRef) => void
  inspect: (target: InspectionTarget, subjectRef?: CompanyBrainObjectRef) => boolean
  setWork: (workId: string | null) => void
  clearInspection: () => void
  clearContext: () => void
}

const Context = createContext<PeOperatingContextState | null>(null)

export function PeOperatingContextProvider({ children }: { children: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const { session } = useJarvisAuth()
  const context = useMemo(() => readPeOperatingContext(params), [params])
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
    void jarvisPost<{ context: PeOperatingContext }>("company-brain/context", context)
      .then(() => { if (active) setValidationStatus("valid") })
      .catch((error) => {
        if (!active) return
        setValidationStatus("invalid")
        setValidationError(error instanceof Error ? error.message : "The selected Private Equity context is unavailable.")
      })
    return () => { active = false }
  }, [context, session])

  const replaceContext = useCallback((next: PeOperatingContext, target: InspectionTarget | null = null) => {
    router.push(withPeOperatingContext(`${pathname}?${params.toString()}`, next, target), { scroll: false })
  }, [params, pathname, router])

  const selectRoot = useCallback((root: PeWorldRootRef) => {
    replaceContext({ root, selectedObject: null, workId: null })
  }, [replaceContext])

  const inspect = useCallback((target: InspectionTarget, subjectRef?: CompanyBrainObjectRef): boolean => {
    const href = inspectionHref(context, target, subjectRef)
    if (!href) return false
    router.push(href, { scroll: false })
    return true
  }, [context, router])

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
