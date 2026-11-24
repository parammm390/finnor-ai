// GET /api/instructions/:id — jarvis-v3 P3.T5 (plan v3 §7.1/§8 PHASE 3): the
// instruction_sessions row this instructionId's trace belongs to. Tenant-scoped,
// same shape as receipts/[id]/route.ts's own dynamic-id GET.

import { withTenant, instructionSessions } from "@finnor/db";
import { and, eq } from "drizzle-orm";
import { requireContext, errorResponse } from "../../../../lib/auth";
import { requireVisibleInstruction } from "../../../../lib/work-access";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await params;
    const ctx = await requireContext(req);
    await requireVisibleInstruction(ctx, id);
    const [row] = await withTenant(ctx.tenantId, (db) =>
      db.select().from(instructionSessions).where(and(eq(instructionSessions.id, id), eq(instructionSessions.tenantId, ctx.tenantId))),
    );
    if (!row) return Response.json({ error: "Instruction not found" }, { status: 404 });
    return Response.json({
      instruction: {
        id: row.id,
        workId: row.workId,
        sessionId: row.sessionId,
        instructionText: row.instructionText,
        source: row.source,
        createdAt: row.createdAt,
      },
    }, { headers: { "cache-control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
