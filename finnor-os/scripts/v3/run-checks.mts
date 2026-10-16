/** Registered V3 compiler/catalogue boundary, not runtime qualification. */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const output = process.env.FINNOR_V3_EVIDENCE_DIR;
if (!output?.startsWith("/")) throw Error("Absolute fresh FINNOR_V3_EVIDENCE_DIR required");
await mkdir(output, { recursive: true });
const files = [
  ...execFileSync("git", ["-C", root, "diff", "--name-only"], { encoding: "utf8" }).trim().split("\n"),
  ...execFileSync("git", ["-C", root, "ls-files", "--others", "--exclude-standard", "--", ":(exclude)scope-v/**/evidence/**"], { encoding: "utf8" }).trim().split("\n"),
].filter(path => path && !path.includes("/evidence/"));
const manifest = await Promise.all([...new Set(files)].sort().map(async path => ({
  path, sha256: createHash("sha256").update(await readFile(join(root, path))).digest("hex"),
})));
const startedAt = new Date().toISOString();
await writeFile(join(output, "freeze.json"), JSON.stringify({ startedAt, node: process.version, manifest }, null, 2), { flag: "wx" });
const mountedFiles = [
  "src/components/centropy/closing/ClosingProgrammePanel.tsx",
  "src/components/centropy/world/WorldWorkRecord.tsx", "src/components/centropy/world/WorldExplorer.tsx",
  "src/components/centropy/canvas/CanvasDocument.tsx", "src/components/centropy/canvas/canvas-contract.ts",
  "src/components/centropy/canvas/canvas-compose.ts", "src/components/centropy/lib/business-invalidation.ts",
  "scripts/centropy/generate-capability-manifest.mjs", "scripts/centropy/generate-human-forms.mjs",
];
const checks = [
  { id: "backend-types", executable: "npm", args: ["run", "typecheck"], cwd: join(root, "finnor-os") },
  { id: "frontend-types", executable: join(root, "node_modules/.bin/tsc"), args: ["--noEmit"], cwd: root },
  { id: "mounted-scoped-lint", executable: join(root, "node_modules/.bin/eslint"), args: mountedFiles, cwd: root },
  ...["workspace:check", "centropy:manifest:check", "centropy:client:check", "centropy:forms:check"]
    .map(id => ({ id, executable: "npm", args: ["run", id], cwd: root })),
];
const results = [];
for (const check of checks) {
  const began = performance.now();
  const run = spawnSync(check.executable, check.args, { cwd: check.cwd, encoding: "utf8", timeout: 180000, maxBuffer: 4 * 1024 ** 2 });
  results.push({ ...check, exitCode: run.status, signal: run.signal, stdout: run.stdout, stderr: run.stderr,
    error: run.error?.message ?? null, elapsedMs: performance.now() - began });
  console.log(JSON.stringify({ id: check.id, exitCode: run.status }));
}
const passed = results.every(result => result.exitCode === 0);
await writeFile(join(output, "checks.json"), JSON.stringify({
  schema: "finnor.v3.repository-checks.v1", classification: "COMPILER_AND_GENERATED_CONTRACTS_NOT_RUNTIME_QUALIFICATION",
  startedAt, finishedAt: new Date().toISOString(), manifest, results, passed, costsUsd: null,
  command: "FINNOR_V3_EVIDENCE_DIR=<absolute-fresh-dir> node --import=tsx scripts/v3/run-checks.mts",
}, null, 2), { flag: "wx" });
process.exitCode = passed ? 0 : 1;
