/** Consume an independently issued V3 domain receipt. This does not widen the
 * S5 payload lifecycle, mint admission, or activate any activity-specific grant. */
import { verify } from "node:crypto";
import { z } from "zod";
import { ClosingOwnerRefSchema } from "@finnor/shared-types";
import { canonical } from "../../governed-execution/src/protocol";

const Receipt = z.object({
  schema: z.literal("finnor.s8.closing-domain-admission.v1"),
  owner: z.literal("S8"), domain: z.literal("V3_AUTONOMOUS_TRANSACTION_CLOSURE"),
  profileDigest: z.string().regex(/^[a-f0-9]{64}$/),
  checkerDigest: z.string().regex(/^[a-f0-9]{64}$/),
  apiRuntimeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  workerRuntimeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  providerContractDigest: z.string().regex(/^[a-f0-9]{64}$/),
  professionalProfileRef: ClosingOwnerRefSchema,
  prerequisiteAdmissions: z.object({ V1: ClosingOwnerRefSchema, V2: ClosingOwnerRefSchema }).strict(),
  preregistrationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  evaluatorReceiptRef: ClosingOwnerRefSchema,
  rehearsalReportRef: ClosingOwnerRefSchema,
  minimumRehearsals: z.number().int().min(50),
  minimumReferenceCompletable: z.number().int().min(30),
  minimumAdverse: z.number().int().min(20),
  confidenceGatePassed: z.literal(true),
  falseCloseCount: z.literal(0),
  unauthorizedFinancialSignatureWaiverCount: z.literal(0),
  duplicateFinancialEffectCount: z.literal(0),
  permittedEnvironment: z.enum(["REHEARSAL", "LIVE"]),
  validFrom: z.string().datetime({ offset: true }),
  validUntil: z.string().datetime({ offset: true }),
  issuerKeyId: z.string().min(1).max(160),
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
}).strict();
export function validateClosingAdmission(value: unknown, expected: {
  profileDigest: string; checkerDigest: string; environment: "REHEARSAL" | "LIVE";
  apiRuntimeDigest: string; workerRuntimeDigest: string; providerContractDigest: string;
}, trustedIssuerKeys: Readonly<Record<string, string>>, now = Date.now()) {
  const parsed = Receipt.safeParse(value);
  if (!parsed.success) return { admitted: false as const, reason: "S8_V3_EXACT_DOMAIN_RECEIPT_UNAVAILABLE" };
  const { signature, ...body } = parsed.data, key = trustedIssuerKeys[body.issuerKeyId];
  let valid = false;
  try { valid = Boolean(key && verify(null, Buffer.from(canonical(body)), key, Buffer.from(signature, "base64"))); } catch { /* No admission. */ }
  if (!valid || Date.parse(body.validFrom) > now || Date.parse(body.validUntil) <= now
      || Object.entries(expected).some(([k, v]) => (k === "environment" ? body.permittedEnvironment : body[k as keyof typeof body]) !== v)) {
    return { admitted: false as const, reason: "S8_V3_SIGNATURE_EXACT_BINDING_OR_VALIDITY_UNPASSED" };
  }
  return { admitted: true as const, receipt: parsed.data, activitySpecificAuthorityGranted: false as const, economicQualificationGranted: false as const };
}
