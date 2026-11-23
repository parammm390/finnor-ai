import assert from "node:assert/strict";
import { createRequire, isBuiltin } from "node:module";
import { readFile, writeFile, mkdir, stat, realpath, unlink } from "node:fs/promises";
import { resolve, dirname, relative, isAbsolute } from "node:path";
const [rootArg, outputArg] = process.argv.slice(2);
assert(isAbsolute(rootArg) && isAbsolute(outputArg));
const root = resolve(rootArg), output = resolve(outputArg), backend = resolve(root, "finnor-os");
const require = createRequire(resolve(backend, "package.json")), { build } = require("esbuild");
const config = JSON.parse(await readFile(resolve(backend, "tsconfig.base.json"), "utf8"));
const frontendConfig = JSON.parse(await readFile(resolve(root, "tsconfig.json"), "utf8"));
assert(!relative(backend, output).startsWith(".."), "Emitted modules must resolve only installed dependencies");
await mkdir(output, { recursive: true });
const source = [
  'export {coalitionProductRuntime} from "./finnor-os/packages/private-equity/src/project-z/z2-coalitions/runtime.ts";',
  'export {constructCoalitions,independentlyCheckCoalitions} from "./finnor-os/packages/epistemic-runtime/src/project-z/z2-coalitions/process.ts";',
  'export {runtimeIdentity as nativeRuntimeIdentity,independentlyCheck as independentlyCheckNative} from "./finnor-os/packages/private-equity/src/interaction-synthesis/process.ts";',
].join("\n")+"\n";
const entry = resolve(root, "z2-runtime-entry.mjs");
await writeFile(entry, source, { flag: "wx" });
async function sourcePath(path) {
  for (const suffix of ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs",
    "/index.ts", "/index.tsx", "/index.js"]) {
    const candidate = path+suffix;
    try { if ((await stat(candidate)).isFile()) return candidate; }
    catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; }
  }
  return null;
}
const plugin = { name: "installed-owner-workspace-closure", setup(builder) {
  builder.onResolve({ filter: /^[^./]/ }, async args => {
    if (!args.path.startsWith("@finnor/") && !args.path.startsWith("@/"))
      return { path: args.path, external: true };
    const paths = args.path.startsWith("@/") ? frontendConfig.compilerOptions.paths : config.compilerOptions.paths,
      base = args.path.startsWith("@/") ? root : backend;
    for (const [key, values] of Object.entries(paths).sort(([a], [b]) => b.length-a.length)) {
      const index = key.indexOf("*");
      if (index < 0 ? key !== args.path :
        !args.path.startsWith(key.slice(0, index)) || !args.path.endsWith(key.slice(index+1))) continue;
      const suffix = index < 0 ? "" : args.path.slice(index, args.path.length-(key.length-index-1));
      for (const value of values) {
        const path = await sourcePath(resolve(base, value.replace("*", suffix)));
        if (path) return { path };
      }
    }
    const importer = createRequire(args.importer || resolve(backend, "package.json"));
    const path = await realpath(importer.resolve(args.path));
    assert(!relative(root, path).startsWith(".."));
    return { path };
  });
} };
const entries = [
  ["api-route", resolve(backend, "apps/api/app/api/company-brain/[operation]/route.ts"), "node"],
  ["worker-root", resolve(backend, "apps/worker/src/index.ts"), "node"],
  ["mounted-component", resolve(root, "src/components/centropy/canvas/InteractionProtocolPanel.tsx"), "browser"],
  ["process-a", entry, "node"], ["process-b", entry, "node"],
  ["native-replay", resolve(backend, "scripts/project-z/z2/native-replay.mjs"), "node"],
];
const results = [];
try { for (const [id, entryPoint, platform] of entries) {
  const result = await build({ absWorkingDir: root, entryPoints: [entryPoint], bundle: true,
    platform, format: "esm", target: platform === "node" ? "node22" : "es2022",
    outfile: resolve(output, id+".mjs"), metafile: true, plugins: [plugin],
    ...(platform === "node" ? { banner: { js:
      'import {createRequire as __z2CreateRequire} from "node:module"; '+
      'import {fileURLToPath as __z2FileURLToPath} from "node:url"; '+
      'import {dirname as __z2Dirname} from "node:path"; '+
      'const require=__z2CreateRequire(import.meta.url), __filename=__z2FileURLToPath(import.meta.url), __dirname=__z2Dirname(__filename);' } } : {}),
    tsconfig: resolve(root, platform === "browser" ? "tsconfig.json" : "finnor-os/tsconfig.json"),
    logLevel: "warning" });
  for (const path of Object.keys(result.metafile.inputs)) assert(!relative(root, resolve(root, path)).startsWith(".."));
  const resolver = createRequire(resolve(platform === "browser" ? root : backend, "package.json"));
  for (const file of Object.values(result.metafile.outputs)) for (const item of file.imports) {
    if (!item.external || isBuiltin(item.path)) continue;
    assert(!item.path.startsWith("@finnor/"), "Workspace implementation left external");
    const actual = await realpath(resolver.resolve(item.path));
    assert(!relative(root, actual).startsWith(".."), "External dependency escaped installed target");
  }
  await writeFile(resolve(output, id+".inputs.json"), JSON.stringify(result.metafile, null, 2)+"\n");
  results.push({ id, sourceEntry: relative(root, entryPoint), inputs: Object.keys(result.metafile.inputs).length,
    output: id+".mjs", executed: false });
} } finally { await unlink(entry); }
await writeFile(resolve(output, "owner-bundle-receipt.json"), JSON.stringify({ schema: "finnor.project-z.z2.owner-bundles.v1",
  entries: results, sourceFallbackUsed: false, borrowedNodeModules: false, startupExecuted: false }, null, 2)+"\n");
console.log(JSON.stringify(results));
