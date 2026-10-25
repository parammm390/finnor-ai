import { createUnderwritingRun, type CreateUnderwritingRunInput } from "@finnor/private-equity";
import { requireContext } from "../../../../lib/auth";
import {resolveEvidenceBindingWork} from "@finnor/private-equity/src/evidence-execution/consumer";
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
    const ctx=underwritingContext(auth);
    const workId=body.evidenceDerivationInputs?await resolveEvidenceBindingWork(ctx,body.evidenceDerivationInputs,body.workId):body.workId;
    const result = await createUnderwritingRun(ctx, {...body,workId} as unknown as CreateUnderwritingRunInput);
    return underwritingJson(result, result.replayed ? 200 : 201);
  } catch (error) {
    return underwritingErrorResponse(error);
  }
}
