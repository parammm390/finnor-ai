import { resolveIcQuestion } from "@finnor/private-equity";
import { handleIcPost, IcResolveQuestionSchema, IcUuidSchema } from "../../../../../../../../../lib/ic";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string; questionId: string }> }): Promise<Response> {
  const route = await params;
  return handleIcPost(req, IcResolveQuestionSchema, (ctx, body) => resolveIcQuestion(ctx, {
    icCaseId: IcUuidSchema.parse(route.id), questionId: IcUuidSchema.parse(route.questionId), ...body,
  }));
}
