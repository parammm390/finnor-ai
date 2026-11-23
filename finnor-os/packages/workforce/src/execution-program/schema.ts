import { z } from 'zod';
import type { AllocationEnvelope } from '../../../shared-types/src/allocation';
import type { ExperimentRef } from '../../../shared-types/src/experiments';
import { exactQuantity } from './exact';

const id = z.string().min(1).max(256);
const time = z.string().datetime({ offset: true });
const list = <T extends z.ZodType>(schema: T) => z.array(schema).max(8192);
export const experimentRefSchema = z.object({ owner: id, id, version: id, contentDigest: id }).strict() satisfies z.ZodType<ExperimentRef>;
const quantity = z.string().refine(value => { try { exactQuantity(value); return true; } catch { return false; } }, 'Nonnegative exact decimal or reduced rational required');
export const allocationEnvelopeSchema = z.object({
  resourceId: id, unit: id, kind: z.enum(['STOCK', 'FLOW', 'OCCUPANCY', 'CUMULATIVE_EXPENDITURE', 'EXPOSURE']),
  horizon: z.object({ startAt: time, periodMs: z.number().int().positive(), periods: z.number().int().min(1).max(512) }).strict(),
  quantities: list(quantity), minimumQuantities: list(quantity),
}).strict().superRefine((e, ctx) => {
  if (e.quantities.length !== e.horizon.periods + 1 || e.minimumQuantities.length !== e.horizon.periods + 1) ctx.addIssue({ code: 'custom', message: 'Native horizon periods is the last index; both vectors require periods + 1 entries' });
  for (let i = 0; i < e.quantities.length; i++) {
    const minimum = quantity.safeParse(e.minimumQuantities[i] ?? '0');
    const maximum = quantity.safeParse(e.quantities[i] ?? '0');
    if (minimum.success && maximum.success && exactQuantity(minimum.data).compare(exactQuantity(maximum.data)) > 0)
      ctx.addIssue({ code: 'custom', message: 'Minimum exceeds maximum quantity' });
  }
}) satisfies z.ZodType<AllocationEnvelope>;
export const workforceCeilingSchema = z.object({
  capabilities: list(id), dataScopes: list(id), purposes: list(id), effects: list(id),
  validFrom: time, validUntil: time, allowSubdelegation: z.boolean(),
}).strict();
const slot = z.object({ startAt: time, endAt: time }).strict();
export const workforceTermsSchema = z.object({
  revision: z.number().int().positive(), deliverable: id,
  compensation: z.object({ value: quantity, unit: id }).strict(),
  subdelegation: z.boolean(), expiresAt: time,
}).strict();
export const actorKindSchema = z.enum(['DETERMINISTIC_SERVICE', 'MODEL_AGENT', 'COMPUTATIONAL_CELL', 'INTERNAL_HUMAN', 'EXTERNAL_PROFESSIONAL', 'PROVIDER']);
export const workforceActorSchema = z.object({
  id, tenantId: id, identityRef: experimentRefSchema, kind: actorKindSchema, status: z.enum(['CURRENT', 'REVOKED', 'UNKNOWN']),
  capabilities: list(z.object({ skill: id, scope: id, evidenceRef: experimentRefSchema, validUntil: time, certainty: z.enum(['OBSERVED', 'ASSERTED', 'UNKNOWN']) }).strict()),
  availability: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('UNKNOWN'), reason: id }).strict(),
    z.object({ kind: z.literal('OBSERVED'), ref: experimentRefSchema, validUntil: time,
      slots: list(slot.extend({ capacity: quantity, committed: quantity })), maxConcurrent: z.number().int().nonnegative(),
      humanLimits: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('NOT_HUMAN') }).strict(),
        z.object({ kind: z.literal('UNKNOWN'), reason: id }).strict(),
        z.object({ kind: z.literal('OBSERVED'), maxEffortSeconds: quantity, alreadyCommittedSeconds: quantity,
          fatigue: z.enum(['WITHIN_LIMIT', 'EXCEEDED', 'UNKNOWN']), ref: experimentRefSchema }).strict(),
      ]),
    }).strict(),
  ]),
}).strict();
export const workforceTaskSchema = z.object({
  id, parentTaskId: id.nullable(), dependsOn: list(id), returnTo: list(id), delegatorActorId: id, criterionId: id,
  requiredCapabilities: list(z.object({ skill: id, scope: id }).strict()), allowedActorKinds: list(actorKindSchema),
  assignmentMode: z.enum(['INTERNAL_AUTHORIZED', 'EXTERNAL_VOLUNTARY']),
  ceiling: workforceCeilingSchema, terms: workforceTermsSchema, dueAt: time, slot, effortSeconds: quantity,
  demand: list(allocationEnvelopeSchema),
  context: z.object({ dataScopes: list(id), purposes: list(id), includesCredentials: z.boolean() }).strict(),
  effectId: id.nullable(),
}).strict();
export const workforceCriterionSchema = z.object({
  id, ref: experimentRefSchema, checkerActorId: id, evidenceCustodianActorId: id,
}).strict();
export const workforceTaskCreationSchema = z.object({
  ref: experimentRefSchema, kind: z.enum(['SUBDELEGATION', 'RECIPROCAL_REQUEST']),
  parentAssignmentId: id, parentTermsDigest: id, actorId: id, recipientActorId: id,
  assignmentId: id, at: time, task: workforceTaskSchema, criterion: workforceCriterionSchema,
}).strict();
export const workforceOutcomeSchema = z.object({
  ref: experimentRefSchema, workId: id, rootId: id, requesterActorId: id, deadline: time,
  criteria: list(workforceCriterionSchema),
  tasks: list(workforceTaskSchema), ceiling: workforceCeilingSchema, resourceLimits: list(allocationEnvelopeSchema),
}).strict();
export const workforceStateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('PROPOSED') }).strict(),
  ...(['OFFERED', 'ACCEPTED', 'IN_PROGRESS', 'DELIVERED', 'VERIFIED', 'DECLINED', 'EXPIRED', 'CANCEL_REQUESTED',
    'CANCELLED_WITH_RESIDUAL_EXPOSURE', 'UNKNOWN_EFFECT', 'CLOSED'] as const).map(kind => z.object({ kind: z.literal(kind), ref: experimentRefSchema }).strict()),
  ...(['BLOCKED', 'DISPUTED', 'RETURNED'] as const).map(kind => z.object({ kind: z.literal(kind), ref: experimentRefSchema, reason: id }).strict()),
]);
export const workforceAssignmentSchema = z.object({
  id, taskId: id, actorId: id, delegatorActorId: id, parentAssignmentId: id.nullable(),
  rootId: id, workId: id, originalDeadline: time, attempt: z.number().int().positive(),
  terms: workforceTermsSchema, termsDigest: id, ceiling: workforceCeilingSchema,
  state: workforceStateSchema,
});
const actionKinds = ['OFFER', 'ACCEPT', 'DECLINE', 'START', 'BLOCK', 'DELIVER', 'VERIFY', 'DISPUTE', 'RETURN', 'EXPIRE',
  'CANCEL', 'CONFIRM_CANCEL', 'MARK_UNKNOWN_EFFECT', 'RECONCILE', 'CLOSE', 'REVISE_TERMS', 'REASSIGN', 'REVOKE', 'SUBDELEGATE'] as const;
export const workforceActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('OFFER'), offerRef: experimentRefSchema }).strict(),
  z.object({ kind: z.literal('ACCEPT'), dispositionRef: experimentRefSchema }).strict(),
  z.object({ kind: z.literal('DECLINE'), dispositionRef: experimentRefSchema }).strict(),
  z.object({ kind: z.literal('START'), observationRef: experimentRefSchema }).strict(),
  z.object({ kind: z.literal('BLOCK'), observationRef: experimentRefSchema, reason: id }).strict(),
  z.object({ kind: z.literal('DELIVER'), deliveryRef: experimentRefSchema }).strict(),
  z.object({ kind: z.literal('VERIFY'), verificationRef: experimentRefSchema }).strict(),
  z.object({ kind: z.literal('DISPUTE'), observationRef: experimentRefSchema, reason: id }).strict(),
  z.object({ kind: z.literal('RETURN'), observationRef: experimentRefSchema, reason: id }).strict(),
  z.object({ kind: z.literal('EXPIRE'), observationRef: experimentRefSchema }).strict(),
  z.object({ kind: z.literal('CANCEL'), observationRef: experimentRefSchema }).strict(),
  z.object({ kind: z.literal('CONFIRM_CANCEL'), observationRef: experimentRefSchema }).strict(),
  z.object({ kind: z.literal('MARK_UNKNOWN_EFFECT'), effectRef: experimentRefSchema }).strict(),
  z.object({ kind: z.literal('RECONCILE'), reconciliationRef: experimentRefSchema }).strict(),
  z.object({ kind: z.literal('CLOSE'), observationRef: experimentRefSchema }).strict(),
  z.object({ kind: z.literal('REVISE_TERMS'), termChangeRef: experimentRefSchema }).strict(),
  z.object({ kind: z.literal('REASSIGN'), replacementActorId: id, replacementAssignmentId: id, reconciliationRef: experimentRefSchema.nullable() }).strict(),
  z.object({ kind: z.literal('REVOKE'), observationRef: experimentRefSchema, reason: id }).strict(),
  z.object({ kind: z.literal('SUBDELEGATE'), taskCreationRef: experimentRefSchema }).strict(),
]);
export const authenticatedWorkforceCommandSchema = z.object({
  id, expectedRevision: z.number().int().nonnegative(), actorId: id, assignmentId: id,
  at: time, authorityRef: experimentRefSchema, action: workforceActionSchema,
}).strict();
export const workforceHistoryAnchorSchema = z.object({
  revision: z.number().int().nonnegative().max(8192), commandsDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const unknownFactor = z.object({ kind: z.literal('UNKNOWN'), reason: id }).strict();
const evidencedFactor = z.object({
  kind: z.literal('EVIDENCED'), value: quantity, evidenceRef: experimentRefSchema, admission: z.enum(['UNADMITTED', 'ADMITTED']),
}).strict();
export const workforceMatchingObservationSchema = z.object({
  ref: experimentRefSchema, taskId: id, actorId: id, validUntil: time,
  cost: z.discriminatedUnion('kind', [unknownFactor, evidencedFactor.extend({ unit: id })]),
  latencySeconds: z.discriminatedUnion('kind', [unknownFactor, evidencedFactor]),
  verificationEffortSeconds: z.discriminatedUnion('kind', [unknownFactor,
    evidencedFactor.extend({ checkerActorId: id, criterionRef: experimentRefSchema })]),
}).strict();
export const workforceCompilerInputSchema = z.object({
  schema: z.literal('finnor.workforce-compiler-input.v1'), programId: id, tenantId: id, principalId: id,
  now: time, snapshotRef: experimentRefSchema, sourceClass: z.enum(['SYNTHETIC', 'CONTROLLED_ACTOR_RECORDS', 'NATIVE_RECORDS']),
  historyAnchor: workforceHistoryAnchorSchema,
  outcome: workforceOutcomeSchema, actors: list(workforceActorSchema),
  matchingObservations: list(workforceMatchingObservationSchema).optional(),
  dependencyInvalidations: list(z.object({ sourceKind: id, sourceId: id, expectedDigest: id,
    actualDigest: id.nullable(), assignmentIds: list(id) }).strict()).optional(),
  grants: list(z.object({ ref: experimentRefSchema, actorId: id, tenantId: id, ceiling: workforceCeilingSchema, revoked: z.boolean() }).strict()),
  funding: list(z.object({ ref: experimentRefSchema, assignmentId: id, rootId: id, parentReservationId: id.nullable(),
    envelope: list(allocationEnvelopeSchema), directReserved: list(allocationEnvelopeSchema), spent: list(allocationEnvelopeSchema),
    unresolved: list(allocationEnvelopeSchema), status: z.enum(['HELD', 'RELEASED']) }).strict()),
  dispositions: list(z.object({ ref: experimentRefSchema, assignmentId: id, actorId: id,
    mode: z.enum(['INTERNAL_AUTHORIZED', 'EXTERNAL_VOLUNTARY']), source: z.enum(['NATIVE_RECIPIENT_DISPOSITION', 'NATIVE_INSTITUTIONAL_ASSIGNMENT']),
    decision: z.enum(['ACCEPT', 'DECLINE']), termsDigest: id, termsRevision: z.number().int().positive(), at: time, revokedAt: time.nullable() }).strict()),
  deliveries: list(z.object({ ref: experimentRefSchema, assignmentId: id, actorId: id, termsDigest: id,
    evidenceRefs: list(experimentRefSchema), custodianActorId: id, at: time }).strict()),
  verifications: list(z.object({ ref: experimentRefSchema, assignmentId: id, deliveryRef: experimentRefSchema, criterionRef: experimentRefSchema,
    checkerActorId: id, custodianActorId: id, evidenceRefs: list(experimentRefSchema), result: z.enum(['SATISFIED', 'FAILED', 'UNKNOWN']), at: time }).strict()),
  effects: list(z.object({ ref: experimentRefSchema, effectId: id, assignmentId: id, rootId: id, at: time,
    status: z.enum(['NOT_DISPATCHED', 'MAY_HAVE_LEFT', 'UNKNOWN', 'CONFIRMED', 'CONFIRMED_NOT_LEFT']),
    reconciliationRef: experimentRefSchema.nullable() }).strict()),
  reconciliations: list(z.object({ ref: experimentRefSchema, effectId: id, rootId: id, authority: z.literal('S6'),
    status: z.enum(['CONFIRMED_NOT_LEFT', 'CONFIRMED_EFFECT', 'UNKNOWN']), at: time }).strict()),
  obligations: list(z.object({ ref: experimentRefSchema, assignmentId: id, rootId: id,
    kind: z.enum(['ACCEPTED_LABOR', 'COMPENSATION', 'OTHER_EXPOSURE']), status: z.enum(['OPEN', 'RELEASED', 'SETTLED']), at: time }).strict()),
  termChanges: list(z.object({ ref: experimentRefSchema, taskId: id, terms: workforceTermsSchema }).strict()),
  taskCreations: list(workforceTaskCreationSchema).optional(),
  commandAuthorities: list(z.object({ ref: experimentRefSchema, commandId: id, actorId: id, assignmentId: id, commandDigest: id,
    actions: list(z.enum(actionKinds)), validFrom: time, validUntil: time }).strict()),
}).strict();
export const workforceExecutionProgramSchema = z.object({
  schema: z.literal('finnor.workforce-execution-program.v1'), id, tenantId: id, principalId: id,
  sourceClass: z.enum(['SYNTHETIC', 'CONTROLLED_ACTOR_RECORDS', 'NATIVE_RECORDS']),
  originalOutcome: workforceOutcomeSchema, originalOutcomeDigest: id, compiledSnapshotRef: experimentRefSchema,
  taskCreations: list(workforceTaskCreationSchema).optional(),
  revision: z.number().int().nonnegative(), assignments: list(workforceAssignmentSchema),
  history: list(authenticatedWorkforceCommandSchema),
  executionAuthorityGranted: z.literal(false),
  method: z.literal('CONSTRAINT_GUIDED_GREEDY_NO_GLOBAL_OPTIMALITY'),
}).strict();

export type WorkforceCompilerInput = z.infer<typeof workforceCompilerInputSchema>;
export type WorkforceHistoryAnchor = z.infer<typeof workforceHistoryAnchorSchema>;
export type WorkforceMatchingObservation = z.infer<typeof workforceMatchingObservationSchema>;
export type WorkforceActor = z.infer<typeof workforceActorSchema>;
export type WorkforceTask = z.infer<typeof workforceTaskSchema>;
export type WorkforceTaskCreation = z.infer<typeof workforceTaskCreationSchema>;
export type WorkforceCeiling = z.infer<typeof workforceCeilingSchema>;
export type WorkforceTerms = z.infer<typeof workforceTermsSchema>;
export type WorkforceAssignment = z.infer<typeof workforceAssignmentSchema>;
export type WorkforceState = z.infer<typeof workforceStateSchema>;
export type WorkforceExecutionProgram = z.infer<typeof workforceExecutionProgramSchema>;
export type AuthenticatedWorkforceCommand = z.infer<typeof authenticatedWorkforceCommandSchema>;
export interface WorkforceIssue { code: string; boundary: 'PROFILE' | 'GRAPH' | 'SUITABILITY' | 'ACCEPTANCE' | 'ACCOUNTING' | 'LIFECYCLE' | 'USE'; assignmentId: string | null; detail: string }
export interface WorkforceCheck {
  valid: boolean; issues: WorkforceIssue[]; affectedAssignmentIds: string[];
  checked: { actors: number; assignments: number; tasks: number; maximumDepth: number; fundingRecords: number; possibleEffects: number };
  executionAuthorityGranted: false;
}
export interface WorkforceCompileResult {
  status: 'COMPLETE' | 'PARTIAL' | 'INVALID_INPUT' | 'LIMIT_EXCEEDED';
  program: WorkforceExecutionProgram | null; gaps: Array<{ taskId: string; code: string; reasons: string[] }>;
  metrics: { actorsConsidered: number; tasksConsidered: number; candidateChecks: number; maximumDepth: number;
    matchingDecisions: Array<{ taskId: string;
      factorsUsed: Array<'COST' | 'LATENCY_SECONDS' | 'VERIFICATION_EFFORT_SECONDS'>;
      unavailableFactors: Array<'COST' | 'LATENCY_SECONDS' | 'VERIFICATION_EFFORT_SECONDS'> }> };
  executionAuthorityGranted: false;
}
export interface WorkforceCommandResult {
  status: 'APPLIED' | 'IDEMPOTENT' | 'REJECTED'; program: WorkforceExecutionProgram; issues: WorkforceIssue[];
  executionAuthorityGranted: false;
}
export const parseWorkforceCompilerInput = (value: unknown): WorkforceCompilerInput => workforceCompilerInputSchema.parse(value);
export const parseWorkforceExecutionProgram = (value: unknown): WorkforceExecutionProgram => workforceExecutionProgramSchema.parse(value);
export const parseAuthenticatedWorkforceCommand = (value: unknown): AuthenticatedWorkforceCommand => authenticatedWorkforceCommandSchema.parse(value);
