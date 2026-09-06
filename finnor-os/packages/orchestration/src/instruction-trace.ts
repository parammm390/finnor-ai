// jarvis-v3 P3.T2 (plan v3 §7.1/§8 PHASE 3): the instruction lifecycle trace.
// `instruction_sessions`/`instruction_events` (migration 0062, unapplied this session —
// see JARVIS-FRONTEND-MAESTRO-STATE-v3.md BLOCKER for why) back the frontend's 400ms
// trace poll. Ordinary presentation trace writes are best-effort. Cancellation
// markers are different: they are execution fences, so their write/read paths are
// explicitly fail-closed.

import { withTenant, instructionSessions, instructionEvents, receiveWork } from "@finnor/db";
import { and, eq, sql } from "drizzle-orm";
import { getLogger } from "@finnor/tools";
import { redactStructured, redactText } from "@finnor/security";
import type { AnswerEnvelope } from "./fast-read-lane";
import { isRetiredWaterAction, type OperatingEvidenceKind } from "@finnor/shared-types";

// 15 values, verbatim from this session's own binding list — see migration 0062's own
// comment on the "14 vs 15" discrepancy between that list's stated count and its
// actual enumerated tokens. Do not invent, rename, or drop any (binding rule).
export const INSTRUCTION_EVENT_PHASES = [
  "received",
  "context_retrieved",
  "planning",
  "plan_ready",
  "clarification_required",
  "action_created",
  "action_gated",
  "dispatched",
  "executing",
  "step_progress",
  "verifying",
  "verified",
  "completed",
  "failed",
  "cancelled",
] as const;
export type InstructionEventPhase = (typeof INSTRUCTION_EVENT_PHASES)[number];

/** The only answer result shape the browser trace is allowed to receive. The
 *  grounded query result remains in the executor/receipt path; it is never copied
 *  into this envelope. */
export interface InstructionTraceAnswerResult {
  kind: "answer";
  spokenSummary: string;
  display?: Record<string, unknown>;
  displaySummary?: string;
  facts?: Array<{ label: string; value: string; source?: string }>;
  evidence?: Array<{ source: string; ref: string; timestamp: string; title?: string; kind?: OperatingEvidenceKind }>;
  asOf?: string;
  freshness?: { status: "fresh" | "stale" | "unknown"; observedAt: string };
}

export interface InstructionTraceResultEnvelope {
  actionId: string;
  result: InstructionTraceAnswerResult;
}

// These are read-only answer-capable action types. Membership is only a fallback
// for older plugins that did not stamp expected.answered; it is never sufficient
// when the executor says the action is waiting for approval.
const READ_ONLY_ANSWER_ACTION_TYPES = new Set([
  "search_web",
]);

export function isReadOnlyAnswerAction(actionType: string, expected: Record<string, unknown> | undefined, awaitingApproval: boolean): boolean {
  if (awaitingApproval || isRetiredWaterAction(actionType)) return false;
  return expected?.answered === true || READ_ONLY_ANSWER_ACTION_TYPES.has(actionType);
}

// A substantive cited research answer regularly exceeds 1,200 characters. The old
// cap cut production responses in the middle of a sentence and could delete the
// requested third takeaway. This is still a bounded, PII-scrubbed user-facing field;
// 4,000 characters is enough for a complete concise answer without turning the trace
// into a raw execution-payload transport.
const MAX_TRACE_SPOKEN_SUMMARY_LENGTH = 4_000;
const MAX_TRACE_DISPLAY_DEPTH = 4;
const MAX_TRACE_DISPLAY_ENTRIES = 20;
const MAX_TRACE_DISPLAY_ITEMS = 12;
const MAX_TRACE_DISPLAY_STRING_LENGTH = 240;

// These keys are deliberately denied even when a plugin accidentally places them
// under its displaySafe projection. The trace is a browser-facing channel, not a
// second receipt or memory transport.
const PRIVATE_TRACE_KEY = /^(?:grounded(?:On|Payload)?|memory|semantic(?:Snippets?)?|citations?|raw|payload|data|error|secret|password|apiKey)$/i;

function sanitizeSpokenSummary(value: unknown): string {
  if (typeof value !== "string") return "";
  return redactText(value)
    .value.replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TRACE_SPOKEN_SUMMARY_LENGTH);
}

function sanitizeDisplayValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    return redactText(value)
      .value.replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_TRACE_DISPLAY_STRING_LENGTH);
  }
  if (depth >= MAX_TRACE_DISPLAY_DEPTH) return undefined;
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_TRACE_DISPLAY_ITEMS)
      .map((item) => sanitizeDisplayValue(item, depth + 1))
      .filter((item): item is NonNullable<typeof item> => item !== undefined);
  }
  if (typeof value !== "object") return undefined;

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, MAX_TRACE_DISPLAY_ENTRIES)) {
    if (PRIVATE_TRACE_KEY.test(key)) continue;
    const sanitized = sanitizeDisplayValue(entry, depth + 1);
    if (sanitized !== undefined) result[key.slice(0, 80)] = sanitized;
  }
  return result;
}

/** Sanitizes only an explicitly display-safe projection; arbitrary execution
 *  output is never used as a fallback source for structured trace data. */
export function sanitizeInstructionTraceDisplay(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const redacted = redactStructured(value);
  const sanitized = sanitizeDisplayValue(redacted, 0);
  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) return undefined;
  return Object.keys(sanitized).length > 0 ? (sanitized as Record<string, unknown>) : undefined;
}

function fallbackSpokenSummary(output: Record<string, unknown>): string {
  return "The requested information is ready.";
}

function sanitizeOutputEvidence(output: Record<string, unknown>): NonNullable<InstructionTraceAnswerResult["evidence"]> {
  if (!Array.isArray(output.citations)) return [];
  return output.citations
    .slice(0, MAX_TRACE_DISPLAY_ITEMS)
    .map((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
      const citation = candidate as Record<string, unknown>;
      const source = sanitizeSpokenSummary(citation.provider ?? citation.source ?? "source").slice(0, 120);
      const ref = sanitizeSpokenSummary(citation.url ?? citation.ref ?? citation.citationId).slice(0, 500);
      const timestamp = sanitizeSpokenSummary(citation.retrievedAt ?? citation.timestamp ?? citation.asOf).slice(0, 80);
      const title = sanitizeSpokenSummary(citation.title).slice(0, 200);
      const explicitKind = citation.evidenceKind ?? citation.kind;
      const kind: OperatingEvidenceKind | undefined = explicitKind === "CANONICAL" || explicitKind === "WORK" || explicitKind === "PROFILE" || explicitKind === "SESSION" || explicitKind === "MEMORY" || explicitKind === "WEB"
        ? explicitKind
        : /^(?:exa|firecrawl|web|research)/i.test(source) || /^https?:\/\//i.test(ref) ? "WEB"
          : /semantic|memory|correction/i.test(source) ? "MEMORY"
            : /(?:postgres|structured|snapshot|business.state|company|deal|workstream|request|finding|risk|dependency|closing|evidence|read.model)/i.test(source) ? "CANONICAL"
              : undefined;
      if (!source || !ref) return null;
      return { source, ref, timestamp: timestamp || new Date().toISOString(), ...(title ? { title } : {}), ...(kind ? { kind } : {}) };
    })
    .filter((citation): citation is NonNullable<typeof citation> => Boolean(citation));
}

/** Builds the privacy-conscious payload for a successful read-only answer. */
export function createInstructionTraceResultEnvelope(actionId: string, output: Record<string, unknown>): InstructionTraceResultEnvelope {
  const display = sanitizeInstructionTraceDisplay(output.displaySafe);
  const evidence = sanitizeOutputEvidence(output);
  const spokenSummary =
    sanitizeSpokenSummary(output.spokenSummary) ||
    sanitizeSpokenSummary(output.answer) ||
    sanitizeSpokenSummary(output.recommendation) ||
    sanitizeSpokenSummary(fallbackSpokenSummary(output));
  return {
    actionId,
    result: {
      kind: "answer",
      spokenSummary,
      ...(display ? { display } : {}),
      ...(evidence.length > 0 ? { evidence } : {}),
    },
  };
}

/** Trace adapter for the deterministic fast lane. Keep the richer AnswerEnvelope
 * fields bounded and display-safe so instruction_events never becomes a raw data
 * transport. The legacy output adapter above remains unchanged for existing plugins. */
export function createInstructionTraceAnswerEnvelope(actionId: string, answer: AnswerEnvelope): InstructionTraceResultEnvelope {
  const display = sanitizeInstructionTraceDisplay(answer.display);
  const facts = answer.display.facts
    .slice(0, MAX_TRACE_DISPLAY_ITEMS)
    .map((fact) => ({
      label: sanitizeSpokenSummary(fact.label).slice(0, 120),
      value: sanitizeSpokenSummary(fact.value).slice(0, MAX_TRACE_DISPLAY_STRING_LENGTH),
    }))
    .filter((fact) => Boolean(fact.label && fact.value));
  const evidence = answer.evidence
    .slice(0, MAX_TRACE_DISPLAY_ITEMS)
    .map((citation) => ({
      source: sanitizeSpokenSummary(citation.source).slice(0, 120),
      ref: sanitizeSpokenSummary(citation.ref).slice(0, 240),
      timestamp: sanitizeSpokenSummary(citation.timestamp).slice(0, 80),
      ...(citation.kind ? { kind: citation.kind } : {}),
    }))
    .filter((citation) => Boolean(citation.source && citation.ref && citation.timestamp));
  return {
    actionId,
    result: {
      kind: "answer",
      spokenSummary: sanitizeSpokenSummary(answer.spokenSummary),
      ...(display ? { display } : {}),
      displaySummary: sanitizeSpokenSummary(answer.display.title),
      ...(facts.length > 0 ? { facts } : {}),
      ...(evidence.length > 0 ? { evidence } : {}),
      ...(typeof answer.asOf === "string" ? { asOf: sanitizeSpokenSummary(answer.asOf).slice(0, 80) } : {}),
      freshness: {
        status: answer.freshness.status,
        observedAt: sanitizeSpokenSummary(answer.freshness.observedAt).slice(0, 80),
      },
    },
  };
}

export interface EnsureInstructionSessionOpts {
  sessionId?: string;
  userId?: string;
  source?: "typed" | "voice";
  workId?: string;
}

function nullableUuid(value: string | undefined): string | null {
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

/** Idempotent — a second call for the same (tenantId, instructionId) is a no-op (the
 *  row IS the claim, same `onConflictDoNothing` shape as intake-idempotency's own
 *  claim insert). Must be called (and resolve) before the first `emitInstructionEvent`
 *  for this instructionId — `instruction_events.instruction_id` foreign-keys here. */
export async function ensureInstructionSession(
  tenantId: string,
  instructionId: string,
  instructionText: string,
  opts: EnsureInstructionSessionOpts = {},
): Promise<void> {
  try {
    // Compatibility callers that only know the legacy instruction trace API still
    // get a first-class Work. receiveWork writes the trace projection itself and is
    // idempotent on instructionId, so no old entry point can create an orphan.
    if (!opts.workId) {
      await receiveWork({
        tenantId,
        instruction: instructionText,
        instructionId,
        sessionId: opts.sessionId,
        userId: opts.userId,
        channel: opts.source === "voice" ? "voice" : "text",
      });
      return;
    }
    await withTenant(tenantId, (db) =>
      db
        .insert(instructionSessions)
        .values({
          id: instructionId,
          tenantId,
          workId: opts.workId ?? null,
          sessionId: opts.sessionId ?? null,
          userId: nullableUuid(opts.userId),
          instructionText,
          source: opts.source ?? "typed",
        })
        .onConflictDoNothing(),
    );
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err), instructionId },
      "[instruction-trace] ensureInstructionSession failed (non-fatal — no trace this turn, real instruction unaffected)",
    );
  }
}

/** Monotonic `seq` per instructionId, read-then-insert inside `withTenant`'s own
 *  transaction. The real write pattern this system has (one instructionId, one
 *  synchronous `handleInstruction` call as its only writer) makes this safe in
 *  practice; the UNIQUE(instruction_id, seq) constraint (migration 0062) turns any
 *  genuine race into a caught, logged insert failure rather than silent corruption.
 *  Callers may require the write when the event is an execution fence. No-ops (does
 *  not throw, does not write) when `instructionId` is absent — the phone
 *  (`webhooks/vapi/route.ts`) and async
 *  worker (`process-instruction.ts`) paths never send one and are untouched by this
 *  phase. */
export async function emitInstructionEvent(
  tenantId: string,
  instructionId: string | undefined,
  phase: InstructionEventPhase,
  // Trace payloads are JSON objects, but not every safe envelope is an index-
  // signature-shaped `Record<string, unknown>` (the fast-read result is a
  // deliberately closed interface). Keep this boundary structural so the
  // compiler checks the caller's object shape without forcing an unsafe cast.
  payload: object = {},
  options: { required?: boolean } = {},
): Promise<void> {
  if (!instructionId) return;
  try {
    await withTenant(tenantId, async (db) => {
      // Serialize every writer for one instruction before allocating the next
      // sequence number. Cancellation is a separate HTTP request and can race a
      // planning trace; locking the owning session makes the append-only ledger
      // genuinely monotonic instead of relying on the old single-writer assumption.
      await db.execute(sql`SELECT id FROM ${instructionSessions} WHERE ${instructionSessions.id} = ${instructionId} AND ${instructionSessions.tenantId} = ${tenantId} FOR UPDATE`);
      const [row] = await db
        .select({ maxSeq: sql<number>`coalesce(max(${instructionEvents.seq}), 0)::int` })
        .from(instructionEvents)
        .where(eq(instructionEvents.instructionId, instructionId));
      const nextSeq = (row?.maxSeq ?? 0) + 1;
      await db.insert(instructionEvents).values({
        tenantId,
        instructionId,
        seq: nextSeq,
        phase,
        payload,
      });
    });
  } catch (err) {
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err), instructionId, phase },
      options.required
        ? "[instruction-trace] required instruction event failed"
        : "[instruction-trace] emitInstructionEvent failed (non-fatal — trace gap, real instruction unaffected)",
    );
    if (options.required) throw err;
  }
}

export function isInstructionCancellationPayload(value: unknown): boolean {
  const payload = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  // Historical action rejections used the instruction-level phase with only an
  // actionId. They are not global cancellation fences and must not suppress
  // sibling actions. Current instruction cancellation carries fence/canonical
  // metadata and no action-scoped identity.
  return typeof payload.actionId !== "string" || payload.fence === true || payload.canonical === true;
}

export async function isInstructionCancelled(tenantId: string, instructionId: string | undefined): Promise<boolean> {
  if (!instructionId) return false;
  try {
    const [row] = await withTenant(tenantId, (db) =>
      db
        .select({ id: instructionEvents.id })
        .from(instructionEvents)
        .where(and(
          eq(instructionEvents.tenantId, tenantId),
          eq(instructionEvents.instructionId, instructionId),
          eq(instructionEvents.phase, "cancelled"),
          sql`(
            jsonb_typeof(${instructionEvents.payload}->'actionId') IS DISTINCT FROM 'string'
            OR ${instructionEvents.payload}->>'fence' = 'true'
            OR ${instructionEvents.payload}->>'canonical' = 'true'
          )`,
        ))
        .limit(1),
    );
    return Boolean(row);
  } catch (err) {
    // This read is an execution fence, not ordinary trace observability. Unknown
    // cancellation state must stop planning/effects until the durable ledger is
    // readable again.
    getLogger().warn(
      { err: err instanceof Error ? err.message : String(err), instructionId },
      "[instruction-trace] cancellation lookup failed; refusing to continue",
    );
    throw err;
  }
}
