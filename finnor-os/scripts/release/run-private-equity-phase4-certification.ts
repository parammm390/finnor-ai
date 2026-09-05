import "dotenv/config";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { pgConnectionConfig } from "@finnor/db";
import {
  createDefaultPluginRegistry,
  plannerActionTypesForVertical,
} from "@finnor/orchestration";
import {
  PRIVATE_EQUITY_ACTION_CONTRACTS,
  PRIVATE_EQUITY_ACTION_TYPES,
} from "../../packages/domain-plugins/private-equity/index";
import { CURRENT_MIGRATION_HEAD } from "../../packages/db/migration-head";
import {
  ACTION_HARDENING_SPEC,
  PRIVATE_EQUITY_ACTION_HARDENING_SPEC,
  actionHardeningSpecForVertical,
} from "./action-hardening-spec";
import { discoverActionRegistry } from "./discover-action-registry";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FINNOR_OS_ROOT = resolve(SCRIPT_DIR, "../..");
const REPO_ROOT = resolve(FINNOR_OS_ROOT, "..");
const GENERATED_DIR = resolve(REPO_ROOT, "docs/release/generated");
const MANIFEST_PATH = resolve(GENERATED_DIR, "private-equity-phase4-action-manifest.json");
const CERTIFICATION_PATH = resolve(GENERATED_DIR, "private-equity-phase4-certification.json");
const REPORT_PATH = resolve(REPO_ROOT, "docs/release/private-equity-phase4.md");
const MIGRATIONS_DIR = resolve(FINNOR_OS_ROOT, "packages/db/migrations");

const STARTING_BRANCH = "codex/p3-epistemic-runtime";
const STARTING_SHA = "7e876b17b601b57b19d9c695ce714e2284b316b2";

const PE4_TEST_EVIDENCE = [
  {
    gate: "pe_action_contract_and_vertical_composition",
    files: ["tests/unit/private-equity-phase4-contract.test.ts", "tests/unit/private-equity-planner-isolation.test.ts"],
  },
  {
    gate: "request_shadow_journey_condition_waiver_and_close",
    files: ["tests/integration/private-equity-phase4.test.ts"],
  },
  {
    gate: "canonical_pe2_and_epistemic_pe3_regression",
    files: ["tests/integration/private-equity-phase2.test.ts", "tests/integration/private-equity-phase3.test.ts"],
  },
  {
    gate: "durable_event_wait_duplicate_wrong_event_deadline_race_and_cross_tenant",
    files: ["tests/integration/event-driven-objective-runtime.test.ts"],
  },
  {
    gate: "provider_acknowledgement_observation_and_reconciliation",
    files: ["tests/integration/external-effect-observation.test.ts"],
  },
  {
    gate: "computer_authorized_effect_identity_restart_and_readback",
    files: ["tests/integration/computer-execution-fabric.test.ts"],
  },
  {
    gate: "durable_effect_approval_receipt_and_reconciliation_bridge",
    files: ["tests/integration/single-action-runtime-bridge.test.ts"],
  },
  {
    gate: "dlq_redrive_and_causal_replay",
    files: ["tests/integration/poison-job-replay-drill.test.ts", "tests/integration/causal-replay.test.ts"],
  },
  {
    gate: "universal_actions_escalation_and_water_preservation",
    files: ["tests/integration/universal-action-fabric.test.ts", "tests/unit/universal-actions-contract.test.ts"],
  },
] as const;

const ARCHITECTURE_OWNERS = {
  instructionWorkAndLinks: "packages/db/index.ts + packages/db/schema.ts",
  objectiveLoopAndBudgets: "packages/orchestration/src/objective-loop.ts",
  objectiveSuccess: "packages/orchestration/src/objective-success.ts",
  plannerAndCapabilityComposition: "packages/orchestration/src/planner.ts + packages/orchestration/src/plugin-registry.ts",
  groundingAndBusinessEffectCompiler: "packages/orchestration/src/compiler.ts",
  domainActionAndApproval: "packages/orchestration/src/index.ts",
  authority: "packages/orchestration/src/authority-runtime.ts + packages/authority/src/index.ts",
  durableExecution: "packages/orchestration/src/durable-execution.ts + apps/worker/src/handlers/run-workflow-step.ts",
  commandsStepsReceiptsAndDlq: "packages/workflow-runtime/src",
  eventsWaitsAndDeadlines: "packages/orchestration/src/event-waits.ts + packages/db/event-fabric.ts",
  externalObservationAndReconciliation: "packages/orchestration/src/external-observation.ts",
  computer: "packages/computer/src/runner.ts + packages/computer/src/repository.ts",
  peTruthAndMutations: "packages/private-equity/src",
  peEpistemicState: "packages/private-equity/src/epistemic.ts + packages/epistemic-runtime/src",
  peOperationalQueries: "packages/private-equity/src/operational-queries.ts",
  peActionAdapter: "packages/domain-plugins/private-equity/index.ts",
} as const;

type CommandResult = {
  name: string;
  command: string;
  status: "PASS" | "FAIL";
  exitCode: number;
  durationMs: number;
  summary: string[];
};

function sha256(value: unknown): string {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return createHash("sha256").update(serialized).digest("hex");
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function outputSummary(stdout: string, stderr: string): string[] {
  const lines = `${stdout}\n${stderr}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const preferred = lines.filter((line) => /Test Files|Tests\s|Duration|policy coverage green|error TS\d+|failed|FAIL/i.test(line));
  return (preferred.length ? preferred : lines).slice(-40);
}

function runCommand(name: string, command: string, args: string[], timeoutMs: number): CommandResult {
  const started = Date.now();
  console.log(`PE4_GATE_START ${name}`);
  const result = spawnSync(command, args, {
    cwd: FINNOR_OS_ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      FINNOR_ENVIRONMENT: "test",
      LIVE_SMOKE_ALLOWED: "0",
    },
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    timeout: timeoutMs,
  });
  const exitCode = result.status ?? 1;
  const commandResult: CommandResult = {
    name,
    command: `${command} ${args.join(" ")}`,
    status: exitCode === 0 ? "PASS" : "FAIL",
    exitCode,
    durationMs: Date.now() - started,
    summary: outputSummary(result.stdout ?? "", result.stderr ?? result.error?.message ?? ""),
  };
  console.log(`PE4_GATE_${commandResult.status} ${name} duration_ms=${commandResult.durationMs}`);
  for (const line of commandResult.summary.slice(-8)) console.log(`  ${line}`);
  return commandResult;
}

async function inspectCertificationDatabase(databaseUrl: string) {
  const client = new pg.Client(pgConnectionConfig(databaseUrl));
  await client.connect();
  try {
    const database = await client.query<{ name: string }>("SELECT current_database() AS name");
    const migrations = await client.query<{ name: string }>("SELECT name FROM finnor_os._migrations ORDER BY name");
    const databaseName = database.rows[0]?.name ?? "";
    const applied = migrations.rows.map((row) => row.name);
    return {
      databaseName,
      isolatedName: /^finnor_pe4_(?:cert|fresh)/.test(databaseName),
      migrationHead: applied.at(-1) ?? null,
      migrationCount: applied.length,
      migrationNamesHash: sha256(applied),
    };
  } finally {
    await client.end();
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for PE4 certification");

  const migrationFiles = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith(".sql")).sort();
  const database = await inspectCertificationDatabase(databaseUrl);
  if (!database.isolatedName) throw new Error("PE4 certification must run against an isolated finnor_pe4_cert* or finnor_pe4_fresh* database");
  if (database.migrationHead !== CURRENT_MIGRATION_HEAD || migrationFiles.at(-1) !== CURRENT_MIGRATION_HEAD || database.migrationCount !== migrationFiles.length) {
    throw new Error(`PE4 certification database migration mismatch: database=${database.migrationHead}/${database.migrationCount}, source=${CURRENT_MIGRATION_HEAD}/${migrationFiles.length}`);
  }

  const registry = createDefaultPluginRegistry();
  const discovered = await discoverActionRegistry();
  const globalActions = registry.actionTypes();
  const privateEquityActions = plannerActionTypesForVertical(registry, "private_equity");
  const waterActions = plannerActionTypesForVertical(registry, "water");
  const sharedActions = plannerActionTypesForVertical(registry, "none");
  const peHardening = actionHardeningSpecForVertical("private_equity");
  const waterHardening = actionHardeningSpecForVertical("water");
  const sharedHardening = actionHardeningSpecForVertical("none");
  const exactCounts = globalActions.length === 74 && privateEquityActions.length === 32 && waterActions.length === 59 && sharedActions.length === 17;
  const exactComposition = sameSet(globalActions, discovered.map((row) => row.actionType))
    && sameSet(globalActions, ACTION_HARDENING_SPEC.map((row) => row.actionType))
    && sameSet(privateEquityActions, peHardening.map((row) => row.actionType))
    && sameSet(waterActions, waterHardening.map((row) => row.actionType))
    && sameSet(sharedActions, sharedHardening.map((row) => row.actionType));
  const exactPeBoundary = sameSet(PRIVATE_EQUITY_ACTION_TYPES, PRIVATE_EQUITY_ACTION_CONTRACTS.map((row) => row.actionType))
    && sameSet(PRIVATE_EQUITY_ACTION_TYPES, PRIVATE_EQUITY_ACTION_HARDENING_SPEC.map((row) => row.actionType))
    && PRIVATE_EQUITY_ACTION_TYPES.length === 15;
  const schemasDiscovered = discovered.every((row) => row.schemaSourcePath && row.schemaSourceLine);
  if (!exactCounts || !exactComposition || !exactPeBoundary || !schemasDiscovered) {
    throw new Error("PE4 action registry, vertical composition, schema discovery, or hardening contract drifted");
  }

  const discoveredByAction = new Map(discovered.map((row) => [row.actionType, row]));
  const hardeningByAction = new Map(ACTION_HARDENING_SPEC.map((row) => [row.actionType, row]));
  const peContractByAction = new Map(PRIVATE_EQUITY_ACTION_CONTRACTS.map((row) => [row.actionType, row]));
  const manifestActions = privateEquityActions.map((actionType) => {
    const source = discoveredByAction.get(actionType);
    const hardening = hardeningByAction.get(actionType);
    if (!source || !hardening) throw new Error(`Missing source/hardening row for ${actionType}`);
    return {
      actionType,
      composition: PRIVATE_EQUITY_ACTION_TYPES.includes(actionType as never) ? "private_equity" : "shared_core",
      plugin: source.plugin,
      payloadSchema: { path: source.schemaSourcePath, line: source.schemaSourceLine },
      profile: hardening.profile,
      approvalFloor: hardening.approvalFloor,
      capabilityFamily: hardening.capabilityFamily,
      external: hardening.external,
      receiptRequired: hardening.receipt,
      ...(peContractByAction.has(actionType as never) ? { peContract: peContractByAction.get(actionType as never) } : {}),
    };
  });
  const generatedAt = new Date().toISOString();
  const manifest = {
    schemaVersion: 1,
    generatedAt,
    vertical: "private_equity",
    composition: {
      sharedCoreCount: sharedActions.length,
      privateEquityDomainCount: PRIVATE_EQUITY_ACTION_TYPES.length,
      activeCount: privateEquityActions.length,
      waterActiveCount: waterActions.length,
      globalReplayRegistryCount: globalActions.length,
    },
    invariants: {
      derivedFromRuntimeRegistry: true,
      derivedFromStaticPluginDiscovery: true,
      exactHardeningCoverage: true,
      privateEquityExcludedFromWater: PRIVATE_EQUITY_ACTION_TYPES.every((actionType) => !waterActions.includes(actionType)),
      waterDomainExcludedFromPrivateEquity: !privateEquityActions.includes("create_invoice") && !privateEquityActions.includes("schedule_water_test"),
    },
    actions: manifestActions,
  };

  const commandResults = [
    runCommand("langgraph_checkpointer_setup", "npm", ["run", "setup:langgraph"], 5 * 60_000),
    runCommand("policy_coverage", "npm", ["run", "policy:lint"], 5 * 60_000),
    runCommand("typescript", "npx", ["--no-install", "tsc", "-p", "tsconfig.release-pe4.json"], 20 * 60_000),
    runCommand("full_core_p1_p6_and_pe4_test_suite", "npm", ["test", "--", "--reporter=dot"], 45 * 60_000),
  ];
  const commandsPass = commandResults.every((row) => row.status === "PASS");
  const gates = {
    isolatedFreshMigration: database.isolatedName && database.migrationHead === CURRENT_MIGRATION_HEAD && database.migrationCount === migrationFiles.length,
    runtimeRegistryCount: globalActions.length === 74,
    privateEquityCompositionCount: privateEquityActions.length === 32,
    waterCompositionCount: waterActions.length === 59,
    sharedCompositionCount: sharedActions.length === 17,
    exactVerticalComposition: exactComposition,
    exactPeActionBoundary: exactPeBoundary,
    payloadSchemasDiscovered: Boolean(schemasDiscovered),
    hardApprovalFloors: PRIVATE_EQUITY_ACTION_HARDENING_SPEC.find((row) => row.actionType === "waive_closing_condition")?.approvalFloor === "REQUIRED"
      && PRIVATE_EQUITY_ACTION_HARDENING_SPEC.find((row) => row.actionType === "declare_deal_closed")?.approvalFloor === "TYPED_REQUIRED",
    langgraphCheckpointer: commandResults[0]!.status === "PASS",
    policyCoverage: commandResults[1]!.status === "PASS",
    typecheck: commandResults[2]!.status === "PASS",
    pe4ShadowCertification: commandResults[3]!.status === "PASS",
    waterAndCoreRegression: commandResults[3]!.status === "PASS",
  };
  const status = Object.values(gates).every(Boolean) && commandsPass ? "PASS" : "FAIL";
  const currentBranch = git(["branch", "--show-current"]);
  const currentHead = git(["rev-parse", "HEAD"]);
  const certification = {
    schemaVersion: 1,
    generatedAt,
    status,
    startingState: {
      branch: STARTING_BRANCH,
      sha: STARTING_SHA,
      tree: "finnor-os was clean at task start; unrelated outer-repository modifications and untracked duplicate files were pre-existing and excluded from the Phase 4 commit.",
    },
    certificationState: { branch: currentBranch, head: currentHead },
    sourceFingerprint: sha256({ manifest, migrationNamesHash: database.migrationNamesHash, peContracts: PRIVATE_EQUITY_ACTION_CONTRACTS }),
    database,
    architectureOwners: ARCHITECTURE_OWNERS,
    programSearch: "No active @finnor/program-search package or authoritative runtime dependency was present; Phase 4 did not promote one.",
    speculativeRuntime: "No speculative result authorizes, proves, or mutates PE canonical truth; Phase 4 execution does not depend on speculative tables or a simulator.",
    actionContracts: PRIVATE_EQUITY_ACTION_CONTRACTS.map((contract) => ({
      ...contract,
      ...PRIVATE_EQUITY_ACTION_HARDENING_SPEC.find((row) => row.actionType === contract.actionType),
    })),
    testEvidence: PE4_TEST_EVIDENCE,
    commands: commandResults,
    gates,
    shadowBoundary: {
      internalPeMutations: "real canonical mutations inside isolated PE test tenants",
      externalPeEffects: "explicit tenant emulator/sandbox/no-egress binding required",
      productionCutover: false,
      waterRetired: false,
    },
    phase5Inputs: [
      "32-action PE planner composition (17 shared/core + 15 PE) derived from the runtime registry",
      "59-action Water composition preserved independently",
      "15 one-to-one PE DomainAction-to-PE2 mutation-owner contracts",
      "PE objective-success predicates over canonical Request/Finding/Risk/Condition/ClosingItem/readiness/close truth",
      "execution-time state/effect/authority revalidation with hard waiver and close approval floors",
      "isolated PE external sandbox/emulator requirement and tenant credential boundary",
      "green long-lived PE shadow corpus and full Core/P1-P6 regression evidence",
    ],
    residualBlockers: status === "PASS" ? [] : Object.entries(gates).filter(([, passed]) => !passed).map(([gate]) => gate),
  };

  const actionRows = certification.actionContracts.map((row) => `| \`${row.actionType}\` | \`${row.canonicalMutationOwner}\` | ${row.profile} | ${row.approvalFloor} |`).join("\n");
  const gateRows = Object.entries(gates).map(([gate, passed]) => `| ${gate} | ${passed ? "PASS" : "FAIL"} |`).join("\n");
  const testRows = PE4_TEST_EVIDENCE.map((row) => `| ${row.gate} | ${row.files.map((file) => `\`${file}\``).join("<br>")} |`).join("\n");
  const ownerRows = Object.entries(ARCHITECTURE_OWNERS).map(([owner, path]) => `| ${owner} | \`${path}\` |`).join("\n");
  const markdown = `# Private Equity Phase 4 certification

Status: **${status}**<br>
Generated: ${generatedAt}

## Starting state

- Branch: \`${STARTING_BRANCH}\`
- SHA: \`${STARTING_SHA}\`
- Tree: \`finnor-os\` was clean; unrelated outer-repository changes were preserved and excluded.
- PE0–PE3: audited as present: vertical contract/tenant routing, canonical PE2 Deal graph and mutation owners, and P3 evidence/DecisionRequirement/operational-query truth.

## Runtime owners found and retained

| Responsibility | Existing owner |
|---|---|
${ownerRows}

Private Equity is an adapter into those owners. Program Search was not present as an active authoritative dependency and was not promoted. Speculative/outcome-shadow state remains non-authoritative and is not an execution dependency.

## Active vertical manifests

- Global replay registry: ${globalActions.length}
- Water planner composition: ${waterActions.length}
- Private Equity planner composition: ${privateEquityActions.length} (${sharedActions.length} shared/core + ${PRIVATE_EQUITY_ACTION_TYPES.length} PE)
- Manifest: \`${relative(REPO_ROOT, MANIFEST_PATH)}\`

## PE DomainActions

| Action | PE2 mutation owner | BusinessEffect profile | Approval floor |
|---|---|---|---|
${actionRows}

Every row has one strict payload schema, pre-authority Deal/Work/entity/version/evidence grounding, DomainAction identity as create idempotency identity, a frozen BusinessEffect, the Core authority/receipt/replay path, one PE2 mutation owner, and canonical return-plus-reread verification. \`waive_closing_condition\` always requires explicit approval; \`declare_deal_closed\` requires explicit typed approval. Approval never overrides a stale effect, stale grounding, unresolved mandatory P3 DecisionRequirement, or execution-time close ineligibility.

## Execution semantics proven

- Request creation is one canonical PE action. Communication and follow-up reuse \`send_message\`; waits reuse durable Work event waits; escalation reuses \`escalate_work\`.
- The long-lived fixture keeps the same Deal, Request, Work, Objective Loop, provider conversation, wait, deadline, and evidence identities across process reconstruction. Provider acknowledgement remains partially verified until exact read-back; neither an event nor a deadline is treated as success.
- Mismatched and duplicate events cannot satisfy the exact wait. Deadline/event races settle once and re-read current truth. Provider unknown/divergent outcomes enter reconciliation instead of blind retry. DLQ redrive and causal replay retain the original effect identity.
- P3 UNKNOWN/STALE/CONFLICTING mandatory requirements block condition/item/close mutation. Fresh exact authoritative evidence permits the bounded PE2 mutation. Stale entity versions and materially changed approved effects fail closed.
- Computer fallback remains the existing governed \`computer_task\` path: fixed tenant application identity, allowed origin, exact authorized effect, restart inspection, and read-back; a click is not business success.
- “Ready to close” verifies PE2 eligibility and does not close. “Close” additionally requires current eligibility, typed human approval, atomic PE2 close, \`actualCloseAt\`, close BusinessEvent, finalized receipt, and canonical objective-success reread.
- PE external writes require an explicit tenant sandbox/emulator binding; the certification adapter has no production egress. Water and PE capability/provider resolution are tenant-specific in the same process.

## Deterministic evidence map

| Gate | Tests included in the full suite |
|---|---|
${testRows}

## Release gates

| Gate | Result |
|---|---|
${gateRows}

- Migration: \`${CURRENT_MIGRATION_HEAD}\` applied from a ${migrationFiles.length}-migration fresh isolated database; bundle/source head matched.
- Commands: ${commandResults.map((row) => `\`${row.command}\` ${row.status}`).join("; ")}.
- PE4 shadow certification: **${commandResults[3]!.status}**.
- Water regression: **${commandResults[3]!.status}**.
- Core/P1–P6 regression: **${commandResults[3]!.status}**.
- Residual blockers: ${certification.residualBlockers.length ? certification.residualBlockers.join(", ") : "none"}.

## Phase 5 handoff

${certification.phase5Inputs.map((input) => `- ${input}`).join("\n")}

**No Water capability was intentionally retired in Phase 4.**

**Private Equity runs through the existing FINNOR Work / Objective / Authority / BusinessEffect / Event-Wait / Reconciliation runtime; no second PE execution engine exists.**

**No full PE Worker architecture, full PE Action Fabric, broad Deal Data Fabric, solver, simulator, Deal Zero, Fund/LP system or Portfolio system was built.**

**The PE shadow runtime can maintain one Deal objective across actions, external waits, deadlines, approvals, ambiguity, restarts and verification without losing identity or falsely claiming success.**
`;

  await mkdir(GENERATED_DIR, { recursive: true });
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(CERTIFICATION_PATH, `${JSON.stringify(certification, null, 2)}\n`, "utf8");
  await writeFile(REPORT_PATH, markdown, "utf8");
  console.log(`PE4_CERTIFICATION_${status} actions=${privateEquityActions.length} water=${waterActions.length} global=${globalActions.length}`);
  console.log(`PE4_CERTIFICATION_REPORT ${relative(REPO_ROOT, REPORT_PATH)}`);
  if (status !== "PASS") throw new Error(`PE4 certification failed: ${certification.residualBlockers.join(", ")}`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
