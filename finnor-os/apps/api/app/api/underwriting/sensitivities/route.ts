import { createUnderwritingSensitivity } from "@finnor/private-equity";
import type { SensitivityDefinition } from "@finnor/underwriting";
import { requireContext } from "../../../../lib/auth";
import {
  UnderwritingCreateSensitivitySchema,
  parseUnderwritingBody,
  underwritingContext,
  underwritingErrorResponse,
  underwritingJson,
} from "../../../../lib/underwriting";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  try {
    const auth = await requireContext(req);
    const body = await parseUnderwritingBody(req, UnderwritingCreateSensitivitySchema);
    const result = await createUnderwritingSensitivity(underwritingContext(auth), {
      baseRunId: body.baseRunId,
      idempotencyKey: body.idempotencyKey,
      definition: body.definition as unknown as SensitivityDefinition,
    });
    return underwritingJson(result, result.replayed ? 200 : 201);
  } catch (error) {
    return underwritingErrorResponse(error);
  }
}
