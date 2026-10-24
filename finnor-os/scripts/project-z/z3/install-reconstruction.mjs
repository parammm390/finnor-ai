// Explicit own-lock engineering install/build. No DB, auth, listener or effect
// command exists here. Run under the coordinator's shared heavy lock.
import { readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join, isAbsolute, dirname } from "node:path";
const arg = key => process.argv.find(a => a.startsWith(key + "="))?.slice(key.length + 1);
const reconstruction = arg("--reconstruction"), output = arg("--output");
if (![reconstruction, output].every(p => p && isAbsolute(p))) throw Error("Absolute reconstruction and fresh output required");
mkdirSync(output, { recursive: false, mode: 0o700 });
const source = join(reconstruction, "source"), backend = join(source, "finnor-os");
const sha = body => createHash("sha256").update(body).digest("hex");
const json = p => JSON.parse(readFileSync(p, "utf8"));
const manifest = json(join(reconstruction, "manifest.json"));
const inventory = json(join(reconstruction, "source-inventory.json"));
if (sha(readFileSync(join(reconstruction, "source-inventory.json"))) !== manifest.inventorySha256
  || sha(readFileSync(join(reconstruction, "source.tar.gz"))) !== manifest.archiveSha256) throw Error("RECONSTRUCTION_SOURCE_IDENTITY_CHANGED");
for (const [p, expected] of Object.entries(inventory)) {
  if (lstatSync(join(source, p)).isSymbolicLink() || sha(readFileSync(join(source, p))) !== expected) throw Error("FRESH_SOURCE_CHANGED:" + p);
}
for (const p of [join(source, "node_modules"), join(backend, "node_modules")]) {
  if (existsSync(p)) throw Error("INSTALL_TARGET_NOT_FRESH");
}
const steps = [];
const environment = { PATH: dirname(process.execPath) + ":" + (process.env.PATH ?? "/usr/bin:/bin"),
  HOME: process.env.HOME, LANG: "C.UTF-8", CI: "1", NEXT_TELEMETRY_DISABLED: "1",
  AWS_EC2_METADATA_DISABLED: "true", AWS_CONFIG_FILE: "/dev/null", AWS_SHARED_CREDENTIALS_FILE: "/dev/null" };
function run(name, command, args, cwd, graph = false) {
  const started = performance.now();
  const result = spawnSync(command, args, { cwd, env: { ...environment,
    NODE_OPTIONS: "--max-old-space-size=" + (graph ? 4096 : 1536) },
    encoding: "utf8", timeout: graph ? 900000 : 600000, maxBuffer: 16 * 1024 * 1024 });
  const log = [result.stdout ?? "", result.stderr ?? "", result.error?.message ?? ""].join("\n");
  writeFileSync(join(output, name + ".log"), log, { flag: "wx" });
  const step = { name, command: [command, ...args], cwd, exitCode: result.status, signal: result.signal,
    spawnError: result.error?.code ?? null, wallMs: Math.round(performance.now() - started), logSha256: sha(log) };
  steps.push(step); console.log(JSON.stringify(step));
  return result.status === 0 && !result.error;
}
run("toolchain-npm", "npm", ["--version"], source);
run("toolchain-python", "/usr/bin/python3.12", ["--version"], source);
run("toolchain-gcc", "gcc", ["--version"], source);
const frontendInstalled = run("root-ci", "npm", ["ci", "--no-audit", "--no-fund"], source);
const backendInstalled = run("backend-ci", "npm", ["ci", "--no-audit", "--no-fund"], backend);
if (frontendInstalled) {
  for (const check of ["workspace:check", "centropy:manifest:check", "centropy:coverage:check",
    "centropy:client:check", "centropy:forms:check"]) run(check.replaceAll(":", "-"), "npm", ["run", check], source);
  run("frontend-lint", "npm", ["run", "lint"], source);
}
if (backendInstalled) {
  // Fresh npm ci may skip install scripts not covered by the allowScripts
  // policy; rebuild the one native module explicitly, as done in the live lane.
  run("native-rebuild", "npm", ["rebuild", "fs-ext"], backend);
  run("native-load", process.execPath, ["-e", "console.log(typeof require('fs-ext').flockSync)"], backend);
  run("backend-typecheck", "npm", ["run", "typecheck"], backend, true);
  run("entry-typecheck", process.execPath, [join(backend, "node_modules/typescript/bin/tsc"),
    "-p", join(backend, "scripts/project-z/z3/tsconfig.entry-check.json"), "--incremental", "false"], backend, true);
}
// These are the real existing build scripts, not fake build IDs or listeners.
if (frontendInstalled) run("frontend-build", "npm", ["run", "build"], source, true);
if (backendInstalled) run("backend-build", "npm", ["run", "build", "--workspace", "@finnor/api"], backend, true);
const cli = join(output, "cli.mjs");
if (backendInstalled) {
  const built = run("cli-build", join(backend, "node_modules/.bin/esbuild"),
    ["scripts/project-z/z3/cli.mts", "--bundle", "--platform=node", "--format=esm", "--outfile=" + cli], backend);
  if (built) {
    run("public-run", "/usr/bin/python3.12", [join(backend, "scripts/project-z/z3/finite-e2e.py"),
      "--cli", cli, "--output", join(output, "public")], source);
    run("boundary-run", process.execPath, ["--import", join(backend, "node_modules/tsx/dist/loader.mjs"),
      join(backend, "scripts/project-z/z3/native-boundary-e2e.mts"), "--cli=" + cli, "--output=" + join(output, "boundary")], backend);
  }
}
const generated = new Set(["next-env.d.ts", "tsconfig.json", "finnor-os/apps/api/next-env.d.ts",
  "finnor-os/apps/api/tsconfig.json",
  "finnor-os/packages/private-equity/src/enterprise-applications/source-manifest.generated.ts",
  "finnor-os/packages/private-equity/src/policy-learning/source-manifest.generated.ts",
  "finnor-os/packages/private-equity/src/system-identification/source-manifest.generated.ts",
  "finnor-os/packages/private-equity/src/system-identification/core-child.generated.mjs",
  "finnor-os/packages/epistemic-runtime/src/strategic-response/source-manifest.generated.ts"]);
const postbuildInventory = {}, deltas = [];
for (const [p, expected] of Object.entries(inventory)) {
  const bytes = readFileSync(join(source, p)), actual = sha(bytes);
  postbuildInventory[p] = actual;
  if (actual !== expected) {
    const postimage = join(output, "generated", p); mkdirSync(dirname(postimage), { recursive: true });
    writeFileSync(postimage, bytes, { flag: "wx" });
    deltas.push({ path: p, beforeSha256: expected, afterSha256: actual, permittedGeneratedPath: generated.has(p) });
  }
}
const modules = [];
for (const [directory, names] of [[source, ["next", "react", "typescript"]], [backend, ["tsx", "esbuild", "fs-ext", "pg", "typescript"]]]) {
  if (!existsSync(join(directory, "node_modules"))) continue;
  const require = createRequire(join(directory, "package.json"));
  for (const name of names) {
    try {
      const path = realpathSync(require.resolve(name));
      modules.push({ name, from: directory, path, sha256: sha(readFileSync(path)),
        local: path.startsWith(realpathSync(source) + "/") });
    } catch { modules.push({ name, from: directory, local: false, missing: true }); }
  }
}
const assets = {};
for (const [name, path] of Object.entries({ producer: cli, checker: join(backend, "packages/epistemic-runtime/src/project-z/z3-viability/checker.py"),
  node: process.execPath, python: "/usr/bin/python3.12", nativeBinding: join(backend, "node_modules/fs-ext/build/Release/fs_ext.node") })) {
  assets[name] = existsSync(path) ? { path, sha256: sha(readFileSync(path)) } : { path, missing: true };
}
const buildIds = Object.fromEntries([".next/BUILD_ID", "finnor-os/apps/api/.next/BUILD_ID"].map(p =>
  [p, existsSync(join(source, p)) ? readFileSync(join(source, p), "utf8").trim() : null]));
const body = JSON.stringify(postbuildInventory, null, 2) + "\n";
writeFileSync(join(output, "postbuild-source-inventory.json"), body, { flag: "wx" });
const report = { schema: "finnor.z3.lock-installed-engineering.v2", status: steps.every(s => s.exitCode === 0)
  && deltas.every(d => d.permittedGeneratedPath) && modules.every(m => m.local) ? "PASS" : "FAIL",
  node: process.version, target: "FRESH_REGULAR_COPY_SAME_COMPUTER_NOT_SEPARATE_HOST",
  sourceManifestSha256: sha(readFileSync(join(reconstruction, "manifest.json"))), steps, assets, buildIds, modules, generatedSourceDeltas: deltas,
  postbuildSourceInventorySha256: sha(body), lockfiles: { root: sha(readFileSync(join(source, "package-lock.json"))),
    backend: sha(readFileSync(join(backend, "package-lock.json"))) },
  dependenciesBorrowed: false, databaseOrAuthProvisioned: false, listenerStarted: false,
  sourceNative: "NOT_RUN", installedNative: "NOT_RUN", protectedAdmission: "NOT_RUN", financialQualification: "NOT_RUN", money: null };
writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ status: report.status, steps: steps.length, buildIds, assets }));
process.exitCode = report.status === "PASS" ? 0 : 1;
