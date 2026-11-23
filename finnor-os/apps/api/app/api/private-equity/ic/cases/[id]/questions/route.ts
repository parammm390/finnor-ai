import { createIcQuestion } from "../../../../../../../../../packages/private-equity/src/ic-repository";
import { handleIcPost, IcCreateQuestionSchema, IcUuidSchema } from "../../../../../../../lib/ic";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const route = await params;
  return handleIcPost(req, IcCreateQuestionSchema, (ctx, body) => createIcQuestion(ctx, { icCaseId: IcUuidSchema.parse(route.id), ...body }), 201);
}
