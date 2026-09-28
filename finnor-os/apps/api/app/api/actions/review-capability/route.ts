import { requireContext, errorResponse } from "../../../../lib/auth";

// A client must verify this exact protocol before submitting a prepare-only
// instruction. Older API deployments ignore unknown request fields and could
// otherwise execute the action before the client receives its review.
export async function GET(req: Request): Promise<Response> {
  try {
    await requireContext(req);
    return Response.json({ protocol: "effect-review-v1", prepareOnly: true, hashBoundApproval: true }, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
