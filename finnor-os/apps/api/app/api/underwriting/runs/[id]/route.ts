import { getUnderwritingRun } from "@finnor/private-equity";
import { requireContext } from "../../../../../lib/auth";
import { UnderwritingUuidSchema, underwritingContext, underwritingErrorResponse, underwritingJson } from "../../../../../lib/underwriting";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const [auth, route] = await Promise.all([requireContext(req), params]);
    return underwritingJson(await getUnderwritingRun(underwritingContext(auth), UnderwritingUuidSchema.parse(route.id)));
  } catch (error) {
    return underwritingErrorResponse(error);
  }
}
