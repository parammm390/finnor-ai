import { beginIcPreparation } from "@finnor/private-equity";
import { handleIcPost, IcCaseTransitionSchema, IcUuidSchema } from "../../../../../../../lib/ic";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const route = await params;
  return handleIcPost(req, IcCaseTransitionSchema, (ctx, body) => beginIcPreparation(ctx, { icCaseId: IcUuidSchema.parse(route.id), ...body }));
}
