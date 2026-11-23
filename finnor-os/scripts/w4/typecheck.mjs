/** Exact original-project context with complete owned/shared target diagnostics.
 * This is scoped semantic coverage, not a full-repository success claim. */
import assert from "node:assert/strict";
import ts from "typescript";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, isAbsolute, relative, dirname } from "node:path";
import { createHash } from "node:crypto";
const began = performance.now(), backend = resolve(import.meta.dirname, "../.."), output = process.argv[2];
const frontend = process.argv[3] === "--ui", contextRoot = frontend ? dirname(backend) : backend;
assert(process.argv.length === 3 || process.argv.length === 4 && frontend, "W4_EXACT_SEMANTIC_PROJECT_MODE_REQUIRED");
assert(process.execArgv.includes("--max-old-space-size=1536"), "W4_GRANTED_1536_MIB_NODE_HEAP_REQUIRED");
assert(output && isAbsolute(output), "W4_TYPECHECK_NEW_ABSOLUTE_OUTPUT_REQUIRED");
await mkdir(output, { mode: 0o700 });
const sha = value => createHash("sha256").update(value).digest("hex");
const checkerPath = join(import.meta.dirname, "typecheck.mjs"), checkerSha256 = sha(await readFile(checkerPath));
const walk = async directory => {
  const result = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) result.push(...await walk(path));
    else if (/\.(?:tsx?|mts)$/.test(item.name)) result.push(path);
  }
  return result;
};
const targets = frontend ? ["GrowthOperatingProgramPanel.tsx", "GrowthOwnerControls.tsx",
  "GrowthParticipantControls.tsx", "growth-program-contracts.ts", "WorldWorkRecord.tsx", "WorldExplorer.tsx"]
  .map(path => join(contextRoot, "src/components/centropy/world", path))
  .concat(join(contextRoot, "src/components/centropy/canvas/WorkforceParticipantWorkspace.tsx")) : [
  ...await walk(join(backend, "packages/private-equity/src/demand-to-business")),
  ...await walk(join(backend, "apps/api/app/api/demand-to-business")),
  ...await walk(import.meta.dirname),
  ...["apps/worker/src/index.ts", "packages/db/compute-contract.ts",
    "packages/governed-execution/src/dispatch-broker.ts",
    "scripts/generate-openapi.ts",
    "scripts/bundle-migrations.ts", "packages/db/migrations-bundle.ts", "packages/db/migration-head.ts",
    "packages/private-equity/src/index.ts", "packages/private-equity/src/allocation-store.ts",
    "packages/private-equity/src/enterprise-obligations.ts", "scripts/s5/owner-fixture.mts"].map(path => join(backend, path)),
].sort();
const configuration = [];
const parsed = ts.getParsedCommandLineOfConfigFile(join(contextRoot, "tsconfig.json"),
  { incremental: false, noEmit: true }, { ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: diagnostic => configuration.push(diagnostic) });
assert(parsed && configuration.length === 0 && parsed.options.noEmit && !parsed.options.noCheck,
  "W4_ORIGINAL_DIAGNOSTIC_CONFIGURATION_REQUIRED");
const program = ts.createProgram({ rootNames: [...new Set([...parsed.fileNames, ...targets])],
  options: parsed.options, projectReferences: parsed.projectReferences });
let diagnostics = [...parsed.errors, ...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics(),
  ...program.getSyntacticDiagnostics()];
for (const path of targets) {
  const source = program.getSourceFile(path);
  assert(source && !source.isDeclarationFile, "W4_NATIVE_SEMANTIC_SOURCE_REQUIRED:" + path);
  diagnostics.push(...program.getSemanticDiagnostics(source));
}
diagnostics = ts.sortAndDeduplicateDiagnostics(diagnostics);
const errors = diagnostics.map(diagnostic => {
  const at = diagnostic.file && diagnostic.start !== undefined
    ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : null;
  return { category: ts.DiagnosticCategory[diagnostic.category], code: diagnostic.code,
    file: diagnostic.file ? relative(contextRoot, diagnostic.file.fileName) : null,
    line: at ? at.line + 1 : null, column: at ? at.character + 1 : null,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n") };
});
const graph = program.getSourceFiles().map(source => ({ path: relative(contextRoot, source.fileName),
  sha256: sha(source.text), declaration: source.isDeclarationFile }));
const semanticTargets = await Promise.all(targets.map(async path => {
  const bytes = await readFile(path), loaded = program.getSourceFile(path);
  assert(loaded && loaded.text === bytes.toString("utf8"), "W4_SEMANTIC_TARGET_CHANGED_DURING_CHECK:" + path);
  return { path: relative(contextRoot, path), sha256: sha(bytes) };
}));
assert.equal(sha(await readFile(checkerPath)), checkerSha256, "W4_SEMANTIC_CHECKER_CHANGED_DURING_CHECK");
const peakRssKiB = process.resourceUsage().maxRSS, rssWithinBound = peakRssKiB <= 2048 * 1024;
const report = { schema: "finnor.w4.full-context-native-semantic-check.v1",
  status: errors.length || !rssWithinBound ? "FAILED_RETAINED" : "PASS_SCOPED_SEMANTIC_FULL_CONTEXT",
  checkerSha256, typescript: ts.version,
  compilerSha256: sha(await readFile(ts.sys.resolvePath(join(backend, "node_modules/typescript/lib/typescript.js")))),
  configuration: { originalProject: frontend ? "../tsconfig.json" : "tsconfig.json",
    context: frontend ? "FRONTEND" : "BACKEND", roots: parsed.fileNames.length,
    strict: parsed.options.strict, noUncheckedIndexedAccess: parsed.options.noUncheckedIndexedAccess,
    skipLibCheck: parsed.options.skipLibCheck, noCheck: false, noEmit: true, substituteDeclarations: false },
  sourceFilesLoaded: graph.length, sourceGraphDigest: sha(JSON.stringify(graph)), graph,
  semanticTargets, diagnostics: errors, elapsedMs: performance.now() - began, peakRssKiB,
  resourceAssessment: { heapMiB: 1536, maximumRssMiB: 2048, rssWithinBound, outerWallSeconds: 120 },
  qualification: "FULL_PROJECT_CONTEXT_WITH_SCOPED_OWNED_AND_SHARED_SEMANTICS_NOT_FULL_REPOSITORY_CHECK" };
await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ ...report, graph: undefined, semanticTargets: report.semanticTargets.map(v => v.path) }));
process.exitCode = errors.length || !rssWithinBound ? 1 : 0;
