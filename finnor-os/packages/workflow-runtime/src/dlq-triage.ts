// A4.T3: rule-based DLQ auto-triage — ErrorKind × provider × count → a suggested
// disposition stored on the row. Purely advisory: dlq.ts's owner-gated replayDeadLetter/
// discardDeadLetter are completely unchanged by this — an owner still makes the actual
// call, this just pre-computes a recommendation instead of leaving them to review a raw
// row cold. Kept out of dlq.ts itself (that file is replay/discard only) and out of the
// API route files, same "thin route, real logic lives in workflow-runtime" convention
// this package already follows throughout.

import { withTenant, deadLetters } from "@finnor/db";
import { and, eq } from "drizzle-orm";
import type { ErrorKind } from "@finnor/shared-types";

export type Disposition = "replay" | "discard" | "escalate";

export interface TriageSuggestion {
  disposition: Disposition;
  reason: string;
}

type DeadLetterRow = typeof deadLetters.$inferSelect;

// A dead letter has no dedicated "provider" column — the envelope's own `type` (e.g.
// a provider-specific event type) is the finest-grained real signal available for "this kind
// of failure, from this kind of event," so it doubles as the provider/family axis rather
// than guessing at a delimiter convention this codebase doesn't actually establish
// anywhere. Honest interpretation, not a fabricated field.
function eventFamily(row: DeadLetterRow): string {
  const envelope = row.envelope as { type?: string } | null;
  return envelope?.type ?? "unknown";
}

// A cluster of ≥3 OTHER currently-open dead letters in the same event family suggests a
// systemic/provider-wide problem worth a human look, rather than something to replay one
// row at a time — real, queryable signal (current open rows), not an invented metric.
const CLUSTER_ESCALATE_THRESHOLD = 3;
const REPEATED_ATTEMPTS_ESCALATE_THRESHOLD = 3;

const NEVER_REPLAY_KINDS: ReadonlySet<ErrorKind> = new Set(["validation", "terminal", "auth"]);
const HUMAN_OR_CONFIG_KINDS: ReadonlySet<ErrorKind> = new Set(["needs_human", "config", "unknown_outcome"]);

/** Pure — unit-testable without a DB round trip. `otherOpenInFamily` is the count of
 *  OTHER open dead letters sharing this row's event family, computed by the caller. */
export function suggestDisposition(row: DeadLetterRow, otherOpenInFamily: number): TriageSuggestion {
  const kind = row.errorKind as ErrorKind;

  if (!row.replayable || NEVER_REPLAY_KINDS.has(kind)) {
    return { disposition: "discard", reason: `${kind} failures don't resolve by replaying — the same input will fail the same way.` };
  }
  if (HUMAN_OR_CONFIG_KINDS.has(kind)) {
    return { disposition: "escalate", reason: `${kind} means a person needs to act (fix a setting, make a call) before a replay could ever succeed.` };
  }
  if (otherOpenInFamily >= CLUSTER_ESCALATE_THRESHOLD) {
    return {
      disposition: "escalate",
      reason: `${otherOpenInFamily + 1} open dead letters share this event type right now — looks systemic, worth a human look instead of replaying one at a time.`,
    };
  }
  if (row.attempts >= REPEATED_ATTEMPTS_ESCALATE_THRESHOLD) {
    return { disposition: "escalate", reason: `Already retried ${row.attempts} times and still failing — unlikely a blind replay changes the outcome.` };
  }
  return { disposition: "replay", reason: `${kind}, few attempts (${row.attempts}), isolated — looks transient and safe to retry.` };
}

/** Recomputes suggestions for every OPEN dead letter for a tenant. Idempotent — always
 *  overwrites with the current-best suggestion, so no separate "already triaged" state to
 *  track, and a row's suggestion never goes stale as its cluster grows or shrinks. */
export async function triageOpenDeadLetters(tenantId: string): Promise<{ triaged: number }> {
  const open = await withTenant(tenantId, (db) =>
    db.select().from(deadLetters).where(and(eq(deadLetters.tenantId, tenantId), eq(deadLetters.status, "open"))),
  );
  if (open.length === 0) return { triaged: 0 };

  const familyCounts = new Map<string, number>();
  for (const row of open) {
    const family = eventFamily(row);
    familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1);
  }

  for (const row of open) {
    const family = eventFamily(row);
    const otherOpenInFamily = (familyCounts.get(family) ?? 1) - 1;
    const { disposition, reason } = suggestDisposition(row, otherOpenInFamily);
    await withTenant(tenantId, (db) =>
      db.update(deadLetters).set({ suggestedDisposition: disposition, suggestionReason: reason }).where(eq(deadLetters.id, row.id)),
    );
  }
  return { triaged: open.length };
}
