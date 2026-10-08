import { z } from 'zod';
import { EvidenceRootSchema, FinancialSemanticsSchema } from '@finnor/shared-types';
import { ExpressionSchema, type HarnessRequest, type NativeModule } from '../program-synthesis/contracts';
import { sha, stable } from '../evidence-execution/store';
export { ProcedureUseSchema, type ProcedureUse } from './use-contracts';

export const P6_VERSION = 'p6-exact-structural-v1' as const;
const uuid = z.string().uuid(), digest = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.string().datetime({ offset: true });
export const role = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
  .refine(key => !['constructor', 'prototype', '__proto__'].includes(key));
export const ImmutableRefSchema = z.object({
  owner: z.enum(['P1', 'P4', 'P5', 'P6', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8']),
  id: z.string().min(1).max(512), version: z.string().min(1).max(128), contentDigest: digest,
}).strict();
export type ImmutableRef = z.infer<typeof ImmutableRefSchema>;
export const immutableRef = (owner: ImmutableRef['owner'], id: string, version: string, body: unknown): ImmutableRef =>
  ImmutableRefSchema.parse({ owner, id, version, contentDigest: sha(body) });
export const componentRef = (name: string, body: unknown): ImmutableRef =>
  immutableRef('P6', 'p6-' + name + ':' + sha(body), P6_VERSION, body);

/** Reject cycles, non-JSON objects and unbounded nesting before recursive codecs. */
export function boundedJson(value: unknown, maxBytes = 1048576) {
  const seen = new Set<object>(), stack: Array<[unknown, number]> = [[value, 0]];
  let nodes = 0;
  while (stack.length) {
    const [next, depth] = stack.pop()!;
    if (++nodes > 32768 || depth > 32) throw Error('P6_DECODE_BOUND');
    if (next && typeof next === 'object') {
      if (seen.has(next)) throw Error('P6_CYCLIC_OR_SHARED_OBJECT');
      seen.add(next);
      if (!Array.isArray(next) && ![Object.prototype, null].includes(Object.getPrototypeOf(next)))
        throw Error('P6_JSON_OBJECT_REQUIRED');
      for (const [key, child] of Object.entries(next)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) throw Error('P6_UNSAFE_KEY');
        stack.push([child, depth + 1]);
      }
    } else if (next === undefined || typeof next === 'function' || typeof next === 'symbol' ||
      typeof next === 'bigint' || typeof next === 'number' && !Number.isFinite(next))
      throw Error('P6_JSON_VALUE_REQUIRED');
  }
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > maxBytes) throw Error('P6_BYTE_BOUND');
}

export const ExperienceRequestSchema = z.object({
  programIds: z.array(uuid).min(1).max(32), knowledgeCut: instant,
  mode: z.enum(['ordinary_disposable', 'protected']),
}).strict().superRefine((v, c) => {
  if (new Set(v.programIds).size !== v.programIds.length)
    c.addIssue({ code: 'custom', message: 'Unique original programme identifiers required' });
});
export const InductionRequestSchema = z.object({
  schema: z.literal('finnor.p6.induction-request.v1'), root: EvidenceRootSchema, workId: uuid,
  programIds: z.array(uuid).min(2).max(32), knowledgeCut: instant,
  idempotencyKey: z.string().min(1).max(160), mode: z.enum(['ordinary_disposable', 'protected']),
}).strict();
export type InductionRequest = z.infer<typeof InductionRequestSchema>;
export const IdSchema = z.object({ capsuleId: uuid }).strict();
export const InductionIdSchema = z.object({ inductionId: uuid }).strict();
export const CounterexampleSchema = IdSchema.extend({
  type: z.enum(['CORRECTION', 'FAILURE', 'UNKNOWN', 'REVOKED']),
  reason: z.string().min(1).max(2000), idempotencyKey: z.string().min(1).max(160),
}).strict();
export const ProjectionSchema = z.object({ root: EvidenceRootSchema, workId: uuid }).strict();

export const SemanticInvariantSchema = FinancialSemanticsSchema.omit({
  entityId: true, entityType: true, periodStart: true, periodEnd: true,
}).strict();
export type SemanticInvariant = z.infer<typeof SemanticInvariantSchema>;
export const TemplateSchema = z.object({
  schema: z.literal('finnor.p6.structural-template.v1'),
  inputs: z.array(z.object({ key: role, semantics: SemanticInvariantSchema }).strict()).min(1).max(16),
  outputs: z.array(z.object({
    key: role, expression: ExpressionSchema, unit: FinancialSemanticsSchema.shape.unit,
    currencyCode: z.string().regex(/^[A-Z]{3}$/).nullable(),
  }).strict()).min(1).max(16),
  failure: z.literal('STOP_ON_MATERIAL_UNKNOWN_OR_NONEXACT_ARITHMETIC'),
  scope: z.literal('EXACT_SINGLE_ENTITY_PERIOD_AND_OWNER_CLOCKS'),
}).strict();
export type StructuralTemplate = z.infer<typeof TemplateSchema>;

export interface ExperienceRecord {
  ref: ImmutableRef; kind: string; episodeId: string; programId: string;
  knowledgeAt: string; body: unknown;
}
export interface EpisodeProjection {
  id: string; workId: string; requestIds: string[]; declaredBounds: unknown;
}
export interface EpisodeCut {
  schema: 'finnor.p6.native-episode-cut.v1'; tenantId: string; principalId: string;
  knowledgeCut: string; episodes: EpisodeProjection[]; records: ExperienceRecord[];
  futureKnowledgeExcluded: ImmutableRef[]; newAdverseNoticeRefs: ImmutableRef[];
  cutDigest: string; counts: Record<string, number>; protectedReceipt: null;
  qualification: 'AUTHORIZED_COMPLETE_DECLARED_NATIVE_EPISODES_NOT_PROTECTED_LEDGER_OR_CAUSAL_TRUTH';
  universe: 'CALLER_DECLARED_ORIGINAL_EPISODES_NOT_GLOBAL_SUCCESS_OR_NOVELTY_SAMPLE';
}

const rightsSchema = z.object({
  revision: z.number().int().nonnegative(), ref: z.string().min(1).max(512), evaluatedAt: instant,
  scope: z.literal('CURRENT_AUTHORIZED_RESOURCES').optional(),
}).strict();
const workSchema = z.object({ id: uuid, revision: uuid, inputDigest: digest }).strict();
const componentNames = ['module', 'parameters', 'returns', 'preconditions', 'applicability',
  'expectedResources', 'fallback'] as const;

export interface ProcedureCapsule {
  schema: 'finnor.procedure-capsule.v1'; id: string;
  tenantId: string; principalId: string;
  mandate: ImmutableRef | null; work: z.infer<typeof workSchema>;
  parents: ImmutableRef[]; rights: z.infer<typeof rightsSchema>;
  inputs: Array<{ ref: ImmutableRef; digest: string; asOf: { validAt: string; knowledgeAt: string } }>;
  producer: { version: typeof P6_VERSION; capability: ImmutableRef | null; codeDigest: string };
  runtime: { node: string; imageDigest: null; fabricInvocation: ImmutableRef | null };
  domain: ImmutableRef; dependencies: Array<{ key: string; revision: number; nodeIds: string[]; digest: string | null }>;
  costs: ImmutableRef[]; status: 'PROPOSED' | 'TESTED' | 'INVALIDATED' | 'FAILED';
  module: ImmutableRef; parameters: ImmutableRef; returns: ImmutableRef;
  preconditions: ImmutableRef[]; applicability: ImmutableRef; counterexamples: ImmutableRef[];
  independentTests: ImmutableRef[]; expectedResources: ImmutableRef;
  fallback: { ref: ImmutableRef; admitted: ImmutableRef | null; predicate: string };
  admission: null; template: StructuralTemplate;
  components: {
    module: NativeModule; parameters: unknown; returns: unknown; preconditions: unknown;
    applicability: unknown; expectedResources: unknown; fallback: unknown;
  };
  support: { episodes: string[]; companies: string[]; cutDigest: string; adverseRecords: ImmutableRef[] };
  unavailableBindings: string[];
  qualification: 'ORDINARY_TEST_ONLY_NO_S8_ADMISSION_NO_INTERVENTION_TRANSPORT_OR_ECONOMIC_CREDIT';
}

/** Full-envelope codec plus immutable component/preimage and executable bindings. */
export function parseCapsule(value: unknown): ProcedureCapsule {
  boundedJson(value, 2097152);
  const capsule = z.object({
    schema: z.literal('finnor.procedure-capsule.v1'), id: uuid, tenantId: uuid, principalId: uuid,
    mandate: ImmutableRefSchema.nullable(), work: workSchema, parents: z.array(ImmutableRefSchema).max(512),
    rights: rightsSchema, inputs: z.array(z.object({
      ref: ImmutableRefSchema, digest, asOf: z.object({ validAt: instant, knowledgeAt: instant }).strict(),
    }).strict()).max(128),
    producer: z.object({ version: z.literal(P6_VERSION), capability: ImmutableRefSchema.nullable(), codeDigest: digest }).strict(),
    runtime: z.object({ node: z.string().min(1).max(128), imageDigest: z.null(),
      fabricInvocation: ImmutableRefSchema.nullable() }).strict(),
    domain: ImmutableRefSchema, dependencies: z.array(z.object({
      key: z.string().min(1).max(512), revision: z.number().int().nonnegative(), nodeIds: z.array(role),
      digest: digest.nullable(),
    }).strict()).max(512),
    costs: z.array(ImmutableRefSchema).max(512), status: z.enum(['PROPOSED', 'TESTED', 'INVALIDATED', 'FAILED']),
    module: ImmutableRefSchema, parameters: ImmutableRefSchema, returns: ImmutableRefSchema,
    preconditions: z.array(ImmutableRefSchema).min(1).max(32), applicability: ImmutableRefSchema,
    counterexamples: z.array(ImmutableRefSchema).max(512), independentTests: z.array(ImmutableRefSchema).max(128),
    expectedResources: ImmutableRefSchema, fallback: z.object({
      ref: ImmutableRefSchema, admitted: ImmutableRefSchema.nullable(), predicate: z.string().min(1).max(160),
    }).strict(), admission: z.null(), template: TemplateSchema,
    components: z.object(Object.fromEntries(componentNames.map(name => [name, z.unknown()]))).strict(),
    support: z.object({ episodes: z.array(uuid).min(2).max(32), companies: z.array(uuid).min(2).max(32),
      cutDigest: digest, adverseRecords: z.array(ImmutableRefSchema).max(512) }).strict(),
    unavailableBindings: z.array(z.string().min(1).max(160)).min(1).max(32),
    qualification: z.literal('ORDINARY_TEST_ONLY_NO_S8_ADMISSION_NO_INTERVENTION_TRANSPORT_OR_ECONOMIC_CREDIT'),
  }).strict().parse(value) as unknown as ProcedureCapsule;
  for (const name of componentNames) {
    const reference = name === 'preconditions' ? capsule.preconditions[0]! :
      name === 'fallback' ? capsule.fallback.ref : capsule[name];
    if (stable(reference) !== stable(componentRef(name, capsule.components[name])))
      throw Error('P6_COMPONENT_REFERENCE_PREIMAGE_MISMATCH');
  }
  if (stable(capsule.domain) !== stable(capsule.applicability) ||
    stable(capsule.components.parameters) !== stable(capsule.template.inputs) ||
    stable(capsule.components.returns) !== stable(capsule.template.outputs.map(({ key, unit, currencyCode }) =>
      ({ key, unit, currencyCode })))) throw Error('P6_TEMPLATE_SCHEMA_BINDING_MISMATCH');
  const module = capsule.components.module;
  if (!module || module.admission !== null || sha(module.compiled) !== module.compiledDigest ||
    module.id !== 'module:' + module.compiledDigest || sha(module.source) !== module.sourceDigest ||
    stable(module.inputKeys) !== stable(capsule.template.inputs.map(i => i.key)))
    throw Error('P6_EXECUTABLE_MODULE_BINDING_MISMATCH');
  return capsule;
}

export function invariant(source: HarnessRequest['sources'][number]['source']): SemanticInvariant {
  if (source.kind !== 'metric' && source.kind !== 'artifact') throw Error('P6_OWNER_RESOLVED_SCHEMA_REQUIRED');
  const { unit, currencyCode, frequency, calendar, consolidation, instrument, scale, sign } = source;
  return SemanticInvariantSchema.parse({ unit, currencyCode, frequency, calendar, consolidation, instrument, scale, sign });
}
