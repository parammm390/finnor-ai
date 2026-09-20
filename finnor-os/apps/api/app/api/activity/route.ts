// GET /api/activity?since=<cursor>&limit=<n> (A2.T6) — merged, tenant-scoped feed of
// action_log + workflow_steps + computer_steps + Work events + calls, for D1.T3's live Activity Theater
// (SSE-first, cursor-delta polling fallback per C1.T2). Distinct from the existing
// GET /api/events (business_events — a separate, already-populated cross-entity
// timeline; see packages/data-platform/src/events.ts's own comment on why that table
// deliberately excludes these activity sources): this merges 5 raw tables that
// have no shared event log of their own.
//
// Forward-only keyset cursor (occurredAt, id), opposite direction from /api/events'
// backward `before` paging — "what's new since I last polled", not "load older
// history". Each source is one indexed, tenant-scoped query; merged and re-limited in
// app code, never a cross-table SQL UNION (five different row shapes).

import { withTenant, actionLog, workflowSteps, computerSteps, calls, domainActions, workEvents } from "@finnor/db";
import { and, asc, eq, gt, inArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { requireContext, errorResponse, AuthError } from "../../../lib/auth";

const QuerySchema = z.object({
  since: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
});

interface Cursor {
  occurredAt: Date;
  id: string;
}

function decodeCursor(raw: string): Cursor {
  const sep = raw.lastIndexOf("|");
  if (sep === -1) throw new AuthError("Malformed since cursor", 400);
  const ts = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  const occurredAt = new Date(ts);
  if (Number.isNaN(occurredAt.getTime()) || !id) throw new AuthError("Malformed since cursor", 400);
  return { occurredAt, id };
}

function encodeCursor(occurredAt: Date, id: string): string {
  return `${occurredAt.toISOString()}|${id}`;
}

interface ActivityItem {
  source: "action_log" | "workflow_step" | "computer_step" | "work_event" | "call";
  id: string;
  occurredAt: Date;
  detail: Record<string, unknown>;
}

// Keyset predicate for (occurredAt, id) > cursor, tie-broken on id so same-timestamp
// rows never get silently skipped or duplicated across pages. The column is truncated
// to millisecond precision before comparing: Postgres timestamptz stores microseconds,
// but the cursor was encoded from a JS Date (pg's driver already rounds to
// milliseconds on read) — comparing raw would let a row's own hidden sub-millisecond
// remainder make it look "strictly after" the cursor it itself produced, re-serving
// the exact boundary row on the next page.
function afterCursor(occurredAtCol: unknown, idCol: unknown, cursor: Cursor | null): SQL | undefined {
  if (!cursor) return undefined;
  const col = occurredAtCol as Parameters<typeof gt>[0];
  const idc = idCol as Parameters<typeof gt>[0];
  const truncated = sql`date_trunc('milliseconds', ${col})`;
  return or(gt(truncated, cursor.occurredAt), and(eq(truncated, cursor.occurredAt), gt(idc, cursor.id)));
}

export async function GET(req: Request): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    const url = new URL(req.url);
    const parsed = QuerySchema.safeParse({
      since: url.searchParams.get("since") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    });
    if (!parsed.success) return Response.json({ error: "Invalid query" }, { status: 400 });
    const cursor = parsed.data.since ? decodeCursor(parsed.data.since) : null;
    const { limit } = parsed.data;

    const { actionLogRows, stepRows, computerStepRows, workEventRows, callRows } = await withTenant(ctx.tenantId, async (db) => {
      const actionLogRows = await db
          .select()
          .from(actionLog)
          .where(and(eq(actionLog.tenantId, ctx.tenantId), afterCursor(actionLog.timestamp, actionLog.id, cursor)))
          .orderBy(asc(actionLog.timestamp), asc(actionLog.id))
          .limit(limit);
      const stepRows = await db
          .select()
          .from(workflowSteps)
          .where(and(eq(workflowSteps.tenantId, ctx.tenantId), afterCursor(workflowSteps.updatedAt, workflowSteps.id, cursor)))
          .orderBy(asc(workflowSteps.updatedAt), asc(workflowSteps.id))
          .limit(limit);
      const callRows = await db
          .select()
          .from(calls)
          .where(and(eq(calls.tenantId, ctx.tenantId), afterCursor(calls.createdAt, calls.id, cursor)))
          .orderBy(asc(calls.createdAt), asc(calls.id))
          .limit(limit);
      const computerStepRows = await db
          .select()
          .from(computerSteps)
          .where(and(eq(computerSteps.tenantId, ctx.tenantId), afterCursor(computerSteps.createdAt, computerSteps.id, cursor)))
          .orderBy(asc(computerSteps.createdAt), asc(computerSteps.id))
          .limit(limit);
      const workEventRows = await db
          .select()
          .from(workEvents)
          .where(and(eq(workEvents.tenantId, ctx.tenantId), afterCursor(workEvents.createdAt, workEvents.id, cursor)))
          .orderBy(asc(workEvents.createdAt), asc(workEvents.id))
          .limit(limit);
      return { actionLogRows, stepRows, computerStepRows, workEventRows, callRows };
    });

    // D3.T1: the renderer registry (root src/) dispatches on actionType + payload —
    // action_log rows only carry domainActionId, so a second, cheap tenant-scoped
    // lookup joins in the 2 fields the Activity Theater's feed context actually
    // needs to reuse the SAME renderer approvals/receipts already use, instead of
    // the feed being permanently stuck on a generic "step" label.
    const domainActionIds = [...new Set(actionLogRows.map((r) => r.domainActionId).filter((id): id is string => !!id))];
    const actionById = new Map<string, { actionType: string; payload: unknown }>();
    if (domainActionIds.length > 0) {
      const actionRows = await withTenant(ctx.tenantId, (db) =>
        db
          .select({ id: domainActions.id, actionType: domainActions.actionType, payload: domainActions.payload })
          .from(domainActions)
          .where(and(eq(domainActions.tenantId, ctx.tenantId), inArray(domainActions.id, domainActionIds)))
          .limit(domainActionIds.length),
      );
      for (const a of actionRows) actionById.set(a.id, { actionType: a.actionType, payload: a.payload });
    }

    const items: ActivityItem[] = [
      ...actionLogRows.map((r) => ({
        source: "action_log" as const,
        id: r.id,
        occurredAt: r.timestamp,
        detail: {
          domainActionId: r.domainActionId,
          step: r.step,
          output: r.output,
          ...(r.domainActionId && actionById.has(r.domainActionId) ? actionById.get(r.domainActionId) : {}),
        },
      })),
      ...stepRows.map((r) => ({
        source: "workflow_step" as const,
        id: r.id,
        occurredAt: r.updatedAt,
        detail: { workflowRunId: r.workflowRunId, stepType: r.stepType, status: r.status, terminalReason: r.terminalReason },
      })),
      ...computerStepRows.map((r) => ({
        source: "computer_step" as const,
        id: r.id,
        // Cursor predicates and ordering use createdAt. Keep the emitted tuple on
        // that exact durable column so reconnects cannot skip or replay a step.
        occurredAt: r.createdAt,
        detail: { runId: r.runId, seq: r.seq, phase: r.phase, operation: r.operation, status: r.status, summary: r.summary, pageUrl: r.pageUrl, detail: r.detail },
      })),
      ...workEventRows.map((r) => ({
        source: "work_event" as const,
        id: r.id,
        occurredAt: r.createdAt,
        detail: { workId: r.workId, seq: r.seq, eventType: r.eventType, fromStatus: r.fromStatus, toStatus: r.toStatus, payload: r.payload },
      })),
      ...callRows.map((r) => ({
        source: "call" as const,
        id: r.id,
        occurredAt: r.createdAt,
        detail: { direction: r.direction, endedReason: r.endedReason, fromNumber: r.fromNumber, toNumber: r.toNumber },
      })),
    ]
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id))
      .slice(0, limit);

    const last = items[items.length - 1];
    const nextCursor = last ? encodeCursor(last.occurredAt, last.id) : (parsed.data.since ?? null);

    return Response.json(
      { items, nextCursor, hasMore: [actionLogRows, stepRows, computerStepRows, workEventRows, callRows].some((rows) => rows.length === limit) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
