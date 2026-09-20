// GET /api/instructions/:id/events?after={seq} — jarvis-v3 P3.T5 (plan v3 §7.1):
// the trace poll's own endpoint. `after` defaults to 0 (every event so far); the
// frontend's 400ms poll passes its own last-seen seq so this never re-sends events
// it already has. Tenant-scoped: a foreign or nonexistent instructionId 404s rather
// than silently returning an empty list, so the poller can tell "nothing new yet"
// apart from "this id isn't yours."

import { MAX_INSTRUCTION_EVENT_PAGE, withTenant, instructionSessions, instructionEvents } from "@finnor/db";
import { and, asc, eq, gt } from "drizzle-orm";
import { requireContext, errorResponse, AuthError } from "../../../../../lib/auth";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await params;
    const ctx = await requireContext(req);
    const url = new URL(req.url);
    const afterParam = url.searchParams.get("after");
    const after = afterParam ? Number.parseInt(afterParam, 10) : 0;
    if (afterParam && (!Number.isInteger(after) || after < 0)) {
      throw new AuthError("after must be a non-negative integer", 400);
    }
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam === null ? MAX_INSTRUCTION_EVENT_PAGE : Number(limitParam);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_INSTRUCTION_EVENT_PAGE) {
      throw new AuthError(`limit must be an integer from 1 to ${MAX_INSTRUCTION_EVENT_PAGE}`, 400);
    }

    const [session] = await withTenant(ctx.tenantId, (db) =>
      db.select({ id: instructionSessions.id }).from(instructionSessions).where(and(eq(instructionSessions.id, id), eq(instructionSessions.tenantId, ctx.tenantId))).limit(1),
    );
    if (!session) return Response.json({ error: "Instruction not found" }, { status: 404 });

    const rowsPlus = await withTenant(ctx.tenantId, (db) =>
      db
        .select({ seq: instructionEvents.seq, phase: instructionEvents.phase, payload: instructionEvents.payload, createdAt: instructionEvents.createdAt })
        .from(instructionEvents)
        .where(and(eq(instructionEvents.instructionId, id), eq(instructionEvents.tenantId, ctx.tenantId), gt(instructionEvents.seq, after)))
        .orderBy(asc(instructionEvents.seq))
        .limit(limit + 1),
    );
    const hasMore = rowsPlus.length > limit;
    const rows = hasMore ? rowsPlus.slice(0, limit) : rowsPlus;
    return Response.json({
      events: rows,
      page: {
        limit,
        hasMore,
        nextAfter: hasMore ? rows.at(-1)?.seq ?? after : null,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
