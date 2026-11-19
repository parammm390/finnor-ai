import { z } from "zod";
import {
  SourceRefSchema, NativeRefSchema, ScopeSchema, instant, OutcomeContractSchema,
  ProviderEvidenceSchema, ObservationSchema, money, W3_BOUNDS,
} from "./contracts";

const key = z.string().trim().min(1).max(160);
export const MandateSchema = z.object({
  schema: z.literal("finnor.service-mandate.v1"), scope: ScopeSchema,
  authorizedByPrincipalId: z.string().uuid(), purpose: z.string().min(1).max(1024),
  permittedOperations: z.array(z.enum(["OFFER", "TRIAL", "BOOK", "ACCESS", "CANCEL", "PAY", "RETIRE_ACCESS"])).max(7),
  validFrom: instant, expiresAt: instant, revoked: z.boolean(),
  originalTrigger: z.enum(["EXPLICIT_OUTCOME", "STANDING_EVENT"]),
  eventSource: SourceRefSchema.nullable(),
}).strict();
export const QualificationSchema = z.object({
  schema: z.literal("finnor.service-qualification.v1"), scope: ScopeSchema,
  subjectPrincipalId: z.string().uuid(), qualificationId: key, process: z.string().min(1).max(2000),
  verifiedByPrincipalId: z.string().uuid(), expiresAt: instant,
  evidence: z.array(SourceRefSchema).min(1).max(32), limitations: z.array(z.string().min(1).max(1024)).min(1).max(32),
}).strict();
export const TriggerSchema = z.object({
  schema: z.literal("finnor.service-trigger.v1"), scope: ScopeSchema,
  kind: z.enum(["EXPLICIT_OUTCOME", "STANDING_EVENT"]),
  description: z.string().min(1).max(8000), occurredAt: instant,
  basis: z.array(SourceRefSchema).max(32),
}).strict();
const coveredTerm = z.object({
  instanceId: key, providerId: z.string().uuid(), termsDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const NativeServiceIRSchema = z.object({
  tenantId: z.string().uuid(), principalId: z.string().uuid(), obligationRef: NativeRefSchema,
  allocationRef: NativeRefSchema, effectRef: z.unknown(),
  members: z.array(z.object({
    semantic: z.object({ operation: key, unit: key, dose: z.number().finite(),
      target: z.object({ entityType: key, entityId: z.string().uuid() }).passthrough() }).passthrough(),
    request: z.object({
      kind: z.literal("CONDITIONAL_JSON_FIELDS_REPLACE"), applicationAccountId: z.string().uuid(),
      recordKey: z.string().min(1).max(1024), changes: z.record(z.string(), z.number().finite()),
    }).passthrough(),
  }).passthrough()).min(1).max(64),
}).passthrough();
export const NativeExecutionSchema = z.object({
  schema: z.literal("finnor.service-native-execution.v1"), scope: ScopeSchema,
  instanceId: key, providerId: z.string().uuid(), termsDigest: z.string().regex(/^[a-f0-9]{64}$/),
  operation: z.enum(["OFFER", "TRIAL", "BOOK", "ACCESS", "CANCEL", "PAY", "RETIRE_ACCESS"]),
  coveredTerms: z.array(coveredTerm).min(1).max(W3_BOUNDS.instances),
  paymentPlan: z.array(coveredTerm.extend({
    invoiceSource: SourceRefSchema, invoiceId: key, amount: money,
  }).strict()).max(W3_BOUNDS.instances),
  obligationRef: NativeRefSchema, parentAllocation: NativeRefSchema,
  execution: z.object({
    request: z.object({ ref: NativeRefSchema, ir: z.record(z.string(), z.unknown()),
      admissions: z.array(z.unknown()).min(1).max(64) }).strict(),
    authorization: z.object({ body: z.record(z.string(), z.unknown()), signature: z.string().min(1).max(256) }).strict(),
  }).strict(),
}).strict();
export const SourceBodySchema = z.union([
  OutcomeContractSchema, ProviderEvidenceSchema, MandateSchema, QualificationSchema, TriggerSchema, NativeExecutionSchema,
]);
export const WriteSourceSchema = z.object({
  workId: z.string().uuid(), idempotencyKey: key, purpose: z.string().min(1).max(1024),
  protocolId: z.string().uuid().nullable(), body: SourceBodySchema,
}).strict();
export const SubmitServiceSchema = z.object({
  workId: z.string().uuid(), workInputId: z.string().uuid(), idempotencyKey: key,
  outcomeSource: SourceRefSchema, providerSources: z.array(SourceRefSchema).max(128),
  budgetObligationRef: NativeRefSchema, s7EstimandId: z.string().min(1).max(1024).nullable(),
}).strict();
export const InviteSchema = z.object({
  requestId: z.string().uuid(), participantId: z.string().uuid(), instanceId: key,
  providerId: z.string().uuid(), termsDigest: z.string().regex(/^[a-f0-9]{64}$/),
  role: z.enum(["PROVIDER", "RECIPIENT", "INSPECTOR", "PROFESSIONAL", "ACCEPTANCE_OWNER"]),
  criterionIds: z.array(key).max(128),
  permittedKinds: z.array(z.enum([
    "PROVIDER_EVIDENCE", "QUOTE", "ACCEPTED", "STARTED", "DELIVERED", "OBSERVATION", "MISSED",
    "DISPUTED", "CANCELLATION_REQUESTED", "CANCELLED", "ORIGINAL_ACCEPTANCE", "INVOICE", "PAYMENT", "COST",
  ])).min(1).max(16),
  qualificationRefs: z.array(SourceRefSchema).max(32), incentiveRef: SourceRefSchema.nullable(),
  expiresAt: instant,
}).strict();
export const ReportSchema = z.object({
  protocolId: z.string().uuid(), idempotencyKey: key, observation: ObservationSchema,
}).strict();
export const ServiceJobSchema = z.object({
  tenantId: z.string().uuid(), principalId: z.string().uuid(), requestId: z.string().uuid(),
  generation: z.number().int().positive(), wakeRevision: z.number().int().positive(),
}).strict();
export type ServiceJobPayload = z.infer<typeof ServiceJobSchema>;
export type NativeServiceExecution = z.infer<typeof NativeExecutionSchema>;
export const ServiceOperationSchemas = {
  intake: z.object({ companyId: z.string().uuid(), instruction: z.string().min(1).max(8000),
    idempotencyKey: key }).strict(),
  "prepare-native": z.object({ workId: z.string().uuid(), mandateSource: SourceRefSchema,
    preparationRef: NativeRefSchema, allocationRef: NativeRefSchema, consumptionRef: NativeRefSchema }).strict(),
  source: WriteSourceSchema, submit: SubmitServiceSchema,
  read: z.object({ workId: z.string().uuid() }).strict(),
  advance: z.object({ requestId: z.string().uuid(), expectedArtifactDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  invite: InviteSchema, inbox: z.object({}).strict(),
  consent: z.object({ protocolId: z.string().uuid(), revoke: z.boolean() }).strict(),
  report: ReportSchema,
} as const;
