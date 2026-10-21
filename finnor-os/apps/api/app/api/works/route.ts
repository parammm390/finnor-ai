import { works, withTenant, workLifecycleOutcome } from "@finnor/db";
import { and, desc, eq, notInArray } from "drizzle-orm";
import { errorResponse, requireContext } from "../../../lib/auth";

/** Small discovery API for reconnecting a typed or voice surface to active Work. */
export async function GET(req: Request): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    const url = new URL(req.url);
    const sessionId = url.searchParams.get("sessionId");
    const activeOnly = url.searchParams.get("active") === "true";
    const rows = await withTenant(ctx.tenantId, (db) => db
      .select()
      .from(works)
      .where(and(
        eq(works.tenantId, ctx.tenantId),
        ...(sessionId ? [eq(works.sessionId, sessionId)] : []),
        ...(activeOnly ? [notInArray(works.status, ["completed", "failed", "cancelled"])] : []),
      ))
      .orderBy(desc(works.updatedAt))
      .limit(100));
    return Response.json({ works: rows.map(work => ({ ...work, finalOutcome: workLifecycleOutcome(work.finalOutcome) })) });
  } catch (err) {
    return errorResponse(err);
  }
}
