import { selectPrimaryIcUnderwritingRun } from "@finnor/private-equity";
import { handleIcPost, IcSelectUnderwritingRunSchema, IcUuidSchema } from "../../../../../../../lib/ic";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const route = await params;
  return handleIcPost(req, IcSelectUnderwritingRunSchema, (ctx, body) => selectPrimaryIcUnderwritingRun(ctx, { icCaseId: IcUuidSchema.parse(route.id), ...body }));
}
