import { createUnderwritingArtifactBinding } from "@finnor/private-equity";
import type { ComparisonPolicy } from "@finnor/underwriting";
import { requireContext } from "../../../../lib/auth";
import {
  UnderwritingCreateArtifactBindingSchema,
  parseUnderwritingBody,
  underwritingContext,
  underwritingErrorResponse,
  underwritingJson,
} from "../../../../lib/underwriting";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  try {
    const auth = await requireContext(req);
    const body = await parseUnderwritingBody(req, UnderwritingCreateArtifactBindingSchema);
    const result = await createUnderwritingArtifactBinding(underwritingContext(auth), {
      investmentCaseId: body.investmentCaseId,
      modelVersionId: body.modelVersionId,
      documentId: body.documentId,
      documentVersionId: body.documentVersionId,
      direction: body.direction,
      bindingMode: body.bindingMode,
      modelNodeId: body.modelNodeId,
      anchorId: body.anchorId,
      anchorHash: body.anchorHash,
      ...(body.valueSelector ? { valueSelector: body.valueSelector } : {}),
      ...(body.comparisonPolicy ? { comparisonPolicy: body.comparisonPolicy as ComparisonPolicy } : {}),
      ...(body.supersedesBindingId ? { supersedesBindingId: body.supersedesBindingId } : {}),
    });
    return underwritingJson(result, 201);
  } catch (error) {
    return underwritingErrorResponse(error);
  }
}
