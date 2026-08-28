import "dotenv/config";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { closePool, getPool, pgConnectionConfig } from "@finnor/db";
import {
  ACTION_HARDENING_SPEC,
  TOTAL_ACTION_COUNT,
} from "./action-hardening-spec";
import { discoverActionRegistry } from "./discover-action-registry";
import {
  certificationStatus,
  createFinalCertification,
  FINAL_CERTIFICATION_GATE_KEYS,
  gateResult,
  sanitizeEvidence,
  sha256,
  type CertificationGateResult,
  type CertificationStatus,
  type FinalDeploymentComponent,
  type FinalMigrationBinding,
} from "./certification-model";
import { CertificationArtifactStore, persistFinalCertification } from "./certification-store";
import { inspectCoreDiff, isSharedCorePath, type CoreDiffResult } from "./core-diff-guard";
import { runCoreCommandGates } from "./core-certification-gates";
import { evaluateStagingGuards, type StagingGuardReport } from "./staging-guards";
import {
  evaluateGoldenBusinessSuite,
  evaluateGoldenSafety,
  GOLDEN_BUSINESS_JOBS,
  GOLDEN_OUTCOMES,
  type GoldenOutcome,
  type GoldenSuiteResult,
} from "./golden-business-suite";

const SCRIPT_DIR = resolve(fileURLToPath(import.meta.url), "..");
const FINNOR_OS_ROOT = resolve(SCRIPT_DIR, "../..");
const REPO_ROOT = resolve(FINNOR_OS_ROOT, "..");
const CONTRACT_PATH = resolve(REPO_ROOT, "infra/deployment/production.contract.json");
const ACTION_MANIFEST_PATH = resolve(REPO_ROOT, "docs/release/generated/action-manifest.json");
const MIGRATIONS_DIR = resolve(FINNOR_OS_ROOT, "packages/db/migrations");
const MIGRATION_BUNDLE_PATH = resolve(FINNOR_OS_ROOT, "packages/db/migrations-bundle.ts");

type CliOptions = Record<string, string | boolean>;

function cliArgs(): { command: string; options: CliOptions } {
  const args = process.argv.slice(2);
  const command = args.find((arg) => !arg.startsWith("--")) ?? "help";
  const options = Object.fromEntries(args.filter((arg) => arg.startsWith("--")).map((argument) => {
    const [key, ...rest] = argument.slice(2).split("=");
    return [key!, rest.length ? rest.join("=") : true];
  }));
  return { command, options };
}

function stringOption(options: CliOptions, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

function gitSha(): string {
  return git(REPO_ROOT, ["rev-parse", "HEAD"]).toLowerCase();
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return "unknown";
}

function blockedConfiguration(output: string): boolean {
  return /BLOCKED[-_ ]CONFIG|(?:environment variable|env(?:ironment)?|secret|credential|configuration|config)\b.{0,80}\b(?:required|missing|not set|unset)\b|\b(?:required|missing|unset)\b.{0,80}\b(?:environment variable|secret|credential|configuration)\b|must provide.{0,80}(?:credential|config|environment)|no .{0,40} credential/i.test(output);
}

interface CommandObservation {
  label: string;
  command: string;
  cwd: string;
  exitCode: number;
  status: CertificationStatus;
  timedOut: boolean;
}

function runCommand(
  label: string,
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): CommandObservation {
  const isTestCommand = command === "npm" && args.includes("test");
  const result = spawnSync(command, args, {
    cwd,
    env: {
      ...process.env,
      LIVE_SMOKE_ALLOWED: "0",
      ...env,
      ...(isTestCommand ? { NODE_ENV: "test", FINNOR_ENVIRONMENT: "test" } : {}),
    },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 40 * 60_000,
  });
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const stderr = typeof result.stderr === "string" ? result.stderr : result.error?.message ?? "";
  const timedOut = result.signal === "SIGTERM" && Boolean(result.error);
  const exitCode = result.status ?? 1;
  return {
    label,
    command: `${command} ${args.join(" ")}`,
    cwd: relative(REPO_ROOT, cwd) || ".",
    exitCode,
    status: exitCode === 0 ? "PASS" : blockedConfiguration(`${stdout}\n${stderr}`) ? "BLOCKED_CONFIG" : "FAIL",
    timedOut,
  };
}

function commandGate(gate: string, observations: readonly CommandObservation[], extra: Record<string, unknown> = {}): CertificationGateResult {
  return gateResult(gate, certificationStatus(observations), {
    ...extra,
    commands: observations.map(({ label, command, cwd, exitCode, status, timedOut }) => ({ label, command, cwd, exitCode, status, timedOut })),
  });
}

function blockedGate(gate: string, reason: string, evidence: Record<string, unknown> = {}): CertificationGateResult {
  return gateResult(gate, "BLOCKED_CONFIG", { reason, ...evidence });
}

async function currentSourceTreeHash(): Promise<string> {
  const tracked = git(REPO_ROOT, ["ls-files", "-z"]).split("\0").filter(Boolean);
  const untracked = git(REPO_ROOT, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
  const paths = [...new Set([...tracked, ...untracked])].filter(isSharedCorePath).sort();
  const rows = await Promise.all(paths.map(async (path) => {
    try {
      const bytes = await readFile(resolve(REPO_ROOT, path));
      return { path, sha256: sha256(bytes.toString("base64")) };
    } catch (error) {
      return { path, missing: errorCode(error) };
    }
  }));
  return sha256(rows);
}

async function migrationBinding(): Promise<FinalMigrationBinding & { files: string[] }> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith(".sql")).sort();
  if (files.length === 0) throw new Error("No SQL migrations found");
  const entries = await Promise.all(files.map(async (name) => {
    const text = await readFile(join(MIGRATIONS_DIR, name), "utf8");
    return { name, sha256: sha256(text) };
  }));
  const bundleHash = existsSync(MIGRATION_BUNDLE_PATH) ? sha256(await readFile(MIGRATION_BUNDLE_PATH, "utf8")) : null;
  return {
    head: files.at(-1)!,
    sourceHash: sha256(entries),
    schemaHash: sha256({ schema: "finnor_os", migrations: entries, bundleHash }),
    files,
  };
}

async function inspectDatabase(expectedHead: string): Promise<{
  status: CertificationStatus;
  migrationHead: string | null;
  schemaHash: string | null;
  finalTable: boolean;
  errorCode?: string;
}> {
  const url = process.env.DATABASE_URL;
  if (!url) return { status: "BLOCKED_CONFIG", migrationHead: null, schemaHash: null, finalTable: false, errorCode: "DATABASE_URL_MISSING" };
  const client = new pg.Client({ ...pgConnectionConfig(url), connectionTimeoutMillis: 5_000, query_timeout: 15_000 });
  try {
    await client.connect();
    const migrations = await client.query<{ name: string }>("SELECT name FROM finnor_os._migrations ORDER BY name");
    const columns = await client.query(
      `SELECT table_name,column_name,data_type,is_nullable,column_default
       FROM information_schema.columns WHERE table_schema='finnor_os' ORDER BY table_name,ordinal_position`,
    );
    const constraints = await client.query(
      `SELECT c.relname table_name,con.conname constraint_name,con.contype constraint_type,
         pg_get_constraintdef(con.oid,true) definition
       FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='finnor_os' ORDER BY c.relname,con.conname`,
    );
    const policies = await client.query(
      `SELECT tablename table_name,policyname policy_name,permissive,roles::text,cmd command,
         qual using_expression,with_check check_expression
       FROM pg_policies WHERE schemaname='finnor_os' ORDER BY tablename,policyname`,
    );
    const triggers = await client.query(
      `SELECT c.relname table_name,t.tgname trigger_name,pg_get_triggerdef(t.oid,true) definition
       FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
       JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='finnor_os' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`,
    );
    const table = await client.query<{ table_name: string | null }>("SELECT to_regclass('finnor_os.final_certifications') AS table_name");
    const names = migrations.rows.map((row) => row.name);
    const schemaHash = sha256({ migrations: names, columns: columns.rows, constraints: constraints.rows, policies: policies.rows, triggers: triggers.rows });
    const migrationHead = names.at(-1) ?? null;
    const finalTable = Boolean(table.rows[0]?.table_name);
    return {
      status: migrationHead === expectedHead && finalTable ? "PASS" : "FAIL",
      migrationHead,
      schemaHash,
      finalTable,
    };
  } catch (error) {
    return { status: "BLOCKED_CONFIG", migrationHead: null, schemaHash: null, finalTable: false, errorCode: errorCode(error) };
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function actionManifestBinding(): Promise<{
  count: number;
  generatedHash: string;
  sourceHash: string;
  generatedPath: string;
  status: CertificationStatus;
  evidence: Record<string, unknown>;
}> {
  const discovered = await discoverActionRegistry();
  const manifest = JSON.parse(await readFile(ACTION_MANIFEST_PATH, "utf8")) as {
    actionCount: number;
    actions: unknown[];
  };
  const generatedHash = sha256({ actionCount: manifest.actionCount, actions: manifest.actions });
  const sourceHash = sha256(ACTION_HARDENING_SPEC);
  const status: CertificationStatus = manifest.actionCount === TOTAL_ACTION_COUNT && discovered.length === TOTAL_ACTION_COUNT
    ? "PASS" : "FAIL";
  return {
    count: manifest.actionCount,
    generatedHash,
    sourceHash,
    generatedPath: relative(REPO_ROOT, ACTION_MANIFEST_PATH),
    status,
    evidence: {
      generatedPath: relative(REPO_ROOT, ACTION_MANIFEST_PATH),
      generatedCount: manifest.actionCount,
      discoveredCount: discovered.length,
      fixedSpecCount: ACTION_HARDENING_SPEC.length,
      currentActionCount: TOTAL_ACTION_COUNT,
    },
  };
}

function contractComponents(contract: Record<string, any>, deploymentEvidence: unknown): FinalDeploymentComponent[] {
  const evidence = deploymentEvidence && typeof deploymentEvidence === "object" ? deploymentEvidence as Record<string, unknown> : {};
  return ["frontend", "api", "worker"].map((name) => {
    const target = contract.topology?.[name] as Record<string, unknown> | undefined;
    const observed = evidence[name] && typeof evidence[name] === "object" ? evidence[name] as Record<string, unknown> : {};
    const commitSha = typeof observed.commitSha === "string" ? observed.commitSha.toLowerCase() : null;
    const version = typeof observed.version === "string" ? observed.version : null;
    const buildId = typeof observed.buildId === "string" ? observed.buildId : null;
    const hasObservedIdentity = Boolean(commitSha && version && buildId);
    const status: CertificationStatus = !target || !hasObservedIdentity
      ? "BLOCKED_CONFIG"
      : commitSha === gitSha() ? "PASS" : "FAIL";
    return {
      name,
      provider: typeof target?.provider === "string" ? target.provider : "unknown",
      projectOrResource: String(target?.projectName ?? target?.resourceName ?? "unknown"),
      version,
      commitSha,
      buildId,
      status,
    };
  });
}

function componentEvidence(components: readonly FinalDeploymentComponent[]): Record<string, unknown> {
  return Object.fromEntries(components.map((component) => [component.name, {
    provider: component.provider,
    projectOrResource: component.projectOrResource,
    version: component.version,
    commitSha: component.commitSha,
    buildId: component.buildId,
    status: component.status,
  }]));
}

function sourceGate(diff: CoreDiffResult, sourceTreeHash: string): CertificationGateResult {
  let originMainSha: string | null = null;
  try { originMainSha = git(REPO_ROOT, ["rev-parse", "origin/main"]).toLowerCase(); } catch { originMainSha = null; }
  const allChangedPaths = diff.changedSharedCorePaths.length + diff.changedClientPaths.length;
  const canonical = originMainSha === diff.canonicalCoreSha;
  const clean = diff.clean && diff.changedClientPaths.length === 0;
  return gateResult("source_provenance", clean && canonical ? "PASS" : "FAIL", {
    canonicalGitSha: diff.canonicalCoreSha,
    originMainSha,
    canonicalRemote: "origin/main",
    canonicalMatchesOriginMain: canonical,
    canonicalCoreSourceTreeHash: diff.coreSourceTreeHash,
    currentSourceTreeHash: sourceTreeHash,
    currentTreeMatchesCanonicalCore: sourceTreeHash === diff.coreSourceTreeHash,
    changedPathCount: allChangedPaths,
    changedSharedCorePathCount: diff.changedSharedCorePaths.length,
    changedClientPathCount: diff.changedClientPaths.length,
    cleanWorktreeRequired: true,
  });
}

function databaseGateStatus(observation: Awaited<ReturnType<typeof inspectDatabase>>, binding: FinalMigrationBinding): CertificationGateResult {
  const status = observation.status === "PASS" && observation.schemaHash ? "PASS" : observation.status;
  return gateResult("database_restore", status, {
    migrationHeadExpected: binding.head,
    migrationHeadObserved: observation.migrationHead,
    finalCertificationTablePresent: observation.finalTable,
    schemaHashObserved: observation.schemaHash,
    connectionErrorCode: observation.errorCode ?? null,
    restoreMechanics: "database restore drill is reported separately; no restore success is inferred from schema inspection",
  });
}

function safetyGate(suite: GoldenSuiteResult, safety: ReturnType<typeof evaluateGoldenSafety>, test: CommandObservation): {
  gate: CertificationGateResult;
  zeroTolerance: { status: CertificationStatus; criticalFailures: string[]; safetyChecks: Record<string, CertificationStatus> };
} {
  const criticalFailures = [...new Set([...suite.criticalFailures, ...safety.failures, ...(test.status === "FAIL" ? ["secret-and-safety-tests"] : [])])].sort();
  const status: CertificationStatus = criticalFailures.length
    ? "FAIL"
    : test.status === "BLOCKED_CONFIG"
      ? "BLOCKED_CONFIG"
      : "PASS";
  return {
    gate: gateResult("zero_tolerance_safety", status, {
      goldenSafety: safety,
      criticalGoldenJobFailures: suite.criticalFailures,
      test: { label: test.label, command: test.command, status: test.status, exitCode: test.exitCode },
      rawSecretsIncluded: false,
      falseSuccessPolicy: "unknown external outcomes remain reconciliation/manual/blocking outcomes",
    }),
    zeroTolerance: { status, criticalFailures, safetyChecks: { ...safety.checks, safety_test_suite: test.status } },
  };
}

function stagingGate(gate: string, report: StagingGuardReport): CertificationGateResult {
  return gateResult(gate, report.status === "PASS" ? "PASS" : "BLOCKED_CONFIG", {
    mode: report.mode,
    productionEgress: report.productionEgress,
    targetHosts: report.targetHosts,
    missing: report.missing,
    failures: report.failures,
    observations: report.observations,
  });
}

async function readObservedGoldenOutcomes(options: CliOptions): Promise<ReadonlyMap<string, GoldenOutcome>> {
  const path = stringOption(options, "golden-outcomes");
  if (!path) return new Map();
  const parsed = JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
  const source = parsed && typeof parsed === "object" && !Array.isArray(parsed) && "outcomes" in parsed
    ? (parsed as { outcomes?: unknown }).outcomes
    : parsed;
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("--golden-outcomes must be a JSON object of job id to observed outcome");
  const allowed = new Set<string>(GOLDEN_OUTCOMES);
  const outcomes = new Map<string, GoldenOutcome>();
  for (const [jobId, outcome] of Object.entries(source as Record<string, unknown>)) {
    if (!GOLDEN_BUSINESS_JOBS.some((job) => job.id === jobId || job.evidenceRef === jobId)) throw new Error(`Unknown golden job in --golden-outcomes: ${jobId}`);
    if (typeof outcome !== "string" || !allowed.has(outcome)) throw new Error(`Invalid observed outcome for golden job ${jobId}`);
    outcomes.set(jobId, outcome as GoldenOutcome);
  }
  return outcomes;
}

export async function runFinalCertificationCommand(options: CliOptions, store: CertificationArtifactStore): Promise<void> {
  const dryRun = options["dry-run"] === true;
  const canonicalGitSha = (stringOption(options, "core-sha") ?? gitSha()).toLowerCase();
  const diff = inspectCoreDiff(REPO_ROOT, canonicalGitSha);
  const sourceTreeHash = await currentSourceTreeHash();
  const migration = await migrationBinding();
  const database = dryRun
    ? { status: "BLOCKED_CONFIG" as const, migrationHead: null, schemaHash: null, finalTable: false, errorCode: "DRY_RUN" }
    : await inspectDatabase(migration.head);
  const observedGoldenOutcomes = await readObservedGoldenOutcomes(options);
  const contractText = await readFile(CONTRACT_PATH, "utf8");
  const contract = JSON.parse(contractText) as Record<string, any>;
  const deploymentEvidencePath = stringOption(options, "deployment-evidence");
  const deploymentEvidence = deploymentEvidencePath ? JSON.parse(await readFile(resolve(deploymentEvidencePath), "utf8")) : {};
  const components = contractComponents(contract, deploymentEvidence);
  const deployment = {
    contractHash: sha256(contractText),
    contractSchemaVersion: Number(contract.schemaVersion ?? 0),
    environment: String(contract.environment ?? "unknown"),
    canonicalRemote: String(contract.canonicalGit?.remote ?? "unknown"),
    canonicalBranch: String(contract.canonicalGit?.branch ?? "unknown"),
    components,
    evidence: {
      contractPath: relative(REPO_ROOT, CONTRACT_PATH),
      requiredMigrationHead: contract.release?.requiredMigrationHead ?? null,
      topology: contract.topology,
      observedComponents: componentEvidence(components),
      providedDeploymentEvidence: Boolean(deploymentEvidencePath),
    },
  };
  const actionManifest = await actionManifestBinding();

  const gates: CertificationGateResult[] = [];
  gates.push(sourceGate(diff, sourceTreeHash));

  let coreGates: CertificationGateResult[];
  if (dryRun || options["skip-core"] === true) {
    coreGates = [blockedGate("core_regression", dryRun ? "dry run" : "core command matrix skipped")];
  } else {
    const existing = runCoreCommandGates(REPO_ROOT);
    coreGates = [gateResult("core_regression", certificationStatus(existing), {
      suite: existing.map(({ gate, status, evidenceHash }) => ({ gate, status, evidenceHash })),
      currentCoreSuite: "phase6-core-v1",
    })];
  }
  gates.push(coreGates[0]!);

  const p0p5Files = [
    "tests/unit/client-manifest-identity-access.test.ts",
    "tests/unit/computer-execution-fabric.test.ts",
    "tests/unit/universal-actions-contract.test.ts",
    "tests/integration/phase0-company-world.test.ts",
    "tests/integration/identity-access-fabric.test.ts",
    "tests/integration/universal-action-fabric.test.ts",
    "tests/integration/computer-execution-fabric.test.ts",
    "tests/integration/event-driven-objective-runtime.test.ts",
    "tests/integration/phase5-connection-lifecycle.test.ts",
  ];
  const securityFiles = [
    "tests/integration/tenant-isolation.test.ts",
    "tests/integration/tenant-credential-isolation.test.ts",
    "tests/integration/authz.test.ts",
    "tests/unit/secrets.test.ts",
  ];
  const databaseEnv: Record<string, string> = process.env.DATABASE_URL ? { DATABASE_URL: process.env.DATABASE_URL } : {};
  const regression = dryRun
    ? { label: "P0-P5 regression", command: "not run (dry run)", cwd: "finnor-os", exitCode: 2, status: "BLOCKED_CONFIG" as const, timedOut: false }
    : runCommand("P0-P5 regression", "npm", ["test", "--", "--run", ...p0p5Files], FINNOR_OS_ROOT, databaseEnv);
  const security = dryRun
    ? { label: "adversarial security regression", command: "not run (dry run)", cwd: "finnor-os", exitCode: 2, status: "BLOCKED_CONFIG" as const, timedOut: false }
    : runCommand("adversarial security regression", "npm", ["test", "--", "--run", ...securityFiles], FINNOR_OS_ROOT, databaseEnv);
  gates.push(commandGate("client_regression", [regression], { requiredCoverage: "P0 company-world, P1 identity/access, P2 universal actions, P3 computer, P4 events, P5 connections" }));

  const actionContract = dryRun
    ? { label: "current action contract", command: "not run (dry run)", cwd: "finnor-os", exitCode: 2, status: "BLOCKED_CONFIG" as const, timedOut: false }
    : runCommand("current action contract", "npm", ["run", "release:contract"], FINNOR_OS_ROOT, {
      ...databaseEnv,
      CERTIFICATION_SEED_ALLOWED: process.env.CERTIFICATION_SEED_ALLOWED ?? "0",
      CERTIFICATION_TEST_EMAILS: process.env.CERTIFICATION_TEST_EMAILS ?? "",
      CERTIFICATION_TEST_PHONES: process.env.CERTIFICATION_TEST_PHONES ?? "",
    });
  const contractManifestGate = actionManifest.status === "PASS" && actionContract.status === "PASS"
    ? "PASS" as const
    : actionContract.status === "BLOCKED_CONFIG" ? "BLOCKED_CONFIG" as const : "FAIL" as const;
  gates.push(gateResult("golden_business_suite", contractManifestGate, {
    actionManifest: actionManifest.evidence,
    contractMatrix: { status: actionContract.status, exitCode: actionContract.exitCode, command: actionContract.command },
  }));

  const verifiedEvidence = new Set<string>();
  if (actionContract.status === "PASS") {
    for (const job of GOLDEN_BUSINESS_JOBS.filter((item) => item.proofKind === "contract")) verifiedEvidence.add(job.id);
  }
  const databaseEvidence = new Set<string>();
  if (regression.status === "PASS") for (const ref of ["phase0-company-world", "p1-identity-access-fabric", "p2-universal-action-fabric", "p3-computer-execution-fabric", "p4-event-driven-objective-runtime", "p5-connection-lifecycle"]) databaseEvidence.add(ref);
  if (security.status === "PASS") databaseEvidence.add("p0-p5-security-batch");
  const suite = evaluateGoldenBusinessSuite({ verifiedEvidence, databaseEvidence, observedOutcomes: observedGoldenOutcomes });
  const safetyTests = dryRun
    ? { label: "secret/privacy safety tests", command: "not run (dry run)", cwd: "finnor-os", exitCode: 2, status: "BLOCKED_CONFIG" as const, timedOut: false }
    : runCommand("secret/privacy safety tests", "npm", ["test", "--", "--run", "tests/unit/secrets.test.ts", "tests/unit/logger-pii-redaction.test.ts", "tests/unit/tool-registry-pii.test.ts", "tests/unit/release-certification.test.ts"], FINNOR_OS_ROOT);
  const safety = safetyGate(suite, evaluateGoldenSafety(), safetyTests);
  // Replace the contract-only summary gate with the complete measured 100-row
  // result. The current action contract is retained inside its evidence.
  gates[gates.findIndex((gate) => gate.gate === "golden_business_suite")] = gateResult("golden_business_suite", suite.status, {
    totalJobs: suite.totalJobs,
    distribution: suite.distribution,
    correctResolvePlan: suite.correctResolvePlan,
    correctEndToEnd: suite.correctEndToEnd,
    blockedResolvePlan: suite.blockedResolvePlan,
    blockedEndToEnd: suite.blockedEndToEnd,
    resolvePlanRate: suite.resolvePlanRate,
    endToEndRate: suite.endToEndRate,
    resolvePlanThreshold: 0.98,
    endToEndThreshold: 0.95,
    outcomeEvidenceRequired: true,
    observedOutcomeCount: suite.jobs.filter((job) => job.observedOutcome !== null).length,
    observedOutcomeEvidenceProvided: observedGoldenOutcomes.size > 0,
    actionManifest: actionManifest.evidence,
    actionContract: { status: actionContract.status, exitCode: actionContract.exitCode },
    jobs: suite.jobs,
  });
  gates.push(safety.gate);

  const idempotencyFiles = [
    "tests/integration/queue.test.ts",
    "tests/integration/intake-idempotency.test.ts",
    "tests/integration/external-operations-idempotency.test.ts",
    "tests/integration/inbox-dedup.test.ts",
    "tests/integration/outbox-dispatch.test.ts",
    "tests/integration/poison-job-replay-drill.test.ts",
  ];
  const recoveryFiles = [
    "tests/integration/workflow-runtime.test.ts",
    "tests/integration/langgraph-workflow-actions.test.ts",
    "tests/integration/compensation.test.ts",
    "tests/integration/poison-job-replay-drill.test.ts",
  ];
  const idempotency = dryRun
    ? { label: "idempotency and unknown-outcome tests", command: "not run (dry run)", cwd: "finnor-os", exitCode: 2, status: "BLOCKED_CONFIG" as const, timedOut: false }
    : runCommand("idempotency and unknown-outcome tests", "npm", ["test", "--", "--run", ...idempotencyFiles], FINNOR_OS_ROOT, databaseEnv);
  const recovery = dryRun
    ? { label: "multi-worker recovery tests", command: "not run (dry run)", cwd: "finnor-os", exitCode: 2, status: "BLOCKED_CONFIG" as const, timedOut: false }
    : runCommand("multi-worker recovery tests", "npm", ["test", "--", "--run", ...recoveryFiles], FINNOR_OS_ROOT, databaseEnv);
  gates.push(commandGate("idempotency_unknown_outcomes", [idempotency], { unknownOutcomePolicy: "reconciliation_required; never implicit success" }));
  gates.push(commandGate("multi_worker_recovery", [recovery], { leaseRecoveryAndCheckpointCoverage: true }));

  const restoreTools = ["pg_dump", "pg_restore", "createdb", "dropdb"];
  const missingRestoreTools = restoreTools.filter((tool) => {
    try { execFileSync("which", [tool], { encoding: "utf8" }); return false; } catch { return true; }
  });
  let restoreObservation: CommandObservation | null = null;
  if (!dryRun && missingRestoreTools.length === 0 && process.env.DATABASE_URL) {
    restoreObservation = runCommand("pg_dump/pg_restore backup restore drill", "npx", ["tsx", "scripts/backup-restore-drill.ts"], FINNOR_OS_ROOT, databaseEnv);
  }
  if (!dryRun && missingRestoreTools.length > 0 && process.env.BACKUP_GITHUB_TOKEN && process.env.BACKUP_GITHUB_REPO && process.env.DATABASE_URL) {
    restoreObservation = runCommand("managed backup restore drill", "npx", ["tsx", "scripts/restore-drill-from-backup.ts"], FINNOR_OS_ROOT, databaseEnv);
  }
  gates.push(restoreObservation
    ? commandGate("database_restore", [restoreObservation], { missingPostgresClientTools: missingRestoreTools })
    : blockedGate("database_restore", "no configured real restore drill was runnable", { missingPostgresClientTools: missingRestoreTools, managedBackupConfigured: Boolean(process.env.BACKUP_GITHUB_TOKEN && process.env.BACKUP_GITHUB_REPO) }));

  const releaseTruth = dryRun
    ? { label: "deployment truth validator", command: "not run (dry run)", cwd: ".", exitCode: 2, status: "BLOCKED_CONFIG" as const, timedOut: false }
    : runCommand("deployment truth validator", "node", ["scripts/release/validate-deployment-truth.mjs"], REPO_ROOT);
  const rollbackContract = dryRun
    ? { label: "release/rollback contract tests", command: "not run (dry run)", cwd: ".", exitCode: 2, status: "BLOCKED_CONFIG" as const, timedOut: false }
    : runCommand("release/rollback contract tests", "node", ["scripts/release/release-policy.test.mjs"], REPO_ROOT);
  const componentStatus = certificationStatus(components);
  const releaseGateStatus: CertificationStatus = releaseTruth.status === "FAIL" || rollbackContract.status === "FAIL" || componentStatus === "FAIL"
    ? "FAIL"
    : releaseTruth.status === "BLOCKED_CONFIG" || rollbackContract.status === "BLOCKED_CONFIG" || componentStatus === "BLOCKED_CONFIG"
      ? "BLOCKED_CONFIG" : "PASS";
  gates.push(gateResult("release_deployment_rollback", releaseGateStatus, {
    contractHash: deployment.contractHash,
    contractValidation: { status: releaseTruth.status, exitCode: releaseTruth.exitCode },
    rollbackContract: { status: rollbackContract.status, exitCode: rollbackContract.exitCode },
    components: componentEvidence(components),
    liveRollbackEvidenceProvided: Boolean(stringOption(options, "deployment-evidence")),
  }));

  const chaos = dryRun
    ? null
    : process.env.FINNOR_CHAOS_TEST_CONTEXT === "1"
      ? runCommand("provider/queue chaos matrix", "npm", ["run", "release:chaos"], FINNOR_OS_ROOT, { FINNOR_CHAOS_TEST_CONTEXT: "1", LIVE_SMOKE_ALLOWED: "0" })
      : null;
  gates.push(chaos
    ? commandGate("provider_chaos", [chaos], { productionEgress: false, providerPayloadsPrinted: false })
    : blockedGate("provider_chaos", dryRun ? "dry run" : "FINNOR_CHAOS_TEST_CONTEXT=1 is required for the guarded local chaos runner", { productionEgress: false }));

  const loadReport = evaluateStagingGuards("load");
  gates.push(stagingGate("load_latency_reliability", loadReport));

  const liveReport = evaluateStagingGuards("live-smoke");
  let steel: CommandObservation | null = null;
  if (!dryRun && process.env.STEEL_LIVE === "1" && process.env.STEEL_API_KEY?.trim()) {
    steel = runCommand("Steel provider canary", "npm", ["run", "test:live:steel", "--", "--run"], FINNOR_OS_ROOT, { STEEL_LIVE: "1" });
  }
  const liveObservations = steel ? [steel] : [];
  const liveStatus: CertificationStatus = liveReport.status !== "PASS"
    ? liveObservations.some((item) => item.status === "FAIL") ? "FAIL" : "BLOCKED_CONFIG"
    : liveObservations.length === 0 ? "BLOCKED_CONFIG" : certificationStatus(liveObservations);
  gates.push(gateResult("live_canaries", liveStatus, {
    stagingGuard: { status: liveReport.status, missing: liveReport.missing, failures: liveReport.failures, targetHosts: liveReport.targetHosts },
    steelConfigured: Boolean(process.env.STEEL_LIVE === "1" && process.env.STEEL_API_KEY?.trim()),
    steel: steel ? { status: steel.status, exitCode: steel.exitCode, command: steel.command } : { status: "BLOCKED_CONFIG", reason: "Steel live credentials/configuration not present" },
    productionEgress: false,
  }));

  gates.push(commandGate("secret_privacy", [safetyTests], {
    rawSecretsPrinted: false,
    finalArtifactSanitized: true,
    secretValuesReadIntoArtifact: false,
  }));

  const score = {
    totalJobs: suite.totalJobs,
    correctResolvePlan: suite.correctResolvePlan,
    correctEndToEnd: suite.correctEndToEnd,
    blockedResolvePlan: suite.blockedResolvePlan,
    blockedEndToEnd: suite.blockedEndToEnd,
    resolvePlanRate: suite.resolvePlanRate,
    endToEndRate: suite.endToEndRate,
    resolvePlanThreshold: 0.98,
    endToEndThreshold: 0.95,
    distribution: suite.distribution,
  };
  const artifact = createFinalCertification({
    canonicalGitSha,
    sourceTreeHash,
    coreSourceTreeHash: diff.coreSourceTreeHash,
    migration: {
      head: migration.head,
      sourceHash: migration.sourceHash,
      schemaHash: database.schemaHash ?? migration.schemaHash,
    },
    actionManifest: {
      count: actionManifest.count,
      generatedHash: actionManifest.generatedHash,
      sourceHash: actionManifest.sourceHash,
      generatedPath: actionManifest.generatedPath,
    },
    deployment,
    score,
    zeroTolerance: safety.zeroTolerance,
    gates: gates.sort((a, b) => a.gate.localeCompare(b.gate)),
    source: process.env.FINNOR_RELEASE_SOURCE ?? "release:certify/final",
  });

  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, status: artifact.status, score: artifact.score, gateStatuses: artifact.gates.map(({ gate, status }) => ({ gate, status })) }, null, 2));
    process.exitCode = artifact.status === "PASS" ? 0 : artifact.status === "BLOCKED_CONFIG" ? 2 : 1;
    return;
  }

  const stored = await store.writeFinalCertification(artifact);
  let durablePersistence: CertificationStatus | "NOT_ATTEMPTED" = "NOT_ATTEMPTED";
  if (process.env.DATABASE_URL && database.status !== "BLOCKED_CONFIG") {
    try {
      await persistFinalCertification(getPool(), stored.artifact);
      durablePersistence = "PASS";
    } catch (error) {
      durablePersistence = "BLOCKED_CONFIG";
      console.error(`Final certification durable persistence did not complete (${errorCode(error)})`);
    }
  }
  console.log(JSON.stringify({
    status: stored.artifact.status,
    certificationId: stored.artifact.certificationId,
    artifactPath: stored.path,
    artifactReused: stored.reused,
    artifactHash: sha256(JSON.stringify(stored.artifact)),
    canonicalGitSha: stored.artifact.canonicalGitSha,
    sourceTreeHash: stored.artifact.sourceTreeHash,
    coreSourceTreeHash: stored.artifact.coreSourceTreeHash,
    migration: stored.artifact.migration,
    actionCount: stored.artifact.actionManifest.count,
    score: stored.artifact.score,
    gateStatuses: stored.artifact.gates.map(({ gate, status }) => ({ gate, status })),
    durablePersistence,
  }, null, 2));
  process.exitCode = stored.artifact.status === "PASS" ? 0 : stored.artifact.status === "BLOCKED_CONFIG" ? 2 : 1;
}

async function main(): Promise<void> {
  const { command, options } = cliArgs();
  const storeRoot = resolve(stringOption(options, "store") ?? resolve(FINNOR_OS_ROOT, ".certifications"));
  const store = new CertificationArtifactStore(storeRoot);
  if (command === "final") return runFinalCertificationCommand(options, store);
  console.error("Usage: npm run release:certify -- final [--core-sha=<40-char-sha>] [--deployment-evidence=<json>] [--golden-outcomes=<json>] [--store=<dir>] [--skip-core] [--dry-run]");
  process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }).finally(() => closePool());
}
