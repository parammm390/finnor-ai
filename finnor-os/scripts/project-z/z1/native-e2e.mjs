/** Guard first, before importing a database, browser, auth or product module.
 * This command never creates a database, tenant, Work, source, grant or listener. */
import { createHash } from "node:crypto";
import { readFile, readdir, readlink, stat, writeFile, mkdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

export const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const required = ["FINNOR_Z1_TARGET_MANIFEST", "FINNOR_Z1_TARGET_SHA256", "FINNOR_Z1_NATIVE_AUTHORIZED",
  "TEST_OWNER_EMAIL", "TEST_OWNER_PASSWORD", "DATABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL",
  "FINNOR_ENVIRONMENT", "FINNOR_Z1_PROFILE", "P3_GOVERNORS"];
export function need(condition, code) { if (!condition) throw Error(code); }
export async function privateJSON(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
export async function processIdentity(pid) {
  need(Number.isSafeInteger(pid) && pid > 1, "OWNED_PROCESS_ID_REQUIRED");
  const base = `/proc/${pid}`, fields = (await readFile(`${base}/stat`, "utf8")).split(") ").slice(1).join(") ").split(" ");
  const info = await stat(base), executable = await readlink(`${base}/exe`);
  return { pid, startTicks: fields[19], uid: info.uid, executableSha256: sha(await readFile(executable)) };
}
async function checkListener(port, expected) {
  const portHex = port.toString(16).padStart(4, "0").toUpperCase();
  const inodes = [];
  for (const family of ["tcp", "tcp6"]) {
    const rows = (await readFile(`/proc/net/${family}`, "utf8")).trim().split("\n").slice(1);
    for (const line of rows) {
      const row = line.trim().split(/\s+/);
      if (row[3] !== "0A" || row[1].split(":")[1] !== portHex) continue;
      need(["0100007F", "00000000000000000000000001000000"].includes(row[1].split(":")[0]),
        "TARGET_LISTENER_MUST_BIND_LOOPBACK_ONLY");
      inodes.push(row[9]);
    }
  }
  need(inodes.length > 0, "OWNED_TARGET_LISTENER_NOT_DELIVERED");
  const sockets = [];
  for (const name of await readdir(`/proc/${expected.pid}/fd`)) {
    try { sockets.push(await readlink(`/proc/${expected.pid}/fd/${name}`)); } catch { /* raced a closed fd */ }
  }
  need(inodes.every(inode => sockets.includes(`socket:[${inode}]`)), "TARGET_LISTENER_NOT_OWNED_BY_DECLARED_PROCESS");
}
export async function guardTarget() {
  need(/^v22\./.test(process.version), "NODE_22_REQUIRED");
  need(required.every(key => process.env[key]), "EXPLICIT_NATIVE_TARGET_AUTH_AND_LOCAL_CREDENTIALS_NOT_DELIVERED");
  need(process.env.FINNOR_Z1_NATIVE_AUTHORIZED === "DISPOSABLE_ORIGINAL_Z1_EPISODE_ONLY" &&
    process.env.FINNOR_ENVIRONMENT === "ordinary_disposable" && process.env.FINNOR_Z1_PROFILE === "ordinary_disposable" &&
    process.env.P3_GOVERNORS === "1", "EXPLICIT_DISPOSABLE_EPISODE_AUTHORITY_REQUIRED");
  const bypasses = ["AUTH_DEV_BYPASS", "CENTROPY_TEST_MODE", "NEXT_PUBLIC_CENTROPY_TEST_MODE", "NEXT_PUBLIC_JARVIS_TEST_MODE"];
  need(!bypasses.some(key => process.env[key] === "1"),
    "REAL_AUTH_REQUIRED_NO_BYPASS");
  const forbidden = /^(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|GROQ_API_KEY|MISTRAL_API_KEY|DEEPSEEK_API_KEY|SENTRY_DSN|AXIOM_TOKEN|VAPI_PRIVATE_KEY|MICROSOFT_CLIENT_SECRET|GOOGLE_CLIENT_SECRET)$/;
  need(!Object.keys(process.env).some(key => forbidden.test(key) && process.env[key]), "EXTERNAL_PROVIDER_CREDENTIALS_MUST_BE_ABSENT");
  const targetPath = process.env.FINNOR_Z1_TARGET_MANIFEST;
  need(isAbsolute(targetPath), "ABSOLUTE_TARGET_MANIFEST_REQUIRED");
  const bytes = await readFile(targetPath); need(bytes.length <= 1048576 && sha(bytes) === process.env.FINNOR_Z1_TARGET_SHA256,
    "EXPLICIT_TARGET_MANIFEST_DIGEST_REQUIRED");
  const target = JSON.parse(bytes);
  need(target.schema === "finnor.z1.authorized-native-target.v1" && target.authorization?.disposableDatabaseExclusive === true &&
    target.authorization?.existingFixtureWritesOnly === true && target.authorization?.ownedWorkerFaultsOnly === true &&
    target.authorization?.externalEffects === false && target.authorization?.newDatabaseTenantsAuthGrantsOrListeners === false &&
    typeof target.authorization?.reference === "string" && target.authorization.reference.length > 0,
    "EXPLICIT_TARGET_CUSTODY_AND_BOUNDED_ACTION_AUTHORITY_REQUIRED");
  const scenario = target.authorization.scenario ?? "ORIGINAL_EPISODE";
  need(["ORIGINAL_EPISODE", "UNRECONCILED_LOGICAL_PREFIX", "EXHAUSTED_EPISODE_PREFIX"].includes(scenario),
    "EXPLICIT_BOUNDED_NATIVE_SCENARIO_REQUIRED");
  need(["SOURCE_DEVELOPMENT", "SEPARATELY_INSTALLED_DEVELOPMENT"].includes(target.flavor) &&
    isAbsolute(target.repository) && resolve(target.repository) === resolve(root), "EXACT_OWN_SOURCE_TARGET_REQUIRED");
  const front = new URL(target.frontend), api = new URL(target.api), database = new URL(process.env.DATABASE_URL);
  for (const url of [front, api]) need(url.protocol === "http:" && url.hostname === "127.0.0.1" &&
    url.port && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash, "EXPLICIT_LOOPBACK_HTTP_TARGET_REQUIRED");
  need(["postgres:", "postgresql:"].includes(database.protocol) && database.hostname === "127.0.0.1" &&
    database.port && database.pathname === `/${target.database.name}` && Number(database.port) === target.database.port &&
    !database.search && !database.hash, "EXPLICIT_OWNED_DISPOSABLE_DATABASE_REQUIRED");
  const auth = new URL(process.env.SUPABASE_URL), browserAuth = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL);
  need(auth.origin === browserAuth.origin && auth.origin === target.authOrigin && auth.pathname === "/" && browserAuth.pathname === "/" &&
    !auth.username && !auth.password && !auth.search && !auth.hash &&
    (auth.protocol === "https:" || auth.protocol === "http:" && ["127.0.0.1", "localhost"].includes(auth.hostname)),
    "SAME_EXPLICIT_REAL_AUTH_PROJECT_REQUIRED");
  need(/^[a-f0-9]{64}$/.test(target.fixtureSha256) && isAbsolute(target.fixtureFile), "PUBLIC_FIXTURE_PIN_REQUIRED");
  const fixture = await readFile(target.fixtureFile);
  need(fixture.length <= 8388608 && sha(fixture) === target.fixtureSha256, "EXACT_PUBLIC_ORIGINAL_FIXTURE_REQUIRED");
  const installed = JSON.parse(await readFile(new URL("../../../packages/private-equity/src/project-z/z1-shared-work/installed-source.json", import.meta.url)));
  need(target.nativeRuntimeDigest === installed.nativeRuntimeDigest && target.sourceCommit === installed.sourceCommit &&
    target.sourceTree === installed.sourceTree && target.reconstructionReference === installed.reconstructionReference,
    "EXACT_INSTALLED_SOURCE_IDENTITY_REQUIRED");
  need(Array.isArray(target.processes) && target.processes.length >= 3 && target.processes.length <= 8,
    "EXPLICIT_OWNED_TARGET_PROCESSES_REQUIRED");
  const identities = [];
  for (const expected of target.processes) {
    const actual = await processIdentity(expected.pid);
    need(actual.uid === process.getuid() && Object.keys(actual).every(key => actual[key] === expected[key]), "TARGET_PROCESS_IDENTITY_CHANGED");
    need(Number.isInteger(expected.port) && expected.port > 1023 && expected.port < 65536, "EXPLICIT_OWNED_PORT_REQUIRED");
    await checkListener(expected.port, expected);
    need(/^[a-f0-9]{64}$/.test(expected.commandLineSha256 ?? "") &&
      sha(await readFile(`/proc/${expected.pid}/cmdline`)) === expected.commandLineSha256 &&
      isAbsolute(expected.cwd) && await readlink(`/proc/${expected.pid}/cwd`) === expected.cwd,
      "EXACT_OWNED_PROCESS_SOURCE_AND_COMMAND_REQUIRED");
    if ([Number(front.port), Number(api.port)].includes(expected.port)) {
      need(expected.cwd === resolve(root) || expected.cwd.startsWith(resolve(root) + "/"), "EXACT_OWNED_APPLICATION_SOURCE_REQUIRED");
      const environment = Object.fromEntries((await readFile(`/proc/${expected.pid}/environ`, "utf8"))
        .split("\0").filter(Boolean).map(entry => { const i = entry.indexOf("="); return [entry.slice(0, i), entry.slice(i + 1)]; }));
      need(environment.FINNOR_ENVIRONMENT === "ordinary_disposable" && environment.FINNOR_Z1_PROFILE === "ordinary_disposable" &&
        environment.P3_GOVERNORS === "1" && !bypasses.some(key => environment[key] === "1") &&
        !Object.keys(environment).some(key => forbidden.test(key) && environment[key]),
        "ACTUAL_TARGET_ENVIRONMENT_MUST_DISABLE_BYPASSES_AND_EXTERNAL_PROVIDERS");
      if (expected.port === Number(front.port)) need(environment.NEXT_PUBLIC_SUPABASE_URL &&
        new URL(environment.NEXT_PUBLIC_SUPABASE_URL).origin === target.authOrigin &&
        (environment.FINNOR_OS_API_URL ?? environment.NEXT_PUBLIC_OS_API_URL)?.replace(/\/$/, "") === api.origin,
        "ACTUAL_FRONTEND_AUTH_AND_API_PROJECT_REQUIRED");
      if (expected.port === Number(api.port)) need(environment.DATABASE_URL === process.env.DATABASE_URL &&
        environment.SUPABASE_URL && new URL(environment.SUPABASE_URL).origin === target.authOrigin &&
        (environment.NODE_ENV !== "production" || environment.FINNOR_Z1_INSTALLED_DEVELOPMENT === "1"),
        "ACTUAL_API_DISPOSABLE_DATABASE_AND_AUTH_PROJECT_REQUIRED");
    }
    identities.push(actual);
  }
  for (const port of [Number(front.port), Number(api.port), Number(database.port)])
    need(target.processes.some(process => process.port === port), "COMPLETE_OWNED_TARGET_PORT_CUSTODY_REQUIRED");
  if (target.flavor === "SEPARATELY_INSTALLED_DEVELOPMENT") {
    need(target.builds?.frontend?.path === ".next-z1-install/BUILD_ID" &&
      target.builds?.api?.path === "finnor-os/apps/api/.next/BUILD_ID", "EXPLICIT_SEPARATE_INSTALLED_BUILD_IDENTITIES_REQUIRED");
    for (const build of [target.builds.frontend, target.builds.api])
      need(typeof build.id === "string" && build.id.length > 0 && build.id.length <= 256 &&
        (await readFile(resolve(root, build.path), "utf8")).trim() === build.id, "ACTUAL_INSTALLED_BUILD_ID_CHANGED");
  }
  const fixtureValue = JSON.parse(fixture);
  need(fixtureValue.schema === "finnor.z1.public-native-episode.v1" &&
    fixtureValue.dataClass === "PUBLIC_DETERMINISTIC_FIXTURE_NO_PII" && fixtureValue.externalEffects === false,
    "EXPLICIT_PUBLIC_NO_EFFECT_ORIGINAL_FIXTURE_REQUIRED");
  return { target, fixture: fixtureValue, targetSha256: sha(bytes), identities, root, installed, scenario };
}

const reportIndex = process.argv.indexOf("--report");
const output = reportIndex >= 0 ? process.argv[reportIndex + 1] : null;
need(output && isAbsolute(output), "ABSOLUTE_NEW_REPORT_DIRECTORY_REQUIRED");
await mkdir(output, { recursive: false, mode: 0o700 });
const report = { schema: "finnor.z1.native-e2e-report.v1", status: "NOT_RUN", startedAt: new Date().toISOString(),
  requiredEnvironmentNames: required, presentEnvironmentNames: required.filter(key => Boolean(process.env[key])),
  sourceOwnerFlow: "NOT_RUN", installedOwnerFlow: "NOT_RUN", physicalNativeRecovery: "NOT_RUN",
  nativeLogicalExposureFalsifier: "NOT_RUN", nativeEpisodeExhaustionFalsifier: "NOT_RUN",
  protectedAdmission: false, productionActivated: false, externalEffectsAuthorized: false, actions: [] };
try {
  const guarded = await guardTarget();
  report.targetSha256 = guarded.targetSha256; report.targetFlavor = guarded.target.flavor;
  report.scenario = guarded.scenario;
  report.sourceCommit = guarded.installed.sourceCommit; report.sourceTree = guarded.installed.sourceTree;
  report.nativeRuntimeDigest = guarded.installed.nativeRuntimeDigest; report.processIdentities = guarded.identities;
  await privateJSON(resolve(output, "doctor.json"), { ...report, status: "DOCTOR_PASSED_NETWORK_AND_DB_STILL_UNTOUCHED" });
  const require = createRequire(resolve(root, "finnor-os/package.json"));
  const { tsImport } = await import(require.resolve("tsx/esm/api"));
  const { runNativeEpisode } = await tsImport(new URL("./native-e2e-run.mjs", import.meta.url).href, import.meta.url);
  await runNativeEpisode({ ...guarded, processIdentity, privateJSON, need, sha }, output, report);
  report.status = guarded.scenario === "ORIGINAL_EPISODE" ? "PASSED" : "PASSED_BOUNDED_NEGATIVE_ONLY";
} catch (error) {
  report.status = report.mutationsStarted ? "FAILED" : "NOT_RUN";
  // No raw driver, PostgreSQL, browser or auth errors: they may carry private data.
  report.blocker = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
    ? error.message : "NATIVE_PREREQUISITE_OR_OWNER_FLOW_FAILED_PRIVATE_DIAGNOSTIC_NOT_EXPORTED";
  process.exitCode = report.status === "NOT_RUN" ? 2 : 1;
} finally {
  report.finishedAt = new Date().toISOString();
  report.fullFinancialCost = "UNKNOWN_NOT_ZERO";
  await privateJSON(resolve(output, "report.json"), report);
  console.log(JSON.stringify({ status: report.status, blocker: report.blocker ?? null, actions: report.actions.length }));
}
