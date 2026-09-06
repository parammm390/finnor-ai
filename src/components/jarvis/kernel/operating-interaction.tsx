"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { usePathname } from "next/navigation"

export type OperatingEntityType =
  | "household" | "contact" | "user" | "technician" | "equipment" | "service_visit"
  | "maintenance_agreement" | "lead" | "opportunity" | "quote" | "proposal" | "work_order"
  | "appointment" | "invoice" | "payment" | "conversation" | "call" | "message" | "communication"
  | "document" | "task" | "work" | "domain_action" | "workflow_run" | "workflow_step"
  | "business_operation" | "business_operation_target" | "decision_receipt" | "business_event"
  | "org_unit" | "tenant_location" | "external_organization" | "external_contact" | "delegation"
  | "acknowledgement_request" | "communication_delivery" | "internal_event" | "document_share"
  | "inventory_item" | "computer_run"

export interface OperatingEntityRef { entityType: OperatingEntityType; entityId: string }
export interface OperatingInteractionContextValue {
  version: 1
  capturedAt: string
  source: "voice" | "text" | "console"
  activeWork?: { workId: string }
  focusedEntity?: OperatingEntityRef
  selectedEntities: OperatingEntityRef[]
  excludedEntities: OperatingEntityRef[]
  surface: {
    id: "home" | "customers" | "money" | "work" | "schedule" | "agents"
    route?: string
    spatialState?: "canvas" | "detail" | "list" | "map" | "timeline"
  }
  filters: Array<{ field: string; operator: "eq" | "neq" | "in" | "not_in" | "gte" | "lte" | "contains"; value: string | number | boolean | string[] }>
  timeContext?: { start?: string; end?: string; timezone?: string }
  cohort?: { kind: "work_query_execution"; executionId: string; entityType: "household"; queryIntent: "customer_cohort"; count: number }
}

type Surface = OperatingInteractionContextValue["surface"]
type Filter = OperatingInteractionContextValue["filters"][number]
type Cohort = NonNullable<OperatingInteractionContextValue["cohort"]>

interface InteractionState {
  activeWorkId: string | null
  focusedEntity: OperatingEntityRef | null
  selectedEntities: OperatingEntityRef[]
  excludedEntities: OperatingEntityRef[]
  surface: Surface
  filters: Filter[]
  timeContext: OperatingInteractionContextValue["timeContext"]
  cohort: Cohort | null
  labels: Record<string, string>
}

interface OperatingInteractionState extends InteractionState {
  focusEntity: (ref: OperatingEntityRef, label?: string) => void
  toggleEntity: (ref: OperatingEntityRef, label?: string) => void
  excludeEntity: (ref: OperatingEntityRef, excluded?: boolean, label?: string) => void
  setSurface: (surface: Surface) => void
  setFilters: (filters: Filter[]) => void
  setTimeContext: (timeContext: InteractionState["timeContext"]) => void
  setCohort: (cohort: Cohort | null) => void
  clearSelection: () => void
  beginUnrelatedWork: () => void
  bindWork: (workId: string | null) => void
  restore: (context: OperatingInteractionContextValue | null, workId?: string | null) => void
  capture: (source: "voice" | "typed", continuingWorkId?: string | null) => OperatingInteractionContextValue
}

const EMPTY: InteractionState = {
  activeWorkId: null,
  focusedEntity: null,
  selectedEntities: [],
  excludedEntities: [],
  surface: { id: "home", route: "/jarvis", spatialState: "canvas" },
  filters: [],
  timeContext: undefined,
  cohort: null,
  labels: {},
}

const OperatingInteractionContext = createContext<OperatingInteractionState | null>(null)
type OperatingInteractionActions = Omit<OperatingInteractionState, keyof InteractionState>
const OperatingInteractionActionsContext = createContext<OperatingInteractionActions | null>(null)

function refKey(ref: OperatingEntityRef): string { return `${ref.entityType}:${ref.entityId}` }
function unique(refs: OperatingEntityRef[]): OperatingEntityRef[] { return [...new Map(refs.map((ref) => [refKey(ref), ref])).values()] }
function routeSurface(pathname: string): Surface["id"] {
  if (pathname.startsWith("/jarvis/customers")) return "customers"
  if (pathname.startsWith("/jarvis/money")) return "money"
  if (pathname.startsWith("/jarvis/work")) return "work"
  if (pathname.startsWith("/jarvis/schedule")) return "schedule"
  if (pathname.startsWith("/jarvis/agents")) return "agents"
  return "home"
}

function exactDeepLink(pathname: string): OperatingEntityRef | null {
  if (typeof window === "undefined") return null
  const params = new URLSearchParams(window.location.search)
  const candidates: Array<[string, OperatingEntityType]> = pathname.startsWith("/jarvis/customers")
    ? [["householdId", "household"]]
    : pathname.startsWith("/jarvis/money")
      ? [["invoiceId", "invoice"]]
      : pathname.startsWith("/jarvis/work")
        ? [["workCaseId", "work"]]
        : pathname.startsWith("/jarvis/schedule")
          ? [["visitId", "service_visit"], ["appointmentId", "appointment"]]
          : []
  for (const [name, entityType] of candidates) {
    const entityId = params.get(name)
    if (entityId) return { entityType, entityId }
  }
  return null
}

export function OperatingInteractionProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const [state, setState] = useState<InteractionState>(EMPTY)
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(() => {
    const focusedEntity = exactDeepLink(pathname)
    setState((current) => ({
      ...current,
      focusedEntity: focusedEntity ?? current.focusedEntity,
      surface: { ...current.surface, id: routeSurface(pathname), route: pathname },
    }))
  }, [pathname])

  const remember = useCallback((labels: Record<string, string>, ref: OperatingEntityRef, label?: string) => label ? { ...labels, [refKey(ref)]: label } : labels, [])
  const focusEntity = useCallback((ref: OperatingEntityRef, label?: string) => setState((current) => ({ ...current, focusedEntity: ref, labels: remember(current.labels, ref, label) })), [remember])
  const toggleEntity = useCallback((ref: OperatingEntityRef, label?: string) => setState((current) => {
    const exists = current.selectedEntities.some((item) => refKey(item) === refKey(ref))
    return {
      ...current,
      focusedEntity: ref,
      selectedEntities: exists ? current.selectedEntities.filter((item) => refKey(item) !== refKey(ref)) : unique([...current.selectedEntities, ref]).slice(0, 50),
      excludedEntities: current.excludedEntities.filter((item) => refKey(item) !== refKey(ref)),
      labels: remember(current.labels, ref, label),
    }
  }), [remember])
  const excludeEntity = useCallback((ref: OperatingEntityRef, excluded = true, label?: string) => setState((current) => ({
    ...current,
    excludedEntities: excluded ? unique([...current.excludedEntities, ref]).slice(0, 50) : current.excludedEntities.filter((item) => refKey(item) !== refKey(ref)),
    focusedEntity: current.focusedEntity && refKey(current.focusedEntity) === refKey(ref) ? null : current.focusedEntity,
    labels: remember(current.labels, ref, label),
  })), [remember])
  const setSurface = useCallback((surface: Surface) => setState((current) => ({ ...current, surface })), [])
  const setFilters = useCallback((filters: Filter[]) => setState((current) => ({ ...current, filters: filters.slice(0, 20) })), [])
  const setTimeContext = useCallback((timeContext: InteractionState["timeContext"]) => setState((current) => ({ ...current, timeContext })), [])
  const setCohort = useCallback((cohort: Cohort | null) => setState((current) => ({ ...current, cohort })), [])
  const clearSelection = useCallback(() => setState((current) => ({ ...current, focusedEntity: null, selectedEntities: [], excludedEntities: [], cohort: null, labels: {} })), [])
  const beginUnrelatedWork = useCallback(() => setState((current) => ({ ...current, activeWorkId: null, focusedEntity: null, selectedEntities: [], excludedEntities: [], filters: [], timeContext: undefined, cohort: null, labels: {} })), [])
  const bindWork = useCallback((workId: string | null) => setState((current) => ({ ...current, activeWorkId: workId })), [])
  const restore = useCallback((context: OperatingInteractionContextValue | null, workId?: string | null) => {
    if (!context || context.version !== 1) return
    const currentPath = typeof window === "undefined" ? null : window.location.pathname
    const deepLink = currentPath ? exactDeepLink(currentPath) : null
    const deepLinkMatchesSelection = Boolean(deepLink && context.selectedEntities.some((ref) => refKey(ref) === refKey(deepLink)))
    setState((current) => ({
      ...current,
      activeWorkId: workId ?? context.activeWork?.workId ?? null,
      focusedEntity: deepLink ?? context.focusedEntity ?? null,
      selectedEntities: deepLink && !deepLinkMatchesSelection ? [] : unique(context.selectedEntities ?? []),
      excludedEntities: deepLink && !deepLinkMatchesSelection ? [] : unique(context.excludedEntities ?? []),
      surface: currentPath ? { ...context.surface, id: routeSurface(currentPath), route: currentPath } : context.surface,
      filters: context.filters ?? [],
      timeContext: context.timeContext,
      cohort: deepLink && !deepLinkMatchesSelection ? null : context.cohort ?? null,
    }))
  }, [])
  const capture = useCallback((source: "voice" | "typed", continuingWorkId?: string | null): OperatingInteractionContextValue => ({
    version: 1,
    capturedAt: new Date().toISOString(),
    source: source === "typed" ? "text" : "voice",
    ...(continuingWorkId ? { activeWork: { workId: continuingWorkId } } : {}),
    ...(stateRef.current.focusedEntity ? { focusedEntity: stateRef.current.focusedEntity } : {}),
    selectedEntities: stateRef.current.selectedEntities,
    excludedEntities: stateRef.current.excludedEntities,
    surface: stateRef.current.surface,
    filters: stateRef.current.filters,
    ...(stateRef.current.timeContext ? { timeContext: stateRef.current.timeContext } : {}),
    ...(stateRef.current.cohort ? { cohort: stateRef.current.cohort } : {}),
  }), [])

  const actions = useMemo<OperatingInteractionActions>(() => ({
    focusEntity, toggleEntity, excludeEntity, setSurface, setFilters, setTimeContext, setCohort,
    clearSelection, beginUnrelatedWork, bindWork, restore, capture,
  }), [focusEntity, toggleEntity, excludeEntity, setSurface, setFilters, setTimeContext, setCohort, clearSelection, beginUnrelatedWork, bindWork, restore, capture])
  const value = useMemo<OperatingInteractionState>(() => ({ ...state, ...actions }), [actions, state])
  return <OperatingInteractionActionsContext.Provider value={actions}><OperatingInteractionContext.Provider value={value}>{children}</OperatingInteractionContext.Provider></OperatingInteractionActionsContext.Provider>
}

export function useOperatingInteractionActions(): OperatingInteractionActions {
  const context = useContext(OperatingInteractionActionsContext)
  if (!context) throw new Error("useOperatingInteractionActions() called outside <OperatingInteractionProvider>")
  return context
}

export function useOperatingInteraction(): OperatingInteractionState {
  const context = useContext(OperatingInteractionContext)
  if (!context) throw new Error("useOperatingInteraction() called outside <OperatingInteractionProvider>")
  return context
}

export function operatingInteractionFromWorkAggregate(value: unknown): OperatingInteractionContextValue | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const root = value as Record<string, unknown>
  const work = root.work && typeof root.work === "object" && !Array.isArray(root.work) ? root.work as Record<string, unknown> : null
  const context = work?.activeContext
  if (!context || typeof context !== "object" || Array.isArray(context) || (context as { version?: unknown }).version !== 1) return null
  return context as OperatingInteractionContextValue
}
