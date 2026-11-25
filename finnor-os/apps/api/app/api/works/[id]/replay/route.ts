import { causalReplayProjection } from "@finnor/read-models";
import { errorResponse, requireContext } from "../../../../../lib/auth";
import { requireVisibleWork } from "../../../../../lib/work-access";

/**
 * Reconstruct historical causality from tenant-scoped durable facts. This GET has
 * no reconciliation, planner, provider, queue, or lifecycle side effects.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await params;
    const ctx = await requireContext(req);
    await requireVisibleWork(ctx, id);
    const replay = await causalReplayProjection(ctx.tenantId, id, {
      userId: ctx.userId,
      role: ctx.role,
    });
    if (!replay) return Response.json({ error: "Work not found" }, { status: 404 });
    return Response.json({ replay }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
