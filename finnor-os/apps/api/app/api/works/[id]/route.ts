import { reconcileWorkStatus, workAggregate, workExists } from "@finnor/db";
import { errorResponse, requireContext } from "../../../../lib/auth";

/** Canonical Work read: one tenant-scoped aggregate with every durable causal edge. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await params;
    const ctx = await requireContext(req);
    if (!(await workExists(ctx.tenantId, id))) return Response.json({ error: "Work not found" }, { status: 404 });
    await reconcileWorkStatus(ctx.tenantId, id);
    const work = await workAggregate(ctx.tenantId, id);
    if (!work) return Response.json({ error: "Work not found" }, { status: 404 });
    return Response.json({ work });
  } catch (err) {
    return errorResponse(err);
  }
}
