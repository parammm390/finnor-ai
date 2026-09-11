import { activateIcCondition } from "@finnor/private-equity";
import { handleIcPost, IcConditionTransitionSchema, IcUuidSchema } from "../../../../../../../../../lib/ic";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string; conditionId: string }> }): Promise<Response> {
  const route = await params;
  return handleIcPost(req, IcConditionTransitionSchema, (ctx, body) => activateIcCondition(ctx, {
    icCaseId: IcUuidSchema.parse(route.id), conditionId: IcUuidSchema.parse(route.conditionId), ...body,
  }));
}
