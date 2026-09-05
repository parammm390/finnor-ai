// scan_watchdog job (A4.T2, JARVIS MAESTRO PLAN §4): four independent reliability
// signals the existing scans don't cover — stuck runs, orphaned steps, aging approvals
// (nudge only), and unfinalized receipts. Modeled directly on scan-reliability-alerts.ts's
// split between a pure, unit-testable detector and a thin handler that reports/acts —
// same convention, new signals.
//
// Deliberately NOT duplicated here (grep-before-build, hard rule #29):
//  - lease-expired step recovery — packages/workflow-runtime/src/steps.ts's
//    recoverStaleSteps() already re-enqueues/reconciles those; this scan only catches a
//    DIFFERENT gap it can't: a step stuck "pending" because its own enqueue job-insert
//    never happened (crash between the step row and the job row), which never has a
//    lease to expire in the first place.
//  - approval expiry — scan-approval-expiry.ts already escalates a pending action past
//    its full confirmationTimeoutHours to needs_human_review. This scan's aging-approval
//    signal fires EARLIER (half that timeout) and only nudges — never changes status —
//    so it can't race or duplicate that scan's own transition.

import { withTenant, workflowRuns, workflowSteps, decisionReceipts, domainActions, domainPolicies, domainPolicyRevisions, enqueueJob, getPool } from "@finnor/db";
import { and, eq, lt, isNull, sql } from "drizzle-orm";
import { enqueueStep, isRunPastWatchdogDeadline, stuckRunDeadlineHours, workflowStepJobKey } from "@finnor/workflow-runtime";
import { appendEpisode, readEpisodes } from "@finnor/memory";
import { Sentry } from "@finnor/tools";
import type { JobHandler } from "../queue";

// Per-workflow-kind "this should have finished by now" deadline. Honest interpretation
// (same posture as scan-reliability-alerts.ts's own "no flapping-history data" note):
// these are conservative first-pass values, not derived from real p95s — A7.T1 is what
// computes those from real history; tune these once that data exists. The 4 known async
// workflow-kind types (§1) get their own row; anything else (single-action commands,
// which normally finish in one runtime-bridge call) falls back to a much shorter default,
// since a single_action run sitting "running" past a few minutes is far more suspicious.
const ORPHANED_STEP_MINUTES = 10;
const UNFINALIZED_RECEIPT_MINUTES = 60;
// Half of scan-approval-expiry's own default — a nudge should land well before the
// escalation it's warning about, not right on top of it.
const AGING_APPROVAL_NUDGE_FRACTION = 0.5;

export interface WatchdogFinding {
  kind: "stuck_run" | "orphaned_step" | "unfinalized_receipt" | "aging_approval_nudge";
  tenantId: string;
  refId: string;
  domainActionId?: string;
  detail: Record<string, unknown>;
}

function hoursSince(d: Date): number {
  return (Date.now() - d.getTime()) / 3_600_000;
}

async function detectStuckRuns(tenantId: string): Promise<WatchdogFinding[]> {
  const running = await withTenant(tenantId, (db) =>
    db.select().from(workflowRuns).where(and(eq(workflowRuns.tenantId, tenantId), eq(workflowRuns.status, "running"))),
  );
  const findings: WatchdogFinding[] = [];
  for (const run of running) {
    const deadline = stuckRunDeadlineHours(run.workflowType);
    const elapsed = hoursSince(run.updatedAt);
    if (isRunPastWatchdogDeadline(run)) {
      findings.push({
        kind: "stuck_run",
        tenantId,
        refId: run.id,
        detail: { workflowType: run.workflowType, elapsedHours: Math.round(elapsed * 10) / 10, deadlineHours: deadline },
      });
    }
  }
  return findings;
}

/** A pending step is healthy only while its current-generation job is actionable.
 * Completed/failed/dead-letter rows are historical evidence, not future delivery;
 * enqueueStep advances the generation and creates the replacement atomically. */
async function detectAndHealOrphanedSteps(tenantId: string): Promise<WatchdogFinding[]> {
  const cutoff = new Date(Date.now() - ORPHANED_STEP_MINUTES * 60_000);
  const pending = await withTenant(tenantId, (db) =>
    db
      .select()
      .from(workflowSteps)
      .where(and(eq(workflowSteps.tenantId, tenantId), eq(workflowSteps.status, "pending"), lt(workflowSteps.createdAt, cutoff))),
  );
  if (pending.length === 0) return [];

  const findings: WatchdogFinding[] = [];
  for (const step of pending) {
    const canonicalJobKey = workflowStepJobKey(tenantId, step.id, step.dispatchGeneration);
    const { rows } = await getPool().query<{ status: string }>("SELECT status FROM jobs WHERE idempotency_key = $1 LIMIT 1", [canonicalJobKey]);
    const jobStatuses = rows.map((row) => row.status);
    if (jobStatuses.some((status) => status === "queued" || status === "running")) continue;
    findings.push({
      kind: "orphaned_step",
      tenantId,
      refId: step.id,
      domainActionId: step.domainActionId ?? undefined,
      detail: { stepType: step.stepType, ageMinutes: Math.round(hoursSince(step.createdAt) * 60), jobStatuses },
    });
    await enqueueStep(tenantId, step.id, step.idempotencyKey);
  }
  return findings;
}

async function detectUnfinalizedReceipts(tenantId: string): Promise<WatchdogFinding[]> {
  const cutoff = new Date(Date.now() - UNFINALIZED_RECEIPT_MINUTES * 60_000);
  const stale = await withTenant(tenantId, (db) =>
    db
      .select()
      .from(decisionReceipts)
      .where(and(eq(decisionReceipts.tenantId, tenantId), isNull(decisionReceipts.finalizedAt), lt(decisionReceipts.createdAt, cutoff))),
  );
  return stale.map((r) => ({
    kind: "unfinalized_receipt" as const,
    tenantId,
    refId: r.id,
    domainActionId: r.domainActionId ?? undefined,
    detail: { objective: r.objective, ageMinutes: Math.round(hoursSince(r.createdAt) * 60) },
  }));
}

/** Nudge only — never touches domain_actions.status (scan-approval-expiry.ts owns that
 *  transition). Deduped via an action_log episode so a tenant's pending action gets
 *  exactly one nudge, not one per scan tick until it either clears or expires. */
async function detectAndNudgeAgingApprovals(tenantId: string): Promise<WatchdogFinding[]> {
  const pending = await withTenant(tenantId, (db) =>
    db
      .select({
        id: domainActions.id,
        actionType: domainActions.actionType,
        createdAt: domainActions.createdAt,
        summary: domainActions.summary,
        confirmationTimeoutHours: domainPolicyRevisions.confirmationTimeoutHours,
        legacyConfirmationTimeoutHours: domainPolicies.confirmationTimeoutHours,
      })
      .from(domainActions)
      .leftJoin(domainPolicyRevisions, and(
        eq(domainActions.policyId, domainPolicyRevisions.policyId),
        eq(domainActions.policyVersion, domainPolicyRevisions.version),
      ))
      .leftJoin(domainPolicies, eq(domainActions.policyId, domainPolicies.id))
      .where(and(eq(domainActions.tenantId, tenantId), eq(domainActions.status, "pending"))),
  );
  if (pending.length === 0) return [];

  const findings: WatchdogFinding[] = [];
  for (const row of pending) {
    const timeoutHours = row.confirmationTimeoutHours ?? row.legacyConfirmationTimeoutHours ?? 24;
    const nudgeAtHours = timeoutHours * AGING_APPROVAL_NUDGE_FRACTION;
    if (hoursSince(row.createdAt) < nudgeAtHours) continue;

    const episodes = await readEpisodes(tenantId, { domainActionId: row.id, limit: 50 });
    if (episodes.some((e) => e.step === "watchdog_nudge_sent")) continue; // already nudged once

    findings.push({
      kind: "aging_approval_nudge",
      tenantId,
      refId: row.id,
      domainActionId: row.id,
      detail: { actionType: row.actionType, timeoutHours, nudgeAtHours: Math.round(nudgeAtHours * 10) / 10 },
    });
    await appendEpisode(tenantId, row.id, "watchdog_nudge_sent", {}, { nudgeAtHours });
    await enqueueJob(
      "voice_notify_failure",
      {
        tenantId,
        script: `Just a heads up — a request to ${row.actionType.replaceAll("_", " ")}${row.summary ? ` (${row.summary})` : ""} is still waiting on your approval. No rush, it's not expired yet — just didn't want it to slip by unnoticed.`,
      },
      `watchdog-nudge:${row.id}`,
    ).catch(() => undefined); // notification trouble must never block the scan itself
  }
  return findings;
}

/** Pure(ish) detector — the orphaned-step branch does self-heal (re-enqueue) inline since
 *  that IS the finding's remediation, same posture as recoverStaleSteps' own "no claim row
 *  yet: safe to reset and re-enqueue" branch. Everything else here only reads + reports;
 *  the handler below is the thin, untested-by-design wiring that alerts on it. */
export async function detectWatchdogFindings(tenantId: string): Promise<WatchdogFinding[]> {
  const [stuckRuns, orphanedSteps, unfinalizedReceipts, agingNudges] = await Promise.all([
    detectStuckRuns(tenantId),
    detectAndHealOrphanedSteps(tenantId),
    detectUnfinalizedReceipts(tenantId),
    detectAndNudgeAgingApprovals(tenantId),
  ]);
  return [...stuckRuns, ...orphanedSteps, ...unfinalizedReceipts, ...agingNudges];
}

function severityFor(kind: WatchdogFinding["kind"]): "warning" | "error" {
  // A stuck run or an unfinalized receipt is a real reliability defect worth paging on;
  // an orphaned step self-heals the moment this scan finds it, and a nudge is routine —
  // both stay at "warning" (visible, not urgent).
  return kind === "stuck_run" ? "error" : "warning";
}

export const scanWatchdog: JobHandler = async (payload) => {
  const tenantId = String(payload.tenantId ?? "");
  if (!tenantId) throw new Error("scan_watchdog requires tenantId");

  const findings = await detectWatchdogFindings(tenantId);
  for (const finding of findings) {
    if (finding.kind === "aging_approval_nudge") continue; // already reported via voice_notify_failure, not an alert
    Sentry.captureMessage(`watchdog:${finding.kind}:tenant:${tenantId}`, {
      level: severityFor(finding.kind),
      extra: finding.detail,
      tags: { watchdog_kind: finding.kind, tenant_id: tenantId },
    });
    if (severityFor(finding.kind) === "error") {
      await enqueueJob(
        "send_push_notification",
        { tenantId, kind: "watchdog-critical", actionId: finding.domainActionId, body: `Watchdog found ${finding.kind.replaceAll("_", " ")}.` },
        `push:watchdog-critical:${tenantId}:${finding.kind}:${finding.refId}`,
      ).catch(() => undefined);
    }
    if (finding.domainActionId) {
      await appendEpisode(tenantId, finding.domainActionId, "watchdog_finding", {}, { kind: finding.kind, ...finding.detail }).catch(() => undefined);
    }
  }
};
