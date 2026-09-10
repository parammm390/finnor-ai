import { closeIcVoting } from "@finnor/private-equity";
import { handleIcPost, IcCloseVotingSchema, IcUuidSchema } from "../../../../../../../../lib/ic";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const route = await params;
  return handleIcPost(req, IcCloseVotingSchema, (ctx, body) => closeIcVoting(ctx, { icCaseId: IcUuidSchema.parse(route.id), ...body }));
}
