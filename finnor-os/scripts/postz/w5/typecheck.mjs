/** Scoped semantic coverage, with the complete configured project as context.
 * No substitute declarations, transpile-only success, or hidden diagnostics.
 * This does not claim complete-repository semantic coverage. */
import { strict as assert } from "node:assert";
import ts from "typescript";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, isAbsolute, relative } from "node:path";
import { createHash } from "node:crypto";
const began = performance.now(), backend = resolve(import.meta.dirname, "../../..");
const output = process.argv[2];
assert(output && isAbsolute(output), "W5_TYPECHECK_NEW_ABSOLUTE_OUTPUT_REQUIRED");
await mkdir(output, { mode: 0o700 });
const sha = value => createHash("sha256").update(value).digest("hex");
const walk = async directory => {
  const result = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) result.push(...await walk(path));
    else if (/\.(?:tsx?|mts)$/.test(item.name)) result.push(path);
  }
  return result;
};
const targets = [
  ...await walk(join(backend, "packages/private-equity/src/organization-transformation")),
  ...await walk(join(backend, "apps/api/app/api/organization/transformation-programs")),
  ...await walk(import.meta.dirname),
  ...["apps/worker/src/index.ts", "packages/db/compute-contract.ts",
    "packages/shared-types/src/operational-queries.ts", "packages/orchestration/src/operational-query-runtime.ts",
    "packages/orchestration/src/plugin-registry.ts", "packages/orchestration/src/fast-read-lane.ts",
    "packages/orchestration/src/index.ts", "packages/orchestration/src/objective-loop.ts",
    "packages/orchestration/src/objective-success.ts", "apps/api/app/api/queries/route.ts",
    "packages/private-equity/src/enterprise-control.ts", "packages/private-equity/src/enterprise-allocation.ts",
    "packages/private-equity/src/enterprise-interventions.ts", "packages/governed-execution/src/owner-transport.ts",
    "scripts/w4/run-native-e2e.mts", "scripts/w4/recipient.mts", "scripts/w4/native-growth-journey.mts",
    "scripts/postz/integrated/organization-owner.mts",
    "scripts/postz/w3/native.mts",
    "apps/api/app/api/policies/[operation]/route.ts",
    "packages/epistemic-runtime/src/postz-w5-prospective-trial.ts",
    "packages/epistemic-runtime/src/postz-w5-randomized-effect.ts", "scripts/s6/governed-dispatch-proof.mts"].map(path => join(backend, path)),
].sort();
const configuration = [];
const parsed = ts.getParsedCommandLineOfConfigFile(join(backend, "tsconfig.json"),
  { incremental: false, noEmit: true }, {
    ...ts.sys, onUnRecoverableConfigFileDiagnostic: diagnostic => configuration.push(diagnostic),
  });
assert(parsed && configuration.length === 0 && parsed.options.noEmit && !parsed.options.noCheck,
  "W5_ORIGINAL_DIAGNOSTIC_CONFIGURATION_REQUIRED");
const program = ts.createProgram({ rootNames: [...new Set([...parsed.fileNames, ...targets])],
  options: parsed.options, projectReferences: parsed.projectReferences });
let diagnostics = [...parsed.errors, ...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics(),
  ...program.getSyntacticDiagnostics()];
for (const path of targets) {
  const source = program.getSourceFile(path);
  assert(source && !source.isDeclarationFile, "W5_NATIVE_SEMANTIC_SOURCE_REQUIRED:" + path);
  diagnostics.push(...program.getSemanticDiagnostics(source));
}
diagnostics = ts.sortAndDeduplicateDiagnostics(diagnostics);
const errors = diagnostics.map(diagnostic => {
  const at = diagnostic.file && diagnostic.start !== undefined
    ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : null;
  return { category: ts.DiagnosticCategory[diagnostic.category], code: diagnostic.code,
    file: diagnostic.file ? relative(backend, diagnostic.file.fileName) : null,
    line: at ? at.line + 1 : null, column: at ? at.character + 1 : null,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n") };
});
const graph = program.getSourceFiles().map(source => ({ path: relative(backend, source.fileName),
  sha256: sha(source.text), declaration: source.isDeclarationFile }));
const report = { schema: "finnor.w5.full-context-native-semantic-check.v1",
  status: errors.length ? "FAILED_RETAINED" : "PASS_SCOPED_SEMANTIC_FULL_CONTEXT",
  typescript: ts.version, compilerSha256: sha(await readFile(ts.sys.resolvePath(
    join(backend, "node_modules/typescript/lib/typescript.js")))),
  configuration: { originalProject: "tsconfig.json", roots: parsed.fileNames.length,
    skipLibCheck: parsed.options.skipLibCheck, noCheck: false, noEmit: true, substituteDeclarations: false },
  sourceFilesLoaded: graph.length, sourceGraphDigest: sha(JSON.stringify(graph)), graph,
  semanticTargets: await Promise.all(targets.map(async path => ({ path: relative(backend, path), sha256: sha(await readFile(path)) }))),
  diagnostics: errors, elapsedMs: performance.now() - began, peakRssKiB: process.resourceUsage().maxRSS,
  qualification: "COMPLETE_PROJECT_CONTEXT_WITH_SCOPED_NATIVE_API_WORKER_DRIVER_SEMANTICS_NOT_FULL_REPOSITORY_CHECK" };
await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ ...report, graph: undefined, semanticTargets: report.semanticTargets.map(v => v.path) }));
process.exitCode = errors.length ? 1 : 0;
