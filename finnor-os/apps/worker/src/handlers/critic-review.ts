// critic_review job: fire-and-forget async second pass over an LLM-planned action
// while it already sits in the confirmation gate awaiting a human — see
// packages/orchestration/src/critic.ts for why this runs here and not synchronously
// pre-draft. No-ops cleanly when Bedrock isn't configured yet (plug-and-play: nothing
// to do until a real key lands, never a hard failure or a dead-lettered job).

import { withTenant, domainActions } from "@finnor/db";
import { and, eq } from "drizzle-orm";
import { appendEpisode, readEpisodes } from "@finnor/memory";
import { criticConfigured, reviewAction } from "@finnor/orchestration";
import { logWithTrace } from "@finnor/tools";
import type { JobHandler } from "../queue";

export const criticReview: JobHandler = async (payload) => {
  const tenantId = String(payload.tenantId ?? "");
  const actionId = String(payload.actionId ?? "");
  if (!tenantId || !actionId) throw new Error("critic_review requires tenantId, actionId");

  const log = logWithTrace({ traceId: payload._correlationId as string | undefined, tenantId, actionId });
  if (!criticConfigured()) {
    log.info("[critic_review] Bedrock not configured — skipping");
    return;
  }

  const row = await withTenant(tenantId, async (db) => {
    const [r] = await db
      .select()
      .from(domainActions)
      .where(and(eq(domainActions.id, actionId), eq(domainActions.tenantId, tenantId)))
      .limit(1);
    return r ?? null;
  });
  // Already decided by the time this fired (a fast human beat us here) — nothing
  // left to review.
  if (!row || row.status !== "pending") return;

  const episodes = await readEpisodes(tenantId, { domainActionId: actionId, limit: 50 });
  const planned = episodes.find((e) => e.step === "planned");
  const plannedInput = (planned?.input ?? {}) as Record<string, unknown>;
  const plannedOutput = (planned?.output ?? {}) as Record<string, unknown>;
  const instruction = String(plannedInput.instruction ?? "");
  // System-originated drafts (scheduled scans) have no instruction to misinterpret —
  // nothing for a critic to check. This job is only ever enqueued for LLM-planned
  // actions anyway (see handleInstruction), but this stays a defensive no-op rather
  // than assuming that will always hold.
  if (!instruction) return;

  const verdict = await reviewAction({
    instruction,
    actionType: row.actionType,
    payload: row.payload as Record<string, unknown>,
    summary: row.summary ?? "",
    reasoning: (plannedOutput.reasoning as string | null) ?? null,
    tenantId,
    actionId,
    traceId: payload._correlationId as string | undefined,
  });

  await appendEpisode(tenantId, actionId, "critic_review", { instruction }, { ...verdict });

  if (verdict.flagged) {
    // Guarded by status = 'pending' so this never clobbers a decision made while the
    // critic call was in flight.
    await withTenant(tenantId, (db) =>
      db
        .update(domainActions)
        .set({ status: "needs_human_review" })
        .where(and(eq(domainActions.id, actionId), eq(domainActions.tenantId, tenantId), eq(domainActions.status, "pending"))),
    );
  }
};
