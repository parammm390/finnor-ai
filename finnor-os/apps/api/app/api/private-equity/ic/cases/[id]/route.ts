import { getIcWorkspace } from "../../../../../../../../packages/private-equity/src/ic-repository";
import { handleIcGet, IcUuidSchema } from "../../../../../../lib/ic";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const route = await params;
  const asOf = new URL(req.url).searchParams.get("asOf") ?? undefined;
  return handleIcGet(req, (ctx) => getIcWorkspace(ctx, { icCaseId: IcUuidSchema.parse(route.id), asOf }));
}
