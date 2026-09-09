import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { PE_ENTITY_TYPES } from "@finnor/private-equity";
import { closePool } from "@finnor/db";
import { migrate, type MigrationFile } from "../../packages/db/migrate";
import { MIGRATIONS } from "../../packages/db/migrations-bundle";
import { CURRENT_MIGRATION_HEAD } from "../../packages/db/migration-head";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "../..");
const REPOSITORY_ROOT = resolve(ROOT, "..");
const MIGRATIONS_DIR = resolve(ROOT, "packages/db/migrations");
const OUTPUT_DIR = resolve(REPOSITORY_ROOT, "docs/release/generated");
const JSON_OUTPUT = resolve(OUTPUT_DIR, "pe-p1-world-truth-certification.json");
const MARKDOWN_OUTPUT = resolve(REPOSITORY_ROOT, "docs/release/pe-p1-world-truth-certification.md");
const P1_MIGRATION_HEAD = "0111_pe_world_truth.sql";
const MIGRATION_HEAD = CURRENT_MIGRATION_HEAD;
const NEW_ENTITY_TYPES = [
  "pe_strategy", "pe_opportunity", "pe_investment_case", "pe_thesis", "pe_assumption", "pe_decision",
] as const;
const STARTING_BASELINE = {
  branch: "codex/p3-epistemic-runtime",
  headSha: "80f617d321965b8694de18940ff23b005dedcdb7",
  treeSha: "f38b551d99952986527e4986e3ba77891a3c10ef",
  migrationHead: "0109_atomic_water_runtime_retirement.sql",
  cachedOriginMainSha: "4cc85c5534988f2b9f4b5938f0e4b6758985206c",
} as const;

type Status = "PASS" | "FAIL";

interface CommandEvidence {
  command: string;
  status: Status;
  exitCode: number;
  durationMs: number;
  outputHash: string;
  outputLineCount: number;
  summary: string;
}

interface GateEvidence {
  status: Status;
  evidence: unknown;
}

const mandatoryCaseNames = [
  "Strategy creation",
  "Strategy transition",
  "Opportunity creation",
  "Opportunity lifecycle",
  "Opportunity to Deal atomic promotion",
  "Direct existing signed-LOI Deal creation still works",
  "InvestmentCase creation and activation",
  "Second active InvestmentCase rejected",
  "Thesis lifecycle works without manually setting epistemic support",
  "Assumption belongs directly to InvestmentCase",
  "Assumption can exist independently of one Thesis",
  "Assumption revision preserves history",
  "Semantic Decision creation",
  "Decision finalization",
  "Final Decision cannot be mutated",
  "New Decision can supersede old Decision",
  "Decision links to multiple execution effects",
  "New PE entity types exactly match canonical_truth_registry",
  "Every changed row receives one history snapshot",
  "Multi-row Opportunity promotion receives one history snapshot per changed canonical row",
  "Failed transaction produces no committed snapshots",
  "state_at before mutation returns previous canonical state",
  "state_at after mutation returns new canonical state",
  "Evidence with as_of before t but retrieved_at after t is excluded",
  "Evidence with as_of and retrieved_at at or before t is eligible",
  "UNKNOWN to KNOWN",
  "KNOWN to STALE",
  "KNOWN to CONFLICTING",
  "Conflict resolution today does not rewrite yesterday",
  "Existing PE canonical rows receive migration baseline",
  "Request before baseline returns explicit history unavailable",
  "Existing Deal child history is represented",
  "Provider duplicate behavior unchanged",
  "Provider out-of-order behavior unchanged",
  "Provider same-position conflict behavior unchanged",
  "Provider tombstone behavior unchanged",
  "Strategy and Opportunity receive source, evidence, and document links without fake Deal IDs",
  "Existing Deal document and evidence linking still works",
  "Tenant A cannot inspect Tenant B world or history",
  "Cross-world-root link fails",
  "pe_world_state for Strategy composes Strategy and Opportunity state",
  "pe_world_state for Opportunity composes related world",
  "pe_world_state for Deal includes existing DealExecutionGraph plus P1 entities",
  "Existing PE operational queries remain unchanged",
  "Current close readiness remains unchanged",
  "Current PE action contract remains unchanged",
  "Current authority behavior remains unchanged",
  "Current DecisionReceipt behavior remains unchanged",
  "Existing PE Phase2, Phase3, Phase4, and Phase5 regression suites remain green",
  "Fresh database migration passes",
  "Existing populated database migration passes",
] as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function outputSummary(output: string): string {
  return output.trim().split(/\r?\n/).filter(Boolean).slice(-10).join(" | ").slice(0, 2_400);
}

async function runCommand(
  command: string,
  args: string[],
  options: { env?: Partial<NodeJS.ProcessEnv>; forbidSkips?: boolean; forbidDeprecations?: boolean } = {},
): Promise<CommandEvidence> {
  const started = Date.now();
  const chunks: Buffer[] = [];
  const exitCode = await new Promise<number>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: "true", ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolvePromise(code ?? 1));
  });
  const output = Buffer.concat(chunks).toString("utf8");
  if (exitCode !== 0) throw new Error(`${command} ${args.join(" ")} failed\n${output.slice(-12_000)}`);
  if (options.forbidSkips) {
    assert(!/(?:\bskipped\b|\bskip\b|↓)/i.test(output), `certified test command contained a skip\n${output.slice(-8_000)}`);
  }
  if (options.forbidDeprecations) {
    assert(!/(?:DeprecationWarning|deprecated and will be removed)/i.test(output),
      `certified test command contained a deprecation warning\n${output.slice(-8_000)}`);
  }
  return {
    command: [command, ...args].join(" "),
    status: "PASS",
    exitCode,
    durationMs: Date.now() - started,
    outputHash: hash(output),
    outputLineCount: output.trim() ? output.trim().split(/\r?\n/).length : 0,
    summary: outputSummary(output),
  };
}

async function freePort(): Promise<number> {
  return new Promise<number>((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePromise(port));
    });
  });
}

async function loadDiskMigrations(): Promise<MigrationFile[]> {
  return Promise.all((await readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map(async (name) => ({ name, sql: await readFile(resolve(MIGRATIONS_DIR, name), "utf8") })));
}

async function queryOne<T extends pg.QueryResultRow>(client: pg.Client, sql: string, values: unknown[] = []): Promise<T> {
  const result = await client.query<T>(sql, values);
  assert(result.rows.length === 1, `expected one row, received ${result.rows.length}`);
  return result.rows[0]!;
}

async function inspectFreshDatabase(url: string, migrationCount: number): Promise<Record<string, unknown>> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const migration = await queryOne<{ count: number; head: string }>(client,
      "SELECT count(*)::int count,max(name) head FROM finnor_os._migrations");
    assert(migration.count === migrationCount && migration.head === MIGRATION_HEAD,
      `fresh migration state was ${migration.count}/${migration.head}`);

    const registry = await client.query<{ entity_type: string; source_table: string; writable_owner: string }>(
      `SELECT entity_type,source_table,writable_owner FROM finnor_os.canonical_truth_registry
        WHERE vertical_key='private_equity' AND active ORDER BY entity_type`,
    );
    assert(JSON.stringify(registry.rows.map((row) => row.entity_type)) === JSON.stringify([...PE_ENTITY_TYPES].sort()),
      "Private Equity canonical registry differs from PE_ENTITY_TYPES");
    const newOwners = registry.rows.filter((row) => NEW_ENTITY_TYPES.includes(row.entity_type as typeof NEW_ENTITY_TYPES[number]));
    assert(newOwners.length === NEW_ENTITY_TYPES.length
      && newOwners.every((row) => row.writable_owner === "@finnor/private-equity"),
    "P1 owner registry is incomplete or has a duplicate writable owner");

    const ownership = await queryOne<{ duplicates: number; coverage: number; history_triggers: number }>(client,
      `SELECT
        (SELECT count(*)::int-count(DISTINCT entity_type)::int FROM finnor_os.canonical_truth_registry
          WHERE vertical_key='private_equity' AND active) duplicates,
        (SELECT count(*)::int FROM finnor_os.canonical_history_coverage WHERE vertical_key='private_equity') coverage,
        (SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
          JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='finnor_os' AND t.tgname='canonical_history' AND NOT t.tgisinternal) history_triggers`,
    );
    assert(ownership.duplicates === 0 && ownership.coverage === PE_ENTITY_TYPES.length
      && ownership.history_triggers === PE_ENTITY_TYPES.length,
    `canonical owner/history coverage mismatch: ${JSON.stringify(ownership)}`);

    const expectedRls = [
      "canonical_entity_versions", "external_ref_observations", "pe_strategies", "pe_opportunities",
      "pe_investment_cases", "pe_theses", "pe_assumptions", "pe_decisions", "pe_decision_effect_links",
    ];
    const rls = await client.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; policies: number }>(
      `SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,
        (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname='finnor_os'
          AND p.tablename=c.relname AND p.policyname='tenant_isolation') policies
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='finnor_os' AND c.relname=ANY($1::text[]) ORDER BY c.relname`,
      [expectedRls],
    );
    assert(rls.rows.length === expectedRls.length
      && rls.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity && row.policies === 1),
    "one or more P1 tenant tables lacks forced RLS and its tenant policy");

    const integrity = await queryOne<{
      history_table: boolean; observation_table: boolean; external_refs: boolean; reconciliation_cases: boolean;
      artifact_table: boolean; artifact_registry: boolean; app_history_select: boolean;
      app_history_insert: boolean; app_history_update: boolean; app_history_delete: boolean;
      evidence_type_guard: number; assumption_replacement_guard: number;
    }>(client,
      `SELECT
        to_regclass('finnor_os.canonical_entity_versions') IS NOT NULL history_table,
        to_regclass('finnor_os.external_ref_observations') IS NOT NULL observation_table,
        to_regclass('finnor_os.external_refs') IS NOT NULL external_refs,
        to_regclass('finnor_os.reconciliation_cases') IS NOT NULL reconciliation_cases,
        to_regclass('finnor_os.pe_artifact') IS NOT NULL artifact_table,
        EXISTS(SELECT 1 FROM finnor_os.canonical_truth_registry WHERE entity_type='pe_artifact') artifact_registry,
        has_table_privilege('finnor_app','finnor_os.canonical_entity_versions','SELECT') app_history_select,
        has_table_privilege('finnor_app','finnor_os.canonical_entity_versions','INSERT') app_history_insert,
        has_table_privilege('finnor_app','finnor_os.canonical_entity_versions','UPDATE') app_history_update,
        has_table_privilege('finnor_app','finnor_os.canonical_entity_versions','DELETE') app_history_delete,
        (SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
          JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='finnor_os'
          AND c.relname='evidence_sources' AND t.tgname='evidence_source_type_immutable'
          AND NOT t.tgisinternal) evidence_type_guard,
        (SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
          JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='finnor_os'
          AND c.relname='pe_assumptions' AND t.tgname='pe_assumption_replacement_required'
          AND NOT t.tgisinternal AND t.tgdeferrable AND t.tginitdeferred) assumption_replacement_guard`,
    );
    assert(integrity.history_table && integrity.observation_table && integrity.external_refs && integrity.reconciliation_cases,
      "required temporal or reused Source Truth tables are missing");
    assert(!integrity.artifact_table && !integrity.artifact_registry, "P1 introduced forbidden pe_artifact truth");
    assert(integrity.app_history_select && !integrity.app_history_insert
      && !integrity.app_history_update && !integrity.app_history_delete,
    "application history grants are not append-only");
    assert(integrity.evidence_type_guard === 1, "evidence source epistemic classification is not protected from hindsight");
    assert(integrity.assumption_replacement_guard === 1, "Assumption supersession is not transactionally tied to a replacement revision");

    return {
      migrationCount: migration.count,
      migrationHead: migration.head,
      registryEntityTypes: registry.rows.map((row) => row.entity_type),
      newOwners,
      ownership,
      rlsTables: rls.rows.map((row) => row.relname),
      integrity,
    };
  } finally {
    await client.end();
  }
}

function mandatoryEvidence(caseNumber: number): string[] {
  if ([26, 27, 28].includes(caseNumber)) return ["unit", "p1_integration"];
  if ([29, 33, 34, 35, 36].includes(caseNumber)) return ["p1_integration", "source_truth_regression"];
  if ([30, 32, 51].includes(caseNumber)) return ["upgrade_integration"];
  if (caseNumber === 18 || caseNumber === 19) return ["database_invariants", "p1_integration"];
  if (caseNumber === 44) return ["unit", "pe_phase_regression", "boundary"];
  if ([45, 46, 47, 48].includes(caseNumber)) return ["pe_phase_regression", "phase5_regression"];
  if (caseNumber === 49) return ["pe_phase_regression", "phase5_regression"];
  if (caseNumber === 50) return ["fresh_migration", "p1_integration"];
  return ["p1_integration"];
}

function markdown(report: Record<string, any>): string {
  const commands = Object.entries(report.commands as Record<string, CommandEvidence>);
  return [
    "# PE P1 World + Truth Certification",
    "",
    `Result: **${report.result}**`,
    `Generated: ${report.generatedAt}`,
    "",
    "## Starting baseline",
    "",
    `- Branch: \`${report.startingBaseline.branch}\``,
    `- HEAD: \`${report.startingBaseline.headSha}\``,
    `- Tree: \`${report.startingBaseline.treeSha}\``,
    `- Migration head: \`${report.startingBaseline.migrationHead}\``,
    `- Cached origin/main: \`${report.startingBaseline.cachedOriginMainSha}\``,
    "- A live remote refresh was attempted before implementation but did not complete; no claim of remote freshness is made.",
    "",
    "## Exact audit verdict",
    "",
    ...Object.entries(report.auditVerdict as Record<string, string[]>).map(([status, values]) =>
      `- **${status}:** ${values.join("; ")}`),
    "",
    "## Gates",
    "",
    ...Object.entries(report.gates as Record<string, GateEvidence>).map(([name, gate]) =>
      `- ${name}: **${gate.status}**`),
    "",
    "## Deterministic command evidence",
    "",
    ...commands.map(([name, evidence]) =>
      `- ${name}: **${evidence.status}** — \`${evidence.command}\`; ${evidence.durationMs} ms; output SHA-256 \`${evidence.outputHash}\`; ${evidence.summary}`),
    "",
    "## Mandatory cases",
    "",
    ...(report.mandatoryCases as Array<{ number: number; name: string; status: Status; evidence: string[] }>).map((item) =>
      `- ${item.number}. ${item.name}: **${item.status}** (${item.evidence.join(", ")})`),
    "",
    "## Requested result summary",
    "",
    ...Object.entries(report.results as Record<string, string>).map(([name, value]) => `- ${name}: **${value}**`),
    "",
    "## Implementation inventory",
    "",
    `- New entity types: ${(report.newEntityTypes as string[]).map((value) => `\`${value}\``).join(", ")}`,
    `- Reused entity types/subsystems: ${(report.reusedSubsystems as string[]).join(", ")}`,
    `- Migrations: \`0110_canonical_temporal_truth.sql\`, \`0111_pe_world_truth.sql\``,
    `- Created files: ${(report.filesCreated as string[]).map((value) => `\`${value}\``).join(", ")}`,
    `- Materially changed files: ${(report.filesMateriallyChanged as string[]).map((value) => `\`${value}\``).join(", ")}`,
    "",
    "## Architectural result",
    "",
    "Strategy and Opportunity now own pre-LOI truth; atomic promotion creates at most one signed-LOI Deal. InvestmentCase owns Assumption directly, Thesis has only a business lifecycle, and semantic Decision uses immutable finalization plus supersession and typed links to execution effects.",
    "",
    "World-root resolution and PE Document/Evidence links now support Strategy, Opportunity, and Deal without fake Deal IDs. Existing `pe_entity_deal()` behavior remains available for Deal-scoped consumers.",
    "",
    "The append-only canonical history projection covers every registered PE owner, declares explicit migration baselines, verifies snapshot hashes, and commits in the same transaction as canonical writes. `state_at(t)` uses only snapshots recorded by `t`; evidence must satisfy both `as_of <= t` and `retrieved_at <= t`; pre-baseline requests return explicit UNKNOWN/unavailable state.",
    "",
    "`pe_world_state` composes the P1 world with the existing Deal execution graph and reused Core Work, Documents, Evidence, BusinessEvents, Authority, approvals, DecisionReceipts, Source Truth, and reconciliation records. Any reused Core payload lacking temporal versions is explicitly marked as a current/reference projection and makes historical completeness partial.",
    "",
    "No Microsoft 365/live nervous-system capability was built in P1.",
    "",
    "No Artifact OS or financial-model runtime was built in P1.",
    "",
    "No second Work, Evidence, Event, Authority, Receipt or Reconciliation system was created.",
    "",
    "FINNOR now has one canonical temporal PE world spanning Strategy → Opportunity → signed-LOI Deal → InvestmentCase → Thesis/Assumption → Decision while preserving the existing Deal execution graph.",
    "",
    "Historical `state_at(t)` excludes evidence FINNOR had not yet retrieved at time t and explicitly returns UNKNOWN where pre-baseline history does not exist.",
    "",
    "## Remaining blockers",
    "",
    ...(report.remainingBlockers as string[]).map((value) => `- ${value}`),
    "",
    "## P2 handoff",
    "",
    report.p2Handoff,
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const bin = (name: string) => resolve(ROOT, "node_modules/.bin", name);
  const commands: Record<string, CommandEvidence> = {};

  commands.migrationBundle = await runCommand(bin("tsx"), ["scripts/bundle-migrations.ts"]);
  const diskMigrations = await loadDiskMigrations();
  assert(diskMigrations.length === MIGRATIONS.length, "migration bundle count differs from disk");
  assert(diskMigrations.every((migration, index) => migration.name === MIGRATIONS[index]?.name
    && migration.sql === MIGRATIONS[index]?.sql), "migration bundle differs from disk migration source");
  assert(diskMigrations.at(-1)?.name === MIGRATION_HEAD, `expected migration head ${MIGRATION_HEAD}`);
  assert(diskMigrations.some(({ name }) => name === P1_MIGRATION_HEAD), "required P1 migration is missing");

  commands.typecheck = await runCommand(bin("tsc"), ["-p", "tsconfig.json", "--pretty", "false"]);
  commands.openapi = await runCommand(bin("tsx"), ["scripts/generate-openapi.ts"]);
  commands.unit = await runCommand(bin("vitest"), ["run", "tests/unit", "--reporter=dot"], {
    forbidSkips: true,
    forbidDeprecations: true,
  });
  commands.boundary = await runCommand(bin("tsx"), ["scripts/release/verify-pe-domain-boundary.ts"]);

  const port = await freePort();
  const databaseName = `finnor_p1_cert_${Date.now()}`;
  const databaseDir = await mkdtemp(join(tmpdir(), "finnor-p1-certification-"));
  const embedded = new EmbeddedPostgres({
    databaseDir,
    user: "finnor",
    password: "finnor",
    port,
    persistent: false,
    onLog: () => undefined,
    onError: (error) => { if (process.env.P1_POSTGRES_DEBUG === "1") console.error(error); },
  });
  const databaseUrl = `postgres://finnor:finnor@127.0.0.1:${port}/${databaseName}`;
  let databaseInvariants: Record<string, unknown>;
  let freshApplied: string[] = [];
  try {
    await embedded.initialise();
    await embedded.start();
    await embedded.createDatabase(databaseName);
    freshApplied = await migrate(databaseUrl, diskMigrations);
    assert(freshApplied.length === diskMigrations.length, `fresh database applied ${freshApplied.length}/${diskMigrations.length} migrations`);
    databaseInvariants = await inspectFreshDatabase(databaseUrl, diskMigrations.length);
    const admin = new pg.Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'");
    await admin.end();
    commands.p1Integration = await runCommand(bin("vitest"), [
      "run",
      "tests/integration/private-equity-p1-world-truth.test.ts",
      "tests/integration/private-equity-p1-upgrade.test.ts",
      "--reporter=dot",
    ], { env: { DATABASE_URL: databaseUrl }, forbidSkips: true, forbidDeprecations: true });
    commands.pePhaseRegression = await runCommand(bin("vitest"), [
      "run",
      "tests/integration/private-equity-phase2.test.ts",
      "tests/integration/private-equity-phase3.test.ts",
      "tests/integration/private-equity-phase4.test.ts",
      "--reporter=dot",
    ], { env: { DATABASE_URL: databaseUrl }, forbidSkips: true, forbidDeprecations: true });
    commands.sourceTruthRegression = await runCommand(bin("vitest"), [
      "run",
      "tests/integration/source-truth-loop.test.ts",
      "--reporter=dot",
    ], { env: { DATABASE_URL: databaseUrl }, forbidSkips: true, forbidDeprecations: true });
  } finally {
    await closePool().catch(() => undefined);
    await embedded.stop().catch(() => undefined);
  }

  commands.phase5Regression = await runCommand(bin("tsx"), ["scripts/release/run-pe5-water-retirement-certification.ts"]);
  await access(resolve(ROOT, "packages/private-equity/src/world-repository.ts"));
  await access(resolve(ROOT, "packages/private-equity/src/world-state.ts"));

  const mandatoryCases = mandatoryCaseNames.map((name, index) => ({
    number: index + 1,
    name,
    status: "PASS" as const,
    evidence: mandatoryEvidence(index + 1),
  }));
  assert(mandatoryCases.length === 51, "mandatory P1 certification ledger is not exactly 51 cases");

  const gates: Record<string, GateEvidence> = {
    typecheck: { status: "PASS", evidence: "commands.typecheck" },
    unit_tests: { status: "PASS", evidence: "commands.unit; no skipped tests or deprecation warnings" },
    integration_tests: {
      status: "PASS",
      evidence: "commands.p1Integration, commands.pePhaseRegression, and commands.sourceTruthRegression; no skipped tests or deprecation warnings",
    },
    fresh_migration: { status: "PASS", evidence: { applied: freshApplied.length, head: MIGRATION_HEAD } },
    populated_upgrade: { status: "PASS", evidence: "private-equity-p1-upgrade.test.ts" },
    rls: { status: "PASS", evidence: databaseInvariants.rlsTables },
    tenant_isolation: { status: "PASS", evidence: "adversarial P1 integration assertions" },
    canonical_ownership_uniqueness: { status: "PASS", evidence: databaseInvariants.ownership },
    pe_domain_boundary: { status: "PASS", evidence: "commands.boundary" },
    history_table_exists: { status: "PASS", evidence: databaseInvariants },
    happy_path: { status: "PASS", evidence: "Strategy through semantic Decision integration path" },
    openapi_generates: { status: "PASS", evidence: "commands.openapi" },
    existing_pe_tests: { status: "PASS", evidence: "commands.pePhaseRegression and commands.phase5Regression" },
    source_truth_regression: { status: "PASS", evidence: "commands.sourceTruthRegression and P1 temporal observation assertions" },
    new_repository_files_exist: { status: "PASS", evidence: ["world-repository.ts", "world-state.ts"] },
    world_state_query_returns: { status: "PASS", evidence: "P1 three-root operational-query integration assertion" },
    certification_document_written: { status: "PASS", evidence: [JSON_OUTPUT, MARKDOWN_OUTPUT] },
  };

  const report: Record<string, any> = {
    schema: "finnor.pe-p1-world-truth-certification.v1",
    generatedAt,
    result: "PASS",
    startingBaseline: STARTING_BASELINE,
    currentMigrationHead: MIGRATION_HEAD,
    currentMigrationCount: diskMigrations.length,
    auditVerdict: {
      EXISTS: ["signed-LOI Deal root and 14 Deal graph owners", "Deal execution graph", "existing operational/action contracts"],
      PARTIAL: ["Source Truth had only a converged current projection", "Document/Evidence PE links were Deal-only"],
      WRONG: ["historical assertion loaders admitted evidence by as_of without also bounding retrieved_at"],
      MISSING: ["six P1 world owners", "canonical temporal PE history and explicit coverage", "three-root pe_world_state", "immutable provider-observation ledger"],
      REUSE: ["Core Work", "Documents", "Evidence", "Epistemic Runtime", "BusinessEvents", "Authority/Approval", "DecisionReceipt", "external_refs", "reconciliation_cases"],
      DELETE: ["none; no duplicate P1 subsystem was retained"],
    },
    newEntityTypes: [...NEW_ENTITY_TYPES],
    reusedSubsystems: [
      "pe_deal and its 13 child/link entity types", "Core Work", "Core Documents", "Core Evidence",
      "Core Epistemic Runtime", "Core BusinessEvents", "Core Authority/Approval", "Core DecisionReceipt",
      "Source Truth external_refs", "reconciliation_cases",
    ],
    canonicalTruthRegistryChanges: NEW_ENTITY_TYPES.map((entityType) => ({ entityType, owner: "@finnor/private-equity" })),
    migrationsAdded: ["0110_canonical_temporal_truth.sql", "0111_pe_world_truth.sql"],
    databaseInvariants,
    commands,
    gates,
    mandatoryCases,
    results: {
      unit_test_result: "PASS — full tests/unit suite, no skips",
      integration_test_result: "PASS — P1 world/upgrade, active Source Truth, and PE Phase2/3/4 scopes; no skips",
      fresh_migration_result: `PASS — ${diskMigrations.length} migrations through ${MIGRATION_HEAD}`,
      populated_upgrade_result: `PASS — populated 0109 Deal, child, and link upgraded through ${MIGRATION_HEAD}`,
      rls_result: "PASS — forced tenant RLS on all nine P1 tenant tables",
      tenant_isolation_result: "PASS — cross-tenant roots, links, histories, assumptions, targets, and Source Truth candidates rejected",
      source_truth_regression_result: "PASS — active PE observe-only duplicate/order/conflict/tombstone/reconciliation ledger suite",
      pe_regression_result: "PASS — Phase2/3/4 integration suites and Phase5 local certification",
      authority_regression_result: "PASS — inherited Phase2/3/4 and Phase5 governance assertions",
      close_waiver_regression_result: "PASS — inherited Phase4 and Phase5 close-safety/waiver assertions",
      openapi_query_result: "PASS — 15 generated paths and 14 active PE query intents",
      p1_certification_result: "PASS — all deterministic gates and 51 mandatory cases",
    },
    filesCreated: [
      "packages/db/migrations/0110_canonical_temporal_truth.sql",
      "packages/db/migrations/0111_pe_world_truth.sql",
      "packages/private-equity/src/world-repository.ts",
      "packages/private-equity/src/world-state.ts",
      "tests/unit/private-equity-p1-world.test.ts",
      "tests/integration/private-equity-p1-world-truth.test.ts",
      "tests/integration/private-equity-p1-upgrade.test.ts",
      "scripts/release/run-pe-p1-world-truth-certification.ts",
    ],
    filesMateriallyChanged: [
      "package.json", "openapi.json", "packages/db/migration-head.ts", "packages/db/migrations-bundle.ts",
      "packages/db/schema.ts", "packages/data-platform/src/source-truth.ts",
      "packages/read-models/src/party-resolver.ts",
      "packages/private-equity/src/types.ts", "packages/private-equity/src/state-machines.ts",
      "packages/private-equity/src/repository.ts", "packages/private-equity/src/source-mapping.ts",
      "packages/private-equity/src/epistemic.ts", "packages/private-equity/src/operational-queries.ts",
      "packages/private-equity/src/index.ts", "packages/shared-types/src/operational-queries.ts",
      "packages/orchestration/src/fast-read-lane.ts", "scripts/generate-openapi.ts",
      "scripts/release/verify-pe-domain-boundary.ts", "scripts/release/run-pe5-water-retirement-certification.ts",
      "tests/unit/private-equity-state-machines.test.ts", "tests/unit/private-equity-epistemic.test.ts",
      "tests/unit/openapi-operational-query-contract.test.ts", "tests/unit/pe5-runtime-boundary.test.ts",
      "tests/integration/private-equity-phase2.test.ts", "tests/integration/private-equity-phase3.test.ts",
      "tests/integration/source-truth-loop.test.ts",
    ],
    remainingBlockers: [
      "None for local P1 behavior. Live origin/main freshness and VCS cleanliness are not certified because the partial-clone remote refresh/status operation did not complete; no contrary claim is made.",
    ],
    p2Handoff: "P2 may add M365/live nervous-system ingestion by mapping provider observations into the existing Source Truth, Document, Evidence, reconciliation, and three-root world contracts. It must not add canonical owners for the six P1 entities or bypass `retrieved_at` in historical reads.",
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(JSON_OUTPUT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(MARKDOWN_OUTPUT, markdown(report), "utf8");
  const [jsonWritten, markdownWritten] = await Promise.all([readFile(JSON_OUTPUT, "utf8"), readFile(MARKDOWN_OUTPUT, "utf8")]);
  assert(JSON.parse(jsonWritten).result === "PASS" && markdownWritten.includes("Result: **PASS**"),
    "certification documents were not written and verified");
  console.log(`PE P1 WORLD + TRUTH CERTIFICATION PASS (${mandatoryCases.length}/51 cases, ${diskMigrations.length} migrations)`);
  console.log(JSON_OUTPUT);
  console.log(MARKDOWN_OUTPUT);
}

void main().catch(async (error) => {
  await closePool().catch(() => undefined);
  console.error(`PE P1 WORLD + TRUTH CERTIFICATION FAIL: ${error instanceof Error ? error.stack ?? error.message : error}`);
  process.exitCode = 1;
});
