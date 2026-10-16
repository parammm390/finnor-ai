import { z } from 'zod';
import { r3Quantity } from './exact';
import type { ElicitationProblem } from '../../../shared-types/src/elicitation-protocol';
import { ExperimentRefSchema } from '../experiments';

const text = z.string().min(1).max(256), time = z.string().datetime({ offset: true });
export const R3QuantitySchema = z.object({
  numerator: z.string().max(128).regex(/^(?:0|-?[1-9]\d*)$/),
  denominator: z.string().max(128).regex(/^[1-9]\d*$/),
}).strict().refine(v => { try { r3Quantity(v); return true } catch { return false } }, 'Reduced canonical rational required');
const ref = ExperimentRefSchema, quantity = R3QuantitySchema;
const root = z.object({ entityType: text, entityId: z.string().uuid() }).strict();
const horizon = z.object({ startAt: time, periodMs: z.number().int().positive().max(31536000000), periods: z.number().int().min(1).max(24) }).strict();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const R3ProgramTargetSchema = z.object({
  grammar: z.literal('r3-m3-report-extension-v1'), queryId: z.string().uuid(),
  programRef: ref, candidateDigest: digest, policyRef: ref,
}).strict();
const party = z.object({
  id: text, entityType: text, entityId: z.string().uuid(), reportingPrincipalId: z.string().uuid(),
  rightsRef: text, sourceRef: ref, assumptionRef: ref,
  types: z.array(z.object({ id: text, values: z.record(text, quantity), dateMultipliers: z.record(text, quantity),
    outsideOptions: z.array(z.object({ otherReports: z.array(text).max(3), utility: quantity }).strict()).min(1).max(27) }).strict()).min(1).max(3),
  payments: z.array(z.object({ dateId: text, minimum: quantity, maximum: quantity }).strict()).min(1).max(8),
  liabilityCap: quantity,
}).strict();
export const R3ProblemSchema = z.object({
  schema: z.literal('finnor.r3.problem.v1'),
  binding: z.object({ tenantId: z.string().uuid(), principalId: z.string().uuid(), workId: z.string().uuid(),
    workRevision: z.string().uuid(), workDigest: digest, root, preferenceRef: ref, mandateRef: ref,
    domainRef: ref, paymentContractRef: ref, rightsRef: text, backendDigest: digest, checkerDigest: digest,
    producerDigest: digest, schemaDigest: digest, sourceManifestDigest: digest,
    programTarget: R3ProgramTargetSchema.optional() }).strict(),
  model: z.object({ utility: z.literal('SUPPLIED_QUASILINEAR'), participation: z.literal('EX_POST_ALL_OTHER_REPORTS'),
    events: z.literal('UNCONDITIONAL_DUE_TIME'), guarantee: z.literal('INDIVIDUAL_WEAK_DSIC') }).strict(),
  money: z.object({ currency: z.string().regex(/^[A-Z]{3}$/), unit: text, valuationDate: time, ownerId: z.string().uuid(),
    timeConvention: text, discountConvention: text, ownerDateMultipliers: z.record(text, quantity),
    ownerPeriodMultipliers:z.array(quantity).min(2).max(25) }).strict(),
  parties: z.array(party).min(1).max(4),
  dates: z.array(z.object({ id: text, at: time, period: z.number().int().min(0).max(24), trigger: z.literal('DUE_TIME'),
    observableBy: z.literal('OWNER_CLOCK'), contractRef: ref, defaultCondition: z.literal('RETAIN_OUTSTANDING_LIABILITY'),
    grossOutflowCap: quantity, escrowCap: quantity }).strict()).min(1).max(8),
  outcomes: z.array(z.object({ id: text, meaningRef: ref, eligibility: z.union([z.literal('ALL_REPORTS'), z.array(z.array(text).max(4)).max(81)]),
    demands: z.record(text, z.array(quantity).min(2).max(25)), costs: z.array(quantity).min(2).max(25),
    liabilities: z.array(quantity).min(2).max(25) }).strict()).min(1).max(3),
  resources: z.array(z.object({ ref, resourceId: text, unit: text,
    kind: z.enum(['STOCK', 'FLOW', 'OCCUPANCY', 'CUMULATIVE_EXPENDITURE', 'EXPOSURE']), horizon,
    availability: z.array(quantity).min(2).max(25), baseline: z.array(quantity).min(2).max(25),
    minimumBaseline: z.array(quantity).min(2).max(25), safetyMargin: quantity }).strict()).min(1).max(16),
  covenants: z.array(z.object({ id: text, sourceRef: ref, unit: text, periods: z.array(z.number().int().min(0).max(24)).min(1).max(25),
    terms: z.array(z.object({ resourceId: text, coefficient: quantity }).strict()).min(1).max(16),
    maximum: quantity, safetyMargin: quantity }).strict()).max(32),
  constraints: z.object({ cashResourceId: text, netTransferMinimum: quantity, netTransferMaximum: quantity,
    incomingPromisesMayFund: z.literal(false), ownerLiabilityCap: quantity }).strict(),
  mandateLimits: z.object({
    dimensions: z.array(z.object({ resourceId: text, unit: text, totalLimit: quantity, capacity: quantity }).strict()).min(1).max(16),
    couplings: z.array(z.object({ id: text, weights: z.record(text, quantity), maximum: quantity }).strict()).max(32),
  }).strict(),
  objective: z.object({ kind: z.enum(['MAXIMIN', 'EXPECTED_QUALIFIED_JOINT']),
    valueByProfile: z.record(text, z.record(text, quantity)), weights: z.array(quantity).max(81).nullable(),
    distributionRef: ref.nullable(), range: z.tuple([quantity, quantity]), normalization: quantity,
    minimumValue: quantity,
    tieConvention: z.literal('NO_STRICT_TRUTH_OR_CONSENT_FROM_TIES') }).strict(),
  assumptions: z.array(z.string().min(1).max(2048)).min(1).max(64),
  referenceGrid: z.array(quantity).min(1).max(8).optional(),
}).strict();
export const parseR3Problem = (value: unknown): ElicitationProblem => R3ProblemSchema.parse(value) as ElicitationProblem;
export const R3PreferenceDeclarationSchema = R3ProblemSchema.omit({ binding: true, resources: true, covenants: true, mandateLimits: true, schema: true, referenceGrid: true }).extend({
  schema: z.literal('finnor.r3.preference-declaration.v1'), workId: z.string().uuid(), workRevision: z.string().uuid(),
  root, mandateRef: ref, domainRef: ref, paymentContractRef: ref, rightsRef: text,
  asOf: time, validUntil: time,
  provenance: z.literal('OWNER_SUPPLIED_PREFERENCE_HYPOTHESIS_NOT_OBSERVED_PRIVATE_TRUTH'),
  behavioralQualification: z.literal('UNQUALIFIED'), permittedReporting: z.literal('EXACT_DECLARED_PRINCIPALS_ONLY'),
}).strict();
const source = z.object({ sourceId: z.string().uuid(), versionId: z.string().uuid(), contentDigest: digest }).strict();
const requestId = z.object({ requestId: z.string().uuid() }).strict();
export const ELICITATION_OPERATIONS = ['submit','read','status','cancel','context','review','reserve','schedules','report','close','event','history','use'] as const;
export const ElicitationOperationSchemas = {
  submit: z.object({ envelope_inputs: z.object({ mode: z.literal('ordinary_disposable') }).strict(),
    problem_ref: source, existing_work_revision: z.object({ workId: z.string().uuid(), revision: z.string().uuid(), root }).strict(),
    domain_profile_ref: ref, budget_grant_ref: ref, cancellation_ref: text, incumbentPolicyRef: ref,
    programTarget: R3ProgramTargetSchema.optional(),
    idempotencyKey: text, limits: z.object({ deadlineAt: time, maxAttempts: z.number().int().min(2).max(32),
      childSeconds: z.number().int().min(1).max(25) }).strict() }).strict(),
  read: requestId, status: requestId, cancel: requestId,
  context: z.object({ workId: z.string().uuid(), root, programTarget: R3ProgramTargetSchema.optional() }).strict(),
  review: requestId.extend({ decision: z.enum(['PROPOSE_USE', 'INQUIRE', 'WAIT', 'STOP']), reason: z.string().min(1).max(2048) }),
  reserve: requestId, schedules: requestId,
  report: requestId.extend({ partyId: text, typeId: text, replacesEventId: text.nullable(), idempotencyKey: text }),
  close: requestId,
  event: requestId.extend({ partyId: text, kind: z.enum(['DECLINE', 'NO_RESPONSE', 'OBSERVED_ACCEPTANCE', 'OUT_OF_DOMAIN']),
    observation: source, idempotencyKey: text }),
  history: requestId,
  use: requestId.extend({ idempotencyKey: text }),
} as const;
export type R3Submit = z.infer<typeof ElicitationOperationSchemas.submit>;
export const R3_BASE = Object.freeze({ commit: '517003a4396bc8101a90be4b425ee01de9446740', tree: '07ba69b8e96f05944c2f9f14a74b2c400eb89e42' });
