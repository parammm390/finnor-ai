import { PE_WORLD_ROOT_TYPES, PeDomainError, designEnterpriseExperiments, projectEnterpriseExperiment, validateEnterpriseExperiment } from "@finnor/private-equity";
import { ExperimentContractError } from "@finnor/epistemic-runtime";
import type { ExperimentRealization } from "@finnor/shared-types";
import { z } from "zod";
import { errorResponse, requireContext } from "../../../../lib/auth";

export const runtime = "nodejs";
const root = z.object({ entityType: z.enum(PE_WORLD_ROOT_TYPES), entityId: z.string().uuid() }).strict();
const design = z.object({ root, request: z.unknown() }).strict();
const validate = z.object({ protocol: z.unknown() }).strict();
const realization = z.object({ protocol: z.unknown(), events: z.array(z.unknown()).max(4096) }).strict();
const resume = realization.extend({ prior: z.unknown() });
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
async function boundedJson(req: Request): Promise<unknown> {
  const limit = 64 * 1024;
  if (Number(req.headers.get("content-length") ?? 0) > limit) { await req.body?.cancel().catch(() => undefined); throw new ExperimentContractError("LIMIT_EXCEEDED", "S2 request exceeds 64 KiB"); }
  if (!req.body) throw new ExperimentContractError("INVALID_REQUEST", "S2 request requires JSON");
  const reader = req.body.getReader(), buffer = new Uint8Array(limit); let size = 0;
  try { while (true) { const chunk = await reader.read(); if (chunk.done) break; if (chunk.value.byteLength > limit - size) { await reader.cancel().catch(() => undefined); throw new ExperimentContractError("LIMIT_EXCEEDED", "S2 request exceeds 64 KiB"); }
    buffer.set(chunk.value, size); size += chunk.value.byteLength; } return JSON.parse(new TextDecoder().decode(buffer.subarray(0, size))); }
  catch (e) { if (e instanceof ExperimentContractError) throw e; throw new ExperimentContractError("INVALID_REQUEST", "S2 request requires JSON"); }
  finally { reader.releaseLock(); }
}
export async function POST(req: Request, { params }: { params: Promise<{ operation: string }> }): Promise<Response> {
  try {
    const [auth, route, body] = await Promise.all([requireContext(req), params, boundedJson(req)]), ctx = { auth };
    switch (route.operation) {
      case "design": { const input = design.parse(body); return response(await designEnterpriseExperiments(ctx, { root: input.root, request: input.request })); }
      case "validate": return response(await validateEnterpriseExperiment(ctx, validate.parse(body).protocol));
      case "realization": { const input = realization.parse(body); return response(await projectEnterpriseExperiment(ctx, { protocol: input.protocol, events: input.events })); }
      case "resume": { const input = resume.parse(body); if (!input.prior || typeof input.prior !== "object") throw new ExperimentContractError("INVALID_REQUEST", "S2 resume requires a prior realization");
        return response(await projectEnterpriseExperiment(ctx, { protocol: input.protocol, events: input.events, prior: input.prior as ExperimentRealization })); }
      default: return response({ error: "S2 operation was not found", code: "NOT_FOUND" }, 404);
    }
  } catch (e) {
    if (e instanceof z.ZodError) return response({ error: "Invalid S2 request", code: "INVALID_REQUEST" }, 400);
    if (e instanceof ExperimentContractError) return response({ error: e.message, code: e.code }, e.code === "LIMIT_EXCEEDED" ? 413 : e.code === "PERMITTED_CONTEXT_UNAVAILABLE" ? 404 : 400);
    if (e instanceof PeDomainError) return response({ error: e.message, code: e.code }, /NOT_FOUND/.test(e.code) ? 404 : /INVALID/.test(e.code) ? 400 : 422);
    return errorResponse(e);
  }
}
