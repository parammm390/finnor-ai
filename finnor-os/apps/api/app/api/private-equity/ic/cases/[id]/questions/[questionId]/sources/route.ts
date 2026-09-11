import { attachIcQuestionSource } from "@finnor/private-equity";
import { handleIcPost, IcQuestionSourceSchema, IcUuidSchema } from "../../../../../../../../../lib/ic";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string; questionId: string }> }): Promise<Response> {
  const route = await params;
  return handleIcPost(req, IcQuestionSourceSchema, (ctx, body) => attachIcQuestionSource(ctx, {
    icCaseId: IcUuidSchema.parse(route.id), questionId: IcUuidSchema.parse(route.questionId), ...body,
  }), 201);
}
