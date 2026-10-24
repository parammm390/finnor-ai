/** Rebuild a source archive without a donor dependency tree or local Git. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, createWriteStream } from "node:fs";
import { resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const options = Object.fromEntries(process.argv.slice(2).map(arg => {
  const match = /^--(installation|output)=(\/.+)$/.exec(arg);
  if (!match) throw Error("Z0_RECONSTRUCTION_ABSOLUTE_ARGUMENT_REQUIRED");
  return [match[1], resolve(match[2])];
}));
if (Object.keys(options).length !== 2 || !options.output.startsWith(resolve(toolRoot, "scope-z/phase-evidence/z0") + sep)
  || existsSync(options.output) || process.versions.node.split(".")[0] !== "22") throw Error("Z0_FRESH_NODE22_RECONSTRUCTION_REQUIRED");
const sha = body => createHash("sha256").update(body).digest("hex");
const source = JSON.parse(await readFile(resolve(options.installation, "source-snapshot.json"), "utf8"));
const archive = JSON.parse(await readFile(resolve(options.installation, "source-archive.json"), "utf8"));
const archivePath = resolve(options.installation, archive.archive);
if (sha(await readFile(archivePath)) !== archive.sha256 || archive.sourcePopulationSha256 !== source.sourcePopulationSha256) {
  throw Error("Z0_FROZEN_RECONSTRUCTION_INPUT_CHANGED");
}
const members = execFileSync("/usr/bin/tar", ["-tzf", archivePath], { encoding: "utf8", maxBuffer: 8 * 1024 ** 2 }).trimEnd().split("\n");
if (new Set(members).size !== members.length || members.length !== source.files.length
  || members.some(path => path.startsWith("/") || path.split("/").includes("..") || !source.files.some(file => file.path === path))) {
  throw Error("Z0_UNDECLARED_RECONSTRUCTION_ARCHIVE_MEMBER");
}
await mkdir(options.output, { mode: 0o700 });
const root = resolve(options.output, "runtime"), backend = resolve(root, "finnor-os"), home = resolve(options.output, "build-home");
await mkdir(root); await mkdir(home);
const env = { PATH: dirname(process.execPath) + ":/usr/bin:/bin", HOME: home, LANG: "C.UTF-8",
  NODE_OPTIONS: "--max-old-space-size=4096", NEXT_TELEMETRY_DISABLED: "1", FINNOR_X1_FRONTEND_INSTALL: "1",
  FINNOR_BUILD_ID: "z0-" + source.sourcePopulationSha256.slice(0, 16),
  PLAYWRIGHT_BROWSERS_PATH: resolve(root, "browsers"), npm_config_cache: resolve(home, "npm-cache"),
  npm_config_devdir: resolve(home, "node-gyp") };
const steps = [];
async function run(name, command, args, cwd = root) {
  const log = resolve(options.output, name + ".log"), stream = createWriteStream(log, { flags: "wx" });
  const started = new Date().toISOString(), start = performance.now();
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream, { end: false });
  const timer = setTimeout(() => child.kill("SIGKILL"), 600000);
  const exit = await new Promise((ok, reject) => { child.once("error", reject); child.once("close", (code, signal) => ok({ code, signal })); });
  clearTimeout(timer); await new Promise(ok => stream.end(ok));
  const record = { name, command, args, cwd, started, elapsedMs: Math.round(performance.now() - start), ...exit,
    logSha256: sha(await readFile(log)) };
  steps.push(record);
  await writeFile(resolve(options.output, name + ".json"), JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
  if (exit.code !== 0) throw Error("Z0_RECONSTRUCTION_STEP_FAILED_" + name);
}
try {
  await run("01-extract-source", "/usr/bin/tar", ["--extract", "--gzip", "--file", archivePath, "--directory", root,
    "--no-same-owner", "--no-same-permissions"]);
  for (const file of source.files) if (sha(await readFile(resolve(root, file.path))) !== file.sha256) {
    throw Error("Z0_EXTRACTED_SOURCE_BYTES_CHANGED");
  }
  await writeFile(resolve(options.output, "source-snapshot.json"), JSON.stringify({ ...source, runtime: root,
    reconstructedFrom: { sourcePopulationSha256: source.sourcePopulationSha256, sourceArchiveSha256: archive.sha256,
      originalSnapshotSha256: sha(await readFile(resolve(options.installation, "source-snapshot.json"))) } }, null, 2) + "\n", { flag: "wx" });
  await run("02-root-ci", "/usr/bin/npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
  await run("03-backend-ci", "/usr/bin/npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], backend);
  await run("04-native-fs-ext", "/usr/bin/npm", ["rebuild", "fs-ext", "--build-from-source"], backend);
  await run("05-browser-assets", process.execPath, [resolve(root, "node_modules/playwright/cli.js"), "install", "chromium", "--only-shell"]);
  await run("06-full-backend-types", process.execPath, [resolve(backend, "node_modules/typescript/bin/tsc"),
    "--project", resolve(backend, "tsconfig.json"), "--noEmit", "--incremental", "false"]);
  await run("07-actual-mounted-frontend-build", process.execPath, [resolve(root, "node_modules/next/dist/bin/next"), "build", "--webpack"]);
  await run("08-complete-emission", process.execPath, [resolve(backend, "scripts/project-z/z0/emit-converged-runtime.mjs"),
    "--installation=" + options.output, "--attempt=01"]);
  const manifest = JSON.parse(await readFile(resolve(backend, "x1-development-installation.json"), "utf8"));
  await run("09-offline-installed-runtime-doctor", process.execPath, ["--import", resolve(root, manifest.sourceCustodyAdapter.preload),
    resolve(backend, "scripts/project-z/z0/offline-runtime-doctor.mjs"), "--z0-offline-doctor",
    "--output=" + resolve(options.output, "offline-runtime-doctor.json")]);
  await writeFile(resolve(options.output, "reconstruction.json"), JSON.stringify({
    schema: "finnor.project-z.z0.complete-fresh-reconstruction.v1", status: "PASSED_ENGINEERING_RECONSTRUCTION",
    sourcePopulationSha256: source.sourcePopulationSha256, archiveSha256: archive.sha256, steps,
    dependencyTreesCopied: false, localGitObjectsRequired: false, typescriptRuntimeFallback: "REFUSED",
    native: "NOT_RUN", installedNative: "NOT_RUN", databaseOrAuthExecuted: false,
  }, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ status: "PASSED_ENGINEERING_RECONSTRUCTION", steps: steps.length,
    native: "NOT_RUN", installedNative: "NOT_RUN" }));
} catch (error) {
  await writeFile(resolve(options.output, "reconstruction-failure.json"), JSON.stringify({
    schema: "finnor.project-z.z0.complete-fresh-reconstruction.v1", status: "FAILED",
    predicate: error.message, steps, native: "NOT_RUN", installedNative: "NOT_RUN",
  }, null, 2) + "\n", { flag: "wx" });
  throw error;
}
