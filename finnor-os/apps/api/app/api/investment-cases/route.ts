import { listInvestmentCasesForUnderwriting } from "@finnor/private-equity";
import { requireContext } from "../../../lib/auth";
import { underwritingContext, underwritingErrorResponse, underwritingJson } from "../../../lib/underwriting";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  try {
    const auth = await requireContext(req);
    return underwritingJson(await listInvestmentCasesForUnderwriting(underwritingContext(auth)));
  } catch (error) {
    return underwritingErrorResponse(error);
  }
}
