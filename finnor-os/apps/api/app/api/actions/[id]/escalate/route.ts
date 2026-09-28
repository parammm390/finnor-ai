// POST /api/actions/:id/escalate — a human (not the confirmation-expiry scan) flags a
// still-pending action as needing review, without approving or rejecting it (Phase 7
// MAESTRO PACK §7.1's Approval Inbox third verb). Same audit-first ordering and shared
// decide() path as confirm/reject.

import { withTenant, domainActions } from "@finnor/db";
import { EscalateActionSchema } from "@finnor/policy-schema";
import { and, eq } from "drizzle-orm";
import { requireContext, errorResponse } from "../../../../../lib/auth";
import { getOrchestrator } from "../../../../../lib/orchestrator";
import { evaluateActionApproval } from "@finnor/authority";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await params;
    const ctx = await requireContext(req);
    const body = EscalateActionSchema.safeParse(await req.json().catch(() => ({})));
    if (!body.success) return Response.json({ error: "Invalid body" }, { status: 400 });

    const row = await withTenant(ctx.tenantId, async (db) => {
      const [r] = await db
        .select()
        .from(domainActions)
        .where(and(eq(domainActions.id, id), eq(domainActions.tenantId, ctx.tenantId)));
      return r;
    });
    if (!row) return Response.json({ error: "Action not found" }, { status: 404 });
    const authority = await evaluateActionApproval(ctx, id);
    if (authority.outcome !== "allowed") return Response.json({ error: `Authority denied: ${authority.reasonCode}`, authority }, { status: 403 });
    if (row.status === "needs_human_review") return Response.json({ status: "needs_human_review", idempotent: true });
    if (row.status !== "pending") {
      return Response.json({ error: `Action is ${row.status}; only pending actions can be escalated` }, { status: 409 });
    }

    const result = await getOrchestrator().decide(id, ctx.tenantId, "escalate", ctx.userId, { role: ctx.role, note: body.data.note ?? null });
    if (result.status === "failure") return Response.json({ error: result.error ?? "Escalation did not complete" }, { status: 409 });
    if (result.output.idempotent && result.output.status !== "needs_human_review") {
      return Response.json({ error: `Action is ${String(result.output.status)}; escalation was not applied` }, { status: 409 });
    }
    return Response.json({ result });
  } catch (err) {
    return errorResponse(err);
  }
}
