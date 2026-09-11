import { z } from "zod";
import { promoteLearningProposal, rejectLearningProposal } from "@finnor/orchestration";
import { AuthError, errorResponse, requireContext } from "../../../../../lib/auth";

export const runtime = "nodejs";

const ProposalReviewSchema = z.object({ decision: z.enum(["promote", "reject"]) }).strict();
const IdSchema = z.string().uuid();

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const ctx = await requireContext(req);
    const id = IdSchema.safeParse((await params).id);
    const body = ProposalReviewSchema.safeParse(await req.json().catch(() => null));
    if (!id.success || !body.success) {
      return Response.json({ error: "A valid proposal id and promote/reject decision are required" }, { status: 400, headers: { "cache-control": "no-store" } });
    }
    try {
      const result = body.data.decision === "promote"
        ? await promoteLearningProposal({ tenantId: ctx.tenantId, proposalId: id.data, actor: ctx })
        : await rejectLearningProposal({ tenantId: ctx.tenantId, proposalId: id.data, actor: ctx });
      return Response.json(result, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      if (error instanceof Error && /human employee|human authority/i.test(error.message)) {
        throw new AuthError("Current employee lacks workforce learning-review authority", 403);
      }
      throw error;
    }
  } catch (error) {
    return errorResponse(error);
  }
}
