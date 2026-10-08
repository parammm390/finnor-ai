/** Export committed phase-only delivery, never a push or a cumulative-S patch. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const joined = '/Users/paramdave/.factory/worktrees/pm-p3-branch-fabric-join/FINNOR';
const base = 'e9c15d65a4a01e81dddbadcbd3449e1a5bd305d5';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (at, ...args) => execFileSync('git', ['-C', at, ...args], { maxBuffer: 256 * 1024 * 1024 });
const text = (at, ...args) => git(at, ...args).toString().trim();
if (text(root, 'status', '--porcelain')) throw Error('COMMITTED_CLEAN_PHASE_REQUIRED');
if (text(root, 'symbolic-ref', '--short', 'HEAD') !== 'codex/pm-p3-branch-fabric') throw Error('EXACT_PHASE_BRANCH_REQUIRED');
if (text(root, 'rev-parse', base + '^{tree}') !== '6c5da18df33c41f6a058ee8ee4bb3c673b507f64') throw Error('NEUTRAL_BASE_CHANGED');
const paths = text(root, 'diff', '--name-only', '--no-renames', base, 'HEAD').split('\n');
const allowed = /^(?:finnor-os\/packages\/private-equity\/src\/branch-fabric\/|finnor-os\/scripts\/p3\/|scope-pm\/phase-03-p3-branch-fabric\/|finnor-os\/apps\/api\/app\/api\/branches\/|src\/app\/api\/branches\/|src\/app\/branches\/|src\/components\/centropy\/canvas\/BranchRehearsalPanel\.tsx$|finnor-os\/packages\/db\/compute-contract\.ts$)/;
if (paths.some(path => !allowed.test(path))) throw Error('NON_PHASE_DIFF_REFUSED');
const output = join(root, '.runtime/p3-handoff-' + new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(output, { mode: 0o700 });
const exports = [];
async function save(name, bytes) {
  await writeFile(join(output, name), bytes, { flag: 'wx', mode: 0o600 });
  exports.push({ path: name, bytes: Buffer.byteLength(bytes), sha256: sha(bytes) });
}
await save('phase-only.patch', git(root, 'diff', '--binary', '--no-renames', base, 'HEAD'));
const commits = text(root, 'rev-list', '--reverse', base + '..HEAD').split('\n');
for (let i = 0; i < commits.length; i++) await save(`${String(i + 1).padStart(2, '0')}-${commits[i].slice(0, 12)}.patch`,
  git(root, 'format-patch', '-1', '--stdout', '--no-signature', commits[i]));
const sharedPath = 'finnor-os/packages/db/compute-contract.ts';
const oldShared = git(root, 'show', base + ':' + sharedPath), newShared = await readFile(join(root, sharedPath));
await save('shared-neutral.patch', git(root, 'diff', base, 'HEAD', '--', sharedPath));
if (text(joined, 'rev-parse', 'HEAD') !== '32d7d6ba6e8bfe344a04a63ffee34e4904df654e') throw Error('EXACT_JOIN_BASE_REQUIRED');
const joinOld = git(joined, 'show', 'HEAD:' + sharedPath), joinNew = await readFile(join(joined, sharedPath));
if (sha(joinOld) !== '999e4aa680b4c259333c55c5f0e600441cc31ba8724c313808e58d2f56c5a064' ||
  sha(joinNew) !== '73e02b0d43bb984777908b11417ca9c4ca0dfe2a255fb8cbb92321fb7dc98fcd') throw Error('JOIN_SHARED_CUT_CHANGED');
await save('shared-joined.patch', git(joined, 'diff', 'HEAD', '--', sharedPath));
await save('0156_p3_branch_fabric_candidate.sql', await readFile(join(root, 'scope-pm/phase-03-p3-branch-fabric/migration.sql')));
const sourceFiles = await Promise.all(paths.map(async path => { const bytes = await readFile(join(root, path)); return { path, bytes: bytes.length, sha256: sha(bytes) }; }));
await save('source-files.json', JSON.stringify(sourceFiles, null, 2) + '\n');
const builds = [];
for (const [at, path] of [[root, '.runtime/p3-linux-final-20261005'], [joined, '.runtime/p3-joined-linux-current-20261005']]) {
  const manifest = JSON.parse(await readFile(join(at, path, 'build-manifest.json'), 'utf8')), changed = [];
  for (const source of manifest.sources) if (sha(await readFile(join(at, source.path))) !== source.sha256) changed.push(source.path);
  for (const file of manifest.files) if (sha(await readFile(join(at, path, file.path))) !== file.sha256) changed.push(file.path);
  if (changed.length) throw Error('BUILD_BYTES_CHANGED:' + changed.join(','));
  builds.push({ root: at, path, sourceInputs: manifest.sources.length, files: manifest.files, rootfsStatus: manifest.rootfsStatus, qualification: 'BUILD_ONLY_NOT_LINUX_EXECUTION' });
}
const receipt = { schema: 'finnor.p3.delivery.v1', observedAt: new Date().toISOString(), root, baseCommit: base,
  baseTree: text(root, 'rev-parse', base + '^{tree}'), featureHead: text(root, 'rev-parse', 'HEAD'), featureTree: text(root, 'rev-parse', 'HEAD^{tree}'),
  commits: commits.map(commit => ({ commit, title: text(root, 'show', '-s', '--format=%s', commit) })), phaseFiles: paths.length,
  sourceBytes: sourceFiles.reduce((n, f) => n + f.bytes, 0), exports, builds,
  shared: { path: sharedPath, neutralBeforeSha256: sha(oldShared), neutralAfterSha256: sha(newShared), joinBeforeSha256: sha(joinOld), joinAfterSha256: sha(joinNew) },
  migration: { candidateName: '0156_p3_branch_fabric_candidate.sql', finalSlot: 'UNASSIGNED_SERIALIZED_INTEGRATION_REQUIRED' },
  latestStandalone: 'run-2026-10-05T02-28-48-382Z-3bc2d9b1', latestJoin: 'run-2026-10-05T02-29-11-152Z-781e6b6c',
  affectedOwnerRegression: 'regression-2026-10-05T02-45-45-315Z',
  evidenceExport: JSON.parse(await readFile(join(root, 'scope-pm/phase-03-p3-branch-fabric/redacted-evidence-index.json'), 'utf8')),
  rawEvidence: 'UNCHANGED_LOCAL_ONLY_NOT_IN_GIT_OR_PATCHES',
  publicBase: 'PR_PUBLIC_BASE_UNRESOLVED', originalP3Gate: 'UNPASSED', acceptedIsolatedBranches: 0,
  moneyUSD: null, deployment: 'UNPASSED_NOT_PERFORMED', externalWrites: [] };
await save('delivery-receipt.json', JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ output, featureHead: receipt.featureHead, commits: receipt.commits, phaseFiles: paths.length,
  bytes: receipt.sourceBytes, originalP3Gate: receipt.originalP3Gate, exports }));
