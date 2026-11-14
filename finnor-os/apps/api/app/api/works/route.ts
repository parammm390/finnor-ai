import { users, works, withTenant, workLifecycleOutcome } from "@finnor/db";
import { and, desc, eq, notInArray, or } from "drizzle-orm";
import { errorResponse, requireContext } from "../../../lib/auth";

const EMPLOYEE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Employee-scoped discovery. A session ID or tenant membership is never a share grant. */
export async function GET(req: Request): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    const url = new URL(req.url);
    const sessionId = url.searchParams.get("sessionId");
    const activeOnly = url.searchParams.get("active") === "true";
    const actorId = ctx.employeeId ?? ctx.userId;
    if (!EMPLOYEE_UUID.test(actorId)) return Response.json({ error: "Canonical employee required" }, { status: 403 });
    const rows = await withTenant(ctx.tenantId, (db) => db
      .select({ work: works })
      .from(works)
      .innerJoin(users, and(
        eq(users.id, actorId),
        eq(users.tenantId, works.tenantId),
        eq(users.status, "active"),
      ))
      .where(and(
        eq(works.tenantId, ctx.tenantId),
        or(eq(works.createdBy, actorId), eq(works.currentOwnerId, actorId), eq(works.assignedTo, actorId)),
        ...(sessionId ? [eq(works.sessionId, sessionId)] : []),
        ...(activeOnly ? [notInArray(works.status, ["completed", "failed", "cancelled"])] : []),
      ))
      .orderBy(desc(works.updatedAt))
      .limit(100), actorId);
    return Response.json({ works: rows.map(({ work }) => ({ ...work, finalOutcome: workLifecycleOutcome(work.finalOutcome) })) },
      { headers: { "cache-control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
