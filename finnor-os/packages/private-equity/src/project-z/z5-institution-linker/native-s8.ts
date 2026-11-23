/** Mandatory client of the ORIGINAL ordinary S8 lifecycle. This module creates
 * no signer, policy, role, admission decision or listener. Existing independent
 * custody supplies the signed consumer configuration and genuine actor token. */
import { verify, createPublicKey, randomUUID, createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { ExperimentRef } from "@finnor/shared-types";
import { privateFile } from "../../../../capability-evolution/src/journal";
import { readOwnerTransportReference } from "../../../../governed-execution/src/owner-transport";
import { canonical, digest, RefSchema, ordinaryDevelopment, type SessionRow, type IndependentCheck, type Admission } from "./contracts";
const instant = z.string().datetime({ offset: true }), text = z.string().min(1).max(4096);
const PolicySchema = z.object({
  schema: z.literal("finnor.s8.z5-composition-consumer-policy.v1"), domain: z.literal("DISPOSABLE_TEST_AUTHORITY"),
  tenantId: z.string().uuid(), principalId: z.string().uuid(), rightsRef: text,
  endpoint: text, tokenPath: text, tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  lifecyclePolicyDigest: z.string().regex(/^[a-f0-9]{64}$/), validAfter: instant, validUntil: instant,
  timeoutMs: z.number().int().min(100).max(45000),
}).strict();
type Policy = z.infer<typeof PolicySchema>;
export interface NativeS8Assertion {
  schema: "finnor.s8.z5-original-composition-check.v1"; tenantId: string; principalId: string;
  workId: string; requestId: string; generation: number; artifactDigest: string; inputDigest: string;
  sourceDigest: string; liveDigest: string; ownerCutDigest: string; rightsRevision: string; rightsRef: string;
  originalDeadline: string; lifecyclePolicyDigest: string; checkerSha256: string; check: IndependentCheck;
  domain: "ORDINARY_DEVELOPMENT"; protectedAdmission: false; productionActivated: false; executionAuthorityGranted: false;
}
async function configuration(row: SessionRow): Promise<Policy> {
  ordinaryDevelopment();
  const file = process.env.FINNOR_Z5_S8_CONSUMER_CONFIG, root = process.env.FINNOR_Z5_S8_CONSUMER_ROOT;
  if (!file || !path.isAbsolute(file) || !root) throw Error("Z5_ORIGINAL_S8_SIGNED_CONSUMER_CONFIGURATION_REQUIRED");
  const signed = JSON.parse((await privateFile(file, 65536)).toString()) as { body: unknown; signature: string };
  const policy = PolicySchema.parse(signed.body), key = createPublicKey(root);
  if (key.asymmetricKeyType !== "ed25519"
    || !verify(null, Buffer.from(canonical(policy)), key, Buffer.from(signed.signature, "base64"))
    || Date.parse(policy.validAfter) > Date.now() || Date.parse(policy.validUntil) <= Date.now()
    || policy.tenantId !== row.tenant_id || policy.principalId !== row.principal_id
    || policy.rightsRef !== row.cut.rightsRef || Date.parse(policy.validUntil) < row.deadline_at.getTime()
    || !path.isAbsolute(policy.tokenPath)) throw Error("Z5_ORIGINAL_S8_CONSUMER_POLICY_NOT_CURRENT");
  const endpoint = new URL(policy.endpoint);
  if (endpoint.origin !== policy.endpoint || endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1"
    || endpoint.username || endpoint.password) throw Error("Z5_ORIGINAL_ORDINARY_S8_ENDPOINT_REQUIRED");
  return policy;
}
async function command(row: SessionRow, policy: Policy, operation: string, body: unknown, signal?: AbortSignal) {
  const token = await privateFile(policy.tokenPath, 4096);
  if (digestBytes(token) !== policy.tokenHash) throw Error("Z5_ORIGINAL_S8_ACTOR_TOKEN_CHANGED");
  const timeout = Math.min(policy.timeoutMs, row.deadline_at.getTime() - Date.now());
  if (timeout <= 0) throw Error("Z5_ORIGINAL_S8_DEADLINE_EXHAUSTED");
  const response = await fetch(policy.endpoint + "/command", { method: "POST", redirect: "error", credentials: "omit",
    headers: { authorization: "Bearer " + token.toString(), "content-type": "application/json" },
    body: canonical({ requestId: "z5-original-s8:" + randomUUID(), operation, body }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
  if (!response.body) throw Error("Z5_ORIGINAL_S8_RESPONSE_REQUIRED");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength; if (bytes > 1024 * 1024) throw Error("Z5_ORIGINAL_S8_RESPONSE_BOUND");
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  if (!response.ok) throw Error("Z5_ORIGINAL_S8_CONSUMER_REFUSED");
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as { assertion: NativeS8Assertion; nativeReference: ExperimentRef; current?: boolean };
}
const digestBytes = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function verifyReference(row: SessionRow, policy: Policy, answer: Awaited<ReturnType<typeof command>>) {
  const assertion = answer.assertion, reference = RefSchema.parse(answer.nativeReference);
  if (reference.owner !== "S8" || reference.contentDigest !== digest(assertion)
    || assertion.schema !== "finnor.s8.z5-original-composition-check.v1"
    || assertion.tenantId !== row.tenant_id || assertion.principalId !== row.principal_id || assertion.requestId !== row.id
    || assertion.workId !== row.work_id || assertion.generation !== row.generation || assertion.artifactDigest !== row.artifact_digest
    || assertion.inputDigest !== digest(row.input) || assertion.sourceDigest !== row.source_digest
    || assertion.liveDigest !== row.cut.liveDigest || assertion.ownerCutDigest !== digest(row.cut)
    || assertion.rightsRevision !== row.rights_revision || assertion.rightsRef !== row.cut.rightsRef
    || assertion.originalDeadline !== row.request.originalDeadline || assertion.lifecyclePolicyDigest !== policy.lifecyclePolicyDigest
    || assertion.domain !== "ORDINARY_DEVELOPMENT" || assertion.protectedAdmission !== false
    || assertion.productionActivated !== false || assertion.executionAuthorityGranted !== false || assertion.check.checked !== true)
    throw Error("Z5_ORIGINAL_S8_NATIVE_ASSERTION_BINDING");
  const accepted = await readOwnerTransportReference({ semanticOwner: "S8", tenantId: row.tenant_id, principalId: row.principal_id }, reference.id);
  const { content, ...descriptor } = accepted.reference;
  if (digest(descriptor) !== digest(reference) || digest(content) !== digest(assertion))
    throw Error("Z5_ORIGINAL_S8_AUTHENTICATED_REFERENCE_REQUIRED");
  return { assertion, nativeReference: reference, policyDigest: policy.lifecyclePolicyDigest };
}
export async function requestOriginalS8Check(row: SessionRow, physical: unknown, signal?: AbortSignal) {
  const policy = await configuration(row);
  return verifyReference(row, policy, await command(row, policy, "Z5_COMPOSITION_ADMIT", {
    tenantId: row.tenant_id, principalId: row.principal_id, requestId: row.id, physical: physical ?? null }, signal));
}
export async function recheckOriginalS8Admission(row: SessionRow, admission: Admission) {
  const policy = await configuration(row);
  if (admission.nativeS8PolicyDigest !== policy.lifecyclePolicyDigest) throw Error("Z5_ORIGINAL_S8_POLICY_CHANGED");
  const result = await command(row, policy, "Z5_COMPOSITION_CURRENT", {
    tenantId: row.tenant_id, principalId: row.principal_id, requestId: row.id, nativeReference: admission.nativeS8Reference });
  if (result.current !== true || digest(result.nativeReference) !== digest(admission.nativeS8Reference))
    throw Error("Z5_ORIGINAL_S8_CURRENT_ADMISSION_REFUSED");
  await verifyReference(row, policy, result);
}
