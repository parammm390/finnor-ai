import {
  boundedJSON, ChangesSchema, digest, inputNodes, operatorBody, RequestSchema, requireZ1, stable, Z1Fault,
  type Binding, type Charge, type Checkpoint, type Columns, type Node, type OriginalWork,
  type Production, type ProgrammeChanges, type Relation, type Row, type SharedNode, type SharedWorkProgram,
  type SharedWorkRequest, type Source, type WorkProjection,
} from './contracts.js';
import { execute, infer, normalizeRow, normalizeScalar, qadd, qcmp, qdiv, qsub, qtext, quantity, type Rational } from './relational.js';

interface Planned extends SharedNode { node: Node; work: OriginalWork; source?: Source }
const ZERO = (): Rational => quantity('0');
const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();
const sum = (values: Iterable<string>): string => qtext([...values].reduce((a, b) => qadd(a, quantity(b)), ZERO()));
const same = (a: unknown, b: unknown): boolean => stable(a) === stable(b);
const fault = (error: unknown): Z1Fault => error instanceof Z1Fault ? error : new Z1Fault('UNSUPPORTED', 'INVALID_TYPED_PROGRAMME');
const meterGaps = [
  'TICKS_ARE_DETERMINISTIC_OPERATION_ACCOUNTING_NOT_CPU_OR_USD',
  'INPUT_VALIDATION_HASHING_STORAGE_IO_CHECKER_AND_FAILED_PROCESS_PHYSICAL_COSTS_REQUIRE_NATIVE_METERS',
  'NO_MODEL_PROVIDER_HUMAN_CAPITAL_OR_EFFECT_COST_MEASUREMENT',
];
function sourcesUsed(work: OriginalWork): string[] {
  return sorted(work.programme.nodes.flatMap(node => node.op === 'source' ? [node.sourceId] : []));
}
export function bindingFor(request: SharedWorkRequest, work: OriginalWork): Binding {
  const byId = new Map(request.sources.map(source => [source.id, source]));
  return {
    original: work, build: request.identity,
    sources: sourcesUsed(work).map(id => {
      const source = byId.get(id); requireZ1(source, 'ORIGINAL_SOURCE_UNAVAILABLE');
      return { id, revision: source.revision, digest: digest(source), partition: source.partition,
        revoked: source.revoked, evidenceClass: source.evidenceClass };
    }),
  };
}
function allowed(source: Source, work: OriginalWork): boolean {
  const { classification: sourceClass, ...sourcePartition } = source.partition;
  const { classification: workClass, ...workPartition } = work.partition;
  return same(sourcePartition, workPartition) && (sourceClass === 'PUBLIC' || sourceClass === workClass);
}
function topological(work: OriginalWork): Node[] {
  const byId = new Map(work.programme.nodes.map(node => [node.id, node]));
  requireZ1(byId.size === work.programme.nodes.length && byId.has(work.programme.output), 'DUPLICATE_OR_MISSING_ORIGINAL_NODE');
  const pending = new Set<string>([work.programme.output]), live = new Set<string>();
  while (pending.size) {
    const id = pending.values().next().value!;
    pending.delete(id);
    if (live.has(id)) continue;
    const node = byId.get(id); requireZ1(node, 'MISSING_ORIGINAL_DEPENDENCY'); live.add(id);
    inputNodes(node).forEach(input => pending.add(input));
  }
  requireZ1(live.size === byId.size, 'UNCOVERED_ORIGINAL_NODE');
  const indegree = new Map<string, number>(), dependents = new Map<string, string[]>();
  for (const node of work.programme.nodes) {
    const dependencies = sorted(inputNodes(node)); indegree.set(node.id, dependencies.length);
    for (const dependency of dependencies) {
      requireZ1(byId.has(dependency), 'MISSING_ORIGINAL_DEPENDENCY');
      const consumers = dependents.get(dependency) ?? []; consumers.push(node.id); dependents.set(dependency, consumers);
    }
  }
  const ready = work.programme.nodes.filter(node => indegree.get(node.id) === 0).map(node => node.id).sort(), order: Node[] = [];
  while (ready.length) {
    const id = ready.shift()!; order.push(byId.get(id)!);
    for (const next of (dependents.get(id) ?? []).sort()) {
      indegree.set(next, indegree.get(next)! - 1); if (indegree.get(next) === 0) ready.push(next);
    }
  }
  requireZ1(order.length === byId.size, 'ORIGINAL_DAG_CYCLE');
  return order;
}
function continuity(previous: Checkpoint, request: SharedWorkRequest): void {
  requireZ1(previous.schema === 'finnor.z1.checkpoint.v1', 'CHECKPOINT_VERSION_UNSUPPORTED');
  requireZ1(same(sorted(previous.request.works.map(w => w.id)), sorted(request.works.map(w => w.id))), 'ORIGINAL_WORK_IDENTITY_CHANGED', 'REVOKED');
  for (const old of previous.request.works) {
    const current = request.works.find(w => w.id === old.id)!;
    const immutable = (work: OriginalWork) => ({
      tenant: work.partition.tenantId, principal: work.partition.principalId,
      mandate: work.resources.mandateRef, assignment: work.resources.assignmentRef,
      parent: work.resources.parentReservationRef, budget: work.resources.remainingBudgetRef,
    });
    requireZ1(same(immutable(old), immutable(current)), 'ORIGINAL_PARENT_OR_PRINCIPAL_CHANGED', 'REVOKED');
    requireZ1(Date.parse(current.resources.originalDeadline) <= Date.parse(old.resources.originalDeadline) &&
      qcmp(quantity(current.resources.remainingTicks), quantity(old.resources.remainingTicks)) <= 0,
    'ORIGINAL_BUDGET_OR_DEADLINE_RENEWED', 'REVOKED');
    requireZ1(!old.withdrawn || current.withdrawn, 'WITHDRAWN_WORK_REACTIVATION_UNSUPPORTED', 'REVOKED');
    requireZ1(old.unresolvedObligationRefs.every(ref => current.unresolvedObligationRefs.includes(ref)),
      'UNRESOLVED_OBLIGATION_DROPPED', 'REVOKED');
  }
  for (const source of request.sources) {
    const old = previous.request.sources.find(s => s.id === source.id);
    if (old && old.revision === source.revision) requireZ1(same(old, source), 'SOURCE_BYTES_CHANGED_WITHOUT_REVISION', 'STALE');
  }
}
function validate(request: SharedWorkRequest): void {
  requireZ1(new Set(request.works.map(w => w.id)).size === request.works.length, 'DISTINCT_ORIGINAL_WORKS_REQUIRED');
  requireZ1(new Set(request.sources.map(s => s.id)).size === request.sources.length, 'DUPLICATE_ORIGINAL_SOURCE');
  requireZ1(request.works.reduce((n, work) => n + work.programme.nodes.length, 0) <= 4096, 'ORIGINAL_NODE_BOUND', 'INCOMPLETE');
  requireZ1(request.sources.reduce((n, source) => n + source.rows.length, 0) <= 100000, 'SOURCE_ROW_BOUND', 'INCOMPLETE');
  const identity = request.works[0]!.partition;
  requireZ1(request.works.every(work => work.partition.tenantId === identity.tenantId && work.partition.principalId === identity.principalId),
    'BATCH_AUTHENTICATED_PRINCIPAL_BOUNDARY', 'REVOKED');
  const sources = new Map(request.sources.map(source => [source.id, source]));
  for (const source of request.sources) {
    requireZ1(source.partition.tenantId === identity.tenantId && source.partition.principalId === identity.principalId,
      'BATCH_RAW_SOURCE_PRINCIPAL_BOUNDARY', 'REVOKED');
    requireZ1(Object.keys(source.columns).length <= 128, 'SOURCE_COLUMN_BOUND');
    for (const row of source.rows) normalizeRow(row, source.columns);
  }
  for (const work of request.works) {
    requireZ1(qcmp(quantity(work.resources.remainingTicks), ZERO()) >= 0, 'NEGATIVE_REMAINING_BUDGET', 'REVOKED');
    topological(work);
    for (const parameter of Object.values(work.parameters)) normalizeScalar(parameter.value, parameter.type);
    for (const id of sourcesUsed(work)) {
      const source = sources.get(id); requireZ1(source, 'ORIGINAL_SOURCE_UNAVAILABLE');
      requireZ1(allowed(source, work), 'PERMITTED_SOURCE_CONTEXT_UNAVAILABLE', 'REVOKED');
    }
  }
}
function contentDigest(program: SharedWorkProgram): string {
  return digest({ ...program, envelope: { ...program.envelope, immutableArtifactDigest: '' } });
}
export function verifyProgramDigest(program: SharedWorkProgram): boolean {
  return program.envelope.immutableArtifactDigest === contentDigest(program);
}
function emptyCosts(): SharedWorkProgram['costs'] {
  return { totalTicks: '0', byWork: {}, charges: [], usd: null, gaps: [...meterGaps] };
}
export function produce(value: unknown, options: { previous?: Checkpoint; mode?: 'SHARED' | 'DIRECT' } = {}): Production {
  let request: SharedWorkRequest | null = null, checkpoint: Checkpoint | null = options.previous ? structuredClone(options.previous) : null;
  const charges: Charge[] = [], current = new Map<string, Rational>(), cumulative = new Map<string, Rational>();
  const values = new Map<string, Relation>(), plan = new Map<string, Planned>();
  const projections: WorkProjection[] = [];
  let ticks = 0, bytes = 0, derivedRows = 0;
  const costs = (): SharedWorkProgram['costs'] => ({
    totalTicks: String(ticks), byWork: Object.fromEntries([...current].map(([id, q]) => [id, qtext(q)])),
    charges, usd: null, gaps: [...meterGaps],
  });
  try {
    boundedJSON(value, 134217728); request = RequestSchema.parse(value);
    boundedJSON(request, request.limits.maxBytes);
    if (options.previous) continuity(options.previous, request);
    validate(request);
    requireZ1(Date.now() < Date.parse(request.limits.deadlineAt) && request.works.filter(w => !w.withdrawn)
      .every(w => Date.now() < Date.parse(w.resources.originalDeadline)), 'ORIGINAL_DEADLINE_EXHAUSTED', 'INCOMPLETE');
    const mode = options.mode ?? options.previous?.mode ?? 'SHARED', requestDigest = digest(request);
    if (options.previous?.program && options.previous.mode === mode && options.previous.program.requestDigest === requestDigest) {
      requireZ1(verifyProgramDigest(options.previous.program), 'CHECKPOINT_ARTIFACT_DIGEST_MISMATCH', 'COUNTEREXAMPLE');
      // This is duplicate delivery of already charged computation, not fresh admission.
      return { disposition: 'UNKNOWN', reason: null, program: structuredClone(options.previous.program),
        checkpoint: structuredClone(options.previous), costs: emptyCosts() };
    }
    checkpoint = { schema: 'finnor.z1.checkpoint.v1', request, program: null, cache: {},
      charges: { ...(options.previous?.charges ?? {}) }, history: [...(options.previous?.history ?? [])],
      generation: (options.previous?.generation ?? 0) + 1, mode };
    for (const work of request.works) {
      current.set(work.id, ZERO()); cumulative.set(work.id,
        quantity(Object.hasOwn(checkpoint.charges, work.id) ? checkpoint.charges[work.id]! : '0'));
    }
    const timeCheck = (): void => {
      const deadlines = [request!.limits.deadlineAt, ...request!.works.filter(w => !w.withdrawn).map(w => w.resources.originalDeadline)];
      requireZ1(deadlines.every(deadline => Date.now() < Date.parse(deadline)), 'ORIGINAL_DEADLINE_EXHAUSTED', 'INCOMPLETE');
    };
    const charge = (consumers: string[], count: number, phase: Charge['phase'], key: string | null): void => {
      requireZ1(consumers.length > 0 && Number.isSafeInteger(count) && count >= 0, 'UNATTRIBUTABLE_SHARED_COST', 'COUNTEREXAMPLE');
      if (!count) return;
      const share = qdiv(quantity(String(count)), quantity(String(consumers.length)));
      for (const id of consumers) {
        const work = request!.works.find(w => w.id === id)!;
        requireZ1(qcmp(qadd(cumulative.get(id)!, share), quantity(work.resources.remainingTicks)) <= 0,
          'REMAINING_ORIGINAL_PARENT_BUDGET_EXHAUSTED', 'INCOMPLETE');
      }
      requireZ1(ticks + count <= request!.limits.maxTicks, 'ATTEMPT_OPERATION_BOUND', 'INCOMPLETE');
      timeCheck();
      const allocations: Record<string, string> = Object.fromEntries(consumers.map(id => [id, qtext(share)]));
      for (const id of consumers) {
        current.set(id, qadd(current.get(id)!, share)); cumulative.set(id, qadd(cumulative.get(id)!, share));
      }
      ticks += count;
      const prior = charges[charges.length - 1];
      if (prior && prior.phase === phase && prior.nodeKey === key && same(Object.keys(prior.allocations), consumers)) {
        prior.ticks = qtext(qadd(quantity(prior.ticks), quantity(String(count))));
        for (const id of consumers) prior.allocations[id] = qtext(qadd(quantity(prior.allocations[id]!), share));
      } else charges.push({ phase, nodeKey: key, ticks: String(count), allocations });
    };
    const sources = new Map(request.sources.map(source => [source.id, source]));
    for (const work of request.works) {
      timeCheck();
      const binding = bindingFor(request, work), revoked = binding.sources.some(source => source.revoked);
      const projection: WorkProjection = {
        workId: work.id, lifecycle: work.withdrawn ? 'WITHDRAWN' : 'ACTIVE',
        disposition: revoked ? 'REVOKED' : 'UNKNOWN', result: null, originalNodeKeys: {}, outputKey: null,
        binding, bindingDigest: digest(binding), unresolvedObligationRefs: [...work.unresolvedObligationRefs],
        accounting: { chargedTicks: '0', cumulativeTicks: qtext(cumulative.get(work.id)!), remainingTicks: work.resources.remainingTicks },
      };
      projections.push(projection);
      if (work.withdrawn || revoked) continue;
      const shape = new Map<string, Relation>();
      for (const node of topological(work)) {
        charge([work.id], 1, 'DISCOVERY', null);
        const inputs = inputNodes(node).map(id => shape.get(id)!);
        const source = node.op === 'source' ? sources.get(node.sourceId)! : undefined;
        const outputSchema: Columns = infer(node, inputs, work.parameters, source);
        const inputKeys = inputNodes(node).map(id => projection.originalNodeKeys[id]!);
        const operator = operatorBody(node), key = digest({
          partition: work.partition, build: request.identity.producerBuildIdentity, parameters: work.parameters,
          operator, inputs: inputKeys, source: source ? digest(source) : null, mode: mode === 'DIRECT' ? work.id : null,
        });
        projection.originalNodeKeys[node.id] = key;
        shape.set(node.id, { columns: outputSchema, rows: [], ordered: false });
        const existing = plan.get(key);
        if (existing) existing.workIds = sorted([...existing.workIds, work.id]);
        else plan.set(key, { key, node, work, source, operator, inputs: inputKeys, workIds: [work.id], outputSchema });
      }
      projection.outputKey = projection.originalNodeKeys[work.programme.output]!;
    }
    for (const entry of plan.values()) {
      timeCheck();
      const old = options.previous?.cache[entry.key];
      if (old) {
        requireZ1(digest(old.value) === old.digest && same(old.value.columns, entry.outputSchema), 'CHECKPOINT_VALUE_DIGEST_OR_TYPE_MISMATCH', 'COUNTEREXAMPLE');
        charge(entry.workIds, 1, 'STORAGE', entry.key);
        bytes += Buffer.byteLength(stable(old.value));
        requireZ1(bytes <= request.limits.maxBytes, 'RETAINED_BYTE_BOUND', 'INCOMPLETE');
        values.set(entry.key, old.value);
        checkpoint.cache[entry.key] = old;
        continue;
      }
      const result = execute(entry.node, entry.inputs.map(key => values.get(key)!), entry.work.parameters, {
        tick: (count = 1) => charge(entry.workIds, count, 'EXECUTION', entry.key),
        row: (row, derived) => {
          bytes += Buffer.byteLength(stable(row));
          if (derived) derivedRows++;
          requireZ1(derivedRows <= 1000000 && bytes <= request!.limits.maxBytes, 'DERIVED_ROW_OR_BYTE_BOUND', 'INCOMPLETE');
        },
      }, entry.source);
      charge(entry.workIds, 1, 'STORAGE', entry.key);
      values.set(entry.key, result);
      checkpoint.cache[entry.key] = { value: result, digest: digest(result) };
    }
    timeCheck();
    for (const projection of projections) {
      if (projection.outputKey) projection.result = values.get(projection.outputKey)!;
      const work = request.works.find(w => w.id === projection.workId)!;
      projection.accounting = {
        chargedTicks: qtext(current.get(work.id)!), cumulativeTicks: qtext(cumulative.get(work.id)!),
        remainingTicks: qtext(qsub(quantity(work.resources.remainingTicks), cumulative.get(work.id)!)),
      };
    }
    const incurred = costs();
    requireZ1(sum(Object.values(incurred.byWork)) === incurred.totalTicks, 'SHARED_COST_NOT_CONSERVED', 'COUNTEREXAMPLE');
    const identity = request.works[0]!.partition, allObligations = sorted(request.works.flatMap(work => work.unresolvedObligationRefs));
    const program: SharedWorkProgram = {
      schema: 'finnor.z1.shared-work-program.v1', version: checkpoint.generation, requestDigest,
      envelope: {
        schemaVersion: 'finnor.project-z.artifact-envelope.v1', phase: 'Z1', principalOutputType: 'SharedWorkProgram',
        immutableArtifactDigest: '', productLockDigest: request.identity.productLockDigest,
        sourceCommit: request.identity.sourceCommit, sourceTree: request.identity.sourceTree,
        producerBuildIdentity: request.identity.producerBuildIdentity, originalTenant: identity.tenantId, principal: identity.principalId,
        Work: request.works.map(work => work.id), mandate: request.works.map(w => w.resources.mandateRef),
        assignment: request.works.map(w => w.resources.assignmentRef), parentReservation: request.works.map(w => w.resources.parentReservationRef),
        originalDeadline: request.works.map(w => w.resources.originalDeadline),
        remainingBudgetReference: request.works.map(w => w.resources.remainingBudgetRef), unresolvedObligationReferences: allObligations,
        inputSemanticsAndRevisionReferences: request.works.map(w => w.inputRef),
        rightsAndPermittedUseFingerprint: request.works.map(w => digest(w.partition)),
        supportedDomain: 'EXACT_FINITE_TYPED_PURE_RELATIONAL_DAGS_V1',
        unsupportedConditions: ['FLOATS', 'EFFECTS', 'RECURSION', 'UNDECLARED_UNIT_ALGEBRA', 'OUT_OF_PROFILE_OR_EXHAUSTED_RESOURCES'],
        claimAndEvidenceClasses: sorted(['deterministic', ...request.sources.map(source => source.evidenceClass)]),
        checkerIdentityAndResultReferences: { identity: request.identity.checkerIdentity, resultReference: null },
        currentnessDependencies: projections.map(p => p.bindingDigest),
        securityAndConfidentialityProfile: 'PRIVATE_AUTHENTICATED_PRINCIPAL; EXACT_LAWFUL_PARTITIONS; NOT_EFFECT_AUTHORITY',
        ownerConsumerContractVersion: request.identity.ownerConsumerContractVersion,
        costAndResourceReceiptReferences: [digest(incurred)],
        gaps: ['INDEPENDENT_CHECK_REQUIRED', 'NATIVE_OWNER_ADMISSION_AND_USE_REQUIRED', ...meterGaps],
        reconstructionReference: request.identity.reconstructionReference,
      },
      sharedDag: [...plan.values()].map(({ key, operator, inputs, workIds, outputSchema }) => ({ key, operator, inputs, workIds, outputSchema })),
      workProjections: projections, rules: {
        initial: 'EXACT_STRUCTURAL_HASH_CONS_WITHIN_COMPLETE_LAWFUL_PARTITION',
        delta: 'RECOMPUTE_DIRTY_DEPENDENT_OPERATORS; REUSE_EXACT_UNCHANGED_VALUES',
        edits: 'RECOMPILE_ORIGINAL_CHANGED_GRAPH; PRESERVE_PARENT_HISTORY_COSTS_AND_OBLIGATIONS',
        retractions: 'ATOMIC_EXACT_BAG_SUBTRACTION_BEFORE_DEPENDENT_RECOMPUTATION', rewrites: [],
      },
      costs: incurred, predecessorDigest: options.previous?.program?.envelope.immutableArtifactDigest ?? null,
      history: [...checkpoint.history], executionAuthorityGranted: false, protectedAdmission: false,
    };
    program.envelope.immutableArtifactDigest = contentDigest(program);
    checkpoint.program = program;
    checkpoint.charges = Object.fromEntries([...cumulative].map(([id, q]) => [id, qtext(q)]));
    checkpoint.history.push({ generation: checkpoint.generation, requestDigest, artifactDigest: program.envelope.immutableArtifactDigest,
      disposition: 'UNKNOWN', totalTicks: incurred.totalTicks, unresolvedObligationRefs: allObligations });
    return { disposition: projections.some(p => p.result) ? 'UNKNOWN' : projections.some(p => p.disposition === 'REVOKED') ? 'REVOKED' : 'UNKNOWN',
      reason: null, program, checkpoint, costs: incurred };
  } catch (error) {
    const problem = fault(error), incurred = costs();
    if (checkpoint && request && checkpoint.request === request) {
      checkpoint.charges = Object.fromEntries([...cumulative].map(([id, q]) => [id, qtext(q)]));
      checkpoint.history.push({
        generation: checkpoint.generation, requestDigest: digest(request), artifactDigest: null, disposition: problem.disposition,
        totalTicks: incurred.totalTicks, unresolvedObligationRefs: sorted(request.works.flatMap(work => work.unresolvedObligationRefs)),
      });
    }
    return { disposition: problem.disposition, reason: problem.message, program: null, checkpoint, costs: incurred };
  }
}
export function applyChanges(previous: Checkpoint | null, value: ProgrammeChanges | unknown): Production {
  try {
    requireZ1(previous, 'DURABLE_ORIGINAL_CHECKPOINT_REQUIRED');
    boundedJSON(value, 134217728); const change = ChangesSchema.parse(value), request = structuredClone(previous.request);
    requireZ1(new Set(change.sourceChanges?.map(c => c.sourceId)).size === (change.sourceChanges?.length ?? 0), 'DUPLICATE_SOURCE_CHANGE', 'COUNTEREXAMPLE');
    for (const patch of change.sourceChanges ?? []) {
      const source = request.sources.find(s => s.id === patch.sourceId);
      requireZ1(source && source.revision === patch.fromRevision && patch.fromRevision !== patch.toRevision, 'SOURCE_EDIT_REVISION_FENCED', 'STALE');
      const counts = new Map<string, { row: Row; count: number }>();
      for (const row of source.rows) {
        const normalized = normalizeRow(row, source.columns), key = stable(normalized), entry = counts.get(key);
        counts.set(key, { row: normalized, count: (entry?.count ?? 0) + 1 });
      }
      for (const row of patch.retract) {
        const key = stable(normalizeRow(row, source.columns)), entry = counts.get(key);
        requireZ1(entry && entry.count > 0, 'NEGATIVE_BAG_MULTIPLICITY', 'COUNTEREXAMPLE'); entry.count--;
      }
      for (const row of patch.insert) {
        const normalized = normalizeRow(row, source.columns), key = stable(normalized), entry = counts.get(key);
        counts.set(key, { row: normalized, count: (entry?.count ?? 0) + 1 });
      }
      requireZ1([...counts.values()].reduce((total, entry) => total + entry.count, 0) <= 100000, 'SOURCE_ROW_BOUND', 'INCOMPLETE');
      source.rows = [...counts.values()].flatMap(entry => Array.from({ length: entry.count }, () => entry.row));
      source.revision = patch.toRevision;
      if (patch.revoked !== undefined) source.revoked = patch.revoked;
    }
    requireZ1(new Set(change.workEdits?.map(c => c.workId)).size === (change.workEdits?.length ?? 0), 'DUPLICATE_PROGRAMME_EDIT', 'COUNTEREXAMPLE');
    for (const patch of change.workEdits ?? []) {
      const index = request.works.findIndex(work => work.id === patch.workId), old = request.works[index];
      requireZ1(old && old.programmeRevision === patch.expectedProgrammeRevision, 'PROGRAMME_EDIT_REVISION_FENCED', 'STALE');
      requireZ1(patch.replacement.id === old.id && patch.replacement.programmeRevision !== old.programmeRevision,
        'ORIGINAL_PROGRAMME_EDIT_IDENTITY', 'REVOKED');
      request.works[index] = patch.replacement;
    }
    for (const id of change.withdrawWorkIds ?? []) {
      const work = request.works.find(w => w.id === id); requireZ1(work, 'ORIGINAL_WORK_UNAVAILABLE'); work.withdrawn = true;
    }
    return produce(request, { previous });
  } catch (error) {
    const problem = fault(error);
    return { disposition: problem.disposition, reason: problem.message, program: null, checkpoint: previous, costs: emptyCosts() };
  }
}
export function currentness(program: SharedWorkProgram, value: unknown, workId: string): 'CURRENT' | 'STALE' | 'REVOKED' {
  try {
    boundedJSON(value, 134217728);
    const request = RequestSchema.parse(value), work = request.works.find(w => w.id === workId);
    if (!work || work.withdrawn) return 'REVOKED';
    if (Date.now() >= Date.parse(work.resources.originalDeadline) || Date.now() >= Date.parse(request.limits.deadlineAt)) return 'STALE';
    const projection = program.workProjections.find(p => p.workId === workId);
    if (!projection || !verifyProgramDigest(program)) return 'STALE';
    const binding = bindingFor(request, work);
    if (binding.sources.some(s => s.revoked) || sourcesUsed(work).some(id => !allowed(request.sources.find(s => s.id === id)!, work))) return 'REVOKED';
    return projection.bindingDigest === digest(binding) ? 'CURRENT' : 'STALE';
  } catch { return 'STALE'; }
}
export function projectForWork(program: SharedWorkProgram, workId: string, identity: { tenantId: string; principalId: string }): WorkProjection {
  const projection = program.workProjections.find(p => p.workId === workId);
  requireZ1(projection && projection.binding.original.partition.tenantId === identity.tenantId &&
    projection.binding.original.partition.principalId === identity.principalId, 'PERMITTED_WORK_CONTEXT_UNAVAILABLE', 'REVOKED');
  requireZ1(verifyProgramDigest(program), 'IMMUTABLE_ARTIFACT_DIGEST_MISMATCH', 'COUNTEREXAMPLE');
  return structuredClone(projection);
}
