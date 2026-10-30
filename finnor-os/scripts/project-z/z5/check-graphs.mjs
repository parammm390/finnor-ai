/** Read-only whole-source engineering check using an explicitly identified
 * installed compiler/declaration pool. This is NOT an installed Z5 proof. */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
const require = createRequire(import.meta.url);
const [repository, graph, compiler, declarationRepository, integrationManifest] = process.argv.slice(2);
if (![repository, compiler, declarationRepository].every(p => p && path.isAbsolute(p))
  || !["frontend", "backend"].includes(graph)) throw Error("Absolute source/compiler/declaration paths and exact graph required");
const ts = require(compiler), root = path.resolve(repository), backend = graph === "backend";
const borrowedDeclarations = path.resolve(declarationRepository) !== root;
const virtual = new Map(); let patchSha256 = null;
if (integrationManifest) {
  if (!path.isAbsolute(integrationManifest)) throw Error("Absolute owned integration manifest required");
  const manifest = JSON.parse(fs.readFileSync(integrationManifest, "utf8"));
  patchSha256 = manifest.patchSha256;
  const hash = bytes => createHash("sha256").update(bytes).digest("hex");
  if (hash(fs.readFileSync(path.join(path.dirname(integrationManifest), "shared.patch"))) !== patchSha256)
    throw Error("Frozen integration patch changed");
  for (const item of manifest.files) {
    if (item.path.startsWith("/") || item.path.split("/").includes("..")) throw Error("Virtual source path escape");
    const target = path.join(root, item.path), payload = path.join(root, item.postimage);
    const before = fs.existsSync(target) ? hash(fs.readFileSync(target)) : null, after = fs.readFileSync(payload, "utf8");
    if (before !== item.preimageSha256 || hash(after) !== item.postimageSha256) throw Error("Exact virtual integration preimage required: " + item.path);
    virtual.set(target, after);
  }
}
const configFile = path.join(root, backend ? "finnor-os/tsconfig.json" : "tsconfig.json");
const config = ts.readConfigFile(configFile, ts.sys.readFile);
if (config.error) throw Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configFile));
for (const target of virtual.keys()) {
  const relative = path.relative(root, target);
  if ((backend ? relative.startsWith("finnor-os/") : relative.startsWith("src/")) && /\.tsx?$/.test(relative)
    && !parsed.fileNames.includes(target)) parsed.fileNames.push(target);
}
const pool = path.join(declarationRepository, backend ? "finnor-os" : "");
const options = { ...parsed.options, noEmit: true, incremental: false,
  typeRoots: [path.join(pool, "node_modules/@types"), path.join(declarationRepository, "node_modules/@types")] };
const host = ts.createCompilerHost(options);
const originalRead = host.readFile, originalExists = host.fileExists, originalGet = host.getSourceFile;
host.readFile = file => virtual.get(path.resolve(file)) ?? originalRead(file);
host.fileExists = file => virtual.has(path.resolve(file)) || originalExists(file);
host.getSourceFile = (file, version, onError, createNew) => virtual.has(path.resolve(file))
  ? ts.createSourceFile(file, virtual.get(path.resolve(file)), version, true)
  : originalGet(file, version, onError, createNew);
const cache = ts.createModuleResolutionCache(root, name => name, options);
const originalResolve = (name, from) => ts.resolveModuleName(name, from, options, host, cache).resolvedModule;
const fallbacks = new Set();
host.resolveModuleNames = (names, containingFile) => names.map(name => {
  const local = originalResolve(name, containingFile);
  if (local) return local;
  if (name.startsWith(".") || name.startsWith("@finnor/") || name.startsWith("@/") || path.isAbsolute(name)) return undefined;
  const result = ts.resolveModuleName(name, path.join(pool, "__z5_read_only_declaration_resolver__.ts"),
    options, host).resolvedModule;
  if (result) fallbacks.add(name);
  return result;
});
host.resolveTypeReferenceDirectives = (names, containingFile) => names.map(input => {
  const name = typeof input === "string" ? input : input.fileName;
  const local = ts.resolveTypeReferenceDirective(name, containingFile, options, host).resolvedTypeReferenceDirective;
  if (local) return local;
  return ts.resolveTypeReferenceDirective(name, path.join(pool, "__z5_read_only_declaration_resolver__.ts"),
    options, host).resolvedTypeReferenceDirective;
});
const started = performance.now(), program = ts.createProgram(parsed.fileNames, options, host);
const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
const format = { getCanonicalFileName: p => p, getCurrentDirectory: () => root, getNewLine: () => "\n" };
if (diagnostics.length) process.stdout.write(ts.formatDiagnostics(diagnostics, format));
const files = program.getSourceFiles(), foreignProjectSource = borrowedDeclarations ? files.filter(f =>
  f.fileName.startsWith(declarationRepository + path.sep) && !f.fileName.includes("/node_modules/")) : [];
if (foreignProjectSource.length) {
  console.log(JSON.stringify({ refusedForeignProjectSource: foreignProjectSource.map(f => f.fileName) }));
  process.exitCode = 2;
}
const ownSources = files.filter(f => f.fileName.startsWith(root + path.sep) && !f.fileName.includes("/node_modules/"))
  .map(f => ({ path: path.relative(root, f.fileName), sha256: createHash("sha256").update(f.text).digest("hex") }))
  .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const changed = ownSources.filter(f => {
  const absolute = path.join(root, f.path), now = virtual.get(absolute) ?? fs.readFileSync(absolute, "utf8");
  return createHash("sha256").update(now).digest("hex") !== f.sha256;
});
if (changed.length) { console.log(JSON.stringify({ sourceChangedDuringCheck: changed.map(f => f.path) })); process.exitCode = 2; }
console.log(JSON.stringify({ schema: "finnor.z5.read-only-engineering-typecheck.v1", graph,
  sourceRepository: root, compiler, compilerVersion: ts.version,
  compilerSha256: createHash("sha256").update(fs.readFileSync(compiler)).digest("hex"),
  declarationRepository, borrowedDeclarations, installedZ5Proof: false,
  rootFiles: parsed.fileNames.length, checkedSourceFiles: files.length, diagnostics: diagnostics.length,
  exactIntegrationManifest: integrationManifest ?? null, patchSha256, sharedFilesActuallyWritten: 0,
  ownSourceFiles: ownSources.length, ownSourceDigest: createHash("sha256").update(JSON.stringify(ownSources)).digest("hex"),
  fallbackPackages: [...fallbacks].sort(), wallMs: performance.now() - started,
  maxRssBytes: process.resourceUsage().maxRSS * 1024 }));
if (diagnostics.some(d => d.category === ts.DiagnosticCategory.Error)) process.exitCode = 1;
