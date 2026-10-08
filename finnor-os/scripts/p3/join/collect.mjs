/** Preserve every terminal join run in the phase checkout without modifying it. */
import { readdir, mkdir, copyFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const target = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const source = '/Users/paramdave/.factory/worktrees/pm-p3-branch-fabric-join/FINNOR';
const suffix = 'scope-pm/phase-03-p3-branch-fabric/scope-evidence';
const sha = b => createHash('sha256').update(b).digest('hex');
let files = 0, bytes = 0;
async function copy(path) {
  await mkdir(join(target, path), { recursive: true });
  for (const entry of await readdir(join(source, path), { withFileTypes: true })) {
    const item = join(path, entry.name);
    if (entry.isDirectory()) await copy(item);
    else if (entry.isFile()) {
      const data = await readFile(join(source, item)); let present;
      try { present = await readFile(join(target, item)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (present) { if (sha(present) !== sha(data)) throw Error('RETAINED_JOIN_EVIDENCE_CHANGED:' + item); }
      else await copyFile(join(source, item), join(target, item));
      files++; bytes += data.length;
    } else throw Error('JOIN_EVIDENCE_LINK_REFUSED');
  }
}
for (const entry of await readdir(join(source, suffix), { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith('run-')) continue;
  const path = join(suffix, entry.name), result = JSON.parse(await readFile(join(source, path, 'results.json'), 'utf8'));
  if (!result.cases.some(c => c.id.startsWith('T1-') || c.id === 'HARNESS_SETUP_OR_INTEGRITY')) continue;
  if (result.cases.some(c => c.status === 'RUNNING')) throw Error('LIVE_JOIN_RUN_REFUSED');
  await copy(path);
}
console.log(JSON.stringify({ source, target, files, bytes, qualification: 'VERBATIM_TERMINAL_JOIN_EVIDENCE_NOT_A_NEW_RUN' }));
