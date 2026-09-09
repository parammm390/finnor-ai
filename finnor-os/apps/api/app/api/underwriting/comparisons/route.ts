import { compareUnderwritingRunToArtifact } from "@finnor/private-equity";
import { requireContext } from "../../../../lib/auth";
import {
  UnderwritingArtifactComparisonSchema,
  parseUnderwritingBody,
  underwritingContext,
  underwritingErrorResponse,
  underwritingJson,
} from "../../../../lib/underwriting";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  try {
    const auth = await requireContext(req);
    const body = await parseUnderwritingBody(req, UnderwritingArtifactComparisonSchema);
    return underwritingJson(await compareUnderwritingRunToArtifact(underwritingContext(auth), body));
  } catch (error) {
    return underwritingErrorResponse(error);
  }
}
