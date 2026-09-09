import { getUnderwritingAffectedNodes } from "@finnor/private-equity";
import { requireContext } from "../../../../../../lib/auth";
import {
  UnderwritingUuidSchema,
  requiredUnderwritingQuery,
  underwritingContext,
  underwritingErrorResponse,
  underwritingJson,
} from "../../../../../../lib/underwriting";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const [auth, route] = await Promise.all([requireContext(req), params]);
    return underwritingJson(await getUnderwritingAffectedNodes(
      underwritingContext(auth),
      UnderwritingUuidSchema.parse(route.id),
      requiredUnderwritingQuery(new URL(req.url), "nodeId"),
    ));
  } catch (error) {
    return underwritingErrorResponse(error);
  }
}
