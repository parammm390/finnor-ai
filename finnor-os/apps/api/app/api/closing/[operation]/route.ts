import { z } from "zod";
import { ClosingError, handleClosingOperation, PeDomainError } from "@finnor/private-equity";
import { errorResponse, requireContext } from "../../../../lib/auth";

export const runtime = "nodejs";
function response(value: unknown, status: number) {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > 4 * 1024 * 1024) throw new ClosingError("CLOSING_RESPONSE_BOUND_EXCEEDED", 413);
  return new Response(body, { status, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
}
async function boundedBody(req: Request): Promise<unknown> {
  const limit = 2 * 1024 * 1024;
  if (!req.body || Number(req.headers.get("content-length") ?? 0) > limit) throw new ClosingError("CLOSING_BOUNDED_JSON_REQUIRED", 413);
  const reader = req.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new ClosingError("CLOSING_REQUEST_BOUND_EXCEEDED", 413); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof ClosingError) throw error;
    throw new ClosingError("CLOSING_INVALID_JSON", 400);
  } finally { reader.releaseLock(); }
}
export async function POST(req: Request, { params }: { params: Promise<{ operation: string }> }) {
  try {
    const [auth, route] = await Promise.all([requireContext(req), params]);
    const result = await handleClosingOperation({ auth }, route.operation, await boundedBody(req));
    return response(result.body, result.status);
  } catch (error) {
    if (error instanceof z.ZodError) return response({ code: "CLOSING_INVALID_REQUEST" }, 400);
    if (error instanceof ClosingError) return response({ code: error.code }, error.status);
    if (error instanceof PeDomainError) return response({ code: error.code }, /NOT_FOUND/.test(error.code) ? 404 : 422);
    return errorResponse(error);
  }
}
