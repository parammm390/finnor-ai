import ts from "typescript";
import { createHash } from "node:crypto";
import { readFile, writeFile, access, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const target = resolve(root, "packages/orchestration/src/capabilities/planner-replay-manifest.json");
const configPath = resolve(root, "tsconfig.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
if (parsed.errors.length) throw new Error(parsed.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"));
const roots = ["packages/orchestration/src/capabilities/gepa-execution.ts", "packages/orchestration/src/capabilities/planner-activation.ts",
  "apps/api/app/api/obligations/[operation]/route.ts", "apps/api/app/api/policies/[operation]/route.ts", "packages/epistemic-runtime/src/allocation-verifier-worker.mjs"];
const queue = roots.map(file => resolve(root, file)), seen = new Set<string>();
while (queue.length) {
  const file = await realpath(queue.pop()!);
  if (seen.has(file) || file === target) continue;
  const name = relative(root, file);
  if (name.startsWith("..") || name.includes("node_modules/")) throw new Error(`REPLAY_SOURCE_OUTSIDE_WORKSPACE:${name}`);
  seen.add(file);
  const body = await readFile(file, "utf8");
  if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
  for (const imported of ts.preProcessFile(body, true, true).importedFiles) {
    const dependency = ts.resolveModuleName(imported.fileName, file, parsed.options, ts.sys).resolvedModule;
    if (!dependency) {
      if (imported.fileName.startsWith(".") || imported.fileName.startsWith("@finnor/")) throw new Error(`UNRESOLVED_REPLAY_IMPORT:${name}:${imported.fileName}`);
      continue;
    }
    const resolved = await realpath(resolve(dependency.resolvedFileName));
    if (!relative(root, resolved).startsWith("..") && !resolved.includes("/node_modules/")) queue.push(resolved);
  }
}
for (const file of ["package.json", "package-lock.json", "tsconfig.json", "tsconfig.base.json", "scripts/release/generate-planner-replay-manifest.mts",
  "apps/api/next.config.mjs", "apps/api/tsconfig.json", "apps/worker/tsconfig.json", "packages/tools/src/capabilities/python/gepa_engine.py",
  "packages/tools/src/capabilities/python/requirements-runtime.lock.txt", "packages/tools/src/capabilities/python/requirements-linux-cpu.lock.txt",
  "packages/epistemic-runtime/src/allocation-solver.py", "packages/epistemic-runtime/src/intervention-numerics.py",
  "packages/epistemic-runtime/src/intervention-requirements.txt", "packages/db/migrations/0150_portfolio_resource_clearing.sql"]) seen.add(resolve(root, file));
for (const file of [...seen]) {
  let directory = dirname(file);
  while (directory.startsWith(root) && directory !== root) {
    const manifest = resolve(directory, "package.json");
    try { await access(manifest); seen.add(manifest); } catch { /* Intermediate source directories are not packages. */ }
    directory = dirname(directory);
  }
}
const sources = await Promise.all([...seen].sort().map(async file => {
  const bytes = await readFile(file); return { file: relative(root, file), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}));
if (sources.length > 1024 || sources.reduce((total, source) => total + source.bytes, 0) > 16 * 1024 * 1024) throw new Error(`PLANNER_REPLAY_MANIFEST_LIMIT_EXCEEDED:${sources.length}:${sources.reduce((total, source) => total + source.bytes, 0)}`);
const manifest = JSON.stringify({ schema: "finnor.planner-replay-source-manifest.v1", roots, sources }, null, 2) + "\n";
if (process.argv.includes("--check")) {
  if (await readFile(target, "utf8") !== manifest) throw new Error("PLANNER_REPLAY_MANIFEST_STALE: npm run capabilities:planner-manifest");
} else await writeFile(target, manifest);
console.log(JSON.stringify({ checked: process.argv.includes("--check"), files: sources.length, manifest: relative(root, target) }));
