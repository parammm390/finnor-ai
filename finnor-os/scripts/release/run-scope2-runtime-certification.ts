import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { seed, SEED_TENANT_ID } from "../../packages/db/seed";
import { CURRENT_MIGRATION_HEAD } from "../../packages/db/migration-head";
import { assertNotProductionDatabaseTarget } from "../../packages/db/production-target-guard";
import {
  SCOPE2_GATE_IDS,
  SCOPE2_MANDATORY_CASES,
  SCOPE2_MANDATORY_CASE_COUNT,
  type Scope2GateId,
} from "./scope2-runtime-mandatory-cases";
import { SCOPE2_CRASH_BOUNDARIES } from "../../tests/integration/fixtures/scope2-crash-boundaries";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "../..");
const REPOSITORY_ROOT = resolve(ROOT, "..");
const BIN = (name: string) => resolve(ROOT, "node_modules/.bin", name);
const SCOPE2_MIGRATION = "0137_scope2_durable_runtime.sql";
const SESSION_COUNT = 100;
let databaseUrl = "";

interface CommandEvidence {
  command: string;
  durationMs: number;
  outputHash: string;
  outputLines: number;
  tests?: { files: number; total: number; passed: number; failed: number; skipped: number; todo: number };
}

interface GateEvidence {
  id: Scope2GateId;
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
  executable: string,
  args: readonly string[],
  options: {
    cwd?: string;
    timeoutMs?: number;
    vitest?: boolean;
    expectedMarker?: RegExp;
    env?: Partial<NodeJS.ProcessEnv>;
  } = {},
): Promise<CommandEvidence> {
  console.log(`SCOPE2_COMMAND_START ${label}`);
  const started = Date.now();
  const chunks: Buffer[] = [];
  let timedOut = false;
  const exitCode = await new Promise<number>((resolvePromise, reject) => {
    const child = spawn(executable, [...args], {
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
    throw new Error(`${label} failed${timedOut ? " (timeout)" : ""}: ${executable} ${args.join(" ")}\n${clean(output).slice(-60_000)}`);
  }
  assert(!/CERTIFICATION(?:_|\s)+FAIL/i.test(clean(output)), `${label} printed a certification failure with exit code zero`);
  if (options.expectedMarker) assert(options.expectedMarker.test(clean(output)), `${label} omitted required success marker ${options.expectedMarker}`);
  const evidence: CommandEvidence = {
    command: [executable, ...args].join(" "),
    durationMs: Date.now() - started,
    outputHash: digest(output),
    outputLines: output.trim() ? output.trim().split(/\r?\n/).length : 0,
    ...(options.vitest ? { tests: parseVitest(output, label) } : {}),
  };
  console.log(`SCOPE2_COMMAND_PASS ${label} ${evidence.durationMs}ms${evidence.tests ? ` ${evidence.tests.passed}/${evidence.tests.total} tests` : ""}`);
  return evidence;
}

async function runGate(
  id: Scope2GateId,
  commands: Array<() => Promise<CommandEvidence>>,
  facts?: Record<string, unknown>,
): Promise<GateEvidence> {
  console.log(`SCOPE2_GATE_START ${id}`);
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
  console.log(`SCOPE2_GATE_PASS ${id} ${result.durationMs}ms`);
  return result;
}

function vitest(label: string, files: readonly string[], timeoutMs = 900_000): () => Promise<CommandEvidence> {
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
  timeoutMs = 900_000,
  cwd = ROOT,
  expectedMarker?: RegExp,
): () => Promise<CommandEvidence> {
  return () => runCommand(label, executable, args, { timeoutMs, cwd, expectedMarker });
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
  assertNotProductionDatabaseTarget(configured, "Scope-2 certification database server");
  // The real-session gate opens one admin connection plus SESSION_COUNT
  // independent backend sessions.  CI's disposable postgres service keeps the
  // image default max_connections=100, which cannot host that certified 101+
  // session proof.  The release workflow opts into this same-engine embedded
  // path with max_connections=240 instead of silently weakening the proof or
  // relying on a runner-specific service configuration.
  const forceEmbedded = process.env.FINNOR_SCOPE2_FORCE_EMBEDDED === "1";
  if (!forceEmbedded && await canConnect(configured)) return { url: configured, mode: "configured", cleanup: async () => undefined };
  const directory = await mkdtemp(join(tmpdir(), "finnor-scope2-cert-pg-"));
  const port = await freePort();
  const embedded = new EmbeddedPostgres({
    databaseDir: directory,
    user: "finnor",
    password: "finnor",
    port,
    persistent: false,
    postgresFlags: ["-c", "max_connections=240"],
    onLog: () => undefined,
  });
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
      sql = sql.replace(/^CREATE EXTENSION IF NOT EXISTS (?:pg_cron|pg_graphql|pg_net|pgmq).*;$/gm, "-- Supabase-managed extension omitted by embedded certification harness");
    }
    return { name, sql };
  }));
}

async function createDatabase(sourceUrl: string, prefix: string): Promise<{ url: string; cleanup: () => Promise<void> }> {
  const database = `${prefix}_${randomUUID().replaceAll("-", "_")}`;
  assert(new RegExp(`^${prefix}_[a-f0-9_]+$`).test(database), "generated certification database name is unsafe");
  const source = new pg.Client({ connectionString: sourceUrl });
  await source.connect();
  try {
    await source.query(`CREATE DATABASE ${database}`);
  } finally {
    await source.end();
  }
  const url = databaseUrlFor(sourceUrl, database);
  assertNotProductionDatabaseTarget(url, "Scope-2 disposable certification database");
  return {
    url,
    cleanup: async () => {
      const cleanup = new pg.Client({ connectionString: sourceUrl });
      await cleanup.connect();
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

async function createCertificationDatabase(sourceUrl: string, embedded: boolean): Promise<{ url: string; cleanup: () => Promise<void> }> {
  const database = await createDatabase(sourceUrl, "finnor_scope2_cert");
  try {
    const applied = await migrate(database.url, embedded ? await embeddedCompatibleMigrations() : undefined);
    assert(applied.includes(SCOPE2_MIGRATION), `fresh migration did not apply ${SCOPE2_MIGRATION}`);
    await seed(database.url);
    const admin = new pg.Client({ connectionString: database.url });
    await admin.connect();
    try {
      await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'");
    } finally {
      await admin.end();
    }
    return database;
  } catch (error) {
    await database.cleanup().catch(() => undefined);
    throw error;
  }
}

async function sourceFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory)) {
    const path = resolve(directory, entry);
    const info = await stat(path);
    if (info.isDirectory()) {
      if (!["node_modules", ".next", "dist", "coverage"].includes(entry)) result.push(...await sourceFiles(path));
    } else if (/\.(?:ts|tsx|js|mjs)$/.test(entry) && !/\.(?:test|spec)\./.test(entry)) {
      result.push(path);
    }
  }
  return result;
}

async function inspectArchitecture(): Promise<Record<string, unknown>> {
  const paths = {
    package: "package.json",
    queue: "apps/worker/src/queue.ts",
    worker: "apps/worker/src/index.ts",
    contracts: "apps/worker/src/job-contracts.ts",
    commands: "packages/workflow-runtime/src/commands.ts",
    steps: "packages/workflow-runtime/src/steps.ts",
    reconciliation: "packages/workflow-runtime/src/reconciliation.ts",
    compensation: "packages/workflow-runtime/src/compensation.ts",
    controls: "packages/workflow-runtime/src/operator-controls.ts",
    inspection: "packages/workflow-runtime/src/inspection.ts",
    chaos: "packages/workflow-runtime/src/chaos.ts",
    outbox: "packages/workflow-runtime/src/outbox.ts",
    toolLedger: "packages/tools/src/idempotent-call.ts",
    toolRegistry: "packages/tools/src/registry.ts",
    graphClient: "packages/provider-microsoft365/src/client.ts",
    graphSubscriptions: "packages/provider-microsoft365/src/subscriptions.ts",
    subscriptionMaintenance: "apps/worker/src/handlers/maintain-integration-subscriptions.ts",
    artifactOperation: "packages/artifacts/src/provider-operation.ts",
    artifactCreation: "packages/artifacts/src/creation.ts",
    artifactPublication: "packages/artifacts/src/publication.ts",
    artifactRecalculation: "packages/artifacts/src/recalculation.ts",
    computerProvider: "packages/computer/src/steel-provider.ts",
    schema: "packages/db/schema.ts",
    migration: `packages/db/migrations/${SCOPE2_MIGRATION}`,
    migrationBundle: "packages/db/migrations-bundle.ts",
    scope1Protocol: "packages/orchestration/src/orchestration-protocol.ts",
    scope1Kernel: "packages/orchestration/src/orchestration-kernel.ts",
    durableExecution: "packages/orchestration/src/durable-execution.ts",
    crashChild: "tests/integration/fixtures/scope2-crash-child.ts",
    crashRegistry: "tests/integration/fixtures/scope2-crash-boundaries.ts",
    crashTest: "tests/integration/scope2-crash-matrix.test.ts",
    auditRecord: "docs/runbooks/scope2-durable-runtime-audit.md",
    conformanceContract: "docs/runbooks/scope2-runtime-conformance-contract.md",
  } as const;
  const source = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => [
    key,
    await readFile(resolve(ROOT, path), "utf8"),
  ]))) as Record<keyof typeof paths, string>;
  const packageJson = JSON.parse(source.package) as { scripts?: Record<string, string> };

  assert(SCOPE2_MANDATORY_CASE_COUNT === 75, `Scope-2 registry contains ${SCOPE2_MANDATORY_CASE_COUNT}/75 cases`);
  assert(new Set(SCOPE2_MANDATORY_CASES.map((item) => item.id)).size === 75, "Scope-2 mandatory case IDs are not unique");
  assert(SCOPE2_MANDATORY_CASES.every((item, index) => item.ordinal === index + 1), "Scope-2 mandatory ordinals are incomplete or unstable");
  assert(SCOPE2_MANDATORY_CASES.every((item) => item.gates.length > 0), "Scope-2 registry contains an unmapped case");
  assert(SCOPE2_GATE_IDS.every((gate) => SCOPE2_MANDATORY_CASES.some((item) => item.gates.includes(gate))), "Scope-2 registry contains an unused gate");
  assert(!SCOPE2_MANDATORY_CASES.some((item) => /\b(?:TODO|SKIP(?:PED)?|PLACEHOLDER|NOT.CONFIGURED)\b/i.test(`${item.id} ${item.statement}`)), "Scope-2 registry contains a disguised non-gate");
  assert(packageJson.scripts?.["release:scope2"] === "tsx scripts/release/run-scope2-runtime-certification.ts", "release:scope2 command is missing or ambiguous");
  assert(SCOPE2_CRASH_BOUNDARIES.length === 32, `Scope-2 crash registry contains ${SCOPE2_CRASH_BOUNDARIES.length}/32 boundaries`);
  assert(SCOPE2_CRASH_BOUNDARIES.filter((item) => item.disposition === "ACTIVE_SIGKILL").length === 29, "Scope-2 active SIGKILL boundary count drifted");
  assert(SCOPE2_CRASH_BOUNDARIES.filter((item) => item.disposition === "RETIRED_NOT_REACHABLE").length === 2, "retired outbox crash boundaries are not explicit");
  assert(SCOPE2_CRASH_BOUNDARIES.filter((item) => item.disposition === "UNSUPPORTED_FAIL_CLOSED").length === 1, "unsupported compensation boundary is not explicit");
  assert(source.crashChild.includes('process.kill(process.pid, "SIGKILL")') && source.crashTest.includes('result.signal !== "SIGKILL"'), "crash corpus does not prove real process death");
  assert(source.inspection.includes("jobDeliveryAttempts") && source.inspection.includes("physicalProviderInvocations") && source.inspection.includes("runtimeOperatorControls"), "canonical runtime inspection is incomplete");
  assert(source.auditRecord.includes("WHAT REQUEST MAY HAVE LEFT FINNOR") && source.auditRecord.includes("NO UNTRACKED POSSIBLE EFFECT"), "Scope-2 audit record uses an untruthful provider/effect claim");
  assert(source.conformanceContract.includes("Temporal and Hatchet have not been") && source.conformanceContract.includes("DEFERRED"), "runtime conformance contract invents an external-engine result");
  assert(CURRENT_MIGRATION_HEAD.localeCompare(SCOPE2_MIGRATION) >= 0, `migration head ${CURRENT_MIGRATION_HEAD} precedes required Scope-2 migration ${SCOPE2_MIGRATION}`);
  assert(source.migrationBundle.includes(SCOPE2_MIGRATION), "serverless migration bundle omits Scope-2 migration");

  assert(source.schema.includes("workObjectiveSteps") && source.scope1Kernel.includes("reserveReadyPlanFrontier"), "Scope-1 semantic ExecutionAttempt owner is missing");
  assert(source.schema.includes("jobDeliveryAttempts") && source.schema.includes("workflowStepClaims"), "runtime delivery/claim history owners are missing");
  assert(source.schema.includes("providerOperationAttempts") && source.schema.includes("providerInvocations"), "provider attempt/invocation layers are missing");
  assert(source.migration.includes("never a Scope-1 semantic ExecutionAttempt"), "layered attempt ownership is not explicit in durable schema evidence");
  assert(source.migration.includes("Every physical consequential request boundary"), "physical invocation audit contract is absent");

  assert(source.queue.includes("jsonb_to_recordset") && source.queue.includes("protocol_version"), "job compatibility is not filtered before claim");
  assert(source.queue.includes("job_delivery_attempts") && source.queue.includes("claim_fence"), "job delivery history/fence is missing");
  assert(source.steps.includes("causalReadyAt") && source.steps.includes("executionEligibleAt") && source.steps.includes('executionState: "claimed"'), "causal-ready/eligible/claimed stages are not distinct");
  assert(source.durableExecution.includes('outcome: "attempted"') && source.durableExecution.includes("attemptedAt"), "attempted workflow-claim transition is missing");
  assert(source.steps.includes("settlementFencePredicate") && source.steps.includes("dispatchGeneration"), "step settlement is not fenced end to end");

  assert(source.toolLedger.includes("providerIdempotencyExpiresAt") && source.toolLedger.includes("Date.now()"), "provider idempotency protection window is not enforced");
  assert(source.toolLedger.includes("prepareProviderInvocation") && source.toolLedger.includes("markProviderRequestMayHaveLeft"), "physical provider invocation boundary is not durable");
  assert(source.toolRegistry.includes("callIdempotent") && source.toolRegistry.includes("stable semantic member key"), "consequential tools do not require stable semantic identity");
  assert(source.graphClient.includes("MicrosoftGraphMutationAudit") && source.graphClient.includes("markRequestMayHaveLeft"), "Graph HTTP mutations lack physical invocation audit hooks");
  assert(source.graphClient.includes("allowAuthRetry") && source.graphClient.includes('request.allowAuthRetry === true || method === "GET"'), "Graph mutation retry policy is not explicit/fail-closed");
  assert(source.artifactOperation.includes("microsoftGraphMutationAudit") && source.artifactOperation.includes("preparedInvocationCount"), "artifact Graph mutations bypass physical invocation audit");
  assert(source.artifactCreation.includes("claimOwnedExternalOperation") && source.artifactCreation.includes("readback"), "artifact creation lacks stable operation/readback recovery");
  assert(source.artifactPublication.includes("claimOwnedExternalOperation") && source.artifactPublication.includes("readback"), "artifact replacement lacks stable operation/readback recovery");
  assert(source.artifactRecalculation.includes("artifact-recalculate") && source.artifactRecalculation.includes("readRange"), "Excel recalculation lacks stable identity and exact readback");
  assert(source.subscriptionMaintenance.includes("prepareProviderInvocation") && source.subscriptionMaintenance.includes("markProviderRequestMayHaveLeft"), "Graph subscription mutations bypass invocation audit");
  assert(/maxRetries\s*:\s*0/.test(source.computerProvider), "computer provider still hides SDK retries");

  assert(source.reconciliation.includes("still_unknowable") && source.reconciliation.includes("resolutionEvidence"), "reconciliation lacks evidence-bearing outcome semantics");
  assert(source.reconciliation.includes("Scope-1 REPLAN/ESCALATE/CANCEL"), "runtime/Scope-1 recovery ownership boundary is not explicit");
  assert(source.controls.includes("authorityDecisionId") && source.controls.includes("expectedVersion") && source.controls.includes("requestHash"), "operator controls are not authorized/versioned/idempotent");
  assert(source.compensation.includes("unsupported_compensation") && source.compensation.includes("no typed compensation binding"), "unsupported compensation does not fail closed");

  assert(source.migration.includes("Scope-2 outbox retirement blocked") && source.migration.includes("unresolvedEvents"), "outbox retirement lacks persisted-obligation guard");
  assert(source.migration.includes("legacy provider-job retirement blocked"), "legacy provider-job retirement lacks persisted-obligation guard");
  assert(!source.worker.includes("relay_outbox_events"), "retired outbox relay remains registered");
  for (const retired of ["voice_confirm_request", "voice_notify_failure", "send_push_notification", "send_resend_email", "backup_db"]) {
    assert(!source.worker.includes(retired), `retired untracked provider job remains registered: ${retired}`);
  }

  const productionFiles = [
    ...await sourceFiles(resolve(ROOT, "apps")),
    ...await sourceFiles(resolve(ROOT, "packages")),
  ];
  const productionText = await Promise.all(productionFiles.map(async (path) => ({ path, text: await readFile(path, "utf8") })));
  const wouldDeliver = productionText.filter(({ text }) => /would deliver/i.test(text));
  assert(wouldDeliver.length === 0, `production sources still contain would-deliver theater: ${wouldDeliver.map((item) => item.path).join(", ")}`);
  const outboxCallers = productionText.filter(({ path, text }) => {
    if (path.endsWith("packages/workflow-runtime/src/outbox.ts")) return false;
    const executable = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    return /\benqueueOutboxEvent\s*\(/.test(executable);
  });
  assert(outboxCallers.length === 0, `retired outbox still has production producers: ${outboxCallers.map((item) => item.path).join(", ")}`);

  const retiredHandlerPaths = [
    "apps/worker/src/handlers/relay-outbox-events.ts",
    "apps/worker/src/handlers/voice-confirm-request.ts",
    "apps/worker/src/handlers/voice-notify-failure.ts",
    "apps/worker/src/handlers/send-push-notification.ts",
    "apps/worker/src/handlers/send-resend-email.ts",
    "apps/worker/src/handlers/backup-db.ts",
  ];
  for (const path of retiredHandlerPaths) {
    await stat(resolve(ROOT, path)).then(
      () => { throw new Error(`retired bypass still exists: ${path}`); },
      (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; },
    );
  }

  return {
    mandatoryCases: SCOPE2_MANDATORY_CASE_COUNT,
    gates: SCOPE2_GATE_IDS.length,
    productionSourceFilesInspected: productionFiles.length,
    wouldDeliverPaths: 0,
    outboxProductionProducers: 0,
    retiredProviderHandlersPresent: 0,
    identityLayers: [
      "scope1_semantic_execution_attempt",
      "runtime_job_delivery_or_step_claim",
      "logical_provider_operation",
      "legally_authorized_provider_attempt",
      "physical_provider_invocation",
    ],
    readinessStages: ["causal_ready", "execution_eligible", "claimed", "attempted"],
    truthfulEffectInvariant: "FINNOR never knowingly repeats an unresolved consequential logical operation without durable legal evidence or still-valid provider idempotency; possible effects are never untracked.",
    runtimeProviderLayer: "deterministic_fake_and_fault_injection",
    liveProviderConformance: "BLOCKED_EXTERNAL",
  };
}

async function inspectMigrationDatabase(url: string): Promise<Record<string, unknown>> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const head = await client.query<{ name: string }>("SELECT name FROM finnor_os._migrations ORDER BY name DESC LIMIT 1");
    assert(head.rows[0]?.name === CURRENT_MIGRATION_HEAD, `fresh database head is ${head.rows[0]?.name ?? "missing"}, expected ${CURRENT_MIGRATION_HEAD}`);

    const tables = ["workflow_step_claims", "provider_operation_attempts", "provider_invocations", "runtime_operator_controls"];
    const rls = await client.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname,relrowsecurity,relforcerowsecurity
         FROM pg_class
        WHERE oid=ANY($1::regclass[])`,
      [tables.map((table) => `finnor_os.${table}`)],
    );
    assert(rls.rows.length === tables.length, `fresh database has ${rls.rows.length}/${tables.length} Scope-2 RLS tables`);
    assert(rls.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity), "a Scope-2 tenant ledger does not FORCE RLS");

    const columns = await client.query<{ table_name: string; column_name: string }>(
      `SELECT table_name,column_name FROM information_schema.columns
        WHERE table_schema='finnor_os'
          AND table_name IN ('jobs','commands','workflow_runs','workflow_steps','external_operations','reconciliation_cases','dead_letters')`,
    );
    const present = new Set(columns.rows.map((row) => `${row.table_name}.${row.column_name}`));
    for (const column of [
      "jobs.protocol_version", "jobs.claim_token", "jobs.claim_fence", "jobs.retry_safety",
      "commands.protocol_version", "commands.command_hash", "workflow_runs.protocol_version",
      "workflow_steps.protocol_version", "workflow_steps.claim_token", "workflow_steps.claim_fence",
      "workflow_steps.causal_ready_at", "workflow_steps.execution_eligible_at", "workflow_steps.eligibility_evidence",
      "external_operations.owner_type", "external_operations.owner_key", "external_operations.execution_state",
      "external_operations.provider_idempotency_scope", "external_operations.provider_idempotency_expires_at",
      "reconciliation_cases.related_external_operation_id", "reconciliation_cases.resolution_evidence",
      "reconciliation_cases.version", "dead_letters.version",
    ]) assert(present.has(column), `fresh database omits Scope-2 column ${column}`);

    const triggers = await client.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger
        WHERE tgrelid IN (
          'finnor_os.runtime_operator_controls'::regclass,
          'finnor_os.reconciliation_cases'::regclass,
          'finnor_os.outbox_events'::regclass,
          'finnor_os.jobs'::regclass
        ) AND NOT tgisinternal`,
    );
    const triggerNames = new Set(triggers.rows.map((row) => row.tgname));
    for (const trigger of [
      "runtime_operator_controls_append_only",
      "reconciliation_cases_scope2_resolution",
      "outbox_events_retired_no_insert",
      "jobs_retired_provider_job_no_write",
    ]) assert(triggerNames.has(trigger), `fresh database omits ${trigger}`);

    const retirements = await client.query<{ substrate: string; evidence: Record<string, unknown> }>(
      "SELECT substrate,evidence FROM finnor_os.runtime_substrate_retirements ORDER BY substrate",
    );
    assert(retirements.rows.length === 2, `fresh database has ${retirements.rows.length}/2 retirement proofs`);
    const outbox = retirements.rows.find((row) => row.substrate === "outbox");
    const providerJobs = retirements.rows.find((row) => row.substrate === "untracked_provider_jobs");
    assert(outbox?.evidence.unresolvedEvents === 0 && outbox.evidence.openDeadLetters === 0 && outbox.evidence.openReconciliationCases === 0,
      "outbox retirement proof did not record a zero-obligation inspection");
    assert(providerJobs?.evidence.unresolvedJobs === 0 && providerJobs.evidence.openDeliveryAttempts === 0,
      "legacy provider-job retirement proof did not record a zero-obligation inspection");

    const privileges = await client.query<{ can_insert: boolean; can_update: boolean; can_delete: boolean }>(
      `SELECT
         has_table_privilege('finnor_app','finnor_os.runtime_operator_controls','INSERT') can_insert,
         has_table_privilege('finnor_app','finnor_os.runtime_operator_controls','UPDATE') can_update,
         has_table_privilege('finnor_app','finnor_os.runtime_operator_controls','DELETE') can_delete`,
    );
    assert(privileges.rows[0]?.can_insert && !privileges.rows[0]?.can_update && !privileges.rows[0]?.can_delete,
      "finnor_app operator-control privileges are not append-only");
    const view = await client.query<{ count: number }>(
      "SELECT count(*)::int count FROM pg_views WHERE schemaname='finnor_os' AND viewname='business_effect_operation_summary'",
    );
    assert(view.rows[0]?.count === 1, "multi-member BusinessEffect summary view is absent");

    const obsoleteInboxConstraint = await client.query<{ count: number }>(
      `SELECT count(*)::int count
         FROM pg_constraint
        WHERE conrelid='finnor_os.inbox_events'::regclass
          AND conname='inbox_events_provider_event_id_key'`,
    );
    assert(obsoleteInboxConstraint.rows[0]?.count === 0,
      "obsolete global inbox provider/event constraint still defeats tenant-scoped deduplication");
    const tenantScopedInboxIndex = await client.query<{ count: number }>(
      `SELECT count(*)::int count
         FROM pg_indexes
        WHERE schemaname='finnor_os' AND tablename='inbox_events'
          AND indexname='inbox_events_provider_event_idx'
          AND indexdef LIKE '%(tenant_id, provider, event_id)%'`,
    );
    assert(tenantScopedInboxIndex.rows[0]?.count === 1, "tenant-scoped inbox replay index is absent");

    const crossTenantEventId = `scope2-cross-tenant-event:${randomUUID()}`;
    const secondTenant = await client.query<{ id: string }>(
      "INSERT INTO finnor_os.tenants(name) VALUES('Scope-2 inbox isolation probe') RETURNING id",
    );
    await client.query(
      `INSERT INTO finnor_os.inbox_events(tenant_id,provider,event_id,payload_hash,status,envelope_version)
       VALUES($1,'scope2_inbox_probe',$3,$4,'received',1),
             ($2,'scope2_inbox_probe',$3,$4,'received',1)`,
      [SEED_TENANT_ID, secondTenant.rows[0]!.id, crossTenantEventId, digest(crossTenantEventId)],
    );
    const crossTenantRows = await client.query<{ count: number }>(
      "SELECT count(*)::int count FROM finnor_os.inbox_events WHERE provider='scope2_inbox_probe' AND event_id=$1",
      [crossTenantEventId],
    );
    assert(crossTenantRows.rows[0]?.count === 2,
      "identical provider event IDs did not remain independently deduplicated per tenant");

    return {
      head: head.rows[0].name,
      forcedRlsTables: rls.rows.length,
      requiredColumns: present.size,
      appendOnlyOperatorControl: true,
      evidenceBearingReconciliationTrigger: true,
      outboxRetirementProof: outbox?.evidence,
      legacyProviderJobRetirementProof: providerJobs?.evidence,
      businessEffectMemberSummaryView: true,
      tenantScopedInboxReplayIdentity: true,
      appPrivileges: "SELECT+INSERT; UPDATE+DELETE revoked for runtime_operator_controls",
    };
  } finally {
    await client.end();
  }
}

async function proveRetirementGuards(sourceUrl: string, embedded: boolean): Promise<Record<string, unknown>> {
  const probe = await createDatabase(sourceUrl, "finnor_scope2_retirement_probe");
  try {
    const migrations = embedded ? await embeddedCompatibleMigrations() : await embeddedCompatibleMigrations();
    const preScope2 = migrations.filter((file) => file.name.localeCompare(SCOPE2_MIGRATION) < 0);
    await migrate(probe.url, preScope2);
    await seed(probe.url);
    const client = new pg.Client({ connectionString: probe.url });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO finnor_os.outbox_events(tenant_id,event_type,payload,status)
         VALUES($1,'retirement.guard.probe','{}','pending')`,
        [SEED_TENANT_ID],
      );
    } finally {
      await client.end();
    }

    let outboxBlocked = false;
    try {
      await migrate(probe.url, migrations);
    } catch (error) {
      outboxBlocked = /outbox retirement blocked/i.test(error instanceof Error ? error.message : String(error));
    }
    assert(outboxBlocked, "migration did not abort on a persisted unresolved outbox obligation");

    const afterOutbox = new pg.Client({ connectionString: probe.url });
    await afterOutbox.connect();
    try {
      const pending = await afterOutbox.query<{ count: number }>("SELECT count(*)::int count FROM finnor_os.outbox_events WHERE status='pending'");
      assert(pending.rows[0]?.count === 1, "failed retirement guard fabricated or removed pending outbox state");
      await afterOutbox.query("DELETE FROM finnor_os.outbox_events WHERE event_type='retirement.guard.probe'");
      await afterOutbox.query(
        `INSERT INTO finnor_os.jobs(type,payload,status,idempotency_key)
         VALUES('send_resend_email','{}','queued','retirement-provider-job-probe')`,
      );
    } finally {
      await afterOutbox.end();
    }

    let providerJobBlocked = false;
    try {
      await migrate(probe.url, migrations);
    } catch (error) {
      providerJobBlocked = /legacy provider-job retirement blocked/i.test(error instanceof Error ? error.message : String(error));
    }
    assert(providerJobBlocked, "migration did not abort on a persisted unresolved legacy provider job");

    const afterProviderJob = new pg.Client({ connectionString: probe.url });
    await afterProviderJob.connect();
    try {
      const queued = await afterProviderJob.query<{ count: number }>("SELECT count(*)::int count FROM finnor_os.jobs WHERE idempotency_key='retirement-provider-job-probe' AND status='queued'");
      assert(queued.rows[0]?.count === 1, "failed provider-job retirement guard fabricated or removed queued work");
      await afterProviderJob.query("DELETE FROM finnor_os.jobs WHERE idempotency_key='retirement-provider-job-probe'");
    } finally {
      await afterProviderJob.end();
    }
    const applied = await migrate(probe.url, migrations);
    assert(applied.includes(SCOPE2_MIGRATION), "clean retirement probe did not apply Scope-2 migration");
    return {
      outboxObligationBlocked: true,
      outboxStatePreservedAfterAbort: true,
      legacyProviderJobObligationBlocked: true,
      providerJobStatePreservedAfterAbort: true,
      cleanDeploymentApplied: true,
    };
  } finally {
    await probe.cleanup().catch(() => undefined);
  }
}

interface TimedClaim<T> {
  value: T;
  durationMs: number;
}

function percentile(values: number[], fraction: number): number {
  assert(values.length > 0, "cannot calculate a percentile over an empty sample");
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * fraction) - 1))]!;
}

function latencySummary(values: number[]): Record<string, number> {
  return {
    samples: values.length,
    p50Ms: Number(percentile(values, 0.5).toFixed(3)),
    p95Ms: Number(percentile(values, 0.95).toFixed(3)),
    maxMs: Number(Math.max(...values).toFixed(3)),
  };
}

async function measured<T>(work: () => Promise<T>): Promise<TimedClaim<T>> {
  const start = process.hrtime.bigint();
  const value = await work();
  return { value, durationMs: Number(process.hrtime.bigint() - start) / 1_000_000 };
}

async function connectSessions(url: string, count: number): Promise<{ clients: pg.Client[]; backendPids: number[] }> {
  const clients = Array.from({ length: count }, (_, index) => new pg.Client({
    connectionString: url,
    application_name: `scope2-real-session-${index + 1}`,
    connectionTimeoutMillis: 10_000,
  }));
  await Promise.all(clients.map((client) => client.connect()));
  const pidRows = await Promise.all(clients.map((client) => client.query<{ pid: number }>("SELECT pg_backend_pid()::int pid")));
  const backendPids = pidRows.map((result) => result.rows[0]!.pid);
  assert(new Set(backendPids).size === count, `expected ${count} distinct PostgreSQL sessions, observed ${new Set(backendPids).size}`);
  return { clients, backendPids };
}

async function claimJobSession(
  client: pg.Client,
  input: { type: string; protocolVersion: number; workerId: string },
): Promise<TimedClaim<{ jobId: string; deliveryAttemptId: string; claimToken: string; claimFence: number } | null>> {
  return measured(async () => {
    await client.query("BEGIN");
    try {
      const candidate = await client.query<{ id: string; tenant_id: string | null }>(
        `SELECT id,tenant_id
           FROM finnor_os.jobs
          WHERE status='queued' AND run_at<=now()
            AND type=$1 AND protocol_version=$2
          ORDER BY CASE lane WHEN 'interactive' THEN 0 ELSE 1 END,priority DESC,run_at,id
          FOR UPDATE SKIP LOCKED
          LIMIT 1`,
        [input.type, input.protocolVersion],
      );
      if (candidate.rows.length === 0) {
        await client.query("COMMIT");
        return null;
      }
      const claimToken = randomUUID();
      const claimed = await client.query<{ id: string; claim_fence: string }>(
        `UPDATE finnor_os.jobs
            SET status='running',attempts=attempts+1,started_at=clock_timestamp(),
                lease_owner=$2,lease_expires_at=now()+interval '5 minutes',
                lease_heartbeat_at=clock_timestamp(),claim_token=$3,
                claim_fence=claim_fence+1,retry_safety='pure'
          WHERE id=$1 AND status='queued' AND protocol_version=$4
          RETURNING id,claim_fence`,
        [candidate.rows[0]!.id, input.workerId, claimToken, input.protocolVersion],
      );
      assert(claimed.rows.length === 1, "selected job lost its claim before the fenced update");
      const delivery = await client.query<{ id: string }>(
        `INSERT INTO finnor_os.job_delivery_attempts(
           job_id,tenant_id,claim_token,claim_fence,worker_id,protocol_version,retry_safety,outcome
         ) VALUES($1,$2,$3,$4,$5,$6,'pure','running') RETURNING id`,
        [claimed.rows[0]!.id, candidate.rows[0]!.tenant_id, claimToken, claimed.rows[0]!.claim_fence, input.workerId, input.protocolVersion],
      );
      await client.query("COMMIT");
      return {
        jobId: claimed.rows[0]!.id,
        deliveryAttemptId: delivery.rows[0]!.id,
        claimToken,
        claimFence: Number(claimed.rows[0]!.claim_fence),
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });
}

async function claimStepSession(
  client: pg.Client,
  input: { stepId: string; tenantId: string; dispatchGeneration: number; workerId: string },
): Promise<TimedClaim<{ stepId: string; claimToken: string; claimFence: number; dispatchGeneration: number } | null>> {
  return measured(async () => {
    await client.query("BEGIN");
    try {
      const claimToken = randomUUID();
      const claimed = await client.query<{ id: string; claim_fence: string; dispatch_generation: number; protocol_version: number }>(
        `UPDATE finnor_os.workflow_steps
            SET status='leased',execution_state='claimed',claimed_at=clock_timestamp(),
                execution_eligible_at=clock_timestamp(),
                eligibility_evidence='{"version":1,"source":"scope2_real_session_certification","authorityIsNotCausality":true}'::jsonb,
                claim_token=$3,claim_fence=claim_fence+1,claim_owner=$4,
                lease_expires_at=now()+interval '5 minutes',lease_heartbeat_at=clock_timestamp(),
                attempts=attempts+1,updated_at=clock_timestamp()
          WHERE id=$1 AND tenant_id=$2::uuid AND status='pending'
            AND dispatch_generation=$5 AND causal_ready_at IS NOT NULL
            AND workflow_run_id NOT IN (
              SELECT id FROM finnor_os.workflow_runs WHERE status IN ('paused','cancelled','escalated')
            )
          RETURNING id,claim_fence,dispatch_generation,protocol_version`,
        [input.stepId, input.tenantId, claimToken, input.workerId, input.dispatchGeneration],
      );
      if (claimed.rows.length === 0) {
        await client.query("COMMIT");
        return null;
      }
      await client.query(
        `INSERT INTO finnor_os.workflow_step_claims(
           tenant_id,workflow_step_id,claim_token,claim_fence,dispatch_generation,protocol_version,worker_id,outcome
         ) VALUES($1,$2,$3,$4,$5,$6,$7,'claimed')`,
        [input.tenantId, claimed.rows[0]!.id, claimToken, claimed.rows[0]!.claim_fence,
          claimed.rows[0]!.dispatch_generation, claimed.rows[0]!.protocol_version, input.workerId],
      );
      await client.query("COMMIT");
      return {
        stepId: claimed.rows[0]!.id,
        claimToken,
        claimFence: Number(claimed.rows[0]!.claim_fence),
        dispatchGeneration: claimed.rows[0]!.dispatch_generation,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  });
}

async function insertStepRun(client: pg.Client, stepCount: number, label: string): Promise<{ commandId: string; runId: string; stepIds: string[] }> {
  const commandId = randomUUID();
  const runId = randomUUID();
  await client.query(
    `INSERT INTO finnor_os.commands(id,tenant_id,command_type,payload,status,protocol_version)
     VALUES($1,$2,'scope2_real_session_certification','{}','running',2)`,
    [commandId, SEED_TENANT_ID],
  );
  await client.query(
    `INSERT INTO finnor_os.workflow_runs(id,tenant_id,command_id,workflow_type,status,protocol_version)
     VALUES($1,$2,$3,'scope2_real_session_certification','running',2)`,
    [runId, SEED_TENANT_ID, commandId],
  );
  const rows = await client.query<{ id: string }>(
    `INSERT INTO finnor_os.workflow_steps(
       tenant_id,workflow_run_id,step_type,sequence,idempotency_key,status,execution_state,
       protocol_version,causal_ready_at,payload
     )
     SELECT $1::uuid,$2::uuid,'scope2_real_session_step',value,
            $3 || ':' || value::text,'pending','authorized',2,clock_timestamp(),'{}'::jsonb
       FROM generate_series(1,$4::int) value
     RETURNING id`,
    [SEED_TENANT_ID, runId, label, stepCount],
  );
  assert(rows.rows.length === stepCount, `created ${rows.rows.length}/${stepCount} step fixtures`);
  return { commandId, runId, stepIds: rows.rows.map((row) => row.id) };
}

async function runRealSessionCertification(url: string): Promise<Record<string, unknown>> {
  const admin = new pg.Client({ connectionString: url, application_name: "scope2-concurrency-admin" });
  await admin.connect();
  const { clients, backendPids } = await connectSessions(url, SESSION_COUNT);
  const fixtureTag = randomUUID();
  const jobType = `scope2_real_session_${fixtureTag}`;
  const backlogType = `scope2_backlog_${fixtureTag}`;
  const futureType = `scope2_future_${fixtureTag}`;
  const stepRuns: Array<{ commandId: string; runId: string }> = [];
  try {
    const oneJob = await admin.query<{ id: string }>(
      `INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,protocol_version,retry_safety)
       VALUES($1,$2,'{}',$3,2,'pure') RETURNING id`,
      [SEED_TENANT_ID, jobType, `scope2-one-job:${fixtureTag}`],
    );
    const sameJobStarted = process.hrtime.bigint();
    const sameJobClaims = await Promise.all(clients.map((client, index) => claimJobSession(client, {
      type: jobType,
      protocolVersion: 2,
      workerId: `scope2-job-contender-${index + 1}`,
    })));
    const sameJobDurationMs = Number(process.hrtime.bigint() - sameJobStarted) / 1_000_000;
    const sameJobWinners = sameJobClaims.flatMap((result) => result.value ? [result.value] : []);
    assert(sameJobWinners.length === 1, `100 real sessions produced ${sameJobWinners.length} winners for one job`);
    assert(sameJobWinners[0]!.jobId === oneJob.rows[0]!.id, "the single job claim returned the wrong durable identity");
    const oneJobDeliveries = await admin.query<{ count: number }>(
      "SELECT count(*)::int count FROM finnor_os.job_delivery_attempts WHERE job_id=$1",
      [oneJob.rows[0]!.id],
    );
    assert(oneJobDeliveries.rows[0]?.count === 1, "single job claim did not produce exactly one delivery-attempt row");

    await admin.query(
      `INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,protocol_version,retry_safety)
       SELECT $1::uuid,$2,'{}'::jsonb,$3 || ':' || value::text,2,'pure'
         FROM generate_series(1,$4::int) value`,
      [SEED_TENANT_ID, backlogType, `scope2-job-backlog:${fixtureTag}`, SESSION_COUNT],
    );
    const backlogStarted = process.hrtime.bigint();
    const backlogClaims = await Promise.all(clients.map((client, index) => claimJobSession(client, {
      type: backlogType,
      protocolVersion: 2,
      workerId: `scope2-backlog-worker-${index + 1}`,
    })));
    const backlogDurationMs = Number(process.hrtime.bigint() - backlogStarted) / 1_000_000;
    const backlogWinners = backlogClaims.flatMap((result) => result.value ? [result.value] : []);
    assert(backlogWinners.length === SESSION_COUNT, `100 real sessions claimed ${backlogWinners.length}/100 backlog jobs`);
    assert(new Set(backlogWinners.map((winner) => winner.jobId)).size === SESSION_COUNT, "backlog claims duplicated a physical job identity");

    const futureJob = await admin.query<{ id: string }>(
      `INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,protocol_version,retry_safety)
       VALUES($1,$2,'{}',$3,999,'pure') RETURNING id`,
      [SEED_TENANT_ID, futureType, `scope2-future:${fixtureTag}`],
    );
    const incompatible = await claimJobSession(clients[0]!, {
      type: futureType,
      protocolVersion: 2,
      workerId: "scope2-incompatible-worker",
    });
    assert(incompatible.value === null, "incompatible worker claimed future-protocol durable work");
    const futureState = await admin.query<{ status: string; attempts: number }>("SELECT status,attempts FROM finnor_os.jobs WHERE id=$1", [futureJob.rows[0]!.id]);
    assert(futureState.rows[0]?.status === "queued" && futureState.rows[0]?.attempts === 0, "preclaim version filter mutated incompatible work");

    const oneStep = await insertStepRun(admin, 1, `scope2-one-step:${fixtureTag}`);
    stepRuns.push(oneStep);
    const sameStepStarted = process.hrtime.bigint();
    const sameStepClaims = await Promise.all(clients.map((client, index) => claimStepSession(client, {
      stepId: oneStep.stepIds[0]!,
      tenantId: SEED_TENANT_ID,
      dispatchGeneration: 0,
      workerId: `scope2-step-contender-${index + 1}`,
    })));
    const sameStepDurationMs = Number(process.hrtime.bigint() - sameStepStarted) / 1_000_000;
    const sameStepWinners = sameStepClaims.flatMap((result) => result.value ? [result.value] : []);
    assert(sameStepWinners.length === 1, `100 real sessions produced ${sameStepWinners.length} winners for one workflow step`);
    const stepClaimRows = await admin.query<{ count: number }>(
      "SELECT count(*)::int count FROM finnor_os.workflow_step_claims WHERE workflow_step_id=$1",
      [oneStep.stepIds[0]!],
    );
    assert(stepClaimRows.rows[0]?.count === 1, "single step claim did not produce exactly one claim-history row");

    const oldFence = sameStepWinners[0]!;
    await admin.query("BEGIN");
    try {
      await admin.query(
        `UPDATE finnor_os.workflow_step_claims
            SET outcome='superseded',finished_at=clock_timestamp()
          WHERE workflow_step_id=$1 AND claim_token=$2 AND claim_fence=$3`,
        [oldFence.stepId, oldFence.claimToken, oldFence.claimFence],
      );
      await admin.query(
        `UPDATE finnor_os.workflow_steps
            SET status='pending',execution_state='authorized',dispatch_generation=dispatch_generation+1,
                claim_token=NULL,claim_owner=NULL,lease_expires_at=NULL,lease_heartbeat_at=NULL,
                execution_eligible_at=NULL,updated_at=clock_timestamp()
          WHERE id=$1 AND claim_token=$2 AND claim_fence=$3 AND dispatch_generation=0`,
        [oldFence.stepId, oldFence.claimToken, oldFence.claimFence],
      );
      await admin.query("COMMIT");
    } catch (error) {
      await admin.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
    const currentClaim = await claimStepSession(clients[0]!, {
      stepId: oldFence.stepId,
      tenantId: SEED_TENANT_ID,
      dispatchGeneration: 1,
      workerId: "scope2-current-fence-owner",
    });
    assert(currentClaim.value?.claimFence === oldFence.claimFence + 1, "lease transfer did not advance the durable step fence");
    const staleCommit = await clients[1]!.query(
      `UPDATE finnor_os.workflow_steps
          SET status='completed',execution_state='verified',claim_token=NULL,claim_owner=NULL,
              lease_expires_at=NULL,lease_heartbeat_at=NULL,updated_at=clock_timestamp()
        WHERE id=$1 AND tenant_id=$2::uuid AND status='leased'
          AND claim_token=$3 AND claim_fence=$4 AND dispatch_generation=$5
        RETURNING id`,
      [oldFence.stepId, SEED_TENANT_ID, oldFence.claimToken, oldFence.claimFence, oldFence.dispatchGeneration],
    );
    assert(staleCommit.rowCount === 0, "stale step owner committed after lease/fence transfer");

    const stepBacklog = await insertStepRun(admin, SESSION_COUNT, `scope2-step-backlog:${fixtureTag}`);
    stepRuns.push(stepBacklog);
    const stepBacklogStarted = process.hrtime.bigint();
    const stepBacklogClaims = await Promise.all(clients.map((client, index) => claimStepSession(client, {
      stepId: stepBacklog.stepIds[index]!,
      tenantId: SEED_TENANT_ID,
      dispatchGeneration: 0,
      workerId: `scope2-step-backlog-worker-${index + 1}`,
    })));
    const stepBacklogDurationMs = Number(process.hrtime.bigint() - stepBacklogStarted) / 1_000_000;
    const claimedSteps = stepBacklogClaims.flatMap((result) => result.value ? [result.value.stepId] : []);
    assert(claimedSteps.length === SESSION_COUNT && new Set(claimedSteps).size === SESSION_COUNT,
      `ready-step backlog produced ${claimedSteps.length} claims over ${new Set(claimedSteps).size} unique steps`);
    const readiness = await admin.query<{ ordered: boolean; claimed: number }>(
      `SELECT bool_and(causal_ready_at<=execution_eligible_at) ordered,
              count(*) FILTER (WHERE status='leased' AND execution_state='claimed')::int claimed
         FROM finnor_os.workflow_steps WHERE workflow_run_id=$1`,
      [stepBacklog.runId],
    );
    assert(readiness.rows[0]?.ordered && readiness.rows[0]?.claimed === SESSION_COUNT,
      "causal-ready -> execution-eligible -> claimed ordering was not durable for the ready-step backlog");

    const eventId = `scope2-event-storm:${fixtureTag}`;
    const eventStarted = process.hrtime.bigint();
    const eventResults = await Promise.all(clients.map((client) => client.query(
      `INSERT INTO finnor_os.inbox_events(tenant_id,provider,event_id,payload_hash,status,envelope_version)
       VALUES($1,'deterministic_fault_provider',$2,$3,'received',1)
       ON CONFLICT(tenant_id,provider,event_id) DO NOTHING`,
      [SEED_TENANT_ID, eventId, digest(eventId)],
    )));
    const eventDurationMs = Number(process.hrtime.bigint() - eventStarted) / 1_000_000;
    assert(eventResults.reduce((sum, result) => sum + (result.rowCount ?? 0), 0) === 1, "duplicate provider-event storm persisted more than one canonical event");
    const eventCount = await admin.query<{ count: number }>(
      "SELECT count(*)::int count FROM finnor_os.inbox_events WHERE tenant_id=$1 AND provider='deterministic_fault_provider' AND event_id=$2",
      [SEED_TENANT_ID, eventId],
    );
    assert(eventCount.rows[0]?.count === 1, "provider-event storm did not converge on one row");

    return {
      requestedSessions: SESSION_COUNT,
      distinctBackendSessions: new Set(backendPids).size,
      backendPidDigest: digest([...backendPids].sort((a, b) => a - b).join(",")),
      oneJobContenders: SESSION_COUNT,
      oneJobWinners: sameJobWinners.length,
      oneJobDeliveryAttempts: oneJobDeliveries.rows[0]!.count,
      oneJobWallMs: Number(sameJobDurationMs.toFixed(3)),
      oneJobLatency: latencySummary(sameJobClaims.map((result) => result.durationMs)),
      jobBacklogSize: SESSION_COUNT,
      jobBacklogUniqueClaims: new Set(backlogWinners.map((winner) => winner.jobId)).size,
      jobBacklogWallMs: Number(backlogDurationMs.toFixed(3)),
      jobBacklogLatency: latencySummary(backlogClaims.map((result) => result.durationMs)),
      incompatiblePreclaimResult: "remained_queued_attempts_0",
      oneStepContenders: SESSION_COUNT,
      oneStepWinners: sameStepWinners.length,
      oneStepClaimHistoryRows: stepClaimRows.rows[0]!.count,
      oneStepWallMs: Number(sameStepDurationMs.toFixed(3)),
      oneStepLatency: latencySummary(sameStepClaims.map((result) => result.durationMs)),
      staleFenceCommitRows: staleCommit.rowCount ?? 0,
      stepBacklogSize: SESSION_COUNT,
      stepBacklogUniqueClaims: new Set(claimedSteps).size,
      stepBacklogWallMs: Number(stepBacklogDurationMs.toFixed(3)),
      stepBacklogLatency: latencySummary(stepBacklogClaims.map((result) => result.durationMs)),
      duplicateProviderEventDeliveries: SESSION_COUNT,
      duplicateProviderEventRows: eventCount.rows[0]!.count,
      duplicateProviderEventWallMs: Number(eventDurationMs.toFixed(3)),
    };
  } finally {
    await Promise.all(clients.map((client) => client.end().catch(() => undefined)));
    await admin.query(
      `DELETE FROM finnor_os.inbox_events WHERE tenant_id=$1 AND provider='deterministic_fault_provider' AND event_id=$2`,
      [SEED_TENANT_ID, `scope2-event-storm:${fixtureTag}`],
    ).catch(() => undefined);
    for (const run of stepRuns) {
      await admin.query("DELETE FROM finnor_os.workflow_step_claims WHERE workflow_step_id IN (SELECT id FROM finnor_os.workflow_steps WHERE workflow_run_id=$1)", [run.runId]).catch(() => undefined);
      await admin.query("DELETE FROM finnor_os.decision_receipts WHERE workflow_run_id=$1", [run.runId]).catch(() => undefined);
      await admin.query("DELETE FROM finnor_os.workflow_steps WHERE workflow_run_id=$1", [run.runId]).catch(() => undefined);
      await admin.query("DELETE FROM finnor_os.workflow_runs WHERE id=$1", [run.runId]).catch(() => undefined);
      await admin.query("DELETE FROM finnor_os.commands WHERE id=$1", [run.commandId]).catch(() => undefined);
    }
    await admin.query(
      `DELETE FROM finnor_os.job_delivery_attempts WHERE job_id IN (
         SELECT id FROM finnor_os.jobs WHERE type=ANY($1::text[])
       )`,
      [[jobType, backlogType, futureType]],
    ).catch(() => undefined);
    await admin.query("DELETE FROM finnor_os.jobs WHERE type=ANY($1::text[])", [[jobType, backlogType, futureType]]).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}

async function runBacklogPerformance(url: string): Promise<Record<string, unknown>> {
  const client = new pg.Client({ connectionString: url, application_name: "scope2-backlog-performance" });
  await client.connect();
  const tag = randomUUID();
  const ownerPrefix = `scope2-perf:${tag}`;
  const observationRows = 1_000;
  const reconciliationRows = 1_000;
  try {
    await client.query(
      `INSERT INTO finnor_os.external_operations(
         tenant_id,owner_type,owner_key,operation_key,request_hash,status,provider,
         protocol_version,target_key,execution_state,retry_safety,provider_idempotency_mode,
         verification_mode,history_complete
       )
       SELECT $1::uuid,'system_job',$2 || ':observation:' || value::text,'member',repeat('a',64),
              'succeeded','deterministic_fault_provider',2,'target:' || value::text,
              'awaiting_observation','readback_required','readback','readback',true
         FROM generate_series(1,$3::int) value`,
      [SEED_TENANT_ID, ownerPrefix, observationRows],
    );
    await client.query(
      `INSERT INTO finnor_os.external_operations(
         tenant_id,owner_type,owner_key,operation_key,request_hash,status,provider,
         protocol_version,target_key,execution_state,retry_safety,provider_idempotency_mode,
         verification_mode,history_complete
       )
       SELECT $1::uuid,'system_job',$2 || ':reconciliation:' || value::text,'member',repeat('b',64),
              'unknown','deterministic_fault_provider',2,'target:' || value::text,
              'reconciliation_required','readback_required','readback','readback',true
         FROM generate_series(1,$3::int) value`,
      [SEED_TENANT_ID, ownerPrefix, reconciliationRows],
    );
    await client.query(
      `INSERT INTO finnor_os.reconciliation_cases(
         tenant_id,case_type,classification,authoritative_side,details,status
       )
       SELECT $1::uuid,'unknown_delivery',$2 || ':' || value::text,'external',
              jsonb_build_object('performanceFixture',true,'ordinal',value),'open'
         FROM generate_series(1,$3::int) value`,
      [SEED_TENANT_ID, ownerPrefix, reconciliationRows],
    );

    const observation = await measured(() => client.query(
      `SELECT id,owner_key,target_key,updated_at
         FROM finnor_os.external_operations
        WHERE tenant_id=$1 AND execution_state='awaiting_observation'
          AND owner_key LIKE $2
        ORDER BY updated_at,id LIMIT 100`,
      [SEED_TENANT_ID, `${ownerPrefix}:%`],
    ));
    const reconciliation = await measured(() => client.query(
      `SELECT id,related_external_operation_id,created_at
         FROM finnor_os.reconciliation_cases
        WHERE tenant_id=$1 AND status='open' AND classification LIKE $2
        ORDER BY created_at,id LIMIT 100`,
      [SEED_TENANT_ID, `${ownerPrefix}:%`],
    ));
    const uncertainOperations = await measured(() => client.query(
      `SELECT id,owner_key,target_key,updated_at
        FROM finnor_os.external_operations
       WHERE tenant_id=$1 AND execution_state IN ('unknown_outcome','reconciliation_required','divergent')
         AND owner_key LIKE $2
        ORDER BY execution_state,updated_at,id LIMIT 100`,
      [SEED_TENANT_ID, `${ownerPrefix}:%`],
    ));
    assert(observation.value.rows.length === 100, "observation backlog query returned an incomplete bounded page");
    assert(reconciliation.value.rows.length === 100, "reconciliation backlog query returned an incomplete bounded page");
    assert(uncertainOperations.value.rows.length === 100, "uncertain-operation backlog query returned an incomplete bounded page");

    const indexDefinition = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname='finnor_os' AND tablename='external_operations'
          AND indexname='external_operations_reconciliation_idx'`,
    );
    assert(indexDefinition.rows.length === 1
      && indexDefinition.rows[0]!.indexdef.includes("tenant_id, execution_state, updated_at, id")
      && indexDefinition.rows[0]!.indexdef.includes("unknown_outcome"),
    "reconciliation backlog partial index is absent or has drifted");
    const indexPlan = await client.query<{ "QUERY PLAN": Array<{ Plan: { "Node Type": string; "Index Name"?: string; Plans?: unknown[] } }> }>(
      `EXPLAIN (FORMAT JSON)
       SELECT id FROM finnor_os.external_operations
        WHERE tenant_id=$1 AND execution_state IN ('unknown_outcome','reconciliation_required','divergent')
        ORDER BY execution_state,updated_at,id LIMIT 100`,
      [SEED_TENANT_ID],
    );
    const planText = JSON.stringify(indexPlan.rows[0]?.["QUERY PLAN"] ?? []);
    // PostgreSQL legitimately prefers a sequential scan for this tiny disposable
    // fixture. Prove the partial index is usable independently from that cost choice,
    // while reporting the natural plan honestly instead of forcing a fake win.
    await client.query("SET enable_seqscan=off");
    const forcedIndexPlan = await client.query<{ "QUERY PLAN": Array<{ Plan: { "Node Type": string; "Index Name"?: string; Plans?: unknown[] } }> }>(
      `EXPLAIN (FORMAT JSON)
       SELECT id FROM finnor_os.external_operations
        WHERE tenant_id=$1 AND execution_state IN ('unknown_outcome','reconciliation_required','divergent')
        ORDER BY execution_state,updated_at,id LIMIT 100`,
      [SEED_TENANT_ID],
    );
    await client.query("RESET enable_seqscan");
    const forcedPlanText = JSON.stringify(forcedIndexPlan.rows[0]?.["QUERY PLAN"] ?? []);
    assert(forcedPlanText.includes("external_operations_reconciliation_idx"),
      `reconciliation backlog partial index exists but is not usable for the bounded query: ${forcedPlanText}`);

    return {
      observationBacklogRows: observationRows,
      observationPageRows: observation.value.rows.length,
      observationPageMs: Number(observation.durationMs.toFixed(3)),
      uncertainOperationBacklogRows: reconciliationRows,
      uncertainOperationPageRows: uncertainOperations.value.rows.length,
      uncertainOperationPageMs: Number(uncertainOperations.durationMs.toFixed(3)),
      reconciliationCaseBacklogRows: reconciliationRows,
      reconciliationCasePageRows: reconciliation.value.rows.length,
      reconciliationCasePageMs: Number(reconciliation.durationMs.toFixed(3)),
      reconciliationIndexAvailable: true,
      reconciliationIndexUsable: true,
      naturalPlannerUsedReconciliationIndex: planText.includes("external_operations_reconciliation_idx"),
      queryPageLimit: 100,
    };
  } finally {
    await client.query(
      "DELETE FROM finnor_os.reconciliation_cases WHERE tenant_id=$1 AND classification LIKE $2",
      [SEED_TENANT_ID, `${ownerPrefix}:%`],
    ).catch(() => undefined);
    await client.query(
      "DELETE FROM finnor_os.external_operations WHERE tenant_id=$1 AND owner_key LIKE $2",
      [SEED_TENANT_ID, `${ownerPrefix}:%`],
    ).catch(() => undefined);
    await client.end().catch(() => undefined);
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
    const gates = new Map<Scope2GateId, GateEvidence>();

    console.log("SCOPE2_GATE_START architecture");
    const architectureStarted = Date.now();
    const architecture = await inspectArchitecture();
    gates.set("architecture", {
      id: "architecture",
      status: "PASS",
      durationMs: Date.now() - architectureStarted,
      evidence: [],
      facts: architecture,
    });
    console.log(`SCOPE2_GATE_PASS architecture ${Date.now() - architectureStarted}ms`);

    console.log("SCOPE2_GATE_START migration-security");
    const migrationStarted = Date.now();
    const [migrationFacts, retirementFacts] = await Promise.all([
      inspectMigrationDatabase(databaseUrl),
      proveRetirementGuards(source.url, source.mode === "embedded"),
    ]);
    gates.set("migration-security", {
      id: "migration-security",
      status: "PASS",
      durationMs: Date.now() - migrationStarted,
      evidence: [],
      facts: { ...migrationFacts, retirementGuards: retirementFacts },
    });
    console.log(`SCOPE2_GATE_PASS migration-security ${Date.now() - migrationStarted}ms`);

    console.log("SCOPE2_GATE_START real-db-concurrency");
    const concurrencyStarted = Date.now();
    const concurrencyFacts = await runRealSessionCertification(databaseUrl);
    gates.set("real-db-concurrency", {
      id: "real-db-concurrency",
      status: "PASS",
      durationMs: Date.now() - concurrencyStarted,
      evidence: [],
      facts: concurrencyFacts,
    });
    console.log(`SCOPE2_GATE_PASS real-db-concurrency ${Date.now() - concurrencyStarted}ms`);

    gates.set("job-step-runtime", await runGate("job-step-runtime", [
      command("scope2-typecheck", BIN("tsc"), ["-p", "tsconfig.json", "--noEmit", "--pretty", "false"], 300_000),
      vitest("scope2-job-step-runtime", [
        "tests/integration/queue.test.ts",
        "tests/integration/workflow-runtime.test.ts",
        "tests/integration/step-receipts.test.ts",
        "tests/integration/single-action-runtime-bridge.test.ts",
        "tests/integration/run-controls.test.ts",
        "tests/unit/production-correctness-receipt-atomicity.test.ts",
        "tests/unit/production-correctness-cancellation.test.ts",
      ], 1_200_000),
    ]));

    gates.set("effect-protocol", await runGate("effect-protocol", [
      vitest("scope2-effect-and-provider-protocol", [
        "tests/integration/scope2-effect-protocol.test.ts",
        "tests/integration/external-operations-idempotency.test.ts",
        "tests/unit/microsoft365-provider.test.ts",
        "tests/unit/microsoft-artifact-transport.test.ts",
      ], 1_200_000),
    ], {
      deterministicFakeFaultProviderCertification: "PASS",
      liveProviderConformance: "BLOCKED_EXTERNAL",
      liveProviderTestsCountedAsPass: 0,
    }));

    gates.set("observation-reconciliation", await runGate("observation-reconciliation", [
      vitest("scope2-observation-and-reconciliation", [
        "tests/integration/scope2-operator-controls.test.ts",
        "tests/integration/external-effect-observation.test.ts",
        "tests/integration/source-truth-loop.test.ts",
        "tests/unit/production-correctness-external-observation.test.ts",
      ], 1_200_000),
    ]));

    gates.set("signals-dlq-controls", await runGate("signals-dlq-controls", [
      vitest("scope2-signals-dlq-and-controls", [
        "tests/integration/dlq-routes.test.ts",
        "tests/integration/outbox-dispatch.test.ts",
        "tests/integration/inbox-dedup.test.ts",
        "tests/integration/scope1-orchestration-concurrency.test.ts",
        "tests/unit/event-wait-matching.test.ts",
      ], 1_500_000),
    ]));

    gates.set("version-redeploy", await runGate("version-redeploy", [
      vitest("scope2-version-and-redeploy", [
        "tests/unit/envelope.test.ts",
        "tests/unit/worker-health.test.ts",
        "tests/integration/scan-watchdog.test.ts",
        "tests/integration/scope2-crash-matrix.test.ts",
      ], 900_000),
    ], {
      incompatibleJobVersionPreclaim: concurrencyFacts.incompatiblePreclaimResult,
      postgresOnlyRecoveryTruth: true,
    }));

    gates.set("scope1-phase15a", await runGate("scope1-phase15a", [
      command("scope1-full-regression", "npm", ["run", "release:scope1"], 2_400_000, ROOT, /SCOPE1_CERTIFICATION_PASS/),
    ]));

    console.log("SCOPE2_GATE_START performance");
    const performanceStarted = Date.now();
    const backlogFacts = await runBacklogPerformance(databaseUrl);
    const performanceFacts = {
      realDatabaseConcurrency: concurrencyFacts,
      backlogs: backlogFacts,
      longRunningLeaseHeartbeat: "covered_by_scope2-job-step-runtime",
      duplicateWakeStormDeliveries: 100,
      duplicateWakeLogicalContinuations: 1,
      duplicateWakeEvidence: "tests/integration/scope1-orchestration-concurrency.test.ts",
    };
    gates.set("performance", {
      id: "performance",
      status: "PASS",
      durationMs: Date.now() - performanceStarted,
      evidence: [],
      facts: performanceFacts,
    });
    console.log(`SCOPE2_GATE_PASS performance ${Date.now() - performanceStarted}ms`);

    assert(gates.size === SCOPE2_GATE_IDS.length, `Scope-2 executed ${gates.size}/${SCOPE2_GATE_IDS.length} gates`);
    assert(SCOPE2_GATE_IDS.every((id) => gates.get(id)?.status === "PASS"), "Scope-2 has a non-passing gate");
    const cases = SCOPE2_MANDATORY_CASES.map((item) => ({
      ...item,
      status: item.gates.every((gate) => gates.get(gate)?.status === "PASS") ? "PASS" as const : "FAIL" as const,
    }));
    const passed = cases.filter((item) => item.status === "PASS").length;
    assert(passed === SCOPE2_MANDATORY_CASE_COUNT, `Scope-2 passed ${passed}/${SCOPE2_MANDATORY_CASE_COUNT} mandatory cases`);
    const executableTests = [...gates.values()].flatMap((gate) => gate.evidence).reduce((sum, item) => sum + (item.tests?.total ?? 0), 0);
    finalResult = {
      status: "PASS",
      mandatoryCases: SCOPE2_MANDATORY_CASE_COUNT,
      passedCases: passed,
      failedCases: 0,
      skippedCases: 0,
      todoCases: 0,
      executableTests,
      gates: SCOPE2_GATE_IDS.map((id) => ({
        id,
        status: gates.get(id)!.status,
        durationMs: gates.get(id)!.durationMs,
      })),
      migrationHead: CURRENT_MIGRATION_HEAD,
      databaseMode: source.mode,
      realDatabaseSessions: concurrencyFacts.distinctBackendSessions,
      deterministicFakeFaultProviderCertification: "PASS",
      liveProviderConformance: "BLOCKED_EXTERNAL",
      liveProviderTestsCountedAsPass: 0,
      crashMatrix: {
        namedBoundaries: SCOPE2_CRASH_BOUNDARIES.length,
        activeRealSigkillBoundaries: SCOPE2_CRASH_BOUNDARIES.filter((item) => item.disposition === "ACTIVE_SIGKILL").length,
        retiredOutboxBoundaries: SCOPE2_CRASH_BOUNDARIES.filter((item) => item.disposition === "RETIRED_NOT_REACHABLE").length,
        unsupportedCompensationBoundaries: SCOPE2_CRASH_BOUNDARIES.filter((item) => item.disposition === "UNSUPPORTED_FAIL_CLOSED").length,
      },
      performance: performanceFacts,
      operationalInspection: "inspectRuntimeTruth",
      truthfulEffectInvariant: "FINNOR must never knowingly issue a second consequential provider invocation for an unresolved logical operation unless durable evidence proves repetition is legal or provider idempotency makes replay equivalent.",
      noUntrackedPossibleEffect: true,
      durationMs: Date.now() - started,
    };
  } finally {
    if (certificationDatabase) await certificationDatabase.cleanup().catch(() => undefined);
    await source.cleanup().catch(() => undefined);
  }
  assert(finalResult, "Scope-2 certification finished without a result");
  console.log(`SCOPE2_CERTIFICATION_PASS ${JSON.stringify(finalResult)}`);
}

main().catch((error) => {
  console.error(`SCOPE2_CERTIFICATION_FAIL ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
