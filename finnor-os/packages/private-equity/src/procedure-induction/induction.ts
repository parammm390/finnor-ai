import type { Expression, HarnessProgram, HarnessRequest } from '../program-synthesis/contracts';
import { constructModules, validateAcceptance } from '../program-synthesis/compiler';
import { sha, stable } from '../evidence-execution/store';
import { P6_VERSION, TemplateSchema, componentRef, invariant, parseCapsule,
  type StructuralTemplate, type EpisodeCut, type ProcedureCapsule } from './contracts';

/** Alpha-normalize dependencies, never task words, numeric observations or
 * guessed financial meaning. Variable literals are NOT silently generalized. */
export function normalizeMethod(request: HarnessRequest): { template: StructuralTemplate; bindings: Record<string, string> } {
  validateAcceptance(request);
  if (request.operations?.length || request.ownerBindings || request.computeSearch)
    throw Error('P6_OWNER_OPERATION_OR_ADAPTIVE_METHOD_DOMAIN_UNSUPPORTED');
  const slots = new Map<string, string>(), sources = new Map(request.sources.map(s => [s.key, s.source]));
  function walk(e: Expression): Expression {
    if (e.kind === 'input') {
      if (!sources.has(e.key!)) throw Error('P6_UNRESOLVED_STRUCTURAL_INPUT');
      if (!slots.has(e.key!)) slots.set(e.key!, 'p' + slots.size);
      return { kind: 'input', key: slots.get(e.key!)! };
    }
    if (e.kind === 'literal') return { ...e };
    if (e.kind === 'if') return {
      kind: 'if', condition: { comparison: e.condition!.comparison,
        left: walk(e.condition!.left), right: walk(e.condition!.right) },
      whenTrue: walk(e.whenTrue!), whenFalse: walk(e.whenFalse!),
    };
    return { kind: e.kind, left: walk(e.left!), right: walk(e.right!) };
  }
  const outputs = request.acceptance.targets.map((t, i) => ({
    key: 'o' + i, expression: walk(t.expression), unit: t.unit, currencyCode: t.currencyCode,
  }));
  if (slots.size !== request.sources.length) throw Error('P6_MATERIAL_STRUCTURAL_SOURCE_UNCOVERED');
  const template = TemplateSchema.parse({
    schema: 'finnor.p6.structural-template.v1',
    inputs: [...slots].map(([key, slot]) => ({ key: slot, semantics: invariant(sources.get(key)!) })),
    outputs, scope: 'EXACT_SINGLE_ENTITY_PERIOD_AND_OWNER_CLOCKS',
    failure: 'STOP_ON_MATERIAL_UNKNOWN_OR_NONEXACT_ARITHMETIC',
  });
  return { template, bindings: Object.fromEntries([...slots].map(([key, slot]) => [slot, key])) };
}

/** Build a fictitious type-checking context ONLY for finite module lowering.
 * It is never used for source reads, authorization, observations or execution. */
export function templateRequest(template: StructuralTemplate): HarnessRequest {
  const root = { entityType: 'external_organization' as const, entityId: '00000000-0000-4000-8000-000000000001' };
  return {
    schema: 'finnor.harness-request.v1', instruction: 'Finite structural module type context, not an episode',
    root, validAt: '2000-01-01T00:00:00.000Z', mode: 'ordinary_disposable',
    idempotencyKey: 'not-an-execution', proposalSource: 'REGISTERED_NATIVE',
    sources: template.inputs.map(i => ({ key: i.key, source: {
      kind: 'metric', subject: root, metricKey: i.key, periodStart: '2000-01-01T00:00:00.000Z',
      periodEnd: '2000-12-31T00:00:00.000Z', ...i.semantics,
    } })),
    acceptance: { requiredSourceKeys: template.inputs.map(i => i.key), targets: template.outputs,
      deliverable: { kind: 'analytical_draft', title: 'Finite structural type context' } },
  };
}

export function induceProcedures(cut: EpisodeCut, codeDigest: string, id: () => string,
  context: Pick<ProcedureCapsule, 'work' | 'rights'>) {
  const groups = new Map<string, Array<{ request: HarnessRequest; program: HarnessProgram; record: EpisodeCut['records'][number] }>>();
  const rejected: Array<{ refs: unknown[]; predicate: string }> = [];
  const requestRecords = new Map(cut.records.filter(r => r.kind === 'REQUEST').map(r =>
    [r.programId, (r.body as { request: HarnessRequest }).request]));
  const latest = new Map<string, EpisodeCut['records'][number]>();
  for (const row of cut.records.filter(r => r.kind === 'PROGRAMME_HEAD')) latest.set(row.programId, row);
  const adverseRecords = cut.records.filter(r => /FAIL|UNKNOWN|INVALIDAT|CORRECT|CANCEL|DISCREPANC|QUARANTIN|STOP/.test(r.kind)).map(r => r.ref);
  for (const [programId, record] of latest) {
    const program = record.body as HarnessProgram, request = requestRecords.get(programId);
    if (!request) throw Error('P6_SOURCE_REQUEST_PREIMAGE_REQUIRED');
    if (program.status !== 'TESTED' || !program.result || !program.independentChecks.length) {
      rejected.push({ refs: [record.ref], predicate: 'P6_NONTESTED_OR_INCOMPLETE_HEAD_RETAINED_NOT_SUPPORT' }); continue;
    }
    if (program.tenantId !== cut.tenantId || program.principalId !== cut.principalId ||
      program.acceptanceDigest !== sha(request.acceptance) || program.bounds.episodeId !== record.episodeId)
      throw Error('P6_EPISODE_HEAD_BINDING_MISMATCH');
    try {
      const normalized = normalizeMethod(request);
      const key = sha(normalized.template), members = groups.get(key) ?? [];
      members.push({ request, program, record }); groups.set(key, members);
    } catch (error) { rejected.push({ refs: [record.ref], predicate: (error as Error).message }); }
  }
  const capsules: ProcedureCapsule[] = [];
  for (const members of groups.values()) {
    const episodes = [...new Set(members.map(m => m.record.episodeId))].sort();
    const companies = [...new Set(members.map(m => m.request.root.entityId))].sort();
    if (episodes.length < 2 || companies.length < 2) {
      rejected.push({ refs: members.map(m => m.record.ref), predicate: 'P6_DISTINCT_EPISODE_AND_COMPANY_SUPPORT_REQUIRED' }); continue;
    }
    const first = members[0]!, template = normalizeMethod(first.request).template;
    const module = constructModules(templateRequest(template), codeDigest)[0]!;
    const components: ProcedureCapsule['components'] = {
      module, parameters: template.inputs,
      returns: template.outputs.map(({ key, unit, currencyCode }) => ({ key, unit, currencyCode })),
      preconditions: ['CURRENT_S1_RIGHTS_AND_WORK', 'EXACT_SOURCE_SEMANTICS_AND_SCOPE',
        'COMPLETE_MATERIAL_INPUTS_AND_WITNESSES', 'ORIGINAL_P1_GRANT_AND_DEADLINE',
        'CURRENT_UNINVALIDATED_CAPSULE_BYTES', 'NO_OWNER_OPERATION_OR_TRANSPORT_AUTHORITY'],
      applicability: { templateDigest: sha(template), expressionMatching: 'EXACT_NONOVERLAPPING_SUBTREE',
        allowedSourceKinds: ['metric', 'artifact'], sourceNamesAndLayoutsAreExplicitParameters: true,
        invariantSemantics: template.inputs, scientificIdentificationGranted: false },
      expectedResources: { maximumCoreSteps: module.bounds.steps, maximumDepth: module.bounds.depth,
        bytes: module.bounds.bytes, wallTimeMsMaximum: 10000, dollars: null,
        originalGrantRequired: true, totalMemoryCpuDiskQuotaQualified: false },
      fallback: { owner: 'P1', producerVersion: first.program.producer.version, codeDigest,
        mode: 'REAL_FRESH_ORDINARY_SYNTHESIS_WITHIN_ORIGINAL_GRANT', admitted: null },
    };
    const refs = Object.fromEntries(Object.entries(components).map(([name, body]) =>
      [name, componentRef(name, body)])) as Record<keyof typeof components, ReturnType<typeof componentRef>>;
    const capsule: ProcedureCapsule = {
      schema: 'finnor.procedure-capsule.v1', id: id(), tenantId: cut.tenantId, principalId: cut.principalId,
      mandate: null, work: context.work,
      parents: members.map(m => m.record.ref), rights: context.rights,
      inputs: members.map(m => ({ ref: m.record.ref, digest: m.record.ref.contentDigest,
        asOf: { validAt: m.program.validAt, knowledgeAt: m.record.knowledgeAt } })),
      producer: { version: P6_VERSION, capability: null, codeDigest },
      runtime: { node: process.version, imageDigest: null, fabricInvocation: null },
      domain: refs.applicability, dependencies: [], costs: members.map(m => componentRef('source-cost', m.program.costs)),
      status: 'PROPOSED', module: refs.module, parameters: refs.parameters, returns: refs.returns,
      preconditions: [refs.preconditions], applicability: refs.applicability,
      counterexamples: adverseRecords, independentTests: members.map(m => componentRef('source-checks', m.program.independentChecks)),
      expectedResources: refs.expectedResources, fallback: { ref: refs.fallback, admitted: null,
        predicate: 'S8_ADMITTED_GENERIC_FALLBACK_UNAVAILABLE' },
      admission: null, template, components,
      support: { episodes, companies, cutDigest: cut.cutDigest, adverseRecords },
      unavailableBindings: ['BASE10_CUMULATIVE_SUCCESSOR', 'COMPLETE_PROTECTED_ANALYTICAL_EPISODES',
        'S4_CANONICAL_MANDATE', 'S5_FUNDING', 'S8_PROCEDURE_AND_PRODUCER_ADMISSION',
        'ATTESTED_RUNTIME_IMAGE', 'INDUCTION_FABRIC_ATTESTATION', 'COMPLETE_RECONCILED_DOLLARS',
        'INDEPENDENT_SEALED_TRANSFER_AND_REAL_REUSE_HORIZON'],
      qualification: 'ORDINARY_TEST_ONLY_NO_S8_ADMISSION_NO_INTERVENTION_TRANSPORT_OR_ECONOMIC_CREDIT',
    };
    capsules.push(parseCapsule(JSON.parse(stable(capsule))));
  }
  return { capsules, rejected, allSourceRecordsRetained: cut.records.length,
    status: capsules.length ? 'PROPOSED' as const : 'NO_SUPPORTED_ABSTRACTION' as const };
}
