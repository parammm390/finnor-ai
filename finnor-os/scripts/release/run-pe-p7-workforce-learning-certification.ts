import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { seed } from "../../packages/db/seed";
import { CURRENT_MIGRATION_HEAD } from "../../packages/db/migration-head";
import {
  P7_GATE_IDS,
  P7_MANDATORY_CASES,
  P7_MANDATORY_CASE_COUNT,
  P7_REQUIRED_GROUPS,
  type P7GateId,
} from "./pe-p7-workforce-learning-mandatory-cases";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "../..");
const REPOSITORY_ROOT = resolve(ROOT, "..");
const BIN = (name: string) => resolve(ROOT, "node_modules/.bin", name);
const P7_MIGRATION = "0129_phase7_governed_workforce_learning.sql";
let databaseUrl = "";

interface CommandEvidence {
  command: string;
  durationMs: number;
  outputHash: string;
  outputLines: number;
  tests?: { files: number; total: number; passed: number; failed: number; skipped: number; todo: number };
}

interface GateEvidence {
  id: P7GateId;
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
  console.log(`P7_COMMAND_START ${label}`);
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
    throw new Error(`${label} failed${timedOut ? " (timeout)" : ""}: ${command} ${args.join(" ")}\n${clean(output).slice(-30_000)}`);
  }
  assert(!/CERTIFICATION(?:_|\s)+FAIL/i.test(clean(output)), `${label} printed a certification failure with exit code zero`);
  const evidence: CommandEvidence = {
    command: [command, ...args].join(" "),
    durationMs: Date.now() - started,
    outputHash: digest(output),
    outputLines: output.trim() ? output.trim().split(/\r?\n/).length : 0,
    ...(options.vitest ? { tests: parseVitest(output, label) } : {}),
  };
  console.log(`P7_COMMAND_PASS ${label} ${evidence.durationMs}ms${evidence.tests ? ` ${evidence.tests.passed}/${evidence.tests.total} tests` : ""}`);
  return evidence;
}

async function runGate(id: P7GateId, commands: Array<() => Promise<CommandEvidence>>, facts?: Record<string, unknown>): Promise<GateEvidence> {
  console.log(`P7_GATE_START ${id}`);
  const started = Date.now();
  const evidence: CommandEvidence[] = [];
  for (const command of commands) evidence.push(await command());
  const result: GateEvidence = { id, status: "PASS", durationMs: Date.now() - started, evidence, ...(facts ? { facts } : {}) };
  console.log(`P7_GATE_PASS ${id} ${result.durationMs}ms`);
  return result;
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
  if (await canConnect(configured)) return { url: configured, mode: "configured", cleanup: async () => undefined };
  const directory = await mkdtemp(join(tmpdir(), "finnor-p7-cert-pg-"));
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

async function createCertificationDatabase(sourceUrl: string): Promise<{ url: string; cleanup: () => Promise<void> }> {
  const database = `finnor_p7_cert_${randomUUID().replaceAll("-", "_")}`;
  assert(/^finnor_p7_cert_[a-f0-9_]+$/.test(database), "generated certification database name is unsafe");
  const source = new pg.Client({ connectionString: sourceUrl });
  await source.connect();
  try { await source.query(`CREATE DATABASE ${database}`); } finally { await source.end(); }
  const url = databaseUrlFor(sourceUrl, database);
  try {
    await migrate(url);
    await seed(url);
    // Migration 0032 deliberately creates finnor_app as NOLOGIN so production
    // receives its password out-of-band. The disposable certification database
    // must opt into a fixed local password explicitly because the concurrency
    // suite connects through TCP as the restricted RLS principal.
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
    workforcePackage: "packages/workforce/package.json",
    contracts: "packages/workforce/src/contracts.ts",
    eligibility: "packages/workforce/src/eligibility.ts",
    learning: "packages/workforce/src/learning.ts",
    runtime: "packages/orchestration/src/workforce-runtime.ts",
    learningRuntime: "packages/orchestration/src/workforce-learning.ts",
    objectiveLoop: "packages/orchestration/src/objective-loop.ts",
    worker: "apps/worker/src/handlers/run-workforce-assignment.ts",
    learningDigest: "apps/worker/src/handlers/learning-digest.ts",
    workerIndex: "apps/worker/src/index.ts",
    readModel: "packages/read-models/src/workforce-status.ts",
    attention: "packages/read-models/src/attention-query.ts",
    migration: `packages/db/migrations/${P7_MIGRATION}`,
    openapi: "openapi.json",
    configureRoute: "apps/api/app/api/workforce/profiles/route.ts",
    reassignRoute: "apps/api/app/api/workforce/assignments/[id]/reassign/route.ts",
    proposalRoute: "apps/api/app/api/workforce/proposals/[id]/route.ts",
  } as const;
  const source = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, await readFile(resolve(ROOT, path), "utf8")]))) as Record<keyof typeof paths, string>;
  const frontend = await readFile(resolve(REPOSITORY_ROOT, "src/components/jarvis/agents/AgentFleetSurface.tsx"), "utf8");
  const rootClient = await readFile(resolve(REPOSITORY_ROOT, "src/lib/jarvis-client.ts"), "utf8");
  const packageJson = JSON.parse(source.package) as { scripts?: Record<string, string> };
  const workforcePackage = JSON.parse(source.workforcePackage) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

  assert(P7_MANDATORY_CASE_COUNT === P7_REQUIRED_GROUPS.length, "P7 mandatory registry must contain exactly one named case per required group");
  assert(new Set(P7_MANDATORY_CASES.map((item) => item.id)).size === P7_MANDATORY_CASE_COUNT, "P7 mandatory case IDs are not unique");
  assert(new Set(P7_MANDATORY_CASES.map((item) => item.group)).size === P7_REQUIRED_GROUPS.length, "P7 mandatory groups are missing or duplicated");
  assert(P7_REQUIRED_GROUPS.every((group) => P7_MANDATORY_CASES.some((item) => item.group === group)), "P7 mandatory registry omits a required group");
  assert(P7_MANDATORY_CASES.every((item) => item.gates.length > 0), "P7 mandatory registry contains an unmapped case");
  assert(!P7_MANDATORY_CASES.some((item) => /\b(?:TODO|SKIP(?:PED)?|PLACEHOLDER|NOT.CONFIGURED)\b/i.test(`${item.id} ${item.statement}`)), "P7 mandatory registry contains a disguised non-gate");
  assert(P7_GATE_IDS.every((gate) => P7_MANDATORY_CASES.some((item) => item.gates.includes(gate))), "P7 mandatory registry contains an unused gate");
  assert(packageJson.scripts?.["release:pe-p7-workforce-learning"] === "tsx scripts/release/run-pe-p7-workforce-learning-certification.ts", "release:pe-p7-workforce-learning command is missing or ambiguous");
  assert(String(CURRENT_MIGRATION_HEAD).localeCompare(P7_MIGRATION) >= 0, `declared migration head predates ${P7_MIGRATION}: ${CURRENT_MIGRATION_HEAD}`);
  assert(Object.keys(workforcePackage.dependencies ?? {}).length === 0 && Object.keys(workforcePackage.devDependencies ?? {}).length === 0, "@finnor/workforce must remain a pure dependency-free package");

  for (const contract of ["AgentProfile", "AgentProfileRevision", "AgentCapabilityGrant", "WorkforceAssignment", "AssignmentEligibility", "AssignmentScore", "LearningObservation", "LearningProposal", "LearningRevision"]) {
    assert(source.contracts.includes(`interface ${contract}`), `@finnor/workforce is missing ${contract}`);
  }
  assert(source.eligibility.includes("Hard filters only") && source.eligibility.includes("rankEligibleWorkers"), "deterministic hard eligibility/ranking is missing");
  assert(source.eligibility.includes("MIN_ROUTING_SAMPLE_SIZE = 5") && source.eligibility.includes('sampleState === "KNOWN"'), "small learning samples are not fenced from routing");
  assert(source.runtime.includes("canExerciseAuthority") && source.runtime.includes("requestWorkforceAssignment") && source.runtime.includes("claimWorkforceAssignment"), "governed workforce runtime is incomplete");
  assert(source.objectiveLoop.includes("requestWorkforceAssignment({") && source.objectiveLoop.includes("claimWorkforceAssignment({"), "ObjectiveLoop does not consume the workforce ownership seam");
  assert(source.worker.includes("FinnorOrchestrator") && source.worker.includes("runObjectiveIteration") && !source.worker.includes("execute(plugin"), "workforce job bypasses or fails to resume ObjectiveLoop");
  assert((source.workerIndex.match(/queue\.register\("run_workforce_assignment"/g) ?? []).length === 1, "run_workforce_assignment must have exactly one queue registration");
  assert(source.learningDigest.includes("generateWorkforceLearningProposals") && source.learningRuntime.includes("proposal-only") && source.learningRuntime.includes("observationsTruncated"), "learning_digest is not safely reused for bounded typed proposals");
  assert(source.learning.includes("assertSafeLearningChange") && !/writeFile|database schema|ALTER TABLE/.test(source.learning), "pure learning can mutate a prohibited hard surface");
  assert(source.readModel.includes('intent: "workforce_status"') && source.readModel.includes('status: anyTruncated ? "partial" : "complete"') && source.readModel.includes("nextCursor"), "workforce_status is not a truthful bounded projection");
  for (const reason of ["ai_assignment_failed", "no_eligible_ai_worker", "worker_budget_exhausted", "learning_proposal_review", "human_only_boundary"]) assert(source.attention.includes(reason), `attention_queue is missing ${reason}`);

  const tables = [...source.migration.matchAll(/CREATE\s+TABLE\s+finnor_os\.([a-z0-9_]+)/gi)].map((match) => match[1]!).sort();
  const expectedTables = ["agent_profile_revisions", "agent_profiles", "learning_observations", "learning_proposals", "learning_revisions", "workforce_assignments"].sort();
  assert(JSON.stringify(tables) === JSON.stringify(expectedTables), `P7 migration created unexpected tables: ${tables.join(",")}`);
  assert((source.migration.match(/FORCE ROW LEVEL SECURITY/g) ?? []).length === 6, "all six P7 tenant tables must FORCE RLS");
  for (const phrase of ["agent_profile_revisions_immutable", "learning_observations_immutable", "learning_revisions_immutable", "AI AgentProfile identity cannot equal a human user identity"]) assert(source.migration.includes(phrase), `P7 migration is missing invariant: ${phrase}`);
  assert(!/INSERT\s+INTO\s+finnor_os\.agent_profiles/i.test(source.migration), "P7 migration contains a fake AgentProfile backfill");

  for (const route of ["/api/workforce/profiles", "/api/workforce/assignments/{id}/reassign", "/api/workforce/proposals/{id}", "/api/queries"]) assert(source.openapi.includes(`\"${route}\"`), `OpenAPI is missing ${route}`);
  assert(source.configureRoute.includes("configureAgentProfile") && source.reassignRoute.includes("reassignWorkforceAssignment") && source.proposalRoute.includes("promoteLearningProposal"), "P7 API routes are not bound to governed runtime functions");
  await access(resolve(REPOSITORY_ROOT, "src/components/jarvis/agents/agent-fleet.ts")).then(() => { throw new Error("static frontend agent-fleet authority still exists"); }, () => undefined);
  assert(!frontend.includes("AGENT_FLEET") && frontend.includes("businessProjections.workforceStatus()") && frontend.includes("no inferred health"), "JARVIS workforce surface is not backend-truth-only");
  for (const status of ["unconfigured", "idle", "working", "waiting", "blocked", "failed", "unavailable"]) assert(frontend.includes(status), `JARVIS workforce surface omits ${status}`);
  assert(rootClient.includes('status: "complete" | "partial"') && rootClient.includes("truncatedSources"), "JARVIS client does not preserve workforce source completeness");

  const p7Sources = [source.contracts, source.eligibility, source.learning, source.runtime, source.learningRuntime, source.worker, source.readModel].join("\n");
  assert(!/@aws-sdk|\b(?:ECS|SQS|EventBridge|Step Functions|Kafka|Lambda@Edge)\b/.test(p7Sources), "P7 introduced a prohibited AWS/orchestration surface");
  assert(!/agent-to-agent|agent swarm|spawn agent|multi-agent chat/i.test(p7Sources), "P7 introduced prohibited agent theater");

  return {
    mandatoryCases: P7_MANDATORY_CASE_COUNT,
    requiredGroups: P7_REQUIRED_GROUPS.length,
    migrationHead: CURRENT_MIGRATION_HEAD,
    newTables: tables,
    workforcePackageDependencies: 0,
    workforceJobs: ["run_workforce_assignment", "learning_digest"],
    frontendAuthority: "canonical-workforce-status-only",
  };
}

function vitest(label: string, files: readonly string[], timeoutMs = 600_000): () => Promise<CommandEvidence> {
  return () => runCommand(label, BIN("vitest"), ["run", ...files, "--reporter=json", "--maxWorkers=1", "--fileParallelism=false"], { vitest: true, timeoutMs });
}

function command(label: string, executable: string, args: readonly string[], timeoutMs = 600_000, cwd = ROOT): () => Promise<CommandEvidence> {
  return () => runCommand(label, executable, args, { timeoutMs, cwd });
}

async function main(): Promise<void> {
  const started = Date.now();
  const source = await sourceDatabase();
  let certificationDatabase: Awaited<ReturnType<typeof createCertificationDatabase>> | undefined;
  let finalResult: Record<string, unknown> | undefined;
  try {
    certificationDatabase = await createCertificationDatabase(source.url);
    databaseUrl = certificationDatabase.url;
    const gates = new Map<P7GateId, GateEvidence>();

    console.log("P7_GATE_START architecture");
    const architectureStarted = Date.now();
    const architecture = await inspectArchitecture();
    gates.set("architecture", { id: "architecture", status: "PASS", durationMs: Date.now() - architectureStarted, evidence: [], facts: architecture });
    console.log(`P7_GATE_PASS architecture ${Date.now() - architectureStarted}ms`);

    gates.set("typecheck-contracts", await runGate("typecheck-contracts", [
      command("openapi-generate", "npm", ["run", "openapi"], 300_000),
      command("nested-typecheck", BIN("tsc"), ["-p", "tsconfig.json", "--pretty", "false"], 300_000),
      command("root-typecheck", BIN("tsc"), ["-p", resolve(REPOSITORY_ROOT, "tsconfig.json"), "--noEmit", "--pretty", "false"], 300_000),
      command("authz-matrix", "npm", ["run", "authz:matrix:check"], 300_000),
      command("action-manifest", "npm", ["run", "release:manifest"], 300_000),
      command("diff-check", "git", ["diff", "--check"], 60_000, REPOSITORY_ROOT),
    ]));

    gates.set("workforce-unit", await runGate("workforce-unit", [vitest("workforce-unit", [
      "tests/unit/phase7-workforce.test.ts",
      "tests/unit/phase7-learning.test.ts",
      "tests/unit/phase7-workforce-read-surface.test.ts",
      "tests/unit/phase6-attention.test.ts",
      "tests/unit/openapi-operational-query-contract.test.ts",
    ])]));

    gates.set("runtime-concurrency", await runGate("runtime-concurrency", [vitest("runtime-concurrency", ["tests/integration/phase7-workforce-concurrency.test.ts"], 900_000)]));
    gates.set("migrations", await runGate("migrations", [vitest("migrations", [
      "tests/integration/private-equity-p7-upgrade.test.ts",
      "tests/integration/private-equity-p6-upgrade.test.ts",
    ], 900_000)]));
    gates.set("performance", await runGate("performance", [vitest("performance", ["tests/integration/phase7-performance.test.ts"], 600_000)]));
    gates.set("regressions", await runGate("regressions", [vitest("p1-p6-core-regressions", [
      "tests/integration/private-equity-p1-world-truth.test.ts",
      "tests/integration/private-equity-phase2.test.ts",
      "tests/integration/private-equity-phase3.test.ts",
      "tests/integration/private-equity-p4-underwriting.test.ts",
      "tests/integration/private-equity-p5-ic-runtime.test.ts",
      "tests/integration/phase6-plan-graph-runtime.test.ts",
      "tests/integration/work-kernel.test.ts",
      "tests/integration/decision-receipts.test.ts",
      "tests/integration/external-effect-observation.test.ts",
      "tests/integration/policy-engine-v2.test.ts",
      "tests/integration/source-truth-loop.test.ts",
      "tests/integration/tenant-isolation.test.ts",
    ], 1_200_000)]));

    assert(gates.size === P7_GATE_IDS.length, `P7 executed ${gates.size}/${P7_GATE_IDS.length} gates`);
    assert(P7_GATE_IDS.every((id) => gates.get(id)?.status === "PASS"), "P7 has a non-passing gate");
    const cases = P7_MANDATORY_CASES.map((item) => ({ ...item, status: item.gates.every((gate) => gates.get(gate)?.status === "PASS") ? "PASS" as const : "FAIL" as const }));
    const passed = cases.filter((item) => item.status === "PASS").length;
    assert(passed === P7_MANDATORY_CASE_COUNT, `P7 passed ${passed}/${P7_MANDATORY_CASE_COUNT} mandatory cases`);
    const executableTests = [...gates.values()].flatMap((gate) => gate.evidence).reduce((sum, item) => sum + (item.tests?.total ?? 0), 0);
    finalResult = {
      status: "PASS",
      mandatoryGroups: P7_REQUIRED_GROUPS.length,
      mandatoryCases: P7_MANDATORY_CASE_COUNT,
      passedCases: passed,
      failedCases: 0,
      skippedCases: 0,
      todoCases: 0,
      executableTests,
      gates: P7_GATE_IDS.map((id) => ({ id, status: gates.get(id)!.status, durationMs: gates.get(id)!.durationMs })),
      migrationHead: CURRENT_MIGRATION_HEAD,
      databaseMode: source.mode,
      externalProviderCertification: "not-required-for-deterministic-p7",
      durationMs: Date.now() - started,
    };
  } finally {
    if (certificationDatabase) await certificationDatabase.cleanup().catch(() => undefined);
    await source.cleanup().catch(() => undefined);
  }
  assert(finalResult, "P7 certification finished without a result");
  console.log(`P7_CERTIFICATION ${JSON.stringify(finalResult)}`);
}

main().catch((error) => {
  console.error(`P7_CERTIFICATION_FAIL ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
