import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ExperimentRefSchema } from '../../../epistemic-runtime/src/experiments';

export class BranchFault extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}
export function fault(code: string, status = 409): never { throw new BranchFault(code, status); }
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return fault('NON_JSON_VALUE', 400);
}
export const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export const bytesHash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
export const Hex = z.string().regex(/^[a-f0-9]{64}$/);
export const Id = z.string().uuid();
export const Text = z.string().min(1).max(256);
export const Kinds = ['pure', 'application_fixture', 'intervention_simulation', 'live_read'] as const;
export const Profiles = ['TRUSTED_NATIVE_H0', 'LINUX_GVISOR_DEVELOPMENT'] as const;
export const Modes = ['COLD_BUILD', 'CLEAN_WARM_IMAGE', 'PRIVATE_STATE_CLONE', 'VERIFIED_CHECKPOINT_RESTORE'] as const;
export const Classes = { pure: 'COMPUTATION', application_fixture: 'APPLICATION_FIXTURE', intervention_simulation: 'MODEL_RELATIVE', live_read: 'REVIEWED_OBSERVATION' } as const;
export const LIMITS = Object.freeze({ bytes: 1024 * 1024, wallMs: 30000, requestMs: 120000, attempts: 3, stateBytes: 32 * 1024 * 1024, files: 64, heapMiB: 256 });
/** Stricter engineering admission bounds, not S5 grants or physical meter totals. */
export const WORK_LIMITS = Object.freeze({ wallMs: 3600000, requests: 64, retainedJsonBytes: 128 * 1024 * 1024, accountingReserveBytes: 8 * 1024 * 1024 });
const Root = z.object({ entityType: Text, entityId: Id }).strict();
export const FixtureParameters = z.object({
  equity: z.number().int().min(0).max(100), leverageTenths: z.number().int().min(0).max(35),
  reserve: z.number().int().min(0).max(100),
}).strict();
export const FinancingStep = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('autosave'), target: z.enum(['C_01', 'C_010']), feeCents: z.number().int().min(0).max(20000).optional(), memo: z.string().max(256).nullable().optional(), effectId: Id }).strict(),
  z.object({ operation: z.literal('navigate'), target: z.enum(['C_01', 'C_010']), effectId: Id }).strict(),
  z.object({ operation: z.literal('submit'), target: z.enum(['C_01', 'C_010']), effectId: Id }).strict(),
]);
export const Source = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('public_fixture'), fixture: z.literal('allocation-abc-v1'), parameters: FixtureParameters }).strict(),
  z.object({ kind: z.literal('financing_fixture'), baseline: Id.optional(), steps: z.array(FinancingStep).min(1).max(16) }).strict(),
  z.object({ kind: z.literal('underwriting'), investmentCaseId: Id, modelVersionId: Id, baseRunId: Id, worldAt: z.string().datetime({ offset: true }) }).strict(),
  z.object({ kind: z.literal('allocation'), allocationRef: ExperimentRefSchema }).strict(),
  z.object({ kind: z.literal('s3'), modelRef: ExperimentRefSchema, context: Text, regime: Text, horizon: z.number().int().min(1).max(24), pathsPerMechanism: z.number().int().min(1).max(64), seed: z.number().int().min(0).max(4294967295), exposures: z.record(z.array(z.number().finite()).min(1).max(24)) }).strict(),
  z.object({ kind: z.literal('s6_read'), obligationRef: ExperimentRefSchema }).strict(),
  z.object({ kind: z.literal('p4'), derivationId: Id, output: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/) }).strict(),
  z.object({ kind: z.literal('m1'), sliceRef: ExperimentRefSchema }).strict(),
  z.object({ kind: z.literal('p1'), programRef: ExperimentRefSchema }).strict(),
]);
export const PrepareSchema = z.object({ workId: Id, root: Root, kind: z.enum(Kinds), profile: z.enum(Profiles), source: Source }).strict();
export const NativeRef = z.object({ programmeSource: z.literal('REGISTERED_NATIVE'), id: Text, version: z.literal('p3-native-v1'), contentDigest: Hex, inputSchema: Text, outputSchema: Text }).strict();
export const RequestSchema = z.object({
  schema: z.literal('finnor.branch-request.v1'), workId: Id, inputId: Id, programme: NativeRef,
  mode: z.enum(Modes), idempotencyKey: z.string().min(1).max(128), checkpointId: Id.optional(),
}).strict();
export const RefOperation = z.object({ branchId: Id }).strict();
export const BranchOperations = {
  prepare: {schema:PrepareSchema,classification:'MUTATION'},
  submit: {schema:RequestSchema,classification:'MUTATION'},
  read: {schema:RefOperation,classification:'READ'},
  list: {schema:z.object({ workId: Id, limit: z.number().int().min(1).max(50).default(20), after: Id.optional() }).strict(),classification:'READ'},
  compare: {schema:z.object({ branchIds: z.array(Id).min(2).max(8) }).strict(),classification:'READ'},
  checkpoint: {schema:RefOperation,classification:'MUTATION'},
  resume: {schema:RefOperation.extend({ checkpointId: Id, idempotencyKey: Text }),classification:'CONTROL'},
  'checkpoint-revoke': {schema:RefOperation.extend({ checkpointId: Id }).strict(),classification:'CONTROL'},
  'checkpoint-purge': {schema:RefOperation,classification:'CONTROL'},
  cancel: {schema:RefOperation,classification:'CONTROL'},
  inspect: {schema:RefOperation,classification:'READ'},
  continue: {schema:RefOperation,classification:'READ'},
} as const;
export const OperationSchemas = Object.fromEntries(Object.entries(BranchOperations).map(([operation, definition]) =>
  [operation, definition.schema])) as { [Operation in keyof typeof BranchOperations]: typeof BranchOperations[Operation]['schema'] };
export type Prepare = z.infer<typeof PrepareSchema>;
export type BranchRequest = z.infer<typeof RequestSchema>;
export interface Scope { tenantId: string; principalId: string }
export interface Basis {
  workId: string; inputRevision: string; inputDigest: string; rightsRevision: number;
  validAt: string; knowledgeAt: string; dependencyDigest: string;
}
export interface InputArtifact extends Scope {
  schema: 'finnor.branch-input.v1'; root: z.infer<typeof Root>; kind: typeof Kinds[number];
  profile: typeof Profiles[number]; source: z.infer<typeof Source>; basis: Basis;
  programme: z.infer<typeof NativeRef>; payload: Record<string, any>;
  ownerBindings: Record<string, any>; qualification: string;
}
export const CandidateSchema = z.object({
  schema: z.literal('finnor.branch-candidate.v1'), invocationDigest: Hex,
  result: z.record(z.unknown()), state: z.record(z.unknown()).nullable(),
}).strict();
export type Candidate = z.infer<typeof CandidateSchema>;
export const STATES = ['PREPARING', 'RUNNING', 'CHECKPOINTING', 'CHECKING', 'COMPLETE', 'CANCEL_REQUESTED', 'CANCELLED', 'INTERRUPTED', 'FAILED', 'INVALIDATED', 'QUARANTINED'] as const;
export type State = typeof STATES[number];
export const TERMINAL: State[] = ['COMPLETE', 'CANCELLED', 'FAILED', 'INVALIDATED', 'QUARANTINED'];
/** Check size/depth before schema recursion. Cyclic/nonfinite runtime objects refuse. */
export function decode<T>(schema: z.ZodType<T>, value: unknown): T {
  const seen = new Set<object>();
  const visit = (v: unknown, depth: number): void => {
    if (depth > 24) fault('REQUEST_DEPTH_BOUND', 400);
    if (typeof v === 'number' && !Number.isFinite(v)) fault('NON_FINITE_NUMBER', 400);
    if (v && typeof v === 'object') {
      if (seen.has(v)) fault('CYCLIC_REQUEST', 400);
      seen.add(v);
      if (Array.isArray(v) && v.length > 4096) fault('REQUEST_ARRAY_BOUND', 413);
      for (const nested of Object.values(v)) visit(nested, depth + 1);
      seen.delete(v);
    }
  };
  visit(value, 0);
  if (Buffer.byteLength(canonical(value)) > LIMITS.bytes) fault('REQUEST_BYTE_BOUND', 413);
  const parsed = schema.safeParse(value);
  if (!parsed.success) fault('BRANCH_SCHEMA_INVALID', 400);
  return parsed.data;
}
export function branchError(e: unknown): { status: number; body: { code: string } } {
  if (e instanceof BranchFault) return { status: e.status, body: { code: e.code } };
  return { status: 503, body: { code: 'BRANCH_RUNTIME_UNAVAILABLE' } };
}
