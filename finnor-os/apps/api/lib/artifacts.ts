import { ArtifactError, type ArtifactActor } from "@finnor/artifacts";
import { MicrosoftGraphError } from "@finnor/provider-microsoft365";
import { ProviderAuthError } from "@finnor/security";
import type { TenantContext } from "@finnor/shared-types";
import { errorResponse } from "./auth";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function artifactActor(ctx: TenantContext): ArtifactActor {
  return {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    role: ctx.role,
    employeeId: ctx.employeeId,
    correlationId: ctx.correlationId,
  };
}

export async function boundedJson(req: Request, maxBytes = 1_048_576): Promise<Record<string, unknown>> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new ArtifactError("REQUEST_TOO_LARGE");
  const text = await req.text();
  if (Buffer.byteLength(text) > maxBytes) throw new ArtifactError("REQUEST_TOO_LARGE");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new ArtifactError("INVALID_JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ArtifactError("INVALID_JSON_OBJECT");
  return parsed as Record<string, unknown>;
}

export function artifactErrorResponse(error: unknown): Response {
  if (error instanceof ArtifactError) {
    const status = /TOO_LARGE|_LIMIT|PAGE_LIMIT/.test(error.code)
      ? 413
      : /NOT_FOUND|MISSING/.test(error.code) ? 404
        : /STALE|CONFLICT|MISMATCH|AMBIGUOUS|OVERLAP/.test(error.code) ? 409
          : /DENIED|APPROVAL_REQUIRED|UNAUTHORIZED/.test(error.code) ? 403 : 400;
    return Response.json({ error: error.message, code: error.code }, { status, headers: { "cache-control": "no-store" } });
  }
  if (error instanceof ProviderAuthError) {
    return Response.json({ error: error.message, code: error.code }, { status: error.code === "blocked_auth" ? 401 : 403, headers: { "cache-control": "no-store" } });
  }
  if (error instanceof MicrosoftGraphError) {
    const status = error.kind === "conflict" ? 409 : error.kind === "not_found" ? 404 : error.kind === "auth" ? 401 : error.kind === "permission" ? 403 : error.kind === "throttled" ? 429 : 502;
    return Response.json({ error: error.message, code: `microsoft_${error.kind}`, retryable: error.retryable }, {
      status,
      headers: { "cache-control": "no-store", ...(error.retryAfterMs ? { "retry-after": String(Math.ceil(error.retryAfterMs / 1_000)) } : {}) },
    });
  }
  return errorResponse(error);
}

export function requiredUuid(value: unknown, code = "INVALID_ID"): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new ArtifactError(code);
  return value;
}

export function requiredString(value: unknown, code: string, max = 10_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new ArtifactError(code);
  return value;
}
