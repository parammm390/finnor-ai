import { createUnderwritingModel } from "@finnor/private-equity";
import { requireContext } from "../../../../lib/auth";
import {
  UnderwritingCreateModelSchema,
  parseUnderwritingBody,
  underwritingContext,
  underwritingErrorResponse,
  underwritingJson,
} from "../../../../lib/underwriting";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  try {
    const auth = await requireContext(req);
    const input = await parseUnderwritingBody(req, UnderwritingCreateModelSchema, 16_384);
    return underwritingJson(await createUnderwritingModel(underwritingContext(auth), input), 201);
  } catch (error) {
    return underwritingErrorResponse(error);
  }
}
