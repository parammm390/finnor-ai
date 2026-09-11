import { satisfyIcCondition } from "@finnor/private-equity";
import { handleIcPost, IcSatisfyConditionSchema, IcUuidSchema } from "../../../../../../../../../lib/ic";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string; conditionId: string }> }): Promise<Response> {
  const route = await params;
  return handleIcPost(req, IcSatisfyConditionSchema, (ctx, body) => satisfyIcCondition(ctx, {
    icCaseId: IcUuidSchema.parse(route.id), conditionId: IcUuidSchema.parse(route.conditionId), ...body,
  }));
}
