import { finalizeIcDecision } from "@finnor/private-equity";
import { handleIcPost, IcFinalizeDecisionSchema, IcUuidSchema } from "../../../../../../../lib/ic";

export const runtime = "nodejs";

// Human-only finalization. It invokes the P1 Decision owner; this route never writes pe_decisions.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const route = await params;
  return handleIcPost(req, IcFinalizeDecisionSchema, (ctx, body) => finalizeIcDecision(ctx, { icCaseId: IcUuidSchema.parse(route.id), ...body }));
}
