import { getIcWorkspace } from "@finnor/private-equity";
import { handleIcGet, IcUuidSchema } from "../../../../../../../lib/ic";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const route = await params;
  return handleIcGet(req, async (ctx) => {
    const workspace = await getIcWorkspace(ctx, { icCaseId: IcUuidSchema.parse(route.id) });
    return {
      icCaseId: workspace.case.id,
      decision: workspace.decision,
      decisionProposal: workspace.decisionProposal,
      decisionProof: workspace.decisionProof,
    };
  });
}
