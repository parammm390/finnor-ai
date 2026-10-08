import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { bytesHash, hash, fault, type InputArtifact } from './contracts';
const entries = {
  'public-allocation': { kind: 'pure', inputSchema: 'finnor.public-allocation-input.v1', outputSchema: 'finnor.public-allocation-output.v1' },
  'underwriting': { kind: 'pure', inputSchema: 'underwriting-input-snapshot.v1', outputSchema: 'underwriting-run-result.v1' },
  'allocation': { kind: 'pure', inputSchema: 'finnor.allocation-problem.v1', outputSchema: 'finnor.s8.allocation-search-result.v1' },
  'financing': { kind: 'application_fixture', inputSchema: 'finnor.financing-fixture.v1', outputSchema: 'finnor.financing-fixture-state.v1' },
  's3-kernel': { kind: 'intervention_simulation', inputSchema: 'finnor.s3.control-kernel-snapshot.v1', outputSchema: 'finnor.p3.joint-trajectory.v1' },
  's6-observation': { kind: 'live_read', inputSchema: 'finnor.p3.reviewed-observation.v1', outputSchema: 'finnor.p3.reviewed-observation.v1' },
  'p4-finite': { kind: 'pure', inputSchema: 'finnor.p3.p4-materialized-input.v1', outputSchema: 'finnor.p3.p4-replay.v1' },
  'm1-underwriting': { kind: 'pure', inputSchema: 'finnor.p3.m1-underwriting-input.v1', outputSchema: 'finnor.p3.m1-native-replay.v1' },
} as const;
const dependencies = [
  './contracts.ts', './registry.ts', './programmes.ts', './fixture.ts', './simulation.ts', './fixtures/allocation.json',
  './numerical-checks.ts', './p4-check.ts', './live-read.ts', './checker.ts', './supervisor.ts',
  '../../../underwriting/src/compiler.ts', '../../../underwriting/src/executor.ts', '../../../underwriting/src/snapshot.ts',
  '../../../underwriting/src/decimal.ts', '../../../underwriting/src/standard-lbo.ts',
  '../../../capability-evolution/src/search.ts', '../../../capability-evolution/src/contracts.ts',
  '../../../epistemic-runtime/src/allocation-checker.ts', '../../../epistemic-runtime/src/allocation-contracts.ts',
  '../../../epistemic-runtime/src/intervention-control.ts',
  '../../../epistemic-runtime/src/experiment-numerics.ts', '../../../epistemic-runtime/src/source-precedence.ts',
  '../../../underwriting/src/canonical.ts', '../../../underwriting/src/types.ts', '../../../underwriting/src/errors.ts',
  '../../../underwriting/src/result.ts', '../../../underwriting/src/periods.ts',
];
export async function programmeRef(id: keyof typeof entries) {
  const sources = await Promise.all(dependencies.map(async p => ({ path: p, sha256: bytesHash(await readFile(fileURLToPath(new URL(p, import.meta.url)))) })));
  if (id === 'p4-finite') for (const path of ['operators.ts', 'exact.ts', 'node-reuse.ts']) {
    const p = '../evidence-execution/' + path;
    sources.push({ path: p, sha256: bytesHash(await readFile(fileURLToPath(new URL(p, import.meta.url)))) });
  }
  const e = entries[id];
  return { programmeSource: 'REGISTERED_NATIVE' as const, id, version: 'p3-native-v1' as const, contentDigest: hash({ id, ...e, sources, node: process.version }), inputSchema: e.inputSchema, outputSchema: e.outputSchema };
}
export async function assertProgramme(input: InputArtifact) {
  if (!Object.hasOwn(entries, input.programme.id)) fault('UNREGISTERED_PROGRAMME', 400);
  const id = input.programme.id as keyof typeof entries;
  if (entries[id].kind !== input.kind || hash(await programmeRef(id)) !== hash(input.programme)) fault('PROGRAMME_REVISION_CHANGED');
}
export const programmeId = (source: InputArtifact['source']['kind']): keyof typeof entries => {
  const map: Partial<Record<InputArtifact['source']['kind'], keyof typeof entries>> = {
    public_fixture: 'public-allocation', financing_fixture: 'financing', underwriting: 'underwriting',
    allocation: 'allocation', s3: 's3-kernel', s6_read: 's6-observation',
    p4: 'p4-finite', m1: 'm1-underwriting',
  };
  return map[source] ?? fault('PENDING_DEPENDENCY', 424);
};
