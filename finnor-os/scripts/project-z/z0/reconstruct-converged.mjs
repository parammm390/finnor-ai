/** Rebuild a source archive without a donor dependency tree or local Git. */
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { existsSync, createWriteStream } from "node:fs";
import { resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const options = Object.fromEntries(process.argv.slice(2).map(arg => {
  const match = /^--(installation|output|public-auth-input)=(\/.+)$/.exec(arg);
  if (!match) throw Error("Z0_RECONSTRUCTION_ABSOLUTE_ARGUMENT_REQUIRED");
  return [match[1], resolve(match[2])];
}));
if (!options.installation || !options.output
  || !options.output.startsWith(resolve(toolRoot, "scope-z/phase-evidence/z0") + sep)
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
const frontendEnv = {};
const publicAuthBuild = { schema: "finnor.project-z.z0.frontend-public-auth-build-receipt.v1",
  sourcePopulationSha256: source.sourcePopulationSha256, state: "NOT_DELIVERED",
  authenticationExecuted: false, environmentNames: [] };
if (options["public-auth-input"]) {
  if (!existsSync(options["public-auth-input"])) throw Error("Z0_PUBLIC_AUTH_BUILD_INPUT_NOT_DELIVERED");
  const bytes = await readFile(options["public-auth-input"]);
  let input, origin;
  try {
    if (bytes.length > 8192) throw Error();
    input = JSON.parse(bytes);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw Error();
    origin = new URL(input.authOrigin);
  } catch { throw Error("Z0_INVALID_PUBLIC_AUTH_BUILD_INPUT"); }
  const fields = ["schema", "phase", "sessionId", "sourcePopulationSha256", "expiresAt", "authOrigin", "publicUrlEnv", "publicAnonKeyEnv"];
  if (Object.keys(input).length !== fields.length || fields.some(key => !Object.hasOwn(input, key))
    || input.schema !== "finnor.project-z.z0.frontend-public-auth-build-input.v1" || input.phase !== "Z0"
    || input.sessionId !== "66647028-fac4-4793-bec3-22b564d12b90"
    || input.sourcePopulationSha256 !== source.sourcePopulationSha256 || !(Date.parse(input.expiresAt) > Date.now())) {
    throw Error("Z0_SOURCE_BOUND_PUBLIC_AUTH_BUILD_INPUT_REQUIRED");
  }
  if (origin.origin !== input.authOrigin || origin.protocol !== "http:" || origin.username || origin.password
    || !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)) throw Error("Z0_PUBLIC_AUTH_LOOPBACK_ORIGIN_REQUIRED");
  for (const key of ["publicUrlEnv", "publicAnonKeyEnv"]) if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(input[key] ?? "")
    || !process.env[input[key]]) throw Error("Z0_EXPLICIT_PUBLIC_AUTH_ENVIRONMENT_NAME_REQUIRED");
  const url = process.env[input.publicUrlEnv], key = process.env[input.publicAnonKeyEnv];
  let publicKey = /^sb_publishable_[A-Za-z0-9_-]{16,256}$/.test(key);
  if (!publicKey && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) {
    try {
      const claims = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString("utf8"));
      publicKey = claims.role === "anon" && Object.keys(claims).every(name => ["role", "iss", "iat", "exp", "ref"].includes(name));
    } catch { /* A malformed or non-public token never reaches the client build. */ }
  }
  if (url !== input.authOrigin || key !== key.trim() || key.length > 4096 || !publicKey) {
    throw Error("Z0_PUBLIC_ANON_OR_PUBLISHABLE_BUILD_KEY_ONLY");
  }
  Object.assign(frontendEnv, { NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_ANON_KEY: key });
  Object.assign(publicAuthBuild, { state: "EXPLICIT_PUBLIC_BUILD_INPUT", inputSha256: sha(bytes),
    expiresAt: input.expiresAt, authOrigin: input.authOrigin, anonKeySha256: sha(key),
    environmentNames: [input.publicUrlEnv, input.publicAnonKeyEnv],
    injectedNames: Object.keys(frontendEnv), secretOrUserKeyAccepted: false });
}
await mkdir(options.output, { mode: 0o700 });
const root = resolve(options.output, "runtime"), backend = resolve(root, "finnor-os"), home = resolve(options.output, "build-home");
await mkdir(root); await mkdir(home);
const env = { PATH: dirname(process.execPath) + ":/usr/bin:/bin", HOME: home, LANG: "C.UTF-8",
  NODE_OPTIONS: "--max-old-space-size=4096", NEXT_TELEMETRY_DISABLED: "1", FINNOR_X1_FRONTEND_INSTALL: "1",
  FINNOR_BUILD_ID: "z0-" + source.sourcePopulationSha256.slice(0, 16),
  SENTRY_RELEASE: "z0-" + source.sourcePopulationSha256, GIT_CEILING_DIRECTORIES: dirname(root),
  PLAYWRIGHT_BROWSERS_PATH: resolve(root, "browsers"), npm_config_cache: resolve(home, "npm-cache"),
  npm_config_devdir: resolve(home, "node-gyp") };
const steps = [];
async function run(name, command, args, cwd = root, expectedCode = 0, buildEnv = {}) {
  const log = resolve(options.output, name + ".log"), stream = createWriteStream(log, { flags: "wx" });
  const started = new Date().toISOString(), start = performance.now();
  const child = spawn(command, args, { cwd, env: { ...env, ...buildEnv }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream, { end: false });
  const timer = setTimeout(() => child.kill("SIGKILL"), 600000);
  const exit = await new Promise((ok, reject) => { child.once("error", reject); child.once("close", (code, signal) => ok({ code, signal })); });
  clearTimeout(timer); await new Promise(ok => stream.end(ok));
  const record = { name, command, args, cwd, started, elapsedMs: Math.round(performance.now() - start), expectedCode, ...exit,
    logSha256: sha(await readFile(log)) };
  steps.push(record);
  await writeFile(resolve(options.output, name + ".json"), JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
  if (exit.code !== expectedCode) throw Error("Z0_RECONSTRUCTION_STEP_FAILED_" + name);
}
try {
  await run("00-git-object-isolation", "/usr/bin/git", ["rev-parse", "--show-toplevel"], root, 128);
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
  await run("06a-backend-type-source-custody", process.execPath, [resolve(backend, "node_modules/typescript/bin/tsc"),
    "--project", resolve(backend, "tsconfig.json"), "--noEmit", "--incremental", "false", "--listFilesOnly"]);
  const selectedTypes = (await readFile(resolve(options.output, "06a-backend-type-source-custody.log"), "utf8"))
    .trim().split(/\r?\n/);
  const typeInputs = [];
  for (const selected of selectedTypes) {
    if (!selected.startsWith(root + sep)) throw Error("Z0_TYPE_SOURCE_OUTSIDE_FRESH_TARGET");
    const path = await realpath(selected);
    if (!path.startsWith(root + sep)) throw Error("Z0_BORROWED_TYPE_SOURCE_REFUSED");
    typeInputs.push({ path: path.slice(root.length + 1), sha256: sha(await readFile(path)) });
  }
  await writeFile(resolve(options.output, "backend-type-source-custody.json"), JSON.stringify({
    schema: "finnor.project-z.z0.backend-type-source-custody.v1",
    sourcePopulationSha256: source.sourcePopulationSha256, selectedFiles: typeInputs.length,
    outsideTargetFiles: 0, files: typeInputs,
  }, null, 2) + "\n", { flag: "wx" });
  await writeFile(resolve(options.output, "frontend-public-auth-build.json"), JSON.stringify(publicAuthBuild, null, 2) + "\n", { flag: "wx" });
  await run("07-actual-mounted-frontend-build", process.execPath, [resolve(root, "node_modules/next/dist/bin/next"), "build", "--webpack"],
    root, 0, frontendEnv);
  await run("08-complete-emission", process.execPath, [resolve(backend, "scripts/project-z/z0/emit-converged-runtime.mjs"),
    "--installation=" + options.output, "--attempt=01"]);
  const manifest = JSON.parse(await readFile(resolve(backend, "x1-development-installation.json"), "utf8"));
  await run("09-offline-installed-runtime-doctor", process.execPath, ["--import", resolve(root, manifest.sourceCustodyAdapter.preload),
    resolve(backend, "scripts/project-z/z0/offline-runtime-doctor.mjs"), "--z0-offline-doctor",
    "--output=" + resolve(options.output, "offline-runtime-doctor.json")]);
  await writeFile(resolve(options.output, "reconstruction.json"), JSON.stringify({
    schema: "finnor.project-z.z0.complete-fresh-reconstruction.v1", status: "PASSED_ENGINEERING_RECONSTRUCTION",
    sourcePopulationSha256: source.sourcePopulationSha256, archiveSha256: archive.sha256, steps,
    dependencyTreesCopied: false, localGitObjectsRequired: false, gitDiscoveryIsolated: true,
    gitCeiling: env.GIT_CEILING_DIRECTORIES, sentryRelease: env.SENTRY_RELEASE, backendTypeInputs: typeInputs.length,
    frontendPublicAuthBuild: publicAuthBuild,
    typescriptRuntimeFallback: "REFUSED",
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
