import { answerIcQuestion } from "@finnor/private-equity";
import { handleIcPost, IcAnswerQuestionSchema, IcUuidSchema } from "../../../../../../../../../lib/ic";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string; questionId: string }> }): Promise<Response> {
  const route = await params;
  return handleIcPost(req, IcAnswerQuestionSchema, (ctx, body) => answerIcQuestion(ctx, {
    icCaseId: IcUuidSchema.parse(route.id), questionId: IcUuidSchema.parse(route.questionId), ...body,
  }));
}
