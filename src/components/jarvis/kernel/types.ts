// JARVIS kernel — canonical types (plan v3 §4.2).
//
// `Truth<T>` is the contract that makes plan v2's C-01 structurally impossible:
// a 401 rendering as a confident `$0` with a sparkline. A value cannot reach the
// screen without carrying how it is known. §5.5 fixes exactly what each status
// renders as; a number renders for `known`, `stale` and `partial` only.
//
// Do not rename anything in this file (§4).

export type TruthSource =
  | "api:stats" | "api:actions-pending" | "api:workflow-runs" | "api:read-model"
  | "api:activity" | "api:receipts" | "api:instruction" | "derived" | "fixture"

export type Truth<T> =
  | { status: "known";       value: T; source: TruthSource; atMs: number }
  | { status: "stale";       value: T; source: TruthSource; atMs: number; ageMs: number }
  | { status: "partial";     value: T; source: TruthSource; atMs: number; capped: number }
  | { status: "unknown";     reason: "loading" | "never-fetched" }
  | { status: "denied";      reason: "signed-out" | "role" }
  | { status: "unavailable"; reason: "network" | "server" | "not-configured"; sinceMs: number }

/** Route-owned presentation posture; it labels the surface's data contract and
 * never reclassifies business records or replaces backend authority. */
export type JarvisMode = "production" | "showcase" | "preview"

// ---------------------------------------------------------------------------
// P2.T1 — canonical entity states, copied byte-for-byte from
// finnor-os/packages/db/schema.ts (plan v3 §4.3). Do not rename anything here.
// ---------------------------------------------------------------------------

export type ActionState =   // schema.ts:193
  | "draft" | "pending" | "approved" | "rejected" | "executing"
  | "completed" | "failed" | "needs_human_review" | "blocked_integration_unavailable"
export type RunState =      // schema.ts:921
  | "running" | "completed" | "failed" | "compensating" | "compensated"
  | "paused" | "cancelled" | "escalated"
export type StepState =     // schema.ts:943
  | "pending" | "leased" | "completed" | "failed" | "compensating" | "compensated"
export type JobState =      // schema.ts:345
  | "queued" | "running" | "completed" | "failed" | "dead_letter"

// ---------------------------------------------------------------------------
// P7.T1 — failure presentation taxonomy (plan v3 §6.8).
//
// This is intentionally a UI recovery taxonomy rather than a copy of the
// backend ErrorKind union. The backend retains its own error kind on the receipt;
// `recovery.ts` maps that value to one of these eight prescribed affordances.
// ---------------------------------------------------------------------------

export type RecoveryKind =
  | "transient"
  | "policy_denied"
  | "integration_unavailable"
  | "invalid_input"
  | "tool_error"
  | "timeout"
  | "compensated"
  | "needs_human"

// ---------------------------------------------------------------------------
// P2.T1 — canonical instruction lifecycle. `stopping` is the honest local state
// between a user's cancellation request and canonical server confirmation.
// ---------------------------------------------------------------------------

export type InstructionState =
  | "idle" | "captured" | "understanding" | "planning" | "clarifying"
  | "awaiting_approval" | "executing" | "verifying" | "stopping"
  | "completed" | "partial" | "failed" | "cancelled"

export type CancelableInstructionState =
  | "captured" | "understanding" | "planning" | "clarifying"
  | "awaiting_approval" | "executing" | "verifying"

/** §4.4 events — every named event a machine transition responds to. `RESET` is
 *  valid from any state. Unlisted (state, event) pairs are a no-op + dev warning,
 *  never a crash (§4.4's own binding rule). */
export type InstructionEvent =
  | { type: "SUBMITTED" }
  | { type: "SUBMIT_FAILED" }
  | { type: "ACK" }
  | { type: "TRACE_planning" }
  | { type: "TRACE_clarification" }
  | { type: "ACTION_pending"; count: number }
  | { type: "ACTION_executing"; gatedCount: number }
  | { type: "TRACE_failed" }
  | { type: "PLAN_EMPTY" }
  | { type: "ANSWERED" }
  | { type: "USER_CANCEL_REQUESTED" }
  | { type: "USER_CANCELLED" }
  | { type: "CANCEL_FAILED"; returnTo: CancelableInstructionState }
  | { type: "APPROVAL_DECIDED"; approvedCount: number; rejectedCount: number; totalDecided: number }
  | { type: "TRACE_verifying" }
  | { type: "TERMINAL"; ok: number; failed: number; total: number }
  | { type: "ACTION_needs_human_review" }
  | { type: "RUN_escalated" }
  | { type: "RESET" }

// ---------------------------------------------------------------------------
// P2.T1 — Presence, the Orb's only input (plan v3 §4.5). Do not rename anything
// here. Derivation order lives in `kernel/presence.ts`.
// ---------------------------------------------------------------------------

export type Presence =
  | "dormant" | "listening" | "hearing" | "thinking" | "asking"
  | "proposing" | "working" | "verifying" | "resolved" | "wounded"
  | "obstructed" | "severed"
