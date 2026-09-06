"use client"

// JARVIS kernel — instruction submission (plan v3 P2.T4, closing the V8 gap) +
// the instruction lifecycle trace poll (plan v3 P3.T6, §7.1 Stage 1).
//
// `CommandBar.tsx:51` posts `{ instruction }` only — the backend's own
// `SubmitInstructionSchema` already accepts `sessionId` and `handleInstruction`
// already writes/reads short-term turn memory keyed by it (verified:
// `finnor-os/apps/api/app/api/actions/route.ts:31` passes `{ sessionId:
// body.data.sessionId }` straight through). Follow-up references ("actually make
// that Thursday") are a solved backend problem; the frontend simply never sent
// the key that unlocks it. This file is the fix, and nothing else — the Thread's
// own instruction/session concept, not a replacement for `CommandBar` (left
// unedited per this session's binding: "read, not edited").

import { jarvisGet, jarvisPost } from "../lib/api"
import type { OperationalQueryExecution } from "../workspaces/contracts"
import type { OperatingInteractionContextValue } from "./operating-interaction"

export type InstructionSource = "voice" | "typed"

const SESSION_STORAGE_KEYS: Record<InstructionSource, string> = {
  voice: "jarvis.session.voice",
  typed: "jarvis.session.typed",
}

let fallbackCounter = 0

function mintSessionId(source: InstructionSource): string {
  const prefix = source === "voice" ? "web" : "typed"
  return `${prefix}:${uuid()}`
}

// crypto.randomUUID() is available in every runtime this app ships to (browsers
// since 2022, Node 19+). The fallback below is NOT a randomness substitute (this
// repo's own ESLint rule bans Math.random() anywhere under src/components/jarvis
// — Phase 7 §7.8, "nothing here may fake a metric or activity effect") — it is a
// monotonic, crypto-free tiebreaker so a session id is still unique-per-tab even
// on a runtime old enough to lack crypto.randomUUID at all.
function uuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID()
  fallbackCounter += 1
  return `nocrypto-${Date.now()}-${fallbackCounter}`
}

/** One stable session id per browser-voice-session and per typed-session, kept in
 *  `sessionStorage` (plan v3 §3.4/P2.T4: "persisted in sessionStorage") so a
 *  follow-up instruction later in the same tab still resolves against the SAME
 *  backend short-term-memory window (30-min TTL, server-side). A page reload
 *  intentionally starts a fresh session — sessionStorage, not localStorage. */
export function getOrCreateSessionId(source: InstructionSource): string {
  if (typeof window === "undefined") return mintSessionId(source)
  const key = SESSION_STORAGE_KEYS[source]
  const existing = window.sessionStorage.getItem(key)
  if (existing) return existing
  const fresh = mintSessionId(source)
  try {
    window.sessionStorage.setItem(key, fresh)
  } catch {
    // Private-mode storage denial degrades to "no continuity this submission" —
    // never a crash; the instruction still submits with a fresh id.
  }
  return fresh
}

/** Minted-fresh, never reused — the golden journey supports one active thread at
 *  a time (§2.2), so every genuinely new instruction (not a clarification answer,
 *  not a follow-up the user explicitly wants threaded) starts a clean turn window.
 *  Exposed separately from `getOrCreateSessionId` because voice barge-in / thread
 *  stacking (P5) will want to explicitly rotate the session; P2 does not. */
export function resetSessionId(source: InstructionSource): string {
  const fresh = mintSessionId(source)
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.setItem(SESSION_STORAGE_KEYS[source], fresh)
    } catch {
      // see getOrCreateSessionId
    }
  }
  return fresh
}

/** Use the provider's call identity when it is available. The backend's voice
 * path already namespaces Vapi calls this way, so browser turns from one call
 * share the same short-term conversation without making a call id global. */
export function sessionIdForVoiceCall(callId: string | null | undefined): string | null {
  const normalized = typeof callId === "string" ? callId.trim() : ""
  return normalized ? `vapi:${normalized}` : null
}

/** jarvis-v3 P3.T6: a FRESH id per submission (never persisted, never reused across
 *  turns — unlike sessionId) so the concurrent trace poll (`startTracePoll`, below)
 *  can target this exact call's own `instruction_events` rows. Minted by the CALLER
 *  (kernel/store.tsx) before either the trace poll or the POST itself fires, so both
 *  race against the backend from the same starting line — see this file's own
 *  header. */
export function mintInstructionId(): string {
  return uuid()
}

export interface SubmitInstructionOpts {
  source: InstructionSource
  /** Explicit override — omit to use/mint this source's own persisted session id
   *  (the common case). A clarification answer passes the SAME id its parent
   *  thread used, since it is the next turn of the same conversation. */
  sessionId?: string
  /** P3.T6: this exact submission's own trace id, minted by the caller via
   *  `mintInstructionId()` — sent to `POST /api/actions` so the concurrent trace
   *  poll and the POST's own (possibly slower) resolution describe the same real
   *  server-side work. Optional only so this file's own unit tests can omit it. */
  instructionId?: string
  /** Existing durable Work for a clarification/follow-up continuation. */
  workId?: string
  /** Canonical Postgres thread. Session/call ids remain transport-only. */
  threadId?: string
  /** Exact visible business context captured at the shared text/voice seam. */
  activeContext?: OperatingInteractionContextValue
}

/** The shape `POST /api/actions` returns for each planned `DomainAction` — the
 *  fields the Thread's plan/clarification/execution blocks read. Kept structural
 *  (not importing the backend's own type) the same way `CommandBar.tsx`'s local
 *  `PlannedAction` already does, since this is a client module reading a JSON
 *  response, not sharing a build-time type with the API package. */
export interface PlannedActionResponse {
  id: string
  actionType: string
  payload: Record<string, unknown>
  policyId: string | null
  policyVersion?: number | null
  /** Real sibling action ids from domain_actions.depends_on. The API returns
   *  this durable DAG fact alongside each planned action when it is available. */
  dependsOn?: string[] | null
  status: string
  createdAt: string
  groundedPayload?: Array<{ field: string; status: "verified" | "not_found" | "unverifiable" }> | null
  reasoning?: string
}

export interface AnswerResponseFact {
  label: string
  value: string
  source?: string
}

/** Additive read-only answer returned alongside `planned` by the actions API.
 *  The display projection is optional so the client remains compatible with
 *  both the direct fast lane and older trace-shaped answer envelopes. */
export interface AnswerResponse {
  kind: "answer"
  spokenSummary: string
  displaySummary?: string
  facts?: AnswerResponseFact[]
  display?: {
    title?: string
    facts?: AnswerResponseFact[]
  }
  query?: OperationalQueryExecution
}

export interface SubmitInstructionResult {
  planned: PlannedActionResponse[]
  answer?: AnswerResponse
  query?: OperationalQueryExecution
  sessionId: string
  workId: string | null
  instructionId: string | null
  threadId: string | null
  assistantMessage?: { id: string; originalText: string; createdAt: string }
}

/** The one path an instruction (typed or spoken) enters the system by (§3.2:
 *  "voice and text are one code path"). Mints/reuses this source's session id and
 *  sends it in the POST body — the single change that closes V8's frontend gap. */
export async function submitInstruction(text: string, opts: SubmitInstructionOpts): Promise<SubmitInstructionResult> {
  const sessionId = opts.sessionId ?? getOrCreateSessionId(opts.source)
  const body = await jarvisPost<{ planned?: PlannedActionResponse[]; answer?: AnswerResponse; query?: OperationalQueryExecution; workId?: string; instructionId?: string; threadId?: string; assistantMessage?: { id: string; originalText: string; createdAt: string } }>("actions", {
    instruction: text,
    channel: opts.source === "voice" ? "voice" : "text",
    sessionId,
    instructionId: opts.instructionId,
    workId: opts.workId,
    threadId: opts.threadId,
    activeContext: opts.activeContext,
  })
  return {
    planned: body.planned ?? [],
    ...(body.answer ? { answer: body.answer } : {}),
    ...(body.query ? { query: body.query } : {}),
    sessionId,
    workId: body.workId ?? opts.workId ?? opts.instructionId ?? null,
    instructionId: body.instructionId ?? opts.instructionId ?? null,
    threadId: body.threadId ?? opts.threadId ?? null,
    ...(body.assistantMessage ? { assistantMessage: body.assistantMessage } : {}),
  }
}

// ---------------------------------------------------------------------------
// P3.T6 — the instruction lifecycle trace poll (§7.1 Stage 1).
// ---------------------------------------------------------------------------

/** One row of `instruction_events`, as `GET /api/instructions/:id/events` returns it. */
export interface TraceEvent {
  seq: number
  phase: string
  payload: Record<string, unknown>
  createdAt: string
  /** Optional envelope metadata. Most trace rows are scoped by the URL rather
   * than repeating this value, but when a provider includes it we validate it. */
  instructionId?: string
}

/** Phases that end the trace for this instruction — no further row will ever be
 *  written for it (mirrors the backend's own reachable set: a GATED plan's real
 *  trace stops at `action_gated`, since approval/execution happens through a wholly
 *  separate later request; only a fully-synchronous ungated action, or a genuine
 *  planning failure, ever reaches one of these three from `handleInstruction`
 *  itself — see orchestration/src/index.ts's own P3.T3 comment). */
const TERMINAL_TRACE_PHASES = new Set(["completed", "failed", "cancelled"])

/** §7.1/§8 PHASE 3 binding: 400ms interval, 120s ceiling, stops on any terminal phase. */
export const TRACE_POLL_INTERVAL_MS = 400
export const TRACE_POLL_CEILING_MS = 120_000

export interface TracePollHandle {
  stop: () => void
}

export type TracePollStatus = "polling" | "reconnecting" | "unavailable"

export interface TracePollFailure {
  status: number
  message: string
  attempts: number
}

export interface TracePollOptions {
  /** Called whenever the poller's real transport state changes. */
  onStatus?: (status: TracePollStatus, failure?: TracePollFailure) => void
  /** Maximum consecutive network/5xx failures before the poll gives up. */
  maxConsecutiveFailures?: number
  /** A short startup grace for the real race where the poll beats POST's row insert. */
  maxNotFoundRetries?: number
}

export const TRACE_POLL_MAX_FAILURES = 3
export const TRACE_POLL_MAX_NOT_FOUND_RETRIES = 6
export const TRACE_POLL_RETRY_BASE_MS = 400

function isTraceEvent(value: unknown): value is TraceEvent {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<TraceEvent>
  return (
    typeof candidate.seq === "number" && Number.isInteger(candidate.seq) && candidate.seq >= 0 &&
    typeof candidate.phase === "string" &&
    Boolean(candidate.payload) && typeof candidate.payload === "object" && !Array.isArray(candidate.payload) &&
    typeof candidate.createdAt === "string" &&
    (candidate.instructionId === undefined || typeof candidate.instructionId === "string")
  )
}

function normalizeTraceEvents(events: unknown, instructionId?: string): TraceEvent[] {
  if (!Array.isArray(events)) return []
  return events
    .filter(isTraceEvent)
    .filter((event) => instructionId === undefined || event.instructionId === undefined || event.instructionId === instructionId)
    .sort((a, b) => a.seq - b.seq)
}

function apiStatus(error: unknown): number {
  if (!error || typeof error !== "object") return 0
  const status = (error as { status?: unknown }).status
  return typeof status === "number" ? status : 0
}

/** One bounded, authenticated snapshot. The kernel uses this after POST resolves
 *  to drain a poll/SSE race without promoting the whole POST response to an event. */
export async function fetchTraceEvents(instructionId: string, sinceSeq = 0): Promise<TraceEvent[]> {
  const res = await jarvisGet<{ events?: unknown }>(`instructions/${instructionId}/events`, { after: String(sinceSeq) })
  return normalizeTraceEvents(res.events, instructionId)
}

/** Polls `GET /api/instructions/:id/events?after={lastSeq}` every 400ms, calling
 *  `onEvents` with each newly-arrived batch (ascending seq, never re-delivered).
 *  Stops itself the instant a terminal-phase event arrives, or at the 120s ceiling —
 *  whichever is first. The caller (kernel/store.tsx) may also call `.stop()` earlier
 *  once the thread's own machine state has moved past where this trace can still
 *  usefully inform it (e.g. `awaiting_approval`) — stopping early is always safe,
 *  never loses an already-delivered event. A transient poll failure never fabricates
 *  lifecycle data: it reports `reconnecting`, retries on a capped exponential
 *  schedule, and becomes `unavailable` after the finite network/404 budget is spent. */
export function startTracePoll(
  instructionId: string,
  onEvents: (events: TraceEvent[]) => void,
  /** jarvis-v3 P3.T8: resume from a seq already seen (a restored thread's own last
   *  event) instead of re-delivering everything from 0 — the restore effect
   *  already replayed history up to this point via a direct events fetch. */
  sinceSeq = 0,
  options: TracePollOptions = {},
): TracePollHandle {
  let lastSeq = sinceSeq
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const startedAtMs = Date.now()
  let consecutiveFailures = 0
  let notFoundRetries = 0
  let lastStatus: TracePollStatus | null = null
  const maxConsecutiveFailures = options.maxConsecutiveFailures ?? TRACE_POLL_MAX_FAILURES
  const maxNotFoundRetries = options.maxNotFoundRetries ?? TRACE_POLL_MAX_NOT_FOUND_RETRIES

  function report(status: TracePollStatus, failure?: TracePollFailure): void {
    if (lastStatus === status && !failure) return
    lastStatus = status
    if (failure) options.onStatus?.(status, failure)
    else options.onStatus?.(status)
  }

  function stop(): void {
    if (stopped) return
    stopped = true
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function schedule(delayMs: number): void {
    if (stopped) return
    timer = setTimeout(() => void tick(), delayMs)
  }

  async function tick(): Promise<void> {
    if (stopped) return
    try {
      const events = await fetchTraceEvents(instructionId, lastSeq)
      if (stopped) return
      consecutiveFailures = 0
      notFoundRetries = 0
      report("polling")
      if (events.length > 0) {
        lastSeq = events[events.length - 1]!.seq
        onEvents(events)
        if (events.some((e) => TERMINAL_TRACE_PHASES.has(e.phase))) {
          stop()
          return
        }
      }
    } catch (error) {
      // A 404 is expected for a short window because this poll starts before the
      // POST has inserted instruction_sessions. It is not retried forever: after
      // the bounded grace it means this route/schema is absent or the id is not
      // visible to this tenant. All other transient failures get their own finite
      // exponential retry ladder. Never fabricates an event.
      const status = apiStatus(error)
      const isNotFound = status === 404
      const attempts = isNotFound ? notFoundRetries + 1 : consecutiveFailures + 1
      if (isNotFound) notFoundRetries = attempts
      else consecutiveFailures = attempts
      const limit = isNotFound ? maxNotFoundRetries : maxConsecutiveFailures
      const terminalAuthFailure = status === 401 || status === 403
      if (terminalAuthFailure || attempts >= limit) {
        report("unavailable", {
          status,
          message: error instanceof Error ? error.message : "Instruction trace unavailable",
          attempts,
        })
        stop()
        return
      }
      report("reconnecting", {
        status,
        message: error instanceof Error ? error.message : "Instruction trace retrying",
        attempts,
      })
    }
    if (stopped) return
    if (Date.now() - startedAtMs >= TRACE_POLL_CEILING_MS) {
      stop()
      return
    }
    const failures = Math.max(consecutiveFailures, notFoundRetries)
    const delay = failures > 0 ? TRACE_POLL_RETRY_BASE_MS * 2 ** (failures - 1) : TRACE_POLL_INTERVAL_MS
    schedule(Math.min(delay, TRACE_POLL_INTERVAL_MS * 4))
  }

  void tick()
  return { stop }
}
