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
async function originalCanonicalInventory() {
  const registryPath = "finnor-os/packages/orchestration/src/plugin-registry.ts";
  const paths = [registryPath, "finnor-os/packages/domain-plugins/private-equity/schemas.ts",
    "finnor-os/packages/shared-types/src/operational-queries.ts",
    "finnor-os/packages/private-equity/src/program-synthesis/economic-native.ts"];
  const sourcePins = [], sourceBytes = new Map();
  for (const path of paths) {
    const bytes = await readFile(resolve(root, path)), pin = manifest.files.find(file => file.path === path);
    ensure(pin && sha(bytes) === pin.sha256, "Z0_ORIGINAL_CAPABILITY_DECLARATION_PIN_CHANGED:" + path);
    sourceBytes.set(path, bytes); sourcePins.push({ path, sha256: sha(bytes) });
  }
  // Inspect immutable declaration data, never evaluate source or ask the bridge
  // to produce its own expected inventory.
  const ts = require("typescript");
  const parsed = ts.createSourceFile(registryPath, sourceBytes.get(registryPath).toString("utf8"), ts.ScriptTarget.Latest, true);
  ensure(parsed.parseDiagnostics.length === 0, "Z0_ORIGINAL_CAPABILITY_DECLARATION_PARSE_FAILED");
  const declarations = new Map();
  for (const statement of parsed.statements) if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) {
      ensure(!declarations.has(declaration.name.text), "Z0_ORIGINAL_CAPABILITY_DECLARATION_AMBIGUOUS");
      declarations.set(declaration.name.text, declaration.initializer);
    }
  }
  function strings(name, seen = []) {
    ensure(!seen.includes(name), "Z0_ORIGINAL_CAPABILITY_DECLARATION_CYCLE");
    let node = declarations.get(name);
    while (node && (ts.isAsExpression(node) || ts.isSatisfiesExpression(node))) node = node.expression;
    ensure(node && ts.isArrayLiteralExpression(node), "Z0_ORIGINAL_CAPABILITY_LITERAL_ARRAY_REQUIRED:" + name);
    return node.elements.flatMap(element => {
      if (ts.isStringLiteral(element)) return [element.text];
      if (ts.isSpreadElement(element) && ts.isIdentifier(element.expression)) return strings(element.expression.text, [...seen, name]);
      throw Error("Z0_ORIGINAL_CAPABILITY_LITERAL_MEMBER_REQUIRED:" + name);
    });
  }
  const [schemas, queries, native] = await Promise.all(paths.slice(1).map(path =>
    import(pathToFileURL(resolve(root, path)).href)));
  for (const values of [schemas.PRIVATE_EQUITY_ACTION_TYPES, queries.OPERATIONAL_QUERY_INTENTS]) {
    ensure(Array.isArray(values) && values.length > 0 && values.every(value => typeof value === "string" && value.length > 0),
      "Z0_ORIGINAL_CAPABILITY_CONTRACT_ARRAY_REQUIRED");
  }
  const actions = [...new Set([...strings("SHARED_PLANNER_ACTIONS"), ...schemas.PRIVATE_EQUITY_ACTION_TYPES,
    ...strings("HUMAN_ONLY_PLANNING_CAPABILITIES")])], economic = native.economicNativeCapability();
  ensure(typeof economic.capability === "string" && economic.capability.length > 0 && economic.kind === "action",
    "Z0_ORIGINAL_ECONOMIC_CAPABILITY_CONTRACT_REQUIRED");
  const rows = [...actions.map(capability => ({ capability, kind: "action" })),
    { capability: economic.capability, kind: economic.kind },
    ...queries.OPERATIONAL_QUERY_INTENTS.map(intent => ({ capability: "query:" + intent, kind: "query" })),
    { capability: "wait:event", kind: "wait" }, { capability: "check:objective_success", kind: "check" }]
    .sort((a, b) => a.capability.localeCompare(b.capability));
  ensure(new Set(rows.map(row => row.capability)).size === rows.length, "Z0_ORIGINAL_CAPABILITY_DECLARATIONS_DUPLICATE");
  return { rows, sourcePins };
}
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
  const expectedInventory = await originalCanonicalInventory();
  const bridge = await import(pathToFileURL(installation.entrypoint("bridge")).href);
  const runtime = new bridge.ConvergedInstitutionRuntime(), capabilities = runtime.capabilities("private_equity");
  const actualRows = capabilities.map(({ capability, kind }) => ({ capability, kind }))
    .sort((a, b) => a.capability.localeCompare(b.capability));
  result.canonicalInventory = { expectedCount: expectedInventory.rows.length, actualCount: actualRows.length,
    expectedRowsSha256: sha(JSON.stringify(expectedInventory.rows)), sourcePins: expectedInventory.sourcePins,
    expectedProducedByCandidateBridge: false, comparison: "EXACT_ORIGINAL_IDENTIFIERS_AND_KINDS" };
  ensure(new Set(actualRows.map(row => row.capability)).size === actualRows.length
    && JSON.stringify(actualRows) === JSON.stringify(expectedInventory.rows), "Z0_CANONICAL_CAPABILITY_CLOSURE_INCOMPLETE");
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
