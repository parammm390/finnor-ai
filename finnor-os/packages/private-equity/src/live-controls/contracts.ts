import { z } from 'zod';
import { EvidenceRootSchema, FinancialSemanticsSchema, type AllocationClearingInput } from '@finnor/shared-types';
import { AllocationOperationSchemas } from '@finnor/epistemic-runtime';
import { PE_ENTITY_TYPES } from '../types';
import { ObligationOperationSchemas, GovernedRequestBindingSchema } from '../obligation-contracts';

export const LIVE_CONTROL_VERSION = 'v5-live-institutional-control-v1' as const;
export const LIVE_CONTROL_OPERATIONS = [
  'open', 'snapshot', 'events', 'branch', 'evaluate', 'share', 'rebase',
  'propose', 'approve', 'dispatch', 'recover', 'withdraw', 'compile-request',
] as const;
const uuid = z.string().uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const key = z.string().min(1).max(200);
const timestamp = z.string().datetime({ offset: true });
const exactDecimal = z.string().max(160).regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/);
const value = z.union([z.string().max(4000), z.boolean(), z.record(z.string().max(96), z.union([z.string().max(160), z.boolean()]))]);
export const ControlObjectSchema = z.object({
  type: z.enum([...PE_ENTITY_TYPES, 'external_organization', 'external_contact', 'work',
    'underwriting_run', 'underwriting_scenario', 'underwriting_model', 'underwriting_model_version',
    'document', 'document_version', 'evidence_source', 'evidence_source_version', 'business_effect', 'domain_action']),
  id: uuid,
}).strict();
export const ControlRefSchema = z.object({
  owner: z.string().min(1).max(64), id: key, version: z.string().min(1).max(100), contentDigest: sha256,
}).strict();
export const ConsequenceGrantSchema = z.object({
  allocationRef: ControlRefSchema, policyRef: ControlRefSchema,
  programmeRef: uuid.nullable(),
}).strict();
export type ConsequenceGrant = z.infer<typeof ConsequenceGrantSchema>;
export const OwnerVectorSchema = z.record(z.string().min(1).max(256), z.string().min(1).max(256))
  .refine(vector => Object.keys(vector).length <= 4096, 'Owner revision vector exceeds its finite bound');
export const QuantityContextSchema = z.object({
  semantics: FinancialSemanticsSchema,
  legalEntityRef: ControlObjectSchema,
  ownerShare: z.object({ numerator: z.string().regex(/^\d{1,96}$/), denominator: z.string().regex(/^[1-9]\d{0,95}$/) }).strict(),
  valuationAt: timestamp,
  rounding: z.literal('EXACT_NO_EXECUTION_ROUNDING'),
}).strict().superRefine((quantity, ctx) => {
  if (BigInt(quantity.ownerShare.numerator) > BigInt(quantity.ownerShare.denominator)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Owner share cannot exceed one' });
  if (Date.parse(quantity.semantics.periodEnd) < Date.parse(quantity.semantics.periodStart)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Quantity period is reversed' });
  if (quantity.semantics.unit === 'currency' && quantity.semantics.currencyCode === null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Money requires an explicit currency' });
});

export const UnderwritingControlIntentSchema = z.object({
  kind: z.literal('UNDERWRITING_ASSUMPTIONS'),
  investmentCaseId: uuid, modelVersionId: uuid, baseRunId: uuid,
  worldAt: timestamp,
  name: z.string().trim().min(1).max(240),
  overrides: z.array(z.object({
    nodeId: z.string().min(1).max(240),
    value, unit: z.enum(['money', 'rate', 'multiple', 'ratio', 'count', 'date', 'period', 'boolean', 'text']),
    currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
    quantityContext: QuantityContextSchema.nullable(),
    reason: z.string().trim().min(1).max(1000),
  }).strict()).min(1).max(100),
}).strict().superRefine((intent, ctx) => {
  if (new Set(intent.overrides.map(item => item.nodeId)).size !== intent.overrides.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A typed intent cannot change one input twice' });
  for (const item of intent.overrides) {
    if (item.unit === 'money' && (!item.currency || !item.quantityContext)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Monetary edits require complete quantity context' });
    if (['money', 'rate', 'multiple', 'ratio', 'count', 'period'].includes(item.unit)) {
      const values = typeof item.value === 'object' ? Object.values(item.value) : [item.value];
      if (values.some(entry => !exactDecimal.safeParse(entry).success)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Financial values must be exact bounded decimal strings, not floating-point numbers' });
    }
  }
});
export const AllocationControlIntentSchema = z.object({
  kind: z.literal('S5_ALLOCATION'),
  request: AllocationOperationSchemas.clear,
  selectedPolicyIds: z.array(key).min(1).max(32),
  quantityContext: QuantityContextSchema,
  handoff: z.object({ policyRef: ControlRefSchema, decision: z.record(z.unknown()) }).strict().nullable(),
}).strict();
export const NativeActionIntentSchema = z.object({
  kind: z.literal('NATIVE_ACTION'),
  actionType: z.string().regex(/^[a-z][a-z0-9_]{1,100}$/),
  payload: z.record(z.unknown()),
  quantityContext: QuantityContextSchema.nullable(),
  professionalAuthorityRef: ControlRefSchema.nullable(),
}).strict();
export const GovernedRequestIntentSchema = z.object({
  kind: z.literal('GOVERNED_REQUEST'),
  execution: ObligationOperationSchemas['schedule-request'],
  quantityContext: QuantityContextSchema,
}).strict();
export const ControlIntentSchema = z.union([
  UnderwritingControlIntentSchema, AllocationControlIntentSchema, NativeActionIntentSchema, GovernedRequestIntentSchema,
]);
export type ControlIntent = z.infer<typeof ControlIntentSchema>;
export type OwnerVector = z.infer<typeof OwnerVectorSchema>;
export type ControlObjectRef = z.infer<typeof ControlObjectSchema>;
export type UnderwritingControlIntent = z.infer<typeof UnderwritingControlIntentSchema>;
export type AllocationControlIntent = z.infer<typeof AllocationControlIntentSchema>;
export const allocationInput = (request: AllocationControlIntent['request']): AllocationClearingInput => ({ ...request, mandate: request.mandate });

const session = { sessionId: uuid };
const branch = { ...session, branchId: uuid };
const expected = { expectedOwnerVector: OwnerVectorSchema };
export const LIVE_CONTROL_OPERATION_SCHEMAS = {
  open: z.object({ workId: uuid, root: EvidenceRootSchema, focus: ControlObjectSchema }).strict(),
  snapshot: z.object(session).strict(),
  events: z.object({ ...session, cursor: z.string().min(1).max(4096), projectionDigest: sha256 }).strict(),
  branch: z.object({ ...session, ...expected, intent: ControlIntentSchema, consequenceGrant: ConsequenceGrantSchema.nullable(), visibility: z.enum(['PRIVATE', 'SHARED']), idempotencyKey: key }).strict(),
  evaluate: z.object({ ...branch, idempotencyKey: key }).strict(),
  share: z.object({ ...branch, ...expected, visibility: z.enum(['PRIVATE', 'SHARED']), idempotencyKey: key }).strict(),
  rebase: z.object({ ...branch, ...expected, intent: ControlIntentSchema, consequenceGrant: ConsequenceGrantSchema.nullable(), reason: z.string().trim().min(1).max(1000), idempotencyKey: key }).strict(),
  propose: z.object({ ...branch, ...expected, idempotencyKey: key }).strict(),
  approve: z.object({ ...session, proposalId: uuid, proposalDigest: sha256, ...expected, expiresAt: timestamp, idempotencyKey: key }).strict(),
  dispatch: z.object({ ...session, proposalId: uuid, proposalDigest: sha256, ...expected, idempotencyKey: key }).strict(),
  recover: z.object({ ...session, proposalId: uuid }).strict(),
  withdraw: z.object({ ...branch, reason: z.string().trim().min(1).max(1000), idempotencyKey: key }).strict(),
  'compile-request': z.object({ ...session, proposalId: uuid, bindings: z.array(GovernedRequestBindingSchema).min(1).max(64) }).strict(),
} as const;

export class LiveControlError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 422) { super(message); }
}
export const unavailable = () => new LiveControlError('PERMITTED_CONTEXT_UNAVAILABLE', 'The permitted control context is unavailable', 404);
export function decodeControlBody(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > 2 * 1024 * 1024) throw new LiveControlError('INPUT_LIMIT', 'Control input exceeds 2 MiB', 413);
  const todo: Array<[unknown, number]> = [[value, 0]];
  let count = 0;
  while (todo.length) {
    const [item, depth] = todo.pop()!;
    if (++count > 20000 || depth > 32) throw new LiveControlError('INPUT_LIMIT', 'Control input exceeds its finite structural bound', 413);
    if (item && typeof item === 'object') for (const child of Object.values(item)) todo.push([child, depth + 1]);
  }
}

export interface ControlConsequence {
  status: 'ACCEPTED' | 'RUNNING' | 'COMPLETE' | 'PARTIAL' | 'FAILED' | 'INVALIDATED' | 'BLOCKED';
  owner: 'P4' | 'P2' | 'S4/S5' | 'Core/S6' | 'Underwriting';
  refs: unknown[];
  result: unknown;
  materialGaps: string[];
  coverage: string[];
  modelRelative: true;
  reservesCapital: false;
  executionAuthorityGranted: false;
  costs: { status: 'OWNER_RECORDED' | 'LOCAL_COST_UNMETERED' | 'UNKNOWN'; refs: unknown[]; usage: unknown };
}
