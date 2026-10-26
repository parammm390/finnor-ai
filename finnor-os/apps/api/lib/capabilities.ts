import { z } from "zod";
import { CapabilityEngineError } from "../../../packages/tools/src/capabilities/python-runner";
import { errorResponse } from "./auth";

export async function capabilityBody(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new CapabilityEngineError("CAPABILITY_JSON_REQUIRED");
  const raw = await capabilityRawBody(request);
  try { return JSON.parse(raw.toString("utf8")); } catch { throw new CapabilityEngineError("CAPABILITY_INVALID_JSON"); }
}

export async function capabilityRawBody(request: Request): Promise<Buffer> {
  const reader = request.body?.getReader();
  if (!reader) throw new CapabilityEngineError("CAPABILITY_BODY_REQUIRED");
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 1_000_000) { await reader.cancel(); throw new CapabilityEngineError("CAPABILITY_REQUEST_TOO_LARGE"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

export function capabilityError(error: unknown): Response {
  if (error instanceof z.ZodError) return Response.json({ code: "CAPABILITY_INVALID_REQUEST", fields: error.issues.map(i => ({ path: i.path, code: i.code })) }, { status: 400 });
  if (error instanceof CapabilityEngineError) {
    const status = /DENIED/.test(error.code) ? 403 : /NOT_FOUND/.test(error.code) ? 404 : /CONFLICT|MISMATCH/.test(error.code) ? 409 : /TOO_LARGE/.test(error.code) ? 413 : 400;
    return Response.json({ code: error.code }, { status, headers: { "cache-control": "no-store" } });
  }
  return errorResponse(error);
}
