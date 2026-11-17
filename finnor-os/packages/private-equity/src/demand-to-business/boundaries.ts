import { z } from "zod";
import { digestSchema, eventSchema, growthInputSchema, instantSchema, moneySchema, nativeRefSchema,
  scopeSchema, sourceRefSchema } from "./contracts";

const key = z.string().trim().min(1).max(160), uuid = z.string().uuid();
export const growthMandateSchema = z.object({
  schema: z.literal("finnor.growth-mandate.v1"), scope: scopeSchema,
  authorizedByPrincipalId: uuid, purpose: key, permittedCapabilityIds: z.array(key).min(1).max(32),
  maximumContacts: z.number().int().positive().max(256), maximumMoney: moneySchema,
  maximumHumanSeconds: z.number().int().nonnegative().max(86400),
  validFrom: instantSchema, expiresAt: instantSchema, revoked: z.boolean(),
}).strict();
/** A private S1 original. Its author is supplied by authentication, not this body.
 * Data records evidence and limitations; it cannot issue S2/S3/S7 qualification. */
export const growthEvidenceSchema = z.object({
  schema: z.literal("finnor.growth-evidence.v1"), scope: scopeSchema,
  kind: z.enum(["CAPABILITY", "DEMAND", "POPULATION", "TEST_PROTOCOL", "ACCOUNTING_POLICY", "CONSENT", "INVOICE", "ACCOUNTING"]),
  subjectId: key, validFrom: instantSchema, validUntil: instantSchema,
  data: z.record(z.string(), z.unknown()), basis: z.array(sourceRefSchema).max(32),
  nativeRefs: z.array(nativeRefSchema).max(32),
  limitations: z.array(z.string().min(1).max(2000)).min(1).max(32),
}).strict();
export const nativeGrowthIRSchema = z.object({
  tenantId: uuid, principalId: uuid, obligationRef: nativeRefSchema,
  allocationRef: nativeRefSchema, effectRef: z.unknown(),
  members: z.array(z.object({
    semantic: z.object({ operation: key, unit: key, dose: z.number().finite(),
      target: z.object({ entityType: key, entityId: uuid }).passthrough() }).passthrough(),
    request: z.object({ kind: z.literal("CONDITIONAL_JSON_FIELDS_REPLACE"), applicationAccountId: uuid,
      recordKey: z.string().min(1).max(1024), changes: z.record(z.string(), z.number().finite()) }).passthrough(),
  }).passthrough()).length(1),
}).passthrough();
export const growthNativeExecutionSchema = z.object({
  schema: z.literal("finnor.growth-native-execution.v1"), scope: scopeSchema,
  buyerId: uuid, offerId: key, termsDigest: digestSchema,
  operation: z.enum(["OFFER", "DELIVER", "COLLECT", "REFUND"]), applicationAccountId: uuid,
  quantity: z.number().int().positive().max(1000000).nullable(), amount: moneySchema.nullable(),
  basis: z.array(sourceRefSchema).max(32),
  obligationRef: nativeRefSchema, parentAllocation: nativeRefSchema,
  execution: z.object({
    request: z.object({ ref: nativeRefSchema, ir: z.record(z.string(), z.unknown()),
      admissions: z.array(z.unknown()).min(1).max(64) }).strict(),
    authorization: z.object({ body: z.record(z.string(), z.unknown()), signature: z.string().min(1).max(256) }).strict(),
  }).strict(),
}).strict().superRefine((v, c) => {
  if (["OFFER", "DELIVER"].includes(v.operation) ? v.quantity === null || v.amount !== null
    : v.quantity !== null || v.amount === null)
    c.addIssue({ code: "custom", message: "Native operation requires exact quantity or exact money, not both" });
});
export type GrowthNativeExecution = z.infer<typeof growthNativeExecutionSchema>;
export const growthSourceBodySchema = z.union([growthMandateSchema, growthInputSchema,
  growthEvidenceSchema, growthNativeExecutionSchema]);
export const writeGrowthSourceSchema = z.object({
  workId: uuid, idempotencyKey: key, purpose: key, protocolId: uuid.nullable(), body: growthSourceBodySchema,
}).strict();
export const submitGrowthSchema = z.object({
  workId: uuid, workInputId: uuid, idempotencyKey: key, outcomeSource: sourceRefSchema,
  budgetObligationRef: nativeRefSchema, s7EstimandId: z.string().min(1).max(1024).nullable(),
}).strict();
export const growthParticipantRoles = ["BUYER", "OPERATOR", "ACCOUNTANT", "INDEPENDENT_OBSERVER"] as const;
export const growthProtocolKinds = ["EVIDENCE", "RESPONSE", "DELIVERY", "DELIVERY_ACCEPTANCE",
  "COLLECTION", "RECOGNITION", "REFUND", "SUPPORT", "COST", "TEST_CLOSED", "MARKET_CHANGE"] as const;
export const inviteGrowthSchema = z.object({
  scope: scopeSchema, requestId: uuid.nullable(), participantId: uuid, buyerId: uuid.nullable(),
  offerId: key.nullable(), termsDigest: digestSchema.nullable(), role: z.enum(growthParticipantRoles),
  permittedKinds: z.array(z.enum(growthProtocolKinds)).min(1).max(11), purpose: key,
  evidenceKinds: z.array(growthEvidenceSchema.shape.kind).max(8), expiresAt: instantSchema,
}).strict();
export const reportGrowthSchema = z.object({ protocolId: uuid, idempotencyKey: key, event: eventSchema }).strict();
export const growthProgressOriginalSchema = z.object({
  protocolId: uuid, participantId: uuid, scope: scopeSchema, expiresAt: instantSchema,
  events: z.array(z.object({ source: sourceRefSchema, body: eventSchema, authorId: uuid,
    role: z.enum(growthParticipantRoles), receivedAt: instantSchema,
    evidenceClass: z.enum(["CONTROLLED", "REPLAYED"]) }).strict()).max(129),
  executions: z.array(z.object({ source: sourceRefSchema, operation: z.enum(["OFFER", "DELIVER", "COLLECT", "REFUND"]),
    quantity: z.number().int().positive().nullable(), amount: moneySchema.nullable(),
    obligationRef: nativeRefSchema }).strict()).max(65),
  evidence: z.array(z.object({ source: sourceRefSchema, kind: growthEvidenceSchema.shape.kind, subjectId: key,
    validFrom: instantSchema, validUntil: instantSchema, data: z.object({
      buyerId: uuid.nullable(), offerId: key.nullable(), termsDigest: digestSchema.nullable(),
      amount: moneySchema.nullable(), category: z.string().nullable(),
    }).strict() }).strict()).max(65),
}).strict();
export const growthJobSchema = z.object({
  tenantId: uuid, principalId: uuid, requestId: uuid,
  generation: z.number().int().positive(), wakeRevision: z.number().int().positive(),
}).strict();
export type GrowthJobPayload = z.infer<typeof growthJobSchema>;
export const growthOperationSchemas = {
  intake: z.object({ companyId: uuid, instruction: z.string().min(1).max(8000), idempotencyKey: key }).strict(),
  "prepare-native": z.object({ workId: uuid, mandateSource: sourceRefSchema,
    preparationRef: nativeRefSchema, allocationRef: nativeRefSchema, consumptionRef: nativeRefSchema }).strict(),
  source: writeGrowthSourceSchema, submit: submitGrowthSchema, read: z.object({ workId: uuid }).strict(),
  advance: z.object({ requestId: uuid, expectedArtifactDigest: digestSchema }).strict(),
  invite: inviteGrowthSchema, inbox: z.object({}).strict(),
  "protocol-progress": z.object({ protocolId: uuid }).strict(),
  consent: z.object({ protocolId: uuid, revoke: z.boolean() }).strict(), report: reportGrowthSchema,
} as const;
