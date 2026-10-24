import { eligibleApproversForAction } from "@finnor/authority";
import { executionActionTypes, executionProjection } from "@finnor/read-models";
import { canApproveReadOnly, errorResponse, requireContext } from "../../../../../lib/auth";

/**
 * One authenticated, tenant-scoped reconstruction of a Work's execution. This is a
 * read model only: approval and run controls continue to call their existing routes,
 * which re-authorize and perform the real guarded transitions.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await params;
    const ctx = await requireContext(req);
    const actions = await executionActionTypes(ctx.tenantId, id);
    const candidates = actions.filter((action) => action.status === "pending" || action.status === "needs_human_review");
    const eligible = await Promise.all(candidates.map(async (action) => ({
      id: action.id,
      employeeIds: await eligibleApproversForAction(ctx.tenantId, action.id),
    })));
    const [canControlRuns, canCancelComputer] = await Promise.all([
      canApproveReadOnly(ctx, "*"),
      canApproveReadOnly(ctx, "computer_task"),
    ]);
    const projection = await executionProjection(ctx.tenantId, id, {
      userId: ctx.userId,
      role: ctx.role,
      approvableActionIds: eligible.filter((row) => row.employeeIds.includes(ctx.userId)).map((row) => row.id),
      canControlRuns,
      canCancelComputer,
    });
    if (!projection) return Response.json({ error: "Work not found" }, { status: 404 });
    return Response.json({ execution: projection }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
