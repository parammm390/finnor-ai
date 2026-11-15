/** One finite compilation of the real API/worker/checker. No downloads,
 * provisioned services, production authority or substituted runtime sources. */
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, realpath, readdir, stat, symlink } from 'node:fs/promises';
import { existsSync, statfsSync } from 'node:fs';
import { dirname, resolve, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';

const backend = fileURLToPath(new URL('../../../', import.meta.url)), root = dirname(backend.slice(0, -1));
const args = process.argv.slice(2);
const w2 = args.length === 4 && args[2] === '--profile' && args[3] === 'postz-w2';
if (w2) args.splice(2);
const label = w2 ? 'w2' : 'x1';
if (args.length !== 2 || args[0] !== '--output' || !args[1].startsWith('/') || existsSync(args[1]))
  throw Error('X1_NEW_ABSOLUTE_INSTALLATION_OUTPUT_REQUIRED');
const output = resolve(args[1]), started = Date.now();
const limits = JSON.parse(await readFile(join(root, w2 ? 'scope-postz/w2-accountable-workforce/verification-plan.json' :
  'scope-frontier5/x1-institutional-programme-compiler/verification-plan.json'), 'utf8')).limits;
const capacity = statfsSync(root, { bigint: true });
if (capacity.bavail * capacity.bsize < BigInt(limits.finalBuildMinimumFreeBytes)) throw Error('X1_FINAL_BUILD_CAPACITY_REFUSED');
const timer = setTimeout(() => { console.error('X1_FINAL_BUILD_WALL_BOUND'); process.exit(1); }, limits.finalBuildWallSeconds * 1000);
const digest = value => createHash('sha256').update(value).digest('hex');
const git = (...argv) => execFileSync('git', argv, { cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }).trimEnd();
const frozen = { commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'), dirty: git('status', '--porcelain=v1', '-uall') };
if (frozen.dirty.split('\n').filter(Boolean).some(line => line.slice(3) !== 'AGENTS.md')) throw Error('X1_BUILD_REQUIRES_COMMITTED_PRODUCT_SOURCE');
await mkdir(output, { mode: 0o700 });
const runtimeDir = join(output, 'finnor-os/' + label + '-runtime'); await mkdir(runtimeDir, { recursive: true });
let outputBytes = 0;
const files = new Map(), packages = [], sourcePreimages = [], links = new Map();
async function save(path, bytes, kind, mode = 0o444) {
  outputBytes += bytes.length;
  if (outputBytes > limits.finalBuildOutputBytes) throw Error('X1_FINAL_BUILD_OUTPUT_BOUND');
  await mkdir(dirname(join(output, path)), { recursive: true });
  await writeFile(join(output, path), bytes, { flag: 'wx', mode });
  files.set(path, { path, sha256: digest(bytes), bytes: bytes.length, kind, mode });
}
const tracked = git('ls-files', '-z').split('\0').filter(Boolean);
for (const path of tracked) {
  if (!/^(?:finnor-os\/(?:packages|apps|scripts)\/|scope-[^/]+\/|scripts\/release\/)/.test(path)
      && !['package.json','package-lock.json','finnor-os/package.json','finnor-os/package-lock.json',
        'finnor-os/tsconfig.json','finnor-os/tsconfig.base.json','infra/deployment/production.contract.json'].includes(path)) continue;
  if (path.includes('/node_modules/') || path.includes('/.next/') || path.endsWith('.tsbuildinfo')) continue;
  const bytes = await readFile(join(root, path)); await save(path, bytes, 'ORIGINAL_SOURCE');
  sourcePreimages.push({ path, sha256: digest(bytes) });
}
// Workspace symlinks stay wholly inside the installation. Third-party package
// bytes are copied once per physical version and never point into the builder.
const packageDirs = new Map();
for (const item of await readdir(join(backend, 'packages'), { withFileTypes: true })) {
  if (!item.isDirectory()) continue;
  const directory = join(backend, 'packages', item.name), path = join(directory, 'package.json');
  if (existsSync(path)) packageDirs.set(JSON.parse(await readFile(path, 'utf8')).name, directory);
}
const vendorRoots = new Map(), destinations = new Map(), requests = [];
async function internalLink(destination, target) {
  const linkTarget = relative(dirname(join(output, destination)), join(output, target));
  await mkdir(dirname(join(output, destination)), { recursive: true });
  if (!existsSync(join(output, destination))) await symlink(linkTarget, join(output, destination));
  links.set(destination, { path: destination, target: linkTarget });
}
async function dependency(name, from, destination) {
  if (name.startsWith('@finnor/') && packageDirs.has(name)) {
    await internalLink(destination, relative(root, packageDirs.get(name)));
    return;
  }
  let location = from;
  while (true) {
    const candidate = join(location, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) { location = dirname(await realpath(candidate)); break; }
    const parent = dirname(location); if (parent === location) throw Error('X1_INSTALLED_DEPENDENCY_UNAVAILABLE:' + name);
    location = parent;
  }
  if (destinations.has(destination)) {
    if (destinations.get(destination) !== location) throw Error('X1_DEPENDENCY_DESTINATION_VERSION_CONFLICT:' + name);
    return;
  }
  destinations.set(destination, location);
  const prior = vendorRoots.get(location);
  if (prior) {
    await internalLink(destination, prior);
    return;
  }
  vendorRoots.set(location, destination);
  requests.push({ location, destination });
}
const workspaceManifests = [...packageDirs.values()].map(directory => join(directory, 'package.json'));
workspaceManifests.push(join(backend, 'apps/api/package.json'), join(backend, 'apps/worker/package.json'));
for (const path of workspaceManifests) {
  const pkg = JSON.parse(await readFile(path, 'utf8'));
  for (const name of Object.keys(pkg.dependencies ?? {})) await dependency(name, dirname(path), 'finnor-os/node_modules/' + name);
}
for (const [name, directory] of packageDirs) await dependency(name, directory, 'finnor-os/node_modules/' + name);
for (let at = 0; at < requests.length; at++) {
  const { location, destination } = requests[at], pkg = JSON.parse(await readFile(join(location, 'package.json'), 'utf8'));
  const copy = async (directory, path) => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (item.name === 'node_modules' || item.name === '.bin') continue;
      const original = join(directory, item.name), target = path + '/' + item.name;
      const actual = await stat(original);
      if (actual.isDirectory()) await copy(original, target);
      else if (actual.isFile()) await save(target, await readFile(original), 'DEPENDENCY', 0o444 | (actual.mode & 0o111));
      else throw Error('X1_DEPENDENCY_SPECIAL_FILE_REFUSED');
    }
  };
  await copy(location, destination);
  packages.push({ name: pkg.name, version: pkg.version, license: pkg.license ?? 'UNKNOWN',
    installedPath: destination, packageJsonSha256: digest(await readFile(join(location, 'package.json'))) });
  for (const name of Object.keys(pkg.dependencies ?? {})) await dependency(name, location, destination + '/node_modules/' + name);
  for (const name of Object.keys(pkg.optionalDependencies ?? {})) {
    try { await dependency(name, location, destination + '/node_modules/' + name); }
    catch (error) { if (!error.message.startsWith('X1_INSTALLED_DEPENDENCY_UNAVAILABLE:')) throw error; }
  }
  for (const name of Object.keys(pkg.peerDependencies ?? {})) {
    try { await dependency(name, location, destination + '/node_modules/' + name); }
    catch (error) {
      if (!pkg.peerDependenciesMeta?.[name]?.optional || !error.message.startsWith('X1_INSTALLED_DEPENDENCY_UNAVAILABLE:')) throw error;
    }
  }
}
const routes = [];
const apiRoot = join(backend, 'apps/api/app/api');
const scan = async directory => { for (const item of await readdir(directory, { withFileTypes: true })) {
  const path = join(directory, item.name); if (item.isDirectory()) await scan(path);
  else if (item.name === 'route.ts') routes.push({ path, parts: relative(apiRoot, directory).split('/'),
    source: relative(root, path), sha256: digest(await readFile(path)) });
} };
await scan(apiRoot);
routes.sort((a, b) => a.parts.filter(p => p.startsWith('[')).length - b.parts.filter(p => p.startsWith('[')).length
  || b.parts.length - a.parts.length || a.source.localeCompare(b.source));
const registry = `import {startDevelopmentApi} from ${JSON.stringify(join(backend, 'apps/api/dev-server.ts'))};\n`
  + 'const routes=' + '[' + routes.map(r => JSON.stringify({ parts: r.parts, source: r.source, sha256: r.sha256 }).slice(0, -1)
    + ',load:()=>import(' + JSON.stringify(r.path) + ')}').join(',\n') + '];\n'
  + 'const server=await startDevelopmentApi(routes);\n'
  + 'for(const signal of ["SIGTERM","SIGINT"])process.once(signal,()=>server.close(()=>process.exit(0)));\n';
const generated = join(runtimeDir, 'api-registry.entry.mjs');
await writeFile(generated, registry, { flag: 'wx', mode: 0o600 });
const externals = new Set(), native = new Set([...builtinModules, ...builtinModules.map(name => 'node:' + name)]);
const compiled = await build({ absWorkingDir: backend, entryPoints: { api: generated,
  worker: join(backend, w2 ? 'scripts/postz-w2/physical-worker.mts' : 'apps/worker/src/dev-entry.mts'),
  checker: join(backend, w2 ? 'packages/workforce/src/execution-program/index.ts' : 'scripts/frontier5/x1/checker-command.mts'),
  migrations: join(backend, 'packages/db/migrate.ts') },
  outdir: runtimeDir, bundle: true, splitting: true, format: 'esm', platform: 'node', target: 'node22',
  outExtension: { '.js': '.mjs' }, write: false, metafile: true, sourcemap: false, tsconfig: join(backend, 'tsconfig.base.json'),
  banner: { js: 'import {createRequire as __nativeRequire} from "node:module";const require=__nativeRequire(import.meta.url);' },
  plugins: [{ name: 'canonical-source-and-installed-dependencies', setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, args => {
      if (native.has(args.path)) return { path: args.path, external: true };
      if (args.path.startsWith('@finnor/') && args.path !== '@finnor/source-custody') return;
      externals.add(args.path); return { path: args.path, external: true };
    });
    builder.onLoad({ filter: /\.(?:[cm]?ts|tsx|[cm]?js)$/ }, async args => {
      if (!args.path.startsWith(root + sep) || args.path.includes('/node_modules/')) return;
      const original = await readFile(args.path, 'utf8');
      if (args.path === generated || args.path.endsWith('/apps/worker/src/dev-entry.mts')) return;
      if (!original.includes('import.meta.url') && !original.includes('import.meta.dirname')) return;
      const path = relative(root, args.path);
      const contents = 'import {sourceURL as __canonicalSourceURL,sourceDirectory as __canonicalSourceDirectory} from "@finnor/source-custody";\n'
        + original.replace(/import\.meta\.url/g, '__canonicalSourceURL(' + JSON.stringify(path) + ')')
          .replace(/import\.meta\.dirname/g, '__canonicalSourceDirectory(' + JSON.stringify(path) + ')');
      return { contents, loader: args.path.endsWith('.tsx') ? 'tsx' : args.path.endsWith('.js') || args.path.endsWith('.mjs') ? 'js' : 'ts', resolveDir: dirname(args.path) };
    });
  } }] });
for (const asset of compiled.outputFiles) await save(relative(output, asset.path), Buffer.from(asset.contents), 'COMPILED');
// Generated build-time paths are never delivered or used as source custody.
const { unlink } = await import('node:fs/promises'); await unlink(generated);
const base = '517003a4396bc8101a90be4b425ee01de9446740';
const prefix = 'finnor-os/packages/db/migrations/';
const retainedMigrations = git('ls-tree', '-r', '--name-only', base, '--', prefix).split('\n').filter(p => p.endsWith('.sql')).sort();
const legacy = [];
for (const path of retainedMigrations) {
  const bytes = execFileSync('git', ['show', base + ':' + path], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
  if (digest(await readFile(join(root, path))) !== digest(bytes)) throw Error('X1_RETAINED_MIGRATION_PREIMAGE_CHANGED');
  legacy.push({ name: path.slice(prefix.length), sha256: digest(bytes) });
}
const checkerPins = [...files.values()].filter(p => p.kind === 'COMPILED'
  || /(?:institution-program\/(?:checker|checker-raw|canonical-json|installed-runtime)\.ts|source-custody\/(?:index|installation)\.cjs|checker-command\.mts|package-lock\.json)$/.test(p.path)
  || p.path.startsWith('finnor-os/node_modules/zod/')).map(p => p.path).sort();
const manifest = { schema: w2 ? 'finnor.postz.w2.development-installation.v1' : 'finnor.x1.development-installation.v1', mode: 'DEVELOPMENT_ONLY',
  builtAt: new Date().toISOString(), source: frozen, sourcePreimages, files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
  links: [...links.values()].sort((a, b) => a.path.localeCompare(b.path)),
  entrypoints: { api: `finnor-os/${label}-runtime/api.mjs`, worker: `finnor-os/${label}-runtime/worker.mjs`, checker: `finnor-os/${label}-runtime/checker.mjs`,
    migrations: `finnor-os/${label}-runtime/migrations.mjs` },
  checkerPins, routes: routes.map(({ path, ...rest }) => rest), packages, externalImports: [...externals].sort(),
  runtime: { node: process.version, platform: process.platform, architecture: process.arch, nodeBinarySha256: digest(await readFile(process.execPath)) },
  schemaState: { retainedBase: base, retainedMigrations: legacy, migrationCount: files.size ? [...files.keys()].filter(p => p.startsWith(prefix) && p.endsWith('.sql')).length : 0 },
  outputBytes, elapsedMs: Date.now() - started, limits, protectedQualification: false, productionActive: false, executionAuthorityGranted: false };
if (git('rev-parse', 'HEAD') !== frozen.commit || git('status', '--porcelain=v1', '-uall') !== frozen.dirty) throw Error('X1_BUILD_SOURCE_CHANGED');
const manifestBytes = JSON.stringify(manifest, null, 2) + '\n';
if (outputBytes + Buffer.byteLength(manifestBytes) > limits.finalBuildOutputBytes) throw Error('X1_FINAL_BUILD_OUTPUT_BOUND');
await writeFile(join(output, `finnor-os/${label}-development-installation.json`), manifestBytes, { flag: 'wx', mode: 0o444 });
clearTimeout(timer);
console.log(JSON.stringify({ output, source: frozen, compiledAssets: [...files.values()].filter(p => p.kind === 'COMPILED').length,
  actualRoutes: routes.length, packages: packages.length, outputBytes, elapsedMs: manifest.elapsedMs,
  productionActive: false, protectedQualification: false }));
