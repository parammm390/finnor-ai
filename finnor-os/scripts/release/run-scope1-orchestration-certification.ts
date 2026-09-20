import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { seed } from "../../packages/db/seed";
import { CURRENT_MIGRATION_HEAD } from "../../packages/db/migration-head";
import { assertNotProductionDatabaseTarget } from "../../packages/db/production-target-guard";
import {
  SCOPE1_GATE_IDS,
  SCOPE1_MANDATORY_CASES,
  SCOPE1_MANDATORY_CASE_COUNT,
  type Scope1GateId,
} from "./scope1-orchestration-mandatory-cases";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "../..");
const REPOSITORY_ROOT = resolve(ROOT, "..");
const BIN = (name: string) => resolve(ROOT, "node_modules/.bin", name);
const SCOPE1_MIGRATION = "0136_scope1_orchestration_kernel.sql";
let databaseUrl = "";

interface CommandEvidence {
  command: string;
  durationMs: number;
  outputHash: string;
  outputLines: number;
  tests?: { files: number; total: number; passed: number; failed: number; skipped: number; todo: number };
}

interface GateEvidence {
  id: Scope1GateId;
  status: "PASS";
  durationMs: number;
  evidence: readonly CommandEvidence[];
  facts?: Record<string, unknown>;
}

interface VitestJson {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  numTodoTests: number;
  numFailedTestSuites: number;
  success: boolean;
  testResults: Array<{ status: string; name: string }>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function clean(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function parseVitest(output: string, label: string): CommandEvidence["tests"] {
  const jsonLine = clean(output).split(/\r?\n/).reverse().find((line) => line.startsWith('{"numTotalTestSuites"'));
  assert(jsonLine, `${label} emitted no machine-readable Vitest result`);
  const result = JSON.parse(jsonLine) as VitestJson;
  assert(result.success, `${label} reported success=false`);
  assert(result.numTotalTests > 0, `${label} executed zero tests`);
  assert(result.numFailedTests === 0 && result.numFailedTestSuites === 0, `${label} contained a failed test or suite`);
  assert(result.numPendingTests === 0, `${label} contained ${result.numPendingTests} skipped/pending tests`);
  assert(result.numTodoTests === 0, `${label} contained ${result.numTodoTests} todo tests`);
  assert(result.numPassedTests === result.numTotalTests, `${label} passed ${result.numPassedTests}/${result.numTotalTests} tests`);
  assert(result.testResults.length > 0 && result.testResults.every((item) => item.status === "passed"), `${label} contained a non-passing test file`);
  return {
    files: result.testResults.length,
    total: result.numTotalTests,
    passed: result.numPassedTests,
    failed: result.numFailedTests,
    skipped: result.numPendingTests,
    todo: result.numTodoTests,
  };
}

async function runCommand(
  label: string,
  command: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number; vitest?: boolean; env?: Partial<NodeJS.ProcessEnv> } = {},
): Promise<CommandEvidence> {
  console.log(`SCOPE1_COMMAND_START ${label}`);
  const started = Date.now();
  const chunks: Buffer[] = [];
  let timedOut = false;
  const exitCode = await new Promise<number>((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd ?? ROOT,
      env: {
        ...process.env,
        CI: "1",
        LOG_LEVEL: "silent",
        VITE_CONFIG_NATIVE_IGNORE_WARNING: "true",
        FINNOR_TEST_MANAGED_EXTENSIONS: "omit",
        DATABASE_URL: databaseUrl,
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = options.timeoutMs ? setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs) : undefined;
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (timer) clearTimeout(timer);
      resolvePromise(code ?? 1);
    });
  });
  const output = Buffer.concat(chunks).toString("utf8");
  if (exitCode !== 0 || timedOut) {
    throw new Error(`${label} failed${timedOut ? " (timeout)" : ""}: ${command} ${args.join(" ")}\n${clean(output).slice(-40_000)}`);
  }
  assert(!/CERTIFICATION(?:_|\s)+FAIL/i.test(clean(output)), `${label} printed a certification failure with exit code zero`);
  const evidence: CommandEvidence = {
    command: [command, ...args].join(" "),
    durationMs: Date.now() - started,
    outputHash: digest(output),
    outputLines: output.trim() ? output.trim().split(/\r?\n/).length : 0,
    ...(options.vitest ? { tests: parseVitest(output, label) } : {}),
  };
  console.log(`SCOPE1_COMMAND_PASS ${label} ${evidence.durationMs}ms${evidence.tests ? ` ${evidence.tests.passed}/${evidence.tests.total} tests` : ""}`);
  return evidence;
}

async function runGate(
  id: Scope1GateId,
  commands: Array<() => Promise<CommandEvidence>>,
  facts?: Record<string, unknown>,
): Promise<GateEvidence> {
  console.log(`SCOPE1_GATE_START ${id}`);
  const started = Date.now();
  const evidence: CommandEvidence[] = [];
  for (const command of commands) evidence.push(await command());
  const result: GateEvidence = {
    id,
    status: "PASS",
    durationMs: Date.now() - started,
    evidence,
    ...(facts ? { facts } : {}),
  };
  console.log(`SCOPE1_GATE_PASS ${id} ${result.durationMs}ms`);
  return result;
}

function vitest(label: string, files: readonly string[], timeoutMs = 600_000): () => Promise<CommandEvidence> {
  return () => runCommand(label, BIN("vitest"), [
    "run",
    ...files,
    "--reporter=json",
    "--maxWorkers=1",
    "--fileParallelism=false",
  ], { vitest: true, timeoutMs });
}

function command(
  label: string,
  executable: string,
  args: readonly string[],
  timeoutMs = 600_000,
  cwd = ROOT,
): () => Promise<CommandEvidence> {
  return () => runCommand(label, executable, args, { timeoutMs, cwd });
}

async function canConnect(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    const result = await client.query<{ value: number }>("SELECT 1::int value");
    return result.rows[0]?.value === 1;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert(address && typeof address === "object", "unable to reserve a local PostgreSQL port");
      const port = address.port;
      server.close((error) => error ? reject(error) : resolvePromise(port));
    });
  });
}

async function sourceDatabase(): Promise<{ url: string; mode: "configured" | "embedded"; cleanup: () => Promise<void> }> {
  const configured = process.env.DATABASE_URL ?? "postgres://finnor:finnor@127.0.0.1:5432/finnor";
  assertNotProductionDatabaseTarget(configured, "Scope-1 certification database server");
  if (await canConnect(configured)) return { url: configured, mode: "configured", cleanup: async () => undefined };
  const directory = await mkdtemp(join(tmpdir(), "finnor-scope1-cert-pg-"));
  const port = await freePort();
  const embedded = new EmbeddedPostgres({ databaseDir: directory, user: "finnor", password: "finnor", port, persistent: false });
  try {
    await embedded.initialise();
    await embedded.start();
    await embedded.createDatabase("finnor");
  } catch (error) {
    await embedded.stop().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const url = `postgres://finnor:finnor@127.0.0.1:${port}/finnor`;
  assert(await canConnect(url), "embedded PostgreSQL did not become reachable");
  return {
    url,
    mode: "embedded",
    cleanup: async () => {
      await embedded.stop().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function databaseUrlFor(sourceUrl: string, database: string): string {
  const url = new URL(sourceUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function embeddedCompatibleMigrations(): Promise<Array<{ name: string; sql: string }>> {
  const directory = resolve(ROOT, "packages/db/migrations");
  return Promise.all((await readdir(directory)).filter((name) => name.endsWith(".sql")).sort().map(async (name) => {
    let sql = await readFile(resolve(directory, name), "utf8");
    if (name === "0132_platform_objects_and_legacy_compatibility.sql") {
      // Supabase owns these four platform extensions. The disposable embedded
      // server certifies application DDL, so omit only provider-managed CREATE
      // EXTENSION statements while retaining every application object in 0132.
      sql = sql.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pg_cron|pg_graphql|pg_net|pgmq).*;$/gm, "-- Supabase-managed extension omitted by embedded certification harness");
    }
    return { name, sql };
  }));
}

async function createCertificationDatabase(sourceUrl: string, embedded: boolean): Promise<{ url: string; cleanup: () => Promise<void> }> {
  const database = `finnor_scope1_cert_${randomUUID().replaceAll("-", "_")}`;
  assert(/^finnor_scope1_cert_[a-f0-9_]+$/.test(database), "generated certification database name is unsafe");
  const source = new pg.Client({ connectionString: sourceUrl });
  await source.connect();
  try { await source.query(`CREATE DATABASE ${database}`); } finally { await source.end(); }
  const url = databaseUrlFor(sourceUrl, database);
  assertNotProductionDatabaseTarget(url, "Scope-1 disposable certification database");
  try {
    const applied = await migrate(url, embedded ? await embeddedCompatibleMigrations() : undefined);
    assert(applied.includes(SCOPE1_MIGRATION), `fresh migration did not apply ${SCOPE1_MIGRATION}`);
    await seed(url);
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    try { await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'"); } finally { await admin.end(); }
  } catch (error) {
    const cleanup = new pg.Client({ connectionString: sourceUrl });
    await cleanup.connect();
    try { await cleanup.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); } finally { await cleanup.end(); }
    throw error;
  }
  return {
    url,
    cleanup: async () => {
      const cleanup = new pg.Client({ connectionString: sourceUrl });
      await cleanup.connect();
      try { await cleanup.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); } finally { await cleanup.end(); }
    },
  };
}

async function inspectArchitecture(): Promise<Record<string, unknown>> {
  const paths = {
    package: "package.json",
    protocol: "packages/orchestration/src/orchestration-protocol.ts",
    frontier: "packages/orchestration/src/plan-progress.ts",
    kernel: "packages/orchestration/src/orchestration-kernel.ts",
    objectiveLoop: "packages/orchestration/src/objective-loop.ts",
    durableExecution: "packages/orchestration/src/durable-execution.ts",
    workforce: "packages/orchestration/src/workforce-runtime.ts",
    waits: "packages/orchestration/src/event-waits.ts",
    replay: "packages/read-models/src/causal-replay.ts",
    db: "packages/db/index.ts",
    schema: "packages/db/schema.ts",
    migration: `packages/db/migrations/${SCOPE1_MIGRATION}`,
    migrationBundle: "packages/db/migrations-bundle.ts",
  } as const;
  const source = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => [
    key,
    await readFile(resolve(ROOT, path), "utf8"),
  ]))) as Record<keyof typeof paths, string>;
  const packageJson = JSON.parse(source.package) as { scripts?: Record<string, string> };

  assert(SCOPE1_MANDATORY_CASE_COUNT === 35, `Scope-1 registry contains ${SCOPE1_MANDATORY_CASE_COUNT}/35 cases`);
  assert(new Set(SCOPE1_MANDATORY_CASES.map((item) => item.id)).size === 35, "Scope-1 mandatory case IDs are not unique");
  assert(SCOPE1_MANDATORY_CASES.every((item, index) => item.ordinal === index + 1), "Scope-1 mandatory ordinals are incomplete or unstable");
  assert(SCOPE1_MANDATORY_CASES.every((item) => item.gates.length > 0), "Scope-1 registry contains an unmapped case");
  assert(SCOPE1_GATE_IDS.every((gate) => SCOPE1_MANDATORY_CASES.some((item) => item.gates.includes(gate))), "Scope-1 registry contains an unused gate");
  assert(!SCOPE1_MANDATORY_CASES.some((item) => /\b(?:TODO|SKIP(?:PED)?|PLACEHOLDER|NOT.CONFIGURED)\b/i.test(`${item.id} ${item.statement}`)), "Scope-1 registry contains a disguised non-gate");
  assert(packageJson.scripts?.["release:scope1"] === "tsx scripts/release/run-scope1-orchestration-certification.ts", "release:scope1 command is missing or ambiguous");
  assert(CURRENT_MIGRATION_HEAD.localeCompare(SCOPE1_MIGRATION) >= 0, `migration head ${CURRENT_MIGRATION_HEAD} predates ${SCOPE1_MIGRATION}`);
  assert(source.migrationBundle.includes(SCOPE1_MIGRATION), "serverless migration bundle omits Scope-1 migration");

  assert(source.frontier.includes("resolvePlanFrontier") && source.frontier.includes("maxReady"), "bounded multi-node ready frontier is missing");
  assert(source.kernel.includes("reserveReadyPlanFrontier") && source.kernel.includes("FOR UPDATE"), "atomic durable frontier reservation is missing");
  assert(source.frontier.includes("historicalIrreversibleEffects") && source.kernel.includes("irreversibleEffectReplayFence"), "cross-revision irreversible-effect replay fence is missing");
  assert(source.durableExecution.includes("orchestrationGenerationViolationTx") && source.durableExecution.includes("FOR UPDATE"), "provider effect boundary lacks an atomic Work/Plan/Objective generation fence");
  assert(source.protocol.includes("VerificationResult") && source.protocol.includes("RecoveryDecision") && source.protocol.includes("decideRecovery"), "explicit verification/recovery semantics are missing");
  const recoveryClassifier = source.protocol.slice(source.protocol.indexOf("function recoveryKind"), source.protocol.indexOf("export function decideRecovery"));
  const ambiguity = recoveryClassifier.indexOf("input.unknownExternalOutcome");
  const cancellation = recoveryClassifier.indexOf("input.cancelled");
  assert(ambiguity >= 0 && cancellation >= 0 && ambiguity < cancellation, "ambiguity must take precedence over cancellation in recovery semantics");
  assert(source.objectiveLoop.includes("reserveReadyPlanFrontier({") && source.objectiveLoop.includes("requestWorkforceAssignment({"), "ObjectiveLoop does not consume the canonical ready frontier and workforce adapter");
  assert(source.workforce.includes("assert_scope1") === false, "application runtime must not masquerade as the database constraint owner");
  assert(source.workforce.includes("exact durable logical attempt") && source.workforce.includes("assignment.nodeAttempt"), "workforce does not fence physical claims to logical attempts");
  assert(source.waits.includes("objectiveRevision") && source.waits.includes("planRevisionId") && source.waits.includes("planNodeId"), "durable waits lack generation pins");
  assert(source.replay.includes('mode: "read_only"') && source.replay.includes("sideEffectsPossible: false"), "causal replay does not declare its read-only guarantee");
  assert(!/executeProvider|executeDomainAction|reconcileExternal/i.test(source.replay), "causal replay contains a provider/effect mutation path");
  assert(source.db.includes("revisionTransition") && source.db.includes("supersededPendingNodes"), "PlanRevision transition history is missing");
  assert(source.schema.includes("workRecoveryDecisions") && source.schema.includes("attemptNumber") && source.schema.includes("maxParallelNodes"), "database schema omits Scope-1 durable protocol fields");

  const createdTables = [...source.migration.matchAll(/CREATE\s+TABLE\s+finnor_os\.([a-z0-9_]+)/gi)].map((match) => match[1]!);
  assert(JSON.stringify(createdTables) === JSON.stringify(["work_recovery_decisions"]), `Scope-1 migration created unexpected tables: ${createdTables.join(",")}`);
  assert(source.migration.includes("FORCE ROW LEVEL SECURITY") && source.migration.includes("REVOKE UPDATE,DELETE"), "RecoveryDecision RLS/append-only permissions are incomplete");
  assert(source.migration.includes("assert_scope1_workforce_attempt") && source.migration.includes("assert_scope1_wait_generation"), "database generation fencing is incomplete");
  assert(!/INSERT\s+INTO\s+finnor_os\.(?:work_objective_steps|work_recovery_decisions)/i.test(source.migration), "Scope-1 migration manufactures attempt or recovery history");

  return {
    mandatoryCases: SCOPE1_MANDATORY_CASE_COUNT,
    gates: SCOPE1_GATE_IDS.length,
    migrationHead: CURRENT_MIGRATION_HEAD,
    newTables: createdTables,
    schedulerOwner: "ObjectiveLoop+PlanRevision+ObjectiveStep",
    executionAdapter: "P7 WorkforceAssignment",
    recoveryOwner: "append-only WorkRecoveryDecision",
  };
}

async function inspectMigrationDatabase(url: string): Promise<Record<string, unknown>> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const head = await client.query<{ name: string }>("SELECT name FROM finnor_os._migrations ORDER BY name DESC LIMIT 1");
    const table = await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='finnor_os.work_recovery_decisions'::regclass");
    const columns = await client.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema='finnor_os' AND table_name IN ('work_plan_revisions','work_objective_loops','work_objective_steps','workforce_assignments','work_event_waits','work_recovery_decisions')");
    const indexes = await client.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname='finnor_os' AND indexname IN ('work_objective_steps_plan_node_attempt_idx','work_objective_steps_claimable_idx','workforce_assignments_node_attempt_idx','work_event_waits_plan_node_idx','work_recovery_decisions_attempt_idx')");
    const triggers = await client.query<{ tgname: string }>("SELECT tgname FROM pg_trigger WHERE tgrelid IN ('finnor_os.workforce_assignments'::regclass,'finnor_os.work_event_waits'::regclass,'finnor_os.work_recovery_decisions'::regclass) AND NOT tgisinternal");
    const privileges = await client.query<{ can_insert: boolean; can_update: boolean; can_delete: boolean }>("SELECT has_table_privilege('finnor_app','finnor_os.work_recovery_decisions','INSERT') can_insert,has_table_privilege('finnor_app','finnor_os.work_recovery_decisions','UPDATE') can_update,has_table_privilege('finnor_app','finnor_os.work_recovery_decisions','DELETE') can_delete");
    assert(head.rows[0]?.name === CURRENT_MIGRATION_HEAD, `fresh database head is ${head.rows[0]?.name ?? "missing"}, expected ${CURRENT_MIGRATION_HEAD}`);
    assert(table.rows[0]?.relrowsecurity && table.rows[0]?.relforcerowsecurity, "WorkRecoveryDecision does not FORCE RLS");
    const requiredColumns = ["compiler_version", "revision_transition", "max_parallel_nodes", "node_attempt_count", "objective_revision", "attempt_number", "execution_state", "verification_result", "node_attempt", "plan_revision_id", "decision_key"];
    const presentColumns = new Set(columns.rows.map((row) => row.column_name));
    for (const column of requiredColumns) assert(presentColumns.has(column), `fresh database omits Scope-1 column ${column}`);
    assert(indexes.rows.length === 5, `fresh database has ${indexes.rows.length}/5 Scope-1 indexes`);
    const triggerNames = new Set(triggers.rows.map((row) => row.tgname));
    for (const trigger of ["workforce_assignments_scope1_attempt", "work_event_waits_scope1_generation", "work_recovery_decisions_scope"]) {
      assert(triggerNames.has(trigger), `fresh database omits ${trigger}`);
    }
    assert(privileges.rows[0]?.can_insert && !privileges.rows[0]?.can_update && !privileges.rows[0]?.can_delete, "finnor_app RecoveryDecision privileges are not append-only");
    return {
      head: head.rows[0].name,
      forcedRls: true,
      requiredColumns: requiredColumns.length,
      requiredIndexes: indexes.rows.length,
      generationTriggers: 3,
      appPrivileges: "SELECT+INSERT; UPDATE+DELETE revoked",
    };
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const started = Date.now();
  const source = await sourceDatabase();
  let certificationDatabase: Awaited<ReturnType<typeof createCertificationDatabase>> | undefined;
  let finalResult: Record<string, unknown> | undefined;
  try {
    certificationDatabase = await createCertificationDatabase(source.url, source.mode === "embedded");
    databaseUrl = certificationDatabase.url;
    const gates = new Map<Scope1GateId, GateEvidence>();

    console.log("SCOPE1_GATE_START architecture");
    const architectureStarted = Date.now();
    const architecture = await inspectArchitecture();
    gates.set("architecture", { id: "architecture", status: "PASS", durationMs: Date.now() - architectureStarted, evidence: [], facts: architecture });
    console.log(`SCOPE1_GATE_PASS architecture ${Date.now() - architectureStarted}ms`);

    gates.set("deterministic-kernel", await runGate("deterministic-kernel", [
      command("typecheck", BIN("tsc"), ["-p", "tsconfig.json", "--noEmit", "--pretty", "false"], 300_000),
      vitest("scope1-kernel-unit", ["tests/unit/scope1-orchestration-kernel.test.ts"]),
    ]));

    gates.set("persistence-races", await runGate("persistence-races", [
      vitest("scope1-persistence-races", ["tests/integration/scope1-orchestration-concurrency.test.ts"], 900_000),
    ]));

    console.log("SCOPE1_GATE_START migration-security");
    const migrationStarted = Date.now();
    const migrationFacts = await inspectMigrationDatabase(databaseUrl);
    gates.set("migration-security", { id: "migration-security", status: "PASS", durationMs: Date.now() - migrationStarted, evidence: [], facts: migrationFacts });
    console.log(`SCOPE1_GATE_PASS migration-security ${Date.now() - migrationStarted}ms`);

    gates.set("core-regressions", await runGate("core-regressions", [
      vitest("scope1-core-unit-regressions", [
        "tests/unit/phase6-planning-compiler.test.ts",
        "tests/unit/phase6-plan-progress.test.ts",
        "tests/unit/phase7-workforce.test.ts",
        "tests/unit/event-wait-matching.test.ts",
        "tests/unit/objective-success-contract.test.ts",
        "tests/unit/production-correctness-objective-delivery.test.ts",
        "tests/unit/production-correctness-cancellation.test.ts",
        "tests/unit/production-correctness-external-observation.test.ts",
        "tests/unit/production-correctness-receipt-atomicity.test.ts",
        "tests/unit/universal-actions-contract.test.ts",
        "tests/unit/outcome-pack-contracts.test.ts",
        "tests/unit/pe5-runtime-boundary.test.ts",
      ], 900_000),
      vitest("scope1-core-db-regressions", [
        "tests/integration/phase6-plan-concurrency.test.ts",
        "tests/integration/phase6-plan-graph-runtime.test.ts",
        "tests/integration/phase7-workforce-concurrency.test.ts",
      ], 1_200_000),
    ]));

    gates.set("phase15a", await runGate("phase15a", [
      vitest("scope1-production-target-guard", ["tests/unit/production-target-guard.test.ts"]),
      command("phase15a-release-safety", "npm", ["run", "test:release"], 600_000, REPOSITORY_ROOT),
    ]));

    gates.set("performance", await runGate("performance", [
      vitest("scope1-performance-and-scale", ["tests/unit/scope1-orchestration-kernel.test.ts"]),
    ], {
      readyNodes: 100,
      repeatedFrontierEvaluations: 100,
      claimContenders: 100,
      deepChainNodes: 100,
      wideFanOutNodes: 98,
      fanInPrerequisites: 98,
      concurrentWaits: 100,
      duplicateWakeAndJobDeliveries: 100,
      concurrentBudgetContenders: 100,
    }));

    assert(gates.size === SCOPE1_GATE_IDS.length, `Scope-1 executed ${gates.size}/${SCOPE1_GATE_IDS.length} gates`);
    assert(SCOPE1_GATE_IDS.every((id) => gates.get(id)?.status === "PASS"), "Scope-1 has a non-passing gate");
    const cases = SCOPE1_MANDATORY_CASES.map((item) => ({
      ...item,
      status: item.gates.every((gate) => gates.get(gate)?.status === "PASS") ? "PASS" as const : "FAIL" as const,
    }));
    const passed = cases.filter((item) => item.status === "PASS").length;
    assert(passed === SCOPE1_MANDATORY_CASE_COUNT, `Scope-1 passed ${passed}/${SCOPE1_MANDATORY_CASE_COUNT} mandatory cases`);
    const executableTests = [...gates.values()].flatMap((gate) => gate.evidence).reduce((sum, item) => sum + (item.tests?.total ?? 0), 0);
    finalResult = {
      status: "PASS",
      mandatoryCases: SCOPE1_MANDATORY_CASE_COUNT,
      passedCases: passed,
      failedCases: 0,
      skippedCases: 0,
      todoCases: 0,
      executableTests,
      gates: SCOPE1_GATE_IDS.map((id) => ({ id, status: gates.get(id)!.status, durationMs: gates.get(id)!.durationMs })),
      migrationHead: CURRENT_MIGRATION_HEAD,
      databaseMode: source.mode,
      externalProviderCertification: "not-required-for-deterministic-scope1",
      durationMs: Date.now() - started,
    };
  } finally {
    if (certificationDatabase) await certificationDatabase.cleanup().catch(() => undefined);
    await source.cleanup().catch(() => undefined);
  }
  assert(finalResult, "Scope-1 certification finished without a result");
  console.log(`SCOPE1_CERTIFICATION_PASS ${JSON.stringify(finalResult)}`);
}

main().catch((error) => {
  console.error(`SCOPE1_CERTIFICATION_FAIL ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
