import { openIcVoting } from "../../../../../../../../../../packages/private-equity/src/ic-repository";
import { handleIcPost, IcOpenVotingSchema, IcUuidSchema } from "../../../../../../../../lib/ic";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const route = await params;
  return handleIcPost(req, IcOpenVotingSchema, (ctx, body) => openIcVoting(ctx, { icCaseId: IcUuidSchema.parse(route.id), ...body }));
}
