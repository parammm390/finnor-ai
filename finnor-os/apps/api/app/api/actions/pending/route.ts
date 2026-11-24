// GET /api/actions/pending — the Confirmation Queue feed (§8). Includes the "blocked"
// and needs_human_review items so nothing is ever silently dropped (§30). Phase 7
// MAESTRO PACK §7.1: each row also carries its most recent DecisionReceipt (objective,
// evidence, policy id+version, risk tier) so the Approval Inbox can render it without a
// second round trip per card.
//
// The `critic` field surfaces the async
// second-pass verdict from packages/orchestration/src/critic.ts's `critic_review`
// action_log rows when one has actually run (needs AWS_BEDROCK_API_KEY — unconfigured
// today per the credentials ledger, so this is real machinery that will typically
// report null until that key exists, not a fake "pending" placeholder).

import { withTenant, domainActions, businessEffects, decisionReceipts, actionLog, decodeKeysetCursor, encodeKeysetCursor, exactInstant, InvalidKeysetCursorError, olderThan, type KeysetPosition } from "@finnor/db";
import { inArray, desc, asc, eq, and } from "drizzle-orm";
import { requireContext, errorResponse } from "../../../../lib/auth";
import { extractPredicted } from "../../../../lib/predicted-outcome";
import { canExerciseAuthority, eligibleApproversForActions } from "@finnor/authority";
import type { AuthorityResource } from "@finnor/shared-types";

type ReceiptSummary = {
  id: string;
  domainActionId: string | null;
  objective: string;
  evidence: unknown;
  policyApplied: unknown;
  riskTier: string;
  createdAt: Date;
};

type CriticSummary = { flagged: boolean; reason: string };

type PendingFilter = "pending" | "blocked";

function parseLimit(value: string | null): number | null {
  if (value === null) return 100;
  const limit = Number(value);
  return Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : null;
}

function decodeCursor(value: string | null, filter: PendingFilter): KeysetPosition | null | undefined {
  if (value === null) return null;
  try {
    const cursor = decodeKeysetCursor(value);
    return cursor.filter === filter ? cursor : undefined;
  } catch (error) {
    if (error instanceof InvalidKeysetCursorError) return undefined;
    throw error;
  }
}

export async function GET(req: Request): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    const url = new URL(req.url);
    const filter = url.searchParams.get("filter") === "blocked" ? "blocked" : "pending";
    const limit = parseLimit(url.searchParams.get("limit"));
    const cursor = decodeCursor(url.searchParams.get("cursor"), filter);
    if (limit === null) return Response.json({ error: "limit must be an integer from 1 to 100" }, { status: 400 });
    if (cursor === undefined) return Response.json({ error: "cursor is invalid for this approval filter" }, { status: 400 });
    const statuses =
      filter === "blocked"
        ? (["blocked_integration_unavailable", "needs_human_review"] as const)
        : (["pending"] as const);
    const rows = await withTenant(ctx.tenantId, (db) =>
      db
        .select({ action: domainActions, at: exactInstant(domainActions.createdAt) })
        .from(domainActions)
        .where(and(
          eq(domainActions.tenantId, ctx.tenantId),
          inArray(domainActions.status, [...statuses]),
          cursor ? olderThan(domainActions.createdAt, domainActions.id, cursor) : undefined,
        ))
        .orderBy(desc(domainActions.createdAt), desc(domainActions.id))
        .limit(limit + 1),
    );
    const hasMore = rows.length > limit;
    const last = rows[limit - 1];
    const pageRows = rows.slice(0, limit).map((row) => row.action);

    const actionIds = pageRows.map((r) => r.id);
    const effectRows = actionIds.length > 0 ? await withTenant(ctx.tenantId, (db) => db.select().from(businessEffects).where(and(eq(businessEffects.tenantId, ctx.tenantId), inArray(businessEffects.domainActionId, actionIds)))) : [];
    const effectByActionId = new Map(effectRows.flatMap((row) => row.domainActionId ? [[row.domainActionId, row] as const] : []));
    // A domain action can have more than one receipt (each reflection-retry step opens
    // its own, per Task 2.5). DISTINCT ON makes PostgreSQL discard older receipts
    // before they cross the network; keeping the latest row in JavaScript after an
    // unbounded fetch was a direct egress regression.
    const receiptByActionId = new Map<string, ReceiptSummary>();
    if (actionIds.length > 0) {
      const receiptRows: ReceiptSummary[] = await withTenant(ctx.tenantId, (db) =>
        db
          .selectDistinctOn([decisionReceipts.domainActionId], {
            id: decisionReceipts.id,
            domainActionId: decisionReceipts.domainActionId,
            objective: decisionReceipts.objective,
            evidence: decisionReceipts.evidence,
            policyApplied: decisionReceipts.policyApplied,
            riskTier: decisionReceipts.riskTier,
            createdAt: decisionReceipts.createdAt,
          })
          .from(decisionReceipts)
          .where(and(eq(decisionReceipts.tenantId, ctx.tenantId), inArray(decisionReceipts.domainActionId, actionIds)))
          .orderBy(asc(decisionReceipts.domainActionId), desc(decisionReceipts.createdAt), desc(decisionReceipts.id))
          .limit(actionIds.length),
      );
      for (const r of receiptRows) {
        if (r.domainActionId && !receiptByActionId.has(r.domainActionId)) receiptByActionId.set(r.domainActionId, r);
      }
    }

    const criticByActionId = new Map<string, CriticSummary>();
    if (actionIds.length > 0) {
      // Latest critic_review episode per action. DISTINCT ON keeps the query's
      // result cardinality bounded by the page's action ids in PostgreSQL.
      const criticRows = await withTenant(ctx.tenantId, (db) =>
        db
          .selectDistinctOn([actionLog.domainActionId], { domainActionId: actionLog.domainActionId, output: actionLog.output, timestamp: actionLog.timestamp })
          .from(actionLog)
          .where(and(eq(actionLog.tenantId, ctx.tenantId), inArray(actionLog.domainActionId, actionIds), eq(actionLog.step, "critic_review")))
          .orderBy(asc(actionLog.domainActionId), desc(actionLog.timestamp), desc(actionLog.id))
          .limit(actionIds.length),
      );
      for (const cr of criticRows) {
        if (criticByActionId.has(cr.domainActionId)) continue;
        const out = cr.output as Record<string, unknown> | null;
        if (out && typeof out.flagged === "boolean" && typeof out.reason === "string") {
          criticByActionId.set(cr.domainActionId, { flagged: out.flagged, reason: out.reason });
        }
      }
    }

    const approversByAction = new Map(Object.entries(await eligibleApproversForActions(ctx.tenantId, actionIds)));
    const reviewMarkers = actionIds.length ? await withTenant(ctx.tenantId, (db) => db.select({ domainActionId: actionLog.domainActionId })
      .from(actionLog).where(and(eq(actionLog.tenantId, ctx.tenantId), eq(actionLog.step, "review_required"), inArray(actionLog.domainActionId, actionIds)))) : [];
    const reviewRequired = new Set(reviewMarkers.map((row) => row.domainActionId));
    const actions = await Promise.all(pageRows.map(async (r) => {
      const chainEligible = approversByAction.get(r.id) ?? [];
      const authorityContext = r.authorityContext && typeof r.authorityContext === "object" ? r.authorityContext as Record<string, unknown> : {};
      const directReviewEligible = reviewRequired.has(r.id) && chainEligible.length === 0 && await canExerciseAuthority(ctx, {
        operation: "approval",
        capability: `approve:${r.actionType}`,
        resources: Array.isArray(authorityContext.resources) ? authorityContext.resources as AuthorityResource[] : [],
        risk: authorityContext.risk === "low" || authorityContext.risk === "high" ? authorityContext.risk : "medium",
        amountUsd: typeof authorityContext.amountUsd === "number" ? authorityContext.amountUsd : undefined,
        workId: r.workId ?? undefined,
        domainActionId: r.id,
        businessEffectId: r.businessEffectId ?? undefined,
        businessEffectHash: effectByActionId.get(r.id)?.semanticHash,
      });
      return {
      ...r,
      receipt: receiptByActionId.get(r.id) ?? null,
      businessEffect: effectByActionId.get(r.id)?.effect ?? null,
      businessEffectStatus: effectByActionId.get(r.id)?.status ?? null,
      critic: criticByActionId.get(r.id) ?? null,
      eligibleApproverIds: chainEligible,
      canCurrentEmployeeApprove: chainEligible.includes(ctx.employeeId ?? ctx.userId) || directReviewEligible,
      // jarvis-v3 P4.T1: the plugin's own simulate() prediction, normalized out of
      // the raw predictedReceipt column (already present on `r` via the `...r`
      // spread above) so the Approval Cockpit reads one clean field instead of
      // reaching into simulation.predicted itself. null when no real simulate()
      // ran for this action type — never a fabricated prediction.
      predicted: extractPredicted(r.predictedReceipt),
      };
    }));
    return Response.json({
      actions,
      page: {
        limit,
        hasMore,
        complete: !hasMore,
        nextCursor: hasMore && last ? encodeKeysetCursor({ at: last.at, id: last.action.id }, { filter }) : null,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
