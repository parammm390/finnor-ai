import { recordIcDissent } from "@finnor/private-equity";
import { handleIcPost, IcDissentSchema, IcUuidSchema } from "../../../../../../../lib/ic";

export const runtime = "nodejs";

// Human-only endpoint: Dissent must attach to this session employee's own Vote.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const route = await params;
  return handleIcPost(req, IcDissentSchema, (ctx, body) => recordIcDissent(ctx, { icCaseId: IcUuidSchema.parse(route.id), ...body }), 201);
}
