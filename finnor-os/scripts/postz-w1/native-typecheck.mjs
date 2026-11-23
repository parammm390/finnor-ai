import ts from "typescript";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

const backend = resolve(import.meta.dirname, "../..");
const leaf = join(backend, "packages/private-equity/src/economic-orchestration");
const destination = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw Error("New evidence destination required");
await mkdir(destination, { recursive: false });
const rootNames = (await readdir(leaf)).filter(path => path.endsWith(".ts")).map(path => join(leaf, path));
rootNames.push(...(await readdir(import.meta.dirname)).filter(path => /^native-.*\.mts$/.test(path)).map(path => join(import.meta.dirname, path)));
const overlay = new Map(), originalRoots = [...rootNames], ownedRoots = new Set(rootNames);
let manifestSha256 = null;
if (process.argv[3]) {
  const proposalDirectory = resolve(process.argv[3]), bytes = await readFile(join(proposalDirectory, "manifest.json"));
  manifestSha256 = createHash("sha256").update(bytes).digest("hex");
  const manifest = JSON.parse(bytes.toString());
  for (const proposal of manifest.proposals) {
    const path = resolve(backend, "..", proposal.normalizedPath);
    if (!path.startsWith(resolve(backend, "..") + "/")) throw Error("Proposal source path escaped checkout");
    if (proposal.originalSha256 !== null) {
      const actual = createHash("sha256").update(await readFile(path)).digest("hex");
      if (actual !== proposal.originalSha256) throw Error("Proposal preimage changed: " + proposal.normalizedPath);
    } else {
      let present = false;
      try { await readFile(path); present = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (present) throw Error("Proposed new shared path is no longer absent: " + proposal.normalizedPath);
    }
    const source = await readFile(join(proposalDirectory, proposal.fullProposedSource), "utf8");
    if (createHash("sha256").update(source).digest("hex") !== proposal.proposedSha256) throw Error("Proposed source digest mismatch");
    if (!/\.(?:tsx?|mts)$/.test(path)) continue;
    overlay.set(path, source); rootNames.push(path);
    if (proposal.originalSha256 !== null) originalRoots.push(path);
  }
}
const config = ts.readConfigFile(join(backend, "tsconfig.json"), ts.sys.readFile);
if (config.error) throw Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, backend);
const options = { ...parsed.options, noEmit: true, incremental: false };
function compile(roots, overrides) {
  const host = ts.createCompilerHost(options), read = host.readFile.bind(host), exists = host.fileExists.bind(host);
  const source = host.getSourceFile.bind(host);
  host.readFile = path => overrides.get(resolve(path)) ?? read(path);
  host.fileExists = path => overrides.has(resolve(path)) || exists(path);
  host.getSourceFile = (path, language, onError, shouldCreateNew) => overrides.has(resolve(path)) ?
    ts.createSourceFile(path, overrides.get(resolve(path)), language, true) : source(path, language, onError, shouldCreateNew);
  const program = ts.createProgram({ rootNames: roots, options, host });
  const diagnostics = [...program.getOptionsDiagnostics()];
  for (const path of roots) {
    const file = program.getSourceFile(path);
    if (!file) throw Error("Target TypeScript source absent: " + path);
    diagnostics.push(...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file));
  }
  return { program, diagnostics: diagnostics.map(format) };
}
function format(diagnostic) {
  const at = diagnostic.file && diagnostic.start !== undefined ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : null;
  return { code: diagnostic.code, category: ts.DiagnosticCategory[diagnostic.category], file: diagnostic.file?.fileName ?? null,
    line: at ? at.line + 1 : null, column: at ? at.character + 1 : null, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n") };
}
const baseline = overlay.size ? compile(originalRoots, new Map()).diagnostics
  .filter(diagnostic => !diagnostic.file || !ownedRoots.has(resolve(diagnostic.file))) : [];
const checked = compile(rootNames, overlay);
const key = diagnostic => JSON.stringify([diagnostic.code, diagnostic.category, diagnostic.file, diagnostic.message]);
const prior = new Map();
for (const diagnostic of baseline) prior.set(key(diagnostic), (prior.get(key(diagnostic)) ?? 0) + 1);
const introduced = checked.diagnostics.filter(diagnostic => {
  const count = prior.get(key(diagnostic)) ?? 0;
  if (count) { prior.set(key(diagnostic), count - 1); return false; }
  return true;
});
const sources = await Promise.all(rootNames.map(async path => ({ path, virtualProposal: overlay.has(path),
  sha256: createHash("sha256").update(overlay.get(path) ?? await readFile(path)).digest("hex") })));
const result = { schema: "finnor.w1.native-owned-typecheck.v1", status: introduced.length ? "FAIL" : "PASS", typescript: ts.version,
  sourceFilesLoaded: checked.program.getSourceFiles().length, checkedFiles: rootNames.length, sources,
  diagnostics: checked.diagnostics, baselineDiagnostics: baseline, introducedDiagnostics: introduced, manifestSha256,
  sharedProposalsApplied: false,
  scope: overlay.size ? "OWNED_LEAVES_PLUS_EXACT_PREIMAGE_VIRTUAL_OWNER_OVERLAY_NOT_RUNTIME_OR_FULL_REPOSITORY_CHECK" :
    "OWNED_LEAVES_AND_NATIVE_DRIVERS_ONLY_NOT_FULL_REPOSITORY_BUILD_OR_TYPECHECK" };
await writeFile(join(destination, "typecheck.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ ...result, sources: undefined }));
process.exitCode = introduced.length ? 1 : 0;
