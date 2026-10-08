import { compileUnderwritingModel } from '../../../underwriting/src/compiler';
import { executeUnderwritingModel } from '../../../underwriting/src/executor';
import { sealInputSnapshot } from '../../../underwriting/src/snapshot';
import { runAllocationMethod } from '../../../capability-evolution/src/search';
import { fault, hash, type Candidate, type InputArtifact } from './contracts';
import { runFinancingFixture } from './fixture';
import { simulateJointKernel } from './simulation';

/** Fixed native algorithms; caller never supplies source, shell, path or URL. */
export async function runProgramme(input: InputArtifact, invocationDigest: string, stateDirectory: string): Promise<Candidate> {
  let result: Record<string, any>, state: Record<string, any> | null = null;
  switch (input.programme.id) {
    case 'public-allocation': result = publicAllocation(input.payload); break;
    case 'underwriting': result = executeUnderwritingModel(compileUnderwritingModel(input.payload.model), sealInputSnapshot(input.payload.snapshot), input.payload.scenario); break;
    case 'allocation': result = runAllocationMethod(input.payload.problem, { schema: 'finnor.s8.allocation-method.v1', algorithm: 'ENUMERATE_EXACT', order: 'CANONICAL', incumbent: 'EMPTY_THEN_SEARCH', maxPolicies: 20, maximumNodes: 2097151 }, { deadlineAt: performance.now() + 25000, maxExpansions: 2097151 }); break;
    case 'financing': {
      const fixture = await runFinancingFixture(input.payload.state, input.payload.steps, stateDirectory, input.payload.restored === true);
      result = fixture.result; state = fixture.state; break;
    }
    case 's3-kernel': result = simulateJointKernel(input.payload); break;
    case 's6-observation': result = structuredClone(input.payload.observation); break;
    case 'm1-underwriting':
      result = { schema: 'finnor.p3.m1-native-replay.v1', sliceRef: input.source.kind === 'm1' ? input.source.sliceRef : null,
        run: executeUnderwritingModel(compileUnderwritingModel(input.payload.model), sealInputSnapshot(input.payload.snapshot)),
        unresolvedCoverage: input.payload.unresolvedCoverage, projectionSupport: input.payload.projectionSupport,
        executionAuthorityGranted: false }; break;
    default: return fault('UNREGISTERED_PROGRAMME', 400);
  }
  return { schema: 'finnor.branch-candidate.v1', invocationDigest, result, state };
}
/** Real existing decimal underwriting compiler/executor, then finite public enumeration.
 * Payoffs are supplied separately by the immutable public fixture, never inferred. */
function publicAllocation(p: Record<string, any>) {
  if (p.schema !== 'finnor.public-allocation-input.v1' || p.programmes.length !== 3) fault('PUBLIC_FIXTURE_DOMAIN_MISMATCH');
  const { equity, leverageTenths, reserve } = p.parameters;
  const rows = p.programmes.map((r: any) => {
    const m: any = { schemaVersion: 'underwriting-model-ir.v1', modelKey: `p3-${r.id.toLowerCase()}`, modelVersion: '1', financialConventionVersion: 'finnor-pe-lbo/1.0.0', minimumEngineVersion: 'finnor-underwriting-engine/1.0.0', periodDefinition: { frequency: 'annual', forecastStart: '2026-01-01', count: 1 }, circularBlocks: [], nodes: [] };
    for (const [id, value, unit] of [['ev', r.enterpriseValue, 'money'], ['ebitda', r.ebitda, 'money'], ['cap', r.debtCap, 'money'], ['leverage', leverageTenths / 10, 'multiple']] as const)
      m.nodes.push({ id, kind: 'input', valueType: 'decimal', unit, ...(unit === 'money' ? { currency: 'USD' } : {}), shape: 'scalar', dependencies: [], required: true });
    m.nodes.push(
      { id: 'debt.limit', kind: 'expression', valueType: 'decimal', unit: 'money', currency: 'USD', shape: 'scalar', dependencies: ['ebitda', 'leverage'], expression: { op: 'multiply', args: [{ op: 'ref', nodeId: 'ebitda' }, { op: 'ref', nodeId: 'leverage' }] } },
      { id: 'debt', kind: 'expression', valueType: 'decimal', unit: 'money', currency: 'USD', shape: 'scalar', dependencies: ['cap', 'debt.limit'], expression: { op: 'min', args: [{ op: 'ref', nodeId: 'cap' }, { op: 'ref', nodeId: 'debt.limit' }] } },
      { id: 'equity', kind: 'expression', valueType: 'decimal', unit: 'money', currency: 'USD', shape: 'scalar', dependencies: ['ev', 'debt'], expression: { op: 'subtract', args: [{ op: 'ref', nodeId: 'ev' }, { op: 'ref', nodeId: 'debt' }] } },
      { id: 'required.equity', kind: 'output', sourceNodeId: 'equity', valueType: 'decimal', unit: 'money', currency: 'USD', shape: 'scalar', dependencies: ['equity'] });
    const compiled = compileUnderwritingModel(m);
    const values = Object.fromEntries(m.nodes.filter((n: any) => n.kind === 'input').map((n: any) => [n.id, { nodeId: n.id, valueType: 'decimal', unit: n.unit, ...(n.currency ? { currency: n.currency } : {}), shape: 'scalar', value: String(({ ev: r.enterpriseValue, ebitda: r.ebitda, cap: r.debtCap, leverage: leverageTenths / 10 } as any)[n.id]), truthClass: 'MODEL_PARAMETER', status: 'KNOWN', provenance: [{ kind: 'model_parameter', id: `public:${r.id}:${n.id}`, semanticHash: hash(r) }] }]));
    const snapshot = sealInputSnapshot({ schemaVersion: 'underwriting-input-snapshot.v1', investmentCaseId: 'public-allocation-abc-v1', worldAt: '2026-01-01T00:00:00.000Z', values } as any);
    const run = executeUnderwritingModel(compiled, snapshot);
    if (run.status !== 'SUCCEEDED' || run.validity !== 'VALID') fault('PUBLIC_NATIVE_UNDERWRITING_FAILED');
    return { id: r.id, requiredEquity: String(run.outputs['required.equity']!.value), payoff: r.registeredNetPayoff, nativeRun: run };
  });
  let best: string[] = [], value = 0;
  const candidates = [];
  for (let mask = 0; mask < 8; mask++) {
    const selected = rows.filter((_: unknown, i: number) => mask & (1 << i));
    const required = selected.reduce((n: number, r: any) => n + Number(r.requiredEquity), 0), payoff = selected.reduce((n: number, r: any) => n + r.payoff, 0);
    const feasible = required <= equity - reserve && equity - reserve >= 0;
    candidates.push({ ids: selected.map((r: any) => r.id), requiredEquity: String(required), payoff, feasible });
    if (feasible && payoff > value) { best = selected.map((r: any) => r.id); value = payoff; }
  }
  return { schema: 'finnor.public-allocation-output.v1', selected: best, registeredPayoff: value, availableEquity: equity - reserve, rows, candidates, qualification: p.qualification, executionAuthorityGranted: false };
}
