/** Complete ordinary native episode. Imported only after the no-network doctor.
 * Fixtures name existing canonical identities. They are data, not injected ports. */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { getPool, withTenantTransaction } from "../../../packages/db/index.ts";
import { appendEvidenceVersionTx } from "../../../packages/memory/src/evidence.ts";
import { authorize } from "../../../packages/private-equity/src/owner-context.ts";
import { originalObligationsTx, fenceTx, rowTx } from "../../../packages/private-equity/src/project-z/z1-shared-work/native-store.ts";
import { currentWorkInputTx } from "../../../packages/private-equity/src/project-z/z1-shared-work/resources.ts";
import { UUID, PinSchema, RootSchema, BudgetSchema, ConsumerSchema, DeclarationSchema, SourceDeclarationSchema } from "../../../packages/private-equity/src/project-z/z1-shared-work/native-contracts.ts";
import { WorkSchema, SourceSchema, ChangesSchema, RequestSchema, digest, stable, Z1_LOCK } from "../../../packages/epistemic-runtime/src/project-z/z1-shared-work/contracts.ts";
import { runtimeIdentity } from "../../../packages/private-equity/src/project-z/z1-shared-work/processes.ts";
import { PRODUCTION_JOB_CONTRACTS } from "../../../packages/db/compute-contract.ts";

const workWithoutResources = WorkSchema.omit({ resources: true });
const stageSchema = z.object({
  name: z.enum(["INITIAL", "INSERT", "RETRACT", "OBJECTIVE_EDIT", "WITHDRAW", "REACTIVATE", "REVOKE"]),
  sourceChanges: ChangesSchema.shape.sourceChanges,
  workEdits: z.array(z.object({ workId: UUID, expectedProgrammeRevision: z.string(),
    replacement: workWithoutResources }).strict()).max(3).optional(),
  withdrawWorkIds: z.array(UUID).max(3).optional(),
}).strict();
const fixtureSchema = z.object({
  schema: z.literal("finnor.z1.public-native-episode.v1"), dataClass: z.literal("PUBLIC_DETERMINISTIC_FIXTURE_NO_PII"),
  externalEffects: z.literal(false), episodeId: z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/),
  tenantId: UUID, principalId: UUID, root: RootSchema, foreignRoot: RootSchema, foreignWorkId: UUID,
  works: z.array(z.object({ work: workWithoutResources, consumer: ConsumerSchema,
    declarationSourceId: UUID, expectedDeclarationHead: PinSchema, inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
    budget: BudgetSchema }).strict()).length(3),
  sources: z.array(z.object({ source: SourceSchema, sourceId: UUID, expectedHead: PinSchema }).strict()).min(1).max(8),
  limits: z.object({ maxTicks: z.number().int().positive().max(1000000000),
    maxBytes: z.number().int().positive().max(134217728) }).strict(),
  stages: z.array(stageSchema).length(7),
}).strict();
const producer = "run_shared_work_program_v1", consumer = "consume_shared_work_projection_v1";
const jobTypes = [producer, consumer];
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const isSame = (left, right) => digest(left) === digest(right);

async function pythonOriginal(payload, root, need) {
  const executable = fileURLToPath(new URL("./original-expectations.py", import.meta.url));
  const input = Buffer.from(JSON.stringify(payload)); need(input.length <= 134217728, "ORIGINAL_ORACLE_INPUT_BOUND");
  return new Promise((resolvePromise, reject) => {
    const child = spawn("python3", [executable], { cwd: root,
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1" },
      stdio: ["pipe", "pipe", "pipe"] });
    let size = 0, diagnosticBytes = 0, timeout = false;
    const chunks = [], timer = setTimeout(() => { timeout = true; child.kill("SIGKILL"); }, 15000);
    child.stdout.on("data", chunk => { size += chunk.length; if (size > 134217728) child.kill("SIGKILL"); else chunks.push(chunk); });
    child.stderr.on("data", chunk => { diagnosticBytes += chunk.length; if (diagnosticBytes > 65536) child.kill("SIGKILL"); });
    child.stdin.on("error", () => {}); child.on("error", () => {});
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || signal || timeout || size > 134217728) return reject(Error("INDEPENDENT_ORIGINAL_EXPECTATION_PROCESS_FAILED"));
      try { resolvePromise({ expected: JSON.parse(Buffer.concat(chunks)), process: { pid: child.pid, code, signal,
        inputBytes: input.length, outputBytes: size, diagnosticBytes, source: "PUBLIC_PYTHON_FRACTION_DIRECT_ORIGINAL_PROGRAMMES" } }); }
      catch { reject(Error("INDEPENDENT_ORIGINAL_EXPECTATION_OUTPUT_INVALID")); }
    });
    child.stdin.end(input);
  });
}

export async function runNativeEpisode(guarded, output, report) {
  const { target, root, installed, need, privateJSON, sha, processIdentity, scenario } = guarded;
  try {
  const fixture = fixtureSchema.parse(guarded.fixture), ids = fixture.works.map(item => item.work.id);
  need(fixture.stages.map(stage => stage.name).join(",") === "INITIAL,INSERT,RETRACT,OBJECTIVE_EDIT,WITHDRAW,REACTIVATE,REVOKE" &&
    new Set(ids).size === 3 && new Set(fixture.works.map(item => item.work.inputRef)).size === 3 &&
    new Set(fixture.works.map(item => digest(item.work.programme))).size === 3 &&
    fixture.works.some(item => item.consumer.owner === "S3") && fixture.works.some(item => item.consumer.owner === "S4") &&
    fixture.works.some(item => item.work.unresolvedObligationRefs.length > 0), "COMPLETE_DISTINCT_ORIGINAL_NATIVE_EPISODE_REQUIRED");
  need(fixture.sources.every(item => item.expectedHead.sourceId === item.sourceId) &&
    fixture.works.every(item => item.expectedDeclarationHead.sourceId === item.declarationSourceId &&
      item.budget.workId === item.work.id && isSame(item.budget.root, fixture.root) &&
      item.work.partition.tenantId === fixture.tenantId && item.work.partition.principalId === fixture.principalId &&
      item.work.partition.permittedUse === "Z1_EXACT_DERIVATION_FOR_ORIGINAL_WORK"),
    "EXACT_PUBLIC_FIXTURE_ORIGINAL_IDENTITIES_REQUIRED");
  need(jobTypes.every(type => PRODUCTION_JOB_CONTRACTS[type]?.retrySafety === "locally_idempotent" &&
    PRODUCTION_JOB_CONTRACTS[type]?.leaseRecovery === "immediate_after_expiry"),
    "COORDINATOR_NATIVE_JOB_CONTRACT_NOT_INSTALLED");
  need(target.authorization.noOtherWorkers === true && target.authorization.realDisposableAuthProject === true &&
    /^[a-f0-9]{64}$/.test(target.schemaCatalogSha256 ?? "") && /^[a-f0-9]{64}$/.test(target.browserExecutableSha256 ?? "") &&
    /^[0-9]{4}[a-z]?_[a-z0-9_]+\.sql$/.test(target.appliedMigration ?? "") &&
    target.nativeSchemaSha256 === sha(await readFile(new URL("./shared-schema.sql", import.meta.url))),
    "EXPLICIT_INSTALLED_SCHEMA_BROWSER_AND_EXCLUSIVE_WORKER_CUSTODY_REQUIRED");
  const runtime = await runtimeIdentity(); need(runtime.digest === installed.nativeRuntimeDigest, "CURRENT_NATIVE_BUILD_REQUIRED");
  const scoped = (fn, readOnly = false) => withTenantTransaction(fixture.tenantId,
    { userId: fixture.principalId, readOnly }, (db, client) => fn(client, db));
  const auth = { tenantId: fixture.tenantId, userId: fixture.principalId, employeeId: fixture.principalId, role: "owner" };
  const ctx = { auth };
  const require = createRequire(resolve(root, "package.json"));
  const { chromium, expect } = require("@playwright/test");
  need(sha(await readFile(chromium.executablePath())) === target.browserExecutableSha256, "EXACT_OWN_BROWSER_INSTALL_REQUIRED");
  const dbIdentity = (await getPool().query(`SELECT current_database() name,current_user role,
    (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) elevated,
    extract(epoch FROM pg_postmaster_start_time())::text started`)).rows[0];
  need(dbIdentity.name === target.database.name && dbIdentity.role === target.database.role && dbIdentity.elevated === false,
    "NONPRIVILEGED_OWN_DATABASE_IDENTITY_REQUIRED");
  const catalog = (await getPool().query(`SELECT p.proname,pg_get_function_identity_arguments(p.oid) args,
    pg_get_functiondef(p.oid) body FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='finnor_os' AND p.proname LIKE 'z1_%' ORDER BY p.proname,args`)).rows;
  need(catalog.length >= 10 && digest(catalog) === target.schemaCatalogSha256, "EXACT_INSTALLED_NATIVE_SCHEMA_CATALOG_REQUIRED");
  need((await getPool().query("SELECT name FROM finnor_os._migrations WHERE name=$1", [target.appliedMigration])).rowCount === 1,
    "COORDINATOR_APPLIED_SCHEMA_RECEIPT_REQUIRED");
  const assertQueueOwned = async () => {
    const rows = (await getPool().query(`SELECT id,type,tenant_id,payload->>'principalId' principal,
      payload->>'requestId' request_id FROM finnor_os.jobs
      WHERE status IN('queued','running','failed','dead_letter') ORDER BY id LIMIT 257`)).rows;
    need(rows.length <= 256 && rows.every(row => jobTypes.includes(row.type) && row.tenant_id === fixture.tenantId &&
      row.principal === fixture.principalId && row.request_id === report.requestId), "EXCLUSIVE_OWN_NATIVE_QUEUE_REQUIRED");
  };
  await assertQueueOwned();
  const policies = (await getPool().query("SELECT job_type,default_class,classification_rule,tenant_scope FROM finnor_os.compute_job_type_policies WHERE job_type=ANY($1::text[]) ORDER BY job_type", [jobTypes])).rows;
  const provider = (await getPool().query("SELECT capacity,per_tenant_capacity,lease_seconds FROM finnor_os.compute_resource_policies WHERE resource_key='provider:z1-shared-work-native'")).rows[0];
  need(policies.length === 2 && policies.every(row => row.default_class === "INTERACTIVE" && row.classification_rule === "fixed" &&
    row.tenant_scope === "tenant") && provider?.capacity === 1 && provider?.per_tenant_capacity === 1 && provider?.lease_seconds === 90,
    "INSTALLED_SERIAL_NATIVE_COMPUTE_POLICIES_REQUIRED");
  need(fixture.works.every(item => Date.parse(item.budget.deadlineAt) > Date.now() + 600000),
    "ORIGINAL_DEADLINE_MUST_ALLOW_BOUNDED_REAL_LEASE_RECOVERY_WITHOUT_RENEWAL");
  const sourceHeads = new Map(), sourceIds = [...fixture.sources.map(item => item.sourceId),
    ...fixture.works.map(item => item.declarationSourceId)];
  need(new Set(sourceIds).size === sourceIds.length, "DISTINCT_CANONICAL_FIXTURE_S1_SOURCES_REQUIRED");
  await scoped(async c => {
    await authorize(ctx, fixture.root, ids.map(id => ({ type: "work", id })), sourceIds, c);
    for (const item of fixture.works) {
      const cut = await currentWorkInputTx(ctx, c, item.work.id, fixture.root);
      need(cut.inputId === item.work.inputRef && cut.inputDigest === item.inputDigest &&
        isSame(await originalObligationsTx(ctx, c, item.work.id), [...item.work.unresolvedObligationRefs].sort()),
        "EXACT_EXISTING_NATIVE_WORK_INPUT_AND_S6_REQUIRED");
    }
    for (const sourceId of sourceIds) {
      const expected = fixture.sources.find(item => item.sourceId === sourceId)?.expectedHead ??
        fixture.works.find(item => item.declarationSourceId === sourceId).expectedDeclarationHead;
      const head = (await c.query(`SELECT id::text,content_hash,snapshot FROM finnor_os.evidence_source_versions
        WHERE tenant_id=$1 AND source_id=$2 ORDER BY version_number DESC,id DESC LIMIT 1`,
      [fixture.tenantId, sourceId])).rows[0];
      need(head && head.id === expected.versionId && head.content_hash === expected.contentDigest &&
        head.snapshot.z1FixtureEpisode === fixture.episodeId && isSame(head.snapshot.worldRoot, fixture.root) &&
        head.snapshot.protectionDomain === "DISPOSABLE_LOCAL_DEVELOPMENT" && head.snapshot.externalEffects === false,
        "EXACT_EXISTING_PUBLIC_FIXTURE_SOURCE_CUSTODY_REQUIRED");
      sourceHeads.set(sourceId, { pin: expected, snapshot: head.snapshot });
    }
  });
  await privateJSON(resolve(output, "native-doctor.json"), { runtime, database: dbIdentity, policies, provider,
    catalogSha256: digest(catalog), migration: target.appliedMigration, originalWorkIds: ids,
    originalInputs: fixture.works.map(item => ({ workId: item.work.id, inputId: item.work.inputRef, inputDigest: item.inputDigest })),
    canonicalSourceIds: sourceIds, actionsStillUntouched: true });

  let browser, context, page, bearer = null, networkDenied = 0;
  const workers = new Set(), physical = [], staleClaims = [];
  const identity = await processIdentity(process.pid);
  const audit = async action => {
    report.actions.push({ index: report.actions.length, at: new Date().toISOString(), ...action });
    await privateJSON(resolve(output, `action-${String(report.actions.length).padStart(3, "0")}.json`), report.actions.at(-1));
  };
  async function post(operation, body, statuses = [200], credential = bearer) {
    const response = await page.request.post(new URL(`/api/centropy/company-brain/${operation}`, target.frontend).href,
      { data: body, headers: credential ? { authorization: credential } : {}, timeout: 65000 });
    need(statuses.includes(response.status()), "AUTHENTICATED_NATIVE_HTTP_EXPECTATION_FAILED");
    need(/no-store/.test(response.headers()["cache-control"] ?? ""), "PRIVATE_NATIVE_RESPONSE_MUST_NOT_BE_CACHED");
    const value = await response.json();
    return { status: response.status(), body: value };
  }
  async function mount(workId) {
    const url = new URL("/centropy/world", target.frontend);
    url.searchParams.set("root", JSON.stringify(fixture.root)); url.searchParams.set("workId", workId);
    url.searchParams.set("object", JSON.stringify({ namespace: "core", owner: "@finnor/db", type: "work", id: workId }));
    await page.goto(url.href); const panel = page.locator(`[data-z1-work-id="${workId}"]`);
    await expect(panel).toBeVisible({ timeout: 30000 }); return panel;
  }
  async function uiWrite(workId, operation, body) {
    const panel = await mount(workId);
    const pending = page.waitForResponse(response => response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/api/centropy/company-brain/${operation}`, { timeout: 65000 });
    void pending.catch(() => {});
    if (["z1-reserve-original-budget", "z1-submit-shared-work"].includes(operation)) {
      const details = panel.locator("details").filter({ has: page.getByLabel("Canonical Z1 intake JSON") });
      if (await details.getAttribute("open") === null) await details.locator("summary").click();
      await panel.getByLabel("Canonical Z1 intake JSON").fill(JSON.stringify(body));
      await panel.getByRole("button", { name: operation === "z1-reserve-original-budget" ?
        "Reserve original S5 budget" : "Submit canonical shared programme", exact: true }).click();
    } else await panel.getByRole("button", { name: operation === "z1-admit-shared-work" ?
      "Admit checked derivation for original owner use" : "Cancel request, retain costs and obligations", exact: true }).click();
    const response = await pending;
    need(response.status() === 200 && /no-store/.test(response.headers()["cache-control"] ?? ""), "MOUNTED_NATIVE_WRITE_FAILED");
    const result = await response.json(); await audit({ kind: "AUTHENTICATED_MOUNTED_ACTION", operation, workId,
      inputDigest: digest(body), responseDigest: digest(result), status: response.status() }); return result;
  }
  async function snapshot() {
    return scoped(async c => {
      const row = (await c.query(`SELECT id,generation,status,request_digest,deadline_at,attempts_used,wall_used_ms,
        wall_reserved_ms,retained_bytes::text,storage_charged_bytes::text,checkpoint->'charges' logical_charges
        FROM finnor_os.z1_requests WHERE tenant_id=$1 AND principal_id=$2 AND id=$3`,
      [fixture.tenantId, fixture.principalId, report.requestId])).rows[0];
      const parents = (await c.query(`SELECT s.reservation_id,s.status,s.envelopes,o.body->'original' original,
        coalesce((SELECT jsonb_object_agg(resource_id,used) FROM (SELECT resource_id,sum(units)::text used
          FROM finnor_os.s5_governed_resource_charges g WHERE g.tenant_id=s.tenant_id AND g.reservation_id=s.reservation_id
          GROUP BY resource_id) q),'{}'::jsonb) used,
        coalesce((SELECT sum((co.body->>'maximumUnits')::bigint)::text FROM finnor_os.s5_consumptions co
          JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id)
          WHERE co.tenant_id=s.tenant_id AND co.reservation_id=s.reservation_id
          AND co.body->>'schema'='finnor.s5.z1-compute-hold.v1' AND st.status<>'RECONCILED'),'0') pending_cpu
        FROM finnor_os.s5_reservations s JOIN finnor_os.s5_reservation_origins o USING(tenant_id,reservation_id)
        WHERE s.tenant_id=$1 AND o.principal_id=$2 AND o.body->>'schema'='finnor.s5.z1-original-budget.v1'
          AND o.body#>>'{original,workId}'=ANY($3::text[]) ORDER BY s.reservation_id`,
      [fixture.tenantId, fixture.principalId, ids])).rows;
      const obligations = {};
      for (const id of ids) obligations[id] = await originalObligationsTx(ctx, c, id);
      const uses = (await c.query("SELECT publication_id,work_id,semantic_owner,reference,body,receipt FROM finnor_os.z1_owner_uses WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3 ORDER BY publication_id,work_id",
        [fixture.tenantId, fixture.principalId, report.requestId])).rows;
      const attempts = (await c.query("SELECT id,delivery_id,status,costs_unknown,body,reserved_wall_ms FROM finnor_os.z1_attempts WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3 ORDER BY created_at,id",
        [fixture.tenantId, fixture.principalId, report.requestId])).rows;
      const workStates = (await c.query("SELECT id,status,final_outcome FROM finnor_os.works WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id",
        [fixture.tenantId, ids])).rows.map(item => ({ id: item.id, status: item.status, finalOutcomeDigest: digest(item.final_outcome) }));
      const effects = (await c.query("SELECT id,status,semantic_hash FROM finnor_os.business_effects WHERE tenant_id=$1 ORDER BY id LIMIT 4097",
        [fixture.tenantId])).rows;
      const actions = (await c.query("SELECT id,status FROM finnor_os.domain_actions WHERE tenant_id=$1 ORDER BY id LIMIT 4097",
        [fixture.tenantId])).rows;
      need(effects.length <= 4096 && actions.length <= 4096, "COMPLETE_FINITE_DISPOSABLE_EFFECT_INVENTORY_REQUIRED");
      return { row, parents, obligations, uses, attempts, workStates, effectInventoryDigest: digest(effects),
        actionInventoryDigest: digest(actions), effectCount: effects.length, actionCount: actions.length };
    }, true);
  }
  const assertConserved = (before, after) => {
    need(before.parents.length === 3 && after.parents.length === 3 && isSame(before.obligations, after.obligations),
      "ORIGINAL_S5_S6_IDENTITY_CONSERVATION_FAILED");
    need(isSame(before.workStates, after.workStates) && before.effectInventoryDigest === after.effectInventoryDigest &&
      before.actionInventoryDigest === after.actionInventoryDigest, "UNAUTHORIZED_WORK_COMPLETION_OR_EFFECT_CHANGE_OBSERVED");
    if (before.row) need(after.row?.id === before.row.id &&
      new Date(after.row.deadline_at).getTime() === new Date(before.row.deadline_at).getTime() &&
      after.row.wall_used_ms + after.row.wall_reserved_ms >= before.row.wall_used_ms + before.row.wall_reserved_ms,
      "ORIGINAL_EPISODE_DEADLINE_OR_WALL_RENEWED");
    for (const parent of before.parents) {
      const next = after.parents.find(item => item.reservation_id === parent.reservation_id);
      need(next && next.status !== "RELEASED" && isSame(parent.original, next.original) && isSame(parent.envelopes, next.envelopes),
        "ORIGINAL_PARENT_RESERVATION_RENEWED_OR_RELEASED");
      for (const [resourceId, used] of Object.entries(parent.used))
        need(BigInt(next.used[resourceId] ?? "0") >= BigInt(used), "ORIGINAL_RESOURCE_CHARGE_DECREASED");
    }
  };
  async function appendFixture(sourceId, property, declaration) {
    const previous = sourceHeads.get(sourceId);
    const result = await scoped(async (c, db) => {
      await authorize(ctx, fixture.root, [], [sourceId], c);
      const current = (await c.query(`SELECT id::text,content_hash FROM finnor_os.evidence_source_versions
        WHERE tenant_id=$1 AND source_id=$2 ORDER BY version_number DESC,id DESC LIMIT 1 FOR SHARE`,
      [fixture.tenantId, sourceId])).rows[0];
      need(current.id === previous.pin.versionId && current.content_hash === previous.pin.contentDigest, "PUBLIC_FIXTURE_APPEND_PREIMAGE_CHANGED");
      const snapshot = { ...previous.snapshot, [property]: declaration };
      const version = await appendEvidenceVersionTx(db, fixture.tenantId, sourceId,
        { content: stable(declaration), snapshot, entityRefs: ids });
      return { pin: { sourceId, versionId: version.versionId, contentDigest: version.contentHash }, snapshot };
    });
    sourceHeads.set(sourceId, result);
    await audit({ kind: "CANONICAL_EXISTING_PUBLIC_S1_APPEND", sourceId, property,
      priorPin: previous.pin, pin: result.pin, declarationDigest: digest(declaration) }); return result.pin;
  }
  async function worker(boundary = null, expectLogicalRefusal = false, recoverTerminalOnly = false) {
    await assertQueueOwned();
    const nonce = randomBytes(32).toString("hex"), loader = resolve(root, "finnor-os/node_modules/tsx/dist/loader.mjs");
    const child = spawn(process.execPath, ["--max-old-space-size=1536", "--import", loader,
      fileURLToPath(new URL("./native-worker.mjs", import.meta.url))], { cwd: resolve(root, "finnor-os"),
      env: { PATH: process.env.PATH, LANG: "C.UTF-8", NODE_ENV: "development", PYTHONDONTWRITEBYTECODE: "1",
        TSX_DISABLE_CACHE: "1", TSX_TSCONFIG_PATH: resolve(root, "finnor-os/tsconfig.json"),
        DATABASE_URL: process.env.DATABASE_URL, PGAPPNAME: "z1-owned-native-proof",
        FINNOR_Z1_NATIVE_AUTHORIZED: "DISPOSABLE_ORIGINAL_Z1_EPISODE_ONLY",
        FINNOR_ENVIRONMENT: "ordinary_disposable", FINNOR_Z1_PROFILE: "ordinary_disposable", P3_GOVERNORS: "1",
        FINNOR_Z1_RECOVERY_NONCE: nonce, FINNOR_Z1_RECOVERY_BOUNDARY: boundary ?? "",
        FINNOR_Z1_RECOVERY_REQUEST: report.requestId },
      stdio: ["ignore", "pipe", "pipe", "ipc"] });
    workers.add(child);
    let diagnosticBytes = 0, killed = false, owned, failure = null, capturedClaim, crashSnapshot, logicalRefusalObserved = false;
    const exited = new Promise((resolveExit, reject) => {
      const timer = setTimeout(() => { failure = "OWNED_NATIVE_WORKER_BOUND"; child.kill("SIGKILL"); }, 125000);
      child.stdout.on("data", chunk => { diagnosticBytes += chunk.length; if (diagnosticBytes > 1048576) child.kill("SIGKILL"); });
      child.stderr.on("data", chunk => { diagnosticBytes += chunk.length; if (diagnosticBytes > 1048576) child.kill("SIGKILL"); });
      child.on("error", () => { failure = "OWNED_NATIVE_WORKER_LAUNCH_FAILED"; });
      child.on("message", message => {
        if (message?.kind === "FAILED") { failure = "OWNED_NATIVE_QUEUE_FLOW_FAILED"; return; }
        if (message?.schema !== "finnor.z1.owned-physical-boundary.v1") return;
        void (async () => {
          need(boundary && message.boundary === boundary && message.nonce === nonce && message.pid === child.pid &&
            message.requestId === report.requestId && !killed, "EXACT_OWNED_NATIVE_RECOVERY_RENDEZVOUS_REQUIRED");
          owned = await processIdentity(child.pid);
          need(owned.uid === identity.uid, "EXACT_OWNED_NATIVE_WORKER_UID_REQUIRED");
          capturedClaim = await scoped(async c => {
            const job = (await c.query("SELECT * FROM finnor_os.jobs WHERE id=$1 AND tenant_id=$2 AND status='running'",
              [message.jobId, fixture.tenantId])).rows[0];
            need(job && Number(job.claim_fence) === message.claimFence && job.payload.requestId === report.requestId,
              "DURABLE_NATIVE_CLAIM_BOUNDARY_NOT_OBSERVED");
            const permit = (await c.query(`SELECT resource_key,owner_id,expires_at FROM finnor_os.compute_resource_leases
              WHERE resource_key='provider:z1-shared-work-native' AND tenant_key=$1
              AND owner_id=$2 AND released_at IS NULL ORDER BY expires_at DESC LIMIT 1`,
            [fixture.tenantId, message.deliveryAttemptId])).rows[0];
            need(permit && new Date(permit.expires_at).getTime() > Date.now(), "DURABLE_NATIVE_SERIAL_PERMIT_NOT_OBSERVED");
            return { job, message, permit };
          }, true);
          crashSnapshot = await snapshot();
          need(isSame(owned, await processIdentity(child.pid)), "OWNED_NATIVE_WORKER_IDENTITY_CHANGED_BEFORE_SIGNAL");
          killed = child.kill("SIGKILL"); need(killed, "OWNED_NATIVE_WORKER_NOT_SIGNALED");
        })().catch(() => { failure = "OWNED_NATIVE_RECOVERY_OBSERVATION_FAILED"; child.kill("SIGKILL"); });
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer); workers.delete(child);
        if (failure || boundary && (!killed || signal !== "SIGKILL")) reject(Error(failure ?? "PHYSICAL_NATIVE_SIGKILL_NOT_OBSERVED"));
        else resolveExit({ pid: child.pid, identity: owned ?? null, code, signal, diagnosticBytes, killed, boundary });
      });
    });
    void exited.catch(() => {});
    if (!boundary) {
      for (let poll = 0; poll < 200; poll++) {
        if (expectLogicalRefusal) {
          logicalRefusalObserved = await scoped(async c => Boolean((await c.query(
            `SELECT q.id FROM finnor_os.z1_requests q WHERE q.tenant_id=$1 AND q.principal_id=$2 AND q.id=$3
             AND q.status='INCOMPLETE' AND EXISTS(SELECT 1 FROM finnor_os.z1_events e
               WHERE e.tenant_id=q.tenant_id AND e.request_id=q.id
               AND e.body->>'kind'='PRIOR_PRODUCER_LOGICAL_EXPOSURE_UNRESOLVED')`,
            [fixture.tenantId, fixture.principalId, report.requestId])).rows[0]), true);
          if (logicalRefusalObserved) { child.send({ kind: "STOP" }); break; }
        }
        const pending = (await getPool().query(`SELECT count(*)::int n FROM finnor_os.jobs
          WHERE tenant_id=$1 AND type=ANY($2::text[]) AND payload->>'requestId'=$3
          AND ((NOT $4::boolean AND status<>'completed') OR ($4::boolean AND status IN('queued','running')))`,
        [fixture.tenantId, jobTypes, report.requestId, recoverTerminalOnly])).rows[0].n;
        if (pending === 0 && !expectLogicalRefusal) { child.send({ kind: "STOP" }); break; }
        if (child.exitCode !== null || child.signalCode !== null) break;
        await wait(250);
      }
    }
    const exit = await exited;
    if (!boundary) need(exit.code === 0 && exit.signal === null, "BOUNDED_NATIVE_WORKER_DID_NOT_COMPLETE");
    if (expectLogicalRefusal) need(logicalRefusalObserved, "DURABLE_ORIGINAL_LOGICAL_EXPOSURE_REFUSAL_NOT_OBSERVED");
    if (boundary) {
      physical.push(exit);
      await privateJSON(resolve(output, `physical-${physical.length}-${boundary.toLowerCase()}.json`), { exit, snapshot: crashSnapshot,
        claim: { jobId: capturedClaim.job.id, deliveryAttemptId: capturedClaim.message.deliveryAttemptId,
          claimFence: capturedClaim.job.claim_fence, leaseExpiresAt: capturedClaim.job.lease_expires_at },
        serialPermit: capturedClaim.permit,
        interruptedCosts: "UNKNOWN_RETAINED_NOT_ZERO" });
      staleClaims.push(capturedClaim);
      // The provider's 90-second serial permit outlives the 30-second job lease.
      // Observe and await both. Never edit either lease or consume a retry while
      // the lost worker's original physical-capacity permit remains outstanding.
      const milliseconds = Math.max(new Date(capturedClaim.job.lease_expires_at).getTime(),
        new Date(capturedClaim.permit.expires_at).getTime()) - Date.now() + 250;
      need(milliseconds <= 91000, "EXPLICIT_BOUNDED_REAL_NATIVE_LEASE_REQUIRED");
      if (milliseconds > 0) await wait(milliseconds);
    }
    return exit;
  }
  try {
    browser = await chromium.launch({ headless: true, chromiumSandbox: true,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8" } });
    context = await browser.newContext();
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if ([target.frontend.replace(/\/$/, ""), target.api.replace(/\/$/, "")].includes(url.origin) ||
        url.origin === target.authOrigin && url.pathname.startsWith("/auth/v1/")) return route.continue();
      networkDenied++; return route.abort("blockedbyclient");
    });
    await context.routeWebSocket("**/*", socket => { networkDenied++; socket.close(); });
    page = await context.newPage(); page.setDefaultTimeout(30000);
    await page.goto(new URL("/centropy/login", target.frontend).href);
    await expect(page.getByRole("heading", { name: "Sign in to CENTROPY", exact: true })).toBeVisible();
    await page.getByLabel("Email", { exact: true }).fill(process.env.TEST_OWNER_EMAIL);
    await page.getByLabel("Password", { exact: true }).fill(process.env.TEST_OWNER_PASSWORD);
    const mePromise = page.waitForResponse(response => response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/api/centropy/me");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    const meResponse = await mePromise, me = await meResponse.json();
    need(meResponse.status() === 200 && me.role === "owner" && me.userId === fixture.principalId &&
      me.employeeId === fixture.principalId && me.tenantId === fixture.tenantId, "REAL_AUTHENTICATED_ORIGINAL_OWNER_REQUIRED");
    bearer = (await meResponse.request().allHeaders()).authorization;
    need(/^Bearer \S+$/.test(bearer ?? ""), "REAL_CALLER_BEARER_REQUIRED");
    const tokenClaims = JSON.parse(Buffer.from(bearer.split(" ")[1].split(".")[1], "base64url").toString());
    need(tokenClaims.iss === `${target.authOrigin.replace(/\/$/, "")}/auth/v1`, "REAL_MATCHING_AUTH_PROJECT_REQUIRED");
    await audit({ kind: "REAL_AUTH_OWNER_AND_MOUNT", role: me.role, principalId: me.userId, tenantId: me.tenantId });
    for (const id of ids) await mount(id);
    await post("z1-project-original-work", { root: fixture.root, workId: fixture.foreignWorkId }, [403, 404]);
    await post("z1-project-original-work", { root: fixture.foreignRoot, workId: ids[0] }, [403, 404]);
    await post("z1-project-original-work", { root: fixture.root, workId: ids[0], role: "owner" }, [400]);
    await post("z1-project-original-work", { root: fixture.root, workId: ids[0] }, [401], null);
    await audit({ kind: "AUTHENTICATED_FOREIGN_SCOPE_RAW_ROLE_AND_ANONYMOUS_REFUSED" });
    report.mutationsStarted = true;
    const budgets = [];
    for (const item of fixture.works) budgets.push(await uiWrite(item.work.id, "z1-reserve-original-budget", item.budget));
    const initial = RequestSchema.parse({ schema: "finnor.z1.request.v1",
      identity: { productLockDigest: Z1_LOCK, sourceCommit: installed.sourceCommit, sourceTree: installed.sourceTree,
        producerBuildIdentity: runtime.digest, checkerIdentity: "z1-original-fraction-v1",
        ownerConsumerContractVersion: "z1-per-original-work-v1", reconstructionReference: installed.reconstructionReference },
      sources: fixture.sources.map(item => item.source).sort((a, b) => a.id < b.id ? -1 : 1),
      works: fixture.works.map((item, index) => ({ ...item.work, resources: {
        mandateRef: `original-work:${item.work.id}`, assignmentRef: `work-input:${budgets[index].inputId}`,
        parentReservationRef: budgets[index].ref.id, remainingBudgetRef: budgets[index].ref.contentDigest,
        originalDeadline: budgets[index].original.deadlineAt, remainingTicks: String(budgets[index].original.maximumTicks) } })),
      limits: { ...fixture.limits, deadlineAt: new Date(Math.min(...budgets.map(item => Date.parse(item.original.deadlineAt)))).toISOString() } });
    let previousRequest = initial, previousSnapshot = await snapshot(), generation = 0, latestPublication;
    const consumers = Object.fromEntries(fixture.works.map(item => [item.work.id, item.consumer]));
    for (const [index, stage] of fixture.stages.entries()) {
      const changes = ChangesSchema.parse({
        ...(stage.sourceChanges ? { sourceChanges: stage.sourceChanges } : {}),
        ...(stage.withdrawWorkIds ? { withdrawWorkIds: stage.withdrawWorkIds } : {}),
        ...(stage.workEdits ? { workEdits: stage.workEdits.map(edit => ({ ...edit, replacement: {
          ...edit.replacement, resources: previousRequest.works.find(work => work.id === edit.workId).resources } })) } : {}),
      });
      const oracle = await pythonOriginal({ request: previousRequest, ...(index ? { changes } : {}), consumers }, root, need);
      const request = RequestSchema.parse(oracle.expected.request);
      await privateJSON(resolve(output, `original-${index}-${stage.name.toLowerCase()}.json`), oracle);
      // Persist independent originals before producing or inspecting shared output.
      for (const source of request.sources) {
        const item = fixture.sources.find(item => item.source.id === source.id);
        await appendFixture(item.sourceId, "z1Source", SourceDeclarationSchema.parse({ schema: "finnor.z1.source-declaration.v1", source }));
      }
      const pins = [];
      for (const [workIndex, work] of request.works.entries()) {
        const item = fixture.works[workIndex], used = [...new Set(work.programme.nodes.filter(node => node.op === "source").map(node => node.sourceId))];
        const declaration = DeclarationSchema.parse({ schema: "finnor.z1.original-work-declaration.v1", work,
          consumer: item.consumer, parentReservation: budgets[workIndex].ref,
          sourcePins: used.map(id => sourceHeads.get(fixture.sources.find(item => item.source.id === id).sourceId).pin) });
        const pin = await appendFixture(item.declarationSourceId, "z1OriginalWork", declaration); pins.push({ workId: work.id, declaration: pin });
      }
      const intake = { root: fixture.root, idempotencyKey: `${fixture.episodeId}:${index}`, works: pins, limits: fixture.limits,
        ...(index ? { previous: { requestId: report.requestId, generation, changes } } : {}) };
      const submitted = await uiWrite(ids[0], "z1-submit-shared-work", intake);
      need(!report.requestId || report.requestId === submitted.requestId, "ORIGINAL_NATIVE_REQUEST_ID_CHANGED");
      report.requestId = submitted.requestId; generation = submitted.generation;
      const canonical = (await post("z1-read-shared-work", { root: fixture.root, requestId: report.requestId, view: "ORIGINAL_REQUEST" })).body;
      need(isSame(canonical.request, request) && canonical.requestDigest === oracle.expected.requestDigest,
        "CANONICAL_NATIVE_INTAKE_DIFFERS_FROM_INDEPENDENT_ORIGINAL");
      if (scenario === "EXHAUSTED_EPISODE_PREFIX") {
        need(index === 0, "BOUNDED_INITIAL_EPISODE_EXHAUSTION_ONLY");
        for (let interruption = 0; interruption < 4; interruption++) await worker("CLAIM");
        const interrupted = await snapshot(); assertConserved(previousSnapshot, interrupted);
        need(interrupted.row.attempts_used === 4 && interrupted.attempts.length === 4 &&
          interrupted.row.wall_reserved_ms === 120000 && interrupted.row.wall_used_ms === 0 &&
          interrupted.row.logical_charges === null && interrupted.uses.length === 0 &&
          interrupted.attempts.every(attempt => attempt.reserved_wall_ms === 30000),
          "ORIGINAL_NATIVE_EPISODE_WAS_NOT_PHYSICALLY_EXHAUSTED");
        await worker(null, false, true);
        const terminalJobs = await scoped(async c => (await c.query(
          `SELECT id,status,attempts,max_attempts FROM finnor_os.jobs
           WHERE tenant_id=$1 AND type='run_shared_work_program_v1' AND payload->>'requestId'=$2 ORDER BY id`,
          [fixture.tenantId, report.requestId])).rows, true);
        need(terminalJobs.length === 1 && terminalJobs[0].status === "dead_letter" &&
          terminalJobs[0].attempts === 4 && terminalJobs[0].max_attempts === 4,
          "CANONICAL_EXHAUSTED_JOB_WAS_NOT_RETIRED");
        const counters = () => scoped(async c => (await c.query(
          `SELECT
           (SELECT count(*)::text FROM finnor_os.z1_artifacts
            WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3) artifacts,
           (SELECT count(*)::text FROM finnor_os.compute_resource_leases
            WHERE resource_key='provider:z1-shared-work-native' AND tenant_key=$1::text) permits,
           (SELECT count(*)::text FROM finnor_os.jobs
            WHERE tenant_id=$1 AND payload->>'requestId'=$3::text) jobs,
           (SELECT count(*)::text FROM finnor_os.job_delivery_attempts a JOIN finnor_os.jobs j ON j.id=a.job_id
            WHERE j.tenant_id=$1 AND j.payload->>'requestId'=$3::text) deliveries,
           (SELECT count(*)::text FROM finnor_os.z1_events WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3
            AND body->>'kind'='ORIGINAL_NATIVE_EPISODE_EXHAUSTED') refusals`,
          [fixture.tenantId, fixture.principalId, report.requestId])).rows[0], true);
        const recovered = await snapshot(), beforeReadCounters = await counters();
        const panel = await mount(ids[0]); await page.reload();
        await expect(panel.locator(`[data-z1-request-id="${report.requestId}"]`)).toHaveAttribute("data-z1-status", "INCOMPLETE");
        const beforeReplay = await snapshot(), afterReadCounters = await counters();
        assertConserved(recovered, beforeReplay);
        need(beforeReplay.row.status === recovered.row.status && beforeReadCounters.refusals === "0" &&
          isSame(beforeReadCounters, afterReadCounters), "READ_ONLY_NATIVE_PROJECTION_MUTATED_DURABLE_STATE");
        const replay = await uiWrite(ids[0], "z1-submit-shared-work", intake);
        need(replay.replayed === true && replay.requestId === report.requestId && replay.generation === generation &&
          replay.status === "INCOMPLETE", "EXHAUSTED_INTAKE_REPLAY_DID_NOT_COMMIT_REFUSAL");
        const blocked = await snapshot(); assertConserved(beforeReplay, blocked);
        const evidence = await scoped(async c => {
          const events = (await c.query(
            `SELECT event_key,body->>'kind' kind,CASE WHEN body->>'kind'='ORIGINAL_NATIVE_EPISODE_EXHAUSTED'
             THEN body ELSE NULL END refusal FROM finnor_os.z1_events
             WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3 ORDER BY created_at,id LIMIT 257`,
            [fixture.tenantId, fixture.principalId, report.requestId])).rows;
          const persisted = (await c.query(
            "SELECT checkpoint IS NOT NULL has_checkpoint,publication IS NOT NULL has_publication FROM finnor_os.z1_requests WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
            [fixture.tenantId, fixture.principalId, report.requestId])).rows[0];
          return { events, ...persisted };
        }, true);
        const afterReplayCounters = await counters();
        const refusals = evidence.events.filter(event => event.kind === "ORIGINAL_NATIVE_EPISODE_EXHAUSTED");
        need(blocked.row.status === "INCOMPLETE" && blocked.row.generation === generation &&
          blocked.row.attempts_used === 4 && blocked.attempts.length === 4 &&
          blocked.attempts.every(attempt => attempt.status === "LOST_UNKNOWN" && attempt.costs_unknown) &&
          blocked.row.wall_reserved_ms === 120000 && blocked.row.wall_used_ms === 0 &&
          blocked.row.logical_charges === null && blocked.uses.length === 0 &&
          evidence.events.length <= 256 && refusals.length === 1 &&
          !evidence.events.some(event => event.event_key.startsWith("pid:") || event.kind === "DURABLE_CHECKPOINT") &&
          !evidence.has_checkpoint && !evidence.has_publication &&
          afterReplayCounters.artifacts === afterReadCounters.artifacts &&
          afterReplayCounters.permits === afterReadCounters.permits && afterReplayCounters.jobs === afterReadCounters.jobs &&
          afterReplayCounters.deliveries === "4" && afterReadCounters.deliveries === "4" && afterReplayCounters.refusals === "1" &&
          refusals[0].refusal.attemptsUsed === 4 && refusals[0].refusal.maximumAttempts === 16 &&
          refusals[0].refusal.wallReservedMs === 120000 && refusals[0].refusal.maximumWallMs === 120000 &&
          refusals[0].refusal.originalParentsCpuWallAndLogicalLiabilityRetained === true &&
          refusals[0].refusal.newComputationAuthorized === false,
          "EXHAUSTED_ORIGINAL_NATIVE_EPISODE_WAS_RENEWED_OR_REFUSAL_NOT_DURABLE");
        for (const parent of beforeReplay.parents) need(
          blocked.parents.find(item => item.reservation_id === parent.reservation_id).pending_cpu === parent.pending_cpu,
          "EXHAUSTED_ORIGINAL_CPU_HOLD_CHANGED_ON_REPLAY");
        await page.reload();
        await expect(panel.locator(`[data-z1-request-id="${report.requestId}"]`)).toHaveAttribute("data-z1-status", "INCOMPLETE");
        const image = await panel.screenshot({ path: resolve(output, "native-episode-exhausted.png"), animations: "disabled" });
        await uiWrite(ids[0], "z1-cancel-shared-work", { root: fixture.root, requestId: report.requestId, expectedGeneration: generation });
        const cancelled = await snapshot(); assertConserved(blocked, cancelled);
        need(cancelled.row.status === "CANCELLED", "EXHAUSTED_NATIVE_CANCELLATION_NOT_RETAINED");
        await privateJSON(resolve(output, "exhausted-native-prefix.json"), { interrupted, beforeReplay, blocked, cancelled,
          terminalJobs, evidence, beforeReadCounters, afterReadCounters, afterReplayCounters, physical,
          panelSha256: sha(image), originalExpectedValues: "original-0-initial.json",
          interruptedPhysicalCost: "UNKNOWN_NOT_ZERO", newLogicalComputationObserved: false,
          sourceOwnerFlow: "NOT_RUN", installedOwnerFlow: "NOT_RUN", scope: "BOUNDED_NEGATIVE_PREFIX_NOT_COMPLETE_ORIGINAL_EPISODE" });
        report.nativeEpisodeExhaustionFalsifier = "PASSED";
        report.originalWorkIds = ids; report.physicalExits = physical;
        await audit({ kind: "DURABLE_EXHAUSTED_ORIGINAL_NATIVE_EPISODE_REFUSAL_AND_CANCELLATION",
          originalWorkIds: ids, originalParentsRetained: true, fullOwnerJourney: "NOT_RUN" });
        return;
      }
      if (scenario === "UNRECONCILED_LOGICAL_PREFIX") {
        need(index === 0, "BOUNDED_INITIAL_PREFIX_ONLY");
        await worker("PRODUCER_PID");
        const interrupted = await snapshot();
        await worker(null, true);
        const blocked = await snapshot(); assertConserved(previousSnapshot, blocked);
        need(blocked.row.status === "INCOMPLETE" && blocked.row.attempts_used === interrupted.row.attempts_used &&
          blocked.attempts.length === 1 && blocked.attempts[0].status === "LOST_UNKNOWN" &&
          blocked.attempts[0].costs_unknown && blocked.row.logical_charges === null && blocked.uses.length === 0,
          "UNRESOLVED_ORIGINAL_LOGICAL_WORK_WAS_RESTARTED_OR_CONSUMED");
        for (const parent of interrupted.parents) need(
          BigInt(blocked.parents.find(item => item.reservation_id === parent.reservation_id).pending_cpu) >= BigInt(parent.pending_cpu),
          "UNRESOLVED_ORIGINAL_CPU_HOLD_BECAME_FREE");
        const panel = await mount(ids[0]); await page.reload();
        await expect(panel.locator(`[data-z1-request-id="${report.requestId}"]`)).toHaveAttribute("data-z1-status", "INCOMPLETE");
        const image = await panel.screenshot({ path: resolve(output, "logical-exposure-incomplete.png"), animations: "disabled" });
        await uiWrite(ids[0], "z1-cancel-shared-work", {
          root: fixture.root, requestId: report.requestId, expectedGeneration: generation });
        const cancelled = await snapshot(); assertConserved(blocked, cancelled);
        need(cancelled.row.status === "CANCELLED", "UNRESOLVED_LOGICAL_CANCELLATION_NOT_RETAINED");
        await privateJSON(resolve(output, "unreconciled-logical-prefix.json"), { interrupted, blocked, cancelled, physical,
          panelSha256: sha(image), originalExpectedValues: "original-0-initial.json",
          logicalCost: "UNKNOWN_NOT_ZERO", newLogicalComputationObserved: false, sourceOwnerFlow: "NOT_RUN",
          installedOwnerFlow: "NOT_RUN", scope: "BOUNDED_NEGATIVE_PREFIX_NOT_COMPLETE_ORIGINAL_EPISODE" });
        report.nativeLogicalExposureFalsifier = "PASSED";
        report.originalWorkIds = ids; report.physicalExits = physical;
        await audit({ kind: "DURABLE_ORIGINAL_LOGICAL_EXPOSURE_REFUSAL_AND_CONSERVATIVE_CANCELLATION",
          originalWorkIds: ids, originalParentsRetained: true, fullOwnerJourney: "NOT_RUN" });
        return;
      }
      if (index === 0) for (const boundary of ["CLAIM", "CHECKPOINT", "DELIVERY"]) await worker(boundary);
      await worker();
      const replay = (await post("z1-submit-shared-work", intake)).body;
      need(replay.replayed === true && replay.requestId === report.requestId && replay.generation === generation,
        "DUPLICATE_NATIVE_INTAKE_NOT_IDEMPOTENT");
      latestPublication = (await post("z1-read-shared-work", { root: fixture.root, requestId: report.requestId, view: "PUBLICATION" })).body.publication;
      need(latestPublication?.body.check.disposition === "CHECKED_CANDIDATE" &&
        latestPublication.body.candidate.workProjections.length === ids.length, "COMPLETE_NATIVE_CHECKED_PUBLICATION_REQUIRED");
      for (const projection of latestPublication.body.candidate.workProjections)
        need(isSame(projection.result, oracle.expected.outputs[projection.workId]), "NATIVE_RESULT_DIFFERS_FROM_INDEPENDENT_ORIGINAL");
      const eligibleId = request.works.find(work => oracle.expected.outputs[work.id] !== null).id;
      await uiWrite(eligibleId, "z1-admit-shared-work", { root: fixture.root, publication: latestPublication.reference });
      await worker();
      const after = await snapshot(); assertConserved(previousSnapshot, after);
      for (const workId of ids) {
        const expected = oracle.expected.ownerUses[workId], use = after.uses.find(item =>
          item.publication_id === latestPublication.reference.id && item.work_id === workId);
        need(expected ? Boolean(use) : !use, "EXACT_ORIGINAL_OWNER_USE_COVERAGE_REQUIRED");
        if (expected?.owner === "S3") need(use.body.analyticalUse.value === expected.value &&
          isSame(use.body.analyticalUse.type, expected.type) && use.body.originalResultActuallyUsed === true,
          "ACTUAL_S3_USE_DIFFERS_FROM_INDEPENDENT_ORIGINAL");
        if (expected?.owner === "S4") {
          need(use.body.choice === expected.choice && isSame(use.body.selected, expected.selected), "ACTUAL_S4_USE_DIFFERS_FROM_INDEPENDENT_ORIGINAL");
          const decision = await scoped(async c => (await c.query(
            "SELECT decision,state,deal_id,investment_case_id FROM finnor_os.pe_decisions WHERE tenant_id=$1 AND id=$2",
            [fixture.tenantId, use.body.decisionId])).rows[0], true);
          need(decision?.decision === expected.choice && decision.state === "final" && decision.deal_id === fixture.root.entityId,
            "CANONICAL_S4_FINAL_DECISION_NOT_OBSERVED");
        }
        const panel = await mount(workId); await page.reload();
        await expect(page.locator(`[data-z1-work-id="${workId}"] [data-z1-request-id="${report.requestId}"]`)).toBeVisible();
        if (oracle.expected.outputs[workId] !== null) {
          await panel.getByText("Exact original projection and conditionality", { exact: true }).click();
          const mounted = JSON.parse(await panel.locator("details").filter({ hasText: "Exact original projection and conditionality" }).locator("pre").textContent());
          need(isSame(mounted.result, oracle.expected.outputs[workId]) && mounted.workId === workId,
            "RELOADED_MOUNTED_ORIGINAL_PROJECTION_DIFFERS");
        }
        if (index === 0 && workId === ids[0]) {
          await panel.getByText("Original owner use and retained costs", { exact: true }).click();
          const traceResponse = page.waitForResponse(response => response.request().method() === "POST" &&
            new URL(response.url()).pathname === "/api/centropy/company-brain/z1-read-shared-work");
          await panel.getByRole("button", { name: "Read current retained request trace", exact: true }).click();
          const response = await traceResponse, value = await response.json();
          need(response.status() === 200 && value.current === true && value.requestId === report.requestId &&
            value.lifecycleFinancialCostComplete === false && value.parents.length === 3, "MOUNTED_RETAINED_NATIVE_TRACE_REQUIRED");
          await expect(panel.getByText("At most 64 events.", { exact: false })).toBeVisible();
          await audit({ kind: "AUTHENTICATED_MOUNTED_TRACE_READ", responseDigest: digest(value),
            eventsReturned: value.events.length, moreHistory: value.nextEventId !== null });
        }
        const image = await panel.screenshot({ path: resolve(output, `panel-${index}-${workId}.png`), animations: "disabled" });
        await audit({ kind: "RELOADED_MOUNTED_ORIGINAL_OBSERVATION", stage: stage.name, workId,
          independentResultDigest: oracle.expected.digests[workId], ownerReference: use?.reference ?? null, panelSha256: sha(image) });
      }
      await privateJSON(resolve(output, `native-${index}-${stage.name.toLowerCase()}.json`), {
        intake, requestDigest: oracle.expected.requestDigest, publication: latestPublication, snapshot: after });
      previousRequest = request; previousSnapshot = after;
    }
    for (const prior of staleClaims) {
      let refused = false;
      try {
        await scoped(async c => {
          const row = await rowTx(ctx, c, report.requestId);
          await fenceTx(ctx, c, row, { jobId: prior.job.id, tenantId: fixture.tenantId, claimToken: prior.job.claim_token,
            claimFence: prior.job.claim_fence, workerId: prior.job.lease_owner,
            deliveryAttemptId: prior.message.deliveryAttemptId, protocolVersion: 1 });
        });
      } catch (error) { refused = error?.message === "Z1_ACTUAL_CANONICAL_JOB_FENCED"; }
      need(refused, "STALE_ACTUAL_NATIVE_CLAIM_NOT_REFUSED");
    }
    const beforeCancel = await snapshot();
    await uiWrite(ids[0], "z1-cancel-shared-work", { root: fixture.root, requestId: report.requestId, expectedGeneration: generation });
    const afterCancel = await snapshot(); assertConserved(beforeCancel, afterCancel);
    need(afterCancel.row.status === "CANCELLED" && afterCancel.attempts.filter(item => item.status === "LOST_UNKNOWN").length === 3,
      "CANCELLATION_OR_PHYSICAL_UNKNOWN_RESPONSIBILITY_LOST");
    await page.goto(new URL("/centropy/world", target.frontend).href);
    await expect(page.locator("[data-z1-work-id]")).toHaveCount(0);
    await context.setOffline(true); await page.reload().catch(() => {}); await context.setOffline(false);
    await context.clearCookies(); await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }).catch(() => {});
    bearer = null; await page.goto(new URL("/centropy/login", target.frontend).href);
    await expect(page.getByRole("heading", { name: "Sign in to CENTROPY", exact: true })).toBeVisible();
    await expect(page.locator("[data-z1-work-id]")).toHaveCount(0);
    await privateJSON(resolve(output, "final-native-state.json"), { afterCancel, physical, networkDenied,
      staleClaimsRefused: staleClaims.length, mutationScope: "EXISTING_PUBLIC_DISPOSABLE_FIXTURES_AND_ORIGINAL_Z1_RECORDS_ONLY",
      money: null, fullFinancialCost: "UNKNOWN", effectsDispatched: false });
    report.sourceOwnerFlow = target.flavor === "SOURCE_DEVELOPMENT" ? "PASSED" : "NOT_RUN";
    report.installedOwnerFlow = target.flavor === "SEPARATELY_INSTALLED_DEVELOPMENT" ? "PASSED" : "NOT_RUN";
    report.physicalNativeRecovery = physical.length === 3 ? "PASSED" : "FAILED";
    report.originalWorkIds = ids; report.physicalExits = physical;
    await audit({ kind: "ROOT_AND_SESSION_CLEAR_CANCELLATION_AND_REAL_STALE_CLAIM_REFUSAL", originalWorkIds: ids });
  } finally {
    // Never stop a declared target listener, other worker, database or fixture.
    for (const child of workers) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const owned = await processIdentity(child.pid).catch(() => null);
      if (!owned || owned.uid !== identity.uid) continue;
      const closed = new Promise(resolveClose => child.once("close", resolveClose));
      child.kill("SIGTERM");
      await Promise.race([closed, wait(1500)]);
      if (child.exitCode === null && child.signalCode === null &&
        isSame(owned, await processIdentity(child.pid).catch(() => null))) child.kill("SIGKILL");
      await closed;
    }
    await context?.close().catch(() => {}); await browser?.close().catch(() => {});
  }
  } finally { await getPool().end(); }
}
