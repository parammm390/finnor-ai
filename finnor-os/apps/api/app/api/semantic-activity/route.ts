import { PeDomainError, loadSemanticActivity, type PeMutationContext } from "@finnor/private-equity";
import { z } from "zod";
import { errorResponse, requireContext } from "../../../lib/auth";

export const runtime = "nodejs";

const InputSchema = z.object({
  root: z.object({
    entityType: z.enum(["pe_strategy", "pe_opportunity", "pe_deal"]),
    entityId: z.string().uuid(),
  }).strict(),
  asOf: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(1_000).optional(),
}).strict();

function response(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "private, no-store" } });
}

export async function POST(req: Request): Promise<Response> {
  try {
    const [auth, raw] = await Promise.all([
      requireContext(req),
      req.json().catch(() => { throw new PeDomainError("PE_ACTIVITY_INVALID", "Semantic Activity request body must be JSON"); }),
    ]);
    const contentLength = Number(req.headers.get("content-length") ?? 0);
    if (Number.isFinite(contentLength) && contentLength > 16 * 1024) {
      throw new PeDomainError("PE_ACTIVITY_LIMIT", "Semantic Activity request exceeds 16 KiB");
    }
    const parsed = InputSchema.safeParse(raw);
    if (!parsed.success) return response({ error: "Invalid Semantic Activity request", code: "INVALID_REQUEST", issues: parsed.error.issues.slice(0, 20) }, 400);
    const ctx: PeMutationContext = { auth };
    return response(await loadSemanticActivity(ctx, parsed.data));
  } catch (error) {
    if (error instanceof PeDomainError) {
      const status = /NOT_FOUND/.test(error.code) ? 404 : /LIMIT/.test(error.code) ? 413 : 400;
      return response({ error: error.message, code: error.code, details: error.details }, status);
    }
    return errorResponse(error);
  }
}
