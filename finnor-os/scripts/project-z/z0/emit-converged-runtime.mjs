/** Complete development emission from independently installed exact locks.
 * Does not migrate, initialize Auth, start listeners or run a business owner. */
import { createRequire, builtinModules, isBuiltin } from "node:module";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir, lstat, readlink, realpath, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const evidenceMarker = "/scope-z/phase-evidence/z0/";
const evidenceRoot = toolRoot.includes(evidenceMarker)
  ? toolRoot.slice(0, toolRoot.indexOf(evidenceMarker)) + evidenceMarker.slice(0, -1)
  : resolve(toolRoot, "scope-z/phase-evidence/z0");
const args = process.argv.slice(2);
if (args.length !== 2 || !args[0].startsWith("--installation=/") || !/^--attempt=[0-9]{2}$/.test(args[1])) {
  throw Error("Z0_INSTALLATION_AND_NEW_ATTEMPT_REQUIRED");
}
const installation = resolve(args[0].slice("--installation=".length)), attempt = args[1].slice("--attempt=".length);
if (!installation.startsWith(evidenceRoot + sep)) throw Error("Z0_OWNED_BUILD_TARGET_REQUIRED");
const root = resolve(installation, "runtime"), backend = resolve(root, "finnor-os");
const source = JSON.parse(await readFile(resolve(installation, "source-snapshot.json"), "utf8"));
if (source.schema !== "finnor.project-z.z0.converged-source-snapshot.v1" || source.runtime !== root
  || process.versions.node.split(".")[0] !== "22" || existsSync(resolve(backend, "x1-development-installation.json"))) {
  throw Error("Z0_FRESH_EXACT_NODE22_INSTALLATION_REQUIRED");
}
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const generatedFrontendChanges = [];
for (const file of source.files) {
  const actual = await readFile(resolve(root, file.path));
  if (sha(actual) === file.sha256) continue;
  // Next's canonical build generator relocates exactly these declaration
  // imports for the existing FINNOR_X1_FRONTEND_INSTALL distDir. It changes no
  // executable product code. Preserve both hashes instead of hiding drift.
  if (file.path === "next-env.d.ts" && existsSync(resolve(root, ".next-x1-install/BUILD_ID"))) {
    const original = actual.toString().replaceAll('import "./.next-x1-install/types/', 'import "./.next/types/');
    if (sha(original) === file.sha256
      && actual.toString() === original.replaceAll('import "./.next/types/', 'import "./.next-x1-install/types/')) {
      generatedFrontendChanges.push({ path: file.path, originalSha256: file.sha256, generatedSha256: sha(actual),
        generator: "CANONICAL_NEXT_FRONTEND_BUILD_DISTDIR_DECLARATIONS" });
      continue;
    }
  }
  throw Error("Z0_SNAPSHOT_SOURCE_CHANGED:" + file.path);
}
const require = createRequire(resolve(backend, "package.json"));
const esbuildPath = require.resolve("esbuild"), typescriptPath = require.resolve("typescript");
for (const path of [esbuildPath, typescriptPath]) if (!(await realpath(path)).startsWith(root + sep)) {
  throw Error("Z0_BORROWED_BUILD_DEPENDENCY_REFUSED");
}
const { build } = require("esbuild"), ts = require("typescript");
const nativePackage = await realpath(require.resolve("fs-ext"));
if (!nativePackage.startsWith(root + sep)
  || !existsSync(resolve(dirname(nativePackage), "build/Release/fs_ext.node"))) throw Error("Z0_FRESH_FS_EXT_NATIVE_BINARY_REQUIRED");
const runtimeDir = resolve(backend, "z0-runtime-" + attempt);
if (existsSync(runtimeDir)) throw Error("Z0_NEW_BUILD_ATTEMPT_REQUIRED");
await mkdir(runtimeDir, { mode: 0o700 });
const files = new Map(), links = [], externals = new Set(), canonicalTransforms = [];
const start = performance.now();
const save = async (path, body, mode = 0o444) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, { flag: "wx", mode });
};
const custodyPath = "finnor-os/packages/source-custody/index.cjs";
const custodyOriginal = await readFile(resolve(root, custodyPath));
const custodyAdapter = await readFile(resolve(toolRoot, "finnor-os/scripts/project-z/z0/installed-source-custody.cjs"));
const loader = await readFile(resolve(toolRoot, "finnor-os/scripts/project-z/z0/installed-loader.mjs"));
const routes = [];
const scanRoutes = async directory => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await scanRoutes(path);
    else if (entry.name === "route.ts") routes.push({
      path, parts: relative(resolve(backend, "apps/api/app/api"), directory).split("/"),
      source: relative(root, path), sha256: sha(await readFile(path)),
    });
  }
};
await scanRoutes(resolve(backend, "apps/api/app/api"));
routes.sort((a, b) => a.parts.filter(p => p.startsWith("[")).length - b.parts.filter(p => p.startsWith("[")).length
  || b.parts.length - a.parts.length || a.source.localeCompare(b.source));
const registry = `import {startDevelopmentApi} from ${JSON.stringify(resolve(backend, "apps/api/dev-server.ts"))};\n`
  + "const routes=[" + routes.map(route => JSON.stringify({ parts: route.parts, source: route.source, sha256: route.sha256 }).slice(0, -1)
    + ",load:()=>import(" + JSON.stringify(route.path) + ")}").join(",\n") + "];\n"
  + "const server=await startDevelopmentApi(routes);\n"
  + 'for(const signal of ["SIGTERM","SIGINT"])process.once(signal,()=>server.close(()=>process.exit(0)));\n';
const entries = {
  api: "z0:actual-api-registry", worker: resolve(backend, "apps/worker/src/dev-entry.mts"),
  checker: resolve(backend, "scripts/frontier5/x1/checker-command.mts"),
  bridge: resolve(backend, "packages/orchestration/src/project-z/z0-convergence/index.ts"),
  migrations: resolve(backend, "packages/db/migrate.ts"),
};
const executableSources = source.files.filter(file => /^(finnor-os\/packages\/|finnor-os\/apps\/)/.test(file.path)
  && /\.(?:[cm]?ts|tsx)$/.test(file.path) && !/\.d\.[cm]?ts$/.test(file.path));
for (const file of executableSources) entries["emitted/" + file.path] = resolve(root, file.path);
const natives = new Set([...builtinModules, ...builtinModules.map(name => "node:" + name)]);
const installedLoaderPath = resolve(runtimeDir, "installed-loader.mjs");
const compiled = await build({
  absWorkingDir: backend, entryPoints: entries, outdir: runtimeDir,
  bundle: true, splitting: true, platform: "node", target: "node22", format: "esm",
  outExtension: { ".js": ".mjs" }, write: false, metafile: true, sourcemap: false,
  tsconfig: resolve(backend, "tsconfig.base.json"), logLevel: "warning",
  banner: { js: 'import {createRequire as __z0CreateRequire} from "node:module";const require=__z0CreateRequire(import.meta.url);' },
  plugins: [{
    name: "exact-installed-canonical-source",
    setup(builder) {
      builder.onResolve({ filter: /^z0:/ }, event => ({ path: event.path, namespace: "z0-generated" }));
      builder.onLoad({ filter: /.*/, namespace: "z0-generated" }, () => ({ contents: registry, loader: "js", resolveDir: backend }));
      builder.onResolve({ filter: /^[^./]/ }, event => {
        if (natives.has(event.path) || isBuiltin(event.path)) return { path: event.path, external: true };
        if (event.path.startsWith("@finnor/") && event.path !== "@finnor/source-custody") return;
        externals.add(event.path); return { path: event.path, external: true };
      });
      builder.onLoad({ filter: /\.(?:[cm]?ts|tsx|[cm]?js)$/ }, async event => {
        if (!event.path.startsWith(root + sep) || event.path.includes("/node_modules/")) return;
        const original = await readFile(event.path, "utf8");
        if (!original.includes("import.meta") && !original.includes("tsx")) return;
        const path = relative(root, event.path), edits = [], invocationRewrites = [];
        const ast = ts.createSourceFile(event.path, original, ts.ScriptTarget.Latest, true);
        const visit = node => {
          // Canonical children use sanitized environments. Their real loader
          // operands, not arbitrary string contents, must select emitted JS too.
          const replaceInvocation = reason => {
            edits.push({ start: node.getStart(ast), end: node.end,
              value: JSON.stringify(reason === "NODE_IMPORT_FLAG" ? "--import=" + installedLoaderPath : installedLoaderPath) });
            invocationRewrites.push({ start: node.getStart(ast), end: node.end, reason });
          };
          if (ts.isStringLiteralLike(node) && node.text === "--import=tsx") {
            replaceInvocation("NODE_IMPORT_FLAG"); return;
          }
          if (ts.isStringLiteralLike(node) && node.text === "tsx" && ts.isArrayLiteralExpression(node.parent)) {
            const siblings = node.parent.elements, position = siblings.indexOf(node);
            if (position > 0 && ts.isStringLiteralLike(siblings[position - 1]) && siblings[position - 1].text === "--import") {
              replaceInvocation("NODE_IMPORT_OPERAND"); return;
            }
          }
          if (ts.isCallExpression(node) && node.arguments.length === 1
            && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text === "tsx"
            && ((ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "resolve")
              || (ts.isIdentifier(node.expression) && node.expression.text === "resolveNativeImport"))) {
            replaceInvocation("CANONICAL_TSX_RESOLUTION_OPERAND"); return;
          }
          if (ts.isPropertyAccessExpression(node) && ts.isMetaProperty(node.expression)
            && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
            && ["url", "dirname"].includes(node.name.text)) {
            edits.push({ start: node.getStart(ast), end: node.end,
              value: `${node.name.text === "url" ? "__z0SourceURL" : "__z0SourceDirectory"}(${JSON.stringify(path)})` });
          }
          ts.forEachChild(node, visit);
        };
        visit(ast);
        if (!edits.length) return;
        let transformed = original;
        for (const edit of edits.sort((a, b) => b.start - a.start)) transformed = transformed.slice(0, edit.start) + edit.value + transformed.slice(edit.end);
        transformed = 'import {sourceURL as __z0SourceURL,sourceDirectory as __z0SourceDirectory} from "@finnor/source-custody";\n' + transformed;
        canonicalTransforms.push({ path, originalSha256: sha(original), emittedInputSha256: sha(transformed),
          syntaxEdits: edits.length, invocationRewrites });
        return { contents: transformed, resolveDir: dirname(event.path),
          loader: event.path.endsWith(".tsx") ? "tsx" : /\.[cm]?js$/.test(event.path) ? "js" : "ts" };
      });
    },
  }],
});
for (const asset of compiled.outputFiles) await save(asset.path, asset.contents);
await save(resolve(runtimeDir, "installed-loader.mjs"), loader);
const sourceMap = executableSources.map(file => ({
  source: file.path, emitted: relative(root, resolve(runtimeDir, "emitted", file.path + ".mjs")),
}));
for (const file of sourceMap) if (!existsSync(resolve(root, file.emitted))) throw Error("Z0_DYNAMIC_NATIVE_ENTRY_NOT_EMITTED:" + file.source);
await save(resolve(runtimeDir, "emitted-source-map.json"), JSON.stringify(sourceMap, null, 2) + "\n");
// Declared installation-only adapter, never a covert edit to canonical source.
await writeFile(resolve(root, custodyPath), custodyAdapter);
await save(resolve(installation, "esbuild-metafile-" + attempt + ".json"), JSON.stringify(compiled.metafile, null, 2) + "\n");
await save(resolve(installation, "canonical-source-transforms-" + attempt + ".json"), JSON.stringify(canonicalTransforms, null, 2) + "\n");
// Every installed link stays in this target. Inventory all dependency/native
// assets, not merely the entrypoint or a copied selected-file dependency list.
let totalBytes = 0;
async function inventory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name), key = relative(root, path), observed = await lstat(path);
    if (observed.isDirectory()) await inventory(path);
    else if (observed.isSymbolicLink()) {
      const target = await readlink(path), actual = await realpath(path);
      if (!actual.startsWith(root + sep)) throw Error("Z0_BORROWED_INSTALLATION_LINK_REFUSED:" + key);
      links.push({ path: key, target });
    } else if (observed.isFile()) {
      const bytes = await readFile(path), mode = 0o444 | (observed.mode & 0o111);
      totalBytes += bytes.length;
      if (totalBytes > 8 * 1024 ** 3) throw Error("Z0_INSTALLATION_BYTE_BOUND");
      await chmod(path, mode);
      files.set(key, { path: key, sha256: sha(bytes), bytes: bytes.length, mode,
        kind: key.includes("/node_modules/") || key.startsWith("node_modules/") ? "FRESH_LOCKED_DEPENDENCY"
          : key.startsWith(relative(root, runtimeDir) + "/") ? "EMITTED_RUNTIME"
            : key === custodyPath ? "DECLARED_EMITTED_ONLY_CUSTODY_ADAPTER" : "ORIGINAL_SOURCE_OR_NATIVE_ASSET" });
    } else throw Error("Z0_INSTALLATION_SPECIAL_FILE_REFUSED");
  }
}
await inventory(root);
const nativeAssets = [...files.values()].filter(file => /\.(?:node|wasm|so(?:\.\d+)*)$/.test(file.path)
  || /\/(?:bin\/esbuild|chrome(?:-headless-shell)?|ffmpeg(?:-linux)?)$/.test(file.path));
const fsNative = [...files.keys()].find(path => /\/fs-ext\/build\/Release\/fs_ext\.node$/.test(path));
if (!fsNative) throw Error("Z0_FRESH_FS_EXT_NATIVE_BINARY_REQUIRED");
const fsExtPath = await realpath(require.resolve("fs-ext"));
if (!fsExtPath.startsWith(root + sep)) throw Error("Z0_NATIVE_PACKAGE_OUTSIDE_TARGET");
require("fs-ext");
const packages = [...files.keys()].filter(path => path.endsWith("/package.json") && path.includes("node_modules/"))
  .map(path => ({ path, sha256: files.get(path).sha256 }));
const externalImports = [];
for (const name of [...externals].sort()) {
  const path = await realpath(require.resolve(name));
  if (!path.startsWith(root + sep)) throw Error("Z0_EXTERNAL_IMPORT_RESOLVES_TO_DONOR:" + name);
  externalImports.push({ specifier: name, resolved: relative(root, path), sha256: sha(await readFile(path)) });
}
const sourceFiles = [...files.values()].filter(file => file.kind !== "FRESH_LOCKED_DEPENDENCY");
const checkerPins = [...files.keys()].filter(path => path.startsWith(relative(root, runtimeDir) + "/")
  || /institution-program\/(?:checker|checker-raw|canonical-json|installed-runtime)\.ts$/.test(path)
  || /source-custody\/(?:index|installation)\.cjs$/.test(path) || /package-lock\.json$/.test(path)
  || /\/node_modules\/(?:zod|pdf-parse|pdfjs-dist|@napi-rs)\//.test(path)).sort();
const manifest = {
  schema: "finnor.x1.development-installation.v1", mode: "DEVELOPMENT_ONLY", builtAt: new Date().toISOString(),
  source: { commit: source.frozen.ownHead, tree: source.frozen.ownTree, snapshotPopulationSha256: source.sourcePopulationSha256,
    snapshotSha256: sha(await readFile(resolve(installation, "source-snapshot.json"))),
    qualification: source.target, coordinatorHead: source.frozen.coordinatorHead, proposalPatchSha256: source.proposalPatchSha256 },
  files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)), links: links.sort((a, b) => a.path.localeCompare(b.path)),
  entrypoints: Object.fromEntries(["api", "worker", "checker", "bridge", "migrations"].map(name =>
    [name, relative(root, resolve(runtimeDir, name + ".mjs"))])),
  checkerPins, routes: routes.map(({ path, ...route }) => route), packages, externalImports,
  sourceCustodyAdapter: { path: custodyPath, originalSha256: sha(custodyOriginal), installedSha256: sha(custodyAdapter),
    source: "finnor-os/scripts/project-z/z0/installed-source-custody.cjs", runtimeTypeScriptFallback: "REFUSED",
    executableSourceMap: relative(root, resolve(runtimeDir, "emitted-source-map.json")),
    preload: relative(root, resolve(runtimeDir, "installed-loader.mjs")) },
  runtime: { node: process.version, platform: process.platform, architecture: process.arch,
    modules: process.versions.modules, nodeBinarySha256: sha(await readFile(process.execPath)) },
  schemaState: { migrationsExecuted: false, grantsExecuted: false,
    migrationCount: sourceFiles.filter(file => /^finnor-os\/packages\/db\/migrations\/.+\.sql$/.test(file.path)).length },
  nativeAssets, emittedSources: sourceMap.length, totalBytes, elapsedMs: Math.round(performance.now() - start),
  buildTool: { esbuild: require("esbuild/package.json").version, typescript: ts.version,
    esbuildPath: relative(root, esbuildPath), typescriptPath: relative(root, typescriptPath),
    builderSha256: sha(await readFile(fileURLToPath(import.meta.url))) },
  generatedFrontendChanges,
  frontend: { buildId: (await readFile(resolve(root, ".next-x1-install/BUILD_ID"), "utf8")).trim(),
    mode: "ACTUAL_NEXT_STANDALONE_BUILD_NOT_STARTED" },
  installedNative: "NOT_RUN", productionActive: false, protectedQualification: false, executionAuthorityGranted: false,
};
await save(resolve(backend, "x1-development-installation.json"), JSON.stringify(manifest, null, 2) + "\n");
await save(resolve(installation, "emitted-closure-" + attempt + ".json"), JSON.stringify({
  ...manifest, files: { count: files.size, populationSha256: sha(JSON.stringify(manifest.files)) },
  checkerPins: { count: checkerPins.length, sha256: sha(JSON.stringify(checkerPins)) }, packages: packages.length,
}, null, 2) + "\n");
console.log(JSON.stringify({ schema: manifest.schema, routes: routes.length, emittedSources: sourceMap.length,
  emittedAssets: compiled.outputFiles.length, packages: packages.length, files: files.size,
  nativeAssets: nativeAssets.length, externalImports: externalImports.length, totalBytes, elapsedMs: manifest.elapsedMs,
  source: manifest.source, runtimeTypeScriptFallback: "REFUSED", installedNative: "NOT_RUN" }));
