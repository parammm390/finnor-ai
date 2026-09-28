// POST /api/actions/:id/reject — halts the action. Audit-first ordering (§19) and the
// actual status flip live in FinnorOrchestrator.decide() — shared with confirm and the
// Vapi webhook (see confirm/route.ts for why).

import { withTenant, domainActions } from "@finnor/db";
import { RejectActionSchema } from "@finnor/policy-schema";
import { and, eq } from "drizzle-orm";
import { requireContext, errorResponse } from "../../../../../lib/auth";
import { getOrchestrator } from "../../../../../lib/orchestrator";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await params;
    const ctx = await requireContext(req);
    const body = RejectActionSchema.safeParse(await req.json().catch(() => ({})));
    if (!body.success) return Response.json({ error: "Invalid body" }, { status: 400 });

    const row = await withTenant(ctx.tenantId, async (db) => {
      const [r] = await db
        .select()
        .from(domainActions)
        .where(and(eq(domainActions.id, id), eq(domainActions.tenantId, ctx.tenantId)));
      return r;
    });
    if (!row) return Response.json({ error: "Action not found" }, { status: 404 });
    if (row.status === "rejected") return Response.json({ status: "rejected", idempotent: true });

    const result = await getOrchestrator().decide(id, ctx.tenantId, "reject", ctx.userId, { role: ctx.role, reason: body.data.reason ?? null });
    if (result.status === "failure" && /authority/i.test(result.error ?? "")) return Response.json({ error: result.error, authority: result.output }, { status: 403 });
    if (result.status === "failure") return Response.json({ error: result.error ?? "Rejection did not complete" }, { status: 409 });
    if (result.output.idempotent) {
      if (result.output.status !== "rejected") return Response.json({ error: `Action is ${String(result.output.status)}; rejection was not applied` }, { status: 409 });
      return Response.json({ status: "rejected", idempotent: true });
    }
    return Response.json({ status: "rejected" });
  } catch (err) {
    return errorResponse(err);
  }
}
