import { createIcCondition } from "@finnor/private-equity";
import { handleIcPost, IcConditionSchema, IcUuidSchema } from "../../../../../../../lib/ic";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const route = await params;
  return handleIcPost(req, IcConditionSchema, (ctx, body) => createIcCondition(ctx, { icCaseId: IcUuidSchema.parse(route.id), ...body }), 201);
}
