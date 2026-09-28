// POST /api/actions/:id/confirm — approve → triggers execution (§8).
// Audit-first ordering (§19) and the actual approve/execute logic live in
// FinnorOrchestrator.decide() — the one place that knows how to resume a paused
// executor (legacy GatedExecutor or LangGraph), shared with reject and the Vapi
// webhook instead of each inlining its own status flip.

import { withTenant, domainActions } from "@finnor/db";
import { ConfirmActionSchema } from "@finnor/policy-schema";
import { and, eq } from "drizzle-orm";
import { requireContext, errorResponse } from "../../../../../lib/auth";
import { getOrchestrator } from "../../../../../lib/orchestrator";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await params;
    const ctx = await requireContext(req);
    const body = ConfirmActionSchema.safeParse(await req.json().catch(() => ({})));
    if (!body.success) return Response.json({ error: "Invalid body" }, { status: 400 });

    const row = await withTenant(ctx.tenantId, async (db) => {
      const [r] = await db
        .select()
        .from(domainActions)
        .where(and(eq(domainActions.id, id), eq(domainActions.tenantId, ctx.tenantId)));
      return r;
    });
    if (!row) return Response.json({ error: "Action not found" }, { status: 404 });
    if (row.status === "approved" || row.status === "executing" || row.status === "completed") {
      return Response.json({ status: row.status, idempotent: true }); // safe to call twice
    }
    if (row.status !== "pending" && row.status !== "needs_human_review") {
      return Response.json({ error: `Action is ${row.status}; only pending actions can be approved` }, { status: 409 });
    }
    if (row.businessEffectId && !body.data.expectedEffectHash) {
      return Response.json({ error: "Approval requires the exact reviewed Business Effect hash." }, { status: 400 });
    }

    const result = await getOrchestrator().decide(id, ctx.tenantId, "approve", ctx.userId, {
      role: ctx.role,
      note: body.data.note ?? null,
      typedConfirmation: body.data.typedConfirmation === true,
      expectedEffectHash: body.data.expectedEffectHash,
    });
    if (result.status === "failure" && result.output.effectMismatch) return Response.json({ error: result.error, effectMismatch: true }, { status: 409 });
    if (result.status === "failure" && /authority/i.test(result.error ?? "")) return Response.json({ error: result.error, authority: result.output }, { status: 403 });
    if (result.status === "failure") return Response.json({ error: result.error ?? "Confirmation did not complete" }, { status: 409 });
    if (result.output.idempotent && !["approved", "executing", "completed"].includes(String(result.output.status))) {
      return Response.json({ error: `Action is ${String(result.output.status)}; confirmation was not applied` }, { status: 409 });
    }
    return Response.json({ result });
  } catch (err) {
    return errorResponse(err);
  }
}
