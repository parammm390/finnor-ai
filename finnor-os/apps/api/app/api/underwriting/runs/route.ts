import { createUnderwritingRun, type CreateUnderwritingRunInput } from "@finnor/private-equity";
import { requireContext } from "../../../../lib/auth";
import {
  UnderwritingCreateRunSchema,
  parseUnderwritingBody,
  underwritingContext,
  underwritingErrorResponse,
  underwritingJson,
} from "../../../../lib/underwriting";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  try {
    const auth = await requireContext(req);
    const body = await parseUnderwritingBody(req, UnderwritingCreateRunSchema);
    const result = await createUnderwritingRun(underwritingContext(auth), body as unknown as CreateUnderwritingRunInput);
    return underwritingJson(result, result.replayed ? 200 : 201);
  } catch (error) {
    return underwritingErrorResponse(error);
  }
}
