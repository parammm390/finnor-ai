import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { assertDisposableDatabaseTarget } from "../../packages/db/production-target-guard";
import { exhibits, mandate } from "./birch";
import type { LLMProvider } from "@finnor/tools";

if (!process.argv[2]) throw new Error("Provide a durable output directory: npm run benchmark:pe:birch -- <directory>");
const output = resolve(process.argv[2]);
const mode = process.argv[3] ?? "participant";
if (!["participant", "owner-control", "owner-denied-control"].includes(mode)) throw new Error("Unknown Birch run mode.");
const runId = randomUUID();
const keep = new Set(["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "TZ"]);
for (const name of Object.keys(process.env)) if (!keep.has(name)) delete process.env[name];
Object.assign(process.env, {
  NODE_ENV: "test", FINNOR_TEST_MANAGED_EXTENSIONS: "omit", SECRETS_PROVIDER: "env",
  LLM_PROVIDER_PLANNING: "birch-local-observer", LLM_PROVIDER_ANSWER: "birch-local-observer",
  LLM_PROVIDER_UNDERSTANDING: "birch-local-observer",
});

const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const report = {
  schema: "finnor.pe.birch.candidate-observation.v1", runId, mode,
  build: {
    revision: git(["rev-parse", "HEAD"]), patchSha256: sha256(git(["diff", "--binary", "HEAD"])),
    runnerSha256: sha256(await readFile(new URL(import.meta.url), "utf8")), node: process.version,
  },
  fixtureSha256: sha256(JSON.stringify({ mandate, exhibits })),
  qualification: "Signed loopback fixture auth, ordinary Postgres role, real API and worker handlers, local diagnostic model only, no external provider calls.",
  attempts: [] as Array<Record<string, unknown>>,
  status: "RUNNING", failure: null as { boundary: string; message: string } | null,
};
const file = join(output, `birch-${runId}.json`);
await mkdir(output, { recursive: true });
async function save() {
  const pending = file + ".pending";
  await writeFile(pending, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  await rename(pending, file);
}
await save();
console.log(`BIRCH_OBSERVATION ${file}`);

function pdf(text: string) {
  const escaped = text.replace(/[\\()]/g, "\\$&");
  const data = `BT /F1 10 Tf 40 750 Td (${escaped}) Tj ET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(data)} >>\nstream\n${data}endstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((value, index) => {
    const offset = Buffer.byteLength(body);
    body += `${index + 1} 0 obj\n${value}\nendobj\n`;
    return offset;
  });
  return Buffer.from(body + `xref\n0 6\n0000000000 65535 f \n${offsets.map(value => `${String(value).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${Buffer.byteLength(body)}\n%%EOF\n`);
}

let boundary = "database";
let postgres: EmbeddedPostgres | undefined;
let started = false;
let admin: pg.Client | undefined;
let stop: (() => Promise<void>) | undefined;
try {
  const port = await new Promise<number>((accept, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => address && typeof address !== "string" ? accept(address.port) : reject(new Error("No loopback port")));
    });
  });
  postgres = new EmbeddedPostgres({
    databaseDir: await mkdtemp(join(tmpdir(), "finnor-birch-")), user: "birch_admin", password: "local-fixture",
    port, persistent: false, onLog: () => undefined,
  });
  await postgres.initialise();
  await postgres.start();
  started = true;
  await postgres.createDatabase("birch_acceptance");
  const url = `postgres://birch_admin:local-fixture@127.0.0.1:${port}/birch_acceptance`;
  const { migrate } = await import("../../packages/db/migrate");
  assertDisposableDatabaseTarget(url, "Birch fixture");
  await migrate(url);
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'local-fixture'; ALTER ROLE finnor_worker LOGIN PASSWORD 'local-fixture'");
  await admin.query("SET app.test_vertical_mode='explicit'");
  const appUrl = `postgres://finnor_app:local-fixture@127.0.0.1:${port}/birch_acceptance`;
  const workerUrl = `postgres://finnor_worker:local-fixture@127.0.0.1:${port}/birch_acceptance`;
  process.env.DATABASE_URL = appUrl;

  boundary = "fixture setup";
  const { closePool, configureTenantVertical } = await import("@finnor/db");
  const { createDefaultPluginRegistry, registerProvider } = await import("@finnor/orchestration");
  const { configureAgentProfile } = await import("../../packages/orchestration/src/workforce-runtime");
  const { attachDocumentTx, createDeal, peTransaction } = await import("@finnor/private-equity");
  const { ingestArtifact, bindArtifact } = await import("@finnor/artifacts");
  const { browserHttpFixture } = await import("../v2/browser-http-fixture.mjs");
  const { startHeartbeat } = await import("../../apps/worker/src/heartbeat");
  const { readWorkerFleetReadiness } = await import("../../apps/api/lib/worker-readiness");
  const { JobQueue } = await import("../../apps/worker/src/queue");
  const { runObjectiveIteration } = await import("../../apps/worker/src/handlers/run-objective-iteration");
  const { runWorkforceAssignment } = await import("../../apps/worker/src/handlers/run-workforce-assignment");
  const { PRODUCTION_JOB_CONTRACTS } = await import("../../apps/worker/src/job-contracts");
  const tenant = randomUUID(), actor = randomUUID(), custodian = randomUUID(), company = randomUUID(), role = randomUUID(), setupRole = randomUUID();
  const owner = { tenantId: tenant, userId: custodian, employeeId: custodian, role: "owner" as const };
  const actorRole = mode === "participant" ? "participant" : "owner";
  const released: Array<{ id: string; access: string; documentId: string; versionId: string; byteSha256: string }> = [];
  const modelCalls: Array<Record<string, unknown>> = [];
  await admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'Synthetic Birch')", [tenant, runId]);
  await admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$3,$4,$6,'active','Birch Associate'),($2,$3,$5,'owner','active','Fixture Custodian')",
    [actor, custodian, tenant, `${actor}@birch.test.invalid`, `${custodian}@birch.test.invalid`, actorRole]);
  await admin.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,'Birch','other')", [company, tenant, runId]);
  await admin.query("INSERT INTO finnor_os.employee_roles(id,tenant_id,key,name) VALUES($1,$2,'birch-associate','Birch Associate'),($3,$2,'fixture-custodian','Fixture Custodian')", [role, tenant, setupRole]);
  await admin.query("INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id,resource_scope) VALUES($1,$2,$4,'{\"kind\":\"tenant\"}'::jsonb),($1,$3,$5,'{\"kind\":\"tenant\"}'::jsonb)", [tenant, actor, custodian, role, setupRole]);
  await admin.query("INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect,max_risk,approval_required) VALUES($1,$2,'query:*','*','allow','low',false),($1,$3,'*','*','allow','high',false)", [tenant, role, setupRole]);
  await configureTenantVertical({ tenantId: tenant, verticalKey: "private_equity", expectedVersion: 0, createdBy: custodian, sourceSystem: "fixture:birch" });
  const deal = String((await createDeal({ auth: owner }, {
    name: "Birch", targetOrganizationId: company, dealLeadEmployeeId: actor,
    signedLoiAt: new Date("2026-01-05"), targetClosingAt: new Date("2026-03-31"),
  })).row.id);
  const root = { entityType: "pe_deal", entityId: deal } as const;
  await configureAgentProfile(tenant, createDefaultPluginRegistry(), {
    key: "birch-readonly", name: "Birch read-only fixture", actor: owner,
    capabilityGrants: [{ kind: "query", capability: "query:pe_world_state" }, { kind: "check", capability: "check:objective_success" }],
    autonomyLimits: { maxActions: 1, maxQueries: 11, maxReplans: 4, maxPlannerCalls: 4, maxWallClockMs: 120_000 },
  });
  for (const exhibit of exhibits.filter(row => row.stage === "T0")) {
    const artifact = await ingestArtifact(owner, {
      title: `${exhibit.id} – ${exhibit.title}.pdf`, bytes: pdf(exhibit.text), origin: "manual_upload",
      sourceSystem: "fixture:birch", sourceRef: `${exhibit.id}:${exhibit.location}:${exhibit.access}`,
    });
    const page = artifact.ir.nodes.find(node => node.kind === "page");
    if (!page) throw new Error(`${exhibit.id} missing page anchor`);
    await bindArtifact(owner, artifact.documentId, {
      versionId: artifact.version.id, anchorId: page.id, anchorHash: page.hash,
      targetKind: "canonical_entity", targetEntityType: "pe_deal", targetId: deal,
    });
    await peTransaction({ auth: owner }, (_db, client) => attachDocumentTx(client, { auth: owner }, {
      dealId: deal, entity: root, documentId: artifact.documentId, linkRole: "source",
    }));
    released.push({ id: exhibit.id, access: exhibit.access, documentId: artifact.documentId, versionId: artifact.version.id, byteSha256: artifact.version.byte_sha256 });
  }
  if (mode === "owner-denied-control") {
    const denyRole = randomUUID();
    await admin.query("INSERT INTO finnor_os.employee_roles(id,tenant_id,key,name) VALUES($1,$2,'birch-qoe-denied','Restricted QoE')", [denyRole, tenant]);
    const scope = { kind: "resources", resourceType: "document", resourceIds: released.filter(doc => doc.access === "qoe").map(doc => doc.documentId) };
    await admin.query("INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id,resource_scope) VALUES($1,$2,$3,$4)", [tenant, actor, denyRole, scope]);
    await admin.query("INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect,max_risk,approval_required) VALUES($1,$2,'query:pe_world_state','document','deny','low',false)", [tenant, denyRole]);
  }
  const observer = (): LLMProvider => ({
    name: "birch-local-observer", contextWindowTokens: 131072,
    async complete(options) {
      modelCalls.push({
        purpose: options.purpose,
        exposedExhibits: exhibits.filter(exhibit => options.user.includes(exhibit.text)).map(exhibit => exhibit.id),
        receivedVersionRefs: released.filter(exhibit => options.user.includes(exhibit.versionId)).map(exhibit => exhibit.id),
      });
      return JSON.stringify({ candidates: [] });
    },
  });
  registerProvider("birch-local-observer", observer);
  const routeTools = createRequire(import.meta.url)("../../packages/tools/src/llm.ts") as typeof import("../../packages/tools/src/llm");
  routeTools.registerProvider("birch-local-observer", observer);
  const http = await browserHttpFixture(admin, tenant, actor, custodian);
  const controller = new AbortController();
  const heartbeat = startHeartbeat(500, controller.signal);
  stop = async () => {
    controller.abort();
    try { await heartbeat.markDraining(); } finally {
      try { await http.close(); } finally { await closePool(); }
    }
  };
  const queue = new JobQueue();
  queue.register("run_objective_iteration", runObjectiveIteration, PRODUCTION_JOB_CONTRACTS.run_objective_iteration);
  queue.register("run_workforce_assignment", runWorkforceAssignment, PRODUCTION_JOB_CONTRACTS.run_workforce_assignment);
  boundary = "worker readiness";
  const readyBy = Date.now() + 10_000;
  while (true) {
    const fleet = await readWorkerFleetReadiness();
    if ((fleet.legacyCompatibleWorkers ?? 0) > 0 || fleet.computeReady) break;
    if (Date.now() >= readyBy) throw new Error("Worker heartbeat was not admitted.");
    await delay(100);
  }
  const deadline = new Date(Date.now() + 30_000);
  const attempt: Record<string, unknown> = {
    stage: "T0", requestedPrincipal: actor, actorRole, tenant, root, released, modelCalls, deadlineAt: deadline.toISOString(),
    deniedExhibits: mode === "owner-denied-control" ? ["B2"] : [],
  };
  report.attempts.push(attempt);
  await save();
  boundary = "authenticated objective intake";
  const response = await http.request("objectives", {
    objective: mandate, channel: "text", idempotencyKey: `birch:${runId}:T0`,
    activeContext: {
      version: 1, capturedAt: new Date().toISOString(), source: "text", selectedEntities: [root],
      excludedEntities: [], businessRoot: root, surface: { id: "world", route: "/centropy", spatialState: "detail" }, filters: [],
    },
    budgets: { maxActions: 0, maxSteps: 8, maxQueries: 12, maxPlannerFailures: 1, deadlineAt: deadline.toISOString() },
  });
  attempt.intake = response;
  attempt.transport = http.observed;
  await save();
  const workId = response.body.objective?.workId ?? response.body.workId;
  if (typeof workId === "string") {
    if (response.status === 202) {
      boundary = "worker/model";
      const signal = AbortSignal.timeout(Math.max(1, deadline.getTime() - Date.now()));
      process.env.DATABASE_URL = workerUrl;
      try {
        while (!signal.aborted) {
          const loop = (await admin.query("SELECT state FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND work_id=$2", [tenant, workId])).rows[0];
          if (["blocked", "failed", "completed", "cancelled", "awaiting_approval", "waiting"].includes(loop?.state)) break;
          if (!await queue.tick(signal)) await delay(150);
        }
      } finally {
        await closePool();
        process.env.DATABASE_URL = appUrl;
      }
      attempt.deadlineReached = signal.aborted;
    }
    boundary = "durable objective observation";
    attempt.work = (await http.read(`works/${workId}`));
    attempt.loop = (await admin.query("SELECT id, state, reason, success_condition FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND work_id=$2", [tenant, workId])).rows[0];
    attempt.events = (await admin.query("SELECT event_type, payload FROM finnor_os.work_events WHERE tenant_id=$1 AND work_id=$2 ORDER BY seq", [tenant, workId])).rows;
    attempt.plannerAttempts = (await admin.query("SELECT status, failure, compilation_result FROM finnor_os.work_planner_attempts WHERE tenant_id=$1 AND work_id=$2 ORDER BY attempt", [tenant, workId])).rows;
    attempt.steps = (await admin.query("SELECT phase, decision_kind, decision_reason, iteration_outcome FROM finnor_os.work_objective_steps WHERE tenant_id=$1 AND work_id=$2 ORDER BY step_number", [tenant, workId])).rows;
    attempt.actions = (await admin.query("SELECT action_type, status FROM finnor_os.domain_actions WHERE tenant_id=$1 ORDER BY created_at,id", [tenant])).rows;
    attempt.effects = (await admin.query("SELECT operation_class, status FROM finnor_os.business_effects WHERE tenant_id=$1 ORDER BY created_at", [tenant])).rows;
    attempt.jobs = (await admin.query("SELECT type, status, last_error FROM finnor_os.jobs WHERE tenant_id=$1 AND type IN ('run_objective_iteration','run_workforce_assignment') ORDER BY run_at,id", [tenant])).rows;
  }
  report.status = response.status !== 202 ? "T0_INTAKE_FAILED" : "T0_DELIVERABLE_UNVERIFIED";
  const loopReason = (attempt.loop as { reason?: string } | undefined)?.reason;
  report.failure = {
    boundary: response.status !== 202 ? "authenticated objective intake" : "verified deliverable",
    message: response.status !== 202 && typeof response.body.error === "string" ? response.body.error
      : loopReason ?? "No verified Birch memo and calculation sheet was established.",
  };
} catch (error) {
  report.status = "FAILED";
  report.failure = { boundary, message: error instanceof Error ? error.message : String(error) };
  console.error(`BIRCH_FAILED ${boundary}: ${report.failure.message}`);
} finally {
  await save();
  try { await stop?.(); } finally {
    try { await admin?.end(); } finally { if (started) await postgres?.stop(); }
  }
}
process.exit(1);
