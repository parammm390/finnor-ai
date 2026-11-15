/** W3 installation over the existing canonical development-custody owner.
 * The X1-named compatibility manifest is a reused file/byte custody format,
 * not an X1 completion claim or a new admission authority. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, readdir, realpath, lstat, symlink, chmod } from "node:fs/promises";
import { existsSync, statfsSync } from "node:fs";
import { resolve, join, dirname, relative, isAbsolute, sep } from "node:path";
import { builtinModules } from "node:module";
import { createServer } from "node:net";
import { build } from "esbuild";
import { packScientific } from "./pack-scientific.mjs";
import { assertKnownNextTypeInput } from "../../../../scripts/frontier5/x1/frontend-generated-inputs.mjs";

const backend = resolve(import.meta.dirname, "../../.."), root = dirname(backend);
const args = process.argv.slice(2);
assert(args.length === 2 && args[0] === "--output" && isAbsolute(args[1]), "W3_NEW_ABSOLUTE_BUILD_OUTPUT_REQUIRED");
const output = resolve(args[1]);
assert(!existsSync(output), "W3_BUILD_OUTPUT_MUST_BE_NEW");
const limits = JSON.parse(await readFile(join(root, "scope-postz/w3-real-world-fulfillment/verification-manifest.json"), "utf8")).limits;
const started = Date.now(), hash = bytes => createHash("sha256").update(bytes).digest("hex");
const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 16777216, timeout: 30000 }).trimEnd();
const source = { commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}") };
assert.equal(git("status", "--porcelain=v1", "-uall"), "", "W3_BUILD_REQUIRES_COMMITTED_CLEAN_SOURCE");
const capacity = statfsSync(root, { bigint: true });
assert(capacity.bavail * capacity.bsize >= BigInt(limits.minimumFreeDiskGiB) * 1024n ** 3n, "W3_BUILD_MINIMUM_FREE_DISK");
// The reused engine also enforces its existing, potentially stricter, bounds.
const inheritedLimits = JSON.parse(await readFile(join(root,
  "scope-frontier5/x1-institutional-programme-compiler/verification-plan.json"), "utf8")).limits;
const child = spawnSync(process.execPath, ["scripts/frontier5/x1/build-development.mjs", "--output", output], {
  cwd: backend, encoding: "utf8", maxBuffer: 16777216, timeout: limits.integrationSeconds * 1000,
  env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=2048" },
});
assert.equal(child.status, 0, child.stdout + "\n" + child.stderr);
const manifestPath = join(output, "finnor-os/x1-development-installation.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
assert.equal(manifest.schema, "finnor.x1.development-installation.v1");
assert.equal(manifest.source.commit, source.commit);
const files = new Map(manifest.files.map(file => [file.path, file]));
const links = new Map(manifest.links.map(link => [link.path, link]));
let outputBytes = manifest.outputBytes;
function checkBound() {
  assert(outputBytes <= limits.maximumGeneratedDiskGiB * 1024 ** 3, "W3_BUILD_OUTPUT_BYTE_BOUND");
  assert(Date.now() - started < limits.integrationSeconds * 1000, "W3_BUILD_WALL_BOUND");
  const space = statfsSync(output, { bigint: true });
  assert(space.bavail * space.bsize >= BigInt(limits.minimumFreeDiskGiB) * 1024n ** 3n, "W3_BUILD_MINIMUM_FREE_DISK");
}
async function save(path, bytes, kind, mode = 0o444) {
  assert(!files.has(path) && !isAbsolute(path) && !path.split("/").includes(".."), "W3_NEW_PINNED_FILE_REQUIRED");
  outputBytes += bytes.length;
  checkBound();
  await mkdir(dirname(join(output, path)), { recursive: true });
  await writeFile(join(output, path), bytes, { flag: "wx", mode });
  files.set(path, { path, sha256: hash(bytes), bytes: bytes.length, kind, mode });
}
async function internalLink(path, destination) {
  const target = relative(dirname(join(output, path)), join(output, destination));
  await mkdir(dirname(join(output, path)), { recursive: true });
  await symlink(target, join(output, path));
  links.set(path, { path, target });
}
const vendors = new Map();
async function dependency(name, from, destination) {
  let directory = from;
  while (!existsSync(join(directory, "node_modules", name, "package.json"))) {
    const parent = dirname(directory);
    assert(parent !== directory, "W3_INSTALLED_DEPENDENCY_UNAVAILABLE:" + name);
    directory = parent;
  }
  const location = dirname(await realpath(join(directory, "node_modules", name, "package.json")));
  const pkg = JSON.parse(await readFile(join(location, "package.json"), "utf8"));
  if (existsSync(join(output, destination, "package.json"))) {
    assert.equal(hash(await readFile(join(output, destination, "package.json"))),
      hash(await readFile(join(location, "package.json"))), "W3_DEPENDENCY_VERSION_CONFLICT:" + name);
    return;
  }
  if (vendors.has(location)) { await internalLink(destination, vendors.get(location)); return }
  vendors.set(location, destination);
  const excluded = new Set(["node_modules", ".bin", "__pycache__"]), aliases = [];
  async function copy(directory, path) {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (excluded.has(item.name)) continue;
      const original = join(directory, item.name), target = path + "/" + item.name, info = await lstat(original);
      if (info.isDirectory()) await copy(original, target);
      else if (info.isFile()) await save(target, await readFile(original), "DEVELOPMENT_DEPENDENCY", 0o444 | (info.mode & 0o111));
      else if (info.isSymbolicLink()) {
        const resolved = await realpath(original);
        assert(resolved.startsWith(location + sep), "W3_DEPENDENCY_EXTERNAL_LINK_REFUSED");
        assert((await lstat(resolved)).isFile(), "W3_DEPENDENCY_NONFILE_LINK_REFUSED");
        const path = relative(location, resolved);
        assert(!path.split(sep).some(part => excluded.has(part)), "W3_DEPENDENCY_EXCLUDED_LINK_REFUSED");
        const pinned = destination + "/" + path.split(sep).join("/");
        await internalLink(target, pinned);
        aliases.push(pinned);
      }
      else throw Error("W3_DEPENDENCY_SPECIAL_FILE_REFUSED");
    }
  }
  await copy(location, destination);
  for (const target of aliases) assert(files.has(target), "W3_DEPENDENCY_LINK_TARGET_NOT_PINNED");
  manifest.packages.push({ name: pkg.name, version: pkg.version, license: pkg.license ?? "UNKNOWN",
    installedPath: destination, packageJsonSha256: hash(await readFile(join(location, "package.json"))) });
  for (const dep of Object.keys(pkg.dependencies ?? {}))
    await dependency(dep, location, destination + "/node_modules/" + dep);
  for (const dep of Object.keys(pkg.optionalDependencies ?? {})) {
    try { await dependency(dep, location, destination + "/node_modules/" + dep) }
    catch (error) { if (!error.message.startsWith("W3_INSTALLED_DEPENDENCY_UNAVAILABLE:")) throw error }
  }
}
// The owning E2E can execute from installed bytes, without a donor tsx or DB binary.
for (const name of ["tsx", "embedded-postgres"])
  await dependency(name, backend, "finnor-os/node_modules/" + name);
await dependency("playwright", root, "node_modules/playwright");
const tracked = git("ls-files", "-z").split("\0").filter(Boolean);
for (const path of tracked.filter(path =>
  /^(?:src\/|public\/|vendor\/|scripts\/centropy\/)/.test(path)
  || /^(?:next\.config\.mjs|postcss\.config\.[^/]+|tailwind\.config\.[^/]+|tsconfig\.json|next-env\.d\.ts)$/.test(path))) {
  if (files.has(path)) continue;
  const bytes = await readFile(join(root, path));
  await save(path, bytes, "FRONTEND_SOURCE");
  manifest.sourcePreimages.push({ path, sha256: hash(bytes) });
}
const native = new Set([...builtinModules, ...builtinModules.map(name => "node:" + name)]);
const compiled = await build({
  absWorkingDir: backend, entryPoints: {
    worker: join(backend, "scripts/postz/w3/worker.mts"),
    checker: join(backend, "scripts/postz/w3/checker.mts"),
  }, outdir: join(output, "finnor-os/w3-runtime"), bundle: true, splitting: true,
  format: "esm", platform: "node", target: "node22", outExtension: { ".js": ".mjs" },
  write: false, metafile: true, sourcemap: false, tsconfig: join(backend, "tsconfig.base.json"),
  banner: { js: 'import {createRequire as __nativeRequire} from "node:module";const require=__nativeRequire(import.meta.url);' },
  plugins: [{ name: "w3-canonical-source-custody", setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, args => {
      if (native.has(args.path)) return { path: args.path, external: true };
      if (args.path.startsWith("@finnor/") && args.path !== "@finnor/source-custody") return;
      return { path: args.path, external: true };
    });
    builder.onLoad({ filter: /\.(?:[cm]?ts|tsx|[cm]?js)$/ }, async args => {
      if (!args.path.startsWith(root + sep) || args.path.includes("/node_modules/")) return;
      const original = await readFile(args.path, "utf8");
      if (!original.includes("import.meta.url") && !original.includes("import.meta.dirname")) return;
      const path = relative(root, args.path);
      return { contents: 'import {sourceURL as __w3URL,sourceDirectory as __w3Directory} from "@finnor/source-custody";\n'
        + original.replace(/import\.meta\.url/g, "__w3URL(" + JSON.stringify(path) + ")")
          .replace(/import\.meta\.dirname/g, "__w3Directory(" + JSON.stringify(path) + ")"),
      loader: args.path.endsWith(".tsx") ? "tsx" : /\.[cm]?js$/.test(args.path) ? "js" : "ts", resolveDir: dirname(args.path) };
    });
  } }],
});
for (const file of compiled.outputFiles) await save(relative(output, file.path), Buffer.from(file.contents), "COMPILED_W3");
const scientific = await packScientific({ backend, output, save, internalLink, checkBound });
const frontendOrigin = await new Promise((accept, reject) => {
  const server = createServer(); server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const port = server.address().port;
    server.close(() => accept("http://127.0.0.1:" + port)); });
});
const frontendPath = join(output, "frontend");
const frontendInputs = await Promise.all(["next-env.d.ts", "tsconfig.json"].map(async path => {
  const original = execFileSync("git", ["-C", root, "show", source.commit + ":" + path], { maxBuffer: 16777216 });
  assert.equal(hash(await readFile(join(root, path))), hash(original), "W3_FRONTEND_INPUT_CHANGED_BEFORE_BUILD");
  return { path, original };
}));
const generatedInputDeltas = [];
console.log(JSON.stringify({ event: "W3_FRONTEND_BUILD_ORIGINAL_INPUTS", source, frontendOrigin,
  inputs: frontendInputs.map(({ path, original }) => ({ path, sha256: hash(original) })) }));
try {
  const frontendBuild = spawnSync(process.execPath, [join(root, "scripts/frontier5/x1/build-frontend.mjs"),
    "--output", frontendPath, "--origin", frontendOrigin], {
    cwd: root, encoding: "utf8", maxBuffer: 16777216,
    timeout: limits.integrationSeconds * 1000 - (Date.now() - started),
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=2048" },
  });
  process.stdout.write(frontendBuild.stdout ?? ""); process.stderr.write(frontendBuild.stderr ?? "");
  assert.equal(frontendBuild.status, 0, "W3_FRONTEND_BUILD_FAILED");
} finally {
  let restorationError;
  for (const { path, original } of frontendInputs) {
    const current = await readFile(join(root, path));
    if (hash(current) === hash(original)) continue;
    try {
      assertKnownNextTypeInput(path, original, current);
      const delta = { path, originalSha256: hash(original), generatedSha256: hash(current),
        basis: "EXACT_OBSERVED_NEXT_GENERATED_TYPE_INPUT" };
      console.log(JSON.stringify({ event: "W3_NEXT_GENERATED_INPUT_VERIFIED_BEFORE_RESTORE", ...delta }));
      assert.equal(hash(await readFile(join(root, path))), delta.generatedSha256, "W3_NEXT_GENERATED_INPUT_RACED");
      await writeFile(join(root, path), original);
      generatedInputDeltas.push(delta);
      console.log(JSON.stringify({ event: "W3_NEXT_GENERATED_INPUT_RESTORED", path, sha256: hash(original) }));
    } catch (error) {
      restorationError ??= error;
      console.log(JSON.stringify({ event: "W3_NEXT_INPUT_RESTORATION_REFUSED", path,
        originalSha256: hash(original), observedSha256: hash(current), unrelatedEditsRestored: false }));
    }
  }
  if (restorationError) throw restorationError;
}
const frontendManifestPath = "frontend/x1-frontend-installation.json";
const frontendBytes = await readFile(join(output, frontendManifestPath));
const frontend = JSON.parse(frontendBytes);
assert.equal(frontend.source.commit, source.commit);
assert.equal(frontend.source.tree, source.tree);
assert.equal(frontend.productionActive, false);
assert.equal(frontend.frontendOrigin, frontendOrigin);
const orderedDeltas = values => [...values].sort((a, b) => a.path.localeCompare(b.path));
assert.deepEqual(orderedDeltas(generatedInputDeltas), orderedDeltas(frontend.generatedInputDeltas),
  "W3_FINALIZER_AND_RESTORER_INPUT_CUSTODY_MUST_AGREE");
for (const pin of frontend.files) {
  const path = "frontend/" + pin.path;
  assert(!files.has(path));
  const actual = await readFile(join(output, path)), mode = (await lstat(join(output, path))).mode & 0o7777;
  assert.equal(hash(actual), pin.sha256); assert.equal(mode, pin.mode);
  files.set(path, { ...pin, path, kind: "COMPILED_FRONTEND" }); outputBytes += actual.length;
  checkBound();
}
files.set(frontendManifestPath, { path: frontendManifestPath, bytes: frontendBytes.length,
  sha256: hash(frontendBytes), mode: 0o444, kind: "FRONTEND_CUSTODY_MANIFEST" });
outputBytes += frontendBytes.length;
for (const link of frontend.links) links.set("frontend/" + link.path, { ...link, path: "frontend/" + link.path });
checkBound();
manifest.files = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
manifest.links = [...links.values()].sort((a, b) => a.path.localeCompare(b.path));
manifest.entrypoints.w3Worker = "finnor-os/w3-runtime/worker.mjs";
manifest.entrypoints.w3Checker = "finnor-os/w3-runtime/checker.mjs";
manifest.entrypoints.s3Python = scientific.s3.entrypoint;
manifest.entrypoints.s5Python = scientific.s5.entrypoint;
manifest.entrypoints.w3Frontend = "frontend/frontend-host.mjs";
manifest.checkerPins.push(...[...files.values()].filter(file => file.kind === "COMPILED_W3").map(file => file.path),
  ...manifest.sourcePreimages.filter(file => file.path.includes("/real-world-service/")).map(file => file.path));
manifest.outputBytes = outputBytes;
manifest.workload = { scope: "POSTZ.W3", frontend: "PINNED_EMITTED_NEXT_STANDALONE",
  scientificInterpreters: "PINNED_RELOCATED_EXACT_PACKAGE_POPULATIONS",
  mountedBrowser: "DECLARED_HOST_PLAYWRIGHT_MANAGED_VISIBLE_CHROMIUM_WITH_FRESH_PROFILE",
  browserAutomation: "PINNED_INSTALLED_PLAYWRIGHT_PACKAGE_BYTES",
  sourceCheckoutClean: true, fieldValidated: false, admitted: false };
const bytes = JSON.stringify(manifest, null, 2) + "\n";
// This is the generated compatibility manifest owned by this new build.
await chmod(manifestPath, 0o600);
await writeFile(manifestPath, bytes);
await chmod(manifestPath, 0o444);
const descriptor = {
  schema: "finnor.w3.development-installation.v1", mode: "DEVELOPMENT_ONLY", source,
  compatibilityManifest: { path: "finnor-os/x1-development-installation.json", sha256: hash(bytes) },
  entrypoints: manifest.entrypoints, workload: manifest.workload, scientific,
  frontend: { manifest: frontendManifestPath, sha256: hash(frontendBytes), origin: frontendOrigin,
    buildId: frontend.buildId, emitted: true }, outputBytes,
  elapsedMs: Date.now() - started, limits, inheritedCustodyEngineBounds: inheritedLimits,
  qualification: "BUILD_ONLY_REQUIRES_INSTALLED_E2E", productionActive: false, executionAuthorityGranted: false,
};
assert.equal(git("rev-parse", "HEAD"), source.commit);
assert.equal(git("status", "--porcelain=v1", "-uall"), "", "W3_BUILD_SOURCE_CHANGED");
await writeFile(join(output, "finnor-os/w3-development-installation.json"), JSON.stringify(descriptor, null, 2) + "\n",
  { flag: "wx", mode: 0o444 });
console.log(JSON.stringify(descriptor));
