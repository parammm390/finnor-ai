import { z } from "zod";
import { workforceActorSchema, workforceOutcomeSchema, workforceTaskSchema, workforceTermsSchema, experimentRefSchema } from "../../../workforce/src/execution-program/schema";

const id = z.string().min(1).max(200);
const integer = z.string().regex(/^-?(0|[1-9]\d{0,95})$/);
export const workforceComputationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("SUM_INTEGERS"), values: z.array(integer).min(1).max(4096) }).strict(),
  z.object({ kind: z.literal("SORT_STRINGS"), values: z.array(z.string().max(256)).max(4096) }).strict(),
  z.object({ kind: z.literal("HUMAN_JUDGMENT"), prompt: z.string().min(1).max(16384) }).strict(),
  z.object({ kind: z.literal("PARTICIPANT_INPUT"), prompt: z.string().min(1).max(16384) }).strict(),
]);
export const nativeWorkforceCriterionSchema = z.object({
  id, checkerActorId: z.string().uuid(), evidenceCustodianActorId: z.string().uuid(),
  acceptance: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("EXACT_JSON"), expected: z.unknown() }).strict(),
    z.object({ kind: z.literal("AUTHENTICATED_HUMAN_JUDGMENT"), question: z.string().min(1).max(16384) }).strict(),
  ]),
}).strict();
export const nativeWorkforceRefinementSchema = z.object({
  kind: z.enum(["SUBDELEGATION", "RECIPROCAL_REQUEST"]), recipientActorId: z.string().uuid(),
  task: workforceTaskSchema.omit({ parentTaskId: true, delegatorActorId: true, criterionId: true }).extend({ id }),
  criterion: nativeWorkforceCriterionSchema, computation: workforceComputationSchema,
}).strict();
export const nativeWorkforceTaskCreationRecordSchema = z.object({
  schema: z.literal("finnor.workforce-task-creation.v1"), programmeId: z.string().uuid(),
  originalWorkId: z.string().uuid(), originalMeaningDigest: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum(["SUBDELEGATION", "RECIPROCAL_REQUEST"]), parentAssignmentId: z.string().min(1).max(256),
  parentTermsDigest: z.string().regex(/^[a-f0-9]{64}$/), actorId: z.string().uuid(),
  recipientActorId: z.string().uuid(), authenticatedPrincipalId: z.string().uuid(), assignmentId: z.string().min(1).max(256),
  at: z.string().datetime({ offset: true }), task: workforceTaskSchema,
  criterion: nativeWorkforceCriterionSchema, computation: workforceComputationSchema,
}).strict();
export const nativeWorkforceOriginalSchema = z.object({
  schema: z.literal("finnor.workforce-original-outcome.v1"),
  sourceClass: z.enum(["CONTROLLED_ACTOR_RECORDS", "NATIVE_RECORDS"]),
  outcome: workforceOutcomeSchema.omit({ ref: true, workId: true, rootId: true, requesterActorId: true, criteria: true }).extend({
    criteria: z.array(nativeWorkforceCriterionSchema).min(1).max(512),
  }),
  actorSourceIds: z.array(z.string().uuid()).min(1).max(128),
  resources: z.object({ resourceRefs: z.array(experimentRefSchema).min(1).max(16),
    schedules: z.array(z.object({ resourceId: id, quantities: z.array(z.string().max(192)).min(2).max(25) }).strict()).min(1).max(16) }).strict(),
  operations: z.array(z.object({ taskId: id, computation: workforceComputationSchema }).strict()).min(1).max(512),
}).strict();
export const nativeWorkforceActorSourceSchema = z.object({
  schema: z.literal("finnor.workforce-actor-evidence.v1"),
  canonical: z.object({ kind: z.enum(["USER", "EXTERNAL_CONTACT"]), id: z.string().uuid(), principalId: z.string().uuid() }).strict(),
  actor: workforceActorSchema,
  qualification: z.literal("AUTHORIZED_SOURCE_ASSERTION_NOT_PROTECTED_QUALIFICATION"),
}).strict();
export const submitWorkforceExecutionSchema = z.object({
  workId: z.string().uuid(), workInputId: z.string().uuid(), idempotencyKey: z.string().min(1).max(200),
}).strict();
export const intakeWorkforceExecutionSchema = z.object({
  workId: z.string().uuid(), idempotencyKey: z.string().min(1).max(160), original: nativeWorkforceOriginalSchema,
}).strict();
export const recipientWorkforceActionSchema = z.object({
  idempotencyKey: z.string().min(1).max(160), expectedRevision: z.number().int().nonnegative(), assignmentId: z.string().min(1).max(256),
  action: z.enum(["ACCEPT", "DECLINE", "START", "BLOCK", "RETURN", "DELIVER", "DISPUTE", "CANCEL", "CONFIRM_CANCEL", "EXPIRE", "CLOSE", "VERIFY", "REASSIGN", "REVISE_TERMS", "RELEASE_LABOR", "SUBDELEGATE"]),
  termsDigest: z.string().regex(/^[a-f0-9]{64}$/), termsRevision: z.number().int().positive(),
  reason: z.string().min(1).max(256).optional(), value: z.unknown().optional(), replacementActorId: z.string().uuid().optional(),
  replacementAssignmentId: z.string().min(1).max(256).optional(),
  revisedTerms: workforceTermsSchema.optional(),
  refinement: nativeWorkforceRefinementSchema.optional(),
}).strict();
export type NativeWorkforceOriginal = z.infer<typeof nativeWorkforceOriginalSchema>;
export type NativeWorkforceActorSource = z.infer<typeof nativeWorkforceActorSourceSchema>;
export type RecipientWorkforceAction = z.infer<typeof recipientWorkforceActionSchema>;
export type NativeWorkforceTaskCreationRecord = z.infer<typeof nativeWorkforceTaskCreationRecordSchema>;
export class WorkforceRuntimeError extends Error {
  constructor(readonly code: string, readonly status = 409, readonly detail?: unknown) { super(code); }
}

export const workforceParticipantProposalSchema = z.object({ contactId: z.string().uuid(), recipientPrincipalId: z.string().uuid(),
  purpose: z.string().min(1).max(256), validUntil: z.string().datetime({ offset: true }),
  idempotencyKey: z.string().min(1).max(160) }).strict();
export const workforceParticipantDispositionSchema = z.object({ action: z.enum(["CONFIRM", "REVOKE"]), proposalDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expectedRevision: z.number().int().nonnegative(), idempotencyKey: z.string().min(1).max(160) }).strict();

export const reconcileWorkforceExecutionSchema = z.object({
  idempotencyKey: z.string().min(1).max(160), expectedRevision: z.number().int().nonnegative(),
}).strict();
