import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { seed } from "../../packages/db/seed";
import { CURRENT_MIGRATION_HEAD } from "../../packages/db/migration-head";
import {
  P6_GATE_IDS,
  P6_MANDATORY_CASE_COUNT,
  P6_MANDATORY_CASES,
  type P6GateId,
} from "./pe-p6-planning-attention-mandatory-cases";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "../..");
const BIN = (name: string) => resolve(ROOT, "node_modules/.bin", name);
const EXPECTED_MANDATORY_CASES = 128;
const P6_MIGRATION = "0128_phase6_planning_causal_attention.sql";
const SOURCE_DATABASE_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@127.0.0.1:5432/finnor";
let DATABASE_URL = SOURCE_DATABASE_URL;

interface CommandEvidence {
  command: string;
  durationMs: number;
  outputHash: string;
  outputLines: number;
  tests?: {
    files: number;
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    todo: number;
  };
}

interface GateEvidence {
  id: P6GateId;
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
  const jsonLine = clean(output).split(/\r?\n/).reverse().find((line: string) => line.startsWith('{"numTotalTestSuites"'));
  assert(jsonLine, `${label} emitted no machine-readable Vitest result`);
  const result = JSON.parse(jsonLine) as VitestJson;
  assert(result.success, `${label} reported success=false`);
  assert(result.numTotalTests > 0, `${label} executed zero tests`);
  assert(result.numFailedTests === 0 && result.numFailedTestSuites === 0, `${label} contained a failed test or suite`);
  assert(result.numPendingTests === 0, `${label} contained ${result.numPendingTests} skipped/pending tests`);
  assert(result.numTodoTests === 0, `${label} contained ${result.numTodoTests} todo tests`);
  assert(result.numPassedTests === result.numTotalTests, `${label} passed ${result.numPassedTests}/${result.numTotalTests} tests`);
  assert(result.testResults.length > 0 && result.testResults.every((test) => test.status === "passed"), `${label} contained a non-passing test file`);
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
  options: { timeoutMs?: number; vitest?: boolean; env?: Partial<NodeJS.ProcessEnv> } = {},
): Promise<CommandEvidence> {
  console.log(`P6_COMMAND_START ${label}`);
  const started = Date.now();
  const chunks: Buffer[] = [];
  let timedOut = false;
  const exitCode = await new Promise<number>((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        CI: "1",
        LOG_LEVEL: "silent",
        VITE_CONFIG_NATIVE_IGNORE_WARNING: "true",
        DATABASE_URL,
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, options.timeoutMs)
      : undefined;
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
    throw new Error(`${label} failed${timedOut ? " (timeout)" : ""}: ${command} ${args.join(" ")}\n${clean(output).slice(-30_000)}`);
  }
  assert(!/CERTIFICATION\s+FAIL/i.test(clean(output)), `${label} printed a certification failure with exit code zero`);
  const evidence: CommandEvidence = {
    command: [command, ...args].join(" "),
    durationMs: Date.now() - started,
    outputHash: digest(output),
    outputLines: output.trim() ? output.trim().split(/\r?\n/).length : 0,
    ...(options.vitest ? { tests: parseVitest(output, label) } : {}),
  };
  console.log(`P6_COMMAND_PASS ${label} ${evidence.durationMs}ms${evidence.tests ? ` ${evidence.tests.passed}/${evidence.tests.total} tests` : ""}`);
  return evidence;
}

async function runGate(
  id: P6GateId,
  commands: Array<() => Promise<CommandEvidence>>,
  facts?: Record<string, unknown>,
): Promise<GateEvidence> {
  console.log(`P6_GATE_START ${id}`);
  const started = Date.now();
  const evidence: CommandEvidence[] = [];
  for (const command of commands) evidence.push(await command());
  const result: GateEvidence = { id, status: "PASS", durationMs: Date.now() - started, evidence, ...(facts ? { facts } : {}) };
  console.log(`P6_GATE_PASS ${id} ${result.durationMs}ms`);
  return result;
}

async function requireDatabase(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 3_000 });
  try {
    await client.connect();
    const result = await client.query<{ value: number }>("SELECT 1::int value");
    assert(result.rows[0]?.value === 1, "PostgreSQL preflight did not return one");
  } catch (error) {
    throw new Error(`P6 certification requires live local PostgreSQL at ${new URL(databaseUrl).host}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

function databaseUrlFor(sourceUrl: string, database: string): string {
  const url = new URL(sourceUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/** Every certification run gets the current migration lineage on an isolated
 * database. This prevents an unrelated developer database, a prior failed suite,
 * or an older locally-applied migration body from turning skips into false PASSes
 * or false failures. The exact generated database is force-dropped in finally. */
async function createCertificationDatabase(): Promise<{ url: string; cleanup: () => Promise<void> }> {
  const database = `finnor_p6_cert_${randomUUID().replaceAll("-", "_")}`;
  assert(/^finnor_p6_cert_[a-f0-9_]+$/.test(database), "generated certification database name is unsafe");
  const source = new pg.Client({ connectionString: SOURCE_DATABASE_URL });
  await source.connect();
  try {
    await source.query(`CREATE DATABASE ${database}`);
  } finally {
    await source.end();
  }
  const url = databaseUrlFor(SOURCE_DATABASE_URL, database);
  try {
    await migrate(url);
    // The shared Vitest setup installs a Core-only vertical seam for historical
    // generic fixtures. Establish the canonical PE seed first so that seam cannot
    // classify this fixed seed tenant before its own acceptance suite runs.
    await seed(url);
  } catch (error) {
    const cleanup = new pg.Client({ connectionString: SOURCE_DATABASE_URL });
    await cleanup.connect();
    try { await cleanup.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); } finally { await cleanup.end(); }
    throw error;
  }
  return {
    url,
    cleanup: async () => {
      const cleanup = new pg.Client({ connectionString: SOURCE_DATABASE_URL });
      await cleanup.connect();
      try { await cleanup.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); } finally { await cleanup.end(); }
    },
  };
}

async function inspectArchitecture(): Promise<Record<string, unknown>> {
  const paths = {
    package: "package.json",
    planningPackage: "packages/planning/package.json",
    planningContracts: "packages/planning/src/contracts.ts",
    planningBuilders: "packages/planning/src/builders.ts",
    planningCompiler: "packages/planning/src/compiler.ts",
    planner: "packages/orchestration/src/planner.ts",
    planRuntime: "packages/orchestration/src/plan-runtime.ts",
    planProgress: "packages/orchestration/src/plan-progress.ts",
    objectiveLoop: "packages/orchestration/src/objective-loop.ts",
    registry: "packages/orchestration/src/plugin-registry.ts",
    health: "packages/orchestration/src/planning-health.ts",
    migration: `packages/db/migrations/${P6_MIGRATION}`,
    db: "packages/db/index.ts",
    attentionQuery: "packages/read-models/src/attention-query.ts",
    attentionRanking: "packages/read-models/src/attention-ranking.ts",
    operationalQueries: "packages/read-models/src/operational-queries.ts",
    consoleBoundary: "apps/console/lib/work-planning.ts",
    consoleView: "apps/console/components/work/WorkPlanningClient.tsx",
    openapi: "openapi.json",
    authz: "docs/authz-matrix.md",
  } as const;
  const source = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, await readFile(resolve(ROOT, path), "utf8")]))) as Record<keyof typeof paths, string>;
  const packageJson = JSON.parse(source.package) as { scripts?: Record<string, string> };
  const planningPackage = JSON.parse(source.planningPackage) as { dependencies?: Record<string, string> };

  assert(P6_MANDATORY_CASE_COUNT === EXPECTED_MANDATORY_CASES, `P6 ledger has ${P6_MANDATORY_CASE_COUNT}/${EXPECTED_MANDATORY_CASES} mandatory cases`);
  assert(new Set(P6_MANDATORY_CASES.map((item) => item.id)).size === P6_MANDATORY_CASE_COUNT, "P6 mandatory case IDs are not unique");
  assert(P6_MANDATORY_CASES.every((item) => item.gates.length > 0), "P6 mandatory ledger contains an unmapped case");
  assert(!P6_MANDATORY_CASES.some((item) => /\b(?:TODO|SKIP(?:PED)?|PLACEHOLDER)\b/i.test(`${item.id} ${item.statement}`)), "P6 mandatory ledger contains a placeholder");
  assert(P6_GATE_IDS.every((gate) => P6_MANDATORY_CASES.some((item) => item.gates.includes(gate))), "P6 mandatory ledger contains an unused gate");
  assert(packageJson.scripts?.["release:pe-p6"] === "tsx scripts/release/run-pe-p6-planning-attention-certification.ts", "release:pe-p6 command is missing or ambiguous");
  assert((CURRENT_MIGRATION_HEAD as string).localeCompare(P6_MIGRATION) >= 0, `declared migration head predates ${P6_MIGRATION}: ${CURRENT_MIGRATION_HEAD}`);

  assert(JSON.stringify(Object.keys(planningPackage.dependencies ?? {}).sort()) === JSON.stringify(["zod"]), "@finnor/planning is not a pure zod-only package");
  const purePlanning = [source.planningContracts, source.planningBuilders, source.planningCompiler].join("\n");
  assert(!/@finnor\/(?:db|orchestration|private-equity|authority|read-models|provider|tools)/.test(purePlanning), "pure planning IR imports a runtime/truth owner");
  assert(!/\b(?:fetch|new\s+Client|withTenant|executeAction|process\.env)\b/.test(purePlanning), "pure planning IR contains runtime I/O");
  for (const contract of ["GoalSpec", "ConstraintSet", "PlanningWorldSnapshot", "CandidatePlan", "PlanGraph", "PlanNode", "PlanEdge", "PlanScoreVector", "PlanRevision", "CompletionProof", "RecoverySpec", "ObservationSpec"]) {
    assert(source.planningContracts.includes(`interface ${contract}`) || source.planningContracts.includes(`type ${contract}`), `planning IR is missing ${contract}`);
  }
  assert(source.planningContracts.includes('PLAN_NODE_KINDS = ["query", "action", "wait", "check"]'), "PlanGraph has the wrong node-kind surface");
  assert(source.planner.includes("Promise<PlanningResult>"), "Planner does not return PlanningResult");
  assert(!source.planner.includes("Promise<DomainAction[]>"), "planner.ts retains direct DomainAction[] authority");
  assert(source.planner.includes("z.array(z.unknown()).min(1).max(4)"), "model candidate envelope is not bounded to one through four");
  assert(source.planner.includes("compileAndSelectPlans({"), "planner does not delegate validity and selection to the deterministic compiler");
  assert(source.planningCompiler.includes("The only selection authority") && source.planningCompiler.includes("compareScore(left.score, right.score)"), "deterministic compiler selection authority is missing");
  assert(!source.planningCompiler.includes("modelWinner") && !source.planningCompiler.includes("selectedByModel"), "compiler contains model-owned winner authority");
  assert(source.planRuntime.includes("The sole PlanGraph -> DomainAction adapter") && source.planRuntime.includes("selectPlanRevision(params"), "one PlanGraph materialization adapter is not explicit");
  assert(source.planRuntime.includes("WorkInput changed before plan materialization"), "materialization lacks current WorkInput fence");
  assert(source.objectiveLoop.includes("resolvePlanProgress(activeGraph") && source.objectiveLoop.includes("this.canonicalPlanner.plan") && source.objectiveLoop.includes("selectPlanRevision({"), "ObjectiveLoop is not consuming one canonical PlanGraph path");
  assert(source.objectiveLoop.includes("completeWorkPlanRevision") && source.objectiveLoop.includes("CompletionProof"), "ObjectiveLoop does not persist completion through CompletionProof");
  assert(source.planProgress.includes("BusinessEffect") && source.planProgress.includes("DecisionReceipt") && source.planProgress.includes("WorkEventWait"), "Plan progress does not observe existing execution truth owners");
  assert(source.registry.includes("planningCapabilitiesForVertical") && source.registry.includes("HUMAN_ONLY_PLANNING_CAPABILITIES"), "existing plugin registry lacks planning metadata/human-only boundary");
  assert(source.health.includes("requiredPlanningHealthCapability") && source.objectiveLoop.includes("planningHealthForAction"), "provider health is not checked at live dispatch");

  const createTables = [...source.migration.matchAll(/CREATE\s+TABLE\s+finnor_os\.([a-z0-9_]+)/gi)].map((match) => match[1]);
  assert(JSON.stringify(createTables) === JSON.stringify(["work_plan_revisions"]), `P6 migration created unexpected tables: ${createTables.join(",")}`);
  assert(source.migration.includes("FORCE ROW LEVEL SECURITY") && source.migration.includes("CREATE POLICY tenant_isolation"), "PlanRevision hard RLS is missing");
  assert(source.migration.includes("guard_work_plan_revision_mutation") && source.migration.includes("plan revisions are immutable history"), "PlanRevision immutability guard is missing");
  assert(source.migration.includes("work_plan_revisions_one_active_idx") && source.migration.includes("plan revision must follow its exact parent"), "PlanRevision active/lineage invariants are missing");
  assert(source.migration.includes("assert_domain_action_plan_link") && source.migration.includes("DomainAction must exactly materialize one action PlanNode"), "DomainAction-to-PlanNode database guard is missing");
  assert(source.db.includes("persistSelectedWorkPlan") && source.db.includes("completeWorkPlanRevision"), "PlanRevision database API is missing");

  assert(source.operationalQueries.includes('request.intent === "attention_queue"') && source.attentionQuery.includes("rankAttentionItems") === false, "attention query is not wired directly through the operational query plane");
  assert(source.attentionRanking.includes("deterministic lexicographic rank") && source.attentionRanking.includes("sort(compareAttentionItems"), "server-side deterministic attention rank is missing");
  assert(source.attentionQuery.includes("CANONICAL_SOURCE_READ_FAILED") && source.attentionQuery.includes('status: "unavailable"'), "attention source failures do not fail visibly");
  assert(source.consoleBoundary.includes("return items;") && !source.consoleBoundary.includes(".sort("), "console boundary owns an independent attention rank");
  assert(!source.consoleView.includes(".sort(") && source.consoleView.includes("attentionItemsInServerOrder"), "console view recomputes attention priority");
  assert(source.openapi.includes('"attention_queue"') && source.openapi.includes('"/api/queries"') && source.authz.includes("/api/queries"), "attention API/OpenAPI/authz contract is incomplete");

  const changed = await runCommand("architecture.changed-files", "git", ["diff", "--name-only", "origin/main"], { timeoutMs: 30_000 });
  const changedOutput = await new Promise<string>((resolvePromise, reject) => {
    const child = spawn("git", ["diff", "--name-only", "origin/main"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolvePromise(Buffer.concat(chunks).toString("utf8")) : reject(new Error("unable to audit changed files")));
  });
  assert(!changedOutput.split(/\r?\n/).some((path) => /(?:^|\/)(?:infra|terraform|cdk|cloudformation|aws)(?:\/|$)/i.test(path)), "P6 introduced an AWS/infrastructure surface");
  assert(!/(?:Bedrock|SageMaker|AgentCore|Lambda|Step Functions|autonomous workforce)/i.test([source.planningContracts, source.planningCompiler, source.planner, source.planRuntime, source.attentionQuery].join("\n")), "P6 planning/attention surface contains P7 or AWS expansion");

  return {
    mandatoryCases: P6_MANDATORY_CASE_COUNT,
    purePlanningDependency: "zod",
    planNodeKinds: ["query", "action", "wait", "check"],
    newPlanningTables: createTables,
    migrationHead: CURRENT_MIGRATION_HEAD,
    canonicalPlannerReturn: "PlanningResult",
    modelCandidateMaximum: 4,
    frontendAttentionAuthority: "server-order-only",
    changedFilesAudit: changed,
  };
}

function vitest(label: string, files: readonly string[], timeoutMs = 600_000): () => Promise<CommandEvidence> {
  return () => runCommand(label, BIN("vitest"), ["run", ...files, "--reporter=json", "--maxWorkers=1", "--fileParallelism=false"], { vitest: true, timeoutMs });
}

function command(label: string, executable: string, args: readonly string[], timeoutMs = 600_000): () => Promise<CommandEvidence> {
  return () => runCommand(label, executable, args, { timeoutMs });
}

async function main(): Promise<void> {
  const started = Date.now();
  await requireDatabase(SOURCE_DATABASE_URL);
  const certificationDatabase = await createCertificationDatabase();
  DATABASE_URL = certificationDatabase.url;
  let finalResult: Record<string, unknown> | null = null;
  try {
  const gateResults = new Map<P6GateId, GateEvidence>();

  console.log("P6_GATE_START architecture");
  const architectureStarted = Date.now();
  const architecture = await inspectArchitecture();
  gateResults.set("architecture", {
    id: "architecture",
    status: "PASS",
    durationMs: Date.now() - architectureStarted,
    evidence: [],
    facts: architecture,
  });
  console.log(`P6_GATE_PASS architecture ${Date.now() - architectureStarted}ms`);

  const firstWave = await Promise.all([
    runGate("typecheck", [command("typecheck", BIN("tsc"), ["-p", "tsconfig.json", "--pretty", "false"], 300_000)]),
    runGate("planning-unit", [vitest("planning-unit", [
      "tests/unit/phase6-planning-compiler.test.ts",
      "tests/unit/phase6-plan-progress.test.ts",
      "tests/unit/phase6-attention.test.ts",
      "tests/unit/phase6-dispatch-health.test.ts",
      "tests/unit/openapi-operational-query-contract.test.ts",
      "tests/unit/objective-success-contract.test.ts",
      "tests/unit/instruction-cancellation-semantics.test.ts",
      "tests/unit/voice-objective-control.test.ts",
    ])]),
    runGate("contracts", [
      command("action-manifest", "npm", ["run", "release:manifest"], 300_000),
      command("authz-matrix", "npm", ["run", "authz:matrix:check"], 300_000),
      command("pe-domain-boundary", "npm", ["run", "PE-DOMAIN-BOUNDARY"], 300_000),
    ]),
  ]);
  for (const result of firstWave) gateResults.set(result.id, result);

  const orderedDatabaseGates: Array<[P6GateId, Array<() => Promise<CommandEvidence>>]> = [
    ["runtime-integration", [vitest("runtime-integration", [
      "tests/integration/phase6-plan-graph-runtime.test.ts",
      "tests/integration/single-action-runtime-bridge.test.ts",
      "tests/integration/external-effect-observation.test.ts",
      "tests/integration/private-equity-phase4.test.ts",
    ], 900_000)]],
    ["concurrency", [vitest("concurrency", ["tests/integration/phase6-plan-concurrency.test.ts"], 600_000)]],
    ["performance", [vitest("performance", ["tests/integration/phase6-performance.test.ts"], 600_000)]],
    ["migration", [vitest("migration", ["tests/integration/private-equity-p6-upgrade.test.ts"], 900_000)]],
    ["pe-regressions", [vitest("pe-regressions", [
      "tests/integration/private-equity-p1-world-truth.test.ts",
      "tests/integration/private-equity-phase2.test.ts",
      "tests/integration/private-equity-phase3.test.ts",
      "tests/integration/artifact-os.test.ts",
      "tests/integration/microsoft365-pe-mapping.test.ts",
      "tests/integration/private-equity-p4-underwriting.test.ts",
      "tests/integration/private-equity-phase4.test.ts",
      "tests/integration/private-equity-p5-ic-runtime.test.ts",
    ], 1_200_000)]],
    ["core-regressions", [
      vitest("core-unit-regressions", ["tests/unit"], 1_200_000),
      vitest("core-integration-regressions", [
        "tests/integration/work-kernel.test.ts",
        "tests/integration/decision-receipts.test.ts",
        "tests/integration/external-effect-observation.test.ts",
        "tests/integration/workflow-runtime.test.ts",
        "tests/integration/policy-engine-v2.test.ts",
        "tests/integration/source-truth-loop.test.ts",
        "tests/integration/actions-pending-receipts.test.ts",
        "tests/integration/tenant-isolation.test.ts",
      ], 1_200_000),
    ]],
  ];
  for (const [id, commands] of orderedDatabaseGates) gateResults.set(id, await runGate(id, commands));

  const builds = await runGate("builds", [
    command("api-production-build", "npm", ["run", "build", "--workspace", "@finnor/api"], 900_000),
    command("console-production-build", "npm", ["run", "build", "--workspace", "@finnor/console"], 900_000),
  ]);
  gateResults.set(builds.id, builds);

  assert(gateResults.size === P6_GATE_IDS.length, `P6 executed ${gateResults.size}/${P6_GATE_IDS.length} gates`);
  assert(P6_GATE_IDS.every((id) => gateResults.get(id)?.status === "PASS"), "P6 has a non-passing gate");
  const mandatoryCases = P6_MANDATORY_CASES.map((item) => ({
    ...item,
    status: item.gates.every((gate) => gateResults.get(gate)?.status === "PASS") ? "PASS" as const : "FAIL" as const,
  }));
  const passed = mandatoryCases.filter((item) => item.status === "PASS").length;
  assert(passed === EXPECTED_MANDATORY_CASES, `P6 passed ${passed}/${EXPECTED_MANDATORY_CASES} mandatory cases`);
  const totalTests = [...gateResults.values()].flatMap((gate) => gate.evidence).reduce((sum, item) => sum + (item.tests?.total ?? 0), 0);
  finalResult = {
    status: "PASS",
    mandatoryCases: EXPECTED_MANDATORY_CASES,
    passedCases: passed,
    failedCases: 0,
    skippedCases: 0,
    executableTests: totalTests,
    gates: P6_GATE_IDS.map((id) => ({ id, status: gateResults.get(id)!.status, durationMs: gateResults.get(id)!.durationMs })),
    migrationHead: CURRENT_MIGRATION_HEAD,
    durationMs: Date.now() - started,
  };
  } finally {
    await certificationDatabase.cleanup();
  }
  assert(finalResult, "P6 certification finished without a result");
  console.log(`P6_CERTIFICATION ${JSON.stringify(finalResult)}`);
}

main().catch((error) => {
  console.error(`P6_CERTIFICATION_FAIL ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
