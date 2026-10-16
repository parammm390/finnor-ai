/** Local emitted installation. No deployment, downloads, or donor links. */
import { build, version as esbuildVersion } from "esbuild";
import { createHash } from "node:crypto";
import {
  constants, copyFileSync, cpSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync,
  readdirSync, readlinkSync, realpathSync, statfsSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const args = process.argv.slice(2), started = performance.now();
if (![2, 4].includes(args.length) || args[0] !== "--output" || !isAbsolute(args[1])
  || args.length === 4 && (args[2] !== "--dependency-seed" || !isAbsolute(args[3])))
  throw Error("NEW_ABSOLUTE_INSTALLATION_OUTPUT_REQUIRED");
const output = resolve(args[1]), runtime = join(output, "runtime"), backend = join(runtime, "finnor-os");
const seed = args[3] ? realpathSync(args[3]) : null;
const inside = (base, path) => path === base || path.startsWith(base + "/");
if (inside(source, output) || inside(output, source) || existsSync(output))
  throw Error("NEW_INSTALLATION_OUTSIDE_CHECKOUT_REQUIRED");
if (esbuildVersion !== "0.25.12") throw Error("LOCKED_ESBUILD_0_25_12_REQUIRED");
mkdirSync(output, { mode: 0o700 }); mkdirSync(runtime, { mode: 0o700 });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const save = (name, body) => writeFileSync(join(output, name), JSON.stringify(body, null, 2) + "\n",
  { mode: 0o444, flag: "wx" });
const git = (...arguments_) => execFileSync("git", ["-C", source, ...arguments_], { encoding: "utf8" }).trim();
const excluded = path => path.split("/").some(part =>
  [".git", ".next", ".vercel", ".cache", ".vite", "evidence"].includes(part) || /^\.env(?:\.|$)/.test(part));
const paths = execFileSync("git", ["-C", source, "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
// Only explicitly owned new source is adopted, never arbitrary untracked captures.
for (const path of [
  "finnor-os/packages/private-equity/src/application-semantics/schema-pattern.ts",
  "finnor-os/packages/db/migrations/0193_frontier5_x2_authority_custody.sql",
  "finnor-os/scripts/x2/build-installed.mjs",
  "finnor-os/scripts/x2/verify-source-contracts.mts",
  "finnor-os/scripts/x2/native-review-gates.mts",
  "finnor-os/scripts/x2/verify-production-domain.mjs",
  "finnor-os/scripts/x2/installed-http-fixture.mts",
  "finnor-os/scripts/x2/installed-runtime-custody.mts",
  "finnor-os/scripts/x2/mounted-native-integration.mts",
  "finnor-os/scripts/x2/verify-native-oracle-custody.mts",
  "finnor-os/scripts/x2/authenticated-http-fixture.mts",
  "finnor-os/scripts/x2/mounted-work.mts",
  "scope-frontier5/x2-software-semantics-compiler/continuation-boundary-contract.md",
  "scope-frontier5/x2-software-semantics-compiler/installed-runtime-contract.md",
  "scope-frontier5/x2-software-semantics-compiler/mounted-work-contract.md",
  "scope-frontier5/x2-software-semantics-compiler/native-discovery-inspection-contract.md",
]) if (existsSync(join(source, path)) && !paths.includes(path)) paths.push(path);
const sourceFiles = [];
for (const path of paths.sort()) {
  if (excluded(path) || !existsSync(join(source, path))) continue;
  const original = join(source, path), target = join(runtime, path), info = lstatSync(original);
  if (!info.isFile() && !info.isSymbolicLink()) throw Error("UNSUPPORTED_INSTALLED_SOURCE_TYPE");
  mkdirSync(dirname(target), { recursive: true });
  if (info.isSymbolicLink()) {
    const resolved = realpathSync(original);
    if (!inside(source, resolved)) throw Error("FOREIGN_SOURCE_LINK_REFUSED");
    symlinkSync(relative(dirname(target), join(runtime, relative(source, resolved))), target);
    sourceFiles.push({ path, kind: "link", target: relative(source, resolved) });
  } else {
    copyFileSync(original, target, constants.COPYFILE_FICLONE);
    sourceFiles.push({ path, bytes: info.size, sha256: hash(readFileSync(original)) });
  }
}
save("source-inputs.json", { head: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"),
  dirtyDiffDigest: hash(execFileSync("git", ["-C", source, "diff", "HEAD", "--binary"])), files: sourceFiles });
const space = statfsSync(output);
save("build-start.json", { startedAt: new Date().toISOString(), source, output,
  freeBytes: Number(space.bavail) * Number(space.bsize), node: process.version,
  platform: process.platform, architecture: process.arch, nodeBinarySha256: hash(readFileSync(process.execPath)),
  emitter: { esbuildVersion, sourceSha256: hash(readFileSync(fileURLToPath(import.meta.url))) },
  qualification: "LOCAL_STAGING_DISPOSABLE_NOT_PROTECTED_ADMISSION_OR_DEPLOYMENT" });
try {
  const seedFiles = new Map();
  if (seed) {
    if (!inside(dirname(source), seed) || inside(source, seed)) throw Error("TASK_OWNED_GENERATED_DEPENDENCY_SEED_REQUIRED");
    const manifest = JSON.parse(readFileSync(join(dirname(seed), "build-manifest.json"), "utf8"));
    const inventory = JSON.parse(readFileSync(join(dirname(seed), "dependency-assets.json"), "utf8"));
    if (manifest.runtime !== seed || hash(JSON.stringify(inventory)) !== manifest.dependencyAssetsDigest)
      throw Error("GENERATED_DEPENDENCY_SEED_IDENTITY_REQUIRED");
    for (const file of inventory) if (file.sha256) seedFiles.set(file.path, file);
  }
  let sharedGeneratedFiles = 0;
  function copyDependencies(original, target) {
    const info = lstatSync(original), name = relative(source, original);
    if (excluded(name)) return;
    if (info.isDirectory()) {
      mkdirSync(target, { recursive: true });
      for (const entry of readdirSync(original)) copyDependencies(join(original, entry), join(target, entry));
    } else if (info.isSymbolicLink()) symlinkSync(readlinkSync(original), target);
    else if (info.isFile()) {
      const prior = seedFiles.get(name), seeded = seed && join(seed, name);
      if (prior && hash(readFileSync(original)) === prior.sha256
        && lstatSync(seeded).isFile() && hash(readFileSync(seeded)) === prior.sha256) {
        linkSync(seeded, target); sharedGeneratedFiles++;
      } else copyFileSync(original, target, constants.COPYFILE_FICLONE);
    } else throw Error("UNSUPPORTED_DEPENDENCY_SEED_TYPE");
  }
  for (const path of ["node_modules", "finnor-os/node_modules"]) {
    const original = join(source, path);
    if (!inside(source, realpathSync(original))) throw Error("FOREIGN_DEPENDENCY_ROOT_REFUSED");
    if (seed) copyDependencies(original, join(runtime, path));
    else cpSync(original, join(runtime, path), { recursive: true, mode: constants.COPYFILE_FICLONE,
        verbatimSymlinks: true, filter: item => !excluded(relative(source, item)) });
  }
  let relocatedLinks = 0;
  function relocate(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) relocate(path);
      else if (entry.isSymbolicLink()) {
        const original = join(source, relative(runtime, path)), resolved = realpathSync(original);
        if (!inside(source, resolved)) throw Error("FOREIGN_DEPENDENCY_LINK_REFUSED");
        const target = join(runtime, relative(source, resolved));
        unlinkSync(path); symlinkSync(relative(dirname(path), target), path); relocatedLinks++;
      }
    }
  }
  relocate(join(runtime, "node_modules")); relocate(join(backend, "node_modules"));
  const emitted = join(backend, "x2-runtime");
  mkdirSync(emitted, { mode: 0o755 });
  writeFileSync(join(emitted, "package.json"), '{"type":"module","private":true}\n', { flag: "wx", mode: 0o444 });
  const compiled = await build({
    absWorkingDir: backend, entryPoints: {
      "physical-worker": "scripts/x2/physical-worker.mts",
      "worker/index": "apps/worker/src/index.ts",
      "ledger-server": "packages/governed-execution/src/ledger-server.mts",
      "s8-server": "packages/capability-evolution/src/server.mts",
      "application-consumer": "packages/capability-evolution/src/application-consumer.ts",
    },
    outdir: emitted, bundle: true, platform: "node", format: "esm", target: "node22",
    write: false, metafile: true, sourcemap: false, tsconfig: join(backend, "tsconfig.json"),
    banner: { js: 'import { createRequire as __x2CreateRequire } from "node:module"; const require = __x2CreateRequire(import.meta.url);' },
    plugins: [{
      name: "installed-native-dependencies-and-source-custody",
      setup(plugin) {
        plugin.onResolve({ filter: /^[^./]|^\// }, ({ path }) => {
          if (!isAbsolute(path) && (!path.startsWith("@finnor/") || path === "@finnor/source-custody"))
            return { path, external: true };
        });
        plugin.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, ({ path }) => {
          if (!inside(runtime, path) || path.includes("/node_modules/")) return;
          let contents = readFileSync(path, "utf8");
          if (/import\.meta\.(?:dirname|url)/.test(contents)) {
            const name = relative(runtime, path).replaceAll("\\", "/");
            if (!/^finnor-os\/(?:packages|scripts|apps)\//.test(name)) throw Error("FOREIGN_EMITTED_SOURCE_METADATA");
            contents = 'import * as __x2SourceCustody from "@finnor/source-custody";\n'
              + contents.replaceAll("import.meta.dirname", `__x2SourceCustody.sourceDirectory(${JSON.stringify(name)})`)
                .replaceAll("import.meta.url", `__x2SourceCustody.sourceURL(${JSON.stringify(name)})`);
          }
          return { contents, loader: path.endsWith("tsx") ? "tsx" : /\.[cm]?ts$/.test(path) ? "ts" : "js" };
        });
      },
    }],
  });
  const emittedFiles = [];
  for (const file of compiled.outputFiles) {
    if (!inside(emitted, file.path)) throw Error("EMITTED_OUTPUT_ESCAPE");
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.contents, { flag: "wx", mode: 0o444 });
    emittedFiles.push({ path: relative(runtime, file.path), bytes: file.contents.length, sha256: hash(file.contents) });
  }
  save("emitter-metafile.json", compiled.metafile);
  console.log(JSON.stringify({ stage: "EMITTED", files: emittedFiles, relocatedLinks }));
  // Bound local build parallelism only. Preserve the original configuration
  // bytes and record this explicit, installation-local build transformation.
  const app = join(backend, "apps/api"), config = join(app, "next.config.mjs");
  copyFileSync(config, join(app, "next.config.x2-original.mjs"), constants.COPYFILE_FICLONE);
  writeFileSync(config, 'import original from "./next.config.x2-original.mjs";\n'
    + 'export default { ...original, experimental: { ...original.experimental, cpus: 2 } };\n', { mode: 0o644 });
  const home = join(output, "build-home"); mkdirSync(home, { mode: 0o700 });
  const buildId = "x2-" + hash(JSON.stringify(sourceFiles));
  execFileSync(process.execPath, [join(backend, "node_modules/next/dist/bin/next"), "build"], {
    cwd: app, stdio: "inherit", timeout: 900000, env: {
      PATH: process.env.PATH, HOME: home, TMPDIR: home, LANG: "C", TZ: "UTC",
      NODE_ENV: "production", NODE_OPTIONS: "--max-old-space-size=3072",
      NEXT_TELEMETRY_DISABLED: "1", CI: "1", FINNOR_BUILD_ID: buildId,
      FINNOR_ENVIRONMENT: "staging", FINNOR_X2_PROFILE: "ordinary_disposable",
      SECRETS_PROVIDER: "env", ALLOW_PLAINTEXT_ENV_SECRETS: "1",
    },
  });
  function inventory(directory, base = runtime) {
    const files = [];
    function visit(current) {
      for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if ([".cache", ".vite"].includes(entry.name)
          || current === join(app, ".next") && entry.name === "cache") continue;
        const path = join(current, entry.name), name = relative(base, path);
        if (entry.isSymbolicLink()) {
          const target = realpathSync(path);
          if (!inside(runtime, target)) throw Error("INSTALLED_RESOLUTION_ESCAPES_RUNTIME");
          files.push({ path: name, kind: "link", target: relative(runtime, target) });
        } else if (entry.isDirectory()) visit(path);
        else if (entry.isFile()) {
          const bytes = readFileSync(path);
          files.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
        } else throw Error("UNSUPPORTED_INSTALLED_ASSET_TYPE");
      }
    }
    visit(directory); return files;
  }
  const dependencies = [...inventory(join(runtime, "node_modules")), ...inventory(join(backend, "node_modules"))];
  const api = inventory(join(app, ".next"));
  save("dependency-assets.json", dependencies); save("api-assets.json", api);
  const locks = ["package-lock.json", "finnor-os/package-lock.json"].map(path => {
    const before = hash(readFileSync(join(source, path))), after = hash(readFileSync(join(runtime, path)));
    if (before !== after) throw Error("INSTALLED_LOCK_CHANGED");
    return { path, sha256: after };
  });
  const identity = { schema: "finnor.x2.installed-asset-identity.v1", buildId,
    emittedFiles, apiAssetsDigest: hash(JSON.stringify(api)), dependencyAssetsDigest: hash(JSON.stringify(dependencies)),
    sourceInputsDigest: hash(JSON.stringify(sourceFiles)), locks,
    node: process.version, platform: process.platform, architecture: process.arch,
    nodeBinarySha256: hash(readFileSync(process.execPath)), esbuildVersion };
  writeFileSync(join(emitted, "identity.json"), JSON.stringify(identity, null, 2) + "\n", { flag: "wx", mode: 0o444 });
  save("build-manifest.json", { ...identity, output, runtime, relocatedLinks, wallMs: performance.now() - started,
    dependencyCopy: { strategy: seed ? "VERIFIED_REGULAR_FILES_FROM_STOPPED_TASK_GENERATED_INSTALLATION" : "COPYFILE_FICLONE",
      seed, sharedGeneratedFiles, noCheckoutHardlinks: true, noRuntimeSeedResolution: true },
    buildConfigurationTransform: { original: "finnor-os/apps/api/next.config.x2-original.mjs", experimentalCpus: 2 },
    sourceLoadedAdapters: "EXPLICIT_RETAINED_CANONICAL_TS_VIA_EXISTING_SOURCE_CUSTODY",
    qualification: "EMITTED_BUILD_NOT_YET_EXECUTED_RECONSTRUCTED_OR_ADMITTED" });
  console.log(JSON.stringify({ stage: "BUILT_NOT_EXECUTED", output, runtime, wallMs: performance.now() - started }));
} catch (error) {
  save("build-failure.json", { status: "FAILED", wallMs: performance.now() - started,
    error: error instanceof Error ? error.message : "UNKNOWN", outputRetained: true });
  throw error;
}
