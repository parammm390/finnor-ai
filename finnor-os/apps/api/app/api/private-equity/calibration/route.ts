import { comparePrivateEquityOutcomeAssessment } from "@finnor/private-equity";
import { z } from "zod";
import { errorResponse, requireContext } from "../../../../lib/auth";

export const runtime = "nodejs";

const RequestSchema = z.object({
  assessmentId:z.string().uuid(),
  outcomeId:z.string().uuid(),
  valuePath:z.string().regex(/^[A-Za-z0-9_.-]{1,240}$/),
}).strict();

/** The caller supplies an exact later Outcome and decision-time assessment.
 * This write only appends an immutable epistemic comparison. */
export async function POST(req: Request): Promise<Response> {
  try {
    const [auth,raw] = await Promise.all([requireContext(req),req.json()]);
    const input = RequestSchema.parse(raw);
    const result = await comparePrivateEquityOutcomeAssessment({auth},input);
    return Response.json(result,{status:result.idempotent ? 200 : 201,
      headers:{"cache-control":"private, no-store"}});
  } catch (error) {
    if (error instanceof z.ZodError) return Response.json({error:"Invalid calibration request",code:"INVALID_REQUEST"},
      {status:400,headers:{"cache-control":"private, no-store"}});
    return errorResponse(error);
  }
}
