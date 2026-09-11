import { recordIcVote } from "@finnor/private-equity";
import { handleIcPost, IcUuidSchema, IcVoteSchema } from "../../../../../../../lib/ic";

export const runtime = "nodejs";

// Human-only endpoint: the service derives employeeId from the verified session.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const route = await params;
  return handleIcPost(req, IcVoteSchema, (ctx, body) => recordIcVote(ctx, { icCaseId: IcUuidSchema.parse(route.id), ...body }), 201);
}
