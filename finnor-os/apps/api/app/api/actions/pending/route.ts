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

import { withTenant, domainActions, businessEffects, decisionReceipts, actionLog } from "@finnor/db";
import { inArray, desc, eq, and, lt, or } from "drizzle-orm";
import { requireContext, errorResponse } from "../../../../lib/auth";
import { extractPredicted } from "../../../../lib/predicted-outcome";
import { eligibleApproversForActions } from "@finnor/authority";

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

type PendingCursor = { createdAt: string; id: string; filter: "pending" | "blocked" };

function parseLimit(value: string | null): number | null {
  if (value === null) return 100;
  const limit = Number(value);
  return Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : null;
}

function decodeCursor(value: string | null, filter: PendingCursor["filter"]): PendingCursor | null | undefined {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<PendingCursor>;
    if (parsed.filter !== filter || typeof parsed.id !== "string" || typeof parsed.createdAt !== "string") return undefined;
    if (Number.isNaN(new Date(parsed.createdAt).getTime())) return undefined;
    return parsed as PendingCursor;
  } catch {
    return undefined;
  }
}

function encodeCursor(row: { createdAt: Date; id: string }, filter: PendingCursor["filter"]): string {
  return Buffer.from(JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id, filter } satisfies PendingCursor)).toString("base64url");
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
        .select()
        .from(domainActions)
        .where(and(
          eq(domainActions.tenantId, ctx.tenantId),
          inArray(domainActions.status, [...statuses]),
          cursor ? or(
            lt(domainActions.createdAt, new Date(cursor.createdAt)),
            and(eq(domainActions.createdAt, new Date(cursor.createdAt)), lt(domainActions.id, cursor.id)),
          ) : undefined,
        ))
        .orderBy(desc(domainActions.createdAt), desc(domainActions.id))
        .limit(limit + 1),
    );
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    const actionIds = pageRows.map((r) => r.id);
    const effectRows = actionIds.length > 0 ? await withTenant(ctx.tenantId, (db) => db.select().from(businessEffects).where(and(eq(businessEffects.tenantId, ctx.tenantId), inArray(businessEffects.domainActionId, actionIds)))) : [];
    const effectByActionId = new Map(effectRows.flatMap((row) => row.domainActionId ? [[row.domainActionId, row] as const] : []));
    // A domain action can have more than one receipt (each reflection-retry step opens
    // its own, per Task 2.5) — order by created desc and keep only the first (latest)
    // one seen per action id, in plain JS rather than a window-function query.
    const receiptByActionId = new Map<string, ReceiptSummary>();
    if (actionIds.length > 0) {
      const receiptRows: ReceiptSummary[] = await withTenant(ctx.tenantId, (db) =>
        db
          .select({
            id: decisionReceipts.id,
            domainActionId: decisionReceipts.domainActionId,
            objective: decisionReceipts.objective,
            evidence: decisionReceipts.evidence,
            policyApplied: decisionReceipts.policyApplied,
            riskTier: decisionReceipts.riskTier,
            createdAt: decisionReceipts.createdAt,
          })
          .from(decisionReceipts)
          .where(inArray(decisionReceipts.domainActionId, actionIds))
          .orderBy(desc(decisionReceipts.createdAt)),
      );
      for (const r of receiptRows) {
        if (r.domainActionId && !receiptByActionId.has(r.domainActionId)) receiptByActionId.set(r.domainActionId, r);
      }
    }

    const criticByActionId = new Map<string, CriticSummary>();
    if (actionIds.length > 0) {
      // Latest critic_review episode per action, same "order desc, keep first seen"
      // pattern as the receipt lookup above.
      const criticRows = await withTenant(ctx.tenantId, (db) =>
        db
          .select({ domainActionId: actionLog.domainActionId, output: actionLog.output, timestamp: actionLog.timestamp })
          .from(actionLog)
          .where(and(inArray(actionLog.domainActionId, actionIds), eq(actionLog.step, "critic_review")))
          .orderBy(desc(actionLog.timestamp)),
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
    const actions = pageRows.map((r) => ({
      ...r,
      receipt: receiptByActionId.get(r.id) ?? null,
      businessEffect: effectByActionId.get(r.id)?.effect ?? null,
      businessEffectStatus: effectByActionId.get(r.id)?.status ?? null,
      critic: criticByActionId.get(r.id) ?? null,
      eligibleApproverIds: approversByAction.get(r.id) ?? [],
      canCurrentEmployeeApprove: (approversByAction.get(r.id) ?? []).includes(ctx.employeeId ?? ctx.userId),
      // jarvis-v3 P4.T1: the plugin's own simulate() prediction, normalized out of
      // the raw predictedReceipt column (already present on `r` via the `...r`
      // spread above) so the Approval Cockpit reads one clean field instead of
      // reaching into simulation.predicted itself. null when no real simulate()
      // ran for this action type — never a fabricated prediction.
      predicted: extractPredicted(r.predictedReceipt),
    }));
    const last = pageRows.at(-1);
    return Response.json({
      actions,
      page: {
        limit,
        hasMore,
        complete: !hasMore,
        nextCursor: hasMore && last ? encodeCursor(last, filter) : null,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
