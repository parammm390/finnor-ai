import { CandidateSchema, decode, hash, type InputArtifact, type Candidate } from './contracts';
import { checkUnderwriting } from './numerical-checks';
import { verifyCanonicalAllocation, certifyAllocationOptimization } from '../../../epistemic-runtime/src/allocation-checker';
import { checkP4Native } from './p4-check';
/** Separate checker implementation. It does not import/call candidate algorithms. */
export function checkCandidate(input: InputArtifact, value: unknown, invocationDigest: string) {
  const candidate = decode(CandidateSchema, value);
  const assertions: Array<{ id: string; passed: boolean }> = [];
  const check = (id: string, passed: boolean) => assertions.push({ id, passed });
  check('EXACT_INVOCATION', candidate.invocationDigest === invocationDigest);
  const fields: Record<string, string[]> = {
    'public-allocation': ['schema','selected','registeredPayoff','availableEquity','rows','candidates','qualification','executionAuthorityGranted'],
    financing: ['schema','identity','observations','stateDigest','qualification'],
    's3-kernel': ['schema','modelRef','kernelRef','seed','trajectories','supported','reproducibilityTolerance','exactKernelDigest','qualification','limitations','evidenceClass','executionAuthorityGranted'],
    underwriting: ['status','validity','engineVersion','modelSemanticHash','inputSemanticHash','scenarioSemanticHash','values','outputs','checks','solverDiagnostics','sponsorCashFlows','failure','resultSemanticHash'],
    allocation: ['schema','methodDigest','problemRef','selectedPolicyIds','objective','check','complete','status','upperBound','nodes','leaves','pruned','usage','cost','executionAuthorityGranted'],
    's6-observation': ['schema','semanticOwner','operation','obligationRef','sourceDigest','observedAt','knowledgeAt','attempts','observations','settlements','projection','attributionGranted','resourceReleaseGranted','executionAuthorityGranted','replayDispatchesExternalRequest'],
    'p4-finite': ['schema','derivationId','native','output','executionAuthorityGranted'],
    'm1-underwriting': ['schema','sliceRef','run','unresolvedCoverage','projectionSupport','executionAuthorityGranted'],
  };
  check('NO_SELF_AUTHORITY_OR_MATERIAL_FIELDS', candidate.result.executionAuthorityGranted !== true && Object.keys(candidate.result).every(k => fields[input.programme.id]?.includes(k)));
  check('STATE_CLASS_BOUNDARY', input.kind === 'application_fixture' || candidate.state === null);
  let domain = 'PUBLIC_FINITE_ORACLE', complete = true;
  if (input.programme.id === 'public-allocation') {
    const p = input.payload, { equity, reserve, leverageTenths } = p.parameters, out = candidate.result;
    const rows = p.programmes.map((r: any) => {
      const debtTenths = BigInt(r.ebitda) * BigInt(leverageTenths) < BigInt(r.debtCap) * 10n ? BigInt(r.ebitda) * BigInt(leverageTenths) : BigInt(r.debtCap) * 10n;
      return { id: r.id, equityTenths: BigInt(r.enterpriseValue) * 10n - debtTenths, payoff: BigInt(r.registeredNetPayoff) };
    });
    let optimum = -1n, selected: string[] = [];
    for (let mask = 0; mask < 8; mask++) {
      const taken = rows.filter((_: unknown, i: number) => mask & (1 << i));
      if (taken.reduce((s: bigint, r: any) => s + r.equityTenths, 0n) <= BigInt(equity - reserve) * 10n) {
        const v = taken.reduce((s: bigint, r: any) => s + r.payoff, 0n);
        if (v > optimum) { optimum = v; selected = taken.map((r: any) => r.id); }
      }
    }
    check('EXACT_PUBLIC_OPTIMUM', BigInt(out.registeredPayoff as number) === (optimum < 0n ? 0n : optimum) && hash(out.selected) === hash(selected));
    check('COMPLETE_ENUMERATION', Array.isArray(out.candidates) && out.candidates.length === 8 && out.availableEquity === equity - reserve);
    check('NATIVE_DECIMAL_LINEAGE', rows.every((r: any) => {
      const actual = (out.rows as any[])?.find(row => row.id === r.id);
      return actual && actual.nativeRun.status === 'SUCCEEDED' && actual.nativeRun.validity === 'VALID' && Number(actual.requiredEquity) * 10 === Number(r.equityTenths) && actual.nativeRun.inputSemanticHash && actual.nativeRun.modelSemanticHash;
    }));
    check('EXACT_NATIVE_ROW_MEMBERSHIP', Array.isArray(out.rows) && hash((out.rows as any[]).map(r => r.id).sort()) === hash(rows.map((r: any) => r.id).sort()));
    for (const declared of p.programmes) {
      const actual = (out.rows as any[])?.find(row => row.id === declared.id);
      if (!actual) { check('ALL_PUBLIC_ANCESTORS:' + declared.id, false); continue; }
      check('NO_EXTRA_NATIVE_ROW_FIELDS:' + declared.id, Object.keys(actual).sort().join() === 'id,nativeRun,payoff,requiredEquity' && actual.payoff === declared.registeredNetPayoff);
      // Reconstruct the frozen public IR independently, then use BigInt arithmetic
      // for every value/metadata/dependency and the original owner commitments.
      checkUnderwriting(publicOracleInput(declared, leverageTenths), actual.nativeRun, (id, passed) => check(`PUBLIC:${declared.id}:${id}`, passed));
    }
    for (let mask = 0; mask < 8; mask++) {
      const taken = rows.filter((_: unknown, i: number) => mask & (1 << i));
      const expectedEquity = taken.reduce((s: bigint, r: any) => s + r.equityTenths, 0n);
      const expectedPayoff = taken.reduce((s: bigint, r: any) => s + r.payoff, 0n);
      const actual = (out.candidates as any[])?.[mask];
      check('EXACT_SUBSET_CERTIFICATE:' + mask, actual && hash(actual.ids) === hash(taken.map((r: any) => r.id)) && actual.requiredEquity === String(Number(expectedEquity) / 10) && BigInt(actual.payoff) === expectedPayoff && actual.feasible === (equity - reserve >= 0 && expectedEquity <= BigInt(equity - reserve) * 10n));
    }
  } else if (input.programme.id === 'financing') {
    const expected = structuredClone(input.payload.state), s = candidate.state;
    if (!input.payload.restored) expected.visits++;
    for (const step of input.payload.steps) {
      if (expected.effects.some((e: any) => e.id === step.effectId)) continue;
      const row = expected.rows.find((r: any) => r.id === step.target);
      if (!row) { check('EXACT_FIXTURE_TARGET', false); continue; }
      if (step.operation === 'autosave') {
        if (Object.hasOwn(step, 'feeCents')) row.feeCents = step.feeCents;
        if (Object.hasOwn(step, 'memo')) row.memo = step.memo;
      }
      if (step.operation === 'navigate') expected.visits++;
      if (step.operation === 'submit') row.submitted = true;
      expected.effects.push({ id: step.effectId, operation: step.operation, requestDigest: hash(step), response: { effectId: step.effectId, target: step.target, operation: step.operation, outcome: 'FIXTURE_COMMITTED_NOT_S6_SETTLEMENT' } });
      expected.file = `fixture:${step.target}:${step.operation}:${step.effectId}`;
    }
    expected.effects.sort((a: any, b: any) => a.id.localeCompare(b.id));
    check('COMPLETE_PRIVATE_STATE', s !== null && hash(expected) === hash(s));
    check('FIXTURE_DELTA_DIGEST', s !== null && candidate.result.stateDigest === hash(s));
    check('FRESH_IDENTITY', typeof candidate.result.identity === 'string');
  } else if (input.programme.id === 's3-kernel') {
    domain = 'S3_JOINT_KERNEL_DIFFERENTIAL';
    const { snapshot, model, exposures } = input.payload;
    const out = candidate.result, initial = model.history.rows.slice(-3).map((r: any) => ({ states: r.states, exposures: r.exposures }));
    const trajectories = out.trajectories as any[];
    for (const m of snapshot.mechanisms) for (const scenario of m.scenarios) {
      let history = structuredClone(initial);
      for (let period = 0; period < snapshot.request.horizon; period++) {
        const e = Object.fromEntries(Object.entries(exposures).map(([id, a]) => [id, (a as number[])[period]]));
        const atom = (f: any): number => f.kind === 'CONSTANT' ? 1 : f.kind === 'EXPOSURE' && f.lag === 0 ? e[f.id]! : (f.kind === 'STATE' ? history.at(-f.lag)?.states : history.at(-f.lag)?.exposures)?.[f.id];
        const states: Record<string, number> = {};
        m.equations.forEach((eq: any, j: number) => { states[eq.variableId] = eq.features.reduce((sum: number, f: any, i: number) => sum + (f.kind === 'PRODUCT' ? atom(f.left) * atom(f.right) : atom(f)) * scenario.coefficients[j][i], scenario.shocks[period][j]); });
        const actual = trajectories?.[period]?.worlds.find((w: any) => w.id === scenario.id)?.history.at(-1)?.states;
        check(`JOINT_SCENARIO:${scenario.id}:${period}`, actual && Object.keys(states).every(id => Math.abs(actual[id] - states[id]!) <= 1e-8));
        history = [...history.slice(-2), { states, exposures: e }];
      }
    }
    check('MODEL_RELATIVE_ONLY', out.evidenceClass === 'MODEL_RELATIVE' && (out.kernelRef as any)?.contentDigest === snapshot.ref.contentDigest);
    check('OWNER_SUPPORT', out.supported === true);
  } else if (input.programme.id === 'underwriting') {
    ({ domain, complete } = checkUnderwriting(input.payload, candidate.result, check));
  } else if (input.programme.id === 'allocation') {
    domain = 'S5_ORIGINAL_CANONICAL_CONSTRAINT_AND_SUBSET_CERTIFICATE';
    const out = candidate.result, problem = input.payload.problem;
    if (Array.isArray(out.selectedPolicyIds)) {
      const ownerCheck = verifyCanonicalAllocation(problem, out.selectedPolicyIds as string[]);
      check('ORIGINAL_COUPLED_RESOURCE_FEASIBILITY', ownerCheck.feasible && hash(out.check) === hash(ownerCheck) && out.objective === ownerCheck.objective && out.status === 'FEASIBLE' && out.complete === true);
      const proof = certifyAllocationOptimization(problem, out.selectedPolicyIds as string[], { deadlineAt: performance.now() + 4000, searchTermination: 'P3_SEPARATE_CANONICAL_SUBSET_CERTIFICATE', solverUpperBoundEstimate: null }).optimization;
      complete = proof.completeSearch; check('REGISTERED_GLOBAL_OPTIMUM', complete && proof.gapUpperBound === '0' && proof.upperBound === out.upperBound);
    } else { complete = false; check('CANONICAL_FEASIBLE_INCUMBENT', false); }
  } else if (input.programme.id === 'p4-finite') {
    check('P4_ORIGIN', candidate.result.derivationId === input.payload.derivationId);
    ({ domain, complete } = checkP4Native(input.payload, candidate.result, check));
  } else if (input.programme.id === 'm1-underwriting') {
    ({ domain, complete } = checkUnderwriting(input.payload, candidate.result.run as Record<string, any>, check));
    check('M1_EXACT_SLICE_AND_GAPS', hash(candidate.result.sliceRef) === hash(input.source.kind === 'm1' ? input.source.sliceRef : null) &&
      hash(candidate.result.unresolvedCoverage) === hash(input.payload.unresolvedCoverage) && hash(candidate.result.projectionSupport) === hash(input.payload.projectionSupport));
  } else if (input.programme.id === 's6-observation') {
    domain = 'REVIEWED_S6_SIGNED_HISTORY_OBSERVATION_ONLY';
    check('EXACT_REVIEWED_OBSERVATION', hash(candidate.result) === hash(input.payload.observation) && candidate.result.sourceDigest === input.ownerBindings.sourceDigest && candidate.result.replayDispatchesExternalRequest === false);
  } else {
    domain = 'UNREGISTERED_CHECK_DOMAIN'; complete = false;
    check('REGISTERED_INDEPENDENT_CHECK', false);
  }
  return { schema: 'finnor.branch-check.v1', version: 'p3-independent-v1', inputDigest: hash(input), outputDigest: hash(candidate), invocationDigest, domain, assertions, complete, passed: complete && assertions.every(a => a.passed), qualification: 'OUTSIDE_CANDIDATE_PUBLIC_CHECK_NOT_S8_OR_S7_ADMISSION' };
}
function publicOracleInput(row: any, leverageTenths: number) {
  const definitions = [['ev', row.enterpriseValue, 'money'], ['ebitda', row.ebitda, 'money'], ['cap', row.debtCap, 'money'], ['leverage', leverageTenths / 10, 'multiple']] as const;
  const inputs = definitions.map(([id, _value, unit]) => ({ id, kind: 'input', valueType: 'decimal', unit, ...(unit === 'money' ? { currency: 'USD' } : {}), shape: 'scalar', dependencies: [], required: true }));
  const financial = { valueType: 'decimal', unit: 'money', currency: 'USD', shape: 'scalar' };
  const ref = (nodeId: string) => ({ op: 'ref', nodeId });
  const model = { schemaVersion: 'underwriting-model-ir.v1', modelKey: `p3-${row.id.toLowerCase()}`, modelVersion: '1', financialConventionVersion: 'finnor-pe-lbo/1.0.0', minimumEngineVersion: 'finnor-underwriting-engine/1.0.0', periodDefinition: { frequency: 'annual', forecastStart: '2026-01-01', count: 1 }, circularBlocks: [], nodes: [
    ...inputs,
    { id: 'debt.limit', kind: 'expression', ...financial, dependencies: ['ebitda', 'leverage'], expression: { op: 'multiply', args: [ref('ebitda'), ref('leverage')] } },
    { id: 'debt', kind: 'expression', ...financial, dependencies: ['cap', 'debt.limit'], expression: { op: 'min', args: [ref('cap'), ref('debt.limit')] } },
    { id: 'equity', kind: 'expression', ...financial, dependencies: ['ev', 'debt'], expression: { op: 'subtract', args: [ref('ev'), ref('debt')] } },
    { id: 'required.equity', kind: 'output', ...financial, dependencies: ['equity'], sourceNodeId: 'equity' },
  ] };
  const values = Object.fromEntries(definitions.map(([id, value, unit]) => [id, { nodeId: id, valueType: 'decimal', unit, ...(unit === 'money' ? { currency: 'USD' } : {}), shape: 'scalar', value: String(value), truthClass: 'MODEL_PARAMETER', status: 'KNOWN', provenance: [{ kind: 'model_parameter', id: `public:${row.id}:${id}`, semanticHash: hash(row) }] }]));
  return { model, snapshot: { schemaVersion: 'underwriting-input-snapshot.v1', investmentCaseId: 'public-allocation-abc-v1', worldAt: '2026-01-01T00:00:00.000Z', values } };
}
