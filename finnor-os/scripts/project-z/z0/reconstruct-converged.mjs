/** Rebuild a source archive without a donor dependency tree or local Git. */
import { readFile, writeFile, mkdir, realpath, readdir, lstat, rm, statfs } from "node:fs/promises";
import { existsSync, createWriteStream } from "node:fs";
import { resolve, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const options = Object.fromEntries(process.argv.slice(2).map(arg => {
  const pin = /^--(prepared-target-sha256)=([a-f0-9]{64})$/.exec(arg);
  if (pin) return [pin[1], pin[2]];
  const match = /^--(installation|output|public-auth-input|prepared-target-input|npm-cli)=(\/.+)$/.exec(arg);
  if (!match) throw Error("Z0_RECONSTRUCTION_ABSOLUTE_ARGUMENT_REQUIRED");
  return [match[1], resolve(match[2])];
}));
const preparedMode = Boolean(options["prepared-target-input"] || options["prepared-target-sha256"]);
if (!options.installation || !options.output
  || !options.output.startsWith(resolve(toolRoot, "scope-z/phase-evidence/z0") + sep)
  || existsSync(options.output) !== preparedMode || process.versions.node.split(".")[0] !== "22") throw Error("Z0_FRESH_NODE22_RECONSTRUCTION_REQUIRED");
const sha = body => createHash("sha256").update(body).digest("hex");
const npmCli = options["npm-cli"] ?? resolve(dirname(process.execPath), "../../npm/bin/npm-cli.js");
if (await realpath(npmCli) !== npmCli || !(await lstat(npmCli)).isFile()) throw Error("Z0_OWN_NPM_CLI_REQUIRED");
const npmPackage = JSON.parse(await readFile(resolve(dirname(npmCli), "../package.json"), "utf8"));
if (process.version !== "v22.23.4" || npmPackage.name !== "npm" || npmPackage.version !== "10.9.9") {
  throw Error("Z0_PINNED_NODE_NPM_REQUIRED");
}
const toolchain = { node: process.version, nodePath: process.execPath,
  nodeSha256: sha(await readFile(process.execPath)), npm: npmPackage.version, npmCli,
  npmCliSha256: sha(await readFile(npmCli)) };
const source = JSON.parse(await readFile(resolve(options.installation, "source-snapshot.json"), "utf8"));
const archive = JSON.parse(await readFile(resolve(options.installation, "source-archive.json"), "utf8"));
const archivePath = resolve(options.installation, archive.archive);
if (sha(await readFile(archivePath)) !== archive.sha256 || archive.sourcePopulationSha256 !== source.sourcePopulationSha256
  || sha(JSON.stringify(source.files)) !== source.sourcePopulationSha256) {
  throw Error("Z0_FROZEN_RECONSTRUCTION_INPUT_CHANGED");
}
const members = execFileSync("/usr/bin/tar", ["-tzf", archivePath], { encoding: "utf8", maxBuffer: 8 * 1024 ** 2 }).trimEnd().split("\n");
if (new Set(members).size !== members.length || members.length !== source.files.length
  || members.some(path => path.startsWith("/") || path.split("/").includes("..") || !source.files.some(file => file.path === path))) {
  throw Error("Z0_UNDECLARED_RECONSTRUCTION_ARCHIVE_MEMBER");
}
let preparedTarget = null;
if (preparedMode) {
  const path = options["prepared-target-input"], expected = options["prepared-target-sha256"];
  if (!path || !expected || !path.startsWith(resolve(toolRoot, "scope-z/phase-evidence/z0") + sep)
    || await realpath(path) !== path || !(await lstat(path)).isFile() || (await lstat(path)).size > 4 * 1024 ** 2) {
    throw Error("Z0_HASH_BOUND_OWNED_PREPARED_TARGET_INPUT_REQUIRED");
  }
  const bytes = await readFile(path);
  if (sha(bytes) !== expected) throw Error("Z0_PREPARED_TARGET_INPUT_HASH_CHANGED");
  const input = JSON.parse(bytes), root = resolve(options.output, "runtime");
  if (input.schema !== "finnor.project-z.z0.prepared-engineering-target.v1"
    || input.target !== options.output || input.sourcePopulationSha256 !== source.sourcePopulationSha256
    || input.sourceArchiveSha256 !== archive.sha256 || input.databaseAuthOrNativeExecuted !== false
    || !Number.isSafeInteger(input.projectedAdditionalPeakBytes) || input.projectedAdditionalPeakBytes < 1536 * 1024 ** 2
    || input.projectedAdditionalPeakBytes > 8 * 1024 ** 3
    || !Array.isArray(input.files) || input.files.length !== source.files.length
    || !Array.isArray(input.additionalFiles) || input.additionalFiles.length > 1
    || await realpath(root) !== root || await realpath(options.output) !== options.output) {
    throw Error("Z0_EXACT_PREPARED_ENGINEERING_TARGET_REQUIRED");
  }
  const originalInput = await readFile(resolve(options.output, "source-input.json"));
  const origin = JSON.parse(originalInput);
  if (sha(originalInput) !== input.sourceInputSha256
    || origin.schema !== "finnor.project-z.z0.canonical-postimage-generation-input.v1"
    || origin.scope !== "FRESH_SOURCE_GENERATION_NOT_INSTALLED_OR_NATIVE_PROOF"
    || origin.freshRoot !== root || origin.sourceMembers !== source.files.length
    || origin.freshOwnDependenciesRequired !== true || origin.databaseAuthOrNativeExecuted !== false) {
    throw Error("Z0_ORIGINAL_FRESH_SOURCE_GENERATION_RECEIPT_REQUIRED");
  }
  const outputNames = await readdir(options.output), rootNames = await readdir(root);
  if (outputNames.some(name => /^(?:0[0-9][a-z]?-|reconstruction(?:-failure)?\.json$|source-snapshot\.json$|frontend-public-auth-build\.json$|mounted-frontend-build-custody\.json$|reconstruction-build-home$)/.test(name))
    || rootNames.some(name => /^(?:\.git$|\.next|browsers$)/.test(name))
    || existsSync(resolve(root, "finnor-os/x1-development-installation.json"))
    || (await readdir(resolve(root, "finnor-os"))).some(name => name.startsWith("z0-runtime-"))) {
    throw Error("Z0_PREPARED_TARGET_MUST_HAVE_NO_PRIOR_BUILD_OR_RECONSTRUCTION");
  }
  const originals = new Set(source.files.map(file => file.path)), checked = new Map();
  for (const file of [...input.files, ...input.additionalFiles]) {
    if (!file || Object.keys(file).sort().join(",") !== "bytes,mode,path,sha256"
      || typeof file.path !== "string" || file.path !== relative(root, resolve(root, file.path))
      || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0
      || ![0o644, 0o755].includes(file.mode) || checked.has(file.path)
      || (!originals.has(file.path) && file.path !== ".z2-source-build.json")) {
      throw Error("Z0_PREPARED_TARGET_SOURCE_SET_INVALID");
    }
    const selected = resolve(root, file.path), metadata = await lstat(selected), body = await readFile(selected);
    if (!metadata.isFile() || await realpath(selected) !== selected || body.length !== file.bytes
      || (metadata.mode & 0o777) !== file.mode || sha(body) !== file.sha256) {
      throw Error("Z0_PREPARED_TARGET_SOURCE_PREIMAGE_CHANGED:" + file.path);
    }
    checked.set(file.path, file);
  }
  if (input.files.some(file => !originals.has(file.path)) || [...originals].some(path => !checked.has(path))
    || input.additionalFiles.some(file => file.path !== ".z2-source-build.json" || originals.has(file.path))) {
    throw Error("Z0_PREPARED_TARGET_SOURCE_SET_INVALID");
  }
  async function checkPreparedFiles(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name), key = relative(root, path);
      if (key === "node_modules" || key === "finnor-os/node_modules") {
        if (!entry.isDirectory() || await realpath(path) !== path) throw Error("Z0_PREPARED_DEPENDENCY_ROOT_INVALID");
      } else if (entry.isDirectory()) await checkPreparedFiles(path);
      else if (!entry.isFile() || !checked.has(key)) throw Error("Z0_UNDECLARED_PREPARED_TARGET_SOURCE:" + key);
    }
  }
  await checkPreparedFiles(root);
  const disk = await statfs(options.output), availableBytes = disk.bavail * disk.bsize;
  if (availableBytes - input.projectedAdditionalPeakBytes < 2 * 1024 ** 3) {
    throw Error("Z0_PREPARED_TARGET_PROJECTED_STORAGE_RESERVE_REQUIRED");
  }
  preparedTarget = { inputSha256: expected, sourceInputSha256: input.sourceInputSha256,
    priorUse: "SOURCE_GENERATION_ONLY_NO_PRIOR_BUILD", preimageFiles: input.files.length,
    additionalMetadata: input.additionalFiles, availableBytes, projectedAdditionalPeakBytes: input.projectedAdditionalPeakBytes,
    minimumProjectedRemainingBytes: 2 * 1024 ** 3, dependencyAction: "FRESH_REINSTALL_BOTH_LOCKS_NOT_COPIED" };
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
if (!preparedMode) {
  const disk = await statfs(dirname(options.output));
  if (disk.bavail * disk.bsize < 6 * 1024 ** 3) throw Error("Z0_FRESH_TARGET_6_GIB_STORAGE_GUARD");
  await mkdir(options.output, { mode: 0o700 });
}
const root = resolve(options.output, "runtime"), backend = resolve(root, "finnor-os"),
  home = resolve(options.output, preparedMode ? "reconstruction-build-home" : "build-home");
if (!preparedMode) await mkdir(root);
await mkdir(home);
const env = { PATH: dirname(process.execPath) + ":/usr/bin:/bin", HOME: home, LANG: "C.UTF-8",
  NODE_OPTIONS: "--max-old-space-size=4096", NEXT_TELEMETRY_DISABLED: "1", FINNOR_X1_FRONTEND_INSTALL: "1",
  FINNOR_BUILD_ID: "z0-" + source.sourcePopulationSha256.slice(0, 16),
  SENTRY_RELEASE: "z0-" + source.sourcePopulationSha256, GIT_CEILING_DIRECTORIES: dirname(root),
  PLAYWRIGHT_BROWSERS_PATH: resolve(root, "browsers"), npm_config_cache: resolve(home, "npm-cache"),
  npm_config_devdir: resolve(home, "node-gyp"), npm_config_nodedir: resolve(dirname(process.execPath), ".."),
  AWS_EC2_METADATA_DISABLED: "true", AWS_CONFIG_FILE: "/dev/null", AWS_SHARED_CREDENTIALS_FILE: "/dev/null" };
const steps = [];
let temporaryNpmCacheCleanup = null;
async function cleanOwnTemporaryNpmCache() {
  const path = resolve(home, "npm-cache");
  if (!existsSync(path)) return;
  if (path !== env.npm_config_cache || await realpath(path) !== path
    || !path.startsWith(home + sep) || !home.startsWith(options.output + sep)) {
    throw Error("Z0_ONLY_NEW_TARGET_TEMPORARY_NPM_CACHE_MAY_BE_REMOVED");
  }
  let files = 0, bytes = 0;
  async function count(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = resolve(directory, entry.name), observed = await lstat(file);
      if (observed.isDirectory()) await count(file);
      else if (observed.isFile()) { files++; bytes += observed.size; }
      else throw Error("Z0_UNEXPECTED_TEMPORARY_NPM_CACHE_FILE_KIND");
    }
  }
  await count(path);
  const record = { schema: "finnor.project-z.z0.temporary-build-cache-cleanup.v1",
    path, designation: "ONLY_THIS_FRESH_TARGETS_TEMPORARY_NPM_DOWNLOAD_CACHE",
    afterStep: "04-native-fs-ext", files, bytes, retainedRuntimeOrEarlierEvidenceRemoved: false };
  await writeFile(resolve(options.output, "temporary-npm-cache-before-cleanup.json"),
    JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
  await rm(path, { recursive: true });
  if (existsSync(path)) throw Error("Z0_NEW_TEMPORARY_NPM_CACHE_CLEANUP_FAILED");
  temporaryNpmCacheCleanup = { ...record, status: "REMOVED_OWN_NEW_TEMPORARY_CACHE_ONLY" };
  await writeFile(resolve(options.output, "temporary-npm-cache-cleanup.json"),
    JSON.stringify(temporaryNpmCacheCleanup, null, 2) + "\n", { flag: "wx" });
}
async function run(name, command, args, cwd = root, expectedCode = 0, buildEnv = {}) {
  const disk = await statfs(options.output);
  const requiredFreeBytes = (/^0[234]-/.test(name) ? 8 : 4) * 1024 ** 3;
  if (disk.bavail * disk.bsize < requiredFreeBytes) throw Error("Z0_RECONSTRUCTION_STORAGE_GUARD_" + name);
  const log = resolve(options.output, name + ".log"), stream = createWriteStream(log, { flags: "wx" });
  const started = new Date().toISOString(), start = performance.now();
  const child = spawn(command, args, { cwd, env: { ...env, ...buildEnv }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream, { end: false });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }, 600000);
  const exit = await new Promise((ok, reject) => { child.once("error", reject); child.once("close", (code, signal) => ok({ code, signal })); });
  clearTimeout(timer); await new Promise(ok => stream.end(ok));
  const record = { name, command, args, cwd, started, elapsedMs: Math.round(performance.now() - start), expectedCode, ...exit,
    timedOut, requiredFreeBytes, freeBytesBefore: disk.bavail * disk.bsize,
    logSha256: sha(await readFile(log)) };
  steps.push(record);
  await writeFile(resolve(options.output, name + ".json"), JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
  if (exit.code !== expectedCode) throw Error("Z0_RECONSTRUCTION_STEP_FAILED_" + name);
}
try {
  await run("00-git-object-isolation", "/usr/bin/git", ["rev-parse", "--show-toplevel"], root, 128);
  await run("01-extract-source", "/usr/bin/tar", ["--extract", "--gzip", "--file", archivePath, "--directory", root,
    "--no-same-owner", "--no-same-permissions"]);
  for (const file of source.files) {
    const path = resolve(root, file.path), metadata = await lstat(path), bytes = await readFile(path);
    if (!metadata.isFile() || await realpath(path) !== path || bytes.length !== file.bytes
      || (metadata.mode & 0o7777) !== file.mode || sha(bytes) !== file.sha256) {
      throw Error("Z0_EXTRACTED_SOURCE_BYTES_OR_MODE_CHANGED:" + file.path);
    }
  }
  await writeFile(resolve(options.output, "source-snapshot.json"), JSON.stringify({ ...source, runtime: root,
    reconstructedFrom: { sourcePopulationSha256: source.sourcePopulationSha256, sourceArchiveSha256: archive.sha256,
      originalSnapshotSha256: sha(await readFile(resolve(options.installation, "source-snapshot.json"))) },
    preparedEngineeringTarget: preparedTarget }, null, 2) + "\n", { flag: "wx" });
  await run("02-root-ci", process.execPath, [npmCli, "ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
  await run("03-backend-ci", process.execPath, [npmCli, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], backend);
  await run("04-native-fs-ext", process.execPath, [npmCli, "rebuild", "fs-ext", "--build-from-source"], backend);
  await cleanOwnTemporaryNpmCache();
  await run("05-browser-assets", process.execPath, [resolve(root, "node_modules/playwright/cli.js"), "install", "chromium", "--only-shell"]);
  // Restore generated route types in the fresh target. Managed source
  // declarations were already generated before the source archive was frozen.
  await run("05a-frontend-route-types", process.execPath,
    [resolve(root, "node_modules/next/dist/bin/next"), "typegen"], root, 0, frontendEnv);
  await run("05b-api-route-types", process.execPath,
    [resolve(backend, "node_modules/next/dist/bin/next"), "typegen"],
    resolve(backend, "apps/api"), 0, { FINNOR_Z2_BUILD_GRAPH: "1" });
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
  for (const phase of ["x3", "x5", "x4", "y2"]) {
    await run("06b-source-stamp-" + phase, process.execPath,
      ["--import", resolve(backend, "node_modules/tsx/dist/loader.mjs"),
        resolve(backend, "scripts", phase, "stamp-source.mts"), "--check"], resolve(backend, "apps/api"));
  }
  await run("07-actual-mounted-frontend-build", process.execPath, [resolve(root, "node_modules/next/dist/bin/next"), "build", "--webpack"],
    root, 0, frontendEnv);
  await run("07a-seal-mounted-frontend", process.execPath, ["--input-type=module", "-e",
    `const {sealMountedBuild}=await import(${JSON.stringify(resolve(backend, "scripts/project-z/z0/native-mounted-build.mjs"))});console.log(JSON.stringify(await sealMountedBuild(${JSON.stringify(root)})));`]);
  await run("07b-actual-next-api-build", process.execPath, [resolve(backend, "node_modules/next/dist/bin/next"), "build"],
    resolve(backend, "apps/api"), 0, { FINNOR_Z2_BUILD_GRAPH: "1" });
  const apiBuildId = (await readFile(resolve(backend, "apps/api/.next/BUILD_ID"), "utf8")).trim();
  if (apiBuildId !== env.FINNOR_BUILD_ID) throw Error("Z0_NEXT_API_BUILD_IDENTITY_MISMATCH");
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
    toolchain, apiBuildId, sourceDriftBeforeEmission: false,
    temporaryNpmCacheCleanup,
    preparedEngineeringTarget: preparedTarget,
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
