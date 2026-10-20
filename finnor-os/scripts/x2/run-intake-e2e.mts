/**
 * Registration-only maintained UI E2E. Read intake-e2e-contract.md first.
 * Explicit scheduling is required; importing this entrypoint is NOT a preflight.
 * No workers, learner, business mutation, saved auth or generated acknowledgements.
 */
import { strict as assert } from "node:assert";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFile, chmod, cp, lstat, mkdir, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { z } from "zod";
import type { Browser, BrowserContext, Page } from "playwright-core";
import {
  attachWorkEntity, closePool, configureTenantVertical, createEmployeeConversationThread,
  receiveWork, updateEmployeeConversationThreadContext,
} from "@finnor/db";
import { migrate } from "../../packages/db/migrate";
import { MIGRATIONS } from "../../packages/db/migrations-bundle";
import { CURRENT_MIGRATION_HEAD } from "../../packages/db/migration-head";
import { putAllocationResource } from "../../packages/private-equity/src/allocation-store";
import { createDeal } from "../../packages/private-equity/src/repository";
import { startAuthenticatedHttpFixture, type AuthenticatedHttpFixture } from "./authenticated-http-fixture.mts";
import { installedHttpFixture } from "./installed-http-fixture.mts";
import { inspectInstalledRuntime } from "./installed-runtime-custody.mts";
import { initialize } from "./fixtures/admin.mjs";

assert.equal(process.env.FINNOR_X2_INTAKE_SCHEDULED, "1", "PARENT_SERIAL_SCHEDULING_REQUIRED");
const runtime = process.env.FINNOR_X2_INTAKE_RUNTIME, out = process.env.FINNOR_X2_EVIDENCE_DIR;
assert(runtime && isAbsolute(runtime) && out && isAbsolute(out), "ABSOLUTE_RUNTIME_AND_NEW_EVIDENCE_REQUIRED");
assert.equal(await realpath(runtime), resolve(runtime), "CANONICAL_INSTALLED_RUNTIME_REQUIRED");
assert(!resolve(out).startsWith(runtime + "/"), "EVIDENCE_MUST_NOT_MODIFY_INSTALLATION");
for (const key of ["HOME", "TMPDIR"]) {
  const value = process.env[key];
  assert(value && isAbsolute(value) && !resolve(value).startsWith(runtime + "/"), "PRIVATE_HOME_TMPDIR_REQUIRED");
  const info = await lstat(value);
  assert(info.isDirectory() && !(info.mode & 0o077), "HOME_TMPDIR_MUST_BE_PRIVATE_OWNED_DIRECTORIES");
}
for (const key of ["AUTH_DEV_BYPASS", "DATABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "AGENT_BROWSER_CDP",
  "FACTORY_DESKTOP_CDP_PORT", "DOTENV_CONFIG_PATH", "NODE_OPTIONS", "NODE_TLS_REJECT_UNAUTHORIZED"]) {
  assert(process.env[key] === undefined, "ENV_I_WITHOUT_AMBIENT_AUTH_DATABASE_OR_BYPASS_REQUIRED");
}
process.umask(0o077);
await mkdir(out, { mode: 0o700 }); // Never adopt a previous episode.
const privateDir = join(out, "private");
await mkdir(privateDir, { mode: 0o700 });
const repo = resolve(import.meta.dirname, "../../..");
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const save = (name: string, body: unknown) => writeFile(join(out, name), JSON.stringify(body, null, 2) + "\n",
  { mode: 0o600 });
const registration = z.object({ sessionId: z.string().uuid() });
const proxyAcquire = "/api/centropy/company-brain/application-acquire";
const panelSelector = ".ct-application-semantics";
const stages: Array<{ id: string; status: "PASS" | "FAIL"; startedAt: string; wallMs: number }> = [];
const cleanup: Array<{ owner: string; status: "PASS" | "FAIL" }> = [];
const processes: Array<{ child: ChildProcess; exit: Promise<void>; flush: () => Promise<void>; name: string }> = [];
const requests: Array<{ workId: string; body: unknown }> = [];
const responses: Array<{ status: number; body: unknown; workId: string }> = [];
const projections: Array<{ status: number; request: unknown; body: unknown; bodyDelivered: boolean }> = [];
let capture = Promise.resolve(), captureFailed = false;
let sql: pg.Client | undefined, auth: AuthenticatedHttpFixture | undefined;
let api: Awaited<ReturnType<typeof installedHttpFixture>> | undefined;
let browser: Browser | undefined, context: BrowserContext | undefined, page: Page | undefined;
let database: EmbeddedPostgres | undefined, databaseStarted = false, failed = false;
const tenant = randomUUID(), actor = randomUUID(), other = randomUUID(), company = randomUUID();
const root = { entityType: "pe_deal" as const, entityId: randomUUID() };
const ctx = { auth: { tenantId: tenant, userId: actor, employeeId: actor, role: "owner" as const },
  provenance: { sourceSystem: "FRONTIER5.X2:ordinary-intake-e2e", createdBy: actor } };
type Episode = {
  name: string; workId: string; threadId: string; title: string; profileId: string;
  targets: Array<{ kind: "identity"; application: string; account: string; entity: string; id: string }>;
  resourceDemand: Array<{ resourceId: string; unit: "request"; amount: string }>; deadlineAt: string;
};
async function stage(id: string, run: () => Promise<void>) {
  const startedAt = new Date().toISOString(), started = performance.now();
  try { await run(); stages.push({ id, status: "PASS", startedAt, wallMs: performance.now() - started }); }
  catch (error) {
    stages.push({ id, status: "FAIL", startedAt, wallMs: performance.now() - started });
    await writeFile(join(privateDir, `failure-${id}.txt`), String(error instanceof Error ? error.stack : error) + "\n",
      { mode: 0o600 });
    if (page && !page.isClosed()) await observe(`failure-${id}`).catch(() => undefined);
    throw Error("INTAKE_STAGE_FAILED:" + id);
  } finally {
    await save("progress.json", { EXECUTED: true, stages, qualification: "REGISTRATION_ONLY_NOT_BUSINESS_SUCCESS" });
    console.log(JSON.stringify({ stage: id, status: stages.at(-1)?.status }));
  }
}
async function bounded<T>(promise: Promise<T>, ms: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<T>((_, no) => { timer = setTimeout(() => no(Error(code)), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function poll<T>(read: () => Promise<T> | T, accept: (value: T) => boolean, code: string): Promise<T> {
  const end = Date.now() + 15000;
  do { const value = await read(); if (accept(value)) return value; await sleep(75); } while (Date.now() < end);
  throw Error(code);
}
async function port(): Promise<number> {
  const value = await new Promise<number>((yes, no) => {
    const server = createServer(); server.once("error", no); server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); no(Error("OWNED_PORT_REQUIRED")); return; }
      server.close(error => error ? no(error) : yes(address.port));
    });
  });
  return value === 19073 ? port() : value;
}
function loopback(origin: string) {
  const url = new URL(origin);
  assert.equal(url.hostname, "127.0.0.1"); assert.notEqual(url.port, "19073");
  return url;
}
async function service(name: string, argv: string[], cwd: string, environment: NodeJS.ProcessEnv, readyPattern: RegExp) {
  const log = join(privateDir, name + ".log");
  await writeFile(log, "", { mode: 0o600, flag: "wx" });
  let yes: () => void = () => {}, no: (error: Error) => void = () => {}, tail = "", flush = Promise.resolve();
  let logFailed = false;
  const ready = new Promise<void>((resolve_, reject) => { yes = resolve_; no = reject; });
  const child = spawn(process.execPath, argv, { cwd, env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const exit = new Promise<void>(resolve_ => child.once("close", () => { no(Error("OWNED_SERVICE_EXIT:" + name)); resolve_(); }));
  child.once("error", no);
  processes.push({ child, exit, name, flush: async () => { await flush; assert(!logFailed, "PRIVATE_LOG_CUSTODY_FAILED"); } });
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (bytes: Buffer) => {
    flush = flush.then(() => appendFile(log, bytes)).catch(() => { logFailed = true; });
    tail = (tail + bytes.toString()).slice(-8192); if (readyPattern.test(tail)) yes();
  });
  await save(`process-${name}.json`, { pid: child.pid, processGroup: child.pid, executable: process.execPath, argv, cwd, log });
  await bounded(ready, 30000, "OWNED_SERVICE_READINESS:" + name);
}
const tables = ["application_semantics_sessions", "s5_requests", "s5_proposals", "s5_reservations",
  "s5_reservation_origins", "s5_consumptions", "application_semantics_requests"] as const;
async function counts() {
  const result: Record<string, number> = {};
  for (const table of tables) result[table] = Number((await sql!.query(
    `SELECT count(*)::int n FROM finnor_os.${table} WHERE tenant_id=$1`, [tenant])).rows[0].n);
  return result;
}
async function canonical(episode: Episode, sessionId: string, checkpoint: string) {
  const sessions = (await sql!.query("SELECT * FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND work_id=$2",
    [tenant, episode.workId])).rows;
  assert.equal(sessions.length, 1);
  const row = sessions[0];
  assert.equal(row.id, sessionId); assert.equal(row.parent_id, sessionId); assert.equal(row.principal_id, actor);
  assert.deepEqual(row.root, root); assert.equal(row.status, "QUEUED"); assert.equal(row.model_ref, null);
  assert.equal(row.check_ref, null); assert.equal(new Date(row.deadline_at).toISOString(), episode.deadlineAt);
  assert.deepEqual(row.profile_ids, [episode.profileId]);
  assert.deepEqual(row.request.targets, episode.targets);
  assert.deepEqual(row.request.resourceDemand, episode.resourceDemand);
  assert.equal(row.request.workId, episode.workId); assert.deepEqual(row.request.root, root);
  const work = (await sql!.query("SELECT id,tenant_id,created_by,current_owner_id,active_context FROM finnor_os.works WHERE tenant_id=$1 AND id=$2",
    [tenant, episode.workId])).rows[0];
  assert(work); assert.equal(work.created_by, actor); assert.equal(work.current_owner_id, actor);
  assert.deepEqual(work.active_context, root);
  const input = (await sql!.query("SELECT id,work_id,created_by FROM finnor_os.work_inputs WHERE tenant_id=$1 AND id=$2",
    [tenant, row.work_input_id])).rows[0];
  assert(input); assert.equal(input.work_id, episode.workId); assert.equal(input.created_by, actor);
  const links = (await sql!.query("SELECT entity_type,entity_id FROM finnor_os.work_entity_links WHERE tenant_id=$1 AND work_id=$2",
    [tenant, episode.workId])).rows;
  assert(links.some(link => link.entity_type === root.entityType && link.entity_id === root.entityId));
  const reservations = (await sql!.query("SELECT r.*,o.principal_id,o.body original FROM finnor_os.s5_reservations r"
    + " JOIN finnor_os.s5_reservation_origins o USING(tenant_id,reservation_id,allocation_digest)"
    + " WHERE r.tenant_id=$1 AND r.reservation_id=$2", [tenant, row.reservation_ref.id])).rows;
  assert.equal(reservations.length, 1); assert.equal(reservations[0].principal_id, actor);
  assert.equal(reservations[0].status, "RESERVED");
  assert.equal(reservations[0].allocation_digest, row.allocation_ref.contentDigest);
  const proposals = (await sql!.query("SELECT content_digest,certificate FROM finnor_os.s5_proposals"
    + " WHERE tenant_id=$1 AND principal_id=$2 AND content_digest=$3", [tenant, actor, row.allocation_ref.contentDigest])).rows;
  assert.equal(proposals.length, 1);
  const consumptions = (await sql!.query("SELECT consumption_id,reservation_id,node_id,body FROM finnor_os.s5_consumptions"
    + " WHERE tenant_id=$1 AND principal_id=$2 AND reservation_id=$3", [tenant, actor, row.reservation_ref.id])).rows;
  assert.equal(consumptions.length, 1); assert.equal(consumptions[0].node_id, "original-computation");
  assert.equal(consumptions[0].consumption_id, row.root_consumption_ref.id);
  const jobs = (await sql!.query("SELECT id,type,status,attempts,claim_token,claim_fence,payload FROM finnor_os.jobs"
    + " WHERE tenant_id=$1 AND payload->>'sessionId'=$2", [tenant, sessionId])).rows;
  assert.equal(jobs.length, 1); assert.equal(jobs[0].type, "run_application_semantics_v1");
  assert.equal(jobs[0].status, "queued"); assert.equal(jobs[0].attempts, 0); assert.equal(Number(jobs[0].claim_fence), 0);
  assert.equal(jobs[0].claim_token, null);
  const thread = (await sql!.query("SELECT owner_employee_id,active_work_id,active_references FROM finnor_os.employee_conversation_threads"
    + " WHERE tenant_id=$1 AND id=$2", [tenant, episode.threadId])).rows[0];
  assert.equal(thread.owner_employee_id, actor); assert.equal(thread.active_work_id, episode.workId);
  assert.deepEqual(thread.active_references, [root]);
  assert.equal((await counts()).application_semantics_requests, 0, "NO_PHYSICAL_PROVIDER_OR_BUSINESS_DISPATCH");
  await save(`canonical-${checkpoint}.json`, { session: row, work, input, links, reservations, proposals, consumptions, jobs, thread });
}
async function observe(checkpoint: string) {
  assert(page);
  const panel = page.locator(panelSelector);
  assert.equal(await panel.count(), 1);
  const observation = await panel.evaluate(node => ({
    visibility: document.visibilityState,
    workId: node.getAttribute("data-application-work"), sessionId: node.getAttribute("data-application-session"),
    status: node.getAttribute("data-application-status"), text: (node as HTMLElement).innerText,
    inputs: Array.from(node.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input,textarea"))
      .map(input => ({ name: input.name, value: input.value, disabled: input.matches(":disabled"),
        valid: input.validity.valid, validationMessage: input.validationMessage })),
    buttons: Array.from(node.querySelectorAll<HTMLButtonElement>("button"))
      .map(button => ({ text: button.textContent, disabled: button.disabled })),
  }));
  await save(`dom-${checkpoint}.json`, observation);
  const image = join(out!, checkpoint + ".png");
  await panel.screenshot({ path: image, timeout: 15000 }); await chmod(image, 0o600);
  return observation;
}
async function matchPanel(episode: Episode, sessionId: string | null) {
  assert(page);
  await poll(async () => {
    const panel = page!.locator(panelSelector);
    if (await panel.count() !== 1) return false;
    return await panel.getAttribute("data-application-work") === episode.workId
      && await panel.getAttribute("data-application-session") === (sessionId ?? "none")
      && await panel.getAttribute("data-application-status") === (sessionId ? "QUEUED" : "none")
      && (await panel.innerText()).includes(`Tenant ${tenant} · native principal ${actor}`)
      && (await panel.innerText()).includes(`root ${root.entityType} / ${root.entityId}`);
  }, Boolean, "EXACT_CANONICAL_MAINTAINED_PANEL_REQUIRED");
}
async function open(episode: Episode) {
  assert(page);
  await page.getByRole("button", { name: "Investigations", exact: true }).click();
  await page.getByRole("dialog", { name: "Recent Investigations", exact: true }).getByText(episode.title, { exact: true }).click();
  await page.waitForURL(url => url.pathname === `/centropy/investigations/${episode.threadId}`, { timeout: 15000 });
  await page.getByRole("main", { name: "Investigation Canvas", exact: true }).waitFor({ state: "visible", timeout: 15000 });
  await matchPanel(episode, null);
}
async function fill(episode: Episode, profileId: string) {
  const panel = page!.locator(panelSelector);
  await panel.locator('textarea[name="profileIds"]').fill(JSON.stringify([profileId]));
  await panel.locator('textarea[name="targets"]').fill(JSON.stringify(episode.targets));
  await panel.locator('textarea[name="resourceDemand"]').fill(JSON.stringify(episode.resourceDemand));
  await panel.locator('input[name="deadlineAt"]').fill(episode.deadlineAt);
}
async function submit() {
  await page!.locator(panelSelector).getByRole("button", { name: "Request acquisition and native reservation", exact: true }).click();
}
const childEnv = () => ({ PATH: process.env.PATH, HOME: privateDir, TMPDIR: privateDir, LANG: "C", TZ: "UTC" });
try {
  await stage("installed-and-source-custody", async () => {
    await save("installed-beginning.json", await inspectInstalledRuntime(runtime));
    await save("driver.json", { path: import.meta.filename, sha256: sha(await readFile(import.meta.filename)),
      contractSha256: sha(await readFile(join(repo, "scope-frontier5/x2-software-semantics-compiler/intake-e2e-contract.md"))),
      argv: process.argv, runtime, node: process.version, noWorkerStarted: true, protectedAdmission: false });
  });
  await stage("fresh-canonical-database-and-owners", async () => {
    process.env.NODE_ENV = "production"; process.env.FINNOR_ENVIRONMENT = "staging";
    process.env.FINNOR_X2_PROFILE = "ordinary_disposable"; process.env.FINNOR_X2_SOURCE_ROOT = runtime;
    process.env.FINNOR_TEST_MANAGED_EXTENSIONS = "omit";
    const password = randomBytes(24).toString("hex"), databasePort = await port();
    database = new EmbeddedPostgres({ databaseDir: join(privateDir, "db"), user: "x2_owner", password,
      port: databasePort, persistent: true, onLog: () => undefined });
    await bounded(database.initialise(), 60000, "OWNED_DB_INITIALIZE_DEADLINE");
    await appendFile(join(privateDir, "db/postgresql.conf"),
      "\ntrack_commit_timestamp=on\nmax_wal_size='256MB'\nmin_wal_size='80MB'\ncheckpoint_timeout='30s'\n");
    await database.start(); databaseStarted = true; await database.createDatabase("x2_intake");
    const adminUrl = `postgres://x2_owner:${password}@127.0.0.1:${databasePort}/x2_intake`;
    const migrations = await Promise.all((await readdir(join(runtime, "finnor-os/packages/db/migrations")))
      .filter(name => name.endsWith(".sql")).sort().map(async name => ({ name,
        sql: await readFile(join(runtime, "finnor-os/packages/db/migrations", name), "utf8") })));
    assert.deepEqual(MIGRATIONS, migrations); assert.equal(CURRENT_MIGRATION_HEAD, migrations.at(-1)?.name);
    const applied = await bounded(migrate(adminUrl, migrations), 120000, "CANONICAL_MIGRATION_DEADLINE");
    assert.deepEqual(await migrate(adminUrl, migrations), []);
    sql = new pg.Client({ connectionString: adminUrl, statement_timeout: 15000 }); await sql.connect();
    const appPassword = randomBytes(24).toString("hex");
    await sql.query(`ALTER ROLE finnor_app LOGIN PASSWORD '${appPassword}'`);
    process.env.DATABASE_URL = `postgres://finnor_app:${appPassword}@127.0.0.1:${databasePort}/x2_intake`;
    await closePool();
    await sql.query("SET app.test_vertical_mode='explicit'");
    await sql.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'X2 ordinary disposable intake')", [tenant, randomUUID()]);
    await sql.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active'),($4,$2,$5,'owner','active')",
      [actor, tenant, actor + "@test.invalid", other, other + "@test.invalid"]);
    await configureTenantVertical({ tenantId: tenant, verticalKey: "private_equity", expectedVersion: 0, createdBy: actor,
      sourceSystem: "FRONTIER5.X2:ordinary-intake-e2e" });
    await sql.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind)"
      + " VALUES($1,$2,'intake-company','Disposable intake company','other')", [company, tenant]);
    const deal = await createDeal(ctx, { id: root.entityId, targetOrganizationId: company, name: "Disposable intake Deal",
      dealLeadEmployeeId: actor, signedLoiAt: new Date(), targetClosingAt: new Date(Date.now() + 86400000) });
    assert.equal(deal.row.id, root.entityId);
    const roles = (await sql.query("SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname='finnor_app'")).rows;
    assert.equal(roles.length, 1); assert(!roles[0].rolsuper && !roles[0].rolbypassrls);
    await save("database-setup.json", { applied, replay: [], head: CURRENT_MIGRATION_HEAD, roles, tenant, actor, other, root, deal: deal.row });
  });
  const frontendPort = await port(), frontendOrigin = `http://127.0.0.1:${frontendPort}`;
  const secretRoot = join(privateDir, "secrets");
  await mkdir(secretRoot, { mode: 0o700 }); await mkdir(join(secretRoot, tenant), { mode: 0o700 });
  process.env.FINNOR_X2_DISPOSABLE_SECRET_ROOT = secretRoot;
  const episodes: Episode[] = [];
  await stage("independent-native-intake-fixtures", async () => {
    for (const name of ["corrected", "response-loss"]) {
      const portalDir = join(privateDir, "portal-" + name);
      await initialize(portalDir, "api");
      // Read only the lawful administrator credential packet; never read graded
      // held-out objective, private provider state or candidate truth.
      const credentials = JSON.parse(await readFile(join(portalDir, "credentials.json"), "utf8"));
      const portalOrigin = `http://127.0.0.1:${await port()}`;
      await service("portal-" + name, [join(import.meta.dirname, "fixtures/server.mjs"),
        "--private-dir", portalDir, "--port", loopback(portalOrigin).port], repo, childEnv(), /"origin":/);
      const accountId = randomUUID(), profileId = randomUUID(), deadlineAt = new Date(Date.now() + 900000).toISOString();
      const validUntil = new Date(Date.now() + 1200000).toISOString();
      const allowedTargets = [credentials.recordIds.discoveryOne, credentials.recordIds.discoveryTwo] as string[];
      const config = { sourceContract: "BOUNDED_CONDITIONAL_APPLICATION_V1", protectionDomain: "DISPOSABLE_TEST_AUTHORITY",
        origin: portalOrigin, application: credentials.applicationId, account: credentials.accounts.primary,
        actingPrincipal: credentials.principalIds.editor, role: "editor", validUntil,
        entrypoint: "/portal/records/{recordId}", documentationPaths: ["/openapi.json"], contextPath: "/api/context",
        recordPathTemplate: "/api/accounts/{accountId}/records/{recordId}", requestPathTemplate: "/api/requests/{requestId}",
        allowedTargets, allowedEntities: [credentials.entities.usd], discoverySurface: "API" };
      await writeFile(join(secretRoot, tenant, name + ".json"), JSON.stringify({ applicationHeaders: JSON.stringify({
        authorization: "Bearer " + credentials.tokens.editor, "x-portal-grant": credentials.grantIds.discovery,
      }) }), { mode: 0o600, flag: "wx" });
      await sql!.query("INSERT INTO finnor_os.application_accounts(id,tenant_id,account_key,application,provider,display_name,provider_account_ref,capabilities)"
        + " VALUES($1,$2,$3,'x2_portal','x2_native','Disposable intake portal',$4,'[\"application-operation-v1\"]')",
      [accountId, tenant, name, credentials.accounts.primary]);
      await sql!.query("INSERT INTO finnor_os.auth_profiles(id,tenant_id,auth_profile_ref,principal_type,principal_id,application_account_id,purpose,"
        + "credential_provider,credential_ref,auth_method,connection_status,capabilities,restrictions)"
        + " VALUES($1,$2,$3,'employee',$4,$5,'application_semantics','disposable-private-file',$6,'application_headers','active',"
        + "'[\"application-operation-v1\"]',$7::jsonb)", [profileId, tenant, name, actor, accountId, `finnor/tenants/${tenant}/x2/${name}`,
        JSON.stringify({ allowedActorIds: [actor], allowedPurposes: ["application_semantics"], applicationSemantics: config })]);
      const ownerRef = { owner: "BUSINESS_OWNER" as const, id: actor, version: "development-v1", contentDigest: sha(actor) };
      const resource = await putAllocationResource(ctx, { schema: "finnor.allocation-resource.v1", resourceId: "intake-" + name,
        tenantId: tenant, ownerRef, legalEntityRef: { ...ownerRef, owner: "S1", id: company }, scopeRef: { ...ownerRef, id: company },
        permittedRoots: [root], rightsRef: "S1:employee:" + actor + ":revision:1", unit: "request", currency: null,
        kind: "CUMULATIVE_EXPENDITURE", resourceClass: "COMPUTE",
        horizon: { startAt: new Date().toISOString(), periodMs: 3600000, periods: 1 }, sourceRef: ownerRef,
        asOf: new Date().toISOString(), knowledgeAt: new Date().toISOString(), validUntil, beliefPins: [],
        availability: [{ amount: "2048", basis: "REPORTED_AVAILABLE" }, { amount: "2048", basis: "REPORTED_AVAILABLE" }],
        existingUse: ["0", "0"], safetyMargin: "0", covenants: [], revoked: false,
        qualification: "AUTHENTICATED_OWNER_ASSERTION_UNADMITTED" }, null);
      const work = await receiveWork({ tenantId: tenant, userId: actor,
        instruction: "Register bounded disposable discovery for " + name + "; do not dispatch its queued job.",
        channel: "console", idempotencyKey: "intake:" + randomUUID(), activeContext: root,
        authorityContext: { principalId: actor, producer: "X2_DISPOSABLE_OWNER" } });
      await attachWorkEntity(tenant, work.workId, { ...root, source: "FRONTIER5.X2:intake-fixture" });
      const title = "X2 intake " + name + " " + randomUUID();
      const thread = await createEmployeeConversationThread({ tenantId: tenant, ownerEmployeeId: actor, title });
      await updateEmployeeConversationThreadContext({ tenantId: tenant, ownerEmployeeId: actor, threadId: thread.id,
        activeReferences: [root], activeWorkId: work.workId });
      episodes.push({ name, workId: work.workId, threadId: thread.id, title, profileId,
        targets: allowedTargets.map(id => ({ kind: "identity", application: credentials.applicationId,
          account: credentials.accounts.primary, entity: credentials.entities.usd, id })),
        resourceDemand: [{ resourceId: resource.resourceId, unit: "request", amount: "2048" }], deadlineAt });
    }
    assert.notEqual(episodes[0]!.workId, episodes[1]!.workId);
    assert.notEqual(episodes[0]!.profileId, episodes[1]!.profileId);
    await save("inputs.json", { tenant, actor, other, root, episodes, noPriorEpisodeAdopted: true, noQueueDispatcher: true });
  });
  const frontendDir = join(privateDir, "frontend");
  const copiedPins: Array<{ path: string; sha256: string }> = [];
  await stage("real-emitted-api-and-maintained-frontend", async () => {
    auth = await startAuthenticatedHttpFixture({ frontendOrigin, port: await port(), identities: [
      { userId: actor, email: actor + "@test.invalid", password: randomBytes(24).toString("hex") },
      { userId: other, email: other + "@test.invalid", password: randomBytes(24).toString("hex") },
    ] });
    loopback(auth.origin);
    let actorAccess = await auth.private.passwordSignIn(actor), otherAccess = await auth.private.passwordSignIn(other);
    api = await installedHttpFixture({ runtimeRoot: runtime, privateDir: join(privateDir, "installed-api"),
      tenantId: tenant, actorId: actor, databaseUrl: process.env.DATABASE_URL!, disposableSecretRoot: secretRoot,
      auth: { origin: auth.origin, serviceRoleKey: auth.publicAnonKey, observations: () => auth!.observations(),
        token: async identity => {
          let access = identity === "actor" ? actorAccess : otherAccess;
          if (access.expiresAt <= Date.now() / 1000 + 30) {
            access = await auth!.private.refresh(access);
            if (identity === "actor") actorAccess = access; else otherAccess = access;
          }
          return auth!.private.accessToken(access);
        } } });
    loopback(api.origin); auth.private.allowApiOrigin(api.origin);
    await mkdir(frontendDir, { mode: 0o700 });
    const source = JSON.parse(await readFile(join(dirname(runtime), "source-inputs.json"), "utf8")) as {
      files: Array<{ path: string; sha256: string }>;
    };
    const directories = ["src", "public", "vendor"];
    const files = ["package.json", "package-lock.json", "next.config.mjs", "tsconfig.json", "next-env.d.ts",
      "postcss.config.js", "tailwind.config.ts", "instrumentation.ts", "instrumentation-client.ts",
      "sentry.edge.config.ts", "sentry.server.config.ts", "AGENTS.md"];
    for (const name of [...directories, ...files]) await cp(join(runtime, name), join(frontendDir, name), { recursive: true, dereference: false });
    for (const pin of source.files.filter(pin => directories.some(directory => pin.path.startsWith(directory + "/")) || files.includes(pin.path))) {
      assert.equal(sha(await readFile(join(frontendDir, pin.path))), pin.sha256, "COPIED_MAINTAINED_FRONTEND_BYTES_REQUIRED");
      copiedPins.push({ path: pin.path, sha256: pin.sha256 });
    }
    assert(copiedPins.some(pin => pin.path.endsWith("/ApplicationSemanticsPanel.tsx")));
    // Dependencies/type-only backend imports resolve from installation read-only.
    // No .env is copied, loaded or generated. All Next writes remain private.
    await symlink(join(runtime, "node_modules"), join(frontendDir, "node_modules"), "dir");
    await symlink(join(runtime, "finnor-os"), join(frontendDir, "finnor-os"), "dir");
    await save("frontend-input-pins.json", copiedPins);
    await service("frontend", [join(runtime, "node_modules/next/dist/bin/next"), "dev", "--webpack",
      "--hostname", "127.0.0.1", "--port", String(frontendPort)], frontendDir, {
      ...childEnv(), NODE_ENV: "development", NODE_OPTIONS: "--max-old-space-size=3072", NEXT_TELEMETRY_DISABLED: "1",
      FINNOR_ENVIRONMENT: "staging", FINNOR_X2_PROFILE: "ordinary_disposable",
      FINNOR_OS_API_URL: api.origin, NEXT_PUBLIC_OS_API_URL: api.origin,
      NEXT_PUBLIC_SUPABASE_URL: auth.origin, NEXT_PUBLIC_SUPABASE_ANON_KEY: auth.publicAnonKey,
    }, /Ready in/);
    const routes = [];
    for (const path of ["/centropy/login", "/centropy", ...episodes.map(item => `/centropy/investigations/${item.threadId}`)]) {
      const response = await fetch(frontendOrigin + path, { redirect: "manual", signal: AbortSignal.timeout(60000) });
      await response.arrayBuffer(); assert.equal(response.status, 200);
      routes.push({ path, status: response.status });
    }
    await save("frontend-preparation.json", { qualification: "UNAUTHENTICATED_COMPILE_ONLY", routes,
      frontendOrigin, apiOrigin: api.origin, authOrigin: auth.origin, frontendDir, noProductionBuild: true });
  });
  await stage("fresh-headed-browser-and-genuine-login", async () => {
    const { chromium } = await import("playwright-core");
    const started = performance.now();
    await bounded((async () => {
      browser = await chromium.launch({ channel: "chrome", headless: false, timeout: 15000, env: childEnv() });
      context = await browser.newContext({ serviceWorkers: "block" });
      assert.equal(context.pages().length, 0);
      page = await context.newPage(); assert.equal(page.url(), "about:blank");
    })(), 15000, "ORIGINAL_VISIBLE_BROWSER_BLANK_PAGE_15000_BOUND");
    await save("browser.json", { mode: "TASK_OWNED_VISIBLE_CHROME", version: browser!.version(),
      startupWallMs: performance.now() - started, startupBoundMs: 15000, freshContext: true, savedAuth: false,
      headless: false, policyBypass: false, cdp: false });
    page!.setDefaultTimeout(15000);
    context!.on("request", request => {
      if (new URL(request.url()).pathname !== proxyAcquire || request.method() !== "POST") return;
      const body = request.postDataJSON() as { workId: string };
      requests.push({ workId: body.workId, body });
    });
    context!.on("response", response => {
      const path = new URL(response.url()).pathname;
      if (![proxyAcquire, "/api/centropy/company-brain/application-projection"].includes(path)
        || response.request().method() !== "POST") return;
      capture = capture.then(async () => {
        const request = response.request().postDataJSON() as { workId: string };
        if (path === proxyAcquire) {
          responses.push({ status: response.status(), body: await response.json(), workId: request.workId });
        } else {
          // A normal scope invalidation may abort a read. Retain that transport
          // fact, but only complete real responses can satisfy the final oracle.
          let body: unknown = null, bodyDelivered = false;
          try { body = await response.json(); bodyDelivered = true; } catch { /* aborted native read */ }
          projections.push({ status: response.status(), request, body, bodyDelivered });
        }
      }).catch(() => { captureFailed = true; });
    });
    const credentials = auth!.private.credentials(actor), cursor = auth!.cursor();
    await page!.goto(frontendOrigin + "/centropy/login", { waitUntil: "domcontentloaded", timeout: 15000 });
    await page!.getByLabel("Email", { exact: true }).fill(credentials.email);
    await page!.getByLabel("Password", { exact: true }).fill(credentials.password);
    await page!.getByRole("button", { name: "Sign in", exact: true }).click();
    await page!.waitForURL(url => url.pathname === "/centropy", { timeout: 15000 });
    await page!.getByLabel("Account menu", { exact: true }).waitFor({ state: "visible" });
    await poll(() => auth!.observations(cursor).some(event => event.event === "password" && event.status === 200
      && event.caller === "BROWSER" && event.userId === actor), Boolean, "GENUINE_BROWSER_PASSWORD_LOGIN_REQUIRED");
  });
  const corrected = episodes[0]!, lost = episodes[1]!;
  let correctedId = "", lostId = "";
  await stage("owning-404-before-writes-and-same-panel-correction", async () => {
    await open(corrected);
    const panel = await page!.locator(panelSelector).elementHandle();
    assert(panel); // Its identity must survive the explicit refusal and correction.
    const missing = randomUUID();
    assert.equal((await sql!.query("SELECT count(*)::int n FROM finnor_os.auth_profiles WHERE id=$1", [missing])).rows[0].n, 0);
    const before = await counts(); await save("before-refusal.json", { missing, counts: before });
    await fill(corrected, missing);
    await observe("00-before-refusal-submit");
    const refusalPromise = page!.waitForResponse(response => new URL(response.url()).pathname === proxyAcquire
      && response.request().method() === "POST", { timeout: 15000 });
    await submit();
    const refusal = await refusalPromise, refusedBody = await refusal.json();
    await save("real-refusal.json", { status: refusal.status(), body: refusedBody,
      request: refusal.request().postDataJSON(), responseOrigin: new URL(refusal.url()).origin });
    assert.equal(refusal.status(), 404); assert.equal(refusedBody.code, "X2_ACQUISITION_PROFILE_UNAVAILABLE");
    await page!.locator(panelSelector).getByText("The native owner refused an unavailable profile before registration.", { exact: false })
      .waitFor({ state: "visible" });
    await matchPanel(corrected, null);
    const after = await counts(); await save("after-refusal.json", after); assert.deepEqual(after, before);
    assert(await panel.evaluate(node => node.isConnected && node === document.querySelector(".ct-application-semantics")));
    for (const name of ["profileIds", "targets", "resourceDemand", "deadlineAt"]) {
      assert(await page!.locator(panelSelector + ` [name="${name}"]`).isEnabled());
    }
    assert(await page!.locator(panelSelector).getByRole("button", { name: "Request acquisition and native reservation", exact: true }).isEnabled());
    await observe("01-explicit-refusal-inputs-editable");
    // Maintained clearing is expected. Refill ordinary controls, without remount.
    await fill(corrected, corrected.profileId);
    const acceptedPromise = page!.waitForResponse(response => new URL(response.url()).pathname === proxyAcquire
      && response.request().method() === "POST", { timeout: 15000 });
    await submit();
    const accepted = await acceptedPromise, acceptedBody = await accepted.json();
    await save("real-corrected-ack.json", { status: accepted.status(), body: acceptedBody, request: accepted.request().postDataJSON() });
    assert.equal(accepted.status(), 202); correctedId = registration.parse(acceptedBody).sessionId;
    await matchPanel(corrected, correctedId);
    assert(await panel.evaluate(node => node.isConnected && node === document.querySelector(".ct-application-semantics")));
    await canonical(corrected, correctedId, "corrected");
    await observe("02-corrected-registration");
    await page!.locator(panelSelector).getByRole("button", { name: "Refresh current scope", exact: true }).click();
    await matchPanel(corrected, correctedId); await sleep(3500);
    assert.equal(requests.filter(request => request.workId === corrected.workId).length, 2);
    await canonical(corrected, correctedId, "corrected-no-duplicate");
    await panel.dispose();
  });
  await stage("genuine-accepted-response-loss-stays-fenced", async () => {
    await open(lost);
    let intercepted = 0, transportFailed = false, routeFailure = false;
    const failedRequest = (request: import("playwright-core").Request) => {
      if (new URL(request.url()).pathname === proxyAcquire && request.method() === "POST"
        && (request.postDataJSON() as { workId: string }).workId === lost.workId) transportFailed = true;
    };
    page!.on("requestfailed", failedRequest);
    await page!.route(frontendOrigin + proxyAcquire, async route => {
      const request = route.request();
      if (request.method() !== "POST" || (request.postDataJSON() as { workId: string }).workId !== lost.workId) {
        await route.continue(); return;
      }
      try {
        intercepted++; assert.equal(intercepted, 1, "NO_AUTOMATIC_REPLAY_ALLOWED");
        const actual = await route.fetch({ timeout: 15000, maxRetries: 0, maxRedirects: 0 });
        try {
          const body = await actual.json();
          assert.equal(actual.status(), 202); lostId = registration.parse(body).sessionId;
          await canonical(lost, lostId, "accepted-before-response-loss");
          await save("real-accepted-response-deliberately-lost.json", { status: actual.status(), body,
            request: request.postDataJSON(), deliveredToBackend: true, deliveredToPage: false,
            fault: "ABORT_AFTER_GENUINE_BACKEND_REGISTRATION_NOT_SYNTHETIC_2XX" });
          await route.abort("failed");
        } finally { await actual.dispose(); }
      } catch {
        routeFailure = true;
        await route.abort("failed").catch(() => undefined);
      }
    });
    await fill(lost, lost.profileId); await submit();
    await poll(() => lostId && transportFailed, Boolean, "ACTUAL_ACCEPTANCE_THEN_TRANSPORT_LOSS_REQUIRED");
    assert(!routeFailure);
    await matchPanel(lost, lostId);
    const panel = page!.locator(panelSelector);
    await panel.getByText("The native request outcome is unconfirmed.", { exact: false }).waitFor({ state: "visible" });
    await panel.getByText("An original native request remains unconfirmed.", { exact: false }).waitFor({ state: "visible" });
    assert(!(await panel.getByRole("button", { name: "Request fresh use and native checks", exact: true }).isEnabled()));
    await observe("03-real-response-loss-fenced");
    await panel.getByRole("button", { name: "Refresh current scope", exact: true }).click();
    await matchPanel(lost, lostId);
    await panel.getByText("An original native request remains unconfirmed.", { exact: false }).waitFor({ state: "visible" });
    await sleep(3500);
    assert.equal(intercepted, 1); assert(transportFailed); assert(!routeFailure);
    assert.equal(requests.filter(request => request.workId === lost.workId).length, 1);
    assert(!(await panel.getByRole("button", { name: "Request fresh use and native checks", exact: true }).isEnabled()));
    await canonical(lost, lostId, "response-loss-no-duplicate");
    await observe("04-refreshed-unconfirmed-fence");
    await page!.unroute(frontendOrigin + proxyAcquire); page!.off("requestfailed", failedRequest);
  });
  await stage("ending-auth-registration-and-installed-custody", async () => {
    await capture; assert(!captureFailed);
    assert.equal(requests.length, 3);
    assert.deepEqual(responses.map(response => response.status), [404, 202]);
    const projectionSchema = z.object({
      schema: z.literal("finnor.x2.work-projection.v1"), tenantId: z.string().uuid(), principalId: z.string().uuid(),
      root: z.object({ entityType: z.literal("pe_deal"), entityId: z.string().uuid() }), workId: z.string().uuid(),
      sessions: z.array(z.object({ id: z.string().uuid(), parentId: z.string().uuid(), status: z.literal("QUEUED"),
        model: z.null(), check: z.null(), effects: z.array(z.unknown()).length(0) })).max(1),
    });
    const delivered = projections.filter(value => value.status === 200 && value.bodyDelivered)
      .map(value => projectionSchema.parse(value.body));
    for (const [episode, id] of [[corrected, correctedId], [lost, lostId]] as const) {
      const observed = delivered.find(value => value.workId === episode.workId
        && value.sessions.length === 1 && value.sessions[0]?.id === id);
      assert(observed, "ACTUAL_DELIVERED_EXACT_CANONICAL_PROJECTION_REQUIRED");
      assert.equal(observed.tenantId, tenant); assert.equal(observed.principalId, actor);
      assert.deepEqual(observed.root, root); assert.equal(observed.sessions[0]!.parentId, id);
    }
    const end = await counts();
    assert.equal(end.application_semantics_sessions, 2); assert.equal(end.s5_reservations, 2);
    assert.equal(end.s5_requests, 2); assert.equal(end.s5_proposals, 2);
    assert.equal(end.s5_reservation_origins, 2); assert.equal(end.s5_consumptions, 2);
    assert.equal(end.application_semantics_requests, 0);
    const observations = auth!.observations();
    assert(observations.some(event => event.caller === "BACKEND_SDK" && event.event === "user"
      && event.status === 200 && event.userId === actor), "REAL_BACKEND_SDK_USER_LOOKUP_REQUIRED");
    assert(!auth!.summary().overflow);
    await save("transport.json", { requests, responses, projections,
      ambiguousBackendResponse: "real-accepted-response-deliberately-lost.json" });
    await save("auth-observations.json", { observations, summary: auth!.summary() });
    await save("ending-counts.json", end);
    for (const pin of copiedPins.filter(pin => pin.path.startsWith("src/") || pin.path === "next.config.mjs")) {
      assert.equal(sha(await readFile(join(frontendDir, pin.path))), pin.sha256);
      assert.equal(sha(await readFile(join(runtime, pin.path))), pin.sha256);
    }
    await save("installed-ending.json", await inspectInstalledRuntime(runtime));
    await canonical(corrected, correctedId, "ending-corrected"); await canonical(lost, lostId, "ending-response-loss");
  });
} catch (error) {
  failed = true;
  await writeFile(join(privateDir, "driver-failure.txt"), String(error instanceof Error ? error.stack : error) + "\n", { mode: 0o600 });
} finally {
  const stop = async (owner: string, action: () => Promise<unknown>) => {
    try { await action(); cleanup.push({ owner, status: "PASS" }); }
    catch { failed = true; cleanup.push({ owner, status: "FAIL" }); }
  };
  await stop("retained-transport-observations", async () => {
    await bounded(capture, 5000, "TRANSPORT_CAPTURE_DEADLINE");
    await save("transport-final.json", { requests, responses, projections, captureFailed });
    if (auth) await save("auth-final.json", { observations: auth.observations(), summary: auth.summary() });
    assert(!captureFailed);
  });
  if (context) await stop("fresh-browser-context", () => bounded(context!.close(), 15000, "CONTEXT_CLOSE_DEADLINE"));
  if (browser) await stop("task-owned-visible-chrome", () => bounded(browser!.close(), 15000, "CHROME_CLOSE_DEADLINE"));
  for (const item of [...processes].reverse()) await stop(item.name, async () => {
    const kill = (signal: NodeJS.Signals) => {
      if (!item.child.pid) return;
      try { process.kill(-item.child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    };
    kill("SIGTERM");
    try { await bounded(item.exit, 10000, "OWNED_SERVICE_STOP_DEADLINE"); } catch { kill("SIGKILL"); await bounded(item.exit, 5000, "OWNED_SERVICE_KILL_DEADLINE"); }
    await item.flush();
  });
  if (api) await stop("installed-api", () => api!.close());
  if (auth) await stop("disposable-auth", () => auth!.close());
  await stop("canonical-app-pool", closePool);
  if (sql) await stop("canonical-admin-connection", () => sql!.end());
  if (database && databaseStarted) await stop("owned-postgres", () => bounded(database!.stop(), 15000, "POSTGRES_STOP_DEADLINE"));
  await save("result.json", { schema: "finnor.x2.intake-e2e.v1", EXECUTED: true, status: failed ? "FAIL" : "PASS",
    qualification: "ORDINARY_REGISTRATION_ONLY_NOT_BUSINESS_SUCCESS", stages, cleanup,
    runtime, noWorkerStarted: true, protectedAdmission: false, productionActivation: false,
    billingUSD: null, humanWork: null, aggregateSimultaneousMemory: null });
}
if (failed) process.exitCode = 1;
