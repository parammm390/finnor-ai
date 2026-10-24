/** Actual emitted/native protocol and closure checks, never a native Work run. */
import { readFile, writeFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateMountedBuild } from "./native-mounted-build.mjs";
if (!process.argv.includes("--z0-offline-doctor") || process.env.DATABASE_URL || process.env.AUTH_DEV_BYPASS) {
  throw Error("Z0_NETWORK_FREE_DOCTOR_ENVIRONMENT_REQUIRED");
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const output = process.argv.find(arg => arg.startsWith("--output=/"))?.slice(9);
if (!output) throw Error("Z0_NEW_OFFLINE_DOCTOR_OUTPUT_REQUIRED");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const require = createRequire(resolve(root, "finnor-os/package.json"));
const installation = require(resolve(root, "finnor-os/packages/source-custody/installation.cjs")).installedRuntime(true);
const { manifest } = installation, loader = resolve(root, manifest.sourceCustodyAdapter.preload);
const result = { schema: "finnor.project-z.z0.offline-emitted-runtime-doctor.v1",
  evidenceClass: "NETWORK_FREE_ENGINEERING_NOT_AUTHENTICATED_NATIVE_PROOF", manifestSha256: installation.manifestDigest,
  node: process.version, cases: [], native: "NOT_RUN", installedNative: "NOT_RUN" };
const ensure = (condition, code) => { if (!condition) throw Error(code); };
const run = (name, executable, args, input, predicate, extra = {}) => {
  const env = { PATH: dirname(process.execPath) + ":/usr/bin:/bin", HOME: dirname(output), LANG: "C.UTF-8",
    NODE_OPTIONS: "--max-old-space-size=4096", GIT_CEILING_DIRECTORIES: dirname(root), ...extra };
  const child = spawnSync(executable, args, { cwd: root, env, input, encoding: "utf8", timeout: 90000, maxBuffer: 2 * 1024 ** 2 });
  const record = { name, exitCode: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr };
  result.cases.push(record);
  ensure(!child.error && predicate(child), "Z0_OFFLINE_RUNTIME_CASE_FAILED_" + name);
};
try {
  const publicAuth = manifest.frontend.publicAuthBuild;
  ensure(publicAuth?.schema === "finnor.project-z.z0.frontend-public-auth-build-receipt.v1"
    && publicAuth.sourcePopulationSha256 === manifest.source.snapshotPopulationSha256
    && ["NOT_DELIVERED", "EXPLICIT_PUBLIC_BUILD_INPUT"].includes(publicAuth.state)
    && publicAuth.authenticationExecuted === false, "Z0_BROWSER_PUBLIC_AUTH_BUILD_STATE_UNDECLARED");
  result.cases.push({ name: "BROWSER_PUBLIC_AUTH_BUILD_STATE_NOT_NATIVE_AUTH_PROOF",
    status: "PASSED", publicBuildInput: publicAuth.state, authenticatedNative: "NOT_RUN" });
  const mountedBuild = await validateMountedBuild(root, manifest);
  result.cases.push({ name: "ACTUAL_SOURCE_BOUND_STANDALONE_WITH_PUBLIC_AND_STATIC_ASSETS",
    status: "PASSED", sha256: mountedBuild.sha256, buildId: mountedBuild.buildId,
    files: mountedBuild.files, links: mountedBuild.links, totalBytes: mountedBuild.totalBytes,
    serverStarted: false, authenticatedNative: "NOT_RUN" });
  const bridge = await import(pathToFileURL(installation.entrypoint("bridge")).href);
  const runtime = new bridge.ConvergedInstitutionRuntime(), capabilities = runtime.capabilities("private_equity");
  ensure(capabilities.length === 77 && new Set(capabilities.map(row => row.capability)).size === 77, "Z0_CANONICAL_CAPABILITY_CLOSURE_INCOMPLETE");
  result.cases.push({ name: "ACTUAL_EMITTED_BRIDGE_CANONICAL_INVENTORY", status: "PASSED", count: capabilities.length,
    inventorySha256: sha(JSON.stringify(capabilities)), scientificIncrement: runtime.scientificIncrement });
  const mappings = JSON.parse(await readFile(resolve(root, manifest.sourceCustodyAdapter.executableSourceMap), "utf8"));
  for (const mapping of mappings) ensure(import.meta.resolve(pathToFileURL(resolve(root, mapping.source)).href)
    === pathToFileURL(resolve(root, mapping.emitted)).href, "Z0_COMPUTED_NATIVE_IMPORT_NOT_EMITTED");
  result.cases.push({ name: "ALL_DECLARED_COMPUTED_SOURCE_URLS_RESOLVE_TO_JS", status: "PASSED", count: mappings.length });
  require("fs-ext");
  result.cases.push({ name: "ACTUAL_FRESH_FS_EXT_NATIVE_ADDON_LOADED", status: "PASSED" });
  const common = ["--import", loader];
  const nativeDriver = resolve(root, "finnor-os/scripts/project-z/z0/run-native-e2e.mjs");
  run("INSTALLED_NATIVE_DRIVER_LOADS_INDEPENDENT_ORIGINAL_ORACLE_WITHOUT_AUTHORITY", process.execPath,
    [...common, nativeDriver, "--doctor"], "", child => {
      if (child.status !== 0) return false;
      const report = JSON.parse(child.stdout);
      return report.cases.length === 54 && report.originalOracle?.candidateImports === false
        && report.originalOracle.expectedRowsAreInputs === false && report.database === "NOT_RUN" && report.auth === "NOT_RUN"
        && report.currentness?.simulation === false && report.currentness.databaseWrites === false
        && report.recovery?.simulation === false && report.recovery.databaseWrites === false
        && report.mountedBuild?.borrowedDependencies === false && report.mountedBuild.serverStarted === false
        && report.mountedWork?.transportInterception === false && report.mountedWork.injectedAuth === false
        && report.mountedWork.createdTenantsOrPrincipals === false;
    });
  run("INSTALLED_NATIVE_DRIVER_REFUSES_MISSING_AUTHORITY", process.execPath,
    [...common, nativeDriver, "--run"], "", child => child.status === 2
      && JSON.parse(child.stdout).predicate === "Z0_NATIVE_AUTHORITY_NOT_DELIVERED"
      && JSON.parse(child.stdout).completedCases === 0);
  for (const entry of ["api", "worker"]) run(entry.toUpperCase() + "_PRE_AUTHORITY_GUARD", process.execPath,
    [...common, installation.entrypoint(entry), "--z0-offline-doctor"], "",
    child => child.status !== 0 && child.stderr.includes("X1_COMPILED_DEVELOPMENT_PROFILE_REQUIRED"));
  run("INDEPENDENT_COMPILED_CHECKER_PIN_PROTOCOL", process.execPath,
    [...common, installation.entrypoint("checker"), "--z0-offline-doctor"], '{"schema":"finnor.x1.checker-process.v1","pins":{}}',
    child => child.status !== 0 && child.stderr.includes("X1_CHECKER_CODE_PIN_MISMATCH"),
    { NODE_ENV: "development", FINNOR_P4_PROFILE: "ordinary_disposable", FINNOR_ENVIRONMENT: "staging" });
  run("ORIGINAL_CANONICAL_CHECKER_URL_RESOLVES_TO_DECLARED_JS", process.execPath,
    [...common, resolve(root, "finnor-os/scripts/frontier5/x1/checker-command.mts"), "--z0-offline-doctor"],
    '{"schema":"finnor.x1.checker-process.v1","pins":{}}',
    child => child.status !== 0 && child.stderr.includes("X1_CHECKER_CODE_PIN_MISMATCH"),
    { NODE_ENV: "development", FINNOR_P4_PROFILE: "ordinary_disposable", FINNOR_ENVIRONMENT: "staging" });
  const browser = manifest.nativeAssets.find(file => file.path.endsWith("/chrome-headless-shell"));
  ensure(browser, "Z0_FRESH_BROWSER_ASSET_REQUIRED");
  run("FRESH_BROWSER_BINARY_VERSION", resolve(root, browser.path), ["--version"], "",
    child => child.status === 0 && /Chrom(?:e|ium)/i.test(child.stdout));
  const paths = [manifest.nativeAssets.find(file => /fs-ext\/build\/Release\/fs_ext\.node$/.test(file.path))?.path,
    browser.path].filter(Boolean);
  result.osNativeDependencies = [];
  for (const path of paths) {
    const linked = spawnSync("/usr/bin/ldd", [resolve(root, path)], { encoding: "utf8", timeout: 10000 });
    ensure(linked.status === 0 && !linked.stdout.includes("not found"), "Z0_UNDECLARED_MISSING_OS_NATIVE_DEPENDENCY");
    const libraries = [...new Set([...linked.stdout.matchAll(/(?:=>\s+)?(\/[^\s()]+)/g)].map(match => match[1]))];
    const pins = [];
    for (const library of libraries) pins.push({ path: await realpath(library), sha256: sha(await readFile(library)) });
    result.osNativeDependencies.push({ nativeAsset: path, ldd: linked.stdout, libraries: pins });
  }
  const declaration = await readFile(resolve(root, "finnor-os/node_modules/typescript/lib/lib.es5.d.ts"));
  run("SOURCE_FALLBACK_REFUSED", process.execPath, [...common, "--input-type=module", "-e",
    `await import(${JSON.stringify(pathToFileURL(resolve(root, "finnor-os/node_modules/typescript/lib/lib.es5.d.ts")).href)});`,
    "--", "--z0-offline-doctor"], "", child => child.status !== 0 && child.stderr.includes("Z0_SOURCE_EXECUTION_WITHOUT_EMISSION_REFUSED"));
  result.cases.push({ name: "DECLARATION_BYTES_RETAINED_NOT_EXECUTABLE", sha256: sha(declaration) });
  result.status = "PASSED_OFFLINE_ENGINEERING_ONLY";
} catch (error) {
  result.status = "FAILED"; result.failure = error.message; process.exitCode = 1;
}
await writeFile(output, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ ...result, cases: result.cases.map(c => ({ name: c.name, status: c.status, exitCode: c.exitCode })),
  osNativeDependencies: result.osNativeDependencies?.map(item => ({ nativeAsset: item.nativeAsset, libraries: item.libraries.length })) }));
