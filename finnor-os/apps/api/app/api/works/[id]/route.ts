import { autonomyEvaluations, outcomePackRuns, reconcileWorkStatus, withTenant, workAggregate, workExists } from "@finnor/db";
import { and, desc, eq } from "drizzle-orm";
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
    const outcomePack = await withTenant(ctx.tenantId, async (db) => {
      const [run] = await db.select({
        id: outcomePackRuns.id,
        workId: outcomePackRuns.workId,
        objectiveLoopId: outcomePackRuns.objectiveLoopId,
        packId: outcomePackRuns.packId,
        packVersion: outcomePackRuns.packVersion,
        mode: outcomePackRuns.mode,
        status: outcomePackRuns.status,
        objective: outcomePackRuns.objective,
        subjectRefs: outcomePackRuns.subjectRefs,
        blockedReason: outcomePackRuns.blockedReason,
        finalVerification: outcomePackRuns.finalVerification,
        updatedAt: outcomePackRuns.updatedAt,
        completedAt: outcomePackRuns.completedAt,
      }).from(outcomePackRuns).where(and(eq(outcomePackRuns.tenantId, ctx.tenantId), eq(outcomePackRuns.workId, id))).limit(1);
      if (!run) return null;
      const [evaluation] = await db.select({
        outcome: autonomyEvaluations.outcome,
        eligible: autonomyEvaluations.eligible,
        reasonCodes: autonomyEvaluations.reasonCodes,
        evaluatedAt: autonomyEvaluations.evaluatedAt,
      }).from(autonomyEvaluations).where(and(eq(autonomyEvaluations.tenantId, ctx.tenantId), eq(autonomyEvaluations.outcomePackRunId, run.id))).orderBy(desc(autonomyEvaluations.evaluatedAt), desc(autonomyEvaluations.id)).limit(1);
      return { ...run, latestAutonomyDecision: evaluation ?? null };
    });
    return Response.json({ work: { ...work, outcomePack } });
  } catch (err) {
    return errorResponse(err);
  }
}
