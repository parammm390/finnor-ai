// POST /api/dlq/:id/replay — re-enqueue a dead-lettered outbox event (§2.3). Owner-only.

import { replayDeadLetter } from "@finnor/workflow-runtime";
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
  not_replayable: 409,
  no_linked_outbox_event: 409,
  no_replay_target: 409,
  version_conflict: 409,
  substrate_retired: 409,
  reconciliation_required: 409,
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
      return Response.json({ error: `Your role (${ctx.role}) cannot replay dead letters` }, { status: 403 });
    }
    const result = await replayDeadLetter(ctx.tenantId, id, {
      actorId: ctx.userId,
      authorityDecisionId: authority.id,
      expectedVersion: body.data.expectedVersion,
      reason: body.data.reason,
      ...(body.data.controlKey ? { controlKey: body.data.controlKey } : {}),
    });
    if (!result.replayed) {
      return Response.json({ error: result.reason }, { status: STATUS_BY_REASON[result.reason] ?? 409 });
    }
    return Response.json({ replayed: true, workflowRunId: result.workflowRunId, version: result.version });
  } catch (err) {
    return errorResponse(err);
  }
}
