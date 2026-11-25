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

if (!process.argv[2]) throw new Error("Provide a durable output directory: node --import=tsx scripts/pe-acceptance/participant-boundary.mts <directory>");
const output = resolve(process.argv[2]);
const mode = "participant-boundary";
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
  associateDealMemo: {
    name: "associate-deal-memo-capability", verdict: "UNMET",
    reason: "Current policy permits only owners to submit deal memo objectives. A participant standalone draft is not a deal memo.",
  },
  qualification: "Signed loopback fixture auth, ordinary Postgres role, real API handlers, local diagnostic model only, no external provider calls.",
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

const exhibitText = (text: string) => text.trim().replace(/\s+/g, " ");

function pdf(text: string) {
  const lines = [""];
  for (const word of exhibitText(text).split(" ")) {
    if (word.length > 80) throw new Error("Exhibit PDF contains an overlong word.");
    const last = lines.at(-1) ?? "";
    const next = last ? `${last} ${word}` : word;
    if (next.length <= 80) lines[lines.length - 1] = next;
    else lines.push(word);
  }
  if (lines.length > 51) throw new Error("Exhibit PDF exceeds the single-page layout.");
  const rendered = lines.map(line => `(${line.replace(/[\\()]/g, "\\$&")}) Tj`).join(" T*\n");
  const data = `BT /F1 10 Tf 14 TL 40 750 Td\n${rendered}\nET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
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
  process.env.DATABASE_URL = appUrl;

  boundary = "fixture setup";
  const { closePool, configureTenantVertical, receiveWork } = await import("@finnor/db");
  const { createDefaultPluginRegistry, registerProvider } = await import("@finnor/orchestration");
  const { configureAgentProfile } = await import("../../packages/orchestration/src/workforce-runtime");
  const { attachDocumentTx, createDeal, peTransaction } = await import("@finnor/private-equity");
  const { ingestArtifact, bindArtifact } = await import("@finnor/artifacts");
  const { browserHttpFixture } = await import("../v2/browser-http-fixture.mjs");
  const { startHeartbeat } = await import("../../apps/worker/src/heartbeat");
  const { readWorkerFleetReadiness } = await import("../../apps/api/lib/worker-readiness");
  const tenant = randomUUID(), actor = randomUUID(), custodian = randomUUID(), company = randomUUID(), role = randomUUID(), setupRole = randomUUID();
  const owner = { tenantId: tenant, userId: custodian, employeeId: custodian, role: "owner" as const };
  const actorRole = "participant";
  const released: Array<{ id: string; access: string; documentId: string; versionId: string; byteSha256: string; textVerified: boolean }> = [];
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
    if (typeof page.data.text !== "string" || exhibitText(page.data.text) !== exhibitText(exhibit.text)) {
      throw new Error(`${exhibit.id} PDF text does not match the exhibit.`);
    }
    await bindArtifact(owner, artifact.documentId, {
      versionId: artifact.version.id, anchorId: page.id, anchorHash: page.hash,
      targetKind: "canonical_entity", targetEntityType: "pe_deal", targetId: deal,
    });
    await peTransaction({ auth: owner }, (_db, client) => attachDocumentTx(client, { auth: owner }, {
      dealId: deal, entity: root, documentId: artifact.documentId, linkRole: "source",
    }));
    released.push({ id: exhibit.id, access: exhibit.access, documentId: artifact.documentId, versionId: artifact.version.id, byteSha256: artifact.version.byte_sha256, textVerified: true });
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
    deniedExhibits: [],
  };
  report.attempts.push(attempt);
  await save();
  boundary = "authenticated objective intake";
  const objectiveRequest = {
    objective: mandate, channel: "text", idempotencyKey: `birch:${runId}:T0`,
    activeContext: {
      version: 1, capturedAt: new Date().toISOString(), source: "text", selectedEntities: [root],
      excludedEntities: [], businessRoot: root, surface: { id: "world", route: "/centropy", spatialState: "detail" }, filters: [],
    },
    budgets: {
      maxActions: 0, maxSteps: 8, maxQueries: 12,
      maxPlannerFailures: 1, deadlineAt: deadline.toISOString(),
    },
  };
  const response = await http.request("objectives", objectiveRequest);
  attempt.intake = response;
  attempt.transport = http.observed;
  await save();
  const workId = response.body.objective?.workId ?? response.body.workId;
  if (typeof workId === "string") {
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
  boundary = "participant boundary observations";
  const { authorizePrivateEquityWorldState } = await import("../../packages/private-equity/src/world-state");
  const foreign = await receiveWork({ tenantId: tenant, userId: custodian, channel: "text", instruction: "Custodian's private Birch Work." });
  const evidenceRequest = { intent: "pe_world_state", root };
  const evidence = await http.request("queries", evidenceRequest, "other");
  const participantEvidenceAuthorization = await authorizePrivateEquityWorldState({
    auth: { tenantId: tenant, userId: actor, employeeId: actor, role: actorRole },
  }, root).then(() => null, (error: { code?: string; message?: string }) => ({
    code: error.code, message: error.message,
  }));
  const b2 = released.find(doc => doc.id === "B2")!;
  const missingWorkId = randomUUID();
  const draftRequest = { kind: "docx", title: "Birch standalone draft" };
  const draftText = "Draft only: request authorized evidence before drawing a conclusion.";
  const created = await http.request("artifacts", draftRequest);
  const documentPath = `documents/${created.body.documentId}/artifact`;
  const baseVersionId = created.body.version?.id;
  const drafted = await http.request(`${documentPath}/drafts`, { baseVersionId });
  const base = await http.read(`${documentPath}/ir/${baseVersionId}`);
  const anchor = base.body.nodes?.find((node: { kind: string }) => node.kind === "paragraph");
  const patchRequest = {
    baseVersionId, draftKey: drafted.body.draftKey,
    operations: [{ type: "replace_text", anchor: anchor?.id, expectedHash: anchor?.hash, text: draftText }],
  };
  const patched = await http.request(`${documentPath}/patches`, patchRequest);
  const readback = await http.read(`${documentPath}/ir/${patched.body.version?.id}`);
  const current = await http.read(documentPath);
  attempt.boundaryProof = {
    objectiveRequest, evidenceRequest, custodian, foreignWorkId: foreign.workId, missingWorkId,
    domainActionCount: Array.isArray(attempt.actions) ? attempt.actions.length : null,
    custodianWorkStatus: (await http.read(`works/${foreign.workId}`, "other")).status,
    foreignWork: await http.read(`works/${foreign.workId}`),
    missingWork: await http.read(`works/${missingWorkId}`),
    custodianEvidence: { status: evidence.status, workId: evidence.body.workId,
      includesB2: evidence.body.result?.documents?.some((doc: { id: string }) => doc.id === b2.documentId) ?? false },
    participantEvidenceAuthorization,
    foreignEvidence: await http.read(`works/${evidence.body.workId}`),
    standaloneArtifactDraft: { draftRequest, patchRequest, created, drafted, patched, readback,
      currentVersionId: current.body.version?.id, currentStatus: current.status },
  };
  report.status = "PARTICIPANT_BOUNDARY_OBSERVED";
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
process.exit(report.status === "PARTICIPANT_BOUNDARY_OBSERVED" ? 0 : 1);
