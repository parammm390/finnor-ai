import { handoffWork, workAggregate } from "@finnor/db";
import { employeeAuthoritySnapshot, evaluateAuthority } from "@finnor/authority";
import { HandoffWorkSchema } from "@finnor/policy-schema";
import { AuthError, errorResponse, requireContext } from "../../../../../lib/auth";
import { requireVisibleWork } from "../../../../../lib/work-access";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Move the same persistent Work to another active employee. The objective and all
 * child records stay in place; only responsibility and its fresh authority snapshot
 * change. Subsequent objective iterations therefore re-inspect and act as the new
 * owner, while already-drafted actions retain their original initiator. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await params;
    const ctx = await requireContext(req);
    await requireVisibleWork(ctx, id);
    const parsed = HandoffWorkSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return Response.json({ error: parsed.error.issues.map((issue) => issue.message).join("; ") }, { status: 400 });
    const actorId = ctx.employeeId ?? (UUID.test(ctx.userId) ? ctx.userId : null);
    if (!actorId) throw new AuthError("Canonical employee identity is required to hand off Work", 403);
    const aggregate = await workAggregate(ctx.tenantId, id);
    if (!aggregate) return Response.json({ error: "Work not found" }, { status: 404 });
    const work = aggregate.work as { currentOwnerId: string | null; createdBy: string | null };
    const currentOwnerId = work.currentOwnerId ?? work.createdBy;
    if (currentOwnerId !== actorId) throw new AuthError("Only the current Work owner may hand off responsibility", 403);
    const permission = await evaluateAuthority({ ...ctx, employeeId: actorId }, {
      operation: "query",
      capability: "query:work_list",
      resource: { type: "work", id },
      risk: "low",
      workId: id,
    });
    if (permission.outcome !== "allowed") throw new AuthError(`Authority denied Work handoff: ${permission.reasonCode}`, 403);
    let targetAuthority: Awaited<ReturnType<typeof employeeAuthoritySnapshot>>;
    try {
      targetAuthority = await employeeAuthoritySnapshot({ tenantId: ctx.tenantId, userId: parsed.data.targetEmployeeId, employeeId: parsed.data.targetEmployeeId, role: "owner" });
    } catch {
      return Response.json({ error: "The handoff target must be an active employee in this tenant" }, { status: 400 });
    }
    try {
      const handoff = await handoffWork({
        tenantId: ctx.tenantId,
        workId: id,
        actorId,
        targetEmployeeId: parsed.data.targetEmployeeId,
        expectedOwnerId: currentOwnerId ?? undefined,
        note: parsed.data.note,
        authorityContext: {
          employeeId: targetAuthority.employeeId,
          revision: targetAuthority.revision,
          roles: targetAuthority.roles,
          principal: targetAuthority.employeeId,
          handedOffBy: actorId,
        },
      });
      return Response.json({ handoff, work: await workAggregate(ctx.tenantId, id) }, { status: handoff.duplicate ? 200 : 202 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Work handoff failed";
      if (/owner changed/i.test(message)) return Response.json({ error: message }, { status: 409 });
      if (/only the current Work owner/i.test(message)) throw new AuthError(message, 403);
      if (/handoff target|active employee/i.test(message)) return Response.json({ error: message }, { status: 400 });
      throw error;
    }
  } catch (error) {
    return errorResponse(error);
  }
}
