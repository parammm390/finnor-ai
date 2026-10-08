/** Builds only new local output; never provisions or downloads a runtime. */
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, realpath, chmod, copyFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const backend = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const root = dirname(backend), args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--output' || !args[1].startsWith('/')) throw Error('ABSOLUTE_NEW_OUTPUT_REQUIRED');
const output = resolve(args[1]); await mkdir(output, { mode: 0o700 });
const app = join(output, 'app'); await mkdir(app, { mode: 0o755 });
const digest = value => createHash('sha256').update(value).digest('hex');
const sources = new Map(), files = [], entries = ['native-worker', 'checker-worker'];
try { await readFile(join(backend, 'packages/private-equity/src/evidence-execution/operators.ts')); entries.push('p4-worker'); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
for (const entry of entries) {
  let entryOptions = { entryPoints: [`scripts/p3/${entry}.mts`] };
  if (entry === 'p4-worker') {
    const path = join(backend, 'scripts/p3/p4-worker.mts'), bytes = await readFile(path);
    const original = "const moduleUrl = new URL('../../packages/private-equity/src/evidence-execution/operators.ts', import.meta.url).href;\nconst { runNativeProgram } = await import(moduleUrl);";
    if (!bytes.toString().includes(original)) throw Error('P4_FIXED_BUILD_ENTRY_CHANGED');
    const contents = bytes.toString().replace(original, "import { runNativeProgram } from '../../packages/private-equity/src/evidence-execution/operators.ts';");
    entryOptions = { stdin: { contents, resolveDir: dirname(path), sourcefile: 'p4-worker.mts', loader: 'ts' } };
    sources.set('finnor-os/scripts/p3/p4-worker.mts', { path: 'finnor-os/scripts/p3/p4-worker.mts', sha256: digest(bytes) });
  }
  const compiled = await build({ absWorkingDir: backend, ...entryOptions, bundle: true,
    platform: 'node', format: 'esm', target: 'node22', write: false, metafile: true,
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require=__createRequire(import.meta.url);' } });
  const bytes = compiled.outputFiles[0].contents;
  await writeFile(join(app, entry + '.mjs'), bytes, { flag: 'wx', mode: 0o444 });
  files.push({ path: 'app/' + entry + '.mjs', bytes: bytes.length, sha256: digest(bytes) });
  for (const name of Object.keys(compiled.metafile.inputs)) {
    if (name === 'p4-worker.mts') continue;
    const path = resolve(backend, name), bytes = await readFile(path);
    if (!path.startsWith(root + '/')) throw Error('FOREIGN_BUILD_SOURCE_REFUSED');
    sources.set(path.slice(root.length + 1), { path: path.slice(root.length + 1), sha256: digest(bytes) });
  }
}
for (const name of ['probe.mjs', 'checkpoint.mjs', 'checkpoint-observer.mjs']) {
  const bytes = await readFile(join(backend, 'scripts/p3/linux', name));
  await writeFile(join(app, name), bytes, { flag: 'wx', mode: 0o444 });
  files.push({ path: 'app/' + name, bytes: bytes.length, sha256: digest(bytes) });
}
const sbom = [];
for (const name of ['zod', 'decimal.js', 'esbuild']) {
  const packagePath = await realpath(join(backend, 'node_modules', name, 'package.json'));
  if (!packagePath.startsWith(root + '/')) throw Error('FOREIGN_BUILD_PACKAGE_REFUSED');
  const bytes = await readFile(packagePath), pkg = JSON.parse(bytes);
  sbom.push({ name, version: pkg.version, license: pkg.license, packageJsonSha256: digest(bytes), role: name === 'esbuild' ? 'BUILD_ONLY' : 'BUNDLED_CANDIDATE_AND_CHECKER' });
}
let rootfs = null, elf = [], rootfsStatus = 'ROOTFS_BUILD_UNPASSED_NON_LINUX_HOST';
if (process.platform === 'linux') {
  rootfs = join(output, 'rootfs'); await mkdir(rootfs, { mode: 0o755 });
  for (const directory of ['bin', 'app', 'state', 'tmp', 'proc', 'dev']) await mkdir(join(rootfs, directory), { mode: 0o755 });
  const copy = async (source, destination) => {
    const bytes = await readFile(await realpath(source));
    await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
    await writeFile(destination, bytes, { flag: 'wx', mode: 0o555 });
    elf.push({ source: await realpath(source), path: destination.slice(rootfs.length + 1), bytes: bytes.length, sha256: digest(bytes) });
  };
  await copy(process.execPath, join(rootfs, 'bin/node'));
  const dependencies = execFileSync('ldd', [process.execPath], { encoding: 'utf8', timeout: 3000 });
  if (dependencies.includes('not found')) throw Error('NODE_ELF_DEPENDENCY_UNAVAILABLE');
  const paths = [...new Set([...dependencies.matchAll(/(?:=>\s*)?(\/[A-Za-z0-9_./+-]+)/g)].map(m => m[1]))];
  for (const path of paths) await copy(path, join(rootfs, path.slice(1)));
  for (const file of files) await copyFile(join(output, file.path), join(rootfs, file.path));
  rootfsStatus = 'BUILT_NOT_EXECUTED_OR_ADMITTED';
}
const nodeBytes = await readFile(process.execPath);
const manifest = { schema: 'finnor.p3.linux-build.v1', builtAt: new Date().toISOString(), output, rootfs, rootfsStatus,
  sources: [...sources.values()].sort((a, b) => a.path.localeCompare(b.path)), files, elf, sbom,
  runtime: { node: process.version, architecture: process.arch, platform: process.platform, nodeBinarySha256: digest(nodeBytes), license: 'MIT_AND_BUNDLED_NOTICES' },
  locks: await Promise.all(['package-lock.json', 'finnor-os/package-lock.json'].map(async path => ({ path, sha256: digest(await readFile(join(root, path))) }))),
  gvisor: { version: 'release-20260928.0', license: 'Apache-2.0', binarySuppliedAndVerifiedSeparately: true },
  qualification: 'DEVELOPMENT_BUILD_NOT_CONFINEMENT_S8_FUNDING_OR_DEPLOYMENT' };
await writeFile(join(output, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
await writeFile(join(output, 'THIRD_PARTY_NOTICES.txt'), [
  'FINNOR P3 fixed candidate/checker build.',
  'Node.js: MIT with bundled notices; Node SQLite: public-domain SQLite implementation.',
  'gVisor/runsc: Apache-2.0; obtain exact release license and provenance with the binary.',
  ...sbom.map(p => `${p.name} ${p.version}: ${p.license} (${p.role}).`),
  'ELF platform libraries are copied only on Linux. Their exact distribution licenses, SBOM and security status must be retained by the authorized host operator.',
  'No build output is protected admission or an executed sandbox certification.',
].join('\n') + '\n', { flag: 'wx', mode: 0o444 });
console.log(JSON.stringify({ output, rootfsStatus, bundles: files, inputSourceCount: sources.size, protectedEligible: false }));
