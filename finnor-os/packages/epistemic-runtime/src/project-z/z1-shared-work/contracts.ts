import { createHash } from 'node:crypto';
import { z } from 'zod';

export const Z1_VERSION = 'z1-shared-work-v1';
export const Z1_LOCK = '61d9881ca8059d24d057d1e00d5436ef2059de7889ccd1fd2f92a630075bcebf';
export type Disposition = 'CHECKED_CANDIDATE' | 'COUNTEREXAMPLE' | 'INCOMPLETE' | 'UNSUPPORTED' | 'STALE' | 'REVOKED' | 'UNKNOWN';
export class Z1Fault extends Error {
  readonly disposition: Disposition;
  constructor(disposition: Disposition, code: string) {
    super(code); this.name = 'Z1Fault'; this.disposition = disposition;
  }
}
export function requireZ1(condition: unknown, code: string, disposition: Disposition = 'UNSUPPORTED'): asserts condition {
  if (!condition) throw new Z1Fault(disposition, code);
}
export function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    requireZ1(value !== undefined && (typeof value !== 'number' || Number.isSafeInteger(value)), 'NON_JSON_OR_FLOAT_VALUE');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => JSON.stringify(key) + ':' + stable(item)).join(',') + '}';
}
export const digest = (value: unknown): string => createHash('sha256').update(stable(value)).digest('hex');
export const token = z.string().min(1).max(256);
const name = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,127}$/)
  .refine(v => !['constructor', 'prototype', '__proto__'].includes(v));
const numericText = z.string().max(312).regex(/^-?(?:0|[1-9][0-9]*)(?:\/[1-9][0-9]*)?$/);
export const TypeSchema = z.union([
  z.object({ kind: z.enum(['integer', 'rational']), unit: token, currency: token.nullable() }).strict(),
  z.object({ kind: z.literal('text') }).strict(),
  z.object({ kind: z.literal('boolean') }).strict(),
]);
export type ValueType = z.infer<typeof TypeSchema>;
export type Scalar = string | boolean;
export type Row = Record<string, Scalar>;
export type Columns = Record<string, ValueType>;
export interface Relation { columns: Columns; rows: Row[]; ordered: boolean }
export const RowSchema = z.record(name, z.union([z.string().max(8192), z.boolean()]));
const ColumnsSchema = z.record(name, TypeSchema).refine(v => Object.keys(v).length > 0 && Object.keys(v).length <= 128);
export const PartitionSchema = z.object({
  tenantId: token, principalId: token, permittedUse: token, rightsRevision: token,
  classification: z.enum(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']),
}).strict();
export type Partition = z.infer<typeof PartitionSchema>;
export interface TypedValue { type: ValueType; value: Scalar }
export type Expression =
  | { op: 'field'; name: string }
  | { op: 'param'; name: string }
  | { op: 'literal'; type: ValueType; value: Scalar }
  | { op: 'add' | 'sub' | 'mul' | 'div'; left: Expression; right: Expression }
  | { op: 'round'; value: Expression; places: number; mode: 'HALF_EVEN' | 'HALF_AWAY' | 'FLOOR' | 'CEILING' | 'TRUNCATE' };
export type Predicate =
  | { op: 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge'; left: Expression; right: Expression }
  | { op: 'and' | 'or'; args: Predicate[] }
  | { op: 'not'; arg: Predicate };
const ExpressionSchema: z.ZodType<Expression> = z.lazy(() => z.union([
  z.object({ op: z.literal('field'), name }).strict(),
  z.object({ op: z.literal('param'), name }).strict(),
  z.object({ op: z.literal('literal'), type: TypeSchema, value: z.union([z.string().max(8192), z.boolean()]) }).strict(),
  z.object({ op: z.enum(['add', 'sub', 'mul', 'div']), left: ExpressionSchema, right: ExpressionSchema }).strict(),
  z.object({ op: z.literal('round'), value: ExpressionSchema, places: z.number().int().min(0).max(18),
    mode: z.enum(['HALF_EVEN', 'HALF_AWAY', 'FLOOR', 'CEILING', 'TRUNCATE']) }).strict(),
]));
const PredicateSchema: z.ZodType<Predicate> = z.lazy(() => z.union([
  z.object({ op: z.enum(['eq', 'ne', 'lt', 'le', 'gt', 'ge']), left: ExpressionSchema, right: ExpressionSchema }).strict(),
  z.object({ op: z.enum(['and', 'or']), args: z.array(PredicateSchema).min(1).max(32) }).strict(),
  z.object({ op: z.literal('not'), arg: PredicateSchema }).strict(),
]));
export const NodeSchema = z.union([
  z.object({ id: name, op: z.literal('source'), sourceId: name }).strict(),
  z.object({ id: name, op: z.literal('filter'), input: name, predicate: PredicateSchema }).strict(),
  z.object({ id: name, op: z.literal('project'), input: name, fields: z.record(name, ExpressionSchema),
    semantics: z.enum(['bag', 'set']) }).strict(),
  z.object({ id: name, op: z.literal('join'), left: name, right: name,
    on: z.array(z.object({ left: name, right: name }).strict()).min(1).max(32), rightPrefix: name }).strict(),
  z.object({ id: name, op: z.literal('union'), inputs: z.array(name).min(1).max(128), semantics: z.enum(['bag', 'set']) }).strict(),
  z.object({ id: name, op: z.literal('sum'), input: name, keys: z.array(name).max(64),
    values: z.record(name, ExpressionSchema), empty: z.literal('zero') }).strict(),
  z.object({ id: name, op: z.literal('select'), input: name, order: z.array(z.object({
    field: name, direction: z.enum(['asc', 'desc']),
  }).strict()).min(1).max(64), limit: z.number().int().min(0).max(1000000), ties: z.literal('CANONICAL_ROW') }).strict(),
]);
export type Node = z.infer<typeof NodeSchema>;
export const SourceSchema = z.object({
  id: name, revision: token, partition: PartitionSchema, columns: ColumnsSchema,
  rows: z.array(RowSchema).max(100000), revoked: z.boolean(),
  evidenceClass: z.enum(['deterministic', 'empirical', 'probabilistic', 'partial', 'blocked-external', 'unknown']),
}).strict();
export type Source = z.infer<typeof SourceSchema>;
export const WorkSchema = z.object({
  id: token, partition: PartitionSchema, inputRef: token,
  programmeRevision: token, objectiveRevision: token, termsRevision: token, modelRevision: token,
  unitsRevision: token, codeRevision: token, checkerRevision: token,
  programme: z.object({ nodes: z.array(NodeSchema).min(1).max(4096), output: name }).strict(),
  parameters: z.record(name, z.object({ type: TypeSchema, value: z.union([z.string().max(8192), z.boolean()]) }).strict()),
  resources: z.object({
    mandateRef: token, assignmentRef: token, parentReservationRef: token, remainingBudgetRef: token,
    originalDeadline: z.string().datetime(), remainingTicks: numericText,
  }).strict(),
  unresolvedObligationRefs: z.array(token).max(4096), withdrawn: z.boolean(),
}).strict();
export type OriginalWork = z.infer<typeof WorkSchema>;
export const RequestSchema = z.object({
  schema: z.literal('finnor.z1.request.v1'),
  identity: z.object({
    productLockDigest: z.literal(Z1_LOCK), sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    sourceTree: z.string().regex(/^[a-f0-9]{40}$/), producerBuildIdentity: token,
    checkerIdentity: token, ownerConsumerContractVersion: z.literal('z1-per-original-work-v1'),
    reconstructionReference: token,
  }).strict(),
  sources: z.array(SourceSchema).min(1).max(4096), works: z.array(WorkSchema).min(2).max(1000),
  limits: z.object({
    maxTicks: z.number().int().positive().max(1000000000),
    maxBytes: z.number().int().positive().max(134217728), deadlineAt: z.string().datetime(),
  }).strict(),
}).strict();
export type SharedWorkRequest = z.infer<typeof RequestSchema>;
export const ChangesSchema = z.object({
  sourceChanges: z.array(z.object({
    sourceId: name, fromRevision: token, toRevision: token, insert: z.array(RowSchema).max(100000),
    retract: z.array(RowSchema).max(100000), revoked: z.boolean().optional(),
  }).strict()).max(4096).optional(),
  workEdits: z.array(z.object({ workId: token, expectedProgrammeRevision: token, replacement: WorkSchema }).strict()).max(1000).optional(),
  withdrawWorkIds: z.array(token).max(1000).optional(),
}).strict();
export type ProgrammeChanges = z.infer<typeof ChangesSchema>;
export interface Binding {
  original: OriginalWork;
  build: SharedWorkRequest['identity'];
  sources: Array<{ id: string; revision: string; digest: string; partition: Partition; revoked: boolean; evidenceClass: Source['evidenceClass'] }>;
}
export interface SharedNode {
  key: string; operator: Record<string, unknown>; inputs: string[]; workIds: string[]; outputSchema: Columns;
}
export interface Charge {
  phase: 'DISCOVERY' | 'EXECUTION' | 'STORAGE'; nodeKey: string | null;
  ticks: string; allocations: Record<string, string>;
}
export interface WorkProjection {
  workId: string; lifecycle: 'ACTIVE' | 'WITHDRAWN'; disposition: Disposition;
  result: Relation | null; originalNodeKeys: Record<string, string>; outputKey: string | null;
  binding: Binding; bindingDigest: string; unresolvedObligationRefs: string[];
  accounting: { chargedTicks: string; cumulativeTicks: string; remainingTicks: string };
}
export interface SharedWorkProgram {
  schema: 'finnor.z1.shared-work-program.v1'; version: number; requestDigest: string;
  envelope: {
    schemaVersion: 'finnor.project-z.artifact-envelope.v1'; phase: 'Z1'; principalOutputType: 'SharedWorkProgram';
    immutableArtifactDigest: string; productLockDigest: string; sourceCommit: string; sourceTree: string;
    producerBuildIdentity: string; originalTenant: string; principal: string; Work: string[];
    mandate: string[]; assignment: string[]; parentReservation: string[]; originalDeadline: string[];
    remainingBudgetReference: string[]; unresolvedObligationReferences: string[];
    inputSemanticsAndRevisionReferences: string[]; rightsAndPermittedUseFingerprint: string[];
    supportedDomain: string; unsupportedConditions: string[]; claimAndEvidenceClasses: string[];
    checkerIdentityAndResultReferences: { identity: string; resultReference: null };
    currentnessDependencies: string[]; securityAndConfidentialityProfile: string;
    ownerConsumerContractVersion: string; costAndResourceReceiptReferences: string[];
    gaps: string[]; reconstructionReference: string;
  };
  sharedDag: SharedNode[]; workProjections: WorkProjection[];
  rules: { initial: string; delta: string; edits: string; retractions: string; rewrites: string[] };
  costs: { totalTicks: string; byWork: Record<string, string>; charges: Charge[]; usd: null; gaps: string[] };
  predecessorDigest: string | null;
  history: Array<{ generation: number; requestDigest: string; artifactDigest: string | null; disposition: Disposition;
    totalTicks: string; unresolvedObligationRefs: string[] }>;
  executionAuthorityGranted: false; protectedAdmission: false;
}
export interface Checkpoint {
  schema: 'finnor.z1.checkpoint.v1'; request: SharedWorkRequest; program: SharedWorkProgram | null;
  cache: Record<string, { value: Relation; digest: string }>; charges: Record<string, string>;
  history: SharedWorkProgram['history']; generation: number; mode: 'SHARED' | 'DIRECT';
}
export interface Production {
  disposition: Disposition; reason: string | null; program: SharedWorkProgram | null;
  checkpoint: Checkpoint | null; costs: SharedWorkProgram['costs'];
}
export function inputNodes(node: Node): string[] {
  if (node.op === 'source') return [];
  if (node.op === 'union') return node.inputs;
  if (node.op === 'join') return [node.left, node.right];
  return [node.input];
}
export function operatorBody(node: Node): Record<string, unknown> {
  const body: Record<string, unknown> = { ...node };
  for (const key of ['id', 'input', 'inputs', 'left', 'right']) delete body[key];
  return body;
}
export function boundedJSON(value: unknown, maxBytes: number): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let cells = 0;
  while (pending.length) {
    const item = pending.pop()!;
    requireZ1(++cells <= 4000000 && item.depth <= 64, 'INPUT_STRUCTURE_BOUND', 'INCOMPLETE');
    if (typeof item.value === 'string') requireZ1(!/[\uD800-\uDFFF]/u.test(item.value), 'UNPAIRED_UNICODE_SURROGATE_UNSUPPORTED');
    if (item.value && typeof item.value === 'object')
      for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 });
  }
  requireZ1(Buffer.byteLength(JSON.stringify(value)) <= maxBytes, 'INPUT_BYTE_BOUND', 'INCOMPLETE');
}
