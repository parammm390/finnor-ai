import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const output = process.argv[2];
if (!output) throw Error('A new owned output directory is required');
const destination = resolve(output);
await mkdir(destination, {recursive: false});
const path = new URL('../../packages/private-equity/src/r1/accounting.ts', import.meta.url);
const cases = [];
const inputs = [];
const attempt = (id, stage, status, body) => ({id, stage, status, body, digest: 'retained-digest:' + id});
const event = (id, kind, body) => ({id, kind, body, digest: 'retained-digest:' + id});
try {
  const {summarizeR1RetainedCosts} = await import(path);
  const check = (id, run) => {
    try { run(); cases.push({id, status: 'PASS'}); }
    catch (error) { cases.push({id, status: 'FAIL', message: error.message}); }
  };
  const native = attempt('a', 'PRODUCE', 'RETURNED', {
    physical: {elapsedMs: 100, cpuUserMicros: 10, cpuSystemMicros: 5, maxRssBytes: 8192}
  });
  const checker = attempt('b', 'CHECK', 'RETURNED', {
    receipt: {elapsedMs: 200, physical: {
      cpuUserMicros: 20, cpuSystemMicros: 3, maxRssNative: 4, platform: 'linux'
    }}
  });
  const unresolved = [
    attempt('c', 'ORIGINAL_FALLBACK', 'UNKNOWN', {}),
    attempt('d', 'CHECK', 'SUBMITTED', {}),
    attempt('e', 'PRODUCE', 'INTENT', {})
  ];
  const lifecycle = [
    event('p', 'COMMON_PREPARATION_CHARGED', {originalS4: {compute: {cpuUserMicros: 1000}}}),
    event('q', 'OWNER_PROJECTION_RETURNED', {cpuUserMicros: 5000}),
    event('r', 'PHYSICAL_RETURNED', {physical: native.body.physical})
  ];
  inputs.push({id: 'retained-records', attempts: [native, checker, ...unresolved], events: lifecycle});
  const value = summarizeR1RetainedCosts(inputs[0].attempts, lifecycle);
  check('all-admitted-dispositions-retained', () => {
    assert.equal(value.attempts, 5);
    assert.equal(value.unknown, 3);
    assert.equal(value.metering.attemptUsage.length, 5);
  });
  check('physical-child-cpu-no-parent-or-event-double-count', () => {
    assert.equal(value.metering.observedChildCpuUserMicros, 30);
    assert.equal(value.metering.observedChildCpuSystemMicros, 8);
    assert.equal(value.metering.cpuCoverage, 'PARTIAL');
  });
  check('native-and-linux-checker-memory-units', () => {
    assert.equal(value.metering.attemptUsage[0].processMaxRssBytes, 8192);
    assert.equal(value.metering.attemptUsage[1].processMaxRssBytes, 4096);
  });
  check('unknown-not-zero-and-not-summed-peaks-or-wall', () => {
    assert.equal(value.metering.attemptUsage[2].cpuUserMicros, null);
    assert.equal(value.metering.aggregateSimultaneousPeakBytes, null);
    assert.equal(value.metering.episodeElapsedMs, null);
    assert.equal(value.usd, null);
    assert.equal(value.metering.humanSeconds, null);
    assert.equal(value.metering.attemptUsage[0].elapsedMs, 100);
    assert.equal(value.metering.attemptUsage[1].elapsedMs, 200);
  });
  check('preparation-and-projection-retained-separately', () => {
    assert.deepEqual(value.metering.commonPreparationRefs, [{id: 'p', digest: 'retained-digest:p'}]);
    assert.deepEqual(value.metering.ownerProjectionRefs, [{id: 'q', digest: 'retained-digest:q'}]);
  });
  const variants = [
    attempt('darwin', 'CHECK', 'RETURNED', {receipt: {physical: {maxRssNative: 4096, platform: 'darwin'}}}),
    attempt('unknown-platform', 'CHECK', 'RETURNED', {receipt: {physical: {maxRssNative: 4096, platform: 'other'}}}),
    attempt('invalid', 'PRODUCE', 'UNKNOWN', {physical: {cpuUserMicros: -1, cpuSystemMicros: '3', maxRssBytes: Infinity, elapsedMs: -1}})
  ];
  inputs.push({id: 'invalid-and-platform', attempts: variants, events: []});
  check('darwin-bytes-and-unknown-platform', () => {
    const result = summarizeR1RetainedCosts(variants, []);
    assert.equal(result.metering.attemptUsage[0].processMaxRssBytes, 4096);
    assert.equal(result.metering.attemptUsage[1].processMaxRssBytes, null);
    assert.equal(result.metering.attemptUsage[2].cpuUserMicros, null);
    assert.equal(result.metering.attemptUsage[2].cpuSystemMicros, null);
    assert.equal(result.metering.attemptUsage[2].processMaxRssBytes, null);
    assert.equal(result.metering.attemptUsage[2].elapsedMs, null);
  });
  check('distinct-attempts-only', () => {
    assert.throws(() => summarizeR1RetainedCosts([native, native], []), /R1_DUPLICATE_PHYSICAL_ACCOUNTING_ID/);
  });
  check('empty-records-do-not-qualify-zero-episode', () => {
    const result = summarizeR1RetainedCosts([], []);
    assert.equal(result.attempts, 0);
    assert.equal(result.metering.cpuCoverage, 'NO_OBSERVATIONS');
    assert.equal(result.metering.episodeElapsedMs, null);
    assert.equal(result.metering.accountingScope, 'OBSERVED_DISTINCT_CHILD_USAGE_NOT_COMPLETE_EPISODE');
  });
} catch (error) {
  cases.push({id: 'accounting-capability-load', status: 'FAIL', message: error.message});
}
const bytes = await readFile(path).catch(() => Buffer.from('MISSING'));
const receipt = {
  schema: 'finnor.r1.retained-accounting-validation.v1',
  boundary: 'ISOLATED_RETAINED_RECORD_ACCOUNTING_NOT_INSTALLED_OWNER',
  node: process.version,
  source: fileURLToPath(path),
  sourceSha256: createHash('sha256').update(bytes).digest('hex'),
  command: 'node --experimental-strip-types finnor-os/scripts/r1/run-retained-accounting.mjs <new-owned-output-directory>',
  inputs, cases,
  status: cases.some(c => c.status === 'FAIL') ? 'FAIL' : 'PASS',
  installedAcceptance: 'NOT_RUN',
  economicQualification: false
};
await writeFile(resolve(destination, 'results.json'), JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({status: receipt.status, cases: cases.length, artifact: resolve(destination, 'results.json')}));
if (receipt.status !== 'PASS') process.exitCode = 1;
