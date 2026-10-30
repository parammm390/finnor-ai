// Full-graph engineering check of exact proposed bytes, without changing a
// shared file, creating another worktree or executing any DB/application code.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolve, join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const arg = key => process.argv.find(a => a.startsWith(key + "="))?.slice(key.length + 1);
const mode = arg("--mode"), packet = arg("--packet"), output = arg("--output");
if (!["backend", "frontend", "entry"].includes(mode) || !packet || !output || ![packet, output].every(isAbsolute)) {
  throw Error("Explicit --mode, absolute --packet and fresh absolute --output required");
}
mkdirSync(output, { recursive: false });
const sha = body => createHash("sha256").update(body).digest("hex");
const blob = body => { const b = Buffer.from(body); return createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex"); };
const read = path => readFileSync(path, "utf8"), overlay = new Map();
function apply(before, patch) {
  const original = before.split("\n"), result = [];
  const lines = patch.split("\n");
  let cursor = 0, seen = false, oldCount = 0, newCount = 0, oldUsed = 0, newUsed = 0;
  const close = () => {
    if (seen && (oldUsed !== oldCount || newUsed !== newCount)) throw Error("PATCH_HUNK_COUNTS_CHANGED");
  };
  for (const line of lines) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match) {
      close();
      const start = Math.max(0, Number(match[1]) - 1);
      if (start < cursor) throw Error("PATCH_HUNK_ORDER_CHANGED");
      result.push(...original.slice(cursor, start)); cursor = start;
      oldCount = Number(match[2] ?? 1); newCount = Number(match[4] ?? 1); oldUsed = 0; newUsed = 0; seen = true;
    } else if (seen && line.length) {
      if (line[0] === " " || line[0] === "-") {
        if (original[cursor] !== line.slice(1)) throw Error("PATCH_EXACT_CONTEXT_CHANGED");
        cursor++; oldUsed++;
      }
      if (line[0] === " " || line[0] === "+") { result.push(line.slice(1)); newUsed++; }
      if (![" ", "-", "+"].includes(line[0])) throw Error("PATCH_FORMAT_UNSUPPORTED");
    }
  }
  close();
  if (!seen) throw Error("PATCH_HAS_NO_HUNKS");
  result.push(...original.slice(cursor));
  return result.join("\n");
}
const priorPath = join(repo, "scope-z/phase-evidence/z3/integration-patches/manifest.json");
const prior = JSON.parse(read(priorPath));
for (const p of prior.patches) {
  const path = join(repo, p.path), before = existsSync(path) ? read(path) : "";
  if (p.preimageBlob ? blob(before) !== p.preimageBlob : before !== "") throw Error("PRIOR_PREIMAGE_CHANGED:" + p.path);
  const patch = read(join(repo, "scope-z/phase-evidence/z3/integration-patches", p.patch));
  if (sha(patch) !== p.sha256) throw Error("PRIOR_PATCH_CHANGED");
  const after = apply(before, patch);
  if (blob(after) !== p.postimageBlob) throw Error("PRIOR_POSTIMAGE_CHANGED:" + p.path);
  overlay.set(path, after);
}
const manifestBody = read(join(packet, "manifest.json")), manifest = JSON.parse(manifestBody);
if (manifest.priorNinePatchManifestSha256 !== sha(read(priorPath))) throw Error("PRIOR_PACKET_IDENTITY_CHANGED");
for (const p of manifest.requests) {
  const path = join(repo, p.path), before = overlay.get(path) ?? read(path);
  const after = read(join(packet, p.afterFile)), patch = read(join(packet, p.patchFile));
  if (sha(before) !== p.beforeSha256 || blob(before) !== p.beforeBlob
    || sha(after) !== p.afterSha256 || blob(after) !== p.afterBlob || sha(patch) !== p.patchSha256
    || apply(before, patch) !== after) throw Error("CORRECTION_PREIMAGE_OR_POSTIMAGE_CHANGED:" + p.path);
  overlay.set(path, after);
}
const require = createRequire(join(repo, mode === "frontend" ? "package.json" : "finnor-os/package.json"));
const ts = require("typescript");
const configPath = mode === "frontend" ? join(repo, "tsconfig.json")
  : mode === "entry" ? join(repo, "finnor-os/scripts/project-z/z3/tsconfig.entry-check.json") : join(repo, "finnor-os/tsconfig.json");
const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error) throw Error("TSC_CONFIG_UNAVAILABLE");
const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, resolve(configPath, ".."), { incremental: false, noEmit: true });
if (mode === "frontend") config.fileNames.push(join(repo, "src/components/centropy/world/ViabilityPanel.tsx"));
const host = ts.createCompilerHost(config.options), get = host.getSourceFile.bind(host);
const fileExists = host.fileExists.bind(host), readFile = host.readFile.bind(host);
host.fileExists = path => overlay.has(resolve(path)) || fileExists(path);
host.readFile = path => overlay.get(resolve(path)) ?? readFile(path);
host.getSourceFile = (file, language, onError, fresh) => {
  const body = overlay.get(resolve(file));
  return body === undefined ? get(file, language, onError, fresh) : ts.createSourceFile(file, body, language, true);
};
const started = performance.now();
const program = ts.createProgram(config.fileNames, config.options, host);
const diagnostics = [...config.errors, ...ts.getPreEmitDiagnostics(program)];
const sourceInventory = Object.fromEntries(program.getSourceFiles().filter(s => !s.fileName.includes("/node_modules/"))
  .map(s => [s.fileName.startsWith(repo + "/") ? s.fileName.slice(repo.length + 1) : s.fileName, sha(s.text)]).sort(([a], [b]) => a.localeCompare(b)));
const exitCode = diagnostics.length ? 2 : 0;
const report = { schema: "finnor.z3.native-overlay-typecheck.v2", mode, exitCode,
  status: exitCode ? "FAIL" : "PASS", compilerVersion: ts.version, node: process.version,
  correctionManifestSha256: sha(manifestBody), sourceInventory,
  sourceInventoryDigest: sha(JSON.stringify(sourceInventory)), overlays: [...overlay.keys()].map(p => p.slice(repo.length + 1)),
  diagnostics: diagnostics.map(d => ({ code: d.code, file: d.file?.fileName, message: ts.flattenDiagnosticMessageText(d.messageText, "\n") })),
  wallMs: Math.round(performance.now() - started), qualification: "FULL_SOURCE_GRAPH_WITH_EXACT_PROPOSED_OVERLAYS_NOT_NATIVE_OR_INSTALLED_EXECUTION" };
writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
if (diagnostics.length) console.log(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCanonicalFileName: f => f, getCurrentDirectory: () => repo, getNewLine: () => "\n",
}));
console.log(JSON.stringify({ mode, exitCode, sourceFiles: Object.keys(sourceInventory).length,
  sourceInventoryDigest: report.sourceInventoryDigest, correctionManifestSha256: report.correctionManifestSha256 }));
process.exitCode = exitCode;
