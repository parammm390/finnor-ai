/**
 * Local feasibility orchestration only. See matched-diagnostic-contract.md.
 * No product imports, secret loading, DB, browser, network or provider calls.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const self = fileURLToPath(import.meta.url);
const repo = resolve(dirname(self), "../../..");
const task = dirname(repo);
const owned = join(task, "matched-diagnostic-002");
const contract = join(repo, "scope-frontier5/x2-software-semantics-compiler/matched-diagnostic-contract.md");
const output = process.argv[2] === "--output" && process.argv.length === 4 ? process.argv[3] : null;
if (!output || !isAbsolute(output) || (output !== owned && !output.startsWith(owned + sep))) {
  throw new Error("FRESH_ABSOLUTE_OWNED_OUTPUT_REQUIRED");
}
if (existsSync(output)) throw new Error("OUTPUT_ALREADY_EXISTS");
if (realpathSync(dirname(output)) !== dirname(output)) throw new Error("OUTPUT_PARENT_SYMLINK_REFUSED");
mkdirSync(output, { mode: 0o700 });
const start = performance.now(), cpuStart = process.cpuUsage();
const attempts = [], pins = new Map();
const hash = value => createHash("sha256").update(value).digest("hex");
const write = (name, body) => writeFileSync(join(output, name), JSON.stringify(body, null, 2) + "\n", { flag: "wx", mode: 0o600 });
function bytes(path) {
  const stat = lstatSync(path);
  const bound = path === realpathSync(process.execPath) ? 256 : 32;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > bound * 1024 * 1024) throw new Error("UNSAFE_OR_OVERSIZED_INPUT");
  return readFileSync(path);
}
function pin(path) {
  const value = { path, sha256: hash(bytes(path)) };
  pins.set(path, value);
  return value;
}
function json(path) { pin(path); return JSON.parse(bytes(path).toString("utf8")); }
function checkedPath(base, path) {
  const full = resolve(base, path);
  if (!full.startsWith(base + sep)) throw new Error("PIN_PATH_ESCAPE");
  return full;
}
function attempt(id, fn) {
  const began = performance.now();
  try {
    const observed = fn();
    attempts.push({ id, status: "COMPLETED", wallMs: performance.now() - began, observed });
    return observed;
  } catch {
    attempts.push({ id, status: "FAILED", wallMs: performance.now() - began, error: "INPUT_OR_INTEGRITY_CHECK_FAILED" });
    return null;
  }
}
function verify(list, base) {
  if (!Array.isArray(list) || !list.length) throw new Error("MISSING_PINS");
  return list.map(item => {
    const actual = pin(checkedPath(base, item.path));
    return { ...actual, expected: item.sha256, matches: actual.sha256 === item.sha256 };
  });
}
try {
  pin(contract);
  pin(self);
  const build = json(join(task, "installed-009/build-manifest.json"));
  const inputs = json(join(task, "installed-009/source-inputs.json"));
  const emitted = verify(build.emittedFiles, join(task, "installed-009/runtime"));
  const strata = [];
  for (const [id, surface, count] of [[99, "api", 15], [100, "hybrid", 16], [101, "ui", 17]]) {
    const directory = join(task, `native-e2e-${String(id).padStart(3, "0")}`);
    const evidence = attempt(`register-historical-${id}`, () => {
      const freeze = json(join(directory, "freeze.json"));
      const result = json(join(directory, "results.json"));
      const beginning = json(join(directory, "installed-beginning.json"));
      const ending = json(join(directory, "installed-ending.json"));
      const model = json(join(directory, "model-freeze.json"));
      const source = verify(freeze.sourceCut.pins, repo);
      const driver = verify(freeze.driverPins, repo);
      const oracle = verify(freeze.oraclePins, join(repo, "finnor-os/scripts/x2"));
      const objective = pin(join(directory, "private/portal/held-out-objective.json"));
      const journal = bytes(join(directory, "private/portal/provider/journal.ndjson"));
      const first = JSON.parse(journal.subarray(0, journal.indexOf(10)).toString("utf8"));
      if (!first.state || first.sequence !== 1) throw new Error("INITIAL_STATE_UNAVAILABLE");
      const independentGrade = json(join(directory, "private/portal/native-grade.json"));
      pin(join(directory, "private/independent-final-state.json"));
      const compatible = surface === result.surface && surface === freeze.surface
        && freeze.installed === true && result.results.length === count
        && result.results.every(check => check.status === "PASS")
        && beginning.buildId === build.buildId && ending.buildId === build.buildId
        && beginning.status === "PASS" && ending.status === "PASS"
        && independentGrade.verdict === "PASS"
        && [...source, ...driver, ...oracle, ...emitted].every(item => item.matches);
      return {
        id, surface, directory, expectedChecks: count,
        historicalChecks: result.results.map(check => ({ id: check.id, status: check.status, wallMs: check.wallMs })),
        compatible, reuse: compatible ? "HISTORICAL_SUPPORT_ONLY" : "REJECTED_INCOMPATIBLE",
        buildId: build.buildId, productHead: inputs.head,
        objective, startingState: { initialJournalStateSha256: hash(JSON.stringify(first.state)), sequence: first.sequence },
        modelRef: model.modelRef, oracle, source, driver,
        roleConstraints: "Same frozen objective; editor submits; distinct governed approver; no expanded grants",
        publicExploration: "Only recorded authorized public surface; hidden oracle unavailable to candidates",
        applicationVersion: oracle.find(item => item.path.endsWith("application.mjs")),
        liveMatching: "NOT_ENROLLED_NO_COMPARATOR_STARTING_STATE",
      };
    });
    strata.push(evidence ?? { id, surface, reuse: "REJECTED_INPUT_FAILURE", liveMatching: "NOT_ENROLLED" });
  }
  const ownerFiles = [
    "finnor-os/packages/computer/src/runner.ts",
    "finnor-os/packages/computer/src/repository.ts",
    "finnor-os/packages/security/src/identity-access.ts",
    "finnor-os/apps/worker/src/handlers/run-computer-task.ts",
    "finnor-os/apps/worker/src/index.ts",
    "finnor-os/packages/tools/src/llm.ts",
    "finnor-os/scripts/p4/frontier-comparison.mts",
    "finnor-os/scripts/x2/run-native-e2e.mts",
  ];
  ownerFiles.forEach(path => pin(join(repo, path)));
  const registration = {
    schema: "finnor.x2.matched-diagnostic-registration.v1", frozenAt: new Date().toISOString(),
    contract: pins.get(contract), harness: pins.get(self), strata,
    runtime: { node: process.version, executable: pin(realpathSync(process.execPath)), platform: process.platform, arch: process.arch },
    installed: { buildId: build.buildId, sourceInputsDigest: build.sourceInputsDigest, emitted,
      assetQualification: "Emitted bytes checked; historical dependency/API inspections referenced, not reexecuted" },
    horizon: { diagnosticStrata: 3, armsPerStratum: 3, coldBusiness: "NOT_ENROLLED", matureReuse: "UNKNOWN", actualEligibleDemand: "UNKNOWN" },
    resources: { newBusinessExecutionsAuthorized: 0, databaseStarts: 0, browserStarts: 0, networkCalls: 0, paidProviderCalls: 0,
      matchedModel: "UNAVAILABLE", matchedLiveResourceEnvelope: "UNAVAILABLE" },
    preparation: { thisTask: "Contract/harness authored before execution; human effort unmetered",
      historicalBuildWallMs: build.wallMs, historicalBuildIsFullLifecycleCost: false,
      historicalPreparationAndAcquisitionCost: "UNMEASURED" },
    pins: [...pins.values()],
  };
  write("registration.json", registration);
  const registrationPin = pin(join(output, "registration.json"));

  // Actual preflight begins only after the immutable registration receipt exists.
  const configuration = attempt("inherited-configuration-presence", () => Object.fromEntries([
    "DATABASE_URL", "STEEL_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "AWS_BEDROCK_API_KEY",
    "AWS_BEARER_TOKEN_BEDROCK", "MISTRAL_API_KEY", "DEEPSEEK_API_KEY", "GROQ_API_KEY",
    "FINNOR_SECRET_IDS", "SECRETS_PROVIDER", "LLM_PROVIDER_PLANNING_TEXT", "LLM_MODEL_PLANNING_TEXT",
  ].map(key => [key, Boolean(process.env[key])])));
  const configFiles = attempt("standard-config-file-presence-not-loaded", () =>
    [".env", ".env.local", "finnor-os/.env", "finnor-os/.env.local"].map(path => ({
      path: join(repo, path), exists: existsSync(join(repo, path)), contentsInspected: false,
    })));
  const admission = attempt("existing-owner-source-admission-preflight", () => {
    const read = path => bytes(join(repo, path)).toString("utf8");
    const runner = read(ownerFiles[0]), identity = read(ownerFiles[2]), fixture = read(ownerFiles[7]);
    const comparator = read(ownerFiles[6]);
    return {
      basis: "EXECUTED_SOURCE_INSPECTION_NOT_RUNTIME_REFUSAL",
      freshWriteGuard: runner.includes('run.mode === "WRITE" && !["dispatching", "unknown"].includes(run.effectStatus)')
        && runner.includes('code: "effect_transport_unadmitted"'),
      incompatibleHeaderProfiles: identity.includes('row.authMethod === "application_headers" || row.credentialProvider === "disposable-private-file"')
        && fixture.includes("'disposable-private-file'") && fixture.includes("'application_headers'"),
      existingEquippedComparator: {
        source: join(repo, ownerFiles[6]), actualFinancialToolManifest: comparator.includes("execute_reusable_financial_procedure"),
        matchesApplicationObjective: false, matchedApplicationEntrypoint: "NOT_ESTABLISHED",
      },
      compatibleExistingBrowserProfiles: "NOT_ESTABLISHED_NO_SECRET_OR_DATABASE_LOOKUP",
      canonicalTaskAndEffectAuthority: "NOT_ESTABLISHED_NOT_FABRICATED",
      runtimeOwnerInvocations: 0,
    };
  });
  for (const stratum of strata) {
    for (const arm of ["X2_ENABLED", "INCUMBENT", "EQUIPPED_INTEGRATION"]) {
      attempt(`${stratum.id}-${arm}-enrollment`, () => ({
        surface: stratum.surface, businessStatus: "NOT_RUN", measurements: null,
        historicalSupport: arm === "X2_ENABLED" ? stratum.reuse : "NONE",
        reasons: ["NO_MATCHED_LIVE_ENROLLMENT", "LOCAL_ONLY_NO_EXTERNAL_EFFECT_AUTHORITY",
          ...(arm === "INCUMBENT" ? ["FRESH_WRITE_SOURCE_GUARD", "FIXTURE_PROFILE_CONTRACT_MISMATCH"] : []),
          ...(arm === "EQUIPPED_INTEGRATION" ? ["NO_MATCHED_EXISTING_APPLICATION_ENTRYPOINT"] : [])],
      }));
    }
  }
  const drift = attempt("postflight-immutable-input-check", () => [...pins.values()].filter(item => hash(bytes(item.path)) !== item.sha256));
  const integrityFailed = attempts.some(item => item.status === "FAILED") || drift?.length > 0;
  const priorAttempt = output !== owned && existsSync(join(owned, "result.json"))
    ? { receipt: pin(join(owned, "result.json")), outcome: "FAILED_BEFORE_CONFIG_PREFLIGHT",
      repair: "Runtime binary needs its own bounded 256 MiB hash allowance; generic evidence stays at 32 MiB" } : null;
  const result = {
    schema: "finnor.x2.matched-diagnostic-result.v1", completedAt: new Date().toISOString(),
    diagnosticExecution: integrityFailed ? "FAILED" : "COMPLETED",
    verdict: "INCONCLUSIVE", matchedRunGate: "UNPASSED", matchedBusinessExecutions: 0,
    matchedBusinessCompletions: 0, denominator: null, multiplier: null,
    registration: registrationPin, configuration, configFiles, admission, attempts, priorAttempt,
    arms: strata.flatMap(stratum => ["X2_ENABLED", "INCUMBENT", "EQUIPPED_INTEGRATION"].map(arm => ({
      stratum: stratum.id, surface: stratum.surface, arm, businessStatus: "NOT_RUN", measurements: null,
    }))),
    command: [process.execPath, self, "--output", output],
    orchestrationOnly: { wallMs: performance.now() - start, cpuMicroseconds: process.cpuUsage(cpuStart), maxRSS: process.resourceUsage().maxRSS },
    lifecycleCosts: { discovery: null, acquisition: null, construction: null, checking: null, execution: null,
      recovery: null, invalidation: null, maintenance: null, human: null, infrastructure: null, provider: null,
      qualification: "UNMEASURED_NOT_ZERO; historical timings are overlapping partial scopes, not summed" },
    reuseHorizon: "UNKNOWN", actualEligibleDemand: "UNKNOWN", safety: "NO_PRODUCT_IMPORTS_NO_NETWORK_NO_DB_NO_BROWSER_NO_SECRETS",
  };
  write("result.json", result);
  console.log(JSON.stringify({ diagnosticExecution: result.diagnosticExecution, verdict: result.verdict,
    matchedBusinessExecutions: 0, historical: strata.map(item => ({ id: item.id, reuse: item.reuse })),
    result: join(output, "result.json"), sha256: hash(bytes(join(output, "result.json"))) }));
  if (integrityFailed) process.exitCode = 1;
} catch {
  write("result.json", { diagnosticExecution: "FAILED", verdict: "INCONCLUSIVE", matchedBusinessExecutions: 0,
    error: "ORCHESTRATION_INPUT_FAILURE", attempts, sourcePins: [...pins.values()] });
  console.error("ORCHESTRATION_INPUT_FAILURE");
  process.exitCode = 1;
}
