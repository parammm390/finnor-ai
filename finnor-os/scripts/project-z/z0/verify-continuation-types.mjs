/** Full-project diagnostics, not selected-file diagnostics or runtime proof. */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const require = createRequire(resolve(root, "finnor-os/package.json"));
const ts = require("typescript");
const options = Object.fromEntries(process.argv.slice(2).map(value => {
  const match = /^--(coordinator|proposal|output|project)=(.+)$/.exec(value);
  if (!match) throw Error("Z0_TYPECHECK_ARGUMENT_REQUIRED");
  return [match[1], match[2]];
}));
for (const name of ["coordinator", "proposal", "output"]) if (!options[name]?.startsWith("/")) throw Error("Z0_ABSOLUTE_TYPECHECK_PATH_REQUIRED");
if (!["backend", "frontend"].includes(options.project)) throw Error("Z0_FULL_PROJECT_REQUIRED");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const proposal = JSON.parse(await readFile(resolve(options.proposal, "manifest.json"), "utf8"));
const coordinatorReceipt = JSON.parse(await readFile(resolve(options.coordinator,
  "scope-z/orchestration/evidence/shared-computer-launch-09ad1704f3584b7fa561712dad6c4845/z0-integrated-postimage-receipt.json"), "utf8"));
const overlays = new Map();
for (const file of coordinatorReceipt.integratedPostimages) {
  if (!/\.(?:ts|tsx|json)$/.test(file.path)) continue;
  overlays.set(resolve(root, file.path), await readFile(resolve(options.coordinator, file.path), "utf8"));
}
for (const file of proposal.paths) {
  if (sha(await readFile(resolve(options.coordinator, file.path))) !== file.preimageSha256) throw Error("Z0_CURRENT_COORDINATOR_DRIFT");
  const source = await readFile(resolve(options.proposal, "postimages", file.path), "utf8");
  if (sha(source) !== file.postimageSha256) throw Error("Z0_TYPECHECK_PROPOSAL_DRIFT");
  overlays.set(resolve(root, file.path), source);
}
const configuration = resolve(root, options.project === "backend" ? "finnor-os/tsconfig.json" : "tsconfig.json");
const config = ts.readConfigFile(configuration, ts.sys.readFile);
if (config.error) throw Error("Z0_TYPES_CONFIGURATION_UNREADABLE");
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configuration));
const compilerOptions = { ...parsed.options, noEmit: true, incremental: false };
const host = ts.createCompilerHost(compilerOptions), diskRead = host.readFile.bind(host), diskExists = host.fileExists.bind(host);
host.readFile = file => overlays.get(resolve(file)) ?? diskRead(file);
host.fileExists = file => overlays.has(resolve(file)) || diskExists(file);
const started = performance.now(), program = ts.createProgram(parsed.fileNames, compilerOptions, host);
const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
console.log(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCanonicalFileName: file => file, getCurrentDirectory: () => root, getNewLine: () => "\n",
}));
const sourceFiles = program.getSourceFiles().filter(file => file.fileName.startsWith(root + sep)
  && !file.fileName.includes("/node_modules/")).map(file => ({
  path: relative(root, file.fileName), sha256: sha(file.text),
})).sort((a, b) => a.path.localeCompare(b.path));
const receipt = {
  schema: "finnor.project-z.z0.full-proposed-convergence-types.v1", project: options.project,
  evidenceClass: "FULL_PROJECT_VIRTUAL_INTEGRATION_NOT_COORDINATOR_APPLIED_OR_NATIVE_PROOF",
  diagnostics: diagnostics.length, rootFiles: parsed.fileNames.length, sourceFiles,
  sourcePopulationSha256: sha(JSON.stringify(sourceFiles)), proposalPatchSha256: proposal.patchSha256,
  compiler: ts.version, runtime: process.version, elapsedMs: Math.round(performance.now() - started),
  memory: process.memoryUsage(), native: "NOT_RUN", sharedFilesWritten: false,
};
await writeFile(options.output, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ ...receipt, sourceFiles: sourceFiles.length }));
process.exitCode = diagnostics.length ? 1 : 0;
