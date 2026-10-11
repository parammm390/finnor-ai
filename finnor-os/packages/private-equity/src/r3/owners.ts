import type { PoolClient } from 'pg';
import { activeWorkPlanRevision } from '@finnor/db';
import type { AllocationResource, EconomicMandate, EvidenceDependency, ExperimentRef } from '@finnor/shared-types';
import type { ElicitationProblem, ElicitationResource } from '../../../shared-types/src/elicitation-protocol';
import { parseR3Problem, R3PreferenceDeclarationSchema, type R3Submit } from '../../../epistemic-runtime/src/incentive-rule-synthesis/contracts';
import { r3Digest, r3RuntimeIdentity } from '../../../epistemic-runtime/src/incentive-rule-synthesis/launcher';
import { R3_ZERO, r3FromDecimal, readR3LedgerQuantity } from '../../../epistemic-runtime/src/incentive-rule-synthesis/exact';
import { resolveDecisionWork } from '../decision-slice/adapters';
import type { WorkBinding } from '../decision-slice/contracts';
import { readSourceObject } from '../deliberation/store';
import { readEnterpriseContingentPolicy } from '../enterprise-control';
import { readValidatedNumericEnterpriseAllocation } from '../enterprise-allocation';
import { readAllocationSnapshot } from '../allocation-store';
import { authorizeBeliefResources, validateBeliefViewPin } from '../enterprise-beliefs';
import { assertDependencies, codeIdentity, revisions, schemaIdentity, tx, principal, unavailable } from '../evidence-execution/store';
import type { PeMutationContext } from '../types';
import { r3Authorize, type R3RequestRow } from './store';
import { resolveR3ProgramTarget, assertR3ProgramTarget } from './program-target';

export interface R3OwnerBinding {
  work: WorkBinding; source: { sourceId: string; versionId: string; contentDigest: string; versionNumber: number };
  plan: { id: string; semanticHash: string; workInputId: string };
  incumbentPolicyRef: ExperimentRef; mandate: EconomicMandate; resourceSnapshotDigest: string;
  resourceRefs: ExperimentRef[]; dependencies: EvidenceDependency[]; codeDigest: string; schemaDigest: string;
  runtimeDigest: string; validUntil: string;
  grant: { ref: ExperimentRef; reservationRef: ExperimentRef; resourceId: string; resourceRef: ExperimentRef;
    capacity: number; envelope: unknown; validUntil: string };
}
const same = (a: unknown, b: unknown) => r3Digest(a) === r3Digest(b);
const ledger = (s: string) => s.startsWith('r3q:') ? readR3LedgerQuantity(s) : r3FromDecimal(s);
export async function r3ResourceInput(ctx: PeMutationContext, mandate: EconomicMandate) {
  const snapshot = await readAllocationSnapshot(ctx), resources: ElicitationResource[] = [];
  const pins = new Map<string, AllocationResource['beliefPins'][number]>();
  for (const r of snapshot.resources) {
    if (r.revoked || r.rightsRef !== mandate.rightsRef || !same(r.horizon, mandate.horizon) ||
      r.ownerRef.id !== principal(ctx) || r.availability.some(v => v.amount === null || v.basis !== 'REPORTED_AVAILABLE') ||
      Date.now() >= Date.parse(r.validUntil)) throw Error('R3_CURRENT_COMPLETE_RESOURCE_SEMANTICS_REQUIRED');
    for (const pin of r.beliefPins) pins.set(r3Digest(pin), pin);
    const upper = r.existingUse.map(ledger), lower = r.existingUse.map(ledger);
    for (const commitment of snapshot.outstanding) for (const e of commitment.envelopes.filter(e => e.resourceId === r.resourceId)) {
      if (e.unit !== r.unit || e.kind !== r.kind || !same(e.horizon, r.horizon) || e.quantities.length !== upper.length ||
        e.minimumQuantities.length !== lower.length) throw Error('R3_OUTSTANDING_UNKNOWN_COMMITMENT_SEMANTICS_UNRESOLVED');
      e.quantities.forEach((s, t) => { upper[t] = upper[t]!.add(ledger(s)); lower[t] = lower[t]!.add(ledger(e.minimumQuantities[t]!)) });
    }
    resources.push({ ref: r.ref, resourceId: r.resourceId, unit: r.unit, kind: r.kind, horizon: r.horizon,
      availability: r.availability.map(v => ledger(v.amount!).json()), baseline: upper.map(v => v.json()),
      minimumBaseline: lower.map(v => v.json()), safetyMargin: ledger(r.safetyMargin).json() });
  }
  // Identical complete pins share one fresh replay in this invocation. A distinct
  // source, rights, root or method pin always gets its own owner validation.
  await Promise.all([...pins.values()].map(async pin => {
    if ((await validateBeliefViewPin(ctx, pin)).status !== 'CURRENT') throw Error('R3_RESOURCE_SOURCE_OR_RIGHTS_CHANGED');
  }));
  const definitions = new Map(snapshot.resources.flatMap(r => r.covenants).map(c => [c.id, c]));
  for (const c of snapshot.resources.flatMap(r => r.covenants)) if (!same(c, definitions.get(c.id))) throw Error('R3_CONFLICTING_SHARED_COVENANT');
  const covenants: ElicitationProblem['covenants'] = [...definitions.values()].map(c => ({
    id: c.id, sourceRef: c.sourceRef, unit: c.unit, periods: c.periods,
    terms: c.terms.map(t => ({ resourceId: t.resourceId, coefficient: ledger(t.coefficient).json() })),
    maximum: ledger(c.maximum).json(), safetyMargin: ledger(c.safetyMargin).json(),
  }));
  return { snapshot, resources, covenants };
}
export async function resolveR3Owners(ctx: PeMutationContext, request: R3Submit): Promise<{ problem: ElicitationProblem; binding: R3OwnerBinding }> {
  if (ctx.auth.role !== 'owner') throw unavailable();
  await tx(ctx, c => r3Authorize(ctx, c));
  const work = await resolveDecisionWork(ctx, request.existing_work_revision.workId);
  if (work.inputId !== request.existing_work_revision.revision) throw Error('R3_ORIGINAL_WORK_REVISION_CHANGED');
  const plan = await activeWorkPlanRevision(ctx.auth.tenantId, work.id);
  if (!plan || plan.workInputId !== work.inputId) throw Error('R3_ACTUAL_EXISTING_WORK_PLAN_REQUIRED');
  const source = await readSourceObject(ctx, request.existing_work_revision.root, request.problem_ref.sourceId, request.problem_ref.versionId);
  if (source.content_hash !== request.problem_ref.contentDigest) throw Error('R3_ORIGINAL_PREFERENCE_SOURCE_DIGEST_REQUIRED');
  const declared = R3PreferenceDeclarationSchema.parse(JSON.parse(source.content));
  if (!same(declared.root, request.existing_work_revision.root) || declared.workId !== work.id || declared.workRevision !== work.inputId ||
    !same(declared.domainRef, request.domain_profile_ref) || Date.parse(declared.asOf) > Date.now() || Date.now() >= Date.parse(declared.validUntil))
    throw Error('R3_DECLARED_MODEL_WORK_DOMAIN_OR_CLOCK_MISMATCH');
  if (declared.parties.length !== 4 || declared.parties.some(p => p.types.length !== 3) || declared.outcomes.length !== 3)
    throw Error('R3_COMPLETE_FOUR_PARTY_PROFILE_REQUIRED');
  const incumbent = await readEnterpriseContingentPolicy(ctx, request.incumbentPolicyRef);
  if (request.incumbentPolicyRef.version !== 's4-finite-contingent-v1') throw Error('R3_ORIGINAL_NUMERIC_S4_MANDATE_REFERENCE_REQUIRED');
  if (!same(incumbent.mandateRef, declared.mandateRef) || incumbent.bindings.rightsRef !== declared.rightsRef ||
    !incumbent.bindings.beliefPins.some(pin => same(pin.root, declared.root)) || incumbent.mandate.principalId !== principal(ctx))
    throw Error('R3_ORIGINAL_S4_MANDATE_RIGHTS_OR_ROOT_MISMATCH');
  if (incumbent.mandate.utility.unit !== declared.money.unit || declared.money.unit !== declared.money.currency ||
    declared.money.ownerId !== principal(ctx) ||
    !same(declared.money.ownerPeriodMultipliers,incumbent.mandate.utility.discountFactors.map(v=>r3FromDecimal(String(v)).json())))
    throw Error('R3_ORIGINAL_OWNER_UTILITY_MONEY_MEANING_REQUIRED');
  if (declared.objective.kind !== 'MAXIMIN' || incumbent.mandate.ambiguity.kind !== 'ROBUST_FIXED_JOINT_SCENARIOS' ||
    !same(declared.objective.minimumValue, r3FromDecimal(String(incumbent.mandate.risk.minimumUtility)).json()) ||
    !same(declared.objective.normalization, r3FromDecimal(String(incumbent.mandate.scoring.normalization)).json()))
    throw Error('R3_ORIGINAL_OWNER_OBJECTIVE_RISK_AND_NORMALIZATION_REQUIRED');
  await authorizeBeliefResources(ctx, declared.parties.map(p => ({ type: p.entityType, id: p.entityId })));
  const unresolved=await tx(ctx,async c=>(await c.query("SELECT count(*)::int n FROM finnor_os.business_effects WHERE tenant_id=$1 AND status NOT IN('verified','cancelled','compensated')",[ctx.auth.tenantId])).rows[0].n,true);
  if(unresolved)throw Error('R3_NATIVE_UNKNOWN_OBLIGATION_REQUIRES_S6_EXACT_RESOURCE_ACCOUNTING');
  const [resource, partySourceIds, allocationState, [runtime, code, schemaDigest]] = await Promise.all([
    r3ResourceInput(ctx, incumbent.mandate),
Promise.all(declared.parties.map(async p => {
    if (p.sourceRef.owner !== 'S1' || p.rightsRef !== declared.rightsRef)
      throw Error('R3_PARTY_VALUATION_OUTSIDE_OPTION_SOURCE_AND_RIGHTS_REQUIRED');
    const parent = await tx(ctx, async c => (await c.query(
      'SELECT source_id FROM finnor_os.evidence_source_versions WHERE tenant_id=$1 AND id=$2',
      [ctx.auth.tenantId, p.sourceRef.id])).rows[0], true);
    if (!parent) throw Error('R3_PARTY_ORIGINAL_PREFERENCE_SOURCE_UNAVAILABLE');
    const original = await readSourceObject(ctx, declared.root, parent.source_id, p.sourceRef.id);
    const { sourceRef: _source, assumptionRef: _assumption, rightsRef: _rights, ...partyMeaning } = p;
    if (original.content_hash !== p.sourceRef.contentDigest ||
      !same(JSON.parse(original.content), { schema: 'finnor.r3.party-preference.v1', party: partyMeaning }))
      throw Error('R3_PARTY_ORIGINAL_VALUATION_OUTSIDE_OPTION_BYTES_MISMATCH');
    return parent.source_id as string;
  })),
    readValidatedNumericEnterpriseAllocation(ctx, request.budget_grant_ref),
    Promise.all([r3RuntimeIdentity(), codeIdentity(), schemaIdentity(ctx)]),
  ]);
  if(resource.snapshot.resources.some(r=>!r.permittedRoots.some(root=>same(root,declared.root))))
    throw Error('R3_ORIGINAL_S5_PERMITTED_ROOT_REQUIRED');
  const grant = allocationState.issued;
  if (!grant.reservation || allocationState.validation.status !== 'CURRENT' ||
    grant.certificate.principalId !== principal(ctx)) throw Error('R3_ACTUAL_CURRENT_S5_COMPUTE_GRANT_REQUIRED');
  const options = grant.problem.resources.filter(r => r.resourceClass === 'COMPUTE' && r.unit === 'invocation' && r.kind === 'CUMULATIVE_EXPENDITURE');
  if (options.length !== 1) throw Error('R3_EXACT_COMPUTE_INVOCATION_RESOURCE_REQUIRED');
  const compute = options[0]!, envelope = grant.reservation.envelopes.find(e => e.resourceId === compute.resourceId);
  if (!envelope || !same(envelope.horizon, compute.horizon)) throw Error('R3_COMPUTE_GRANT_ENVELOPE_REQUIRED');
  const capacity = envelope.quantities.map(ledger).reduce((a, b) => a.add(b), R3_ZERO);
  if (capacity.d !== 1n || capacity.n < 2n || capacity.n > 1000000n) throw Error('R3_INTEGRAL_NATIVE_INVOCATION_ALLOWANCE_REQUIRED');
  if (Date.parse(request.limits.deadlineAt) > Date.now() + 3600000 ||
    Date.parse(request.limits.deadlineAt) > Date.parse(grant.certificate.validUntil) || Date.parse(request.limits.deadlineAt) <= Date.now())
    throw Error('R3_ORIGINAL_GRANT_DEADLINE_CANNOT_BE_EXTENDED');
  const keys = ['rights:tenant', `work-inputs:${work.id}`, `evidence:${source.source_id}`, `source-version:${source.id}`,
    `r3:plan:${work.id}`, `r3:reservation:${grant.reservation.ref.id}`,
    `r3:preference:${source.source_id}`, `r3:outside-option:${source.source_id}`, `r3:domain:${declared.domainRef.id}`,
    `r3:mandate:${declared.mandateRef.id}`, `r3:payment-contract:${declared.paymentContractRef.id}`,
    `r3:method:${runtime.digest}`, `r3:checker:${runtime.checkerDigest}`,
    ...declared.parties.flatMap(p => [`canonical:${p.entityType}:${p.entityId}`, `source-version:${p.sourceRef.id}`]),
    ...partySourceIds.map(id => `evidence:${id}`),
    ...resource.snapshot.resources.map(r => `r3:resource:${r.resourceId}`)];
  const programDependencies = request.programTarget
    ? await resolveR3ProgramTarget(ctx, request.programTarget, work, request.incumbentPolicyRef) : [];
  const dependencyMap = new Map<string, EvidenceDependency>();
  for (const dependency of [...programDependencies, ...await revisions(ctx, keys)]) {
    const previous = dependencyMap.get(dependency.key);
    if (previous && previous.revision !== dependency.revision) throw Error('R3_PROGRAMME_AND_RULE_DEPENDENCY_CUT_MISMATCH');
    dependencyMap.set(dependency.key, dependency);
  }
  const dependencies = [...dependencyMap.values()].sort((a, b) => a.key.localeCompare(b.key)), validUntil = new Date(Math.min(Date.parse(declared.validUntil),
    Date.parse(incumbent.validUntil), Date.parse(grant.certificate.validUntil), ...resource.snapshot.resources.map(r => Date.parse(r.validUntil)))).toISOString();
  const { schema: _schema, workId: _workId, workRevision: _revision, root: _root, mandateRef: _mandate,
    domainRef: _domain, paymentContractRef: _payment, rightsRef: _rights, asOf: _asOf, validUntil: _until,
    provenance: _provenance, behavioralQualification: _qualification, permittedReporting: _reporting, ...mathematics } = declared;
  const problem = parseR3Problem({ ...mathematics, schema: 'finnor.r3.problem.v1', resources: resource.resources, covenants: resource.covenants,
    mandateLimits: { dimensions: incumbent.mandate.resources.dimensions.map(d => ({
      resourceId: d.id, unit: d.unit, totalLimit: r3FromDecimal(String(d.totalLimit)).json(), capacity: r3FromDecimal(String(d.capacity)).json(),
    })), couplings: incumbent.mandate.resources.couplings.map(c => ({ id: c.id,
      weights: Object.fromEntries(Object.entries(c.weights).map(([key, value]) => [key, r3FromDecimal(String(value)).json()])),
      maximum: r3FromDecimal(String(c.maxPerPeriod)).json(),
    })) },
    binding: { tenantId: ctx.auth.tenantId, principalId: principal(ctx), workId: work.id, workRevision: work.inputId, workDigest: work.inputDigest,
      root: declared.root, preferenceRef: { owner: 'S1', id: source.id, version: 'evidence-source-version-v1', contentDigest: source.content_hash },
      mandateRef: declared.mandateRef, domainRef: declared.domainRef, paymentContractRef: declared.paymentContractRef, rightsRef: declared.rightsRef,
      backendDigest: runtime.digest, checkerDigest: runtime.checkerDigest, producerDigest: runtime.producerDigest,
      schemaDigest, sourceManifestDigest: code.digest,
      ...(request.programTarget ? { programTarget: request.programTarget } : {}) } });
  // Supplied outcome/resource schedules must fit the ORIGINAL S4 authorization,
  // not merely the shared capacity registry. No float projection is installed.
  for (const outcome of problem.outcomes) for (const dimension of incumbent.mandate.resources.dimensions) {
    const matched = resource.snapshot.resources.find(r => r.resourceId === dimension.id && r.unit === dimension.unit && r.resourceClass === dimension.resourceClass);
    if (!matched || !outcome.demands[matched.resourceId]) throw Error('R3_EXPLICIT_S4_S5_DIMENSION_BINDING_REQUIRED');
  }
  return { problem, binding: { work, plan: { id: plan.id, semanticHash: plan.semanticHash, workInputId: plan.workInputId },
    source: { sourceId: source.source_id, versionId: source.id, contentDigest: source.content_hash,
    versionNumber: Number(source.version_number) }, incumbentPolicyRef: incumbent.ref, mandate: incumbent.mandate,
    resourceSnapshotDigest: resource.snapshot.snapshotDigest, resourceRefs: resource.snapshot.resources.map(r => r.ref), dependencies,
    codeDigest: code.digest, schemaDigest, runtimeDigest: runtime.digest, validUntil,
    grant: { ref: request.budget_grant_ref, reservationRef: grant.reservation.ref, resourceId: compute.resourceId,
      resourceRef: compute.ref, capacity: Number(capacity.n), envelope, validUntil: grant.certificate.validUntil } } };
}
export async function assertR3Current(ctx: PeMutationContext, row: R3RequestRow, c?: PoolClient, lock = false, allowOwnReservation = false) {
  if (['CANCELLED','INVALIDATED'].includes(row.status)) throw Error('R3_INVALIDATED_FUTURE_USE_RESPONSIBILITIES_RETAINED');
  const binding = row.binding;
  await authorizeBeliefResources(ctx, [{ type: row.problem.binding.root.entityType, id: row.problem.binding.root.entityId }, { type: 'work', id: row.work_id }]);
  await assertDependencies(ctx, binding.dependencies, c, lock);
  const source = await readSourceObject(ctx, row.problem.binding.root, binding.source.sourceId, binding.source.versionId);
  if (source.content_hash !== binding.source.contentDigest) throw Error('R3_PREFERENCE_OUTSIDE_OPTION_OR_EVENT_SOURCE_CHANGED');
  await Promise.all(row.problem.parties.map(async party => {
    const sourceId = await tx(ctx, async client => (await client.query(
      'SELECT source_id FROM finnor_os.evidence_source_versions WHERE tenant_id=$1 AND id=$2',
      [row.tenant_id, party.sourceRef.id])).rows[0]?.source_id, true);
    if (!sourceId) throw Error('R3_PARTY_ORIGINAL_PREFERENCE_SOURCE_UNAVAILABLE');
    const original = await readSourceObject(ctx, row.problem.binding.root, sourceId, party.sourceRef.id);
    if (original.content_hash !== party.sourceRef.contentDigest)
      throw Error('R3_PARTY_VALUATION_OR_OUTSIDE_OPTION_SOURCE_CHANGED');
  }));
  const [work, plan, incumbent, code, schema, runtime] = await Promise.all([
    resolveDecisionWork(ctx, row.work_id), activeWorkPlanRevision(ctx.auth.tenantId, row.work_id),
    readEnterpriseContingentPolicy(ctx, binding.incumbentPolicyRef), codeIdentity(), schemaIdentity(ctx), r3RuntimeIdentity(),
  ]);
  if (!same(work, binding.work)) throw Error('R3_CURRENT_WORK_IDENTITY_OR_REVISION_CHANGED');
  if (!plan || plan.id !== binding.plan.id || plan.workInputId !== binding.plan.workInputId || plan.semanticHash !== binding.plan.semanticHash)
    throw Error('R3_CURRENT_ORIGINAL_WORK_PLAN_CHANGED');
  if (!same(incumbent.mandate, binding.mandate)) throw Error('R3_ORIGINAL_OWNER_MANDATE_CHANGED');
  if (code.digest !== binding.codeDigest || schema !== binding.schemaDigest ||
    runtime.digest !== binding.runtimeDigest) throw Error('R3_METHOD_CHECKER_SCHEMA_OR_RUNTIME_CHANGED');
  if (Date.now() >= Date.parse(binding.validUntil)) throw Error('R3_ORIGINAL_OWNER_VALIDITY_EXPIRED');
  if (!c && !allowOwnReservation && (await readAllocationSnapshot(ctx)).snapshotDigest !== binding.resourceSnapshotDigest)
    throw Error('R3_SHARED_RESOURCE_OR_OUTSTANDING_RESERVATION_CHANGED');
  const check = async (client: PoolClient) => {
    await r3Authorize(ctx, client, lock);
    if (row.problem.binding.programTarget)
      await assertR3ProgramTarget(ctx, row.problem.binding.programTarget, binding.work, client, lock);
    if (lock) await client.query('SELECT id FROM finnor_os.works WHERE tenant_id=$1 AND id=$2 FOR SHARE', [row.tenant_id, row.work_id]);
    const latest = (await client.query('SELECT id::text FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',
      [row.tenant_id, row.work_id])).rows[0];
    if (latest?.id !== row.work_input_id) throw Error('R3_ORIGINAL_WORK_PUBLICATION_FENCED');
    const current = (await client.query('SELECT status,revocation_reason,envelopes FROM finnor_os.s5_reservations WHERE tenant_id=$1 AND reservation_id=$2' + (lock ? ' FOR SHARE' : ''),
      [row.tenant_id, binding.grant.reservationRef.id])).rows[0];
    if (!current || current.status === 'RELEASED' || current.revocation_reason ||
      !same(current.envelopes.find((e: { resourceId: string }) => e.resourceId === binding.grant.resourceId), binding.grant.envelope))
      throw Error('R3_ORIGINAL_S5_GRANT_PUBLICATION_FENCED');
    const head = (await client.query('SELECT content_digest FROM finnor_os.s5_resources r JOIN finnor_os.s5_resource_heads h USING(tenant_id,resource_id,revision) WHERE r.tenant_id=$1 AND r.resource_id=$2' +
      (lock ? ' FOR SHARE OF h,r' : ''), [row.tenant_id, binding.grant.resourceId])).rows[0];
    if (head?.content_digest !== binding.grant.resourceRef.contentDigest) throw Error('R3_COMPUTE_RESOURCE_PUBLICATION_FENCED');
    if (!allowOwnReservation) {
      const resources = (await client.query('SELECT r.body FROM finnor_os.s5_resources r JOIN finnor_os.s5_resource_heads h USING(tenant_id,resource_id,revision) WHERE r.tenant_id=$1 ORDER BY r.resource_id LIMIT 17', [row.tenant_id])).rows.map(r=>r.body as AllocationResource);
      if (resources.length !== binding.resourceRefs.length || resources.some(r=>!binding.resourceRefs.some(ref=>same(ref,r.ref))))
        throw Error('R3_ORIGINAL_RESOURCE_HEAD_PUBLICATION_FENCED');
    }
  };
  if (c) await check(c); else await tx(ctx, check, !lock);
}
