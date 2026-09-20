// POST /api/dlq/:id/discard — permanently give up on a dead-lettered event (§2.3).
// Owner-only. Discarding never deletes the row — it's the audit trail of what was
// dropped and by implication of whom (requireContext'd caller, in server logs).

import { discardDeadLetter } from "@finnor/workflow-runtime";
import { z } from "zod";
import { requireContext, authorizeRuntimeControl, errorResponse } from "../../../../../lib/auth";

const BodySchema = z.object({
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(1).max(4_000),
  controlKey: z.string().trim().min(1).max(512).optional(),
});

const STATUS_BY_REASON: Record<string, number> = {
  not_found: 404,
  not_open: 409,
  version_conflict: 409,
};

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await params;
    const ctx = await requireContext(req);
    if (!z.string().uuid().safeParse(id).success) return Response.json({ error: "Invalid dead-letter id" }, { status: 400 });
    const body = BodySchema.safeParse(await req.json().catch(() => ({})));
    if (!body.success) return Response.json({ error: "expectedVersion and a non-empty reason are required" }, { status: 400 });
    const authority = await authorizeRuntimeControl(ctx, "dead_letter", id);
    if (authority.outcome !== "allowed") {
      return Response.json({ error: `Your role (${ctx.role}) cannot discard dead letters` }, { status: 403 });
    }
    const result = await discardDeadLetter(ctx.tenantId, id, {
      actorId: ctx.userId,
      authorityDecisionId: authority.id,
      expectedVersion: body.data.expectedVersion,
      reason: body.data.reason,
      ...(body.data.controlKey ? { controlKey: body.data.controlKey } : {}),
    });
    if (!result.discarded) {
      return Response.json({ error: result.reason }, { status: STATUS_BY_REASON[result.reason] ?? 409 });
    }
    return Response.json({ discarded: true, version: result.version });
  } catch (err) {
    return errorResponse(err);
  }
}
