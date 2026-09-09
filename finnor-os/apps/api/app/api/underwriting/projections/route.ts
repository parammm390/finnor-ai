import { projectUnderwritingOutputs } from "@finnor/private-equity";
import { requireContext } from "../../../../lib/auth";
import {
  UnderwritingProjectionSchema,
  parseUnderwritingBody,
  underwritingContext,
  underwritingErrorResponse,
  underwritingJson,
} from "../../../../lib/underwriting";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  try {
    const auth = await requireContext(req);
    const body = await parseUnderwritingBody(req, UnderwritingProjectionSchema);
    const result = await projectUnderwritingOutputs(underwritingContext(auth), body);
    return underwritingJson(result, result.replayed ? 200 : 201);
  } catch (error) {
    return underwritingErrorResponse(error);
  }
}
