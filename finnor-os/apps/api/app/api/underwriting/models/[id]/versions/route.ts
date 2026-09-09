import { createUnderwritingModelVersion } from "@finnor/private-equity";
import type { UnderwritingModelIR } from "@finnor/underwriting";
import { requireContext } from "../../../../../../lib/auth";
import {
  UnderwritingCreateModelVersionSchema,
  UnderwritingUuidSchema,
  parseUnderwritingBody,
  underwritingContext,
  underwritingErrorResponse,
  underwritingJson,
} from "../../../../../../lib/underwriting";

export const runtime = "nodejs";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const [auth, route, body] = await Promise.all([
      requireContext(req),
      params,
      parseUnderwritingBody(req, UnderwritingCreateModelVersionSchema, 5 * 1024 * 1024),
    ]);
    const modelId = UnderwritingUuidSchema.parse(route.id);
    const result = await createUnderwritingModelVersion(underwritingContext(auth), {
      modelId,
      definition: body.definition as unknown as UnderwritingModelIR,
      ...(body.parentVersionId ? { parentVersionId: body.parentVersionId } : {}),
    });
    return underwritingJson(result, 201);
  } catch (error) {
    return underwritingErrorResponse(error);
  }
}
