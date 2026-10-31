/** Scoped compiler diagnostics over in-memory coordinator postimages.
 * This does not apply patches, check SQL authority or certify an installed flow. */
import ts from "typescript";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIntegrationChanges, sha256 } from "./prepare-integration.mts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const argument = (name: string) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const group = argument("group");
const manifestPath = argument("manifest");
if (!manifestPath || !group) throw new Error("Explicit --group and absolute --manifest required");
const manifest = JSON.parse(await readFile(resolve(manifestPath), "utf8")) as {
  paths: Array<{ path: string; preimageSha256: string | null; postimageSha256: string }>;
};
const changes = await buildIntegrationChanges(root);
for (const change of changes) {
  const expected = manifest.paths.find(entry => entry.path === change.path);
  if (!expected || expected.preimageSha256 !== (change.before === null ? null : sha256(change.before))
    || expected.postimageSha256 !== sha256(change.after)) throw new Error(`Integration manifest mismatch: ${change.path}`);
}
if (changes.length !== manifest.paths.length) throw new Error("Integration manifest population mismatch");
const app = "finnor-os/packages/private-equity/src/application-semantics";
const p1 = "finnor-os/packages/private-equity/src/program-synthesis";
const scopes: Record<string, string[]> = {
  owned: ["index", "semantics", "original-work-observation", "institution-origin", "institution-allocation", "institution-consumer", "projection"]
    .map(name => `finnor-os/packages/orchestration/src/project-z/z0-convergence/${name}.ts`),
  api: [`${app}/api.ts`, `${app}/native-contracts.ts`, `${app}/ports.ts`, `${app}/store.ts`],
  "s5-s6": [`${app}/allocation.ts`, `${app}/obligations.ts`, `${app}/worker.ts`],
  p1: [`${p1}/institution.ts`, `${p1}/institution-continuation.ts`],
  orchestration: ["finnor-os/packages/orchestration/src/index.ts", "finnor-os/apps/api/app/api/queries/route.ts"],
  frontend: ["src/components/centropy/canvas/application-semantics-client.ts", "src/components/centropy/canvas/ApplicationSemanticsPanel.tsx"],
  scripts: ["prepare-integration", "integration-frontend", "verify-integration-types", "verify-contracts", "prepare-owned-reconstruction"]
    .map(name => `finnor-os/scripts/project-z/z0/${name}.mts`),
};
const scope = scopes[group];
if (!scope) throw new Error("Unknown diagnostic scope");
const configPath = resolve(root, group === "frontend" ? "tsconfig.json"
  : group === "scripts" ? "finnor-os/scripts/project-z/z0/tsconfig.json"
    : "finnor-os/scripts/project-z/z0/tsconfig.runtime.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath));
const overlays = new Map(changes.map(change => [resolve(root, change.path), change.after]));
const options = { ...parsed.options, noEmit: true, incremental: false };
const host = ts.createCompilerHost(options);
const diskRead = host.readFile.bind(host), diskExists = host.fileExists.bind(host);
host.readFile = path => overlays.get(resolve(path)) ?? diskRead(path);
host.fileExists = path => overlays.has(resolve(path)) || diskExists(path);
const files = scope.map(path => resolve(root, path));
const started = performance.now();
const program = ts.createProgram(files, options, host);
const diagnostics = [...parsed.errors, ...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()];
for (const path of files) {
  const source = program.getSourceFile(path);
  if (!source) throw new Error(`Missing diagnostic source: ${path}`);
  diagnostics.push(...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source));
}
console.log(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCanonicalFileName: path => path, getCurrentDirectory: () => root, getNewLine: () => "\n",
}));
console.log(JSON.stringify({
  evidenceClass: "SCOPED_VIRTUAL_POSTIMAGE_DIAGNOSTICS_NOT_FULL_PROJECT_OR_RUNTIME_PROOF",
  group, files: scope, diagnostics: diagnostics.length, manifestPath,
  patchSha256: (JSON.parse(await readFile(resolve(manifestPath), "utf8")) as { patchSha256: string }).patchSha256,
  elapsedMs: Math.round(performance.now() - started), memoryAtCompletion: process.memoryUsage(),
  sharedFilesWritten: false, migrationExecuted: false,
}));
process.exitCode = diagnostics.length ? 1 : 0;
