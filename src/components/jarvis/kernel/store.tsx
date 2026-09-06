"use client"

// JARVIS kernel — the store (plan v3 P2.T1/§4.1).
//
// "The kernel wraps lib/data-core.ts; it never replaces it." The persistent
// `/jarvis` layout owns auth, live projections, and the data-core adapter; this
// seam layers the instruction
// machine + presence derivation + (P2-scope, polling-only) transport health on
// top, all built from the pure functions in `machine.ts`/`presence.ts`/
// `transport.ts` so the actual decision logic stays unit-testable without a DOM
// (BLOCKER B-1's own resolution, carried forward from P1).
//
// P2 has no real instruction-event stream yet (P3 adds `instruction_events` and
// `domain_actions.instruction_id` — P3.T1). Until then, this store correlates a
// thread's own approval/execution outcome by set-diffing the kernel's own
// snapshots ("which pending rows/runs are new since this thread's own moment")
// rather than an authoritative backend link. That is honest for the golden
// journey's own stated scope — "one active thread expanded at a time" (§2.3) —
// and is explicitly superseded once P3 ships real per-instruction correlation.
// Every place this matters is commented at the point it happens, not just here.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { useJarvisAuth } from "../lib/jarvis-auth"
import { useJarvis, type EventRow, type WorkflowRun } from "../lib/data-core"
import { useSelectorInput, useLanePresentation, type LanePresentation } from "./useSelectorInput"
import type { SelectorInput } from "./selectors"
import {
  selectCollectedUsd,
  selectOverdueInvoices,
  selectPendingApprovals,
  selectRunsInFlight,
} from "./selectors"
import { initialMachineState, transition, type MachineState } from "./machine"
import { derivePresence } from "./presence"
import { deriveTransportHealth, startInstructionTransport, type InstructionTransportHandle, type SseHealth, type TransportHealth } from "./transport"
import { jarvisGet, jarvisPost, JarvisApiError } from "../lib/api"
import { publishBusinessInvalidation } from "../lib/business-invalidation"
import {
  getOrCreateSessionId,
  fetchTraceEvents,
  mintInstructionId,
  submitInstruction,
  type InstructionSource,
  type PlannedActionResponse,
  type TraceEvent,
} from "./instruction"
import { recordTraceEventReceived } from "./trace-metrics"
import type { CancelableInstructionState, InstructionState, JarvisMode, Presence, Truth } from "./types"
import { looksLikeFollowUpReference, UNRESOLVED_REFERENCE_MESSAGE, UNRESOLVED_REFERENCE_CONTEXT } from "./followup-reference"
import { isOperationalQueryExecution, type OperationalQueryExecution } from "../workspaces/contracts"
import { operatingInteractionFromWorkAggregate, useOperatingInteractionActions, type OperatingInteractionContextValue } from "./operating-interaction"

// ---------------------------------------------------------------------------
// Thread shape
// ---------------------------------------------------------------------------

export interface ThreadNode {
  id: string
  actionType: string
  amountUsd: number | null
  targetLabel: string | null
  policyId: string | null
  policyVersion: number | null
  groundedPayload: Array<{ field: string; status: "verified" | "not_found" | "unverifiable" }>
  payload: Record<string, unknown>
  /** Real sibling action ids from the planner's durable dependency DAG. Absent
   *  means this thin trace node has not received the fuller plan row yet. */
  dependsOn?: string[] | null
  reasoning?: string
}

export interface ClarificationData {
  question: string
  missingFields: string[]
  context?: string
}

/** jarvis-v3 P3.T7: one real chip from a `context_retrieved` trace event's own
 *  `{label, count, source}` — never memory contents (this session's own binding
 *  rule; `label`/`source` are the ONLY strings this ever carries). */
export interface ContextChip {
  label: string
  source: string
}

export interface AnswerFact {
  label: string
  value: string
  source?: string
}

export interface AnswerEvidence {
  source: string
  ref: string
  timestamp?: string
  title?: string
  kind?: "CANONICAL" | "WORK" | "PROFILE" | "SESSION" | "MEMORY" | "WEB"
}

/** A read-only answer emitted by the backend's completed-event result envelope.
 *  `spokenSummary` is the only required, grounded string. Optional fields are
 *  accepted only when they are display-safe primitives already shaped by the
 *  backend; malformed envelopes are ignored rather than promoted to UI copy. */
export interface AnswerResult {
  kind: "answer"
  spokenSummary: string
  displaySummary?: string
  facts?: AnswerFact[]
  evidence?: AnswerEvidence[]
  /** The canonical typed Query Plane execution returned by POST /api/actions.
   * Trace events intentionally keep only a bounded display projection; the
   * durable Work response enriches this field after navigation or refresh. */
  query?: OperationalQueryExecution
}

/** A bounded projection of the backend's real `step_progress`/verification
 * events. This is presentation state only: it cannot advance Work, authorize an
 * action, or manufacture completion. */
export interface ThreadProgress {
  stage:
    | "resolving_context"
    | "querying_business"
    | "querying_grounded_sources"
    | "researching_verified_external_sources"
    | "verifying"
    | "verified"
  sourceKind?: "CANONICAL" | "MEMORY" | "WEB"
  actionId?: string
  observedAt?: string
}

function parseAnswerEnvelope(candidate: unknown, queryCandidate?: unknown): AnswerResult | null {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null
  const result = candidate as Record<string, unknown>
  if (result.kind !== "answer" || typeof result.spokenSummary !== "string" || !result.spokenSummary.trim()) return null

  const display = result.display && typeof result.display === "object" && !Array.isArray(result.display)
    ? result.display as Record<string, unknown>
    : null
  const rawFacts = Array.isArray(result.facts) ? result.facts : display?.facts
  const facts = Array.isArray(rawFacts)
    ? rawFacts
        .map((fact) => (fact && typeof fact === "object" && !Array.isArray(fact) ? fact as Record<string, unknown> : null))
        .filter((fact): fact is Record<string, unknown> => Boolean(fact))
        .map((fact): AnswerFact => ({
          label: typeof fact.label === "string" ? fact.label.trim() : "",
          value: typeof fact.value === "string" ? fact.value.trim() : "",
          ...(typeof fact.source === "string" && fact.source.trim() ? { source: fact.source.trim() } : {}),
        }))
        .filter((fact): fact is AnswerFact => Boolean(fact.label && fact.value))
    : undefined
  const displaySummary =
    typeof result.displaySummary === "string" && result.displaySummary.trim()
      ? result.displaySummary.trim()
      : typeof display?.title === "string" && display.title.trim()
        ? display.title.trim()
        : undefined
  const evidence = Array.isArray(result.evidence)
    ? result.evidence
        .map((item) => (item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : null))
        .filter((item): item is Record<string, unknown> => Boolean(item))
        .map((item): AnswerEvidence => ({
          source: typeof item.source === "string" ? item.source.trim() : "",
          ref: typeof item.ref === "string" ? item.ref.trim() : "",
          ...(typeof item.timestamp === "string" && item.timestamp.trim() ? { timestamp: item.timestamp.trim() } : {}),
          ...(typeof item.title === "string" && item.title.trim() ? { title: item.title.trim() } : {}),
          ...(item.kind === "CANONICAL" || item.kind === "WORK" || item.kind === "PROFILE" || item.kind === "SESSION" || item.kind === "MEMORY" || item.kind === "WEB" ? { kind: item.kind } : {}),
        }))
        .filter((item) => Boolean(item.source && item.ref))
    : undefined
  return {
    kind: "answer",
    spokenSummary: result.spokenSummary.trim(),
    ...(displaySummary ? { displaySummary } : {}),
    ...(facts && facts.length > 0 ? { facts } : {}),
    ...(evidence && evidence.length > 0 ? { evidence } : {}),
    ...(isOperationalQueryExecution(queryCandidate)
      ? { query: queryCandidate }
      : isOperationalQueryExecution(result.query)
        ? { query: result.query }
        : {}),
  }
}

export function parseSubmissionAnswer(value: unknown, query?: unknown): AnswerResult | null {
  return parseAnswerEnvelope(value, query)
}

export function parseAnswerResult(payload: Record<string, unknown>): AnswerResult | null {
  return parseAnswerEnvelope(payload.result)
}

function mergeAnswerResult(current: AnswerResult | null | undefined, incoming: AnswerResult | null): AnswerResult | null | undefined {
  if (!incoming) return current
  if (!current) return incoming
  return {
    ...current,
    ...incoming,
    facts: incoming.facts ?? current.facts,
    evidence: incoming.evidence ?? current.evidence,
    query: incoming.query ?? current.query,
  }
}

interface DurableSubmissionSnapshot {
  answer: AnswerResult | null
  planned: PlannedActionResponse[]
}

function submissionFromWorkAggregate(value: unknown): DurableSubmissionSnapshot {
  const empty = { answer: null, planned: [] }
  if (!value || typeof value !== "object" || Array.isArray(value)) return empty
  const envelope = value as Record<string, unknown>
  const aggregate = envelope.work && typeof envelope.work === "object" && !Array.isArray(envelope.work)
    ? envelope.work as Record<string, unknown>
    : envelope
  const workRow = aggregate.work && typeof aggregate.work === "object" && !Array.isArray(aggregate.work)
    ? aggregate.work as Record<string, unknown>
    : null
  const finalOutcome = workRow?.finalOutcome && typeof workRow.finalOutcome === "object" && !Array.isArray(workRow.finalOutcome)
    ? workRow.finalOutcome as Record<string, unknown>
    : null
  const response = finalOutcome?.response && typeof finalOutcome.response === "object" && !Array.isArray(finalOutcome.response)
    ? finalOutcome.response as Record<string, unknown>
    : null
  if (!response) return empty
  const planned = Array.isArray(response.planned)
    ? response.planned.filter((row): row is PlannedActionResponse => {
        if (!row || typeof row !== "object" || Array.isArray(row)) return false
        const candidate = row as Record<string, unknown>
        return typeof candidate.id === "string"
          && typeof candidate.actionType === "string"
          && candidate.payload !== null
          && typeof candidate.payload === "object"
          && !Array.isArray(candidate.payload)
      })
    : []
  return { answer: parseSubmissionAnswer(response.answer, response.query), planned }
}

function eventInstructionId(event: TraceEvent): string | undefined {
  if (typeof event.instructionId === "string") return event.instructionId
  return typeof event.payload.instructionId === "string" ? event.payload.instructionId : undefined
}

/** Strict correlation seam shared by the trace reducer and the live queue. An
 * event without repeated identity is accepted because the transport endpoint is
 * already instruction-scoped; a repeated identity must match exactly. */
export function traceEventMatchesInstructionId(event: TraceEvent, instructionId: string | null): boolean {
  const repeatedId = eventInstructionId(event)
  return repeatedId === undefined ? true : instructionId !== null && repeatedId === instructionId
}

/** P2-scope correlation bookkeeping (see file header). Superseded by P3's real
 *  `domain_actions.instruction_id`.
 *
 *  `enteredAtMs`/`everPendingIds` exist because of a real race found via a live
 *  test against a real tenant (not a hypothetical): the moment the machine
 *  enters `awaiting_approval`, `data.pendingActions` is whatever the fast lane
 *  last polled — possibly from BEFORE this submission, i.e. it does not yet
 *  contain our new node ids at all. Evaluating "is anything still pending"
 *  against that stale snapshot reads as "already fully decided, 0 approved",
 *  which the machine (correctly, given that input) sends to `cancelled` — even
 *  when the real action is a perfectly normal gated approval nobody has looked
 *  at yet, or an ungated action that auto-executed with nothing to approve at
 *  all. `enteredAtMs` gates evaluation until a poll has actually landed since
 *  we started watching; `everPendingIds` remembers which of our own node ids
 *  were EVER actually seen sitting in the pending list, so "never appeared at
 *  all" (auto-executed, ungated) can be told apart from "appeared, then a real
 *  human decision removed it." */
interface ApprovalWatch {
  pendingNodeIds: Set<string>
  approvalsAtStart: number
  rejectionsAtStart: number
  enteredAtMs: number
  everPendingIds: Set<string>
}
interface RunWatch {
  priorRunIds: Set<string>
  correlatedRunIds: Set<string>
}

export interface Thread {
  id: string
  sessionId: string
  /** Canonical authenticated-employee conversation. Session/call ids are only
   * transport provenance and never select durable history. */
  conversationThreadId?: string | null
  /** jarvis-v3 P3.T6: this submission's own client-minted trace id — the SAME id
   *  sent in POST /api/actions's body and polled via GET /api/instructions/:id/events.
   *  Null only for a thread this file's own unit tests construct without it. */
  instructionId: string | null
  /** Upgrade 2: stable across clarification/follow-up turns while instructionId
   * rotates per trace submission. Optional for older fixtures. */
  workId?: string | null
  /** Exact context snapshot submitted with the current Work input. */
  interactionContext?: OperatingInteractionContextValue | null
  source: InstructionSource
  instructionText: string
  createdAtMs: number
  machine: MachineState
  nodes: ThreadNode[]
  /** jarvis-v3 P3.T7: real chips from `context_retrieved` trace events, streamed in
   *  as they arrive (M4 ContextGather) — additive to (never replacing) the
   *  groundedPayload-derived chips `ThreadUnderstood` already rendered in P2. */
  contextChips: ContextChip[]
  /** Latest genuine backend progress event. Optional for legacy fixtures and
   * restored rows written before progressive trace projection shipped. */
  progress?: ThreadProgress | null
  /** Present only when a completed event carries the backend's read-only answer
   *  envelope. Its presence changes the document into an Answer surface; it is
   *  never inferred from an action type or an empty plan. */
  answerResult?: AnswerResult | null
  /** jarvis-v3 P3.T7/T8: real per-action gating bookkeeping derived ENTIRELY from
   *  `instruction_events` (`plan_ready`'s count, `action_gated`/`executing`/
   *  `completed`/`failed`'s own actionId) — not rendered by any block directly.
   *  Exists so the aggregate awaiting_approval/executing transition can be derived
   *  from the trace ALONE, which is what makes T8's restore-after-refresh able to
   *  reach `awaiting_approval` with no POST response to fall back on (a fresh page
   *  load never has one). The live path's own POST-completion handler
   *  (`runSubmission`) remains the primary, redundant driver of this same
   *  transition — `transition()`'s own idempotency makes firing it from both
   *  places safe. */
  traceGating: {
    expectedCount: number | null
    resolvedActionIds: string[]
    gatedActionIds: string[]
    /** Per-action terminal outcomes from synchronous execution. Optional so
     *  older fixture/test threads remain valid when folded through the kernel. */
    completedActionIds?: string[]
    failedActionIds?: string[]
  }
  clarification: ClarificationData | null
  submitError: string | null
  cancelError?: string | null
  approvalWatch: ApprovalWatch | null
  runWatch: RunWatch | null
  /** Wall-clock ms the machine reached a terminal state, or null. Drives the 4s
   *  "resolved"/"wounded" presence bloom (§5.3 M15 / §6⑦) via `terminalDecayActive`. */
  terminalAtMs: number | null
  /** True the moment the machine EVER enters "executing", never reset. A
   *  rejected/cancelled thread reaches a terminal state (§4.4) without ever
   *  executing anything — found via a real live test (a rejected approval
   *  still showed a collapsed "Execution: Executed" row, a real truth
   *  violation this field exists to prevent). Gates whether the Execution
   *  block exists in Thread.tsx at all, instead of inferring it from "reached
   *  any terminal state." */
  everExecuted: boolean
  /** jarvis-v3 P4.T5: bumped whenever the payment-watch effect below sees a
   *  real `payment_recorded` business event for one of this thread's own
   *  invoices — `ThreadReceipt` passes it straight through as
   *  `ReceiptContent`'s `refreshKey`, so the SAME already-shown receipt
   *  re-fetches and "gets truer over time" (§6⑦) without a fresh page load. */
  receiptRefreshTick: number
}

export interface DurableThreadSummary {
  id: string
  title: string | null
  summary: string | null
  activeWorkId: string | null
  activeObjectiveLoopId: string | null
  lastActivityAt: string
  createdAt: string
}

interface DurableThreadMessage {
  id: string
  sequence: number
  role: "user" | "assistant"
  originalText: string
  instructionId: string | null
  workId: string | null
  createdAt: string
}

/** P3.T3 LF-07: a clarification answer is a new turn in the SAME causal
 * thread. Carry source-labelled context, but never prior action nodes: a new
 * plan must be the only plan that can drive approval language or execution. */
export function carryThreadContinuity(existing: Pick<Thread, "nodes" | "contextChips"> | null): Pick<Thread, "nodes" | "contextChips"> {
  return {
    nodes: [],
    contextChips: existing?.contextChips ?? [],
  }
}

const TERMINAL_DECAY_MS = 4000

let fallbackIdCounter = 0

// See kernel/instruction.ts's own `uuid()` for why this is a monotonic tiebreaker
// rather than a Math.random() fallback — this repo's ESLint rule bans it outright
// under src/components/jarvis (Phase 7 §7.8).
function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID()
  fallbackIdCounter += 1
  return `nocrypto-${Date.now()}-${fallbackIdCounter}`
}

function pickTargetLabel(payload: Record<string, unknown>): string | null {
  for (const key of ["householdLabel", "contactName", "name", "address", "phone"]) {
    const v = payload[key]
    if (typeof v === "string" && v.trim()) return v
  }
  return null
}

function pickAmountUsd(payload: Record<string, unknown>): number | null {
  const v = payload.amountUsd
  return typeof v === "number" ? v : null
}

function pickDependencies(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0))]
}

function nodeFromPlanned(p: PlannedActionResponse): ThreadNode {
  const payload = (p.payload ?? {}) as Record<string, unknown>
  return {
    id: p.id,
    actionType: p.actionType,
    amountUsd: pickAmountUsd(payload),
    targetLabel: pickTargetLabel(payload),
    policyId: p.policyId,
    policyVersion: p.policyVersion ?? null,
    groundedPayload: p.groundedPayload ?? [],
    payload,
    dependsOn: pickDependencies(p.dependsOn),
    reasoning: p.reasoning,
  }
}

/** jarvis-v3 P3.T7: a THIN node from a real `action_created` trace event — only
 *  `id`/`actionType` are known this early (amountUsd/targetLabel/policy/
 *  groundedPayload arrive later, from the POST response's own richer
 *  PlannedActionResponse). `ThreadPlan` already renders amountUsd/targetLabel
 *  conditionally (§6③), so a thin node just shows its action type until
 *  `enrichNodesFromPlanned` (below) fills the rest in — a real, honest interim
 *  state, never a fabricated placeholder value. */
function thinNodeFromTraceEvent(payload: Record<string, unknown>): ThreadNode | null {
  const id = typeof payload.actionId === "string" ? payload.actionId : null
  const actionType = typeof payload.actionType === "string" ? payload.actionType : null
  if (!id || !actionType) return null
  const dependsOn = pickDependencies(payload.dependsOn)
  return {
    id,
    actionType,
    amountUsd: null,
    targetLabel: null,
    policyId: null,
    policyVersion: null,
    groundedPayload: [],
    payload: {},
    ...(dependsOn !== null ? { dependsOn } : {}),
  }
}

/** Upgrades any thin (trace-created) nodes in place with the POST response's fuller
 *  data, matched by id; appends any node the POST response has that the trace never
 *  delivered (the trace poll's own safety net — see kernel/instruction.ts's header
 *  on why a GATED plan's trace can legitimately stop early). Never drops a node,
 *  never reorders one the user has already seen. */
function enrichNodesFromPlanned(existing: ThreadNode[], planned: PlannedActionResponse[], appendMissing = true): ThreadNode[] {
  const byId = new Map(planned.map((p) => [p.id, p]))
  const seen = new Set<string>()
  const upgraded = existing.map((node) => {
    seen.add(node.id)
    const full = byId.get(node.id)
    if (!full) return node
    const enriched = nodeFromPlanned(full)
    return full.dependsOn === undefined && node.dependsOn !== undefined ? { ...enriched, dependsOn: node.dependsOn } : enriched
  })
  const appended = appendMissing ? planned.filter((p) => !seen.has(p.id)).map(nodeFromPlanned) : []
  return [...upgraded, ...appended]
}

function isTerminal(state: InstructionState): boolean {
  return state === "completed" || state === "partial" || state === "failed" || state === "cancelled"
}

/** jarvis-v3 P4.T5 — the pure part of the payment-watch effect below, so the
 *  "which invoiceIds does this thread care about, which real events actually
 *  match one of them" logic is unit-testable without a DOM (BLOCKER B-1). */
export function invoiceIdsForThread(nodes: ThreadNode[]): Set<string> {
  return new Set(nodes.map((n) => (typeof n.payload.invoiceId === "string" ? n.payload.invoiceId : null)).filter((v): v is string => v !== null))
}

export function findRelevantPaymentEvents(events: EventRow[], invoiceIds: Set<string>, seenEventIds: Set<string>): EventRow[] {
  if (invoiceIds.size === 0) return []
  return events.filter((e) => {
    if (e.entityType !== "payment" || seenEventIds.has(e.id)) return false
    const payload = e.payload && typeof e.payload === "object" ? (e.payload as { invoiceId?: unknown }) : {}
    return typeof payload.invoiceId === "string" && invoiceIds.has(payload.invoiceId)
  })
}

// ---------------------------------------------------------------------------
// P3.T8 — restore-after-refresh (§7.1/§8 PHASE 3: "non-terminal instructionId in
// sessionStorage -> refetch -> resume the thread mid-flight").
// ---------------------------------------------------------------------------

const ACTIVE_THREAD_STORAGE_KEY = "jarvis.thread.active"

export interface ActiveThreadPointer {
  id: string
  sessionId: string
  instructionId: string
  workId?: string
  conversationThreadId?: string
  source: InstructionSource
  instructionText: string
  createdAtMs: number
}

/** Persisted the instant a thread is born (① HEARD) — sessionStorage, not
 *  localStorage, matching kernel/instruction.ts's own session-id convention (a
 *  genuinely new browser tab starts fresh, a refresh of THIS tab does not). */
export function persistActiveThreadPointer(p: ActiveThreadPointer): void {
  if (typeof window === "undefined") return
  try {
    window.sessionStorage.setItem(ACTIVE_THREAD_STORAGE_KEY, JSON.stringify(p))
  } catch {
    // Private-mode storage denial: the thread still works this tab session, it
    // just will not survive a refresh — never a crash.
  }
}

export function readActiveThreadPointer(): ActiveThreadPointer | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.sessionStorage.getItem(ACTIVE_THREAD_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ActiveThreadPointer>
    if (
      typeof parsed.id === "string" &&
      typeof parsed.sessionId === "string" &&
      typeof parsed.instructionId === "string" &&
      (parsed.source === "voice" || parsed.source === "typed") &&
      typeof parsed.instructionText === "string" &&
      typeof parsed.createdAtMs === "number"
    ) {
      return parsed as ActiveThreadPointer
    }
    return null
  } catch {
    return null
  }
}

export function clearActiveThreadPointer(): void {
  if (typeof window === "undefined") return
  try {
    window.sessionStorage.removeItem(ACTIVE_THREAD_STORAGE_KEY)
  } catch {
    // see persistActiveThreadPointer
  }
}

/** jarvis-v3 P3.T7/T8: the two live counters `ApprovalWatch` needs to tell "this
 *  many decisions happened since we started watching" apart from history — supplied
 *  by the caller (real `data.approvalsThisSession`/`rejectionsThisSession`) rather
 *  than closed over, so this whole file stays a pure function over an explicit
 *  input (BLOCKER B-1's own established pattern). */
export interface TraceApprovalContext {
  approvalsThisSession: number
  rejectionsThisSession: number
}

/** jarvis-v3 P3.T7/T8: folds a batch of real `instruction_events` rows into a
 *  Thread — what makes ② UNDERSTOOD's chips and ③ PLAN's nodes stream in as
 *  `handleInstruction` actually does the work (M4/M5), instead of waiting for the
 *  whole POST to resolve. ALSO derives the aggregate awaiting_approval/executing
 *  transition (and its approvalWatch/runWatch side-registration) from the trace
 *  alone, once `plan_ready`'s count and every action's own `action_gated` or
 *  terminal (`completed`/`failed`) outcome have arrived — the live path's POST
 *  response remains a redundant second driver of the SAME transition
 *  (`runSubmission`'s completion handler); `transition()`'s own idempotency makes
 *  firing it from both places safe. This second driver is NOT redundant for T8's
 *  restore-after-refresh, which has no POST response to fall back on at all. */
/** jarvis-v3 P5.T5 (V8) — a genuinely empty plan (0 actions, no clarification)
 *  for an instruction that reads like a follow-up reference gets an honest,
 *  narrower message than the generic empty-plan copy — never a fabricated
 *  resolution, and never the misleading "I couldn't turn that into anything I
 *  can do" for what was specifically an unresolved reference (real live
 *  finding this session: e2e/jarvis-p5-followup-real.spec.ts). Shared by both
 *  the trace-poll path (applyTraceEvents) and runSubmission's own POST-
 *  response safety net below, so the two never disagree. */
function emptyPlanOutcome(machine: MachineState, instructionText: string): { machine: MachineState; clarification: ClarificationData | null } {
  if (looksLikeFollowUpReference(instructionText)) {
    return {
      machine: transition(machine, { type: "TRACE_clarification" }),
      clarification: { question: UNRESOLVED_REFERENCE_MESSAGE, missingFields: ["instruction"], context: UNRESOLVED_REFERENCE_CONTEXT },
    }
  }
  return { machine: transition(machine, { type: "PLAN_EMPTY" }), clarification: null }
}

export function applyTraceEvents(thread: Thread, events: TraceEvent[], approval: TraceApprovalContext): Thread {
  let next = thread

  function resolveAction(t: Thread, actionId: string | undefined, resolution: "gated" | "completed" | "failed"): Thread {
    if (!actionId || t.traceGating.resolvedActionIds.includes(actionId)) return t
    const resolvedActionIds = [...t.traceGating.resolvedActionIds, actionId]
    const gated = resolution === "gated"
    const gatedActionIds = gated ? [...t.traceGating.gatedActionIds, actionId] : t.traceGating.gatedActionIds
    const completedActionIds =
      resolution === "completed" ? [...(t.traceGating.completedActionIds ?? []), actionId] : (t.traceGating.completedActionIds ?? [])
    const failedActionIds = resolution === "failed" ? [...(t.traceGating.failedActionIds ?? []), actionId] : (t.traceGating.failedActionIds ?? [])
    let updated: Thread = {
      ...t,
      traceGating: { ...t.traceGating, resolvedActionIds, gatedActionIds, completedActionIds, failedActionIds },
    }
    const { expectedCount } = updated.traceGating
    if (
      !updated.clarification &&
      expectedCount !== null &&
      expectedCount > 0 &&
      resolvedActionIds.length >= expectedCount &&
      (updated.machine.instructionState === "planning" || updated.machine.instructionState === "executing" || updated.machine.instructionState === "verifying")
    ) {
      const gatedCount = gatedActionIds.length
      const executing =
        updated.machine.instructionState === "planning" ? transition(updated.machine, { type: "ACTION_executing", gatedCount: 0 }) : updated.machine
      const terminalCount = completedActionIds.length + failedActionIds.length
      const allSynchronousActionsTerminal = gatedCount === 0 && terminalCount >= expectedCount
      const awaitingApproval =
        gatedCount > 0
          ? executing.instructionState === "planning"
            ? transition(executing, { type: "ACTION_pending", count: gatedCount })
            : executing.instructionState === "executing"
              ? transition(executing, { type: "ACTION_needs_human_review" })
              : executing
          : executing
      const m =
        gatedCount > 0
          ? awaitingApproval
          : allSynchronousActionsTerminal
            ? transition(executing, { type: "TERMINAL", ok: completedActionIds.length, failed: failedActionIds.length, total: terminalCount })
            : executing
      updated = {
        ...updated,
        machine: m,
        approvalWatch:
          m.instructionState === "awaiting_approval"
            ? {
                pendingNodeIds: new Set(gatedActionIds),
                approvalsAtStart: approval.approvalsThisSession,
                rejectionsAtStart: approval.rejectionsThisSession,
                enteredAtMs: Date.now(),
                everPendingIds: new Set(),
              }
            : null,
        runWatch: m.instructionState === "executing" && !allSynchronousActionsTerminal ? { priorRunIds: new Set(), correlatedRunIds: new Set() } : null,
        terminalAtMs: isTerminal(m.instructionState) ? Date.now() : updated.terminalAtMs,
        // A fully-ungated plan moves straight to "executing" from here (never
        // visits awaiting_approval at all) — `everExecuted` gates whether
        // Thread.tsx's Execution block exists (§6⑦'s own truth rule: never claim
        // "Executed" for a thread that never did), so it must flip here too, not
        // only in the approval-watch effect's own APPROVAL_DECIDED path below.
        everExecuted: updated.everExecuted || executing.instructionState === "executing",
      }
    }
    return updated
  }

  for (const event of events) {
    if (!traceEventMatchesInstructionId(event, next.instructionId)) continue
    switch (event.phase) {
      case "received": {
        if (next.machine.instructionState !== "captured") break
        next = { ...next, machine: transition(next.machine, { type: "ACK" }) }
        break
      }
      case "context_retrieved": {
        const raw = Array.isArray(event.payload.chips) ? (event.payload.chips as unknown[]) : []
        const real = raw
          .map((c) => (c && typeof c === "object" ? (c as { label?: unknown; source?: unknown }) : {}))
          .filter((c): c is { label: string; source: string } => typeof c.label === "string" && typeof c.source === "string")
        const existingKeys = new Set(next.contextChips.map((c) => `${c.label}·${c.source}`))
        const fresh = real.filter((c) => !existingKeys.has(`${c.label}·${c.source}`))
        if (fresh.length > 0) next = { ...next, contextChips: [...next.contextChips, ...fresh] }
        break
      }
      case "planning": {
        if (next.machine.instructionState !== "understanding") break
        next = { ...next, machine: transition(next.machine, { type: "TRACE_planning" }) }
        break
      }
      case "plan_ready": {
        const count = typeof event.payload.count === "number" ? event.payload.count : null
        next = { ...next, traceGating: { ...next.traceGating, expectedCount: count } }
        if (count === 0 && next.machine.instructionState === "planning") {
          const outcome = emptyPlanOutcome(next.machine, next.instructionText)
          next = outcome.clarification
            ? { ...next, machine: outcome.machine, clarification: outcome.clarification }
            : { ...next, machine: outcome.machine, terminalAtMs: Date.now() }
        }
        break
      }
      case "clarification_required": {
        if (next.clarification || next.machine.instructionState !== "planning") break
        const payload = event.payload as { question?: unknown; missingFields?: unknown; context?: unknown }
        next = {
          ...next,
          machine: transition(next.machine, { type: "TRACE_clarification" }),
          clarification: {
            question: typeof payload.question === "string" ? payload.question : "I need one more thing to continue.",
            missingFields: Array.isArray(payload.missingFields) ? payload.missingFields.filter((f): f is string => typeof f === "string") : [],
            context: typeof payload.context === "string" ? payload.context : undefined,
          },
        }
        break
      }
      case "action_created": {
        const thin = thinNodeFromTraceEvent(event.payload)
        if (thin && !next.nodes.some((n) => n.id === thin.id)) {
          next = { ...next, nodes: [...next.nodes, thin] }
        }
        break
      }
      case "action_gated": {
        const actionId = typeof event.payload.actionId === "string" ? event.payload.actionId : undefined
        next = resolveAction(next, actionId, "gated")
        break
      }
      case "completed":
      case "failed": {
        // Once canonical cancellation is observed, a late planner/query trace is
        // stale evidence from the losing generation and cannot resurrect Work.
        if (next.machine.instructionState === "cancelled") break
        const actionId = typeof event.payload.actionId === "string" ? event.payload.actionId : undefined
        const answerResult = event.phase === "completed" ? parseAnswerResult(event.payload) : null
        if (answerResult) {
          next = { ...next, answerResult: mergeAnswerResult(next.answerResult, answerResult) }
        }
        if (actionId) {
          // A per-action terminal outcome (this action ran synchronously and
          // ungated, inside the same handleInstruction call) — resolves gating;
          // the aggregate branch above ends the instruction once every action
          // has a terminal outcome.
          next = resolveAction(next, actionId, event.phase)
          // An answer result is a read-only completion. The reducer may have
          // traversed the legacy aggregate path to reach a terminal state, but
          // it must not leave behind an execution claim for the answer surface.
          if (answerResult) next = { ...next, answerResult: mergeAnswerResult(next.answerResult, answerResult), everExecuted: false, approvalWatch: null, runWatch: null }
        } else if (event.phase === "failed") {
          // No actionId: the whole instruction failed before any action existed
          // (a real planner exception — orchestration/src/index.ts's own P3.T3
          // try/catch around this.planner.plan()).
          const providerTimedOut =
            typeof event.payload.error === "string" && /(?:deadline|timed?\s*out|timeout)/i.test(event.payload.error)
          next = {
            ...next,
            machine: transition(next.machine, { type: "TRACE_failed" }),
            submitError: providerTimedOut
              ? "Planning took too long. Nothing was executed; you can retry safely."
              : "JARVIS could not prepare a safe plan. Nothing was executed; you can retry safely.",
            terminalAtMs: Date.now(),
          }
        }
        break
      }
      case "answer_result":
      case "answer-result":
      case "answerResult": {
        const answerResult = parseAnswerResult(event.payload)
        if (answerResult) next = { ...next, answerResult: mergeAnswerResult(next.answerResult, answerResult) }
        break
      }
      case "executing": {
        // The backend emits this at the real executor boundary, after dispatch
        // and immediately before an ungated action invokes its implementation.
        // Consume it as its own renderable transition so the active Work paints
        // while execution is genuinely in flight, before its terminal row.
        if (next.machine.instructionState === "planning") {
          next = {
            ...next,
            machine: transition(next.machine, { type: "ACTION_executing", gatedCount: 0 }),
            everExecuted: true,
            runWatch: { priorRunIds: new Set(), correlatedRunIds: new Set() },
          }
        }
        break
      }
      case "verifying": {
        const sourceKind = event.payload.sourceKind === "CANONICAL" || event.payload.sourceKind === "MEMORY" || event.payload.sourceKind === "WEB"
          ? event.payload.sourceKind
          : undefined
        next = {
          ...next,
          ...(next.machine.instructionState === "executing" ? { machine: transition(next.machine, { type: "TRACE_verifying" }) } : {}),
          progress: {
            stage: "verifying",
            ...(sourceKind ? { sourceKind } : {}),
            ...(typeof event.payload.actionId === "string" ? { actionId: event.payload.actionId } : {}),
            observedAt: event.createdAt,
          },
        }
        break
      }
      case "step_progress": {
        const stage = event.payload.stage
        if (
          stage !== "resolving_context"
          && stage !== "querying_business"
          && stage !== "querying_grounded_sources"
          && stage !== "researching_verified_external_sources"
        ) break
        const sourceKind = event.payload.sourceKind === "CANONICAL" || event.payload.sourceKind === "MEMORY" || event.payload.sourceKind === "WEB"
          ? event.payload.sourceKind
          : undefined
        next = {
          ...next,
          progress: {
            stage,
            ...(sourceKind ? { sourceKind } : {}),
            ...(typeof event.payload.actionId === "string" ? { actionId: event.payload.actionId } : {}),
            observedAt: event.createdAt,
          },
        }
        break
      }
      case "verified": {
        const sourceKind = event.payload.sourceKind === "CANONICAL" || event.payload.sourceKind === "MEMORY" || event.payload.sourceKind === "WEB"
          ? event.payload.sourceKind
          : next.progress?.sourceKind
        next = {
          ...next,
          progress: {
            stage: "verified",
            ...(sourceKind ? { sourceKind } : {}),
            ...(typeof event.payload.actionId === "string" ? { actionId: event.payload.actionId } : {}),
            observedAt: event.createdAt,
          },
        }
        break
      }
      case "cancelled": {
        // The first marker is a planner fence written before cleanup. Only the
        // second marker follows the canonical Work transition and may terminate
        // the visible thread. Older emitters omitted `canonical`; retain their
        // established terminal meaning unless they explicitly say false.
        if (event.payload.canonical === false) break
        next = {
          ...next,
          machine: transition(next.machine, { type: "USER_CANCELLED" }),
          answerResult: null,
          approvalWatch: null,
          runWatch: null,
          terminalAtMs: Date.now(),
        }
        break
      }
      // `dispatched` remains a measured trace fact with no distinct aggregate
      // machine state. The row is retained in the transport cursor.
      default:
        break
    }
  }
  if (next.answerResult && next.machine.instructionState !== "cancelled") {
    next = {
      ...next,
      machine: { instructionState: "completed" },
      everExecuted: false,
      approvalWatch: null,
      runWatch: null,
      terminalAtMs: next.terminalAtMs ?? Date.now(),
    }
  }
  return next
}

// ---------------------------------------------------------------------------
// Kernel context
// ---------------------------------------------------------------------------

/** Result exposed to the command rail so transcript ink is cleared only after
 * the authenticated instruction POST has resolved, and remains editable when
 * that POST fails. The kernel still owns the request and all thread state. */
export type SubmissionOutcome = "accepted" | "failed" | "stale"

export interface KernelState {
  mode: JarvisMode
  thread: Thread | null
  /** Presentation-only marker for a thread rebuilt from the refresh pointer.
   *  It suppresses mount-time one-shots only while the restored snapshot keeps
   *  its restored state; new real state edges remain eligible to animate. */
  threadRestored: boolean
  /** Count of real instruction_events fetched while rebuilding the current
   *  thread from the refresh pointer. Diagnostic-only; it is not business state. */
  restoredTraceEventCount: number
  /** jarvis-v3 P5.T8 — §2.2 "Threads stack newest-first; older threads
   *  collapse to a single row." Newest-superseded-first. Each entry is a
   *  real snapshot of a thread that WAS the active one, captured the instant
   *  a new top-level instruction superseded it (never a live reference —
   *  mutating the old thread further would be dishonest once it's "history"). */
  threadHistory: Thread[]
  recentThreads: DurableThreadSummary[]
  recentThreadsStatus: "idle" | "loading" | "live" | "unavailable"
  openThread: (threadId: string) => Promise<void>
  presence: Presence
  transport: TransportHealth
  selectorInput: SelectorInput
  lane: LanePresentation
  overdueInvoices: Truth<{ count: number; totalUsd: number }>
  collectedUsd: Truth<number>
  pendingApprovals: Truth<number>
  runsInFlight: Truth<number>
  micOpen: boolean
  voiceSpeaking: boolean
  setVoiceIndicators: (next: { micOpen?: boolean; speaking?: boolean }) => void
  submit: (text: string, source: InstructionSource, sessionIdOverride?: string) => Promise<SubmissionOutcome>
  continueWork: (text: string, source: InstructionSource, sessionIdOverride?: string) => Promise<SubmissionOutcome>
  answerClarification: (text: string) => Promise<SubmissionOutcome>
  cancelThread: () => Promise<void>
  retryThread: () => Promise<void>
  refetchSlowLaneNow: () => void
}

/** jarvis-v3 P5.T8 — a defensive, uncontroversial cap on how many superseded
 *  threads accumulate in one browser session (not specified by the plan;
 *  this session's own reasoned choice, recorded as a deviation). Oldest
 *  history entries drop first — the ACTIVE thread is never capped. */
const THREAD_HISTORY_CAP = 50

export function canContinueWork(thread: Pick<Thread, "workId" | "machine"> | null): boolean {
  return Boolean(thread?.workId && isTerminal(thread.machine.instructionState))
}

export function continuationIdentity(
  existing: Pick<Thread, "sessionId" | "workId" | "instructionId"> | null,
  fallbackSessionId: string,
): { sessionId: string; workId: string | null } {
  return {
    sessionId: existing?.sessionId ?? fallbackSessionId,
    workId: existing?.workId ?? existing?.instructionId ?? null,
  }
}

const KernelContext = createContext<KernelState | null>(null)

export function useKernel(): KernelState {
  const ctx = useContext(KernelContext)
  if (!ctx) throw new Error("useKernel() called outside <KernelProvider>")
  return ctx
}

function KernelInner({ children, mode }: { children: React.ReactNode; mode?: JarvisMode }) {
  const data = useJarvis()
  const auth = useJarvisAuth()
  const effectiveMode: JarvisMode = mode ?? (auth.session ? "production" : "preview")
  const selectorInput = useSelectorInput()
  const lane = useLanePresentation()
  const interaction = useOperatingInteractionActions()

  const [thread, setThread] = useState<Thread | null>(null)
  const [restoredThreadPresentation, setRestoredThreadPresentation] = useState<{ threadId: string; instructionState: InstructionState } | null>(null)
  const [restoredTraceEventCount, setRestoredTraceEventCount] = useState(0)
  const [threadHistory, setThreadHistory] = useState<Thread[]>([])
  const [recentThreads, setRecentThreads] = useState<DurableThreadSummary[]>([])
  const [recentThreadsStatus, setRecentThreadsStatus] = useState<KernelState["recentThreadsStatus"]>("idle")
  const refreshRecentThreads = useCallback(async () => {
    if (!auth.session) {
      setRecentThreads([])
      setRecentThreadsStatus("idle")
      return
    }
    setRecentThreadsStatus("loading")
    try {
      const response = await jarvisGet<{ threads?: DurableThreadSummary[] }>("threads", { limit: "50" })
      setRecentThreads(Array.isArray(response.threads) ? response.threads : [])
      setRecentThreadsStatus("live")
    } catch {
      // The active Work remains usable when the history list is temporarily
      // unavailable. Preserve the last verified list instead of fabricating one.
      setRecentThreadsStatus("unavailable")
    }
  }, [auth.session])

  useEffect(() => {
    if (!auth.loading) void refreshRecentThreads()
  }, [auth.loading, refreshRecentThreads])
  // jarvis-v3 P5.T8 — `runSubmission`'s own `useCallback` deps are
  // deliberately minimal (`[data.approvalsThisSession, data.rejectionsThisSession]`,
  // NOT `thread` — see its own eslint-disable comment), so reading `thread`
  // directly inside it would be stale. A plain ref kept in sync via a normal
  // effect (never inside a setState updater — this codebase has already been
  // bitten once by a StrictMode double-invoke bug from exactly that shape,
  // see P3's own real finding) is the safe way to read "the thread as of
  // right now" from that stable callback.
  const threadRef = useRef<Thread | null>(null)
  useEffect(() => {
    threadRef.current = thread
  }, [thread])
  const [micOpen, setMicOpen] = useState(false)
  const [voiceSpeaking, setVoiceSpeaking] = useState(false)
  const [terminalDecayActive, setTerminalDecayActive] = useState(false)
  const decayTimerRef = useRef<number | null>(null)
  // jarvis-v3 P3.T6: the CURRENT submission's own trace-transport handle. A ref,
  // not state — starting/stopping it is not itself a displayed fact (§4.7 only
  // governs facts a selector produces).
  const traceHandleRef = useRef<InstructionTransportHandle | null>(null)
  const traceCursorRef = useRef(0)
  const traceStatusRef = useRef<SseHealth>(null)
  const activeInstructionIdRef = useRef<string | null>(null)
  const traceQueueRef = useRef<Array<{ threadId: string; instructionId: string; event: TraceEvent }>>([])
  const traceQueueTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelInFlightRef = useRef(false)
  const traceQueueWaitersRef = useRef<Set<() => void>>(new Set())
  const answerResultInstructionIdsRef = useRef<Set<string>>(new Set())
  const approvalRef = useRef({ approvalsThisSession: 0, rejectionsThisSession: 0 })
  approvalRef.current = { approvalsThisSession: data.approvalsThisSession, rejectionsThisSession: data.rejectionsThisSession }

  const resolveTraceQueueWaiters = useCallback(() => {
    if (traceQueueRef.current.length > 0) return
    for (const resolve of traceQueueWaitersRef.current) resolve()
    traceQueueWaitersRef.current.clear()
  }, [])

  const processTraceQueue = useCallback(() => {
    traceQueueTimerRef.current = null
    const item = traceQueueRef.current.shift()
    if (item && activeInstructionIdRef.current === item.instructionId) {
      setThread((prev) =>
        prev && prev.id === item.threadId && prev.instructionId === item.instructionId
          ? applyTraceEvents(prev, [item.event], approvalRef.current)
          : prev,
      )
    }
    if (traceQueueRef.current.length > 0) {
      // A separate task is intentional: React must be able to commit the
      // Heard -> Understood -> Plan -> Execution changes between real rows that
      // arrived in one HTTP/SSE batch. The rows remain backend-authored; only the
      // presentation queue is paced to a frame-sized unit.
      traceQueueTimerRef.current = setTimeout(processTraceQueue, 0)
    } else {
      resolveTraceQueueWaiters()
    }
  }, [resolveTraceQueueWaiters])

  const enqueueTraceEvents = useCallback((threadId: string, instructionId: string, events: TraceEvent[]) => {
    // A stopped SSE/poll request can still resolve one queued callback after a
    // new turn starts. The local thread id is intentionally not enough here:
    // clarification answers continue the same thread id, so identity must be
    // checked against the exact instruction that opened this transport.
    if (activeInstructionIdRef.current !== instructionId) return
    const fresh = events
      .filter((event) => event.seq > traceCursorRef.current && traceEventMatchesInstructionId(event, instructionId))
      .sort((a, b) => a.seq - b.seq)
    if (fresh.length === 0) return
    traceCursorRef.current = fresh[fresh.length - 1]!.seq
    const phases = new Set(fresh.map((event) => event.phase))
    if (["action_created", "action_gated", "action_executing", "completed", "failed", "cancelled"].some((phase) => phases.has(phase))) {
      publishBusinessInvalidation({
        source: "trace",
        tags: phases.has("completed") || phases.has("failed")
          ? ["work", "actions", "approvals", "workflows", "receipts", "activity", "events", "customers", "schedule", "money", "agents", "queries"]
          : ["work", "actions", "approvals", "activity", "events"],
        path: `instructions/${instructionId}/events`,
      })
    }
    for (const event of fresh) {
      // The queue is keyed by the local Thread id, but the paint-measurement
      // bus is read by the rendered instruction id. Keep those identifiers
      // explicit; they are deliberately distinct for refresh continuity.
      recordTraceEventReceived(instructionId, event)
      if (parseAnswerResult(event.payload)) answerResultInstructionIdsRef.current.add(instructionId)
      traceQueueRef.current.push({ threadId, instructionId, event })
    }
    if (traceQueueTimerRef.current === null) {
      traceQueueTimerRef.current = setTimeout(processTraceQueue, 0)
    }
  }, [processTraceQueue])

  const drainTraceQueue = useCallback((timeoutMs: number): Promise<void> => {
    if (traceQueueRef.current.length === 0 && traceQueueTimerRef.current === null) return Promise.resolve()
    return new Promise((resolve) => {
      let timeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        timeout = null
        traceQueueWaitersRef.current.delete(done)
        resolve()
      }, timeoutMs)
      const done = () => {
        if (timeout !== null) clearTimeout(timeout)
        timeout = null
        resolve()
      }
      traceQueueWaitersRef.current.add(done)
    })
  }, [])

  const resetTraceQueue = useCallback(() => {
    traceQueueRef.current = []
    traceCursorRef.current = 0
    if (traceQueueTimerRef.current !== null) clearTimeout(traceQueueTimerRef.current)
    traceQueueTimerRef.current = null
    resolveTraceQueueWaiters()
  }, [resolveTraceQueueWaiters])

  useEffect(() => () => {
    traceHandleRef.current?.stop()
    resetTraceQueue()
  }, [resetTraceQueue])
  // jarvis-v3 P3.T11: the active thread's own SSE health (null when no thread is
  // tracing, or SSE is disabled) — a real selector-visible fact (feeds `transport`
  // below, which the rail's connection dot reads), so it IS state, unlike the
  // handle above.
  const [sseHealth, setSseHealth] = useState<SseHealth>(null)

  // jarvis-v3 P3.T8: restore a non-terminal thread after a refresh. Runs its
  // real attempt exactly once, the first time auth actually resolves to a real
  // session (never for a signed-out visitor — nothing of theirs to restore, and
  // the fetch would just 401). Best-effort: any failure (network, a 404 because
  // the row somehow never made it to the DB, auth not ready) leaves the pointer
  // in place and the rest state shows instead — never a crash, never a
  // fabricated thread.
  const restoreAttemptedRef = useRef(false)
  // Real bug found via live testing (P3.T8): this effect's own deps include
  // `auth.session`, and Supabase's client can hand out a NEW session object
  // reference shortly after sign-in (e.g. a follow-up auth-state event) even
  // when nothing meaningful changed — which re-runs this effect and, with a
  // PER-INVOCATION `cancelled` flag, ran this exact cleanup and cancelled the
  // already-in-flight restore fetch a moment before it could call setThread.
  // Both real GET calls completed, but the thread never appeared. A MOUNT-
  // scoped ref (only ever flipped by true unmount, below) fixes it — cancelling
  // an in-flight fetch on a same-mount effect re-run was never the intent;
  // `restoreAttemptedRef` already prevents starting a second attempt.
  const mountedRef = useRef(true)
  useEffect(() => {
    // Real second bug found via the SAME live test: React's dev-mode
    // StrictMode double-invokes an effect (mount -> cleanup -> mount again)
    // against the SAME ref. Setting `mountedRef.current = true` only via
    // `useRef`'s initial value meant the interim cleanup call flipped it to
    // false and nothing ever set it back — so the restore's own async
    // continuation always read "unmounted" and bailed right before
    // `setThread`, even though the component was genuinely still mounted.
    // Resetting it here, on every real (re)mount, is the standard fix.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  useEffect(() => {
    if (restoreAttemptedRef.current || auth.loading || !auth.session || thread) return
    const pointer = readActiveThreadPointer()
    if (!pointer) return
    restoreAttemptedRef.current = true
    activeInstructionIdRef.current = pointer.instructionId
    void (async () => {
      try {
        const [sessionRes, initialWorkRes] = await Promise.all([
          jarvisGet<{ instruction?: { id: string; workId?: string | null } }>(`instructions/${pointer.instructionId}`),
          pointer.workId ? jarvisGet<unknown>(`works/${pointer.workId}`).catch(() => null) : Promise.resolve(null),
        ])
        if (!sessionRes.instruction) {
          clearActiveThreadPointer()
          return
        }
        const durableWorkId = sessionRes.instruction.workId ?? pointer.workId ?? pointer.instructionId
        // A failed mutation may have created Work before the browser received
        // its identifier. The instruction row is authoritative on refresh; retry
        // the aggregate by that relationship if the optimistic id missed.
        const workRes = initialWorkRes ?? (durableWorkId !== pointer.workId
          ? await jarvisGet<unknown>(`works/${durableWorkId}`).catch(() => null)
          : null)
        interaction.restore(operatingInteractionFromWorkAggregate(workRes), durableWorkId)
        if (durableWorkId !== pointer.workId) {
          persistActiveThreadPointer({ ...pointer, workId: durableWorkId })
        }
        const eventsRes = await jarvisGet<{ events?: TraceEvent[] }>(`instructions/${pointer.instructionId}/events`, { after: "0" })
        const events = eventsRes.events ?? []
        if (!mountedRef.current || activeInstructionIdRef.current !== pointer.instructionId || threadRef.current) return
        const base: Thread = {
          id: pointer.id,
          sessionId: pointer.sessionId,
          conversationThreadId: pointer.conversationThreadId ?? null,
          instructionId: pointer.instructionId,
          workId: durableWorkId,
          source: pointer.source,
          instructionText: pointer.instructionText,
          createdAtMs: pointer.createdAtMs,
          machine: transition(initialMachineState, { type: "SUBMITTED" }),
          nodes: [],
          contextChips: [],
          progress: null,
          traceGating: { expectedCount: null, resolvedActionIds: [], gatedActionIds: [] },
          clarification: null,
          submitError: null,
          approvalWatch: null,
          runWatch: null,
          terminalAtMs: null,
          everExecuted: false,
          receiptRefreshTick: 0,
        }
        const traced = applyTraceEvents(base, events, {
          approvalsThisSession: data.approvalsThisSession,
          rejectionsThisSession: data.rejectionsThisSession,
        })
        const durable = submissionFromWorkAggregate(workRes)
        const enriched = durable.planned.length > 0
          ? { ...traced, nodes: enrichNodesFromPlanned(traced.nodes, durable.planned) }
          : traced
        const restored = durable.answer
          ? { ...enriched, machine: { instructionState: "completed" as const }, answerResult: mergeAnswerResult(enriched.answerResult, durable.answer), terminalAtMs: enriched.terminalAtMs ?? Date.now() }
          : enriched
        // Restored rows are real authenticated instruction_events fetched above,
        // not a replay fixture. Record their browser receipt at the same seam as
        // streamed/polled rows so the next-paint audit does not silently omit the
        // refresh path. The timestamp is intentionally the local fetch/application
        // boundary; it is not presented as backend event-creation latency.
        for (const event of events) recordTraceEventReceived(pointer.instructionId, event)
        setRestoredTraceEventCount(events.length)
        setRestoredThreadPresentation({ threadId: restored.id, instructionState: restored.machine.instructionState })
        setThread(restored)
        if (!isTerminal(restored.machine.instructionState)) {
          const lastSeq = events.length > 0 ? events[events.length - 1]!.seq : 0
          traceCursorRef.current = lastSeq
          traceHandleRef.current = startInstructionTransport({
            instructionId: pointer.instructionId,
            onEvents: (newEvents) => enqueueTraceEvents(pointer.id, pointer.instructionId, newEvents),
            onHealthChange: (health) => {
              if (activeInstructionIdRef.current !== pointer.instructionId) return
              traceStatusRef.current = health
              setSseHealth(health)
            },
            sinceSeq: lastSeq,
          })
        }
      } catch {
        // Best-effort — see this effect's own header.
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.loading, auth.session, thread])

  const setVoiceIndicators = useCallback((next: { micOpen?: boolean; speaking?: boolean }) => {
    if (next.micOpen !== undefined) setMicOpen(next.micOpen)
    if (next.speaking !== undefined) setVoiceSpeaking(next.speaking)
  }, [])

  // ---- transport health (P2 scope: polling only, §7.1) ----
  const degradedSinceRef = useRef<number | null>(null)
  useEffect(() => {
    if (data.statsDegraded) {
      if (degradedSinceRef.current === null) degradedSinceRef.current = data.now
    } else {
      degradedSinceRef.current = null
    }
  }, [data.statsDegraded, data.now])
  const degradedForMs = data.statsDegraded && degradedSinceRef.current !== null ? data.now - degradedSinceRef.current : null
  const transport = deriveTransportHealth({ signedIn: !!auth.session, statsDegraded: data.statsDegraded, degradedForMs, sseHealth })

  // ---- terminal decay timer (4s bloom, §5.3 M15) ----
  useEffect(() => {
    if (!thread || !isTerminal(thread.machine.instructionState) || thread.terminalAtMs === null) return
    setTerminalDecayActive(true)
    const elapsed = Date.now() - thread.terminalAtMs
    const remaining = Math.max(0, TERMINAL_DECAY_MS - elapsed)
    if (decayTimerRef.current) window.clearTimeout(decayTimerRef.current)
    decayTimerRef.current = window.setTimeout(() => setTerminalDecayActive(false), remaining)
    return () => {
      if (decayTimerRef.current) window.clearTimeout(decayTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread?.id, thread?.machine.instructionState, thread?.terminalAtMs])

  // Upgrade 4: the active Work remains addressable after a terminal transition.
  // A new top-level instruction replaces this pointer; navigation and refresh do
  // not erase the person's current receipt, query result, or recovery surface.

  const presence = derivePresence({
    transport,
    activeInstructionState: thread ? thread.machine.instructionState : null,
    terminalDecayActive,
    voiceSpeaking,
    micOpen,
    blockedCount: data.blockedActions.length,
    needsHumanReviewCount: data.blockedActions.filter((a) => a.status === "needs_human_review").length,
  })

  // ---- approval-watch reconciliation (P2-scope correlation, see file header) ----
  useEffect(() => {
    if (!thread || thread.machine.instructionState !== "awaiting_approval" || !thread.approvalWatch) return
    const watch = thread.approvalWatch

    // Don't evaluate against a pendingActions snapshot older than the moment we
    // started watching — see ApprovalWatch's own doc comment for the real race
    // this guards against.
    if (data.lastPollAtMs === null || data.lastPollAtMs <= watch.enteredAtMs) return

    const currentlyPending = new Set(data.pendingActions.map((a) => a.id))
    const everPendingIds = new Set(watch.everPendingIds)
    for (const id of watch.pendingNodeIds) {
      if (currentlyPending.has(id)) everPendingIds.add(id)
    }
    const stillPending = [...watch.pendingNodeIds].filter((id) => currentlyPending.has(id))

    if (stillPending.length > 0) {
      // Still waiting on at least one real decision — just remember what we've
      // seen pending so far and check again on the next poll.
      if (everPendingIds.size !== watch.everPendingIds.size) {
        setThread((prev) => (prev && prev.id === thread.id && prev.instructionId === thread.instructionId ? { ...prev, approvalWatch: { ...watch, everPendingIds } } : prev))
      }
      return
    }

    // Nothing of ours is currently pending. Split into "genuinely gated, and a
    // real decision removed it" vs. "never appeared pending at all" (ungated,
    // auto-executed — nothing for a human to approve, so it counts as approved).
    const neverGatedCount = watch.pendingNodeIds.size - everPendingIds.size
    const sessionApproved = Math.max(0, data.approvalsThisSession - watch.approvalsAtStart)
    const sessionRejected = Math.max(0, data.rejectionsThisSession - watch.rejectionsAtStart)
    const totalDecided = watch.pendingNodeIds.size
    const approvedCount = Math.min(totalDecided, neverGatedCount + sessionApproved)
    const rejectedCount = Math.min(totalDecided - approvedCount, sessionRejected)

    setThread((prev) => {
      if (!prev || prev.id !== thread.id || prev.instructionId !== thread.instructionId) return prev
      const nextMachine = transition(prev.machine, { type: "APPROVAL_DECIDED", approvedCount, rejectedCount, totalDecided })
      const nowExecuting = nextMachine.instructionState === "executing"
      return {
        ...prev,
        machine: nextMachine,
        approvalWatch: null,
        runWatch: nowExecuting ? { priorRunIds: new Set(data.runs.map((r) => r.id)), correlatedRunIds: new Set() } : prev.runWatch,
        terminalAtMs: isTerminal(nextMachine.instructionState) ? Date.now() : prev.terminalAtMs,
        everExecuted: prev.everExecuted || nowExecuting,
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread?.id, thread?.machine.instructionState, data.pendingActions, data.approvalsThisSession, data.rejectionsThisSession, data.lastPollAtMs])

  // ---- run-watch correlation + terminal detection ----
  // A run can move from running to terminal between two polls. Correlating only
  // the running list then loses it forever, which used to leave the rail disabled
  // even though the backend had finished. New runtime steps carry their originating
  // domainActionId; do not fall back to a tenant-wide set-diff because an unrelated
  // run must never complete this instruction's thread.
  useEffect(() => {
    if (!thread || thread.machine.instructionState !== "executing" || !thread.runWatch) return
    const watch = thread.runWatch
    const expected = thread.nodes.length
    if (expected === 0) return

    const visibleById = new Map([...data.runs, ...data.terminalRuns].map((run) => [run.id, run]))
    const expectedActionIds = new Set(thread.nodes.map((node) => node.id))
    const latestRunByAction = new Map<string, WorkflowRun>()
    for (const run of visibleById.values()) {
      for (const step of run.steps) {
        if (!step.domainActionId || !expectedActionIds.has(step.domainActionId)) continue
        const previous = latestRunByAction.get(step.domainActionId)
        if (!previous || new Date(run.updatedAt).getTime() >= new Date(previous.updatedAt).getTime()) {
          latestRunByAction.set(step.domainActionId, run)
        }
      }
    }

    const linkedRunIds = new Set([...latestRunByAction.values()].map((run) => run.id))
    const correlated = new Set([...watch.correlatedRunIds, ...linkedRunIds])
    if (correlated.size !== watch.correlatedRunIds.size) {
      setThread((prev) => (prev && prev.id === thread.id && prev.instructionId === thread.instructionId ? { ...prev, runWatch: { ...watch, correlatedRunIds: correlated } } : prev))
      return
    }
    if (correlated.size === 0 || correlated.size < expected) return // still waiting for every run to appear
    const relevant = [...correlated].map((id) => visibleById.get(id)).filter((run): run is WorkflowRun => Boolean(run))
    if (relevant.length < correlated.size) return // a correlated run is not in either current snapshot yet
    const relevantTerminal = relevant.filter((run) => run.status === "completed" || run.status === "failed" || run.status === "compensated")
    if (relevantTerminal.length < correlated.size) return // not all correlated runs are terminal yet
    const ok = relevantTerminal.filter((r) => r.status === "completed").length
    const failed = relevantTerminal.length - ok
    setThread((prev) => {
      if (!prev || prev.id !== thread.id || prev.instructionId !== thread.instructionId) return prev
      const nextMachine = transition(prev.machine, { type: "TERMINAL", ok, failed, total: relevantTerminal.length })
      return { ...prev, machine: nextMachine, runWatch: null, terminalAtMs: isTerminal(nextMachine.instructionState) ? Date.now() : prev.terminalAtMs }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread?.id, thread?.machine.instructionState, thread?.runWatch, data.runs, data.terminalRuns])

  // ---- payment-watch: the payment-webhook consequence (P4.T5, §6⑦'s "the
  // payment webhook lands minutes or hours later... the receipt updates in
  // place"). Reconciles against `data.events` exactly like approval-watch/
  // run-watch reconcile against `data.pendingActions`/`data.runs` above — one
  // reconciliation shape, not a second mechanism alongside P3's own
  // applyTraceEvents. A real `payment_recorded` business event
  // (packages/data-platform/src/payments.ts's recordBusinessEvent, fired by
  // the payment webhook) whose payload.invoiceId matches one of THIS thread's
  // own node payloads triggers an immediate slow-lane refetch (cashCollections
  // otherwise waits up to its own 30s cadence) and bumps receiptRefreshTick so
  // the already-shown receipt re-fetches in place. seenPaymentEventIdsRef
  // persists for the component's life (not per-thread) — a real event is only
  // ever actioned once, harmlessly, even across thread boundaries.
  const seenPaymentEventIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!thread) return
    const relevant = findRelevantPaymentEvents(data.events, invoiceIdsForThread(thread.nodes), seenPaymentEventIdsRef.current)
    if (relevant.length === 0) return
    for (const e of relevant) seenPaymentEventIdsRef.current.add(e.id)
    data.refetchSlowLaneNow()
    setThread((prev) => (prev && prev.id === thread.id && prev.instructionId === thread.instructionId ? { ...prev, receiptRefreshTick: prev.receiptRefreshTick + 1 } : prev))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread?.id, thread?.nodes, data.events])

  const runSubmission = useCallback(
    async (text: string, source: InstructionSource, existing: Thread | null, sessionIdOverride?: string) => {
      // A voice or text continuation inherits the active Work's session and
      // durable Work identity. Only a genuinely new Work consults the source-
      // specific browser session. This is the backend identity seam; the UI does
      // not merely look continuous while submitting an unrelated Work.
      const fallbackSessionId = existing ? existing.sessionId : sessionIdOverride ?? getOrCreateSessionId(source)
      const identity = continuationIdentity(existing, fallbackSessionId)
      const activeContext = interaction.capture(source, identity.workId)
      const sessionId = identity.sessionId
      const id = existing?.id ?? newId()
      // jarvis-v3 P3.T6: always freshly minted, never reused across turns — this
      // exact submission's own instruction_events trace, distinct from sessionId
      // (which persists for follow-up-reference continuity, kernel/instruction.ts).
      const instructionId = mintInstructionId()
      const nowMs = Date.now()

      traceHandleRef.current?.stop()
      traceHandleRef.current = null
      resetTraceQueue()
      activeInstructionIdRef.current = instructionId
      traceStatusRef.current = null
      setSseHealth(null)
      setRestoredTraceEventCount(0)

      // jarvis-v3 P5.T8 — §2.2 "Threads stack newest-first." A genuinely NEW
      // top-level instruction (`existing === null` — never a clarification
      // answer, which continues the SAME thread in place, §4.4) supersedes
      // whatever was active: snapshot it into history before it's replaced.
      if (!existing && threadRef.current) {
        const superseded = threadRef.current
        setThreadHistory((prev) => [superseded, ...prev].slice(0, THREAD_HISTORY_CAP))
      }

      // ① HEARD — captured, immediately, with the verbatim text (§6①).
      const continuity = carryThreadContinuity(existing)
      setRestoredThreadPresentation(null)
      setThread({
        id,
        sessionId,
        conversationThreadId: existing?.conversationThreadId ?? null,
        instructionId,
        workId: identity.workId ?? instructionId,
        interactionContext: activeContext,
        source,
        instructionText: text,
        createdAtMs: nowMs,
        machine: transition(initialMachineState, { type: "SUBMITTED" }),
        nodes: continuity.nodes,
        contextChips: continuity.contextChips,
        progress: null,
        traceGating: { expectedCount: null, resolvedActionIds: [], gatedActionIds: [] },
        clarification: null,
        submitError: null,
        cancelError: null,
        approvalWatch: null,
        runWatch: null,
        terminalAtMs: null,
        everExecuted: existing?.everExecuted ?? false,
        receiptRefreshTick: existing ? existing.receiptRefreshTick : 0,
      })
      // Survive navigation and refresh. A later response rebinds the optimistic
      // instruction id below to the server-authored durable Work id.
      persistActiveThreadPointer({ id, sessionId, instructionId, workId: identity.workId ?? instructionId, ...(existing?.conversationThreadId ? { conversationThreadId: existing.conversationThreadId } : {}), source, instructionText: text, createdAtMs: nowMs })

      // jarvis-v3 P3.T6/T7: the trace poll starts THE SAME INSTANT as the POST
      // below — both race the real backend from the same starting line
      // (kernel/instruction.ts's own header) — so HEARD->UNDERSTOOD->PLAN can
      // render as `handleInstruction` actually does the work (context chips, plan
      // nodes appearing one at a time), not after its whole response resolves.
      // Guarded on `prev.id === id`, same convention every setThread callback in
      // this file already uses.
      traceHandleRef.current = startInstructionTransport({
        instructionId,
        onEvents: (events) => {
          enqueueTraceEvents(id, instructionId, events)
        },
        onHealthChange: (health) => {
          if (activeInstructionIdRef.current !== instructionId) return
          traceStatusRef.current = health
          setSseHealth(health)
        },
      })

      let result: Awaited<ReturnType<typeof submitInstruction>>
      try {
        result = await submitInstruction(text, { source, sessionId, instructionId, workId: identity.workId ?? undefined, threadId: existing?.conversationThreadId ?? undefined, activeContext })
      } catch (err) {
        if (activeInstructionIdRef.current !== instructionId) return "stale"
        const errorEnvelope = err instanceof JarvisApiError && err.details && typeof err.details === "object" && !Array.isArray(err.details)
          ? err.details as Record<string, unknown>
          : null
        const errorWorkId = typeof errorEnvelope?.workId === "string" ? errorEnvelope.workId : null
        if (errorWorkId) {
          persistActiveThreadPointer({ id, sessionId, instructionId, workId: errorWorkId, ...(existing?.conversationThreadId ? { conversationThreadId: existing.conversationThreadId } : {}), source, instructionText: text, createdAtMs: nowMs })
          setThread((prev) => prev && prev.id === id && prev.instructionId === instructionId ? { ...prev, workId: errorWorkId } : prev)
        }
        // The backend records lifecycle facts before returning an error. Reconcile
        // that durable terminal row before stopping transport, otherwise a POST
        // failure that arrives after `planning` can strand the UI there forever.
        // The same cursor/dedupe queue remains the sole event application path.
        try {
          enqueueTraceEvents(id, instructionId, await fetchTraceEvents(instructionId, traceCursorRef.current))
          await drainTraceQueue(1_500)
        } catch {
          // If the trace boundary itself is unavailable, the bounded local failure
          // below is the honest recovery surface.
        }
        traceHandleRef.current?.stop()
        setSseHealth(null)
        const timedOut = err instanceof Error && /(?:deadline|timed?\s*out|timeout)/i.test(err.message)
        setThread((prev) =>
          prev && prev.id === id && prev.instructionId === instructionId
            ? isTerminal(prev.machine.instructionState)
              ? prev
              : {
                  ...prev,
                  machine: transition(prev.machine, { type: "SUBMIT_FAILED" }),
                  submitError: timedOut
                    ? "Planning took too long. Nothing was executed; you can retry safely."
                    : "JARVIS could not reach the operating system. Nothing was executed; you can retry safely.",
                  terminalAtMs: Date.now(),
                }
            : prev,
        )
        return "failed"
      }

      // The POST can resolve after a clarification answer or a newer top-level
      // instruction has already replaced this turn. Its planned rows are no
      // longer authoritative for the visible thread or the optimistic inbox.
      if (activeInstructionIdRef.current !== instructionId) return "stale"

      persistActiveThreadPointer({
        id,
        sessionId,
        instructionId,
        workId: result.workId ?? existing?.workId ?? instructionId,
        ...(result.threadId ? { conversationThreadId: result.threadId } : {}),
        source,
        instructionText: text,
        createdAtMs: nowMs,
      })
      interaction.bindWork(result.workId ?? existing?.workId ?? instructionId)

      // ② UNDERSTOOD / ③ PLAN — the trace transport above may already have driven ACK,
      // TRACE_planning, TRACE_clarification and every action_created node by the
      // time this resolves (P3's own real improvement: event->pixel is now
      // typically far under the ~4s the whole POST round trip used to take). What
      // follows is now a SAFETY NET, not the primary driver: it (a) enriches any
      // thin trace-created nodes with this response's fuller amount/target/
      // policy/groundedPayload data, (b) fills in anything the trace poll missed
      // (a slow first tick, a dropped event), and (c) is still the sole driver of
      // the AGGREGATE awaiting_approval/executing transition and its
      // approvalWatch/runWatch side-registration — this phase's own deliberate
      // scope decision (see `applyTraceEvents`'s own header) to keep that
      // coordination in one place rather than duplicating it.
      const planned = result.planned
      const directAnswerResult = parseSubmissionAnswer(result.answer, result.query)
      if (directAnswerResult) answerResultInstructionIdsRef.current.add(instructionId)
      const clarificationRow = planned.find((p) => p.actionType === "clarification_request")

      // Drain the real rows once more after POST resolves. This closes the race
      // where the backend has committed every event but the browser's first poll
      // or SSE frame has not reached React yet. It is a snapshot safety net, not a
      // second source of truth: the same cursor/dedupe path feeds the same queue.
      if (traceStatusRef.current !== "unavailable") {
        try {
          enqueueTraceEvents(id, instructionId, await fetchTraceEvents(instructionId, traceCursorRef.current))
        } catch (error) {
          // A missing route/table is an integration state, not an empty trace. Keep
          // the status visible and use the POST response only as the explicit,
          // labelled fallback below.
          const status =
            error && typeof error === "object" && "status" in error && typeof (error as { status?: unknown }).status === "number"
              ? (error as { status: number }).status
              : 0
          if (status !== 0 && activeInstructionIdRef.current === instructionId) {
            traceStatusRef.current = "unavailable"
            setSseHealth("unavailable")
          }
        }
      }
      await drainTraceQueue(1_500)
      if (activeInstructionIdRef.current !== instructionId) return "stale"
      const traceDelivered = traceCursorRef.current > 0
      const usePostFallback = !traceDelivered || traceStatusRef.current === "unavailable"
      if (usePostFallback && !traceDelivered && traceStatusRef.current !== "unavailable") {
        // A healthy-looking socket with zero lifecycle rows is not evidence that
        // the trace contract is live. Keep the POST response as the bounded,
        // explicit fallback and leave the rail red so the UI never implies that
        // Heard/Plan/Execution were event-driven when no event reached the page.
        traceStatusRef.current = "unavailable"
        setSseHealth("unavailable")
      }

      setThread((prev) => {
        if (!prev || prev.id !== id || prev.instructionId !== instructionId) return prev
        if (directAnswerResult) {
          return {
            ...prev,
            workId: result.workId,
            conversationThreadId: result.threadId,
            machine: { instructionState: "completed" },
            nodes: [],
            clarification: null,
            answerResult: mergeAnswerResult(prev.answerResult, directAnswerResult),
            approvalWatch: null,
            runWatch: null,
            everExecuted: false,
            terminalAtMs: prev.terminalAtMs ?? Date.now(),
          }
        }
        const enrichedNodes = enrichNodesFromPlanned(prev.nodes, planned, usePostFallback)
        const m = usePostFallback && prev.machine.instructionState === "captured" ? transition(prev.machine, { type: "ACK" }) : prev.machine
        return { ...prev, workId: result.workId, conversationThreadId: result.threadId, machine: m, nodes: enrichedNodes }
      })

      setThread((prev) => {
        if (!prev || prev.id !== id || prev.instructionId !== instructionId) return prev
        if (directAnswerResult) return prev
        if (!usePostFallback) return prev
        let m = prev.machine.instructionState === "understanding" ? transition(prev.machine, { type: "TRACE_planning" }) : prev.machine
        if (planned.length === 0) {
          const outcome = emptyPlanOutcome(m, prev.instructionText)
          return outcome.clarification
            ? { ...prev, machine: outcome.machine, nodes: [], clarification: outcome.clarification }
            : { ...prev, machine: outcome.machine, nodes: [], clarification: null, terminalAtMs: Date.now() }
        }
        if (clarificationRow) {
          if (prev.clarification) return { ...prev, machine: m } // the trace already delivered it
          const payload = clarificationRow.payload as { question?: string; missingFields?: string[]; context?: string }
          m = m.instructionState === "planning" ? transition(m, { type: "TRACE_clarification" }) : m
          return {
            ...prev,
            machine: m,
            clarification: {
              question: typeof payload.question === "string" ? payload.question : "I need one more thing to continue.",
              missingFields: Array.isArray(payload.missingFields) ? payload.missingFields.filter((f): f is string => typeof f === "string") : [],
              context: typeof payload.context === "string" ? payload.context : undefined,
            },
          }
        }
        // No clarification: every real business action in this plan requires
        // approval by default (§6⑤: "Every one of these needs your approval") —
        // `defaultPolicy()`'s own requiresConfirmation is `true`, verified at
        // orchestration/src/index.ts:60. The exact per-action gated/ungated split
        // is not yet in this response (`planned[].status` is the planner's
        // pre-execution "draft" value, not the post-gate outcome — verified at
        // orchestration/src/planner.ts:422/`.returning()`); the approval-watch
        // effect above reconciles against the REAL `pendingActions` list the
        // instant the next poll lands, the same bridge `CommandBar.tsx`'s existing
        // `injectOptimisticPending` already relies on. A plan that turns out to be
        // fully ungated self-corrects there rather than getting stuck.
        if (m.instructionState !== "planning") return { ...prev, machine: m } // already moved past this
        m = transition(m, { type: "ACTION_pending", count: planned.length })
        return {
          ...prev,
          machine: m,
          clarification: null,
          approvalWatch:
            m.instructionState === "awaiting_approval"
              ? {
                  pendingNodeIds: new Set(prev.nodes.map((n) => n.id)),
                  approvalsAtStart: data.approvalsThisSession,
                  rejectionsAtStart: data.rejectionsThisSession,
                  enteredAtMs: Date.now(),
                  everPendingIds: new Set(),
                }
              : null,
        }
      })
      // Nothing more will ever change this turn's own trace (a gated plan's real
      // backend trace stops at action_gated; the aggregate decision above is now
      // made) — stop the transport rather than waiting out the full 120s ceiling.
      if (activeInstructionIdRef.current === instructionId) {
        traceHandleRef.current?.stop()
        if (traceStatusRef.current !== "unavailable") setSseHealth(null)

        // An answer completion is read-only. Do not leak its planned helper row
        // into the tenant-wide optimistic approval queue; similarly, never inject
        // rows from a response that belonged to a superseded instruction.
        if (!answerResultInstructionIdsRef.current.has(instructionId)) {
          data.injectOptimisticPending(
            planned
              .filter((p) => p.actionType !== "clarification_request")
              .map((p) => ({
                id: p.id,
                instructionId,
                actionType: p.actionType,
                summary: null,
                payload: p.payload,
                status: "pending",
                createdAt: p.createdAt,
                groundedPayload: p.groundedPayload ?? undefined,
              })),
          )
        }
      }
      void refreshRecentThreads()
      return "accepted"
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.approvalsThisSession, data.rejectionsThisSession, drainTraceQueue, enqueueTraceEvents, resetTraceQueue, interaction, refreshRecentThreads],
  )

  const retryThread = useCallback(async () => {
    const current = threadRef.current
    if (!current || current.machine.instructionState !== "failed") return
    // A retry is a new durable input/trace turn on the SAME Work. The failed
    // planner attempt remains immutable while receiveWork moves the Work through
    // recovery and the new attempt gets its own instruction id/idempotency claim.
    await runSubmission(current.instructionText, current.source, current)
  }, [runSubmission])

  const submit = useCallback((text: string, source: InstructionSource, sessionIdOverride?: string) => runSubmission(text, source, null, sessionIdOverride), [runSubmission])

  const continueWork = useCallback((text: string, source: InstructionSource, sessionIdOverride?: string) => {
    const current = threadRef.current
    if (!canContinueWork(current)) return Promise.resolve<SubmissionOutcome>("failed")
    return runSubmission(text, source, current, sessionIdOverride)
  }, [runSubmission])

  const openThread = useCallback(async (threadId: string) => {
    const loaded = await jarvisGet<{ thread: DurableThreadSummary; messages?: DurableThreadMessage[] }>(`threads/${threadId}`, { limit: "100" })
    const messages = Array.isArray(loaded.messages) ? loaded.messages : []
    const lastUser = [...messages].reverse().find((message) => message.role === "user")
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant")
    const workId = lastUser?.workId ?? loaded.thread.activeWorkId
    const workAggregate = workId ? await jarvisGet<unknown>(`works/${workId}`).catch(() => null) : null
    if (workId) interaction.restore(operatingInteractionFromWorkAggregate(workAggregate), workId)
    const workStatus = workAggregate && typeof workAggregate === "object" && "work" in workAggregate
      ? String((workAggregate as { work?: { status?: unknown } }).work?.status ?? "")
      : ""
    let instructionState: InstructionState = "completed"
    if (["received", "understanding", "planning"].includes(workStatus)) instructionState = "planning"
    else if (["ready", "actionable", "awaiting_approval"].includes(workStatus)) instructionState = "awaiting_approval"
    else if (["executing", "waiting", "blocked", "recovery"].includes(workStatus)) instructionState = "executing"
    else if (workStatus === "failed") instructionState = "failed"
    else if (workStatus === "cancelled") instructionState = "cancelled"
    if (threadRef.current && threadRef.current.conversationThreadId !== threadId) {
      setThreadHistory((previous) => [threadRef.current!, ...previous].slice(0, THREAD_HISTORY_CAP))
    }
    traceHandleRef.current?.stop()
    activeInstructionIdRef.current = null
    const createdAtMs = new Date(lastUser?.createdAt ?? loaded.thread.createdAt).getTime()
    const restored: Thread = {
      id: threadId,
      conversationThreadId: threadId,
      sessionId: getOrCreateSessionId("typed"),
      instructionId: lastUser?.instructionId ?? null,
      workId,
      interactionContext: operatingInteractionFromWorkAggregate(workAggregate),
      source: "typed",
      instructionText: lastUser?.originalText ?? loaded.thread.title ?? "Conversation",
      createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : Date.now(),
      machine: { instructionState },
      nodes: [],
      contextChips: [],
      progress: null,
      answerResult: lastAssistant ? { kind: "answer", spokenSummary: lastAssistant.originalText } : null,
      traceGating: { expectedCount: null, resolvedActionIds: [], gatedActionIds: [] },
      clarification: null,
      submitError: null,
      cancelError: null,
      approvalWatch: null,
      runWatch: null,
      terminalAtMs: isTerminal(instructionState) ? Date.now() : null,
      everExecuted: ["executing", "completed", "partial"].includes(instructionState),
      receiptRefreshTick: 0,
    }
    setRestoredThreadPresentation({ threadId, instructionState })
    setRestoredTraceEventCount(0)
    setThread(restored)
    if (lastUser?.instructionId) {
      persistActiveThreadPointer({
        id: threadId,
        sessionId: restored.sessionId,
        instructionId: lastUser.instructionId,
        ...(workId ? { workId } : {}),
        conversationThreadId: threadId,
        source: "typed",
        instructionText: restored.instructionText,
        createdAtMs: restored.createdAtMs,
      })
    }
  }, [interaction])

  const threadRestored = Boolean(
    thread &&
    restoredThreadPresentation?.threadId === thread.id &&
    restoredThreadPresentation.instructionState === thread.machine.instructionState,
  )

  const answerClarification = useCallback(
    async (text: string) => {
      // §4.4: "clarifying + ANSWERED -> captured (same thread, new turn)". The
      // The SAME presentation thread and durable Work continue. The new
      // instruction id remains an independently traceable input while workId and
      // sessionId preserve causal and conversational context.
      setThread((prev) => (prev ? { ...prev, machine: transition(prev.machine, { type: "ANSWERED" }) } : prev))
      const current = thread
      if (!current) return "failed"
      return runSubmission(text, current.source, current)
    },
    [thread, runSubmission],
  )

  const cancelThread = useCallback(async () => {
    const current = threadRef.current
    if (!current || cancelInFlightRef.current) return
    const returnTo = current.machine.instructionState
    if (!["captured", "understanding", "planning", "clarifying", "awaiting_approval", "executing", "verifying"].includes(returnTo)) return
    cancelInFlightRef.current = true
    setThread((prev) => prev && prev.id === current.id
      ? { ...prev, machine: transition(prev.machine, { type: "USER_CANCEL_REQUESTED" }), cancelError: null }
      : prev)
    try {
      if (current.instructionId) {
        await jarvisPost(`instructions/${current.instructionId}/cancel`, {})
      }
      if (threadRef.current?.id !== current.id) return
      activeInstructionIdRef.current = null
      traceHandleRef.current?.stop()
      setSseHealth(null)
      setThread((prev) => (prev && prev.id === current.id ? { ...prev, machine: transition(prev.machine, { type: "USER_CANCELLED" }), cancelError: null, terminalAtMs: Date.now() } : prev))
    } catch (error) {
      setThread((prev) => prev && prev.id === current.id
        ? prev.machine.instructionState === "stopping" ? {
            ...prev,
            machine: transition(prev.machine, { type: "CANCEL_FAILED", returnTo: returnTo as CancelableInstructionState }),
            cancelError: error instanceof Error ? `Cancellation did not reach the server: ${error.message}` : "Cancellation did not reach the server. Try again.",
          } : prev
        : prev)
    } finally {
      cancelInFlightRef.current = false
    }
  }, [])

  const value = useMemo<KernelState>(
    () => ({
      mode: effectiveMode,
      thread,
      threadRestored,
      restoredTraceEventCount,
      threadHistory,
      recentThreads,
      recentThreadsStatus,
      openThread,
      presence,
      transport,
      selectorInput,
      lane,
      overdueInvoices: selectOverdueInvoices(selectorInput),
      collectedUsd: selectCollectedUsd(selectorInput),
      pendingApprovals: selectPendingApprovals(selectorInput),
      runsInFlight: selectRunsInFlight(selectorInput),
      micOpen,
      voiceSpeaking,
      setVoiceIndicators,
      submit,
      continueWork,
      answerClarification,
      cancelThread,
      retryThread,
      refetchSlowLaneNow: data.refetchSlowLaneNow,
    }),
    [effectiveMode, thread, threadRestored, restoredTraceEventCount, threadHistory, recentThreads, recentThreadsStatus, openThread, presence, transport, selectorInput, lane, micOpen, voiceSpeaking, setVoiceIndicators, submit, continueWork, answerClarification, cancelThread, retryThread, data.refetchSlowLaneNow],
  )

  return <KernelContext.Provider value={value}>{children}</KernelContext.Provider>
}

/** Adds the instruction kernel to an already-mounted auth/data context. This is
 * the shared seam used by the canonical role landing so a route does not create
 * a second polling/auth stack just to render the Thread. */
export function KernelSurface({ children, mode }: { children: React.ReactNode; mode?: JarvisMode }) {
  return <KernelInner mode={mode}>{children}</KernelInner>
}

export function KernelProvider({ children, mode }: { children: React.ReactNode; mode?: JarvisMode }) {
  return <KernelSurface mode={mode}>{children}</KernelSurface>
}
