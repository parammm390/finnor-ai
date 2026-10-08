import { readFile } from 'node:fs/promises';
import { assertDisposableDatabaseTarget } from '../../../db/production-target-guard';
import type { TenantContext } from '@finnor/shared-types';
import { decode, fault, hash, PrepareSchema, type Prepare, type InputArtifact } from './contracts';
import { assertProgramme, programmeId, programmeRef } from './registry';
import { actor, tx, workBasis, readArtifact } from './store';
import { baselineState } from './fixture';
import { assertUnderwritingCheckDomain } from './numerical-checks';
import { verifyCheckpoint } from './checkpoint';
import { acquireProducerSource, currentProducerSource } from './ports';
import { branchRemainingMs } from './budget';

export async function prepareInput(ctx: TenantContext, value: unknown): Promise<InputArtifact> {
  branchRemainingMs();
  const p = decode(PrepareSchema, value);
  if (p.profile === 'TRUSTED_NATIVE_H0') {
    if (process.env.NODE_ENV === 'production') fault('NON_ISOLATED_PRODUCTION_REFUSED', 403);
    assertDisposableDatabaseTarget(process.env.DATABASE_URL, 'P3 development profile');
  }
  const basis = await tx(ctx, c => workBasis(c, ctx, p.workId));
  if (['public_fixture', 'financing_fixture'].includes(p.source.kind)) {
    await tx(ctx, async c => {
      if (p.root.entityType !== 'external_organization' || !(await c.query('SELECT id FROM finnor_os.external_organizations WHERE tenant_id=$1 AND id=$2', [ctx.tenantId, p.root.entityId])).rows.length) fault('PERMITTED_BRANCH_UNAVAILABLE', 404);
    });
  }
  const { payload, ownerBindings } = await acquireSource(ctx, p);
  const programme = await programmeRef(programmeId(p.source.kind));
  const input: InputArtifact = { schema: 'finnor.branch-input.v1', tenantId: ctx.tenantId, principalId: actor(ctx), root: p.root, kind: p.kind, profile: p.profile, source: p.source, basis, programme, payload, ownerBindings, qualification: p.profile === 'TRUSTED_NATIVE_H0' ? 'NON_ISOLATED_DEVELOPMENT_NO_PROTECTED_ELIGIBILITY' : 'DEVELOPMENT_PROFILE_NOT_S8_ADMITTED' };
  await assertProgramme(input);
  await currentInput(ctx, input);
  return input;
}
async function acquireSource(ctx: TenantContext, p: Prepare): Promise<{ payload: Record<string, any>; ownerBindings: Record<string, any> }> {
  const source = p.source, owner = { auth: ctx };
  if (source.kind === 'p1') fault('PENDING_DEPENDENCY', 424);
  if (source.kind === 'p4' || source.kind === 'm1') {
    if (p.kind !== 'pure') fault('BRANCH_DOMAIN_MISMATCH', 400);
    return acquireProducerSource(ctx, p);
  }
  if (source.kind === 's6_read') {
    if (p.kind !== 'live_read') fault('BRANCH_DOMAIN_MISMATCH', 400);
    const { loadEnterpriseBeliefView } = await import('../enterprise-beliefs');
    const { acquireReviewedObservation } = await import('./live-read');
    const belief = await loadEnterpriseBeliefView(owner, { root: p.root as any });
    const observation = await acquireReviewedObservation(ctx, source.obligationRef, p.root);
    return { ...observation, ownerBindings: { ...observation.ownerBindings, beliefPin: belief.pin, coverage: belief.coverage, rights: belief.rights } };
  }
  if (source.kind === 'public_fixture') {
    const data = JSON.parse(await readFile(new URL('./fixtures/allocation.json', import.meta.url), 'utf8'));
    return { payload: { ...data, parameters: source.parameters }, ownerBindings: { sourceDigest: hash(data), rightsBasis: 'PUBLIC_FIXTURE_PLUS_AUTHENTICATED_WORK_NOT_ENTERPRISE_FACT', coverage: 'COMPLETE_DECLARED_PUBLIC_FIXTURE' } };
  }
  if (source.kind === 'financing_fixture') {
    let state = baselineState();
    if (source.baseline) {
      const cp = await tx(ctx, c => readArtifact<any>(c, ctx, source.baseline!, 'CHECKPOINT'));
      if (cp.schema !== 'finnor.branch-checkpoint-sealed.v2' || cp.binding?.tenantId !== ctx.tenantId ||
        cp.binding?.principalId !== actor(ctx) || cp.kind !== 'application_fixture') fault('PERMITTED_BRANCH_UNAVAILABLE', 404);
      const { head, inputFor } = await import('./store');
      const prior = await tx(ctx, c => head(c, ctx, cp.binding.branchId));
      const priorInput = await inputFor(ctx, prior.input_id);
      if (priorInput.basis.workId !== p.workId || hash(priorInput.root) !== hash(p.root)) fault('CHECKPOINT_ROOT_OR_WORK_CHANGED');
      state = (await verifyCheckpoint(ctx, priorInput, source.baseline)).state as ReturnType<typeof baselineState>;
    }
    return { payload: { state, steps: source.steps }, ownerBindings: { stateDigest: hash(state), coverage: 'COMPLETE_PRIVATE_SYNTHETIC_FIXTURE', externalAuthority: null } };
  }
  const { loadEnterpriseBeliefView } = await import('../enterprise-beliefs');
  const belief = await loadEnterpriseBeliefView(owner, { root: p.root as any });
  if (belief.coverage.canonicalStatus !== 'COMPLETE' || belief.coverage.truncated) fault('SOURCE_COVERAGE_PARTIAL', 409);
  if (source.kind === 'underwriting') {
    const { prepareUnderwritingRun } = await import('../underwriting-repository');
    const run = await prepareUnderwritingRun(owner, source);
    assertUnderwritingCheckDomain(run.compiled.model);
    return { payload: { model: run.compiled.model, snapshot: run.baseSnapshot, ...(run.scenario ? { scenario: run.scenario } : {}) }, ownerBindings: { beliefPin: belief.pin, modelDigest: run.compiled.semanticHash, snapshotDigest: run.baseSnapshot.semanticHash, coverage: belief.coverage, rights: belief.rights } };
  }
  if (source.kind === 'allocation') {
    const { readEnterpriseAllocation, validateEnterpriseAllocation } = await import('../enterprise-allocation');
    if ((await validateEnterpriseAllocation(owner, source.allocationRef)).status !== 'CURRENT') fault('S5_INPUT_NOT_CURRENT');
    const issued = await readEnterpriseAllocation(owner, source.allocationRef);
    return { payload: { problem: issued.problem }, ownerBindings: { beliefPin: belief.pin, allocationRef: source.allocationRef, coverage: belief.coverage, rights: belief.rights, funding: 'COMPUTATION_INPUT_NOT_BRANCH_FINANCIAL_GRANT' } };
  }
  if (source.kind === 's3') {
    const { resolveEnterpriseInterventionModelForControl } = await import('../enterprise-interventions');
    const { createInterventionControlAdapter } = await import('../../../epistemic-runtime/src/intervention-control');
    const model = await resolveEnterpriseInterventionModelForControl(owner, source.modelRef);
    const { context, regime, horizon, pathsPerMechanism, seed } = source;
    const prepared = await createInterventionControlAdapter(model, { context, regime, horizon, pathsPerMechanism, seed }, branchRemainingMs());
    if (!prepared.snapshot || !prepared.adapter) fault('S3_MODEL_DOMAIN_UNSUPPORTED', 424);
    if (Object.keys(source.exposures).sort().join() !== prepared.adapter.exposureIds.slice().sort().join() || Object.values(source.exposures).some(v => v.length !== horizon)) fault('S3_EXPOSURE_DOMAIN_MISMATCH', 400);
    return { payload: { model, snapshot: prepared.snapshot, exposures: source.exposures }, ownerBindings: { beliefPin: belief.pin, modelRef: model.ref, kernelRef: prepared.snapshot.ref, assumptions: model.request.mechanisms, compute: prepared.compute, coverage: belief.coverage, rights: belief.rights } };
  }
  return fault('UNREGISTERED_SOURCE', 400);
}
/** Fresh owner reads on launch, restore, publication and every current consume. */
export async function currentInput(ctx: TenantContext, input: InputArtifact) {
  if (input.tenantId !== ctx.tenantId || input.principalId !== actor(ctx)) fault('PERMITTED_BRANCH_UNAVAILABLE', 404);
  const b = await tx(ctx, c => workBasis(c, ctx, input.basis.workId));
  if (b.dependencyDigest !== input.basis.dependencyDigest) fault('WORK_OR_RIGHTS_INVALIDATED');
  await assertProgramme(input);
  if (input.source.kind === 'p4' || input.source.kind === 'm1') await currentProducerSource(ctx, input);
  if (input.ownerBindings.beliefPin) {
    const { validateBeliefViewPin } = await import('../enterprise-beliefs');
    if ((await validateBeliefViewPin({ auth: ctx }, input.ownerBindings.beliefPin)).status !== 'CURRENT') fault('S1_SOURCE_RIGHTS_INVALIDATED');
  }
  if (input.source.kind === 's3') {
    const { resolveEnterpriseInterventionModelForControl } = await import('../enterprise-interventions');
    await resolveEnterpriseInterventionModelForControl({ auth: ctx }, input.source.modelRef);
  }
  if (input.source.kind === 'allocation') {
    const { validateEnterpriseAllocation } = await import('../enterprise-allocation');
    if ((await validateEnterpriseAllocation({ auth: ctx }, input.source.allocationRef)).status !== 'CURRENT') fault('S5_SOURCE_INVALIDATED');
  }
  if (input.source.kind === 'underwriting') {
    const { prepareUnderwritingRun } = await import('../underwriting-repository');
    const fresh = await prepareUnderwritingRun({ auth: ctx }, input.source);
    if (fresh.compiled.semanticHash !== input.ownerBindings.modelDigest || fresh.baseSnapshot.semanticHash !== input.ownerBindings.snapshotDigest) fault('UNDERWRITING_SOURCE_INVALIDATED');
  }
  if (input.source.kind === 's6_read') {
    const { readEnterpriseDurableObligation } = await import('../enterprise-obligations');
    const obligation = await readEnterpriseDurableObligation({ auth: ctx }, input.source.obligationRef);
    // A current permission to historical history is not a new live observation.
    // Resume/replay does not invoke the reviewed read a second time.
    const { ownerTransportRoute } = await import('../../../governed-execution/src/owner-transport');
    const route = await ownerTransportRoute({ semanticOwner: 'S6', tenantId: ctx.tenantId, principalId: actor(ctx) });
    if (!route || !route.rightsRefs.includes(obligation.rightsRef) || hash({ domain: route.protectionDomain, ledger: route.ledger, originKeys: route.originKeys, rightsRefs: route.rightsRefs }) !== input.ownerBindings.reviewedRouteDigest) fault('S6_READ_AUTHORITY_CHANGED');
  }
}
