/** Bounded replay of saved real image HTTP inputs; not a new owner/image receipt. */
import { strict as assert } from 'node:assert';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { compileAllocationMilp } from '../../packages/epistemic-runtime/src/allocation-producer';
import { allocationRef, allocationDecimal, allocationRationalLedgerQuantity } from '../../packages/epistemic-runtime/src/allocation-contracts';
import { verifyCanonicalAllocation } from '../../packages/epistemic-runtime/src/allocation-checker';
import { epistemicHash } from '../../packages/epistemic-runtime/src/source-precedence';
import type { CanonicalAllocationProblem } from '@finnor/shared-types';

const [httpFile, output] = process.argv.slice(2);
assert(httpFile && output && process.env.FINNOR_S5_PYTHON, 'HTTP log, fresh evidence directory and pinned Python required');
const sourceDigests = await Promise.all(['allocation-producer.ts', 'allocation-solver.py', 'allocation-contracts.ts',
  'allocation-checker.ts', 'allocation-resource-check.ts', 'exact-allocation-adapter.ts', 'experiment-numerics.ts']
  .map(async path => ({ path: 'finnor-os/packages/epistemic-runtime/src/' + path,
    sha256: createHash('sha256').update(await readFile(new URL('../../packages/epistemic-runtime/src/' + path, import.meta.url))).digest('hex') })));
await mkdir(output); // Never overwrite a prior failed or successful replay.
const raw = await readFile(httpFile, 'utf8');
const rows = raw.trim().split('\n').map(line => JSON.parse(line));
const clear = rows.find(r => r.path === '/api/allocations/clear');
const policy = rows.find(r => r.path === '/api/policies/synthesize-exact')?.output.policy;
const resources = rows.filter(r => r.path === '/api/allocations/resource').map(r => r.output);
assert(clear && policy && resources.length === 2);
assert.deepEqual(clear.input.policyRefs, [policy.ref]);
assert.deepEqual(clear.input.resourceRefs, resources.map(r => r.ref));
const { mandate, jointModel, demandBindings, funding } = clear.input;
const body = { schema: 'finnor.allocation-problem.v1' as const, tenantId: mandate.tenantId,
  principalId: mandate.principalId, episodeId: mandate.episodeId, mandate, policies: [policy], resources,
  jointModel, demandBindings, funding, outstanding: [], snapshotDigest: epistemicHash({ resources, outstanding: [] }),
  knowledgeAt: clear.at, validUntil: new Date(Math.min(...[mandate, jointModel, policy, ...resources].map(v => Date.parse(v.validUntil)))).toISOString(), methodVersion: 's5-joint-finite-v1' as const,
  quantityEncoding: 'DECIMAL_OR_RATIONAL_V2' as const };
// The owner does not accept outstanding commitments from its request. Bind the
// reconstructed empty snapshot to the actual problem hash retained by the child;
// any omitted commitment or changed input makes this replay fail closed.
const originalRef = clear.output.compute?.inputRef;
assert(originalRef, 'Actual solver problem commitment required');
const begin = Date.parse(clear.at), end = Date.parse(clear.output.compute.attempts[0].startedAt);
assert(Number.isSafeInteger(begin) && Number.isSafeInteger(end) && end >= begin && end - begin <= 30000);
let matched = false;
for (let at = begin; at <= end; at++) {
  body.knowledgeAt = new Date(at).toISOString();
  if (epistemicHash(allocationRef('S5', 'allocation-problem', body)) === epistemicHash(originalRef)) { matched = true; break; }
}
assert(matched, 'Saved issued inputs and empty outstanding snapshot must reconstruct the exact original problem commitment');
const problem: CanonicalAllocationProblem = { ...body, ref: originalRef };
const receipt: any = { schema: 'finnor.s5.image-allocation-replay.v1', status: 'FAIL',
  qualification: 'SAVED_ISSUED_INPUT_REPLAY_NOT_NEW_HTTP_SQL_OR_IMAGE_ACCEPTANCE',
  inputSha256: createHash('sha256').update(raw).digest('hex'), startedAt: new Date().toISOString(),
  sourceDigests, nodeVersion: process.version,
  originalProblemRef: originalRef, reconstructedOriginalProblemCommitment: true,
  rerun: 'FINNOR_S5_PYTHON=<pinned-python> node --import=tsx scripts/s5/replay-image-allocation.mts <saved-http.jsonl> <fresh-output>' };
try {
  const compiled = compileAllocationMilp(problem, 10000);
  await writeFile(join(output, 'compiled-input.json'), JSON.stringify(compiled, null, 2) + '\n');
  const run = spawnSync(process.env.FINNOR_S5_PYTHON!, [resolve('packages/epistemic-runtime/src/allocation-solver.py')], {
    input: JSON.stringify(compiled.input), encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024,
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1' } });
  assert.equal(run.status, 0, String(run.error ?? run.stderr));
  const solved = JSON.parse(run.stdout);
  await writeFile(join(output, 'solver-result.json'), JSON.stringify(solved, null, 2) + '\n');
  assert.equal(solved.status, 'OPTIMAL_NUMERICAL', solved.termination);
  const selected = compiled.policyColumns.filter((_, i) => solved.vector[i] > .5);
  assert.deepEqual(selected, [policy.ref.id]);
  const checked = verifyCanonicalAllocation(problem, selected);
  assert.equal(checked.feasible, true, JSON.stringify(checked.reasons));
  assert.equal(checked.objective, '7');
  assert(checked.envelopes.find(e => e.resourceId === 'capital')!.quantities.includes('r3q:1/3'));
  const coefficients = compiled.input.rows.flatMap(r => Object.values(r.coefficients));
  assert(coefficients.includes('1/3'), 'One third must reach the actual solver without rounding');
  assert(!JSON.stringify(compiled.input).includes('r3q:'));
  const unbound: any = { ...body }; delete unbound.quantityEncoding;
  assert.throws(() => compileAllocationMilp({ ...unbound, ref: allocationRef('S5', 'allocation-problem', unbound) }, 10000), /versioned rational encoding/);
  for (const value of ['r3q:2/6', 'r3q:1/0', 'r3q:-0/1', 'r3q:01/3']) assert.throws(() => allocationRationalLedgerQuantity(value));
  assert.equal(allocationDecimal(allocationRationalLedgerQuantity('r3q:1/2')), '0.5');
  receipt.status = 'PASS'; receipt.checked = checked; receipt.backend = solved.backend;
  receipt.negativeCases = ['missing-v2-binding', 'unreduced-ledger', 'zero-denominator', 'negative-zero', 'leading-zero'];
} catch (error) { receipt.error = String(error); process.exitCode = 1; }
receipt.finishedAt = new Date().toISOString();
await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt));
