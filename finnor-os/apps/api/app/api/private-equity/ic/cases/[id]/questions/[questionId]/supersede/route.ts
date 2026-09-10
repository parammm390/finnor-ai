import { supersedeIcQuestion } from "@finnor/private-equity";
import { handleIcPost, IcSupersedeQuestionSchema, IcUuidSchema } from "../../../../../../../../../lib/ic";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string; questionId: string }> }): Promise<Response> {
  const route = await params;
  return handleIcPost(req, IcSupersedeQuestionSchema, (ctx, body) => supersedeIcQuestion(ctx, {
    icCaseId: IcUuidSchema.parse(route.id), questionId: IcUuidSchema.parse(route.questionId), ...body,
  }));
}
