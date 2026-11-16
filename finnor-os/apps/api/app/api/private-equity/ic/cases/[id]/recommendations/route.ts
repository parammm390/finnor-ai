import { createIcRecommendation } from "../../../../../../../../../packages/private-equity/src/ic-repository";
import { handleIcPost, IcRecommendationSchema, IcUuidSchema } from "../../../../../../../lib/ic";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const route = await params;
  return handleIcPost(req, IcRecommendationSchema, (ctx, body) => createIcRecommendation(ctx, { icCaseId: IcUuidSchema.parse(route.id), ...body }), 201);
}
