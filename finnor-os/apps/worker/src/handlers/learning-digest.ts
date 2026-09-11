// learning_digest job: real observability, not autonomy — aggregates domain_actions
// and critic_review outcomes into a report a human can act on (e.g. by editing a
// domain_policies row). Nothing here changes system behavior on its own. When an
// action_type is failing or getting rejected often enough to be worth a human's
// attention, it's written as a scanFinding — the SAME mechanism Pillar 2 already
// built (apps/worker/src/handlers/owner-digest.ts) — so this rolls into the existing
// daily call instead of adding a new one. A separate daily "insights" call would be
// exactly the call-fatigue problem owner-digest was designed to avoid.

import { withTenant, scanFindings } from "@finnor/db";
import { and, eq, isNull } from "drizzle-orm";
import { computeLearningDigest, generateWorkforceLearningProposals, MIN_SAMPLE, CONCERN_THRESHOLD } from "@finnor/orchestration";
import type { JobHandler } from "../queue";

export const learningDigest: JobHandler = async (payload) => {
  const tenantId = String(payload.tenantId ?? "");
  if (!tenantId) throw new Error("learning_digest requires tenantId");

  const digest = await computeLearningDigest(tenantId);
  // P7 reuses this one existing job. Typed proposals are immutable and remain
  // inert until an authorized human explicitly promotes one.
  await generateWorkforceLearningProposals(tenantId, digest.windowDays);
  const concerning = digest.actionTypeStats.filter(
    (s) => s.total >= MIN_SAMPLE && (s.failureRate >= CONCERN_THRESHOLD || (s.decided >= MIN_SAMPLE && s.rejectionRate >= CONCERN_THRESHOLD)),
  );
  if (concerning.length === 0) return; // nothing worth a human's attention right now

  // Don't re-flag an action_type that's already sitting undigested from a prior run —
  // same "fetch once, check membership" idempotency shape as scheduled-reminder.ts.
  const alreadyFlagged = await withTenant(tenantId, (db) =>
    db
      .select({ details: scanFindings.details })
      .from(scanFindings)
      .where(and(eq(scanFindings.tenantId, tenantId), eq(scanFindings.scanType, "learning_digest"), isNull(scanFindings.digestedAt))),
  );
  const alreadyFlaggedTypes = new Set(alreadyFlagged.map((f) => (f.details as Record<string, unknown> | null)?.actionType).filter(Boolean));

  for (const s of concerning) {
    if (alreadyFlaggedTypes.has(s.actionType)) continue;
    const parts: string[] = [];
    if (s.failureRate >= CONCERN_THRESHOLD) parts.push(`failing ${(s.failureRate * 100).toFixed(0)}% of the time (${s.failed}/${s.total})`);
    if (s.decided >= MIN_SAMPLE && s.rejectionRate >= CONCERN_THRESHOLD) {
      parts.push(`rejected by a human ${(s.rejectionRate * 100).toFixed(0)}% of the time (${s.rejected}/${s.decided} decided)`);
    }
    await withTenant(tenantId, (db) =>
      db.insert(scanFindings).values({
        tenantId,
        scanType: "learning_digest",
        summary: `${s.actionType} is ${parts.join(" and ")} over the last ${digest.windowDays} days — may be worth reviewing its policy.`,
        details: { ...s },
      }),
    );
  }
};
