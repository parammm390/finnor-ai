import { createUnderwritingScenario } from "@finnor/private-equity";
import type { UnderwritingScenario } from "@finnor/underwriting";
import { requireContext } from "../../../../lib/auth";
import {
  UnderwritingCreateScenarioSchema,
  parseUnderwritingBody,
  underwritingContext,
  underwritingErrorResponse,
  underwritingJson,
} from "../../../../lib/underwriting";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  try {
    const auth = await requireContext(req);
    const body = await parseUnderwritingBody(req, UnderwritingCreateScenarioSchema);
    const result = await createUnderwritingScenario(underwritingContext(auth), {
      investmentCaseId: body.investmentCaseId,
      modelVersionId: body.modelVersionId,
      scenario: body.scenario as unknown as UnderwritingScenario,
      ...(body.parentScenarioId ? { parentScenarioId: body.parentScenarioId } : {}),
    });
    return underwritingJson(result, 201);
  } catch (error) {
    return underwritingErrorResponse(error);
  }
}
