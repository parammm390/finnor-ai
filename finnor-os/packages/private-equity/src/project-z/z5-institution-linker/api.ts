import { randomUUID } from "node:crypto";
import type { PeMutationContext } from "../../types";
import { ordinaryDevelopment, Z5_OPERATIONS, Z5_SCHEMAS, RequestSchema, UseSchema, digest } from "./contracts";
import { registerFixedProfile } from "./owners";
import { transaction, requestTx, nativeFailureReason } from "./store";
import { submitInstitutionLink, readInstitutionLink, institutionLinkProjection, cancelInstitutionLink, revokeInstitutionProfile } from "./service";
import { admitInstitutionComposition, useInstitutionComposition } from "./consumer";
export { Z5_OPERATIONS, Z5_SCHEMAS };
export async function readInstitutionBody(req: Request): Promise<unknown> {
  if (Number(req.headers.get("content-length") ?? 0) > 8 * 1024 * 1024) throw Error("Z5_REQUEST_BYTE_BOUND");
  const reader = req.body?.getReader();
  if (!reader) throw Error("Z5_BOUNDED_JSON_BODY_REQUIRED");
  const chunks: Uint8Array[] = []; let bytes = 0, timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => undefined); }, 8000);
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 8 * 1024 * 1024) { await reader.cancel(); throw Error("Z5_REQUEST_BYTE_BOUND"); }
      chunks.push(next.value);
    }
    if (timedOut || req.signal.aborted) throw Error("Z5_REQUEST_BODY_DEADLINE");
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { clearTimeout(timeout); reader.releaseLock(); }
}
export async function handleInstitutionLinkOperation(ctx: PeMutationContext, operation: string, raw: unknown) {
  try {
    ordinaryDevelopment();
    if (!ctx.auth.deliverySession || Date.parse(ctx.auth.deliverySession.expiresAt) <= Date.now())
      throw Error("Z5_REAL_AUTHENTICATED_OWNER_SESSION_REQUIRED");
    if (!(Z5_OPERATIONS as readonly string[]).includes(operation)) throw Error("Z5_UNKNOWN_OPERATION");
    const parsed = Z5_SCHEMAS[operation as keyof typeof Z5_SCHEMAS].safeParse(raw);
    if (!parsed.success) return { status: 400, body: { code: "Z5_INVALID_REQUEST", error: "The strict original-owner request is invalid" } };
    let body: unknown;
    switch (operation) {
      case "institution-contract-register": body = await registerFixedProfile(ctx, parsed.data); break;
      case "institution-link-submit": body = await submitInstitutionLink(ctx, parsed.data); break;
      case "institution-link-read": body = await readInstitutionLink(ctx, parsed.data); break;
      case "institution-link-projection": body = await institutionLinkProjection(ctx, parsed.data); break;
      case "institution-link-cancel": body = await cancelInstitutionLink(ctx, parsed.data); break;
      case "institution-contract-revoke": body = await revokeInstitutionProfile(ctx, parsed.data); break;
      case "institution-link-admit":
      case "institution-link-use": {
        const input = RequestSchema.passthrough().parse(parsed.data);
        const row = await transaction(ctx, c => requestTx(ctx, c, input.requestId));
        if (row.work_id !== input.workId || digest(row.root) !== digest(input.root)) throw Error("Z5_EXACT_WORK_ROOT_REQUIRED");
        if (operation === "institution-link-admit") body = await admitInstitutionComposition(ctx, row.id);
        else {
          const use = UseSchema.parse(parsed.data);
          body = await useInstitutionComposition(ctx, row.id, use.artifactDigest, use.idempotencyKey, randomUUID());
        }
        break;
      }
      default: throw Error("Z5_UNKNOWN_OPERATION");
    }
    return { status: operation === "institution-link-submit" ? 202 : 200, body };
  } catch (error) {
    const code = nativeFailureReason(error, "Z5_NATIVE_OWNER_DEPENDENCY_UNAVAILABLE");
    return { status: /IDEMPOTENCY|STALE|CURRENT|CHANGED|FENCED|EXHAUSTED/.test(code) ? 409 : 403,
      body: { code, error: "The original permitted owner state or supported conditional contract is unavailable",
        protectedAdmission: false, executionAuthorityGranted: false, oldExposureRetained: true } };
  }
}
