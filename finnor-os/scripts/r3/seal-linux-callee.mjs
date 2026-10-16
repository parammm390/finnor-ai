/** Seal only the supplemental ordinary callee; no protected admission. */
import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
const directory = '/opt/finnor-s6-linux-native';
const files = new Map();
async function pin(path) {
  const actual = await realpath(path), metadata = await stat(actual);
  if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o022)) throw Error('CALLEE_CUSTODY_INVALID');
  files.set(actual, createHash('sha256').update(await readFile(actual)).digest('hex'));
}
for (const name of ['node', 'bwrap', 'uname']) await pin(directory + '/' + name);
await pin('/usr/lib/ld-linux-aarch64.so.1');
for (const name of await readdir('/usr/lib/aarch64-linux-gnu')) {
  const path = '/usr/lib/aarch64-linux-gnu/' + name;
  if ((await stat(path)).isFile()) await pin(path);
}
await writeFile(directory + '/manifest.json', JSON.stringify({
  schema: 'finnor.s6.ordinary-native-callee.v1', kernelMachine: 'aarch64', architecture: 'arm64',
  node: directory + '/node', bwrap: directory + '/bwrap', uname: directory + '/uname',
  files: [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, sha256]) => ({ path, sha256 })),
  protectedAdmission: 'UNADMITTED', authority: 'NONE_OUTPUT_UNTRUSTED',
}, null, 2) + '\n', { mode: 0o444 });
