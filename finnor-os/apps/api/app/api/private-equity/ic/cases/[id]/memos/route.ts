import { selectIcMemoVersion } from "@finnor/private-equity";
import { handleIcPost, IcSelectMemoSchema, IcUuidSchema } from "../../../../../../../lib/ic";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const route = await params;
  return handleIcPost(req, IcSelectMemoSchema, (ctx, body) => selectIcMemoVersion(ctx, { icCaseId: IcUuidSchema.parse(route.id), ...body }), 201);
}
