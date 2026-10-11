/** Installed-byte execution proof, not S8 admission or a Linux image claim. */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { r3RuntimeIdentity, r3Digest, r3Hash, proposeR3Rule, checkR3Rule } from '../../packages/epistemic-runtime/src/incentive-rule-synthesis/launcher';
import { parseR3Problem } from '../../packages/epistemic-runtime/src/incentive-rule-synthesis/contracts';
import { R3RuleSchema, R3CheckSchema, R3WorkReviewSchema, R3_OUTPUT_SCHEMA_CONTRIBUTION } from '../../packages/epistemic-runtime/src/incentive-rule-synthesis/output-contracts';
import { createWorker } from '../../apps/worker/src/index';

const repo = resolve(import.meta.dirname, '../../..');
const output = process.argv[2] ?? ''; assert(output.startsWith('/'), 'R3_ABSOLUTE_NEW_EVIDENCE_DIRECTORY_REQUIRED');
await mkdir(output, { recursive: false });
const startedAt = new Date().toISOString(), started = performance.now();
const results: any[] = [];
const save = async (name: string, value: unknown) =>
  writeFile(join(output, name), JSON.stringify(value, null, 2) + '\n');
try {
  assert.notEqual(process.getuid?.(), 0);
  const identity = await r3RuntimeIdentity(), interpreter = await realpath(identity.runtime.python);
  const probe = spawnSync(identity.runtime.python, ['-I', '-c', `
import json,os,sys,platform,tempfile,resource
import numpy,pyscipopt
m=pyscipopt.Model()
with tempfile.TemporaryFile() as f:f.write(b'r3-bounded-scratch');f.flush()
print(json.dumps({'uid':os.getuid(),'python':sys.version,'executable':sys.executable,
 'numpy':numpy.__version__,'pyscipopt':pyscipopt.__version__,
 'scip':'%s.%s.%s'%(m.getMajorVersion(),m.getMinorVersion(),m.getTechVersion()),
 'exactModeOption':'exact/enable' in m.getParams(),'machine':platform.machine(),
 'platform':sys.platform,'scratchWritable':True}))`],
    { timeout: 25000, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1',
      OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1' } });
  assert.equal(probe.status, 0, probe.stderr);
  const installed = JSON.parse(probe.stdout);
  assert.equal(installed.scip, '10.0.0'); assert.equal(installed.numpy, '2.2.6');
  assert.equal(installed.pyscipopt, '6.0.0'); assert.equal(installed.exactModeOption, false);
  results.push({ id: 'installed-non-root-interpreter-solver-scratch', status: 'PASS', observed: installed });
  const licensePreimages = [];
  for (const license of identity.runtime.licenseInventory) {
    const path = license.source.startsWith('/') ? license.source
      : identity.runtime.files.find(f => f.path.endsWith('/' + license.source))?.path;
    assert(path, 'R3_STANDALONE_LICENSE_PREIMAGE_REQUIRED');
    const sha256 = r3Hash(await readFile(path)); assert.equal(sha256, license.evidenceDigest);
    licensePreimages.push({ ...license, path, sha256 });
  }
  await save('installed-identity.json', { identity, interpreter, installed, licensePreimages,
    r3LockSha256: r3Hash(await readFile(join(repo, 'finnor-os/scripts/r3/requirements.lock'))),
    upstreamLockSha256: r3Hash(await readFile(join(repo, 'finnor-os/scripts/r3/upstream-requirements.lock'))) });
  const original = spawnSync(identity.runtime.python, ['-I', '-c',
    "import sys,json;sys.path.insert(0,sys.argv[1]);from fixtures import fixture;print(json.dumps(fixture()))",
    join(repo, 'finnor-os/scripts/r3')], { timeout: 25000, encoding: 'utf8' });
  assert.equal(original.status, 0, original.stderr);
  const problem = parseR3Problem(JSON.parse(original.stdout));
  problem.binding.backendDigest = identity.digest;
  problem.binding.checkerDigest = identity.checkerDigest;
  problem.binding.producerDigest = identity.producerDigest;
  await save('original-input.json', problem);
  const deadline = Date.now() + 60000;
  const proposal = await proposeR3Rule(problem, deadline, 25);
  await save('native-proposal.json', proposal); assert(proposal.output.rule);
  R3RuleSchema.parse(proposal.output.rule);
  const checked = await checkR3Rule(problem, proposal.output.rule, deadline, 25);
  await save('independent-check.json', checked); R3CheckSchema.parse(checked.output);
  assert.deepEqual(checked.output.counts, { profiles: 81, deviations: 648, participation: 324 });
  results.push({ id: 'installed-Node-launcher-producer-independent-checker', status: 'PASS',
    counts: checked.output.counts, receipts: [proposal.receipt, checked.receipt] });
  if (process.argv[3]) {
    const observed = JSON.parse(await readFile(process.argv[3], 'utf8'));
    const review = observed.review ?? observed.protocolReview ?? observed;
    R3WorkReviewSchema.parse(review);
    results.push({ id: 'actual-owner-output-schema', status: 'PASS', source: process.argv[3], digest: r3Digest(review) });
  }
  const registered = createWorker().registeredTypes();
  for (const type of ['release_probe', 'run_capital_program_v2', 'run_harness_program_v1',
    'run_programme_continuation_v1', 'run_counterexample_search_v1', 'run_incentive_rule_synthesis_v1'])
    assert(registered.includes(type), 'R3_EXISTING_JOB_REGISTRATION_RETAINED:' + type);
  results.push({ id: 'actual-worker-original-and-R3-registration', status: 'PASS', registered,
    queuedDispatchVerifiedHere: false });
  await save('output-schema-contribution.json', R3_OUTPUT_SCHEMA_CONTRIBUTION);
} catch (error) {
  results.push({ id: 'installed-runtime', status: 'FAIL',
    error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) });
  process.exitCode = 1;
} finally {
  await save('results.json', { schema: 'finnor.r3.installed-runtime-proof.v1', startedAt,
    finishedAt: new Date().toISOString(), elapsedMs: performance.now() - started, node: process.version,
    uid: process.getuid?.(), platform: process.platform, architecture: process.arch, results,
    LinuxImageVerified: false, S8AdmissionGranted: false, aggregateSimultaneousPeakMemoryBytes: null,
    usd: null, rerun: 'node --import=tsx scripts/r3/check-runtime.mts <new-absolute-evidence-dir> [actual-owner-review-artifact]' });
  console.log(JSON.stringify({ output, exitCode: process.exitCode ?? 0, results: results.map(({ id, status }) => ({ id, status })) }));
}
