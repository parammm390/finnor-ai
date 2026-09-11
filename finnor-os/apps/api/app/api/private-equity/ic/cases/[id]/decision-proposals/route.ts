import { prepareIcDecisionProposal } from "@finnor/private-equity";
import { handleIcPost, IcDecisionProposalSchema, IcUuidSchema } from "../../../../../../../lib/ic";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const route = await params;
  return handleIcPost(req, IcDecisionProposalSchema, (ctx, body) => prepareIcDecisionProposal(ctx, { icCaseId: IcUuidSchema.parse(route.id), ...body }), 201);
}
