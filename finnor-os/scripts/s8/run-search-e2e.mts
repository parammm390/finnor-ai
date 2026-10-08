/** Real native S5 input → bounded process methods → independent Fraction oracle. */
import { strict as assert } from 'node:assert';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { byteDigest, digest, type AllocationMethod, type EvaluationProtocol, type LifecycleCost, makeRef } from '../../packages/capability-evolution/src/contracts';
import { runAllocationMethodProcess } from '../../packages/capability-evolution/src/search-process';
import { produceAllocationCandidate } from '../../packages/epistemic-runtime/src/allocation-producer';
import { summarizeAdmission, type ScoredCase } from '../../packages/capability-evolution/src/evaluation';
const inputPath = process.env.FINNOR_S8_NATIVE_OWNER_EVIDENCE;
if (!inputPath)
    throw Error('FRESH_NATIVE_S5_OWNER_EVIDENCE_REQUIRED');
if (process.env.FINNOR_S8_CONSUMER_CONFIG)
    throw Error('FIXED_BASELINE_REQUIRES_UNCHANGED_NATIVE_ROUTE');
const source = JSON.parse(await readFile(inputPath, 'utf8')), problem = source.issued.problem, out = resolve(process.env.FINNOR_S8_EVIDENCE_DIR ?? '../scope-8/scope-evidence/search-initial');
await mkdir(out, { recursive: true });
const paths = (await readdir('packages/capability-evolution/src')).filter(p => /\.(ts|mts)$/.test(p)).map(p => resolve('packages/capability-evolution/src', p)).concat(['scripts/s5/reference.py', 'packages/epistemic-runtime/src/allocation-producer.ts', 'packages/epistemic-runtime/src/allocation-checker.ts', 'scripts/s8/run-search-e2e.mts', 'package-lock.json'].map(p => resolve(p)));
const snapshot = () => Promise.all(paths.map(async (path) => ({ path, sha256: byteDigest(await readFile(path)) }))), before = await snapshot(), results: any[] = [], startedAt = new Date().toISOString();
const python = process.env.FINNOR_S5_PYTHON;
if (!python)
    throw Error('PINNED_INDEPENDENT_REFERENCE_RUNTIME_REQUIRED');
const independent = spawnSync(python, ['scripts/s5/reference.py'], { input: JSON.stringify(problem), encoding: 'utf8', env: { PATH: process.env.PATH, OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1' }, timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
assert.equal(independent.status, 0, independent.stderr);
const reference = JSON.parse(independent.stdout), fixed = await produceAllocationCandidate(problem, performance.now() + 30000);
assert.equal(fixed.status, 'FEASIBLE');
for (const algorithm of ['ENUMERATE_EXACT', 'BRANCH_BOUND_EXACT'] as const)
    for (const order of ['CANONICAL', 'VALUE_IMPACT'] as const)
        for (const incumbent of ['FIRST_FEASIBLE', 'EMPTY_THEN_SEARCH'] as const) {
            const payload: AllocationMethod = { schema: 'finnor.s8.allocation-method.v1', algorithm, order, incumbent, maxPolicies: 8, maximumNodes: 511 };
            let observed: any;
            try {
                observed = await runAllocationMethodProcess(problem, payload, { deadlineAt: performance.now() + 30000, maxExpansions: 511 });
                assert.equal(observed.complete, true);
                assert.equal(observed.objective, reference.exact.optimum);
                assert.equal(observed.check.feasible, true);
                const witness = reference.exact.rows.find((row: any) => row.selected.slice().sort().join('|') === observed.selectedPolicyIds.slice().sort().join('|'));
                assert(witness?.feasible);
                assert.equal(witness.value, observed.objective);
                results.push({ id: algorithm + ':' + order + ':' + incumbent, status: 'PASS', input: payload, observed, independentSelectedValue: witness.value });
            }
            catch (error) {
                results.push({ id: algorithm + ':' + order + ':' + incumbent, status: 'FAIL', input: payload, observed, error: String(error) });
            }
        }
const exhausted = await runAllocationMethodProcess(problem, { schema: 'finnor.s8.allocation-method.v1', algorithm: 'BRANCH_BOUND_EXACT', order: 'VALUE_IMPACT', incumbent: 'EMPTY_THEN_SEARCH', maxPolicies: 8, maximumNodes: 1 }, { deadlineAt: performance.now() + 30000, maxExpansions: 1 });
assert.equal(exhausted.complete, false);
assert.equal(exhausted.status, 'SEARCH_EXHAUSTED');
assert.equal(exhausted.upperBound, null);
// The protected lifecycle's signature acceptance controls are a separate test.
// This numerical comparison reports equality against the strongest fixed exact
// baseline, unmetered dollars, and therefore no qualified future-value gain.
const groups = ['native-generated-company'], caseCommitment = digest(problem), revisionRef = makeRef('capability-revision', { payload: results.at(-1).input });
const protocol: EvaluationProtocol = { schema: 'finnor.s8.evaluation-protocol.v1', tenantId: problem.tenantId, principalId: problem.principalId, revisionRef, evaluatorId: 'GENERATED_REFERENCE_EVALUATOR', registeredAt: startedAt, trainingCutoff: startedAt, domain: { owner: 'S5', interface: 's5-joint-finite-v1', maxPolicies: 8, maxPeriods: 8, maxScenarios: 8, strata: ['coupled'], rightsRef: problem.mandate.rightsRef, validAfter: startedAt, validUntil: problem.validUntil }, caseCommitments: [caseCommitment, digest('second-dependent-episode')], companies: ['generated-arithmetic-control-0', 'generated-arithmetic-control-1'], dependenceGroups: ['g0', 'g1'], chronologicalStart: startedAt, chronologicalEnd: new Date().toISOString(), strata: ['coupled'], priorDomains: [], baselines: ['INCUMBENT', 'STRONG_FIXED', 'INDEPENDENT_EVOLUTION'].map(kind => ({ id: kind, kind: kind as any, payloadDigest: digest(kind), dependencyDigest: digest(before), resourceEnvelopeDigest: digest(problem.mandate.search) })), scoringAssetsDigest: digest(reference), harnessDigest: digest(before), splitDigest: digest(groups), oracle: 'EXACT_CANONICAL_REFERENCE', materialGain: 0.01, scoreRange: 100, confidence: 0.95, maxSubmissions: 8, maxWaves: 2, minIndependentGroups: 2, floors: { correctness: 0.95, regret: 0.05, calibrationError: 0.02, safetyViolations: 0, maxEpisodeCost: 100, maxHumanSeconds: 900 }, feedback: 'FINAL_AGGREGATE_ONLY_ONE_USE', horizon: 'H1', costAllocation: 'COMPLETE_INCURRED_COST_NO_SPECULATIVE_REUSE' };
const metrics = { correctness: 1, regret: 0, calibrationError: 0, safetyViolations: 0, episodeCost: 0, humanSeconds: 0, decisionValue: [32, 32] as [
        number,
        number
    ] }, rows: ScoredCase[] = protocol.caseCommitments.map((caseCommitment, i) => ({ caseCommitment, company: 'generated-arithmetic-control-' + i, dependenceGroup: 'g' + i, stratum: 'coupled', priorDomain: null, candidate: metrics, baselines: Object.fromEntries(protocol.baselines.map(b => [b.id, metrics])), failure: null }));
const unknownCosts: LifecycleCost = { search: null, training: null, evaluation: null, human: null, computeData: null, integration: null, maintenance: null, recovery: null, deployment: null, costRefs: [], currency: 'USD', basis: 'UNKNOWN' };
const admission = summarizeAdmission(protocol, rows, unknownCosts, digest(results), 0);
assert.equal(admission.disposition, 'INCONCLUSIVE');
assert.equal(admission.gain, null);
const forgettingRows = structuredClone(rows);
forgettingRows[1]!.candidate.correctness = 0;
const forgetting = summarizeAdmission(protocol, forgettingRows, unknownCosts, digest(results), 0);
assert.equal(forgetting.disposition, 'REJECTED');
assert.equal(forgetting.allFloorsPassed, false);
const after = await snapshot(), unchanged = digest(before) === digest(after);
await writeFile(join(out, 'results.json'), JSON.stringify({ schema: 'finnor.s8.search-e2e.v1', startedAt, finishedAt: new Date().toISOString(), inputPath, problemRef: problem.ref, inputDigest: digest(problem), results, independentReference: { sourceDigest: before.find(s => s.path.endsWith('/reference.py'))!.sha256, output: reference }, fixedBaseline: fixed, exhausted, admission, forgetting, before, after, sourcesUnchanged: unchanged, qualification: 'GENERATED_NATIVE_CANONICAL_ALLOCATION_NUMERICAL_CORRECTNESS_ONLY. TWO_SCORING_CONTROL_ROWS_ARE_NOT_INDEPENDENT_COMPANY_TRIALS. NO_STATISTICAL_TRANSFER_OR_POSITIVE_FUTURE_GAIN_CLAIM', economicGainEstablished: false, frontierExtensionEstablished: false, costs: 'UNKNOWN', rerun: 'FINNOR_S5_PYTHON=<pinned-python> FINNOR_S8_NATIVE_OWNER_EVIDENCE=<fresh-s5-owner-and-reference.json> FINNOR_S8_EVIDENCE_DIR=<fresh-dir> node --import=tsx scripts/s8/run-search-e2e.mts' }, null, 2) + '\n');
process.exitCode = results.some(r => r.status === 'FAIL') || !unchanged ? 1 : 0;
console.log(JSON.stringify({ out, passed: results.filter(r => r.status === 'PASS').length, failed: results.filter(r => r.status === 'FAIL').length, sourcesUnchanged: unchanged, admission: admission.disposition }));
