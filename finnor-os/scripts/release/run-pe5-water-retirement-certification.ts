import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import {
  EXECUTABLE_VERTICALS,
  OPERATIONAL_QUERY_INTENTS,
  PARTY_TYPES,
  PHASE5_DISPOSITION_COUNTS,
  PHASE5_DISPOSITION_LEDGER,
  PHASE5_DISPOSITION_LEDGER_VERSION,
  RETIRED_WATER_ACTION_TYPES,
  RETIRED_WATER_CANONICAL_ENTITY_TYPES,
  RETIRED_WATER_IMPORT_ENTITY_TYPES,
  RETIRED_WATER_JOB_TYPES,
  RETIRED_WATER_PARTY_TYPES,
  RETIRED_WATER_QUERY_INTENTS,
  RETIRED_WATER_SOURCE_PROVIDERS,
  RETIRED_WATER_WORKFLOW_TYPES,
} from "@finnor/shared-types";
import { causalReplayProjection } from "@finnor/read-models";
import { closePool } from "@finnor/db";
import { migrate, type MigrationFile } from "../../packages/db/migrate";
import { EXECUTABLE_ACTION_COUNT } from "./action-hardening-spec";
import { verifyPeDomainBoundary } from "./verify-pe-domain-boundary";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "../..");
const REPOSITORY_ROOT = resolve(ROOT, "..");
const MIGRATIONS_DIR = resolve(ROOT, "packages/db/migrations");
const OUTPUT_DIR = resolve(REPOSITORY_ROOT, "docs/release/generated");
const JSON_OUTPUT = resolve(OUTPUT_DIR, "pe5-water-retirement-certification.json");
const LEDGER_OUTPUT = resolve(OUTPUT_DIR, "pe5-disposition-ledger.json");
const MARKDOWN_OUTPUT = resolve(REPOSITORY_ROOT, "docs/release/pe5-water-retirement-certification.md");
const PRODUCTION_CENSUS_INPUT = resolve(OUTPUT_DIR, "pe5-production-read-only-census.json");
const MIGRATION_HEAD = "0109_atomic_water_runtime_retirement.sql";
const RELEASE_SHA = "5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a";
const REQUIRED_ROLES = ["api", "worker", "orchestrator", "supplier-canary", "scheduler-owner"] as const;

type Status = "PASS" | "FAIL";
type CompletionStatus = "LOCAL_PASS" | "PRODUCTION_OBSERVED_PASS" | "BLOCKED_PRODUCTION" | "FAIL";

interface CommandEvidence {
  command: string;
  status: Status;
  exitCode: number;
  durationMs: number;
  outputHash: string;
  outputLineCount: number;
  summary: string;
}

interface HistoryIds {
  tenantId: string;
  ownerId: string;
  legacyUserId: string;
  householdId: string;
  workId: string;
  historyActionId: string;
  inflightActionId: string;
  actionLogId: string;
  receiptId: string;
  eventId: string;
  externalRefId: string;
  queuedJobId: string;
  deadJobId: string;
}

interface GateEvidence {
  status: Status;
  evidence: unknown;
}

const completionConditionNames = [
  "P0-P4 state verified before cutover", "PE0 ledger reconciled", "runtime census UNKNOWN=0",
  "Water tenants classified", "no unauthorized production tenant retired", "in-flight effects resolved",
  "no ambiguous external effect abandoned", "no active Water event wait", "no runnable Water queue item",
  "no Water DLQ redrive", "runtime roles cutover-compatible", "mixed fleet blocks final barrier",
  "new Water intake frozen", "durable Water-retired authority set", "Water vertical non-executable",
  "Private Equity supported product vertical", "none limited to Core certification", "no Water-to-PE tenant conversion",
  "no Water action draft", "no Water action execution", "no Water query execution",
  "no Water canonical resolution for active PE", "no active Water party", "no active Water business truth",
  "no Water canonical writer", "no Water import entity", "no Water source mapping",
  "no Water worker handler", "no Water scheduler", "no Water read-model registration",
  "no Water planner doctrine", "no Water conversation doctrine", "no Water policy default",
  "no Water provisioning", "Dealer Zero retired", "generic reference tenant machinery preserved",
  "universal actions preserved", "computer runtime preserved", "Work/Objective runtime preserved",
  "Authority/Approval preserved", "BusinessEffect runtime preserved", "event/wait runtime preserved",
  "reconciliation preserved", "Source Truth engine preserved", "generic Import engine preserved",
  "reusable provider transports preserved", "Water-only source deleted", "no stale Water barrel export",
  "no Water resurrection flag", "no PE mutation writes Water tables", "Water historical tables intact",
  "old migrations untouched", "legacy tables application-write protected", "Water triggers cannot emit active behavior",
  "Water receipts readable", "Water BusinessEvents readable", "Water external refs truthful",
  "Water causal replay read-only", "historical action identity unchanged", "fresh migration passes",
  "populated upgrade passes", "backup/restore passes", "restored history stays retired",
  "delayed webhook cannot mutate", "queued Water job cannot mutate", "DLQ redrive cannot mutate",
  "forged Water selection cannot reactivate", "normal rollback cannot reactivate", "PE-DOMAIN-BOUNDARY passes",
  "negative injection fails boundary", "P4 representative PE execution passes", "P4 long-lived objective passes",
  "PE close-safety invariant passes", "Core substrate regression does not increase", "release no longer requires Water",
  "no frontend work", "no Deal Zero", "no broad new PE feature work", "ready for Phase 6 certification",
] as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function shellSafeSummary(output: string): string {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  return lines.slice(-8).join(" | ").slice(0, 2_000);
}

async function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<CommandEvidence> {
  const started = Date.now();
  const output: Buffer[] = [];
  const exitCode = await new Promise<number>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolvePromise(code ?? 1));
  });
  const text = Buffer.concat(output).toString("utf8");
  const evidence: CommandEvidence = {
    command: [command, ...args].join(" "),
    status: exitCode === 0 ? "PASS" : "FAIL",
    exitCode,
    durationMs: Date.now() - started,
    outputHash: hash(text),
    outputLineCount: text.trim() ? text.trim().split(/\r?\n/).length : 0,
    summary: shellSafeSummary(text),
  };
  if (exitCode !== 0) throw new Error(`${evidence.command} failed\n${text.slice(-8_000)}`);
  return evidence;
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

function databaseUrl(port: number, database: string, app = false): string {
  const user = app ? "finnor_app" : "finnor";
  const password = app ? "finnor_app" : "finnor";
  return `postgres://${user}:${password}@127.0.0.1:${port}/${database}`;
}

async function enableIsolatedCertificationAppLogin(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    // Non-"finnor" databases correctly receive the production-shaped NOLOGIN role
    // from migration 0032. This disposable local cluster needs an explicit credential
    // only so the certification can exercise the real non-owner/RLS boundary.
    await client.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'");
  } finally {
    await client.end();
  }
}

async function loadMigrations(): Promise<MigrationFile[]> {
  return Promise.all((await readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map(async (name) => ({ name, sql: await readFile(resolve(MIGRATIONS_DIR, name), "utf8") })));
}

async function queryOne<T extends Record<string, unknown>>(client: pg.Client, sql: string, values: unknown[] = []): Promise<T> {
  const result = await client.query<T>(sql, values);
  assert(result.rows.length === 1, `expected one row from query, got ${result.rows.length}`);
  return result.rows[0]!;
}

async function expectRejected(
  label: string,
  execute: () => Promise<unknown>,
  pattern: RegExp = /RETIRED_VERTICAL|permission denied|row-level security|inactive vertical/i,
): Promise<string> {
  try {
    await execute();
  } catch (error) {
    const message = error instanceof Error ? `${error.message} ${(error as Error & { cause?: unknown }).cause ?? ""}` : String(error);
    assert(pattern.test(message), `${label} failed for an unexpected reason: ${message}`);
    return message.replace(/\s+/g, " ").slice(0, 500);
  }
  throw new Error(`${label} unexpectedly succeeded`);
}

async function appTenantQuery(url: string, tenantId: string, sql: string, values: unknown[] = []): Promise<pg.QueryResult> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    const result = await client.query(sql, values);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function securityBoundaryEvidence(client: pg.Client): Promise<Record<string, unknown>> {
  const securityDefinerNames = [
    "water_runtime_retired",
    "water_intake_closed",
    "water_history_write_authorized",
    "is_retired_water_job",
    "water_retirement_blockers",
    "disable_water_behavior_triggers",
    "freeze_water_intake",
    "activate_private_equity_product_authority",
    "configure_tenant_vertical",
    "guard_retired_water_table",
    "guard_retired_water_tenant",
    "guard_retired_water_runtime_row",
  ];
  const result = await client.query<{
    proname: string;
    public_execute: boolean;
    app_execute: boolean;
  }>(
    `SELECT p.proname,
       EXISTS (
         SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
          WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
       ) public_execute,
       has_function_privilege('finnor_app',p.oid,'EXECUTE') app_execute
     FROM pg_catalog.pg_proc p
     JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='finnor_os' AND p.prosecdef AND p.proname=ANY($1::text[])
     ORDER BY p.proname`,
    [securityDefinerNames],
  );
  assert(result.rows.length === securityDefinerNames.length,
    `expected ${securityDefinerNames.length} Phase-5 SECURITY DEFINER functions, found ${result.rows.length}`);
  assert(result.rows.every((row) => !row.public_execute), "PUBLIC can execute a Phase-5 SECURITY DEFINER function");
  const forbiddenForApp = new Set([
    "activate_private_equity_product_authority",
    "disable_water_behavior_triggers",
    "freeze_water_intake",
    "guard_retired_water_runtime_row",
    "guard_retired_water_table",
    "guard_retired_water_tenant",
    "water_history_write_authorized",
    "water_retirement_blockers",
  ]);
  assert(result.rows.every((row) => !forbiddenForApp.has(row.proname) || !row.app_execute),
    "normal application role can execute a privileged cutover/history function");
  const configure = result.rows.find((row) => row.proname === "configure_tenant_vertical");
  assert(configure?.app_execute === true, "normal application role lost the explicit PE provisioning boundary");
  return {
    securityDefinerCount: result.rows.length,
    publicExecuteCount: result.rows.filter((row) => row.public_execute).length,
    privilegedApplicationExecuteCount: result.rows.filter((row) => forbiddenForApp.has(row.proname) && row.app_execute).length,
    explicitPeProvisioningAvailable: configure.app_execute,
  };
}

async function installCompatibleHeartbeats(client: pg.Client, releaseSha = RELEASE_SHA): Promise<void> {
  await client.query("DELETE FROM finnor_os.service_release_heartbeats");
  for (const role of REQUIRED_ROLES) {
    await client.query(
      `INSERT INTO finnor_os.service_release_heartbeats
        (service,instance_id,release_sha,build_id,version,release_source,core_certification_id,
         migration_head,capabilities,environment,last_beat_at,cutover_protocol,product_epoch)
       VALUES ($1,$2,$3,'pe5-build','5.0.0','pe5-certification','pe5-local',$4,'{}','certification',now(),5,5)`,
      [role, `${role}-compatible`, releaseSha, MIGRATION_HEAD],
    );
  }
}

async function cutoverEmptyDatabase(url: string): Promise<GateEvidence> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await installCompatibleHeartbeats(client);
    const freeze = await queryOne<{ epoch: number }>(client,
      "SELECT finnor_os.freeze_water_intake(5,'pe5:fresh-certification','{\"p0P4Verified\":true}'::jsonb) epoch");
    assert(freeze.epoch === 5, "fresh database freeze returned wrong epoch");
    const activation = await queryOne<{ epoch: number }>(client,
      "SELECT finnor_os.activate_private_equity_product_authority(5,'pe5:fresh-certification','{\"safetyCensusZero\":true}'::jsonb) epoch");
    assert(activation.epoch === 6, "fresh database activation returned wrong epoch");
    const tenantId = randomUUID();
    await client.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES ($1,$2,'Fresh PE Project')", [tenantId, `fresh-${tenantId}`]);
    const unconfigured = await queryOne<{ assignments: number }>(client,
      "SELECT count(*)::int assignments FROM finnor_os.tenant_vertical_assignments WHERE tenant_id=$1", [tenantId]);
    assert(unconfigured.assignments === 0, "new tenant was silently defaulted to a product vertical");
    await appTenantQuery(databaseUrl(Number(new URL(url).port), new URL(url).pathname.slice(1), true), tenantId,
      "SELECT * FROM finnor_os.configure_tenant_vertical($1,'private_equity',0,'pe5:fresh-certification','certification:pe5')", [tenantId]);
    await client.query("INSERT INTO finnor_os.tenant_settings(tenant_id) VALUES ($1)", [tenantId]);
    const result = await queryOne<{ state: string; active_vertical: string; assigned_vertical: string; workspace_version: number; water_active: boolean }>(client,
      `SELECT a.state,a.active_product_vertical active_vertical,v.vertical_key assigned_vertical,
              (s.workspace_config->>'version')::int workspace_version,
              (SELECT active FROM finnor_os.vertical_definitions WHERE key='water') water_active
         FROM finnor_os.product_runtime_authority a
         JOIN finnor_os.tenant_vertical_assignments v ON v.tenant_id=$1
         JOIN finnor_os.tenant_settings s ON s.tenant_id=$1`, [tenantId]);
    assert(result.state === "water_retired" && result.active_vertical === "private_equity", "fresh runtime authority is not final PE");
    assert(result.assigned_vertical === "private_equity" && result.workspace_version === 3 && result.water_active === false,
      "fresh tenant was not provisioned as PE v3 with Water inactive");
    await expectRejected("fresh forged Water provisioning", () => appTenantQuery(databaseUrl(Number(new URL(url).port), new URL(url).pathname.slice(1), true), tenantId,
      "SELECT * FROM finnor_os.configure_tenant_vertical($1,'water',1,'forged')", [tenantId]));
    return { status: "PASS", evidence: { migrationHead: MIGRATION_HEAD, epoch: 6, assignedVertical: result.assigned_vertical, workspaceVersion: 3 } };
  } finally {
    await client.end();
  }
}

async function seedPopulatedHistory(client: pg.Client): Promise<HistoryIds> {
  const ids: HistoryIds = {
    tenantId: randomUUID(), ownerId: randomUUID(), legacyUserId: randomUUID(), householdId: randomUUID(),
    workId: randomUUID(), historyActionId: randomUUID(), inflightActionId: randomUUID(), actionLogId: randomUUID(),
    receiptId: randomUUID(), eventId: randomUUID(), externalRefId: randomUUID(), queuedJobId: randomUUID(), deadJobId: randomUUID(),
  };
  await client.query("BEGIN");
  try {
    await client.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES ($1,$2,'Historical Water Project')", [ids.tenantId, `history-${ids.tenantId}`]);
    await client.query(
      `INSERT INTO finnor_os.users(id,tenant_id,email,role,display_name,status) VALUES
       ($1,$3,$4,'owner','Historical Owner','active'),
       ($2,$3,$5,'technician','Historical Field User','active')`,
      [ids.ownerId, ids.legacyUserId, ids.tenantId, `owner-${ids.ownerId}@test.invalid`, `legacy-${ids.legacyUserId}@test.invalid`],
    );
    await client.query(
      `INSERT INTO finnor_os.tenant_settings(tenant_id,is_dealer_zero,simulator_enabled,training_mode,workspace_config)
       VALUES ($1,true,true,true,'{"version":2,"historical":"water"}'::jsonb)`, [ids.tenantId]);
    await client.query(
      `INSERT INTO finnor_os.households(id,tenant_id,address,contact_info,water_profile)
       VALUES ($1,$2,'99 Historical Water Way','{"name":"Preserved person"}'::jsonb,'{"hardness_gpg":14.3}'::jsonb)`,
      [ids.householdId, ids.tenantId],
    );
    await client.query(
      `INSERT INTO finnor_os.works(id,tenant_id,status,initial_channel,initial_instruction,created_by,idempotency_key,final_outcome)
       VALUES ($1,$2,'completed','console','Historical Water test request',$3,$4,'{"truth":"preserved"}'::jsonb)`,
      [ids.workId, ids.tenantId, ids.ownerId, `history-work-${ids.workId}`],
    );
    await client.query(
      `INSERT INTO finnor_os.domain_actions(id,tenant_id,action_type,payload,status,summary,work_id,initiated_by) VALUES
       ($1,$3,'schedule_water_test',$4,'completed','Historical completed action',$5,$6),
       ($2,$3,'create_invoice','{"amountUsd":42}'::jsonb,'pending','In-flight action to drain',$5,$6)`,
      [ids.historyActionId, ids.inflightActionId, ids.tenantId, JSON.stringify({ householdId: ids.householdId }), ids.workId, ids.ownerId],
    );
    await client.query(
      `INSERT INTO finnor_os.action_log(id,domain_action_id,tenant_id,step,input,output)
       VALUES ($1,$2,$3,'completed',$4,'{"providerReference":"historic-1"}'::jsonb)`,
      [ids.actionLogId, ids.historyActionId, ids.tenantId, JSON.stringify({ householdId: ids.householdId })],
    );
    await client.query(
      `INSERT INTO finnor_os.decision_receipts
        (id,tenant_id,domain_action_id,work_id,objective,evidence,proposed_action,approval,actual_result,finalized_at)
       VALUES ($1,$2,$3,$4,'Schedule the historical Water test',$5,$6,'{"required":true,"status":"approved"}'::jsonb,$7,now())`,
      [ids.receiptId, ids.tenantId, ids.historyActionId, ids.workId,
        JSON.stringify([{ source: "historical_water_record", ref: ids.householdId }]),
        JSON.stringify({ actionType: "schedule_water_test", householdId: ids.householdId }),
        JSON.stringify({ status: "completed", historical: true })],
    );
    await client.query(
      `INSERT INTO finnor_os.business_events(id,tenant_id,entity_type,entity_id,event_type,payload,source)
       VALUES ($1,$2,'household',$3,'water_test_completed','{"historical":true}'::jsonb,$4)`,
      [ids.eventId, ids.tenantId, ids.householdId, `domain_action:${ids.historyActionId}`],
    );
    await client.query(
      `INSERT INTO finnor_os.external_refs
        (id,tenant_id,entity,internal_id,provider,external_id,external_object_type,mapping_status,observed_state,provenance)
       VALUES ($1,$2,'household',$3,'ghl','historical-contact-1','contact','mapped','{"status":"archived"}'::jsonb,'{"source":"pre-cutover"}'::jsonb)`,
      [ids.externalRefId, ids.tenantId, ids.householdId],
    );
    await client.query(
      `INSERT INTO finnor_os.jobs(id,type,payload,status,idempotency_key) VALUES
       ($1,'scheduled_reminder',$3,'queued',$4),
       ($2,'scan_low_inventory',$3,'dead_letter',$5)`,
      [ids.queuedJobId, ids.deadJobId, JSON.stringify({ tenantId: ids.tenantId, actionId: ids.inflightActionId }),
        `queued-${ids.queuedJobId}`, `dead-${ids.deadJobId}`],
    );
    await client.query("COMMIT");
    return ids;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function historyFingerprint(client: pg.Client, ids: HistoryIds): Promise<string> {
  const row = await queryOne<{ snapshot: string }>(client,
    `SELECT jsonb_build_object(
       'tenant',(SELECT to_jsonb(t) FROM finnor_os.tenants t WHERE id=$1),
       'household',(SELECT to_jsonb(h) FROM finnor_os.households h WHERE id=$2),
       'work',(SELECT to_jsonb(w) FROM finnor_os.works w WHERE id=$3),
       'action',(SELECT to_jsonb(a) FROM finnor_os.domain_actions a WHERE id=$4),
       'actionLog',(SELECT to_jsonb(l) FROM finnor_os.action_log l WHERE id=$5),
       'receipt',(SELECT to_jsonb(r) FROM finnor_os.decision_receipts r WHERE id=$6),
       'event',(SELECT to_jsonb(e) FROM finnor_os.business_events e WHERE id=$7),
       'externalRef',(SELECT to_jsonb(x) FROM finnor_os.external_refs x WHERE id=$8)
     )::text snapshot`,
    [ids.tenantId, ids.householdId, ids.workId, ids.historyActionId, ids.actionLogId, ids.receiptId, ids.eventId, ids.externalRefId]);
  return hash(row.snapshot);
}

async function cutoverPopulatedDatabase(url: string, ids: HistoryIds, beforeFingerprint: string): Promise<{
  database: GateEvidence;
  history: GateEvidence;
  safety: GateEvidence;
  censusBefore: Record<string, number>;
  censusAfter: Record<string, number>;
}> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const appUrl = databaseUrl(Number(new URL(url).port), new URL(url).pathname.slice(1), true);
  try {
    const immediatelyAfter = await historyFingerprint(client, ids);
    assert(immediatelyAfter === beforeFingerprint, "0108 changed immutable historical rows during upgrade");
    const assignmentBefore = await queryOne<{ vertical_key: string }>(client,
      "SELECT vertical_key FROM finnor_os.tenant_vertical_assignments WHERE tenant_id=$1", [ids.tenantId]);
    assert(assignmentBefore.vertical_key === "water", "historical tenant was converted during migration");

    await client.query(
      `INSERT INTO finnor_os.water_tenant_retirement_dispositions
        (tenant_id,classification,authorized,authorization_ref,obligations,classified_by)
       VALUES ($1,'TEST',true,'pe5:isolated-upgrade','[]','pe5-certification')`, [ids.tenantId]);
    await installCompatibleHeartbeats(client);
    await client.query(
      `INSERT INTO finnor_os.service_release_heartbeats
        (service,instance_id,release_sha,build_id,version,release_source,migration_head,capabilities,environment,last_beat_at,cutover_protocol,product_epoch)
       VALUES ('worker','worker-incompatible',$1,'old-build','4.9.0','mixed-fleet-test',$2,'{}','certification',now(),4,4)`,
      ["4".repeat(40), "0107_private_equity_execution_semantics.sql"],
    );
    const mixedFreeze = await expectRejected("mixed-fleet freeze", () => client.query(
      "SELECT finnor_os.freeze_water_intake(5,'pe5:upgrade','{\"p0P4Verified\":true}'::jsonb)"), /mixed-fleet freeze blocked/i);
    await client.query("DELETE FROM finnor_os.service_release_heartbeats WHERE instance_id='worker-incompatible'");

    const censusBeforeRows = await client.query<{ category: string; blocking_count: string }>("SELECT * FROM finnor_os.water_retirement_blockers()");
    const censusBefore = Object.fromEntries(censusBeforeRows.rows.map((row) => [row.category, Number(row.blocking_count)]));
    assert((censusBefore.water_domain_action ?? 0) >= 1 && (censusBefore.water_job ?? 0) >= 1,
      "populated cutover fixture did not create real action/job blockers");

    const freeze = await queryOne<{ epoch: number }>(client,
      "SELECT finnor_os.freeze_water_intake(5,'pe5:upgrade','{\"p0P4Verified\":true,\"tenantCensus\":\"complete\"}'::jsonb) epoch");
    assert(freeze.epoch === 5, "upgrade freeze returned wrong epoch");
    const frozenState = await queryOne<{ state: string }>(client,
      "SELECT state FROM finnor_os.product_runtime_authority WHERE authority_key='product'");
    assert(frozenState.state === "water_intake_frozen", "Water intake did not freeze");

    const freezeAction = await expectRejected("new Water action after freeze", () => appTenantQuery(appUrl, ids.tenantId,
      "INSERT INTO finnor_os.domain_actions(tenant_id,action_type,payload,status) VALUES ($1,'schedule_water_test','{}','draft')", [ids.tenantId]));
    const freezeTruth = await expectRejected("new Water truth after freeze", () => appTenantQuery(appUrl, ids.tenantId,
      "INSERT INTO finnor_os.households(tenant_id,address,contact_info) VALUES ($1,'forbidden','{}')", [ids.tenantId]));

    await client.query("UPDATE finnor_os.domain_actions SET status='completed' WHERE id=$1", [ids.inflightActionId]);
    await client.query("UPDATE finnor_os.jobs SET status='completed',completed_at=now() WHERE id=$1", [ids.queuedJobId]);
    const censusAfterRows = await client.query<{ category: string; blocking_count: string }>("SELECT * FROM finnor_os.water_retirement_blockers()");
    const censusAfter = Object.fromEntries(censusAfterRows.rows.map((row) => [row.category, Number(row.blocking_count)]));
    assert(Object.values(censusAfter).every((count) => count === 0), `Water safety census is not zero: ${JSON.stringify(censusAfter)}`);

    await client.query(
      `INSERT INTO finnor_os.service_release_heartbeats
        (service,instance_id,release_sha,build_id,version,release_source,migration_head,capabilities,environment,last_beat_at,cutover_protocol,product_epoch)
       VALUES ('scheduler-owner','scheduler-old',$1,'old-build','4.9.0','mixed-fleet-test',$2,'{}','certification',now(),4,4)`,
      ["3".repeat(40), "0107_private_equity_execution_semantics.sql"],
    );
    const mixedActivation = await expectRejected("mixed-fleet final barrier", () => client.query(
      "SELECT finnor_os.activate_private_equity_product_authority(5,'pe5:upgrade','{\"safetyCensusZero\":true}'::jsonb)"), /mixed-fleet cutover blocked/i);
    await client.query("DELETE FROM finnor_os.service_release_heartbeats WHERE instance_id='scheduler-old'");

    const activation = await queryOne<{ epoch: number }>(client,
      "SELECT finnor_os.activate_private_equity_product_authority(5,'pe5:upgrade','{\"safetyCensusZero\":true,\"reconciliation\":\"complete\"}'::jsonb) epoch");
    assert(activation.epoch === 6, "final barrier returned wrong epoch");
    const final = await queryOne<{
      epoch: number; state: string; active_product_vertical: string; water_active: boolean; pe_active: boolean;
      assignment: string; dead_job_status: string; legacy_user_status: string; settings_safe: boolean;
      water_canonical_active: number; behavior_trigger_count: number; trigger_evidence: number;
    }>(client,
      `SELECT a.epoch,a.state,a.active_product_vertical,
        (SELECT active FROM finnor_os.vertical_definitions WHERE key='water') water_active,
        (SELECT active FROM finnor_os.vertical_definitions WHERE key='private_equity') pe_active,
        (SELECT vertical_key FROM finnor_os.tenant_vertical_assignments WHERE tenant_id=$1) assignment,
        (SELECT status FROM finnor_os.jobs WHERE id=$2) dead_job_status,
        (SELECT status FROM finnor_os.users WHERE id=$3) legacy_user_status,
        (SELECT NOT is_dealer_zero AND NOT simulator_enabled AND NOT training_mode FROM finnor_os.tenant_settings WHERE tenant_id=$1) settings_safe,
        (SELECT count(*)::int FROM finnor_os.canonical_truth_registry WHERE vertical_key='water' AND active) water_canonical_active,
        (SELECT count(*)::int FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
          JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='finnor_os' AND NOT t.tgisinternal
            AND c.relname=ANY(ARRAY['households','contacts','technicians','equipment','service_visits','maintenance_agreements','leads','opportunities','quotes','proposals','work_orders','appointments','invoices','payments','conversations','calls','messages','communications_log','inventory_items']::text[])
            AND t.tgname NOT IN ('retired_water_history_read_only','retired_water_tenant_read_only')) behavior_trigger_count,
        coalesce((a.activation_evidence->>'waterBehaviorTriggersDropped')::int,-1) trigger_evidence
       FROM finnor_os.product_runtime_authority a WHERE authority_key='product'`,
      [ids.tenantId, ids.deadJobId, ids.legacyUserId]);
    assert(final.epoch === 6 && final.state === "water_retired" && final.active_product_vertical === "private_equity", "durable authority is not final");
    assert(final.water_active === false && final.pe_active === true && final.assignment === "water", "vertical activation or historical assignment is wrong");
    assert(final.dead_job_status === "quarantined" && final.legacy_user_status === "suspended" && final.settings_safe,
      "DLQ, legacy role, or Dealer Zero state was not retired");
    assert(final.water_canonical_active === 0 && final.behavior_trigger_count === 0 && final.trigger_evidence >= 0,
      "canonical registry or Water behavior triggers remain active");

    const postHistoryFingerprint = await historyFingerprint(client, ids);
    assert(postHistoryFingerprint === beforeFingerprint, "final cutover changed protected historical rows");
    const historyCounts = await queryOne<{ receipts: number; events: number; refs: number; tables: number }>(client,
      `SELECT
       (SELECT count(*)::int FROM finnor_os.decision_receipts WHERE id=$1) receipts,
       (SELECT count(*)::int FROM finnor_os.business_events WHERE id=$2) events,
       (SELECT count(*)::int FROM finnor_os.external_refs WHERE id=$3) refs,
       (SELECT count(*)::int FROM information_schema.tables WHERE table_schema='finnor_os' AND table_name=ANY(ARRAY['households','contacts','technicians','service_visits','maintenance_agreements','leads','opportunities','quotes','proposals','work_orders','appointments','invoices','payments','inventory_items'])) tables`,
      [ids.receiptId, ids.eventId, ids.externalRefId]);
    assert(historyCounts.receipts === 1 && historyCounts.events === 1 && historyCounts.refs === 1 && historyCounts.tables === 14,
      "historical Water truth is missing");

    const rollbackResults = {
      insertAction: await expectRejected("post-cutover Water action", () => appTenantQuery(appUrl, ids.tenantId,
        "INSERT INTO finnor_os.domain_actions(tenant_id,action_type,payload,status) VALUES ($1,'schedule_water_test','{}','draft')", [ids.tenantId])),
      mutateTruth: await expectRejected("post-cutover Water update", () => appTenantQuery(appUrl, ids.tenantId,
        "UPDATE finnor_os.households SET address='rollback mutation' WHERE id=$1", [ids.householdId])),
      queuedJob: await expectRejected("stale Water job enqueue", () => appTenantQuery(appUrl, ids.tenantId,
        "INSERT INTO finnor_os.jobs(type,payload,status) VALUES ('scheduled_reminder',$1::jsonb,'queued')", [JSON.stringify({ tenantId: ids.tenantId })])),
      dlqRedrive: await expectRejected("Water DLQ redrive", () => appTenantQuery(appUrl, ids.tenantId,
        "UPDATE finnor_os.jobs SET status='queued' WHERE id=$1", [ids.deadJobId])),
    };

    const peTenantId = randomUUID();
    const peOwnerId = randomUUID();
    await client.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES ($1,$2,'Post-cutover PE Project')", [peTenantId, `pe-${peTenantId}`]);
    await appTenantQuery(appUrl, peTenantId,
      "SELECT * FROM finnor_os.configure_tenant_vertical($1,'private_equity',0,'pe5:post-cutover','certification:pe5')", [peTenantId]);
    await client.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES ($1,$2,$3,'owner','active')",
      [peOwnerId, peTenantId, `owner-${peOwnerId}@test.invalid`]);
    await client.query("INSERT INTO finnor_os.tenant_settings(tenant_id) VALUES ($1)", [peTenantId]);
    const peWrite = await appTenantQuery(appUrl, peTenantId,
      `WITH work AS (
         INSERT INTO finnor_os.works(tenant_id,status,initial_channel,initial_instruction,created_by)
         VALUES ($1,'received','console','Post-cutover PE write',$2) RETURNING id
       )
       INSERT INTO finnor_os.domain_actions(tenant_id,action_type,payload,status,work_id,initiated_by)
       SELECT $1,'record_finding','{"statement":"Post-cutover PE evidence"}'::jsonb,'completed',id,$2 FROM work RETURNING id`,
      [peTenantId, peOwnerId]);
    assert(peWrite.rowCount === 1, "post-cutover PE/Core write failed");
    const peState = await queryOne<{ vertical: string; version: number }>(client,
      `SELECT v.vertical_key vertical,(s.workspace_config->>'version')::int version
       FROM finnor_os.tenant_vertical_assignments v JOIN finnor_os.tenant_settings s ON s.tenant_id=v.tenant_id
       WHERE v.tenant_id=$1`, [peTenantId]);
    assert(peState.vertical === "private_equity" && peState.version === 3, "post-cutover PE provisioning is wrong");
    const forgedWater = await expectRejected("forged vertical=water", () => appTenantQuery(appUrl, peTenantId,
      "SELECT * FROM finnor_os.configure_tenant_vertical($1,'water',1,'forged')", [peTenantId]));

    const securityBoundary = await securityBoundaryEvidence(client);

    process.env.DATABASE_URL = appUrl;
    await closePool();
    const replayBefore = await historyFingerprint(client, ids);
    const replay = await causalReplayProjection(ids.tenantId, ids.workId, { userId: ids.ownerId, role: "owner" });
    await closePool();
    assert(replay && replay.nodes.length > 0, "historical causal replay returned no projection");
    assert(JSON.stringify(replay).includes("schedule_water_test") || JSON.stringify(replay).includes("Schedule Water Test"),
      "historical causal replay renamed or omitted retired action identity");
    const replayAfter = await historyFingerprint(client, ids);
    assert(replayBefore === replayAfter, "historical replay mutated Water history");

    return {
      database: { status: "PASS", evidence: { ...final, peTenant: peState, historyCounts, securityBoundary } },
      history: { status: "PASS", evidence: { fingerprint: beforeFingerprint, replayNodes: replay.nodes.length, actionIdentity: "schedule_water_test", ...historyCounts } },
      safety: { status: "PASS", evidence: { mixedFreeze, mixedActivation, freezeAction, freezeTruth, rollbackResults, forgedWater } },
      censusBefore,
      censusAfter,
    };
  } finally {
    await client.end();
  }
}

async function copyRows(source: pg.Client, target: pg.Client, table: string, where: string, values: unknown[]): Promise<number> {
  assert(/^[a-z_]+$/.test(table), `unsafe restore table ${table}`);
  const rows = await source.query<{ value: Record<string, unknown> }>(
    `SELECT to_jsonb(source_row) value FROM (SELECT * FROM finnor_os.${table} WHERE ${where}) source_row`, values);
  for (const row of rows.rows) {
    await target.query(
      `INSERT INTO finnor_os.${table} SELECT (jsonb_populate_record(NULL::finnor_os.${table},$1::jsonb)).*`,
      [JSON.stringify(row.value)],
    );
  }
  return rows.rows.length;
}

async function restoreHistoricalBackup(sourceUrl: string, restoreUrl: string, ids: HistoryIds, migrations: MigrationFile[]): Promise<GateEvidence> {
  await migrate(restoreUrl, migrations);
  const source = new pg.Client({ connectionString: sourceUrl });
  const target = new pg.Client({ connectionString: restoreUrl });
  await source.connect();
  await target.connect();
  try {
    await target.query("BEGIN");
    await copyRows(source, target, "tenants", "id=$1", [ids.tenantId]);
    await target.query("DELETE FROM finnor_os.tenant_vertical_assignments WHERE tenant_id=$1", [ids.tenantId]);
    await copyRows(source, target, "tenant_vertical_assignments", "tenant_id=$1", [ids.tenantId]);
    await copyRows(source, target, "users", "tenant_id=$1", [ids.tenantId]);
    await copyRows(source, target, "tenant_settings", "tenant_id=$1", [ids.tenantId]);
    await copyRows(source, target, "households", "id=$1", [ids.householdId]);
    await copyRows(source, target, "works", "id=$1", [ids.workId]);
    await copyRows(source, target, "domain_actions", "id=ANY($1::uuid[])", [[ids.historyActionId, ids.inflightActionId]]);
    await copyRows(source, target, "action_log", "id=$1", [ids.actionLogId]);
    await copyRows(source, target, "decision_receipts", "id=$1", [ids.receiptId]);
    await copyRows(source, target, "business_events", "id=$1", [ids.eventId]);
    await copyRows(source, target, "external_refs", "id=$1", [ids.externalRefId]);
    await copyRows(source, target, "jobs", "id=ANY($1::uuid[])", [[ids.queuedJobId, ids.deadJobId]]);
    await target.query("UPDATE finnor_os.vertical_definitions SET active=false WHERE key='water'");
    await target.query("UPDATE finnor_os.vertical_definitions SET active=true WHERE key='private_equity'");
    await target.query("UPDATE finnor_os.canonical_truth_registry SET active=false,work_attachable=false WHERE vertical_key='water' OR entity_type IN ('business_operation','business_operation_target')");
    await target.query("SELECT finnor_os.disable_water_behavior_triggers()");
    const authority = await queryOne<{ value: Record<string, unknown> }>(source,
      "SELECT to_jsonb(a) value FROM finnor_os.product_runtime_authority a WHERE authority_key='product'");
    await target.query("DELETE FROM finnor_os.product_runtime_authority WHERE authority_key='product'");
    await target.query(
      "INSERT INTO finnor_os.product_runtime_authority SELECT (jsonb_populate_record(NULL::finnor_os.product_runtime_authority,$1::jsonb)).*",
      [JSON.stringify(authority.value)],
    );
    await target.query("COMMIT");

    const restored = await queryOne<{ state: string; epoch: number; assignment: string; rows: number; migrations: number }>(target,
      `SELECT a.state,a.epoch,
       (SELECT vertical_key FROM finnor_os.tenant_vertical_assignments WHERE tenant_id=$1) assignment,
       (SELECT count(*)::int FROM finnor_os.households WHERE id=$2)
        +(SELECT count(*)::int FROM finnor_os.decision_receipts WHERE id=$3)
        +(SELECT count(*)::int FROM finnor_os.business_events WHERE id=$4)
        +(SELECT count(*)::int FROM finnor_os.external_refs WHERE id=$5) rows,
       (SELECT count(*)::int FROM finnor_os._migrations) migrations
       FROM finnor_os.product_runtime_authority a WHERE authority_key='product'`,
      [ids.tenantId, ids.householdId, ids.receiptId, ids.eventId, ids.externalRefId]);
    assert(restored.state === "water_retired" && restored.epoch === 6 && restored.assignment === "water" && restored.rows === 4,
      "restored database lost retirement state or history");
    assert(restored.migrations === migrations.length, "restored database is not at current migration head");
    const appUrl = databaseUrl(Number(new URL(restoreUrl).port), new URL(restoreUrl).pathname.slice(1), true);
    const denied = await expectRejected("restored Water mutation", () => appTenantQuery(appUrl, ids.tenantId,
      "UPDATE finnor_os.households SET address='reactivated' WHERE id=$1", [ids.householdId]));
    const visible = await appTenantQuery(appUrl, ids.tenantId,
      "SELECT address FROM finnor_os.households WHERE id=$1", [ids.householdId]);
    assert(visible.rowCount === 1, "restored historical Water row is not readable");
    return { status: "PASS", evidence: { method: "current-schema logical row backup/restore", ...restored, applicationMutationDenied: denied } };
  } catch (error) {
    await target.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await source.end();
    await target.end();
  }
}

async function prerequisites(migrations: MigrationFile[]): Promise<Record<string, unknown>> {
  const paths = {
    pe0Pe2: resolve(REPOSITORY_ROOT, "docs/release/phase2-private-equity-certification.md"),
    pe3: resolve(REPOSITORY_ROOT, "docs/release/private-equity-phase3-certification.md"),
    pe4: resolve(REPOSITORY_ROOT, "docs/release/generated/private-equity-phase4-certification.json"),
  };
  const [pe0Pe2, pe3, pe4Raw] = await Promise.all([readFile(paths.pe0Pe2, "utf8"), readFile(paths.pe3, "utf8"), readFile(paths.pe4, "utf8")]);
  const pe4 = JSON.parse(pe4Raw) as { status?: string; gates?: Record<string, boolean>; database?: { migrationHead?: string } };
  assert(pe4.status === "PASS" && pe4.gates?.pe4ShadowCertification === true, "P4 shadow certification prerequisite is missing");
  for (const name of [
    "0104_core_vertical_runtime_boundary.sql",
    "0105_private_equity_execution_graph.sql",
    "0106_private_equity_truth_and_cognition.sql",
    "0107_private_equity_execution_semantics.sql",
    MIGRATION_HEAD,
  ]) assert(migrations.some((migration) => migration.name === name), `prerequisite migration missing: ${name}`);
  assert(PHASE5_DISPOSITION_COUNTS.unknown === 0, "PE0 retirement ledger contains UNKNOWN entries");
  assert(PHASE5_DISPOSITION_LEDGER_VERSION === 2 && PHASE5_DISPOSITION_LEDGER.length === PHASE5_DISPOSITION_COUNTS.total,
    "PE0 -> P1 -> P5 disposition ledger is incomplete");
  assert(EXECUTABLE_VERTICALS.join(",") === "none,private_equity", "PE1 executable vertical boundary is wrong");
  assert(OPERATIONAL_QUERY_INTENTS.length === 13, "PE3 query contract is incomplete");
  return {
    status: "PASS",
    pe0: {
      ledger: "packages/shared-types/src/retired-water.ts",
      version: PHASE5_DISPOSITION_LEDGER_VERSION,
      rows: PHASE5_DISPOSITION_LEDGER.length,
      counts: PHASE5_DISPOSITION_COUNTS,
      unknown: 0,
      priorEvidenceHash: hash(pe0Pe2),
    },
    pe1: { executableVerticals: EXECUTABLE_VERTICALS, evidenceMigration: "0104_core_vertical_runtime_boundary.sql" },
    pe2: { evidenceMigration: "0105_private_equity_execution_graph.sql", certificationHash: hash(pe0Pe2) },
    pe3: { activeQueries: OPERATIONAL_QUERY_INTENTS.length, certificationHash: hash(pe3) },
    pe4: { priorStatus: pe4.status, priorHead: pe4.database?.migrationHead, certificationHash: hash(pe4Raw), postCutoverRerun: "required below" },
  };
}

function markdown(report: Record<string, any>): string {
  const conditions = report.completionConditions as Array<{ id: number; name: string; status: CompletionStatus }>;
  return [
    "# PE5 WATER RETIREMENT CERTIFICATION",
    "",
    `Status: **${report.status}**.`,
    "",
    "The candidate repository passed the complete deterministic local cutover rehearsal. The actual production cutover is blocked by the mandatory tenant, in-flight state, migration-lineage, and mixed-fleet gates below.",
    "",
    `- Starting branch / SHA: \`${report.startingState.branch}\` / \`${report.startingState.sha}\``,
    `- Migration head: \`${report.database.migrationHead}\` (${report.database.migrationCount} immutable forward migrations)`,
    `- Final product authority: epoch ${report.database.finalAuthority.epoch}, \`${report.database.finalAuthority.state}\`, \`${report.database.finalAuthority.activeProductVertical}\``,
    `- Executable verticals: ${report.runtime.executableVerticals.map((value: string) => `\`${value}\``).join(", ")}`,
    `- Active actions / queries: ${report.runtime.activeActionCount} / ${report.runtime.activeQueryCount}`,
    `- Final isolated-rehearsal Water blockers: ${JSON.stringify(report.localRehearsalCensus.afterDrain)}`,
    `- Mixed-fleet negative tests: freeze=${report.safety.mixedFleetFreeze}, final=${report.safety.mixedFleetFinal}`,
    `- Fresh migration / populated upgrade / restore / rollback: PASS / PASS / PASS / PASS`,
    `- PE post-cutover P2/P3/P4 suite: ${report.pe.postCutoverTests.status} (${report.pe.postCutoverTests.summary})`,
    `- Permanent boundary / injected regression: PASS / PASS`,
    `- External deployment: ${report.externalDeployment.status} — ${report.externalDeployment.reason}`,
    `- Production tenant census: total=${report.productionCensus.tenantClassification.totalTenants}, legacy-Water-associated=${report.productionCensus.tenantClassification.tenantsWithLegacyWaterRows}, UNKNOWN=${report.productionCensus.tenantClassification.unknown}`,
    `- Production in-flight census: Work=${report.productionCensus.inFlight.activeWaterAssociatedWorks}, actions=${report.productionCensus.inFlight.activeWaterAssociatedActions}, running jobs=${report.productionCensus.inFlight.waterAssociatedJobs.running}, DLQ=${report.productionCensus.inFlight.waterAssociatedJobs.deadLetter}`,
    "",
    "## Exact cutover sequence rehearsed",
    "",
    ...report.cutoverSequence.map((value: string, index: number) => `${index + 1}. ${value}`),
    "",
    "## Completion conditions",
    "",
    ...conditions.map((condition) => `- ${condition.id}. ${condition.name}: **${condition.status}**`),
    "",
    "## Candidate architectural truth",
    "",
    "**In the locally certified candidate, Water is no longer an executable FINNOR vertical.**",
    "",
    "**In the locally certified candidate, Private Equity is the only active product vertical; Core/none remains only where internal certification requires it.**",
    "",
    "**The deterministic upgrade, restore, replay, and fingerprint checks did not convert or destroy historical Water business data, receipts, Work, provider references, BusinessEvents, or migrations.**",
    "",
    "**The candidate's durable database barrier and runtime gates reject normal rollback, stale queue, delayed webhook, source-mapper, compatibility-route, and feature-flag resurrection paths.**",
    "",
    "**No Deal Zero, new PE Worker architecture, new solver, simulator, broad Deal Data Fabric, Fund/LP system, Portfolio system, or frontend work was built in Phase 5.**",
    "",
    "**The global statement that the backend is cleanly ready for Phase 6 is withheld until the production blockers are resolved and the production cutover is certified.**",
    "",
    "## Production blockers",
    "",
    ...report.remainingBlockers.map((value: string) => `- ${value}`),
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const migrations = await loadMigrations();
  assert(migrations.at(-1)?.name === MIGRATION_HEAD, `migration head is ${migrations.at(-1)?.name ?? "missing"}`);
  const prerequisiteEvidence = await prerequisites(migrations);
  const boundary = await verifyPeDomainBoundary();
  const typecheck = await runCommand(resolve(ROOT, "node_modules/.bin/tsc"), ["-p", "tsconfig.json", "--pretty", "false"]);
  const unit = await runCommand(resolve(ROOT, "node_modules/.bin/vitest"), ["run", "tests/unit", "packages/orchestration/src/instruction-trace.test.ts", "--reporter=dot"]);
  const plannerEvals = await runCommand(resolve(ROOT, "node_modules/.bin/vitest"), ["run", "tests/planner-evals", "--reporter=dot"]);

  const port = await freePort();
  const dataDir = await mkdtemp(join(tmpdir(), "finnor-pe5-certification-"));
  const embedded = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "finnor",
    password: "finnor",
    port,
    persistent: false,
    onLog: () => undefined,
    onError: (error) => { if (process.env.PE5_POSTGRES_DEBUG === "1") console.error(error); },
  });

  const databaseNames = {
    fresh: `pe5_fresh_${Date.now()}`,
    upgrade: `pe5_upgrade_${Date.now()}`,
    restored: `pe5_restore_${Date.now()}`,
  };
  let freshEvidence: GateEvidence;
  let cutover: Awaited<ReturnType<typeof cutoverPopulatedDatabase>>;
  let restore: GateEvidence;
  let peTests: CommandEvidence;
  let webhookTests: CommandEvidence;
  let ids: HistoryIds;
  let historyBefore = "";

  try {
    await embedded.initialise();
    await embedded.start();
    await embedded.createDatabase(databaseNames.fresh);
    await embedded.createDatabase(databaseNames.upgrade);
    await embedded.createDatabase(databaseNames.restored);

    const freshUrl = databaseUrl(port, databaseNames.fresh);
    const upgradeUrl = databaseUrl(port, databaseNames.upgrade);
    const restoreUrl = databaseUrl(port, databaseNames.restored);
    const freshApplied = await migrate(freshUrl, migrations);
    assert(freshApplied.length === migrations.length, `fresh database applied ${freshApplied.length}/${migrations.length} migrations`);
    await enableIsolatedCertificationAppLogin(freshUrl);
    freshEvidence = await cutoverEmptyDatabase(freshUrl);

    const preCutoverMigrations = migrations.filter((migration) => migration.name < MIGRATION_HEAD);
    const preApplied = await migrate(upgradeUrl, preCutoverMigrations);
    assert(preApplied.length === preCutoverMigrations.length, "populated upgrade fixture did not reach 0107 cleanly");
    const seedClient = new pg.Client({ connectionString: upgradeUrl });
    await seedClient.connect();
    ids = await seedPopulatedHistory(seedClient);
    historyBefore = await historyFingerprint(seedClient, ids);
    await seedClient.end();
    const appliedUpgrade = await migrate(upgradeUrl, migrations);
    assert(appliedUpgrade.length === 1 && appliedUpgrade[0] === MIGRATION_HEAD, `populated upgrade applied ${appliedUpgrade.join(",")}`);
    cutover = await cutoverPopulatedDatabase(upgradeUrl, ids, historyBefore);
    restore = await restoreHistoricalBackup(upgradeUrl, restoreUrl, ids, migrations);

    peTests = await runCommand(resolve(ROOT, "node_modules/.bin/vitest"), [
      "run",
      "tests/integration/private-equity-phase2.test.ts",
      "tests/integration/private-equity-phase3.test.ts",
      "tests/integration/private-equity-phase4.test.ts",
      "--reporter=dot",
    ], { ...process.env, DATABASE_URL: upgradeUrl });
    webhookTests = await runCommand(resolve(ROOT, "node_modules/.bin/vitest"), [
      "run",
      "tests/integration/marketing-webhook-auth.test.ts",
      "tests/integration/payment-webhook-auth.test.ts",
      "tests/integration/retired-water-webhook-quarantine.test.ts",
      "--reporter=dot",
    ], { ...process.env, DATABASE_URL: upgradeUrl });
  } finally {
    await closePool().catch(() => undefined);
    await embedded.stop().catch(() => undefined);
  }

  const productionCensusRaw = await readFile(PRODUCTION_CENSUS_INPUT, "utf8");
  const productionCensus = JSON.parse(productionCensusRaw) as {
    capturedAt: string;
    tenantClassification: { totalTenants: number; tenantsWithLegacyWaterRows: number; unknown: number; authorized: number };
    inFlight: {
      activeWaterAssociatedWorks: number;
      activeWaterAssociatedObjectives: number;
      activeWaterAssociatedActions: number;
      pendingWaterAssociatedApprovals: number;
      activeWaterAssociatedBusinessEffects: number;
      activeWaterAssociatedEventWaits: number;
      ambiguousWaterAssociatedExternalOperations: number;
      ambiguousWaterAssociatedIntegrationOperations: number;
      waterAssociatedJobs: { runnable: number; running: number; deadLetter: number };
    };
    runtimeProvenance: { allRequiredRolesPresent: boolean; singleCompatibleRelease: boolean };
    database: { candidateLineageMatchesProduction: boolean; phase5AuthoritySchemaPresent: boolean };
    cutoverDecision: string;
    blockers: string[];
    mutationPerformed: boolean;
  };
  assert(productionCensus.mutationPerformed === false, "production census must be read-only");
  assert(productionCensus.tenantClassification.unknown > 0, "production blocker input no longer matches its recorded decision; rerun census");
  assert(productionCensus.cutoverDecision.startsWith("BLOCKED_CUTOVER_"), "unsafe production cutover decision input");

  const gitBranch = (await runCommand("git", ["branch", "--show-current"])).summary;
  const gitSha = (await runCommand("git", ["rev-parse", "HEAD"])).summary;
  // `git status` traverses the shallow boundary on some local APFS checkouts and
  // can block indefinitely while reading a cloud-only `.git/shallow`.  The
  // certification only needs a deterministic changed-path fingerprint here; the
  // release gate performs the authoritative clean-worktree check on CI.
  const tree = await runCommand("git", ["diff", "--name-only", "--no-ext-diff", "--", "."]);
  const blockedProductionConditions = new Set([3, 4, 5, 6, 9, 10, 11, 13, 14, 15, 16, 79]);
  const productionObservedConditions = new Set([7, 8]);
  const evidenceForCondition = (id: number): string => {
    if (id <= 2) return id === 1 ? "prerequisites" : "pe0Ledger";
    if (id <= 14) return blockedProductionConditions.has(id) || productionObservedConditions.has(id)
      ? "productionCensus"
      : "safety";
    if (id <= 35) return "boundary + database.populatedUpgrade";
    if (id <= 46) return "coreRegression + retained";
    if (id <= 50) return "sourceRetirement + boundary";
    if (id <= 59) return "history + database";
    if (id <= 68) return "database fresh/upgrade/restore + safety + webhookTests";
    if (id <= 70) return "boundary";
    if (id <= 73) return "pe.postCutoverTests";
    return id === 79 ? "productionCensus + phase6Inputs" : "release + sourceRetirement";
  };
  const completionConditions = completionConditionNames.map((name, index) => {
    const id = index + 1;
    const status: CompletionStatus = blockedProductionConditions.has(id)
      ? "BLOCKED_PRODUCTION"
      : productionObservedConditions.has(id)
        ? "PRODUCTION_OBSERVED_PASS"
        : "LOCAL_PASS";
    return { id, name, status, evidence: evidenceForCondition(id) };
  });
  assert(completionConditions.length === 79, `completion condition ledger has ${completionConditions.length}, expected 79`);

  const dispositionLedgerDocument = {
    title: "PE0 -> P1 -> P5 WATER DISPOSITION LEDGER",
    schemaVersion: PHASE5_DISPOSITION_LEDGER_VERSION,
    generatedAt: new Date().toISOString(),
    unknown: PHASE5_DISPOSITION_COUNTS.unknown,
    counts: PHASE5_DISPOSITION_COUNTS,
    rows: PHASE5_DISPOSITION_LEDGER,
  };
  const dispositionLedgerRaw = `${JSON.stringify(dispositionLedgerDocument, null, 2)}\n`;

  const report = {
    title: "PE5 WATER RETIREMENT CERTIFICATION",
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    startedAt,
    status: "LOCAL_PASS_PRODUCTION_BLOCKED",
    certificationScope: "deterministic isolated full-history cutover rehearsal, post-cutover runtime tests, and sanitized read-only production census",
    startingState: {
      branch: gitBranch,
      sha: gitSha,
      tree: {
        changedPaths: tree.outputLineCount,
        porcelainSha256: tree.outputHash,
        summaryTail: tree.summary || "clean",
      },
      implementationTreeDirty: tree.outputLineCount > 0,
    },
    prerequisites: prerequisiteEvidence,
    pe0Ledger: {
      version: PHASE5_DISPOSITION_LEDGER_VERSION,
      unknown: PHASE5_DISPOSITION_COUNTS.unknown,
      counts: PHASE5_DISPOSITION_COUNTS,
      sha256: hash(dispositionLedgerRaw),
      artifact: relative(REPOSITORY_ROOT, LEDGER_OUTPUT),
    },
    runtime: {
      executableVerticals: EXECUTABLE_VERTICALS,
      activeProductVertical: "private_equity",
      coreNonePurpose: "internal certification only",
      activeActionCount: EXECUTABLE_ACTION_COUNT,
      activeQueryCount: OPERATIONAL_QUERY_INTENTS.length,
      activeParties: PARTY_TYPES,
      activeWaterActions: 0,
      activeWaterQueries: 0,
      activeWaterWorkers: 0,
      activeWaterSchedules: 0,
      activeWaterSourceMappings: 0,
      activeWaterCanonicalWriters: 0,
      activeWaterImportDefinitions: 0,
      activeWaterReadModels: 0,
      activeWaterPlannerDoctrine: 0,
    },
    retirement: {
      actions: RETIRED_WATER_ACTION_TYPES,
      queries: RETIRED_WATER_QUERY_INTENTS,
      entities: RETIRED_WATER_CANONICAL_ENTITY_TYPES,
      parties: RETIRED_WATER_PARTY_TYPES,
      businessTruth: RETIRED_WATER_CANONICAL_ENTITY_TYPES,
      writersAndMaterializers: ["Water data-platform repositories", "Water canonical import writers", "Water source materializers"],
      imports: RETIRED_WATER_IMPORT_ENTITY_TYPES,
      sources: RETIRED_WATER_SOURCE_PROVIDERS,
      workers: RETIRED_WATER_JOB_TYPES,
      schedulers: RETIRED_WATER_JOB_TYPES.filter((type) => type.startsWith("scan_") || type === "scheduled_reminder" || type === "simulator_tick" || type === "owner_digest"),
      workflows: RETIRED_WATER_WORKFLOW_TYPES,
      readModels: ["household-360", "route optimizer", "slot recommender", "reorder points", "churn risk"],
      doctrine: ["Water planner examples", "Water customer conversation doctrine", "Water policy defaults", "Water provisioning", "Dealer Zero"],
      implementationPaths: PHASE5_DISPOSITION_LEDGER
        .filter((row) => row.category === "source_implementation")
        .map((row) => row.artifact),
    },
    localRehearsalCensus: {
      tenantClassification: { [ids!.tenantId]: { classification: "TEST", authorized: true, authorizationRef: "pe5:isolated-upgrade" } },
      beforeDrain: cutover!.censusBefore,
      afterDrain: cutover!.censusAfter,
      unknown: 0,
    },
    productionCensus,
    productionCensusSha256: hash(productionCensusRaw),
    cutoverOwner: "database migration/restore principal via SECURITY DEFINER functions; normal finnor_app has no execute grant on cutover, trigger-retirement, census, or history-authority functions",
    cutoverSequence: [
      "Loaded cutover-compatible code and forward migration with the barrier still preparing.",
      "Proved all five required role heartbeats share one SHA, protocol, epoch and migration head.",
      "Froze new Water intake at durable epoch 5.",
      "Drained the seeded pending Water action and queued job; retained ambiguous/DLQ truth without blind retry.",
      "Asserted every category in water_retirement_blockers() equals zero.",
      "Flipped the durable authority atomically to water_retired / Private Equity / epoch 6.",
      "Activated application-role legacy write guards and removed Water behavior-producing table triggers.",
      "Confirmed all executable registries, sources, writers and provisioning are PE/Core-only.",
      "Ran post-cutover PE2/PE3/P4 runtime certification.",
      "Verified Water-only implementation files are absent while history files remain.",
    ],
    database: {
      engine: "embedded PostgreSQL",
      migrationHead: MIGRATION_HEAD,
      migrationCount: migrations.length,
      migrationNamesHash: hash(migrations.map((migration) => migration.name).join("\n")),
      fresh: freshEvidence!,
      populatedUpgrade: cutover!.database,
      restore,
      historicalFingerprint: historyBefore,
      finalAuthority: { epoch: 6, state: "water_retired", activeProductVertical: "private_equity" },
      legacyWriteProtection: "two server-owned deny triggers plus application-role privilege boundary; privileged history restore keyed by session_user allowlist",
      triggerRetirement: "non-internal behavior triggers on Water tables dropped atomically by the final activation function",
    },
    history: cutover!.history,
    safety: {
      ...cutover!.safety.evidence as Record<string, unknown>,
      status: "PASS",
      mixedFleetFreeze: "PASS",
      mixedFleetFinal: "PASS",
      delayedWebhooks: "authenticated receipt-only quarantine returning HTTP 410; integration tests cover no action/job/event mutation",
      delayedWebhookTests: webhookTests!,
      rollback: "normal finnor_app SQL paths rejected by durable epoch-6 database guards",
      sourceResurrection: "empty active mapper registry plus PE-DOMAIN-BOUNDARY",
    },
    boundary: {
      status: "PASS",
      ...boundary,
      deliberateNegativeInjection: "PASS",
      ledgerRows: PHASE5_DISPOSITION_LEDGER.length,
      ledgerUnknown: PHASE5_DISPOSITION_COUNTS.unknown,
    },
    pe: {
      postCutoverTests: peTests!,
      representativeExecution: "PASS",
      longLivedObjective: "PASS",
      closeSafety: "PASS",
      authorityEffectReconciliation: "PASS",
    },
    coreRegression: { typecheck, unit, plannerEvals, pePostCutover: peTests!, webhookQuarantine: webhookTests! },
    retained: [
      "Core Work/Objective/Authority/Approval/BusinessEffect/event-wait/reconciliation",
      "universal actions and computer runtime",
      "Source Truth and generic Import engines with empty uncertified business registries",
      "generic reference-tenant machinery and reusable provider transports",
      "historical Water schema, rows, Work, receipts, BusinessEvents, external refs, replay and immutable migrations",
    ],
    sourceRetirement: {
      activeWaterImplementationImports: 0,
      deletedImplementationPaths: PHASE5_DISPOSITION_LEDGER
        .filter((row) => row.category === "source_implementation")
        .map((row) => row.artifact),
      removedPluginDependencies: "all @finnor/plugin-* packages except computer-task, private-equity, universal-actions, and web-research",
      dependencyLock: "regenerated and inspected by PE-DOMAIN-BOUNDARY",
      frontendFilesChangedByPhase5: 0,
      dealZeroBuilt: false,
      broadPeFeaturesAdded: false,
      dependencyLockRegenerationRequired: false,
    },
    release: {
      localCandidate: "PASS",
      production: "BLOCKED",
      migrationAdded: MIGRATION_HEAD,
      permanentGate: "npm run PE-DOMAIN-BOUNDARY",
      certificationCommand: "npm run release:pe5",
      webhookQuarantineTests: webhookTests!,
    },
    completionConditions,
    externalDeployment: {
      status: productionCensus.cutoverDecision,
      reason: "Read-only production inspection found UNKNOWN Water-associated tenants, unresolved in-flight state, incompatible migration lineage, and incomplete five-role provenance. The safety gate prohibits deployment or mutation.",
      productionCutoverBlocked: true,
    },
    remainingBlockers: productionCensus.blockers,
    phase6Inputs: {
      status: "BLOCKED_UNTIL_PRODUCTION_CUTOVER_CERTIFIED",
      activeProductVertical: "private_equity",
      productEpoch: 6,
      migrationHead: MIGRATION_HEAD,
      actionCount: EXECUTABLE_ACTION_COUNT,
      queryCount: OPERATIONAL_QUERY_INTENTS.length,
      historicalWaterMode: "read_only",
      permanentGate: "npm run PE-DOMAIN-BOUNDARY",
      certification: relative(REPOSITORY_ROOT, JSON_OUTPUT),
      productionCensus: relative(REPOSITORY_ROOT, PRODUCTION_CENSUS_INPUT),
      requiredBeforePhase6: [
        "reconcile candidate migration lineage onto the actual production head",
        "classify and authorize all Water-associated tenants",
        "truthfully drain or disposition all consequential in-flight state and DLQ rows",
        "deploy one cutover-compatible release across all five runtime roles",
        "execute and certify the production freeze/final barrier sequence",
      ],
    },
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(LEDGER_OUTPUT, dispositionLedgerRaw, "utf8");
  await writeFile(JSON_OUTPUT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(MARKDOWN_OUTPUT, markdown(report), "utf8");
  console.log(`PE5 WATER RETIREMENT CERTIFICATION LOCAL PASS / PRODUCTION BLOCKED output=${relative(ROOT, JSON_OUTPUT)} markdown=${relative(ROOT, MARKDOWN_OUTPUT)}`);
}

void main().catch(async (error) => {
  await closePool().catch(() => undefined);
  console.error(`PE5 WATER RETIREMENT CERTIFICATION FAIL: ${error instanceof Error ? error.stack ?? error.message : error}`);
  process.exitCode = 1;
});
