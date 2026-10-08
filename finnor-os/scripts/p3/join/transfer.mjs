/** Exact P3-only transfer into the agent-created committed join. No semantic merge. */
import { readFile, writeFile, readdir, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const source = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const target = '/Users/paramdave/.factory/worktrees/pm-p3-branch-fabric-join/FINNOR';
const base = '32d7d6ba6e8bfe344a04a63ffee34e4904df654e';
const git = (...args) => execFileSync('git', ['-C', target, ...args], { encoding: 'utf8' }).trim();
if (git('rev-parse', 'HEAD') !== base || git('branch', '--show-current') !== 'codex/pm-p3-branch-fabric-join') throw Error('EXACT_AGENT_JOIN_REQUIRED');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const receiptPath = 'scope-pm/phase-03-p3-branch-fabric/scope-evidence/join-import-receipt.json';
let prior = null; try { prior = JSON.parse(await readFile(join(target, receiptPath), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const owned = [
  'finnor-os/packages/private-equity/src/branch-fabric', 'finnor-os/scripts/p3',
  'finnor-os/apps/api/app/api/branches', 'src/app/api/branches', 'src/app/branches',
  'src/components/centropy/canvas/BranchRehearsalPanel.tsx', 'scope-pm/phase-03-p3-branch-fabric',
];
const files = [], unchanged = new Set();
async function inventory(path) {
  if (path === receiptPath) return;
  try {
    for (const entry of await readdir(join(source, path), { withFileTypes: true })) {
      if (entry.isDirectory()) await inventory(path + '/' + entry.name);
      else if (entry.isFile()) await add(path + '/' + entry.name);
      else throw Error('TRANSFER_LINK_REFUSED');
    }
  } catch (e) { if (e.code === 'ENOTDIR') await add(path); else throw e; }
}
async function add(path) {
  const bytes = await readFile(join(source, path)); let exists;
  try { exists = await readFile(join(target, path)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (exists && sha(exists) !== prior?.files.find(f => f.path === path)?.sha256 && sha(exists) !== sha(bytes)) throw Error('UNOWNED_JOIN_FILE_CHANGED:' + path);
  if (exists && sha(exists) === sha(bytes)) unchanged.add(path);
  files.push({ path, sha256: sha(bytes), bytes: bytes.length });
}
for (const path of owned) await inventory(path);
const sharedPath = 'finnor-os/packages/db/compute-contract.ts', beforeBytes = await readFile(join(target, sharedPath));
const marker = 'export const PRODUCTION_JOB_CONTRACTS = {\n', hunk = '  run_branch_fabric_v1: tenantFixed("HEAVY", "pure", "P3 registered native branch work, no live mutation replay or self-admission."),\n';
let shared = beforeBytes.toString();
const baseBytes = execFileSync('git', ['-C', target, 'show', base + ':' + sharedPath]);
if (sha(beforeBytes) !== sha(baseBytes) && sha(beforeBytes) !== prior?.shared.afterSha256) throw Error('SHARED_PREDECESSOR_CHANGED');
if (!shared.includes('run_evidence_derivation_v1:') || shared.split(marker).length !== 2) throw Error('P4_REGISTRATION_OR_PREDECESSOR_MISSING');
if (!shared.includes(hunk)) shared = shared.replace(marker, marker + hunk);
if (shared.replace(hunk, '') !== baseBytes.toString()) throw Error('NON_P3_SHARED_DELTA_REFUSED');
for (const file of files) {
  if (unchanged.has(file.path)) continue;
  await mkdir(dirname(join(target, file.path)), { recursive: true }); await copyFile(join(source, file.path), join(target, file.path));
}
await writeFile(join(target, sharedPath), shared);
const packages = [];
const original = JSON.parse(await readFile(join(source, 'scope-pm/phase-03-p3-branch-fabric/base-integration-receipt.json'), 'utf8'));
const require = createRequire(join(target, 'finnor-os/package.json'));
for (const item of original.packageResolution) {
  const name = item.name ?? item.package; if (!name) continue;
  const path = require.resolve(name), fs = await import('node:fs/promises'), realpath = await fs.realpath(path);
  if (!realpath.startsWith(target + '/')) throw Error('FOREIGN_PACKAGE_INSTALL');
  packages.push({ name, path, realpath });
}
const receipt = { schema: 'finnor.p3.join-import.v1', recordedAt: new Date().toISOString(), source,
  sourceNeutralBase: execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  target, commit: base, tree: git('rev-parse', 'HEAD^{tree}'), parents: git('show', '-s', '--format=%P', 'HEAD'),
  committedP4Import: JSON.parse(await readFile(join(target, 'scope-pm/phase-02-m1-decision-slice/scope-evidence/p4-import-receipt.json'), 'utf8')),
  locks: await Promise.all(['package-lock.json', 'finnor-os/package-lock.json'].map(async path => {
    const bytes = await readFile(join(target, path)); if (sha(bytes) !== sha(await readFile(join(source, path)))) throw Error('LOCKFILE_DELTA_UNREVIEWED');
    return { path, sha256: sha(bytes), unchanged: true };
  })),
  packages, migrations: (await readdir(join(target, 'finnor-os/packages/db/migrations'))).filter(x => x.endsWith('.sql')).sort(),
  shared: { path: sharedPath, beforeSha256: sha(baseBytes), afterSha256: sha(shared), exactAddedHunk: hunk, p4RegistrationPreserved: true },
  files, writesLimitedTo: owned, movingPeerWorkingSourceCopied: false, dependencyInstallCopied: false,
  qualification: 'EXACT_COMMITTED_ORDINARY_JOIN_IMPORT_NOT_EXECUTED_COMBINED_GATE' };
await writeFile(join(target, receiptPath), JSON.stringify(receipt, null, 2) + '\n');
await writeFile(join(source, receiptPath), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ target, importedFiles: files.length, importedBytes: files.reduce((n, f) => n + f.bytes, 0), shared: receipt.shared, migrations: receipt.migrations.length, packages }));
