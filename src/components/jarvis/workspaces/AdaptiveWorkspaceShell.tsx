"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import Link from "next/link"
import { useGSAP } from "@gsap/react"
import gsap from "gsap"
import {
  ArrowUpRight,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  Clock3,
  ExternalLink,
  FileCheck2,
  History,
  ListFilter,
  PanelRight,
  Search,
  ShieldAlert,
  Sparkles,
  UsersRound,
  Workflow,
  Wrench,
} from "lucide-react"
import type { JarvisRole } from "../lib/jarvis-auth"
import type { Thread } from "../kernel/store"
import type { LiveFrameProjection } from "../kernel/liveframe"
import { useOperatingInteractionActions } from "../kernel/operating-interaction"
import { ActionRenderer } from "../ui/renderers/ActionRenderer"
import { ApprovalCockpit } from "../bridge/ApprovalCockpit"
import { ThreadClarify, ThreadExecution, ThreadReceipt } from "../bridge/ThreadBlocks"
import { projectThreadWorkspace } from "./projector"
import { useBusinessProjection } from "../lib/business-projections"
import { businessProjections } from "../lib/projection-definitions"
import type {
  AgentActivityResult,
  BusinessStateResult,
  CompanyContextResult,
  CustomerCohortResult,
  CustomerLookupResult,
  InventoryStatusResult,
  MoneySummaryResult,
  OperationalQueryResult,
  ScheduleRangeResult,
  WorkListResult,
  WorkspaceProjection,
  OperationalQueryExecution,
} from "./contracts"
import { projectRestingAttention, restingAttentionPresentation, type RestingAttentionItem } from "./resting-attention"
import { withOperationalContext } from "../surfaces/surface-routes"
import { buildWorkspaceInspector, groupWorkspaceInspector, type WorkspaceInspectorItem } from "./workspace-inspector"
import { deriveWorkspaceProgress, splitResearchNarrative } from "./presentation"
import { WorkspaceSettingsButton, useWorkspaceConfig } from "../WorkspaceConfigProvider"
import { effectiveMotionPreference, inspectorFieldVisible, orderedWorkspaceItems, sceneSlot } from "../lib/workspace-config"
import { deriveSceneDirector } from "../kernel/scene-director"
import { TenantReadyExperience } from "../experience/TenantReadyExperience"
import { ExperienceSlot } from "../experience/extension-registry"
import { TenantBrandMark } from "../experience/TenantBrandMark"

gsap.registerPlugin(useGSAP)

type InspectorItem = WorkspaceInspectorItem

const NAV = [
  { key: "home", href: "/jarvis", icon: Sparkles },
  { key: "work", href: "/jarvis/work", icon: Wrench },
  { key: "customers", href: "/jarvis/customers", icon: UsersRound },
  { key: "schedule", href: "/jarvis/schedule", icon: CalendarDays },
  { key: "money", href: "/jarvis/money", icon: CircleDollarSign },
  { key: "agents", href: "/jarvis/agents", icon: Workflow },
] as const

const EMPTY_QUERY_EXECUTION: OperationalQueryExecution = {
  request: { intent: "business_state" },
  result: {
    kind: "operational_query_result",
    version: 1,
    intent: "business_state",
    status: "not_found",
    source: { kind: "canonical_postgres", tables: [] },
    asOf: "1970-01-01T00:00:00.000Z",
    count: 0,
    truncated: false,
    page: { limit: 0, returned: 0, totalCount: null, totalCountExact: false, hasMore: false, nextCursor: null, truncated: false },
    data: {},
    pipeline: {},
    operations: {},
  },
  metadata: { queryId: "unselected", source: "none", durationMs: 0, startedAt: "1970-01-01T00:00:00.000Z", completedAt: "1970-01-01T00:00:00.000Z" },
}

function humanize(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase())
}

function money(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value)
}

function dateTime(value: string, timeZone?: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  }).format(parsed)
}

function dateOnly(value: string, timeZone?: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", ...(timeZone ? { timeZone } : {}) }).format(parsed)
}

function stateLabel(state: WorkspaceProjection["state"]): string {
  if (state === "awaiting_approval") return "Needs your approval"
  if (state === "executing") return "Working"
  if (state === "verifying") return "Verifying outcome"
  if (state === "completed") return "Complete"
  if (state === "partial") return "Partially complete"
  if (state === "failed") return "Needs recovery"
  if (state === "clarifying") return "Needs one detail"
  if (state === "understanding" || state === "planning") return "Preparing workspace"
  return humanize(state)
}

function EmptyWorkspace() {
  return (
    <section className="jarvis-workspace-empty" data-workspace-kind="plan">
      <div>
        <span className="jarvis-workspace-empty__line" aria-hidden />
        <p>Start with the outcome, not the app.</p>
        <h1>What needs to move?</h1>
        <p className="jarvis-workspace-empty__copy">Ask about a customer, inspect a cohort, open a schedule range, review money, research a question, or direct operational work.</p>
      </div>
      <div className="jarvis-workspace-empty__examples" aria-label="Example instructions">
        <span>Show customers inactive for 90 days</span>
        <span>What is on tomorrow&apos;s schedule?</span>
        <span>Collect the overdue invoices</span>
      </div>
    </section>
  )
}

function WorkspaceProgress({ thread, liveframe }: { thread: Thread; liveframe: LiveFrameProjection }) {
  const model = deriveWorkspaceProgress({
    state: thread.machine.instructionState,
    actionCount: thread.nodes.length,
    expectedActionCount: thread.traceGating.expectedCount,
    contextCount: thread.contextChips.length,
    hasCanonicalQuery: Boolean(thread.answerResult?.query),
    hasExternalEvidence: thread.progress?.sourceKind === "WEB" || Boolean(thread.answerResult?.evidence?.some((item) => /^https?:\/\//i.test(item.ref) || /web|research/i.test(item.source))),
    progress: thread.progress,
    transportPosture: liveframe.transportPosture,
  })
  const statusText = liveframe.transportPosture === "healthy" ? "Live trace" : liveframe.transportPosture === "degraded" ? "Trace delayed" : "Trace offline"

  return (
    <section className="jarvis-workspace-progress" data-workspace-progress data-progress-stage={model.activeStage} data-progress-transport={liveframe.transportPosture} aria-live="polite">
      <header>
        <div>
          <span className="jarvis-workspace-progress__eyebrow"><i aria-hidden /> {statusText}</span>
          <h2>{model.activeLabel}</h2>
          <p>{model.detail}</p>
        </div>
        <span className="jarvis-workspace-progress__work-id">Work {thread.workId ? `${thread.workId.slice(0, 12)}…` : "pending"}</span>
      </header>
      <ol aria-label="Live Work progress">
        {model.steps.map((step) => (
          <li key={step.key} data-progress-status={step.status}>
            <span className="jarvis-workspace-progress__step-dot" aria-hidden />
            <span>{step.label}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}

function attentionInspector(item: RestingAttentionItem): InspectorItem[] {
  return [
    { label: "What you are looking at", value: `${item.eyebrow} · ${item.workCase.title}` },
    { label: "Why now", value: item.reason },
    { label: "Next permitted action", value: item.nextAction },
    { label: "Expected change", value: item.expectedChange },
    { label: "Authority", value: item.authority },
    { label: "Closing evidence", value: item.evidence },
    { label: "Supporting sources", value: item.source },
    { label: "Updated", value: dateTime(item.workCase.updatedAt) },
    { label: "Durable Work", value: item.workCase.id, href: item.href },
  ]
}

function RestingWorkspace({
  items,
  loading,
  error,
  stale,
  onRetry,
  onInspect,
}: {
  items: RestingAttentionItem[]
  loading: boolean
  error: string | null
  stale: boolean
  onRetry: () => void
  onInspect: (items: InspectorItem[]) => void
}) {
  const [selectedId, setSelectedId] = useState<string | null>(items[0]?.workCase.id ?? null)
  const selected = items.find((item) => item.workCase.id === selectedId) ?? items[0] ?? null
  const presentation = restingAttentionPresentation({ itemCount: items.length, loading, error, stale })

  useEffect(() => {
    if (!selected) return
    if (selectedId !== selected.workCase.id) setSelectedId(selected.workCase.id)
    onInspect(attentionInspector(selected))
  }, [onInspect, selected, selectedId])

  return (
    <section className="jarvis-resting-workspace" aria-labelledby="jarvis-attention-title" data-resting-attention-count={items.length}>
      <header className="jarvis-resting-workspace__header">
        <div>
          <span className="jarvis-resting-workspace__eyebrow"><i aria-hidden /> Operational attention</span>
          <h2 id="jarvis-attention-title">{presentation.heading}</h2>
          <p>{presentation.detail}</p>
        </div>
        <div className="jarvis-resting-workspace__truth">
          <CheckCircle2 size={14} aria-hidden />
          <span><strong>Canonical Work</strong>{presentation.truthLabel}</span>
        </div>
      </header>

      {error && <div className="jarvis-resting-workspace__notice" role="status"><span>{error}</span><button type="button" onClick={onRetry}>Retry</button></div>}

      {loading && items.length === 0 ? (
        <div className="jarvis-resting-workspace__loading" aria-label="Loading operational attention">
          {[0, 1, 2].map((row) => <span key={row} className="jarvis-skeleton-tide" />)}
        </div>
      ) : items.length > 0 ? (
        <div className="jarvis-attention-list" role="list" aria-label="Highest-priority Work">
          {items.map((item, index) => (
            <article key={item.workCase.id} role="listitem" className="jarvis-attention-item" data-tone={item.tone} data-selected={selected?.workCase.id === item.workCase.id ? "true" : undefined}>
              <button type="button" className="jarvis-attention-item__inspect" onClick={() => { setSelectedId(item.workCase.id); onInspect(attentionInspector(item)) }} aria-label={`Inspect ${item.workCase.title}`}>
                <span className="jarvis-attention-item__index">{String(index + 1).padStart(2, "0")}</span>
                <span className="jarvis-attention-item__body">
                  <span className="jarvis-attention-item__eyebrow">{item.eyebrow}</span>
                  <strong>{item.workCase.title}</strong>
                  <span className="jarvis-attention-item__reason">{item.reason}</span>
                  <span className="jarvis-attention-item__meta"><span>{item.evidence}</span><span>Updated {dateTime(item.workCase.updatedAt)}</span></span>
                </span>
              </button>
              <Link className="jarvis-attention-item__action" href={item.href} aria-label={`${item.nextAction}: ${item.workCase.title}`}>
                <span>{item.nextAction}</span><ArrowUpRight size={15} aria-hidden />
              </Link>
            </article>
          ))}
        </div>
      ) : presentation.showClearState ? (
        <div className="jarvis-resting-workspace__clear">
          <CheckCircle2 size={24} aria-hidden />
          <div><strong>The operating queue is clear.</strong><p>Conversation remains available below for a customer query or a new business objective.</p></div>
        </div>
      ) : null}
    </section>
  )
}

function SourceBar({ result }: { result: OperationalQueryResult }) {
  return (
    <div className="jarvis-workspace-sourcebar">
      <span><CheckCircle2 size={13} /> Canonical PostgreSQL</span>
      <span>{result.page.returned} returned{result.page.totalCount !== null ? ` of ${result.page.totalCount}` : ""}</span>
      <span>As of {dateTime(result.asOf)}</span>
      {result.truncated && <span className="jarvis-workspace-sourcebar__warn">Bounded result</span>}
    </div>
  )
}

function CustomerWorkspace({ projection, onInspect }: WorkspaceBodyProps) {
  const { focusEntity } = useOperatingInteractionActions()
  const result = projection.query?.result.intent === "customer_lookup" ? projection.query.result as CustomerLookupResult : null
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const rows = result?.rows ?? []
  const inspect = (row: CustomerLookupResult["rows"][number]) => {
    setSelectedId(row.householdId)
    focusEntity({ entityType: "household", entityId: row.householdId }, row.displayName ?? row.address)
    onInspect([
      { label: "Customer", value: row.displayName ?? "Unnamed household" },
      { label: "Address", value: row.address },
      { label: "Matched by", value: row.matchedBy.map(humanize).join(", ") || "Exact record" },
      { label: "Record", value: row.householdId, href: `/jarvis/customers?householdId=${encodeURIComponent(row.householdId)}` },
    ])
  }
  if (!result) return <ActionPlan projection={projection} onInspect={onInspect} />
  return (
    <div className="jarvis-customer-workspace">
      <SourceBar result={result} />
      {rows.length === 0 ? <WorkspaceEmptyResult title="No matching customer" copy="The canonical customer records returned no match for this query." /> : (
        <div className="jarvis-record-list">
          {rows.map((row) => (
            <button key={row.householdId} type="button" data-selected={selectedId === row.householdId} onClick={() => inspect(row)}>
              <span className="jarvis-record-list__glyph">{(row.displayName ?? row.address).slice(0, 1).toUpperCase()}</span>
              <span><strong>{row.displayName ?? "Unnamed household"}</strong><small>{row.address}</small></span>
              <span className="jarvis-record-list__meta">{row.contacts.length} contact{row.contacts.length === 1 ? "" : "s"}<ArrowUpRight size={14} /></span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function CompanyContextWorkspace({ projection, onInspect }: WorkspaceBodyProps) {
  const graph = projection.query!.result as CompanyContextResult
  if (!graph.context) return <div className="jarvis-customer-workspace"><SourceBar result={graph} /><WorkspaceEmptyResult title={graph.status === "ambiguous" ? "Customer needs disambiguation" : "No connected context"} copy="JARVIS could not resolve one tenant-safe canonical customer context." /></div>
  const nodes = graph.context.nodes
  return (
    <div className="jarvis-customer-workspace">
      <SourceBar result={graph} />
      <div className="jarvis-cohort-summary">
        <div><strong>{nodes.length}</strong><span>canonical records</span></div>
        <div><strong>{graph.context.relationships.length}</strong><span>typed relationships</span></div>
        <div><strong>{graph.context.household.displayName ?? "Customer"}</strong><span>{graph.context.household.address}</span></div>
      </div>
      <div className="jarvis-record-list">
        {nodes.map((node) => <button key={`${node.entityType}:${node.entityId}`} type="button" onClick={() => onInspect([
          { label: "Entity", value: humanize(node.entityType) },
          { label: "Label", value: node.label ?? "Canonical record" },
          { label: "Status", value: node.status ? humanize(node.status) : "Recorded" },
          { label: "Canonical ID", value: node.entityId },
        ])}><span className="jarvis-record-list__glyph">{node.entityType.slice(0, 1).toUpperCase()}</span><span><strong>{node.label ?? humanize(node.entityType)}</strong><small>{humanize(node.entityType)}</small></span><span className="jarvis-record-list__meta">{node.status ? humanize(node.status) : "linked"}<ArrowUpRight size={14} /></span></button>)}
      </div>
    </div>
  )
}

function CohortWorkspace({ projection, onInspect }: WorkspaceBodyProps) {
  const { focusEntity, setCohort, setFilters } = useOperatingInteractionActions()
  const result = projection.query?.result as CustomerCohortResult
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const inspect = (row: CustomerCohortResult["rows"][number]) => {
    setSelectedId(row.householdId)
    focusEntity({ entityType: "household", entityId: row.householdId }, row.displayName ?? row.address)
    onInspect([
      { label: "Customer", value: row.displayName ?? "Unnamed household" },
      { label: "Address", value: row.address },
      { label: "Last interaction", value: row.lastInteractionAt ? dateTime(row.lastInteractionAt) : "No recorded interaction" },
      { label: "Qualification", value: row.qualifiesBecause === "never_active" ? "Never active" : `Before ${dateOnly(result.cutoff)}` },
      { label: "Open record", value: row.householdId, href: `/jarvis/customers?householdId=${encodeURIComponent(row.householdId)}` },
    ])
  }
  const cohortCount = result.page.totalCountExact && result.page.totalCount !== null ? result.page.totalCount : result.count
  const useEntireCohort = () => {
    setCohort({ kind: "work_query_execution", executionId: projection.query!.metadata.queryId, entityType: "household", queryIntent: "customer_cohort", count: cohortCount })
    setFilters([{ field: "cohort", operator: "eq", value: "inactive" }, { field: "minDaysInactive", operator: "gte", value: result.minDaysInactive }])
  }
  return (
    <div className="jarvis-cohort-workspace">
      <SourceBar result={result} />
      <div className="jarvis-cohort-summary">
        <div><strong>{result.count}</strong><span>customers in this bounded set</span></div>
        <div><strong>{result.minDaysInactive}+</strong><span>days inactive</span></div>
        <div><strong>{dateOnly(result.cutoff)}</strong><span>activity cutoff</span></div>
      </div>
      <button type="button" className="mb-3 rounded-xl border border-violet-300/25 bg-violet-300/10 px-3 py-2 text-xs font-black text-violet-100" onClick={useEntireCohort} data-use-entire-cohort={projection.query?.metadata.queryId}>Use entire {cohortCount}-customer cohort</button>
      {result.rows.length === 0 ? <WorkspaceEmptyResult title="No customers in this cohort" copy="No customer met the requested inactivity threshold at the query cutoff." /> : (
        <div className="jarvis-cohort-table" role="table" aria-label="Inspectable customer cohort">
          <div role="row" className="jarvis-cohort-table__head"><span>Customer</span><span>Address</span><span>Last interaction</span><span>Why included</span></div>
          {result.rows.map((row) => (
            <button role="row" key={row.householdId} type="button" data-selected={selectedId === row.householdId} onClick={() => inspect(row)}>
              <strong>{row.displayName ?? "Unnamed household"}</strong>
              <span>{row.address}</span>
              <span>{row.lastInteractionAt ? dateTime(row.lastInteractionAt) : "No history"}</span>
              <span>{row.qualifiesBecause === "never_active" ? "Never active" : "Before cutoff"}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ScheduleWorkspace({ projection, onInspect }: WorkspaceBodyProps) {
  const { focusEntity, setTimeContext } = useOperatingInteractionActions()
  const result = projection.query?.result.intent === "schedule_range" ? projection.query.result as ScheduleRangeResult : null
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const rangeStart = result?.range.start
  const rangeEnd = result?.range.end
  const rangeTimeZone = result?.timeZone
  useEffect(() => {
    if (rangeStart && rangeEnd && rangeTimeZone) setTimeContext({ start: rangeStart, end: rangeEnd, timezone: rangeTimeZone })
  }, [rangeEnd, rangeStart, rangeTimeZone, setTimeContext])
  if (!result) return <ActionPlan projection={projection} onInspect={onInspect} />
  const days = result.rows.reduce<Record<string, typeof result.rows>>((groups, row) => {
    const key = dateOnly(row.scheduledAt, result.timeZone)
    groups[key] = [...(groups[key] ?? []), row]
    return groups
  }, {})
  const inspect = (row: ScheduleRangeResult["rows"][number]) => {
    setSelectedId(row.id)
    if (row.kind === "appointment" || row.kind === "service_visit" || row.kind === "work_order") focusEntity({ entityType: row.kind, entityId: row.id }, row.household?.displayName ?? humanize(row.kind))
    const destination = row.household ? `/jarvis/schedule?${row.kind === "appointment" ? "appointmentId" : row.kind === "work_order" ? "workOrderId" : "serviceVisitId"}=${encodeURIComponent(row.id)}&householdId=${encodeURIComponent(row.household.id)}` : "/jarvis/schedule"
    onInspect([
      { label: "Time", value: dateTime(row.scheduledAt, result.timeZone) },
      { label: "Type", value: humanize(row.kind) },
      { label: "Status", value: humanize(row.status) },
      { label: "Customer", value: row.household?.displayName ?? "No household linked" },
      { label: "Technician", value: row.technician?.name ?? "Unassigned" },
      { label: "Open schedule", value: row.id, href: destination },
    ])
  }
  return (
    <div className="jarvis-schedule-workspace">
      <SourceBar result={result} />
      <div className="jarvis-schedule-range"><Clock3 size={15} /><span>{dateOnly(result.range.start, result.timeZone)} — {dateOnly(new Date(new Date(result.range.end).getTime() - 1).toISOString(), result.timeZone)}</span><small>{result.timeZone}</small></div>
      {result.rows.length === 0 ? (
        <div className="jarvis-schedule-zero" data-schedule-zero-evidence>
          <CheckCircle2 size={22} aria-hidden />
          <strong>0 appointments found for {dateOnly(result.range.start, result.timeZone)} as of {dateTime(result.asOf, result.timeZone)}</strong>
          <p>The canonical schedule read returned no appointments, service visits, or work orders in this tenant-local range.</p>
          <span>Source: canonical PostgreSQL · {result.source.tables.join(" · ") || "schedule read model"}</span>
        </div>
      ) : (
        <div className="jarvis-operational-timeline">
          {Object.entries(days).map(([day, rows]) => (
            <section key={day}>
              <header><strong>{day}</strong><span>{rows.length} item{rows.length === 1 ? "" : "s"}</span></header>
              {rows.map((row) => (
                <button key={`${row.kind}:${row.id}`} type="button" data-selected={selectedId === row.id} onClick={() => inspect(row)}>
                  <time>{new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: result.timeZone }).format(new Date(row.scheduledAt))}</time>
                  <span className="jarvis-operational-timeline__rail" aria-hidden />
                  <span><strong>{row.household?.displayName ?? row.subjectType ?? humanize(row.kind)}</strong><small>{row.household?.address ?? humanize(row.kind)}</small></span>
                  <span className="jarvis-operational-timeline__owner">{row.technician?.name ?? "Unassigned"}</span>
                  <span className="jarvis-operational-timeline__status">{humanize(row.status)}</span>
                </button>
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

function MoneyWorkspace({ projection, onInspect }: WorkspaceBodyProps) {
  const result = projection.query?.result.intent === "money_summary" ? projection.query.result as MoneySummaryResult : null
  if (!result) return <ActionPlan projection={projection} onInspect={onInspect} />
  const max = Math.max(1, result.totals.invoicedUsd, result.totals.collectedUsd, result.totals.pendingCollectionUsd)
  const groups = [...result.invoices.map((row) => ({ ...row, section: "Invoices" })), ...result.collections.map((row) => ({ ...row, section: "Collections" }))]
  return (
    <div className="jarvis-money-workspace">
      <SourceBar result={result} />
      <div className="jarvis-money-ledger">
        {[
          ["Invoiced", result.totals.invoicedUsd, "cyan"],
          ["Collected", result.totals.collectedUsd, "green"],
          ["Pending", result.totals.pendingCollectionUsd, "amber"],
        ].map(([label, value, tone]) => (
          <button key={String(label)} type="button" onClick={() => onInspect([{ label: String(label), value: money(Number(value)) }, { label: "As of", value: dateTime(result.asOf) }, { label: "Open ledger", value: "Money deep view", href: "/jarvis/money" }])}>
            <span>{label}</span><strong>{money(Number(value))}</strong><i data-tone={tone} style={{ width: `${Math.max(2, Number(value) / max * 100)}%` }} />
          </button>
        ))}
      </div>
      <div className="jarvis-money-status-grid">
        {groups.map((row) => (
          <button key={`${row.section}:${row.status}`} type="button" onClick={() => onInspect([{ label: "Ledger", value: row.section }, { label: "Status", value: humanize(row.status) }, { label: "Records", value: String(row.count) }, { label: "Amount", value: money(row.totalUsd) }, { label: "Open ledger", value: "Inspect exact invoices", href: "/jarvis/money" }])}>
            <span>{row.section}</span><strong>{humanize(row.status)}</strong><em>{row.count} · {money(row.totalUsd)}</em>
          </button>
        ))}
      </div>
    </div>
  )
}

function NarrativeWorkspace({ projection, onInspect, research }: WorkspaceBodyProps & { research: boolean }) {
  const answer = projection.answer
  const evidence = answer?.evidence ?? []
  const narrative = splitResearchNarrative(answer?.spokenSummary ?? projection.description)
  return (
    <div className="jarvis-research-workspace" data-narrative-kind={research ? "research" : "answer"}>
      <div className="jarvis-research-result">
        <Search size={18} />
        <div>
          <span>{research ? "Evidence-backed narrative" : "Direct answer"}</span>
          <h2>{projection.title}</h2>
          <div className="jarvis-research-narrative" data-source={research ? "web-research" : "instruction_events.completed.result.spokenSummary"}>
            {narrative.map((paragraph, index) => <p key={`${index}:${paragraph}`}>{paragraph}</p>)}
          </div>
        </div>
      </div>
      {answer?.facts && answer.facts.length > 0 && (
        <div className="jarvis-research-facts">
          {answer.facts.map((fact) => <button type="button" key={`${fact.label}:${fact.value}`} onClick={() => onInspect([{ label: fact.label, value: fact.value }, ...(fact.source ? [{ label: "Source", value: fact.source }] : [])])}><span>{fact.label}</span><strong>{fact.value}</strong></button>)}
        </div>
      )}
      <section className="jarvis-research-sources">
        <header><strong>{research ? "Sources and citations" : "Evidence attached"}</strong><span>{evidence.length} attached</span></header>
        {evidence.length === 0 ? <p>No citation records were attached to this backend result.</p> : evidence.map((source, index) => {
          const linked = /^https?:\/\//i.test(source.ref)
          return (
            <button key={`${source.source}:${source.ref}`} type="button" onClick={() => onInspect([{ label: "Evidence class", value: source.kind ?? "Unclassified" }, { label: "Source", value: source.source }, { label: "Reference", value: source.ref, ...(linked ? { href: source.ref } : {}) }, ...(source.timestamp ? [{ label: "Retrieved", value: dateTime(source.timestamp) }] : [])])}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <span><strong>{source.title ?? humanize(source.source)}</strong><small>{source.kind ?? "UNCLASSIFIED"} · {source.ref}</small></span>
              {linked ? <ExternalLink size={14} /> : <FileCheck2 size={14} />}
            </button>
          )
        })}
      </section>
    </div>
  )
}

function ResearchWorkspace({ projection, onInspect }: WorkspaceBodyProps) {
  return <NarrativeWorkspace projection={projection} onInspect={onInspect} research />
}

function AnswerWorkspace({ projection, onInspect }: WorkspaceBodyProps) {
  return <NarrativeWorkspace projection={projection} onInspect={onInspect} research={false} />
}

function ActionPlan({ projection, onInspect }: WorkspaceBodyProps) {
  if (projection.actions.length === 0) return <WorkspaceEmptyResult title="Workspace is forming" copy={projection.description} />
  return (
    <div className="jarvis-action-workspace">
      <div className="jarvis-action-sequence">
        {projection.actions.map((action, index) => (
          <button key={action.id} type="button" onClick={() => onInspect([
            { label: "Action", value: humanize(action.actionType) },
            ...(action.targetLabel ? [{ label: "Target", value: action.targetLabel }] : []),
            ...(action.amountUsd !== null ? [{ label: "Amount", value: money(action.amountUsd) }] : []),
            { label: "Policy", value: action.policyVersion === null ? "Checking" : `Version ${action.policyVersion}` },
            { label: "Action ID", value: action.id },
          ])}>
            <span className="jarvis-action-sequence__index">{String(index + 1).padStart(2, "0")}</span>
            <span className="jarvis-action-sequence__card"><ActionRenderer actionType={action.actionType} payload={action.payload} compact /></span>
            <ArrowUpRight size={15} />
          </button>
        ))}
      </div>
    </div>
  )
}

function WorkTimelineWorkspace({
  result,
  rows,
  onInspect,
}: {
  result: OperationalQueryResult
  rows: Array<{ id: string; title: string; type: string; status: string; at: string; href: string }>
  onInspect: (items: InspectorItem[]) => void
}) {
  return (
    <div className="jarvis-work-timeline-workspace">
      <SourceBar result={result} />
      <header className="jarvis-work-timeline-workspace__header">
        <div><span>Durable operating record</span><strong>{rows.length} live Work records</strong></div>
        <span>Ordered by latest observed activity</span>
      </header>
      {rows.length === 0 ? <WorkspaceEmptyResult title="No Work records found" copy="The canonical Work read returned no records for this request." /> : (
        <ol className="jarvis-work-timeline" aria-label="Work timeline">
          {rows.map((row) => (
            <li key={`${row.type}:${row.id}`}>
              <span className="jarvis-work-timeline__dot" aria-hidden />
              <button type="button" onClick={() => onInspect([{ label: "Record", value: row.title }, { label: "Type", value: row.type }, { label: "Status", value: humanize(row.status) }, { label: "Updated", value: dateTime(row.at) }, { label: "Open Work", value: row.id, href: row.href }])}>
                <span><strong>{row.title}</strong><small>{row.type} · {humanize(row.status)}</small></span>
                <time>{dateTime(row.at)}</time>
                <ArrowUpRight size={14} aria-hidden />
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

function QueryOperationsWorkspace({ projection, onInspect }: WorkspaceBodyProps) {
  const { focusEntity } = useOperatingInteractionActions()
  const result = projection.query!.result
  if (result.intent === "work_list") {
    const work = result as WorkListResult
    const rows = [
      ...work.works.map((row) => ({ id: row.id, title: `Work ${row.id.slice(0, 8)}`, type: "Durable Work", status: row.status, at: row.updatedAt, href: `/jarvis/work?workCaseId=${encodeURIComponent(row.id)}` })),
      ...work.workOrders.map((row) => ({ id: row.id, title: row.household?.displayName ?? humanize(row.type), type: "Work order", status: row.status, at: row.scheduledAt ?? row.createdAt, href: `/jarvis/schedule?workOrderId=${encodeURIComponent(row.id)}` })),
      ...work.tasks.map((row) => ({ id: row.id, title: row.title, type: "Task", status: row.status, at: row.dueAt ?? row.createdAt, href: "/jarvis/work" })),
    ]
    return <WorkTimelineWorkspace result={result} rows={rows} onInspect={onInspect} />
  }
  if (result.intent === "agent_activity") {
    const activity = result as AgentActivityResult
    const rows = [
      ...activity.actions.map((row) => ({ id: row.id, title: humanize(row.actionType), type: "Action", status: row.status, at: row.occurredAt, href: "/jarvis/agents" })),
      ...activity.workflows.map((row) => ({ id: row.id, title: humanize(row.workflowType), type: "Workflow", status: row.status, at: row.occurredAt, href: "/jarvis/agents" })),
      ...activity.calls.map((row) => ({ id: row.id, title: `${humanize(row.direction)} call`, type: "Call", status: row.endedReason ?? (row.endedAt ? "ended" : "active"), at: row.occurredAt, href: "/jarvis/agents" })),
    ]
    return <OperationalRows result={result} rows={rows} onInspect={onInspect} />
  }
  if (result.intent === "inventory_status") {
    const inventory = result as InventoryStatusResult
    return (
      <div className="jarvis-query-plan-workspace"><SourceBar result={result} /><div className="jarvis-inventory-grid">{inventory.items.map((item) => <button key={item.id} type="button" data-alert={item.lowStock} onClick={() => { focusEntity({ entityType: "inventory_item", entityId: item.id }, item.name); onInspect([{ label: "Item", value: item.name }, { label: "SKU", value: item.sku }, { label: "On hand", value: String(item.quantity) }, { label: "Reorder at", value: String(item.reorderThreshold) }]) }}><span>{item.sku}</span><strong>{item.name}</strong><em>{item.quantity} on hand</em></button>)}</div></div>
    )
  }
  const business = result as BusinessStateResult
  const sections = [
    ...Object.entries(business.pipeline).map(([label, values]) => ({ label: humanize(label), values })),
    ...Object.entries(business.operations).filter((entry): entry is [string, Array<{ status: string; count: number }>] => Array.isArray(entry[1])).map(([label, values]) => ({ label: humanize(label), values })),
  ]
  return <div className="jarvis-query-plan-workspace"><SourceBar result={result} /><div className="jarvis-business-state-grid">{sections.map((section) => <button key={section.label} type="button" onClick={() => onInspect(section.values.map((value) => ({ label: humanize(value.status), value: String(value.count) })))}><strong>{section.label}</strong><span>{section.values.reduce((sum, value) => sum + value.count, 0)}</span><small>{section.values.map((value) => `${humanize(value.status)} ${value.count}`).join(" · ")}</small></button>)}</div></div>
}

function OperationalRows({ result, rows, onInspect }: { result: OperationalQueryResult; rows: Array<{ id: string; title: string; type: string; status: string; at: string; href: string }>; onInspect: (items: InspectorItem[]) => void }) {
  return <div className="jarvis-query-operations"><SourceBar result={result} /><div className="jarvis-operational-rows">{rows.map((row) => <button key={`${row.type}:${row.id}`} type="button" onClick={() => onInspect([{ label: "Record", value: row.title }, { label: "Type", value: row.type }, { label: "Status", value: humanize(row.status) }, { label: "Updated", value: dateTime(row.at) }, { label: "Open deep view", value: row.id, href: row.href }])}><span><strong>{row.title}</strong><small>{row.type}</small></span><span>{humanize(row.status)}</span><time>{dateTime(row.at)}</time><ArrowUpRight size={14} /></button>)}</div></div>
}

function WorkspaceEmptyResult({ title, copy }: { title: string; copy: string }) {
  return <div className="jarvis-workspace-zero"><ListFilter size={20} /><strong>{title}</strong><p>{copy}</p></div>
}

interface WorkspaceBodyProps {
  projection: WorkspaceProjection
  onInspect: (items: InspectorItem[]) => void
}

function WorkspaceBody({ projection, thread, role, reducedMotion, liveframe, onInspect, onAnswer, onCancel, onRetry }: WorkspaceBodyProps & { thread: Thread; role: JarvisRole; reducedMotion: boolean; liveframe: LiveFrameProjection; onAnswer: (text: string) => void; onCancel: () => void; onRetry: () => void | Promise<void> }) {
  if (["captured", "understanding", "planning"].includes(thread.machine.instructionState)) {
    const progress = <WorkspaceProgress thread={thread} liveframe={liveframe} />
    return thread.machine.instructionState === "planning" && projection.actions.length > 0
      ? <div className="jarvis-planning-workspace">{progress}<ActionPlan projection={projection} onInspect={onInspect} /></div>
      : progress
  }
  if (thread.machine.instructionState === "clarifying") return <div className="jarvis-clarification-workspace"><ThreadClarify thread={thread} onAnswer={onAnswer} onSkip={onCancel} onCancel={onCancel} /></div>
  if (thread.machine.instructionState === "awaiting_approval" && !thread.everExecuted) {
    return <div className="jarvis-embedded-approval">
      <ApprovalCockpit escalateOnly={role === "dispatcher"} scopeActionIds={thread.nodes.map((node) => node.id)} scopeInstructionId={thread.instructionId} restored={false} />
      <p className="jarvis-embedded-approval__note">Review the recorded actions above. Cancel remains available in the command composer until a decision is made.</p>
    </div>
  }
  if (projection.kind === "customer") return projection.query?.result.intent === "company_context"
    ? <CompanyContextWorkspace projection={projection} onInspect={onInspect} />
    : <CustomerWorkspace projection={projection} onInspect={onInspect} />
  if (projection.kind === "customer-cohort") return <CohortWorkspace projection={projection} onInspect={onInspect} />
  if (projection.kind === "schedule") return <ScheduleWorkspace projection={projection} onInspect={onInspect} />
  if (projection.kind === "money") return <MoneyWorkspace projection={projection} onInspect={onInspect} />
  if (projection.kind === "research") return <ResearchWorkspace projection={projection} onInspect={onInspect} />
  if (projection.kind === "answer") return <AnswerWorkspace projection={projection} onInspect={onInspect} />
  if (projection.kind === "execution") {
    if (projection.query) return <QueryOperationsWorkspace projection={projection} onInspect={onInspect} />
    return <div className="jarvis-execution-workspace"><WorkspaceProgress thread={thread} liveframe={liveframe} /><ThreadExecution thread={thread} restored={false} executionWeavePlacement="document" energy={0.7} /></div>
  }
  if (projection.kind === "receipt") return <div className="jarvis-receipt-workspace"><ThreadReceipt thread={thread} reducedMotion={reducedMotion} onRetry={onRetry} restored={false} /></div>
  if (projection.kind === "recovery") return <div className="jarvis-recovery-workspace"><div className="jarvis-recovery-workspace__lead"><ShieldAlert size={22} /><div><strong>Work stopped safely</strong><p>{thread.submitError ?? "The durable Work record is available for retry and inspection. No unverified success is being shown."}</p></div></div><ThreadReceipt thread={thread} reducedMotion={reducedMotion} onRetry={onRetry} restored={false} /></div>
  if (projection.query) return <QueryOperationsWorkspace projection={projection} onInspect={onInspect} />
  return <ActionPlan projection={projection} onInspect={onInspect} />
}

export function AdaptiveWorkspaceShell({
  thread,
  threadHistory,
  liveframe,
  role,
  reducedMotion,
  composer,
  onAnswer,
  onCancel,
  onRetry,
  fixtureLabel,
  publicPreview = false,
  threadRestored = false,
  restoredTraceEventCount = 0,
}: {
  thread: Thread | null
  threadHistory: Thread[]
  liveframe: LiveFrameProjection
  role: JarvisRole
  reducedMotion: boolean
  composer: ReactNode
  onAnswer: (text: string) => void
  onCancel: () => void
  onRetry: () => void | Promise<void>
  fixtureLabel?: string
  publicPreview?: boolean
  threadRestored?: boolean
  restoredTraceEventCount?: number
}) {
  const { config: workspaceConfig } = useWorkspaceConfig()
  const shellRef = useRef<HTMLDivElement | null>(null)
  const projectedThread = useMemo(() => thread ? projectThreadWorkspace(thread) : null, [thread])
  const initialQuery = projectedThread?.query ?? null
  const liveQuery = useBusinessProjection(businessProjections.operationalQuery(initialQuery ?? EMPTY_QUERY_EXECUTION), {
    enabled: initialQuery !== null,
    ...(initialQuery ? { initialData: initialQuery, initialUpdatedAt: new Date(initialQuery.metadata.completedAt).getTime() } : {}),
  })
  const projection = useMemo(() => {
    if (!projectedThread || !projectedThread.query || !liveQuery.data) return projectedThread
    return {
      ...projectedThread,
      query: liveQuery.data,
      answer: projectedThread.answer ? { ...projectedThread.answer, query: liveQuery.data } : projectedThread.answer,
      updatedAtMs: liveQuery.updatedAt ?? projectedThread.updatedAtMs,
    }
  }, [liveQuery.data, liveQuery.updatedAt, projectedThread])
  const restingWork = useBusinessProjection(businessProjections.workCases(), { enabled: thread === null && !publicPreview })
  const restingAttention = useMemo(() => {
    const allowed = new Set(workspaceConfig.roles[role].ready.attentionCategories)
    return projectRestingAttention(restingWork.data ?? [], Date.now(), 12).filter((item) => allowed.has(item.kind)).slice(0, 3)
  }, [restingWork.data, role, workspaceConfig.roles])
  const [inspector, setInspector] = useState<InspectorItem[]>([])
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [advancedInspectorOpen, setAdvancedInspectorOpen] = useState(false)
  const activeInspector = useMemo(() => thread && projection ? buildWorkspaceInspector(thread, projection, role) : [], [projection, role, thread])
  const inspectActive = useCallback((items: InspectorItem[]) => {
    const contextualLabels = new Set(items.map((item) => item.label))
    setInspector([...items, ...activeInspector.filter((item) => !contextualLabels.has(item.label))])
  }, [activeInspector])

  useEffect(() => {
    if (!projection) {
      setInspector([])
      return
    }
    setInspector(activeInspector)
  }, [activeInspector, projection])

  useEffect(() => {
    setInspectorOpen(false)
    setAdvancedInspectorOpen(false)
  }, [projection?.key])

  useEffect(() => {
    if (!inspectorOpen) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setInspectorOpen(false)
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [inspectorOpen])

  const restingError = restingWork.error
    ? restingWork.data
      ? "The latest refresh was delayed. Showing the last verified Work projection."
      : "Operational attention is unavailable because canonical Work could not be read."
    : null
  const restingLoading = !publicPreview && thread === null && restingWork.data === null && (restingWork.status === "idle" || restingWork.status === "loading")
  const restingState = restingAttention[0]?.tone === "critical" ? "failed" : restingAttention[0]?.tone === "decision" ? "awaiting_approval" : "idle"
  const restingStateLabel = restingLoading ? "Reading Work" : restingAttention.length > 0 ? `${restingAttention.length} need attention` : "Current"
  const navItems = orderedWorkspaceItems([...NAV], workspaceConfig, role)
  const visibleInspector = inspector.filter((item) => inspectorFieldVisible(item.label, workspaceConfig))
  const inspectorGroups = useMemo(() => groupWorkspaceInspector(visibleInspector), [visibleInspector])
  const scene = deriveSceneDirector(liveframe).scene
  const configuredScene = workspaceConfig.scenes[scene]
  const extensionSlot = sceneSlot(scene)
  const extensionContext = {
    role,
    scene,
    vocabulary: workspaceConfig.vocabulary,
    primaryProjection: workspaceConfig.roles[role].ready.primaryProjection,
    activeWork: thread ? { id: thread.workId ?? null, state: thread.machine.instructionState } : null,
  }

  useGSAP(() => {
    if (reducedMotion || !projection) return
    gsap.fromTo("[data-adaptive-workspace-body]", { autoAlpha: 0, scale: 0.985, y: 10 }, { autoAlpha: 1, scale: 1, y: 0, duration: 0.34, ease: "power2.out" })
    gsap.fromTo("[data-adaptive-inspector]", { autoAlpha: 0, x: 14 }, { autoAlpha: 1, x: 0, duration: 0.3, ease: "power2.out", delay: 0.05 })
  }, { scope: shellRef, dependencies: [projection?.key, projection?.kind, reducedMotion], revertOnUpdate: true })

  return (
    <div
      ref={shellRef}
      className="jarvis-adaptive-shell"
      data-inspector-state={inspectorOpen ? "open" : "closed"}
      data-active-workspace={projection?.kind ?? "ready"}
      data-thread-document
      data-thread-restored={threadRestored ? "true" : "false"}
      data-jarvis-restored-event-count={threadRestored ? restoredTraceEventCount : undefined}
      data-jarvis-instruction-id={thread?.instructionId ?? undefined}
      data-source={fixtureLabel ? "fixture.adaptiveWorkspace" : undefined}
      data-experience-scene={scene}
      data-experience-detail={configuredScene.detail}
      data-experience-emphasis={configuredScene.emphasis}
      data-experience-motion={effectiveMotionPreference(workspaceConfig.brand.motion, reducedMotion)}
    >
      {fixtureLabel && <div className="fixed left-1/2 top-2 z-[100] -translate-x-1/2"><span className="j-chip border border-violet-300/40 bg-violet-400/15 text-violet-200">FIXTURE · {fixtureLabel}</span></div>}
      {publicPreview && <div className="fixed left-1/2 top-2 z-[100] -translate-x-1/2"><span className="j-chip border border-cyan-300/30 bg-cyan-300/10 text-cyan-100">PUBLIC PREVIEW</span></div>}
      <aside className="jarvis-adaptive-nav" aria-label="JARVIS navigation">
        <Link href={withOperationalContext("/jarvis", undefined, projection?.workId)} className="jarvis-adaptive-nav__brand"><span><TenantBrandMark size={24} /></span><strong>JARVIS</strong></Link>
        <nav>{navItems.map(({ key, href, icon: Icon }) => <Link key={href} href={withOperationalContext(href, undefined, projection?.workId)} aria-current={href === "/jarvis" ? "page" : undefined} title={workspaceConfig.terminology[key]}><Icon size={17} /><span>{workspaceConfig.terminology[key]}</span></Link>)}</nav>
        <div className="jarvis-adaptive-nav__status" data-state={liveframe.mode}><i /><span>{stateLabel(projection?.state ?? "idle")}</span></div>
      </aside>

      <main className="jarvis-adaptive-main">
        <header className="jarvis-adaptive-header">
        <div>
            <span>{projection?.eyebrow ?? (publicPreview ? "Adaptive workspace" : "Operational focus")}</span>
            <h1>{projection?.title ?? (publicPreview ? "JARVIS workspace" : "What needs attention now")}</h1>
          </div>
          <div className="jarvis-adaptive-header__controls">
            {!publicPreview && <WorkspaceSettingsButton compact />}
            {!publicPreview && <button type="button" className="jarvis-adaptive-inspector-toggle" onClick={() => setInspectorOpen((open) => !open)} aria-expanded={inspectorOpen} aria-controls="jarvis-context-inspector">
              <PanelRight size={15} aria-hidden /> <span>{inspectorOpen ? "Hide context" : "Context"}</span>
            </button>}
            <div className="jarvis-adaptive-header__state" data-state={projection?.state ?? restingState}><i />{projection ? stateLabel(projection.state) : publicPreview ? "Ready" : restingStateLabel}</div>
          </div>
        </header>
        <div className="jarvis-adaptive-stage" data-adaptive-workspace-body>
          {thread && projection ? <>{extensionSlot ? <ExperienceSlot slot={extensionSlot} context={extensionContext} className="jarvis-experience-scene-slot" /> : null}<WorkspaceBody projection={projection} thread={thread} role={role} reducedMotion={reducedMotion} liveframe={liveframe} onInspect={inspectActive} onAnswer={onAnswer} onCancel={onCancel} onRetry={onRetry} /></>
            : publicPreview ? <EmptyWorkspace />
              : <><TenantReadyExperience role={role} /><RestingWorkspace items={restingAttention} loading={restingLoading} error={restingError} stale={Boolean(restingWork.data) && (restingWork.stale || restingWork.status === "error")} onRetry={() => { void restingWork.refresh().catch(() => undefined) }} onInspect={setInspector} /></>}
        </div>
        <section className="jarvis-conversation-layer" aria-label="Command history">
          {thread && <div className="jarvis-current-request" data-history-current>
            <span><strong>Current request</strong><em>{stateLabel(thread.machine.instructionState)}</em></span>
            <p>{thread.instructionText}</p>
          </div>}
          {!thread && !publicPreview && <div className="jarvis-current-request" data-current-request-empty>
            <span><strong>Current request</strong><em>Ready</em></span>
            <p>No active instruction. Start new Work or continue an existing case.</p>
          </div>}
          <details className="jarvis-history-drawer">
            <summary><span><History size={14} aria-hidden /><strong>{thread ? "Previous commands" : "Command history"}</strong></span><span>{threadHistory.length} {threadHistory.length === 1 ? "instruction" : "instructions"}<ChevronDown size={14} aria-hidden /></span></summary>
            <ol className="jarvis-history-timeline">
              {threadHistory.slice(0, 6).map((item) => <li key={item.id}><span className="jarvis-history-timeline__dot" aria-hidden /><div><strong>{dateTime(new Date(item.createdAtMs).toISOString())} · {stateLabel(item.machine.instructionState)}</strong><p>{item.instructionText}</p></div></li>)}
              {!thread && threadHistory.length === 0 && <li><span className="jarvis-history-timeline__dot" aria-hidden /><div><strong>Ready</strong><p>Your instructions and outcomes stay attached to durable Work.</p></div></li>}
            </ol>
          </details>
        </section>
        <div className="jarvis-adaptive-composer">{composer ?? <Link className="jarvis-adaptive-signin" href="/jarvis/login">Sign in to direct live Work <ArrowUpRight size={14} /></Link>}</div>
      </main>

      <aside id="jarvis-context-inspector" className="jarvis-adaptive-inspector" data-adaptive-inspector aria-label="Contextual inspector" hidden={!inspectorOpen}>
        <div className="jarvis-adaptive-inspector__inner">
          <header><span>Context inspector</span><strong>{projection ? humanize(projection.kind) : publicPreview ? "Ready" : "Operational attention"}</strong></header>
          <dl className="jarvis-adaptive-inspector__primary">
            {inspectorGroups.primary.map((item, index) => <div key={`${item.label}:${index}`} data-inspector-field={item.label.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-")}><dt>{item.label}</dt><dd>{item.href ? <Link href={item.href}>{item.value}<ArrowUpRight size={12} /></Link> : item.value}</dd></div>)}
          </dl>
          {inspectorGroups.advanced.length > 0 && (
            <details className="jarvis-adaptive-inspector__advanced" open={advancedInspectorOpen} onToggle={(event) => setAdvancedInspectorOpen(event.currentTarget.open)}>
              <summary>Advanced policy and debug <ChevronDown size={14} aria-hidden /></summary>
              <dl>{inspectorGroups.advanced.map((item, index) => <div key={`${item.label}:${index}`} data-inspector-field={item.label.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-")}><dt>{item.label}</dt><dd>{item.href ? <Link href={item.href}>{item.value}<ArrowUpRight size={12} /></Link> : item.value}</dd></div>)}</dl>
            </details>
          )}
          {projection?.query && <div className="jarvis-adaptive-inspector__provenance"><CheckCircle2 size={14} /><span><strong>Verified source</strong>{projection.query.result.source.tables.join(" · ")}</span></div>}
          <ExperienceSlot slot="inspector.extra" context={extensionContext} />
          {inspectorGroups.durableWork?.href ? <Link className="jarvis-adaptive-inspector__open" href={inspectorGroups.durableWork.href}>Open durable Work <ArrowUpRight size={14} /></Link> : projection?.workId ? <Link className="jarvis-adaptive-inspector__open" href={`/jarvis/work?workCaseId=${encodeURIComponent(projection.workId)}`}>Open durable Work <ArrowUpRight size={14} /></Link> : null}
        </div>
      </aside>
    </div>
  )
}
