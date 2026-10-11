import { z } from "zod";
import { PeDomainError } from "@finnor/private-equity";
import { errorResponse, requireContext } from "../../../../lib/auth";
import { registerProfile, submit, read, cancel, consume, readWork } from "../../../../../../packages/private-equity/src/r4/api";
import { RunSchema, ConsumeSchema } from "../../../../../../packages/private-equity/src/r4/contracts";
import { R4_LIMITS } from "../../../../../../packages/shared-types/src/identification-plan";

export const runtime = "nodejs";
function response(value: unknown, status = 200) {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > R4_LIMITS.outputBytes) throw Error("R4_RESPONSE_BYTE_BOUND");
  return new Response(body, { status, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
}
async function boundedJson(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > R4_LIMITS.inputBytes) {
    await request.body?.cancel().catch(() => undefined);
    throw Error("R4_INPUT_BYTE_BOUND");
  }
  if (!request.body) throw Error("R4_JSON_REQUIRED");
  const reader = request.body.getReader(), bytes = Buffer.alloc(R4_LIMITS.inputBytes);
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.byteLength > bytes.length - size) {
        await reader.cancel().catch(() => undefined); throw Error("R4_INPUT_BYTE_BOUND");
      }
      bytes.set(chunk.value, size); size += chunk.value.byteLength;
    }
    try { return JSON.parse(bytes.subarray(0, size).toString("utf8")); }
    catch { throw Error("R4_JSON_REQUIRED"); }
  } finally { reader.releaseLock(); }
}
export async function POST(request: Request, { params }: { params: Promise<{ operation: string }> }) {
  try {
    const [auth, route] = await Promise.all([requireContext(request), params]);
    const ctx = { auth }, body = await boundedJson(request);
    switch (route.operation) {
      case "register": return response(await registerProfile(ctx, body));
      case "submit": return response(await submit(ctx, body), 202);
      case "work": return response(await readWork(ctx, body));
      case "read": case "status": return response(await read(ctx, RunSchema.parse(body).runId));
      case "history": return response(await read(ctx, RunSchema.parse(body).runId, true));
      case "cancel": return response(await cancel(ctx, RunSchema.parse(body).runId));
      case "consume": { const input = ConsumeSchema.parse(body); return response(await consume(ctx, input.runId, input.disposition)); }
      default: return response({ code: "NOT_FOUND", error: "Identification operation not found" }, 404);
    }
  } catch (error) {
    if (error instanceof z.ZodError) return response({ code: "R4_INVALID_REQUEST", error: "Invalid identification request" }, 400);
    if (error instanceof PeDomainError) return response({ code: error.code, error: "Identification context unavailable" }, /NOT_FOUND/.test(error.code) ? 404 : 400);
    if (error instanceof Error && /^R4_[A-Z0-9_]{1,180}$/.test(error.message))
      return response({ code: error.message, error: "Identification condition is unresolved; no effect or collection authority granted" },
        error.message === "R4_INPUT_BYTE_BOUND" ? 413 : /CONFLICT|REVISED|CHANGED|RENEWED|SWAP/.test(error.message) ? 409 : 400);
    return errorResponse(error);
  }
}
