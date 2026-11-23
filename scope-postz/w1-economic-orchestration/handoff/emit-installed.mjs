/** Local W1 emitted owning runtime. No deployment or dependency downloads. */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  constants, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync,
  readdirSync, readlinkSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url), source = resolve(dirname(self), "../../..");
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--output" || !isAbsolute(args[1]) || args[2] !== "--plan")
  throw Error("NEW_ABSOLUTE_OUTPUT_AND_FROZEN_PLAN_REQUIRED");
const output = join(realpathSync(dirname(resolve(args[1]))), basename(args[1]));
const planPath = realpathSync(resolve(args[3])), runtime = join(output, "runtime");
const inside = (root, path) => path === root || path.startsWith(root + sep);
if (existsSync(output) || inside(source, output) || inside(output, source))
  throw Error("NEW_INSTALLATION_OUTSIDE_SOURCE_REQUIRED");
if (!inside(source, planPath)) throw Error("CANONICAL_FROZEN_PLAN_INSIDE_SOURCE_REQUIRED");
const plan = JSON.parse(readFileSync(planPath, "utf8"));
if (plan.state !== "FROZEN_EXECUTABLE_W1_SCOPED_NOT_COMPLETE") throw Error("FROZEN_PLAN_REQUIRED");
const started = performance.now(), sha = bytes => createHash("sha256").update(bytes).digest("hex");
const hash = path => sha(readFileSync(path));
const save = (name, body) => writeFileSync(join(output, name), JSON.stringify(body, null, 2) + "\n",
  { flag: "wx", mode: 0o444 });
const verifySource = () => {
  for (const pin of plan.sourceFiles)
    if (!existsSync(join(source, pin.path)) || hash(join(source, pin.path)) !== pin.sha256)
      throw Error("FROZEN_SOURCE_DRIFT:" + pin.path);
  for (const [path, expected] of Object.entries(plan.locks))
    if (hash(join(source, path)) !== expected) throw Error("ORIGINAL_LOCK_DRIFT:" + path);
};
verifySource();
const require = createRequire(join(source, "finnor-os/package.json"));
const { build, version: esbuildVersion } = require("esbuild");
if (esbuildVersion !== "0.25.12") throw Error("ORIGINAL_LOCKED_ESBUILD_0_25_12_REQUIRED");
mkdirSync(output, { mode: 0o700 });
mkdirSync(runtime, { mode: 0o700 });
const excluded = name => name.split("/").some(part =>
  ["node_modules", ".git", ".next", ".next-x1-install", "dist", "__pycache__", ".cache"].includes(part)
  || /^\.env(?:\.|$)/.test(part));
const selected = new Set(plan.sourceFiles.map(pin => pin.path));
selected.add(relative(source, planPath).replaceAll("\\", "/"));
for (const name of ["package.json", "package-lock.json", "finnor-os/package.json",
  "finnor-os/package-lock.json", "finnor-os/tsconfig.json", "finnor-os/tsconfig.base.json",
  "finnor-os/Dockerfile.worker"])
  if (!selected.has(name)) throw Error("REQUIRED_ASSET_MUST_BE_IN_FROZEN_SOURCE:" + name);
for (const pin of plan.lockedVendorAssets)
  if (!selected.has(pin.path) || hash(join(source, pin.path)) !== pin.sha256)
    throw Error("EXACT_LOCK_REFERENCED_VENDOR_ASSET_REQUIRED:" + pin.path);
const sourceFiles = [];
try {
  let sourceBytes = 0;
  for (const name of [...selected].sort()) {
    if (excluded(name) || isAbsolute(name) || name.split("/").includes(".."))
      throw Error("SOURCE_ASSET_PATH_REFUSED:" + name);
    const original = join(source, name), target = join(runtime, name), info = lstatSync(original);
    if (!info.isFile()) throw Error("REGULAR_CANONICAL_SOURCE_REQUIRED:" + name);
    sourceBytes += info.size;
    if (sourceBytes > 384 * 1024 * 1024) throw Error("CANONICAL_SOURCE_ASSET_BYTE_BOUND");
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(original, target, constants.COPYFILE_FICLONE);
    sourceFiles.push({ path: name, bytes: info.size, sha256: hash(original) });
  }
  save("source-inputs.json", { sourceCommit: plan.sourceCommit, frozenPlanSha256: hash(planPath),
    files: sourceFiles, bytes: sourceBytes, emitterSha256: hash(self) });
  for (const name of ["node_modules", "finnor-os/node_modules"]) {
    const original = join(source, name);
    if (!lstatSync(original).isDirectory() || !inside(source, realpathSync(original)))
      throw Error("INDEPENDENT_LOCAL_DEPENDENCY_ROOT_REQUIRED:" + name);
    cpSync(original, join(runtime, name), { recursive: true, mode: constants.COPYFILE_FICLONE,
      verbatimSymlinks: true, filter: path =>
        !relative(original, path).split(sep).some(part => [".cache", ".vite"].includes(part)) });
  }
  const links = [];
  function relocate(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) relocate(path);
      else if (entry.isSymbolicLink()) {
        const original = join(source, relative(runtime, path)), actual = realpathSync(original);
        if (!inside(source, actual)) throw Error("DEPENDENCY_LINK_OUTSIDE_SOURCE:" + relative(runtime, path));
        const target = join(runtime, relative(source, actual)), value = relative(dirname(path), target);
        unlinkSync(path); symlinkSync(value, path);
        if (!inside(runtime, realpathSync(path))) throw Error("DEPENDENCY_LINK_ESCAPES_INSTALLATION");
        links.push({ path: relative(runtime, path), target: value });
      }
    }
  }
  relocate(join(runtime, "node_modules"));
  relocate(join(runtime, "finnor-os/node_modules"));
  const transformations = [];
  const banner = [
    'import {createRequire as __w1CreateRequire,registerHooks as __w1RegisterHooks} from "node:module";',
    'import {readFileSync as __w1Read,appendFileSync as __w1Append} from "node:fs";',
    'import {createHash as __w1Hash} from "node:crypto";',
    'import {fileURLToPath as __w1Path} from "node:url";',
    'const require=__w1CreateRequire(import.meta.url);',
    'const __w1Observe=value=>{if(process.send)process.send({type:"observation",...value});',
    'else console.log("W1_EMITTED_OBSERVATION "+JSON.stringify(value));};',
    '__w1Observe({emittedEntrypoint:import.meta.url,argv:process.argv.slice(0,2),pid:process.pid,',
    'sha256:__w1Hash("sha256").update(__w1Read(__w1Path(import.meta.url))).digest("hex")});',
    '__w1RegisterHooks({load(url,context,next){const path=decodeURIComponent(url);',
    'if(/\\.[cm]?tsx?$/.test(path)&&!path.includes("/node_modules/")){',
    'if(/\\/economic-orchestration\\/|\\/metalevel-policy\\/|\\/compute-search\\/|\\/apps\\/api\\/app\\/api\\/company-brain\\//.test(path))',
    'throw Error("W1_CORE_SOURCE_EXECUTION_REFUSED:"+path);',
    '__w1Observe({sourceLoadedPredecessorAdapter:path,pid:process.pid});}',
    'return next(url,context);}});',
  ].join("\n");
  const backend = join(runtime, "finnor-os");
  const compiled = await build({
    absWorkingDir: backend,
    entryPoints: {
      "finnor-os/scripts/p2/run-e2e": join(backend, "scripts/p2/run-e2e.mts"),
      "finnor-os/scripts/p5/physical-worker": join(backend, "scripts/p5/physical-worker.mts"),
    },
    outdir: runtime, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node",
    format: "esm", target: "node22", keepNames: true, write: false, metafile: true,
    sourcemap: false, tsconfig: join(backend, "tsconfig.json"), banner: { js: banner },
    plugins: [{
      name: "w1-canonical-assets-and-emitted-worker-launch",
      setup(plugin) {
        plugin.onResolve({ filter: /^[^./]/ }, ({ path }) => {
          if (!path.startsWith("@finnor/") || path === "@finnor/source-custody")
            return { path, external: true };
        });
        plugin.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, ({ path }) => {
          if (!inside(runtime, path) || path.includes("/node_modules/")) return;
          const original = readFileSync(path, "utf8"), name = relative(runtime, path).replaceAll("\\", "/");
          let contents = original;
          if (name === "finnor-os/scripts/p5/native-worker-client.mts") {
            const before = "'./physical-worker.mts'", after = "'./physical-worker.mjs'";
            if (contents.split(before).length !== 2) throw Error("EXACT_ORIGINAL_WORKER_LAUNCH_REQUIRED");
            contents = contents.replace(before, after);
            transformations.push({ path: name, kind: "FIXTURE_ENTRYPOINT_EXTENSION_ONLY", before, after,
              originalSha256: sha(original), transformedSha256: sha(contents) });
          }
          if (/import\.meta\.(?:dirname|url)/.test(contents)) {
            const before = contents;
            contents = 'import * as __w1SourceCustody from "@finnor/source-custody";\n'
              + contents.replaceAll("import.meta.dirname", `__w1SourceCustody.sourceDirectory(${JSON.stringify(name)})`)
                .replaceAll("import.meta.url", `__w1SourceCustody.sourceURL(${JSON.stringify(name)})`);
            transformations.push({ path: name, kind: "EXISTING_CANONICAL_SOURCE_METADATA_ADAPTER",
              originalSha256: sha(before), transformedSha256: sha(contents) });
          }
          return { contents, resolveDir: dirname(path),
            loader: path.endsWith("tsx") ? "tsx" : /\.[cm]?ts$/.test(path) ? "ts" : "js" };
        });
      },
    }],
  });
  const emittedFiles = [];
  for (const asset of compiled.outputFiles) {
    if (!inside(runtime, asset.path) || existsSync(asset.path)) throw Error("NEW_EMITTED_ASSET_REQUIRED");
    mkdirSync(dirname(asset.path), { recursive: true });
    writeFileSync(asset.path, asset.contents, { flag: "wx", mode: 0o444 });
    emittedFiles.push({ path: relative(runtime, asset.path), bytes: asset.contents.length, sha256: sha(asset.contents) });
  }
  const inputNames = Object.keys(compiled.metafile.inputs);
  for (const suffix of [
    "packages/private-equity/src/economic-orchestration/controller.ts",
    "packages/private-equity/src/economic-orchestration/policy.ts",
    "packages/epistemic-runtime/src/metalevel-policy/checker.ts",
    "apps/api/app/api/company-brain/[operation]/route.ts",
    "scripts/postz-w1/native-observe.mts",
  ]) if (!inputNames.some(path => path.endsWith(suffix))) throw Error("REQUIRED_CORE_NOT_EMITTED:" + suffix);
  save("emitter-metafile.json", compiled.metafile);
  save("emitter-transformations.json", transformations);
  const dependencyAssets = [];
  function inventory(directory) {
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, item.name), name = relative(runtime, path);
      if (item.isDirectory()) inventory(path);
      else if (item.isSymbolicLink()) {
        if (!inside(runtime, realpathSync(path))) throw Error("INSTALLED_DEPENDENCY_ESCAPE:" + name);
        dependencyAssets.push({ path: name, kind: "link", target: readlinkSync(path) });
      } else if (item.isFile()) dependencyAssets.push({ path: name, bytes: statSync(path).size, sha256: hash(path) });
      else throw Error("UNSUPPORTED_DEPENDENCY_ASSET");
    }
  }
  inventory(join(runtime, "node_modules")); inventory(join(backend, "node_modules"));
  save("dependency-assets.json", dependencyAssets);
  const locks = Object.entries(plan.locks).map(([path, expected]) => {
    if (hash(join(runtime, path)) !== expected) throw Error("COPIED_LOCK_DRIFT");
    return { path, sha256: expected };
  });
  verifySource();
  const manifest = { schema: "finnor.w1.emitted-owning-runtime.v1", status: "BUILT_NOT_EXECUTED",
    builtAt: new Date().toISOString(), sourceCommit: plan.sourceCommit, frozenPlanSha256: hash(planPath),
    runtime, source, sourceInputsSha256: hash(join(output, "source-inputs.json")), emittedFiles, locks,
    dependencyAssetsSha256: hash(join(output, "dependency-assets.json")), dependencyAssets: dependencyAssets.length,
    dependencyMaterialization: "COPYFILE_FICLONE_REGULAR_FILES_AND_RUNTIME_INTERNAL_LINKS_NOT_FRESH_INSTALL",
    entrypoints: { owningSuite: "finnor-os/scripts/p2/run-e2e.mjs",
      physicalWorker: "finnor-os/scripts/p5/physical-worker.mjs" },
    sourceLoadedAdapters: "EXPLICIT_EXISTING_SOURCE_CUSTODY_PREDECESSOR_ADAPTERS_RECORDED_AT_EXECUTION_CORE_TS_REFUSED",
    emitterSha256: hash(self), emitterVersion: esbuildVersion, transformationsSha256: hash(join(output, "emitter-transformations.json")),
    node: { path: realpathSync(process.execPath), version: process.version, sha256: hash(process.execPath) },
    platform: process.platform, architecture: process.arch, elapsedMs: performance.now() - started,
    protectedAdmission: false, productionActive: false, costUSD: null };
  save("build-manifest.json", manifest);
  console.log(JSON.stringify({ status: manifest.status, runtime, emittedFiles,
    sourceFiles: sourceFiles.length, dependencyAssets: dependencyAssets.length, elapsedMs: manifest.elapsedMs }));
} catch (error) {
  save("build-failure.json", { status: "FAIL", message: String(error), elapsedMs: performance.now() - started,
    outputRetained: true, costUSD: null });
  throw error;
}
