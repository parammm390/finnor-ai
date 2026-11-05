import { autonomyEvaluations, outcomePackRuns, reconcileWorkStatus, withTenant, workAggregate, workExists } from "@finnor/db";
import { FinancialDocumentReviewReceiptSchema, type FinancialDocumentReview } from "@finnor/shared-types";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { errorResponse, requireContext } from "../../../../lib/auth";

const ReviewWork = z.object({
  status: z.literal("completed"),
  createdBy: z.string().uuid(),
  updatedAt: z.coerce.date(),
  finalOutcome: z.object({
    kind: z.literal("answer"),
    answer: z.object({ documentReviewReceipt: FinancialDocumentReviewReceiptSchema }),
  }),
});

/** Canonical Work read: one tenant-scoped aggregate with every durable causal edge. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await params;
    const ctx = await requireContext(req);
    if (!(await workExists(ctx.tenantId, id))) return Response.json({ error: "Work not found" }, { status: 404 });
    await reconcileWorkStatus(ctx.tenantId, id);
    const work = await workAggregate(ctx.tenantId, id);
    if (!work) return Response.json({ error: "Work not found" }, { status: 404 });
    const exportBrief = new URL(req.url).searchParams.get("export") === "valuation-brief";
    const privateHeaders = { "cache-control": "private, no-store" };
    let documentReview: FinancialDocumentReview | undefined;
    const saved = ReviewWork.safeParse(work.work);
    if (saved.success && saved.data.createdBy === (ctx.employeeId ?? ctx.userId)) {
      const receipt = saved.data.finalOutcome.answer.documentReviewReceipt;
      try {
        const { reviewFinancialDocuments } = await import("@finnor/private-equity/src/document-financial-review");
        const current = await reviewFinancialDocuments({ auth: ctx }, receipt.root, req.signal, null, receipt.valuation?.forecast);
        if (current.digest !== receipt.digest) {
          documentReview = { status: "stale" };
        } else {
          documentReview = current.review;
          if (receipt.valuation) {
            const { assessDocumentValuation, renderValuationDiligenceBrief } = await import("@finnor/private-equity/src/document-valuation");
            const valuation = assessDocumentValuation(current.review, receipt.valuation, current.scopeName);
            documentReview = { ...current.review, valuation };
            if (exportBrief && valuation.status === "calculated") {
              const brief = renderValuationDiligenceBrief({ valuation, review: current.review, asOf: saved.data.updatedAt.toISOString() });
              return new Response(brief, { headers: {
                ...privateHeaders,
                "content-type": "text/markdown; charset=utf-8",
                "content-disposition": 'attachment; filename="finnor-valuation-diligence-brief.md"',
                "x-content-type-options": "nosniff",
              } });
            }
          }
        }
      } catch {
        documentReview = { status: "unavailable" };
      }
    }
    if (exportBrief) {
      return documentReview?.status === "stale"
        ? Response.json({ error: "The source versions or coverage changed. Run the valuation again before exporting." }, { status: 409, headers: privateHeaders })
        : Response.json({ error: "No current valuation brief is available for this Work." }, { status: 404, headers: privateHeaders });
    }
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
    return Response.json({ work: { ...work, outcomePack, ...(documentReview ? { documentReview } : {}) } },
      documentReview ? { headers: privateHeaders } : undefined);
  } catch (err) {
    return errorResponse(err);
  }
}
