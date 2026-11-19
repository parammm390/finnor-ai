/** Read-only declaration bridge for the EXISTING coverage auditor.
 * Same original audit, source graph and predicates. No filtered calls/results. */
import Module, { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const pools = [process.env.FINNOR_Z5_TOOLING_POOL, process.env.FINNOR_Z5_TOOLING_BACKEND_POOL].filter(Boolean);
if (!pools.length || !pools.every(p => path.isAbsolute(p))) throw Error("EXPLICIT_DECLARATION_POOLS_REQUIRED");
const ts = createRequire(path.join(pools[0], "package.json"))("typescript"), borrowed = new Set(), graphs = [];
const wrapped = { ...ts, createProgram(rootNames, options, suppliedHost, ...rest) {
  const opts = { ...options, typeRoots: [...new Set([...(options.typeRoots ?? []), ...pools.map(p => path.join(p, "node_modules/@types"))])] };
  const host = suppliedHost ?? ts.createCompilerHost(opts);
  const cache = ts.createModuleResolutionCache(root, p => p, opts);
  host.resolveModuleNames = (names, from) => names.map(name => {
    const original = ts.resolveModuleName(name, from, opts, host, cache).resolvedModule;
    if (original) return original;
    if (name.startsWith(".") || name.startsWith("@finnor/") || name.startsWith("@/") || path.isAbsolute(name)) return undefined;
    for (const pool of pools) {
      const resolved = ts.resolveModuleName(name, path.join(pool, "__z5_coverage_declarations__.ts"), opts, host).resolvedModule;
      if (resolved) { borrowed.add(name); return resolved; }
    }
    return undefined;
  });
  const program = ts.createProgram(rootNames, opts, host, ...rest);
  const source = program.getSourceFiles();
  if (source.some(f => pools.some(pool => f.fileName.startsWith(pool + path.sep)) && !f.fileName.includes("/node_modules/")))
    throw Error("COVERAGE_FOREIGN_PROJECT_SOURCE_REFUSED");
  const own = source.filter(f => f.fileName.startsWith(root + path.sep) && !f.fileName.includes("/node_modules/"))
    .map(f => ({ path: path.relative(root, f.fileName), sha256: createHash("sha256").update(f.text).digest("hex") }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  graphs.push({ roots: rootNames.length, sourceFiles: source.length, ownFiles: own.length,
    ownSourceDigest: createHash("sha256").update(JSON.stringify(own)).digest("hex") });
  return program;
} };
const load = Module._load;
Module._load = function(specifier, parent, ...rest) {
  if (specifier === "typescript" && parent?.filename === path.join(root, "package.json")
    && process.argv[1] === path.join(root, "scripts/centropy/audit-capability-coverage.mjs")) return wrapped;
  return load.call(this, specifier, parent, ...rest);
};
process.once("exit", () => process.stderr.write(JSON.stringify({
  schema: "finnor.z5.coverage-read-only-declarations.v1", compilerVersion: ts.version, pools, graphs,
  fallbackDeclarations: [...borrowed].sort(), borrowedProjectSource: false, installedZ5Proof: false,
  originalAuditAndFailurePredicatesUnchanged: true }) + "\n"));
