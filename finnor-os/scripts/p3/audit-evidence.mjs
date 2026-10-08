/** Read-only checks; the sole write is a new phase-local audit receipt. */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const phase = join(root, 'scope-pm/phase-03-p3-branch-fabric'), evidence = join(phase, 'scope-evidence');
const primary = '/Users/paramdave/Desktop/FINNOR';
const control = '/Users/paramdave/.codex/visualizations/2026/10/04/01a10828-82e3-7572-8d13-530b28a346bf/finnor-pm-control';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (at, ...args) => execFileSync('git', ['-C', at, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const runs = [], defects = [];
for (const entry of await readdir(evidence, { withFileTypes: true })) {
  if (!entry.isDirectory() || !/^(run-|linux-|regression-|bundle-smoke-)/.test(entry.name)) continue;
  const directory = join(evidence, entry.name), observed = { path: entry.name, mismatches: [], missing: [], manifestStatus: 'UNSEALED_FAILED_OR_INTERRUPTED_RUN', sourcesChangedSinceRun: [] };
  try {
    const manifest = await json(join(directory, 'evidence-manifest.json'));
    for (const file of manifest.files) {
      if (file.path.startsWith('/') || file.path.split('/').includes('..')) throw Error('EVIDENCE_PATH_INVALID');
      try {
        const bytes = await readFile(join(directory, file.path));
        if (sha(bytes) !== file.sha256 || file.bytes != null && bytes.length !== file.bytes) observed.mismatches.push(file.path);
      } catch (e) { if (e.code === 'ENOENT') observed.missing.push(file.path); else throw e; }
    }
    observed.manifestStatus = observed.mismatches.length || observed.missing.length ? 'INTEGRITY_DEFECT_RETAINED_NOT_A_PASS' : 'VERIFIED_EXACT_RETAINED_BYTES';
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  try {
    const result = await json(join(directory, 'results.json'));
    const cases = result.cases ?? [];
    observed.outcomes = Object.fromEntries([...new Set(cases.map(c => c.status))].map(status => [status, cases.filter(c => c.status === status).length]));
    const isJoin = cases.some(c => c.id.startsWith('T1-'));
    const sourceRoot = isJoin ? '/Users/paramdave/.factory/worktrees/pm-p3-branch-fabric-join/FINNOR' : root;
    observed.currentSourceRoot = sourceRoot;
    for (const pin of result.sourceManifest ?? []) {
      try { if (sha(await readFile(join(sourceRoot, pin.path))) !== pin.sha256) observed.sourcesChangedSinceRun.push(pin.path); }
      catch (e) { if (e.code === 'ENOENT') observed.sourcesChangedSinceRun.push(pin.path); else throw e; }
    }
    observed.currentSourceQualification = !result.sourceManifest ? 'NO_SOURCE_CUT_IN_THIS_RESULT_SEE_PROFILE_OR_BUILD_MANIFEST'
      : observed.sourcesChangedSinceRun.length ? 'HISTORICAL_SOURCE_CUT_NOT_CURRENT_SOURCE_COVERAGE' : 'RECORDED_SOURCE_CUT_STILL_MATCHES';
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (observed.mismatches.length || observed.missing.length) defects.push(observed);
  runs.push(observed);
}
const start = await json('/tmp/finnor-p3-primary-start-20261005.json'), changed = [];
for (const file of start.files) if (sha(await readFile(join(primary, file.path))) !== file.sha256) changed.push(file.path);
const currentPrimary = { head: git(primary, 'rev-parse', 'HEAD'), tree: git(primary, 'rev-parse', 'HEAD^{tree}'),
  indexSha256: sha(await readFile(resolve(primary, git(primary, 'rev-parse', '--git-path', 'index')))),
  selectedFiles: start.files.length, selectedChanged: changed };
const primaryPreserved = !changed.length && ['head', 'tree', 'indexSha256'].every(k => currentPrimary[k] === start[k]);
const governancePaths = [
  ...Array.from({ length: 6 }, (_, i) => `sources/attachments/pasted-text-${i + 1}.txt`),
  'sources/historical-research/architecture-locked-specification.md', 'sources/historical-research/architecture-lock.json',
  'source-index.json', 'requirement-index.json', 'audit-target.json', 'audit.md', 'reconciliation-and-delivery-order.md',
  'research-decisions.md', 'phase03-parallel-contract.md', 'phase03-runtime-failure-model.md',
  'evidence/phase03-authoring-refresh.json', 'evidence/phase03-peer-progress-refresh.json',
  'evidence/phase03-public-pr-refresh.json', 'evidence/phase03-neutral-base-verification.json',
  'prompts/phase-03-p3-branch-fabric-factory-parallel.md',
  'prompts/phase-01-p4-evidence-execution-delivered-recovered.md', 'prompts/phase-02-m1-decision-slice-factory-parallel.md',
  'evidence/phase03-compute-owner-rerun/run-manifest.json', 'evidence/phase03-compute-owner-rerun/vitest-results.json', 'evidence/phase03-compute-owner-rerun/stdout.log',
  'sources/historical-research/references/openclaw-test-audit/SKILL.md',
];
const governance = [];
for (const path of governancePaths) {
  const bytes = await readFile(join(control, path)); governance.push({ path, bytes: bytes.length, sha256: sha(bytes) });
}
const peerRoots = [
  '/Users/paramdave/.factory/worktrees/pm-m1-decision-slice/FINNOR',
  '/Users/paramdave/.codex/visualizations/2026/10/04/01a10858-1ea5-7df3-b7c8-9668bd48608e/p4-implementation/FINNOR',
];
const peers = await Promise.all(peerRoots.map(async root => ({ root, head: git(root, 'rev-parse', 'HEAD'), tree: git(root, 'rev-parse', 'HEAD^{tree}'),
  indexSha256: sha(await readFile(resolve(root, git(root, 'rev-parse', '--git-path', 'index')))),
  observation: 'READ_ONLY_PEER_MAY_ADVANCE_NOT_AN_UNCHANGED_WORKING_SOURCE_ASSERTION' })));
const receipt = { schema: 'finnor.p3.integrity-audit.v1', observedAt: new Date().toISOString(), runs, defects,
  primary: { startReceiptSha256: sha(await readFile('/tmp/finnor-p3-primary-start-20261005.json')), current: currentPrimary, preserved: primaryPreserved },
  governingSources: { root: control, files: governance, requirementsNotExecutionEvidence: true }, peers,
  publishedMain: git(root, 'ls-remote', 'origin', 'refs/heads/main'), publicPRBase: 'PR_PUBLIC_BASE_UNRESOLVED',
  protectedAdmission: 'UNPASSED', externalWrites: [], codingModelRoute: null, codingModelRouteReason: 'NOT_EXPOSED_BY_SESSION_TOOLING',
  sharedReportedFactoryAllocationUSD: 200, verifiedRemainingFactoryAllocationUSD: null,
  qualification: 'EXACT_BYTE_REVERIFICATION_NOT_SCIENTIFIC_TRUTH_OR_FINANCIAL_ADMISSION' };
const path = join(evidence, 'integrity-audit-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
await writeFile(path, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ path, runs: runs.length, integrityDefects: defects.map(d => ({ path: d.path, mismatches: d.mismatches, missing: d.missing })), primaryPreserved }));
if (defects.length || !primaryPreserved) process.exitCode = 1;
