import { errorResponse } from "../../../../lib/auth";
import { WorkforceRuntimeError, WorkforceAllocationError } from "@finnor/orchestration/workforce-execution";
import { ZodError } from "zod";
export const privateHeaders = { "cache-control": "no-store, private", "vary": "Authorization", "x-content-type-options": "nosniff" };
export async function boundedJson(req: Request) {
  const limit = 2 * 1024 * 1024, reader = req.body?.getReader();
  if (!reader) throw new WorkforceRuntimeError("WORKFORCE_INVALID_JSON", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new WorkforceRuntimeError("WORKFORCE_REQUEST_BOUND_EXCEEDED", 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const raw = Buffer.concat(chunks, size).toString("utf8");
  try { return JSON.parse(raw); } catch { throw new WorkforceRuntimeError("WORKFORCE_INVALID_JSON", 400); }
}
export function workforceError(error: unknown) {
  if (error instanceof WorkforceAllocationError) return Response.json({ error: error.code },
    { status: 409, headers: privateHeaders });
  if (error instanceof WorkforceRuntimeError) return Response.json({ error: error.code,
    ...(error.detail ? { detail: error.detail } : {}) }, { status: error.status, headers: privateHeaders });
  if (error instanceof ZodError) return Response.json({ error: "WORKFORCE_INVALID_INPUT", issues: error.flatten() },
    { status: 400, headers: privateHeaders });
  const response = errorResponse(error);
  for (const [key, value] of Object.entries(privateHeaders)) response.headers.set(key, value);
  return response;
}
