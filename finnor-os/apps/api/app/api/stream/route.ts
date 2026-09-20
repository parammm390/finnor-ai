// GET /api/stream?instructionId=... — jarvis-v3 P3.T9 (plan v3 §7.1 Stage 2): SSE
// delivery of ONE instruction's `instruction_events`, as an alternate transport to
// the 400ms poll (P3.T5/T6's GET /api/instructions/:id/events) — both feed the
// SAME kernel reconciliation (kernel/store.tsx's applyTraceEvents), just via a
// different transport; kernel/transport.ts (P3.T11) picks which is active and
// falls back to polling after 2 SSE failures.
//
// Bounded lifetime (120s, matching the poll's own ceiling): a real Vercel
// serverless function cannot hold a connection open indefinitely — verified this
// session against apps/worker/src/sse/gateway.ts's own header comment, the reason
// THAT SSE gateway is the always-on worker gateway rather than living
// here. This stream's natural lifetime is exactly one instruction's own planning
// window (seconds, not a whole session), which the ceiling already bounds
// honestly — no separate always-on service needed for this specific job.
//
// `id:` is `instruction_events.seq` itself (real, monotonic, per-instructionId) —
// so a browser EventSource's automatic `Last-Event-ID` on reconnect is a REAL
// resume point, not a replay-everything reconnect (no duplicates: verified by
// this file's own resume logic below, and by e2e/jarvis-stream-route.spec.ts).

import { MAX_INSTRUCTION_EVENT_PAGE, withTenant, instructionEvents, instructionSessions } from "@finnor/db";
import { and, asc, eq, gt } from "drizzle-orm";
import { requireContext, errorResponse, AuthError } from "../../../lib/auth";

const HEARTBEAT_MS = 25_000;
const POLL_MS = 500;
const CEILING_MS = 120_000;
const EVENT_BATCH_SIZE = MAX_INSTRUCTION_EVENT_PAGE;
const TERMINAL_PHASES = new Set(["completed", "failed", "cancelled"]);

export async function GET(req: Request): Promise<Response> {
  let ctx: Awaited<ReturnType<typeof requireContext>>;
  try {
    ctx = await requireContext(req);
  } catch (err) {
    return errorResponse(err);
  }

  const url = new URL(req.url);
  const instructionId = url.searchParams.get("instructionId");
  if (!instructionId) return errorResponse(new AuthError("instructionId is required", 400));

  const [session] = await withTenant(ctx.tenantId, (db) =>
    db.select({ id: instructionSessions.id }).from(instructionSessions).where(and(eq(instructionSessions.id, instructionId), eq(instructionSessions.tenantId, ctx.tenantId))).limit(1),
  );
  if (!session) return Response.json({ error: "Instruction not found" }, { status: 404 });

  const lastEventId = req.headers.get("last-event-id");
  const startAfter = lastEventId ? Number.parseInt(lastEventId, 10) : 0;
  let lastSeq = Number.isInteger(startAfter) && startAfter >= 0 ? startAfter : 0;

  const encoder = new TextEncoder();
  let cancelled = false;

  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(": connected\n\n"));
      const startedAt = Date.now();
      let lastHeartbeatAt = Date.now();

      while (!cancelled) {
        try {
          const rows = await withTenant(ctx.tenantId, (db) =>
            db
              .select({ seq: instructionEvents.seq, phase: instructionEvents.phase, payload: instructionEvents.payload, createdAt: instructionEvents.createdAt })
              .from(instructionEvents)
              .where(and(eq(instructionEvents.instructionId, instructionId), eq(instructionEvents.tenantId, ctx.tenantId), gt(instructionEvents.seq, lastSeq)))
              .orderBy(asc(instructionEvents.seq))
              .limit(EVENT_BATCH_SIZE),
          );
          for (const row of rows) {
            if (cancelled) break;
            controller.enqueue(encoder.encode(`id: ${row.seq}\n`));
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ seq: row.seq, phase: row.phase, payload: row.payload, createdAt: row.createdAt })}\n\n`));
            lastSeq = row.seq;
          }
          if (rows.some((r) => TERMINAL_PHASES.has(r.phase))) break;
        } catch {
          // A transient internal poll failure never tears down the connection by
          // itself — the client's own SSE onerror/reconnect ladder (T11) is what
          // handles a genuinely dead connection.
        }
        if (cancelled) break;
        if (Date.now() - lastHeartbeatAt >= HEARTBEAT_MS) {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
          lastHeartbeatAt = Date.now();
        }
        if (Date.now() - startedAt >= CEILING_MS) break;
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
      if (!cancelled) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
