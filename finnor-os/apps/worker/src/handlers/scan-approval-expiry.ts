// scan_approval_expiry job (§2.8, closing the chaos matrix's "approval expiry" cell):
// finds domain_actions sitting in "pending" past their policy's
// confirmation_timeout_hours (default 24h if unset) and escalates them to
// needs_human_review. Same scan-then-transition pattern as scan-service-due.ts.
//
// The confirmation gate is a security boundary (executor.ts's own words) — a timeout
// can only make the situation LOUDER, never skip it. This scan never approves, never
// rejects, never executes anything. needs_human_review is already an approvable
// status (apps/api/app/api/actions/[id]/confirm/route.ts accepts "pending" OR
// "needs_human_review") and is the exact status reflection.ts's own escalation path
// already uses — reused machinery, not a new subsystem. Re-notifies via the same
// voice_notify_failure job pattern scheduled-reminder.ts's AMC lapse notice and
// executor.ts's integration-failure notice both already use.

import { withTenant, domainActions, domainPolicies, domainPolicyRevisions, enqueueJob } from "@finnor/db";
import { and, eq } from "drizzle-orm";
import type { JobHandler } from "../queue";

export const DEFAULT_CONFIRMATION_TIMEOUT_HOURS = 24;

export const scanApprovalExpiry: JobHandler = async (payload) => {
  const tenantId = String(payload.tenantId ?? "");
  if (!tenantId) throw new Error("scan_approval_expiry requires tenantId");

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
      // Older callers legitimately create a DomainAction against the mutable
      // policy row without a policy_version. Keep the expiry scan compatible
      // with that durable shape while preferring the immutable revision.
      .leftJoin(domainPolicies, eq(domainActions.policyId, domainPolicies.id))
      .where(and(eq(domainActions.tenantId, tenantId), eq(domainActions.status, "pending"))),
  );
  if (pending.length === 0) return;

  const now = Date.now();
  const expired = pending.filter((row) => {
    const timeoutHours = row.confirmationTimeoutHours ?? row.legacyConfirmationTimeoutHours ?? DEFAULT_CONFIRMATION_TIMEOUT_HOURS;
    return now - row.createdAt.getTime() >= timeoutHours * 3600 * 1000;
  });

  for (const row of expired) {
    // Conditional on status still being 'pending' — naturally idempotent across
    // repeated ticks (once escalated, this row never matches the query above again),
    // and a defense against a genuine concurrent double-tick.
    const [updated] = await withTenant(tenantId, (db) =>
      db
        .update(domainActions)
        .set({ status: "needs_human_review" })
        .where(and(eq(domainActions.id, row.id), eq(domainActions.tenantId, tenantId), eq(domainActions.status, "pending")))
        .returning({ id: domainActions.id }),
    );
    if (!updated) continue; // another concurrent tick already escalated it

    const timeoutHours = row.confirmationTimeoutHours ?? row.legacyConfirmationTimeoutHours ?? DEFAULT_CONFIRMATION_TIMEOUT_HOURS;
    await enqueueJob(
      "voice_notify_failure",
      {
        tenantId,
        script: `Heads up — a request to ${row.actionType.replaceAll("_", " ")}${row.summary ? ` (${row.summary})` : ""} has been waiting on your approval for over ${timeoutHours} hours. It's still there whenever you're ready — nothing has happened without you. Want me to read it to you now?`,
      },
      `approval-expiry:${row.id}`,
    ).catch(() => undefined); // notification trouble must never block the escalation itself
  }
};
