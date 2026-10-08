import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { actor } from './store';
import { BranchFault, bytesHash, fault, hash, type Prepare } from './contracts';
import type { PinnedProducerPort } from './ports';
import { assertP4CheckDomain } from './p4-check';
import { compileUnderwritingModel } from '../../../underwriting/src/compiler';
import type { TenantContext } from '@finnor/shared-types';

const mutation = (ctx: TenantContext) => ({ auth: ctx, provenance: { sourceSystem: 'P3:authentic-producer-acquisition', createdBy: actor(ctx) } });
const upstream = async <T>(owner: 'P4' | 'M1', invoke: () => Promise<T>): Promise<T> => {
  try { return await invoke(); }
  catch (error) {
    if (error instanceof BranchFault) throw error;
    if ((error as any)?.code === 'PE_ENTITY_NOT_FOUND' || (error as any)?.code === 'UNAVAILABLE') fault('BRANCH_UNAVAILABLE', 404);
    fault(owner + '_CURRENT_PRODUCER_PREDICATE_UNPASSED');
  }
};
let installation: Promise<PinnedProducerPort[]> | undefined;
/** Finite source-loaded adapters. Missing owners remain unavailable, never mocked. */
export function initializeAuthenticProducerPorts() {
  return installation ??= (async () => {
    const available: PinnedProducerPort[] = [];
    const p4Url = new URL('../evidence-execution/store.ts', import.meta.url).href;
    const m1Url = new URL('../decision-slice/service.ts', import.meta.url).href;
    let p4Present = false, m1Present = false;
    try { await readFile(fileURLToPath(p4Url)); p4Present = true; } catch (e) { if ((e as any).code !== 'ENOENT') throw e; }
    try { await readFile(fileURLToPath(m1Url)); m1Present = true; } catch (e) { if ((e as any).code !== 'ENOENT') throw e; }
    if (p4Present) {
      const p4 = await import(p4Url);
      const sourcesUrl = new URL('../evidence-execution/sources.ts', import.meta.url).href;
      const sources = await import(sourcesUrl), identity = await p4.codeIdentity();
      available.push({ owner: 'P4', schema: 'finnor.evidence-derivation.v1', buildDigest: identity.digest,
        readCurrent: (ctx, request) => upstream('P4', async () => {
          if (request.source.kind !== 'p4') fault('PRODUCER_SOURCE_MISMATCH');
          const d = await p4.currentDerivation(mutation(ctx), request.source.derivationId);
          if (d.schema !== 'finnor.evidence-derivation.v1' || d.tenantId !== ctx.tenantId || d.principalId !== actor(ctx) ||
            d.work.id !== request.workId || hash(d.beliefView.root) !== hash(request.root)) fault('P4_WORK_ROOT_BINDING_MISMATCH', 404);
          if (d.coverage.status !== 'COMPLETE_SELECTED_UNIVERSE' || d.coverage.globalAbsenceClaimsPermitted !== false ||
            d.contradictions.length || !d.result || d.independentChecks.some((c: any) => c.status !== 'PASS') ||
            !d.independentChecks.length || !d.result.outputs[request.source.output]) fault('P4_COMPLETE_SELECTED_CHECKED_OUTPUT_REQUIRED', 424);
          const acquired: Record<string, any[]> = {};
          for (const h of d.sourceHandles) {
            const handle = await sources.loadHandle(mutation(ctx), h.id, d.beliefView.root);
            const loaded = await sources.materializeHandle(mutation(ctx), handle);
            if (loaded.coverage.status !== 'COMPLETE' || loaded.contradictions.length) fault('P4_SOURCE_MATERIALIZATION_INCOMPLETE', 424);
            acquired[h.inputId] = loaded.rows;
          }
          const payload = { schema: 'finnor.p3.p4-materialized-input.v1', derivationId: d.id, program: d.queryProgram,
            sources: acquired, output: request.source.output, expectedOutputs: d.result.outputs };
          assertP4CheckDomain(payload);
          return { payload, ownerBindings: { evidenceDerivation: d, selectedUniverseOnly: true,
            globalAbsenceClaimsPermitted: false, sourceMeaningOwner: 'S1/P4', bothClocks: { validAt: d.validAt, knowledgeAt: d.knowledgeAt },
            producerRef: { owner: 'P4', id: d.id, version: d.code.version, contentDigest: p4.sha(d) },
            upstreamCosts: d.costs, upstreamFunding: d.funding, upstreamAdmission: d.admission } };
        }) });
    }
    if (m1Present) {
      const m1 = await import(m1Url), files = [];
      const budgetUrl = new URL('../decision-slice/budget.ts', import.meta.url).href, budget = await import(budgetUrl);
      for (const name of ['service', 'contracts', 'adapters', 'graph', 'checker', 'store', 'budget', 'context', 'evidence-port', 'consumer', 'handler']) {
        const url = new URL('../decision-slice/' + name + '.ts', import.meta.url);
        files.push({ path: 'decision-slice/' + name + '.ts', sha256: bytesHash(await readFile(fileURLToPath(url))) });
      }
      available.push({ owner: 'M1', schema: 'finnor.decision-slice.v1', buildDigest: hash(files),
        readCurrent: (ctx, request: Prepare) => upstream('M1', async () => {
          if (request.source.kind !== 'm1') fault('PRODUCER_SOURCE_MISMATCH');
          const source = request.source;
          const current = await budget.inM1Episode(30000, () => m1.measuredM1(mutation(ctx), 'P3_CURRENT_SLICE_BINDING', request.workId, 30000,
            () => m1.readCurrentDecisionSlice(mutation(ctx), source.sliceRef)));
          const { slice, binding, publication, projectionInput } = current, e = slice.envelope;
          if (slice.schema !== 'finnor.decision-slice.v1' || hash(slice.ref) !== hash(source.sliceRef) ||
            e.tenantId !== ctx.tenantId || e.principalId !== actor(ctx) || e.work.id !== request.workId ||
            !binding.views.some((v: any) => hash(v.root) === hash(request.root))) fault('M1_WORK_ROOT_BINDING_MISMATCH', 404);
          if (slice.projectionSupport.status !== 'EXACT_DEPENDENCY_PRESERVATION' || !slice.projectionSupport.check.exactPreservation ||
            slice.projectionSupport.check.status !== 'CHECKED' || binding.underwriting.length !== 1 || binding.policies.length ||
            binding.allocation || binding.request.source.kind !== 'UNDERWRITING') fault('M1_DECLARED_NATIVE_BRANCH_DOMAIN_UNSUPPORTED', 424);
          const candidate = binding.underwriting[0], compiled = compileUnderwritingModel(candidate.definition);
          if (compiled.model.runtime || compiled.model.circularBlocks.length || compiled.model.nodes.length > 256 ||
            compiled.periods.length > 24 || Object.values(candidate.input.values).some((v: any) => v.status !== 'KNOWN')) fault('M1_NATIVE_INPUT_NOT_BRANCH_READY', 424);
          return { payload: { model: candidate.definition, snapshot: candidate.input,
            unresolvedCoverage: slice.unresolvedCoverage, projectionSupport: slice.projectionSupport },
            ownerBindings: { decisionSlice: slice, nativeBinding: binding, publication, projectionInput,
              unresolvedCoverage: slice.unresolvedCoverage, projectionLossBudget: slice.projectionLoss,
              mandateRefs: e.mandateRefs, upstreamCosts: e.cost, upstreamAdmission: e.admission,
              wholeEnterpriseStateClaimed: false } };
        }) });
    }
    return available;
  })();
}
