import { z } from 'zod';
import { ExperimentRefSchema as ref } from '../experiments';
import { R3ProblemSchema, R3QuantitySchema as quantity } from './contracts';

const text = z.string().min(1).max(2048), id = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/), time = z.string().datetime({ offset: true });
export const R3RuleRowSchema = z.object({
  reports: z.array(text).length(4), outcomeId: text,
  schedule: z.array(z.object({ partyId: text, dateId: text, amount: quantity, eventId: text,
    currency: z.string().regex(/^[A-Z]{3}$/), unit: text, dueAt: time }).strict()).min(4).max(32),
}).strict();
export const R3RuleSchema = z.object({
  schema: z.literal('finnor.r3.rule.v1'), inputDigest: digest,
  binding: R3ProblemSchema.shape.binding, table: z.array(R3RuleRowSchema).length(81),
  search: z.object({ status: text, numericalSemantics: z.literal('SCIP_FLOAT64_PROPOSAL'),
    optimum: z.enum(['UNKNOWN', 'ORIGINAL_ANALYTIC_BOUND_ATTAINED']),
    claimedObjective: quantity, claimedUpper: quantity.nullable(), proof: z.null(), trace: z.record(z.string(), z.unknown()) }).strict(),
}).strict();
export const R3CheckSchema = z.object({
  schema: z.literal('finnor.r3.check.v1'), accepted: z.literal(true), inputDigest: digest, ruleDigest: digest,
  checker: z.object({ sourceDigest: digest, pythonVersion: text, implementation: z.literal('INDEPENDENT_FRACTION_V1') }).strict(),
  basis: z.literal('MODEL_RELATIVE_EXACT'), counts: z.object({ profiles: z.literal(81), deviations: z.literal(648), participation: z.literal(324) }).strict(),
  failures: z.array(z.record(z.string(), z.unknown())).max(0), objective: quantity, upper: quantity.nullable(), optimizationGap: quantity.nullable(),
  optimum: z.enum(['CHECKED_ANALYTIC', 'UNKNOWN']), minimumIncentiveMargin: quantity, minimumParticipationMargin: quantity,
  maximumDeviationGain: quantity, envelopes: z.array(z.record(z.string(), z.unknown())).max(16), assumptions: z.array(text).max(64),
  consentEstablished: z.literal(false), executionAuthorityGranted: z.literal(false), behavioralTruthEstablished: z.literal(false),
}).passthrough();
export const R3ArtifactEnvelopeSchema = z.object({
  id: text, kind: z.literal('ElicitationProtocol'), schemaRevision: z.literal(1), tenantId: id, principalId: id,
  work: z.object({ id, revision: id, digest }).strict(),
  baseline: z.object({ commit: z.string().regex(/^[a-f0-9]{40}$/), tree: z.string().regex(/^[a-f0-9]{40}$/), manifestDigest: digest }).strict(),
  producer: z.object({ codeDigest: digest, lockDigest: digest, admissionRef: z.null() }).strict(),
  ownerInputs: z.array(z.object({ ref, asOf: time, rightsRef: text }).strict()).min(3).max(18),
  domainRef: ref, grammar: z.literal('r3-elicitation-use-v1'), checkBasis: z.literal('MODEL_RELATIVE_EXACT'),
  claims: z.array(z.object({ statement: text, domainRef: ref, checkerReceipt: ref }).strict()).min(1).max(32),
  gaps: z.array(z.object({ reason: text, affectedClaims: z.array(text), status: z.enum(['UNKNOWN', 'BLOCKED_EXTERNAL']) }).strict()).max(64),
  budgetGrantRef: ref, resourceReceipts: z.array(z.record(z.string(), z.unknown())).max(32),
  invalidationDependencies: z.array(z.object({ key: text, revision: z.number().int().nonnegative(),
    nodeIds: z.array(text), digest: digest.nullable() }).strict()).max(256),
  lifecycle: z.object({ state: z.literal('development-verified'), historyRefs: z.array(ref),
    domainQualified: z.literal(false), s8Admitted: z.literal(false), active: z.literal(false) }).strict(),
}).strict();
export const ElicitationProtocolSchema = z.object({
  schema: z.literal('finnor.elicitation-protocol.v1'), ref, envelope: R3ArtifactEnvelopeSchema,
  problem: R3ProblemSchema, rule: R3RuleSchema, check: R3CheckSchema,
  reporting: z.object({ schema: z.literal('r3-authorized-report-v1'), corrections: z.literal('BEFORE_CLOSE_ONLY'),
    closing: z.literal('ALL_REPORTS_OR_NO_AGREEMENT'), tableFixedBeforeReports: z.literal(true) }).strict(),
  usePolicyRef: ref.nullable(), reservation: z.record(z.string(), z.unknown()).nullable(), proposedSchedulesRef: ref.nullable(),
  agreementEstablished: z.literal(false), settlementEstablished: z.literal(false), executionAuthorityGranted: z.literal(false),
}).strict();
export const R3WorkReviewSchema = z.object({
  schema: z.literal('finnor.r3.work-review.v1'), requestId: id, workId: id, workRevision: id, tenantId: id, principalId: id,
  status: z.enum(['QUEUED', 'RUNNING', 'COMPLETE', 'INCOMPLETE', 'INFEASIBLE', 'UNSUPPORTED', 'INVALIDATED', 'CANCELLED', 'UNKNOWN']),
  deadlineAt: time, protocol: ElicitationProtocolSchema.nullable(), usePolicy: z.record(z.string(), z.unknown()).nullable(),
  allocation: z.record(z.string(), z.unknown()).nullable(), schedules: z.record(z.string(), z.unknown()).nullable(), reportState: z.record(z.string(), z.unknown()).nullable(),
  costs: z.record(z.string(), z.unknown()), reason: z.string().nullable(), provisional: z.boolean(),
  agreementEstablished: z.literal(false), settlementEstablished: z.literal(false), executionAuthorityGranted: z.literal(false),
}).strict();
/** Only this R3 artifact is contributed. No other algorithm output is invented. */
export const R3_OUTPUT_SCHEMA_CONTRIBUTION = {
  artifact: 'ElicitationProtocol', schema: 'finnor.elicitation-protocol.v1',
  grammar: 'r3-elicitation-use-v1', quantities: 'CANONICAL_RATIONAL_NUMERATOR_DENOMINATOR',
  checkBasis: 'MODEL_RELATIVE_EXACT', domain: 'FOUR_PARTIES_THREE_TYPES_THREE_OUTCOMES',
  consumerOwners: ['S3', 'S4', 'S5', 'S6'], admissionGranted: false,
} as const;

export const R3OwnerOperationSchemas = {
  interventions: { 'finite-preference': z.object({ modelRef: ref }).strict() },
  policies: {
    'read-mechanism': z.object({ policyRef: ref }).strict(),
    'decide-mechanism': z.object({ policyRef: ref }).strict(),
  },
  allocations: {
    'clear-mechanism': z.object({ requestId: id, idempotencyKey: z.string().min(1).max(256) }).strict(),
    'consume-mechanism': z.object({ requestId: id, idempotencyKey: z.string().min(1).max(256) }).strict(),
  },
} as const;
