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

import { withTenant, actionLog, workflowSteps, computerSteps, calls, domainActions, workEvents, compareKeysetPositions, decodeKeysetCursor, encodeKeysetCursor, exactInstant, InvalidKeysetCursorError, newerThan, type KeysetPosition } from "@finnor/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { requireContext, errorResponse, AuthError } from "../../../lib/auth";

const QuerySchema = z.object({
  since: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
});

function decodeCursor(raw: string): KeysetPosition {
  try {
    return decodeKeysetCursor(raw);
  } catch (error) {
    if (error instanceof InvalidKeysetCursorError) throw new AuthError("Malformed since cursor", 400);
    throw error;
  }
}

interface ActivityItem {
  source: "action_log" | "workflow_step" | "computer_step" | "work_event" | "call";
  id: string;
  occurredAt: Date;
  position: KeysetPosition;
  detail: Record<string, unknown>;
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
          .select({ row: actionLog, at: exactInstant(actionLog.timestamp) })
          .from(actionLog)
          .where(and(eq(actionLog.tenantId, ctx.tenantId), cursor ? newerThan(actionLog.timestamp, actionLog.id, cursor) : undefined))
          .orderBy(asc(actionLog.timestamp), asc(actionLog.id))
          .limit(limit);
      const stepRows = await db
          .select({ row: workflowSteps, at: exactInstant(workflowSteps.updatedAt) })
          .from(workflowSteps)
          .where(and(eq(workflowSteps.tenantId, ctx.tenantId), cursor ? newerThan(workflowSteps.updatedAt, workflowSteps.id, cursor) : undefined))
          .orderBy(asc(workflowSteps.updatedAt), asc(workflowSteps.id))
          .limit(limit);
      const callRows = await db
          .select({ row: calls, at: exactInstant(calls.createdAt) })
          .from(calls)
          .where(and(eq(calls.tenantId, ctx.tenantId), cursor ? newerThan(calls.createdAt, calls.id, cursor) : undefined))
          .orderBy(asc(calls.createdAt), asc(calls.id))
          .limit(limit);
      const computerStepRows = await db
          .select({ row: computerSteps, at: exactInstant(computerSteps.createdAt) })
          .from(computerSteps)
          .where(and(eq(computerSteps.tenantId, ctx.tenantId), cursor ? newerThan(computerSteps.createdAt, computerSteps.id, cursor) : undefined))
          .orderBy(asc(computerSteps.createdAt), asc(computerSteps.id))
          .limit(limit);
      const workEventRows = await db
          .select({ row: workEvents, at: exactInstant(workEvents.createdAt) })
          .from(workEvents)
          .where(and(eq(workEvents.tenantId, ctx.tenantId), cursor ? newerThan(workEvents.createdAt, workEvents.id, cursor) : undefined))
          .orderBy(asc(workEvents.createdAt), asc(workEvents.id))
          .limit(limit);
      return { actionLogRows, stepRows, computerStepRows, workEventRows, callRows };
    });

    const domainActionIds = [...new Set(actionLogRows.map(({ row }) => row.domainActionId).filter((id): id is string => !!id))];
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
      ...actionLogRows.map(({ row: r, at }) => ({
        source: "action_log" as const,
        id: r.id,
        occurredAt: r.timestamp,
        position: { at, id: r.id },
        detail: {
          domainActionId: r.domainActionId,
          step: r.step,
          output: r.output,
          ...(r.domainActionId && actionById.has(r.domainActionId) ? actionById.get(r.domainActionId) : {}),
        },
      })),
      ...stepRows.map(({ row: r, at }) => ({
        source: "workflow_step" as const,
        id: r.id,
        occurredAt: r.updatedAt,
        position: { at, id: r.id },
        detail: { workflowRunId: r.workflowRunId, stepType: r.stepType, status: r.status, terminalReason: r.terminalReason },
      })),
      ...computerStepRows.map(({ row: r, at }) => ({
        source: "computer_step" as const,
        id: r.id,
        // Cursor predicates and ordering use createdAt. Keep the emitted tuple on
        // that exact durable column so reconnects cannot skip or replay a step.
        occurredAt: r.createdAt,
        position: { at, id: r.id },
        detail: { runId: r.runId, seq: r.seq, phase: r.phase, operation: r.operation, status: r.status, summary: r.summary, pageUrl: r.pageUrl, detail: r.detail },
      })),
      ...workEventRows.map(({ row: r, at }) => ({
        source: "work_event" as const,
        id: r.id,
        occurredAt: r.createdAt,
        position: { at, id: r.id },
        detail: { workId: r.workId, seq: r.seq, eventType: r.eventType, fromStatus: r.fromStatus, toStatus: r.toStatus, payload: r.payload },
      })),
      ...callRows.map(({ row: r, at }) => ({
        source: "call" as const,
        id: r.id,
        occurredAt: r.createdAt,
        position: { at, id: r.id },
        detail: { direction: r.direction, endedReason: r.endedReason, fromNumber: r.fromNumber, toNumber: r.toNumber },
      })),
    ]
      .sort((a, b) => compareKeysetPositions(a.position, b.position))
      .slice(0, limit);

    const last = items.at(-1);
    const nextCursor = last ? encodeKeysetCursor(last.position) : (parsed.data.since ?? null);

    return Response.json(
      { items: items.map(({ position: _position, ...item }) => item), nextCursor, hasMore: [actionLogRows, stepRows, computerStepRows, workEventRows, callRows].some((rows) => rows.length === limit) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
