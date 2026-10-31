import { z } from "zod";
import { withDatabaseExecutionDeadline } from "@finnor/db";
import { PeDomainError } from "@finnor/private-equity";
import { realWorldServiceOperation } from "@finnor/private-equity/src/real-world-service/api";
import { requireContext, errorResponse } from "../../../../lib/auth";
export const runtime = "nodejs";
const limit = 8 * 1024 * 1024;
async function bounded(req: Request, deadline: number) {
  if (!req.body || Number(req.headers.get("content-length") ?? 0) > limit) throw Error("W3_REQUEST_BYTE_BOUND");
  const reader = req.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  const timer = setTimeout(() => { void reader.cancel().catch(() => undefined) }, Math.max(0, deadline - performance.now()));
  try {
    for (;;) {
      if (performance.now() >= deadline) throw Error("W3_INITIAL_RESPONSE_DEADLINE_EXHAUSTED");
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > limit) { await reader.cancel(); throw Error("W3_REQUEST_BYTE_BOUND") }
      chunks.push(part.value);
    }
    if (performance.now() >= deadline) throw Error("W3_INITIAL_RESPONSE_DEADLINE_EXHAUSTED");
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { clearTimeout(timer); reader.releaseLock() }
}
function response(value: unknown, status = 200) {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > limit) throw Error("W3_RESPONSE_BYTE_BOUND");
  return new Response(body, { status, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
}
export async function POST(req: Request, { params }: { params: Promise<{ operation: string }> }) {
  const deadline = performance.now() + 29000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      withDatabaseExecutionDeadline(deadline, async () => {
        const [auth, route] = await Promise.all([requireContext(req), params]);
        return response(await realWorldServiceOperation({ auth }, route.operation, await bounded(req, deadline)));
      }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("W3_INITIAL_RESPONSE_DEADLINE_EXHAUSTED")), 29000) }),
    ]);
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) return response({ code: "W3_INVALID_REQUEST" }, 400);
    if (error instanceof PeDomainError) return response({ code: error.code, error: "Permitted service context is unavailable" }, 404);
    if (error instanceof Error && /^W3_[A-Z0-9_:]+$/.test(error.message)) {
      const code = error.message;
      return response({ code, executionAuthorityGranted: false },
        code.includes("DEADLINE_EXHAUSTED") ? 504 : code.includes("BYTE_BOUND") ? 413 :
        code.includes("NOT_FOUND") ? 404 : code.includes("UNADMITTED") ? 422 : 409);
    }
    return errorResponse(error);
  } finally { if (timer) clearTimeout(timer) }
}
