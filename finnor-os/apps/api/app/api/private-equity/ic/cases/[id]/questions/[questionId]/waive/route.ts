import { waiveIcQuestion } from "@finnor/private-equity";
import { handleIcPost, IcUuidSchema, IcWaiveQuestionSchema } from "../../../../../../../../../lib/ic";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string; questionId: string }> }): Promise<Response> {
  const route = await params;
  return handleIcPost(req, IcWaiveQuestionSchema, (ctx, body) => waiveIcQuestion(ctx, {
    icCaseId: IcUuidSchema.parse(route.id), questionId: IcUuidSchema.parse(route.questionId), ...body,
  }));
}
