import { z } from 'zod';
import type { ExperimentRef, AllocationEnvelope, AllocationResource } from '@finnor/shared-types';
import {
  WorkSchema, SourceSchema, ChangesSchema, boundedJSON, digest, requireZ1,
  type SharedWorkRequest, type Checkpoint, type OriginalWork,
} from '../../../../epistemic-runtime/src/project-z/z1-shared-work/contracts.js';
import { epistemicHash } from '../../../../epistemic-runtime/src/source-precedence';
import type { PeWorldRootRef } from '../../types';
import type { PublishedProgram } from './owner.js';

export const UUID = z.string().uuid(), HEX = z.string().regex(/^[a-f0-9]{64}$/);
export const RefSchema = z.object({ owner: z.string().min(1).max(256), id: z.string().min(1).max(256),
  version: z.string().min(1).max(256), contentDigest: HEX }).strict();
export const RootSchema = z.object({ entityType: z.literal('pe_deal'), entityId: UUID }).strict();
const Key = z.string().min(1).max(128);
export const PinSchema = z.object({ sourceId: UUID, versionId: UUID, contentDigest: HEX }).strict();
export const WorkPinSchema = z.object({ workId: UUID, declaration: PinSchema }).strict();
export const ConsumerSchema = z.discriminatedUnion('owner', [
  z.object({ owner: z.literal('S3'), kind: z.literal('EXACT_FINANCIAL_RELATION'),
    measureField: Key }).strict(),
  z.object({ owner: z.literal('S4'), kind: z.literal('EXACT_REGISTERED_CHOICE'),
    investmentCaseId: UUID, decisionType: Key, title: z.string().min(1).max(256),
    actionField: Key, valueField: Key, direction: z.enum(['MAXIMIZE', 'MINIMIZE']) }).strict(),
]);
export type Consumer = z.infer<typeof ConsumerSchema>;
export const DeclarationSchema = z.object({
  schema: z.literal('finnor.z1.original-work-declaration.v1'), work: WorkSchema, consumer: ConsumerSchema,
  parentReservation: RefSchema, sourcePins: z.array(PinSchema).min(1).max(4096),
}).strict();
export const SourceDeclarationSchema = z.object({
  schema: z.literal('finnor.z1.source-declaration.v1'), source: SourceSchema,
}).strict();
export const SubmitSchema = z.object({
  root: RootSchema, idempotencyKey: Key, works: z.array(WorkPinSchema).min(2).max(1000),
  limits: z.object({ maxTicks: z.number().int().positive().max(1000000000),
    maxBytes: z.number().int().positive().max(134217728) }).strict(),
  previous: z.object({ requestId: UUID, generation: z.number().int().positive(),
    changes: ChangesSchema }).strict().optional(),
}).strict();
export type Submit = z.infer<typeof SubmitSchema>;
export const BudgetSchema = z.object({
  root: RootSchema, workId: UUID, idempotencyKey: Key, deadlineAt: z.string().datetime(),
  maximumTicks: z.number().int().positive().max(1000000000),
  maximumCpuMicros: z.number().int().positive().max(120000000),
  maximumRetainedBytes: z.number().int().positive().max(536870912),
  maximumMemoryBytes: z.number().int().positive().max(2147483648),
  resources: z.object({ logical: RefSchema, cpu: RefSchema, storage: RefSchema, memory: RefSchema }).strict(),
}).strict();
export type BudgetInput = z.infer<typeof BudgetSchema>;
export interface OriginalBudget {
  schema: 'finnor.s5.z1-original-budget.v1'; ref: ExperimentRef; certificateRef: ExperimentRef;
  tenantId: string; principalId: string; original: BudgetInput; inputId: string; inputDigest: string;
  rightsRevision: string; resources: AllocationResource[]; envelopes: AllocationEnvelope[];
  authorityDecisionId: string; resourceReadDecisionIds: string[];
  createdAt: string; executionAuthorityGranted: false; protectedReceipt: null;
}
export interface NativeCut {
  workId: string; inputId: string; inputDigest: string; declarationDigest: string;
  declaration: Submit['works'][number]['declaration']; sourcePins: z.infer<typeof PinSchema>[];
  consumer: Consumer; parent: ExperimentRef;
}
export interface NativeRow {
  tenant_id: string; principal_id: string; id: string; root: PeWorldRootRef;
  intake: Submit; request: SharedWorkRequest; request_digest: string; runtime: { digest: string };
  cuts: NativeCut[]; rights_revision: string; generation: number; version: number;
  checkpoint: Checkpoint | null; publication: PublishedProgram | null;
  deadline_at: Date; wall_used_ms: number; wall_reserved_ms: number; attempts_used: number; status: string;
}
export const nativeRef = (owner: string, kind: string, body: unknown): ExperimentRef => {
  const contentDigest = epistemicHash(body);
  return { owner, id: `${kind}:${contentDigest}`, version: 'z1-native-owner-v1', contentDigest };
};
export const same = (a: unknown, b: unknown): boolean => digest(a) === digest(b);
export function parsed<T>(schema: z.ZodType<T>, value: unknown, maxBytes = 262144): T {
  boundedJSON(value, maxBytes); const result = schema.safeParse(value);
  requireZ1(result.success, 'Z1_NATIVE_TYPED_REQUEST_REQUIRED');
  return result.data;
}
export function developmentOnly(): void {
  requireZ1(process.env.FINNOR_Z1_PROFILE === 'ordinary_disposable' &&
    process.env.FINNOR_ENVIRONMENT === 'ordinary_disposable' &&
    (process.env.NODE_ENV !== 'production' || process.env.FINNOR_Z1_INSTALLED_DEVELOPMENT === '1'),
  'Z1_AUTHORIZED_DISPOSABLE_NATIVE_PROFILE_REQUIRED');
}
export function assertOriginalBudget(work: OriginalWork, budget: OriginalBudget): void {
  requireZ1(work.id === budget.original.workId && work.partition.tenantId === budget.tenantId &&
    work.partition.principalId === budget.principalId &&
    work.resources.parentReservationRef === budget.ref.id && work.resources.remainingBudgetRef === budget.ref.contentDigest &&
    work.resources.originalDeadline === budget.original.deadlineAt &&
    work.resources.remainingTicks === String(budget.original.maximumTicks) &&
    work.resources.mandateRef === `original-work:${work.id}` && work.resources.assignmentRef === `work-input:${budget.inputId}`,
  'Z1_EXACT_ORIGINAL_S5_WORK_PARENT_REQUIRED', 'REVOKED');
}
