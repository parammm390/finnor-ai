import { compareUnderwritingRuns } from "@finnor/private-equity";
import { requireContext } from "../../../../../lib/auth";
import {
  UnderwritingUuidSchema,
  requiredUnderwritingQuery,
  underwritingContext,
  underwritingErrorResponse,
  underwritingJson,
} from "../../../../../lib/underwriting";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  try {
    const auth = await requireContext(req);
    const url = new URL(req.url);
    const left = requiredUnderwritingQuery(url, "left", UnderwritingUuidSchema);
    const right = requiredUnderwritingQuery(url, "right", UnderwritingUuidSchema);
    return underwritingJson(await compareUnderwritingRuns(underwritingContext(auth), left, right));
  } catch (error) {
    return underwritingErrorResponse(error);
  }
}
