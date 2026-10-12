import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { createServer } from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, writeFile, appendFile, readFile, rm } from "node:fs/promises";
import { statfsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "../../../packages/db/migrate";
import { closePool, withTenantTransaction, configureTenantVertical, receiveWork, attachWorkEntity } from "@finnor/db";
import { createDeal, createWorkstream, addDealParty, type PeMutationContext } from "@finnor/private-equity";
import { createDocument, appendDocumentVersion } from "@finnor/data-platform";
import { putAllocationResource } from "../../../packages/private-equity/src/allocation-store";
import { parseAllocationResource } from "../../../packages/epistemic-runtime/src/allocation-contracts";
import { authenticatedApiFixture } from "./authenticated-api-fixture.mts";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const evidence = process.env.FINNOR_X1_OWNER_EVIDENCE;
if (!evidence || !evidence.startsWith("/")) throw Error("FRESH_PRIVATE_X1_OWNER_EVIDENCE_REQUIRED");
const dutyCount=process.env.FINNOR_X1_OWNER_CASE==='128'?128:1;
if(process.env.FINNOR_X1_OWNER_CASE&&!['1','128'].includes(process.env.FINNOR_X1_OWNER_CASE))
  throw Error('EXACT_FROZEN_OWNER_CASE_REQUIRED');
const limits = JSON.parse(await readFile(join(repo, "scope-frontier5/x1-institutional-programme-compiler/verification-plan.json"), "utf8")).limits;
const disk = () => { const s = statfsSync(repo, { bigint: true }); return s.bavail * s.bsize; };
if (disk() < BigInt(limits.liveMinimumFreeBytes)) throw Error("FROZEN_LIVE_CAPACITY_REFUSED");
await mkdir(evidence, { mode: 0o700 });
for (const dir of ["tmp", "cache", "home", "originals"]) await mkdir(join(evidence, dir), { mode: 0o700 });
const started = performance.now(), startedAt = new Date().toISOString(), diskBefore = disk();
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", timeout: 5000 }).trim();
const sourcePaths = ["finnor-os/scripts/frontier5/x1/run-owner-slice.mts", "finnor-os/scripts/frontier5/x1/authenticated-api-fixture.mts",
  "finnor-os/scripts/frontier5/x1/physical-owner-worker.mts", "finnor-os/packages/db/migrations-bundle.ts",
  "finnor-os/package-lock.json", "scope-frontier5/x1-institutional-programme-compiler/profile.json"];
const sourcePins = await Promise.all(sourcePaths.map(async path => ({ path, sha256: sha(await readFile(join(repo, path))) })));
const freeze = { source: { commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"),
  dirty: git("status", "--porcelain=v1", "-uall"), pins: sourcePins }, startedAt,
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  profile: "DISPOSABLE_LOCAL_AUTH_SERVICE_ACTUAL_BEARER_AND_RLS", hostedSupabaseQualified: false,
  authDevBypass: false, expectedMigrations: 180, limits, freeBytesBefore: String(diskBefore), dutyCount,
  cases: ["A-raw-two-identity-native-request", "C-unsigned-forged-input", "D-same-key-replay", "G-restricted-roles"],
  omitted: "Full B–H, physical interruption, mounted browser, clean built installation/upgrade and protected qualification remain distinct required evidence" };
await writeFile(join(evidence, "freeze.json"), JSON.stringify(freeze, null, 2) + "\n", { mode: 0o600, flag: "wx" });
const results: any[] = [], traffic: unknown[] = [];
let database: EmbeddedPostgres | undefined, admin: pg.Client | undefined;
let service: Awaited<ReturnType<typeof authenticatedApiFixture>> | undefined, worker: ReturnType<typeof spawn> | undefined;
let peakOwnedRssBytes = 0, guard: NodeJS.Timeout | undefined;
const save = async (name: string, body: unknown) => writeFile(join(evidence, name), JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
const tenant = randomUUID(), actor = randomUUID(), institutionId = "unseen-local-" + randomUUID();
const ctx: PeMutationContext = { auth: { tenantId: tenant, userId: actor, employeeId: actor, role: "owner" },
  provenance: { sourceSystem: `x1:${institutionId}`, createdBy: actor } };
const deadlineAt = new Date(Date.now() + 1200000).toISOString();
const occurredAt = new Date(Date.now() - 120000).toISOString(), availableAt = new Date(Date.now() - 60000).toISOString();
const registrationA = "DEAL-" + randomUUID(), registrationB = "DEAL-" + randomUUID();
const requestText = "Provide the original signed evidence schedule " + randomUUID();
let workId: string | null = null, compilerId: string | null = null, expected: any = null;
const take = async () => {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8" }).trim().split("\n")
    .map(line => line.trim().split(/\s+/).map(Number));
  const owned = new Set([process.pid]);
  for (;;) { const before = owned.size; for (const row of rows) if (owned.has(row[1]!)) owned.add(row[0]!); if (owned.size === before) break; }
  const rss = rows.filter(row => owned.has(row[0]!)).reduce((sum, row) => sum + row[2]! * 1024, 0);
  peakOwnedRssBytes = Math.max(peakOwnedRssBytes, rss);
  const free = disk();
  await appendFile(join(evidence, "resources.jsonl"), JSON.stringify({ at: new Date().toISOString(),
    elapsedSeconds: (performance.now() - started) / 1000, ownedRssBytes: rss, freeBytes: String(free),
    sharedVolumeGrowthBytes: String(diskBefore - free) }) + "\n", { mode: 0o600 });
  if (free < BigInt(limits.liveMinimumFreeBytes) || diskBefore - free > BigInt(limits.liveEpisodeIncrementalDiskBytes)
      || rss > limits.localSampledProcessMemoryStopBytes || performance.now() - started > 840000)
    throw Error("X1_FROZEN_LIVE_RESOURCE_GUARD");
};
try {
  process.env.NODE_ENV = "test"; process.env.AUTH_DEV_BYPASS = "0";
  process.env.FINNOR_P4_PROFILE = "ordinary_disposable"; process.env.FINNOR_TEST_MANAGED_EXTENSIONS = "omit";
  process.env.RATE_LIMIT_PER_MINUTE = "10000"; process.env.RATE_LIMIT_IP_PER_MINUTE = "10000";
  const port = await new Promise<number>((yes, no) => { const socket = createServer(); socket.once("error", no);
    socket.listen(0, "127.0.0.1", () => { const address = socket.address(); if (!address || typeof address === "string") return no(Error("PORT_UNAVAILABLE")); socket.close(() => yes(address.port)); }); });
  const password = randomBytes(32).toString("hex"), appPassword = randomBytes(32).toString("hex"), workerPassword = randomBytes(32).toString("hex");
  const directory = join(evidence, "tmp/database");
  database = new EmbeddedPostgres({ databaseDir: directory, user: "x1_fixture", password, port, persistent: false,
    postgresFlags: ["-c", "listen_addresses=127.0.0.1", "-c", "unix_socket_directories="], onLog: () => {} });
  await database.initialise(); await appendFile(join(directory, "postgresql.conf"), "\ntrack_commit_timestamp=on\n");
  await database.start(); await database.createDatabase("x1_owner");
  const connection = (user: string, pass: string) => `postgres://${user}:${pass}@127.0.0.1:${port}/x1_owner`;
  const migrations = await migrate(connection("x1_fixture", password)); assert.equal(migrations.length, freeze.expectedMigrations);
  admin = new pg.Client({ connectionString: connection("x1_fixture", password) }); await admin.connect();
  await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD " + admin.escapeLiteral(appPassword));
  await admin.query("ALTER ROLE finnor_worker LOGIN PASSWORD " + admin.escapeLiteral(workerPassword));
  const roles = (await admin.query(`SELECT rolname,rolsuper,rolbypassrls,
    pg_has_role('finnor_app','finnor_worker','MEMBER') app_inherits_worker
    FROM pg_roles WHERE rolname IN('finnor_app','finnor_worker') ORDER BY rolname`)).rows;
  assert.equal(roles.length, 2); for (const r of roles) { assert.equal(r.rolsuper, false); assert.equal(r.rolbypassrls, false); assert.equal(r.app_inherits_worker, false); }
  await save("migration-roles.json", { migrations, roles, databaseProfile: "ACTUAL_DISPOSABLE_POSTGRES_18", noHostedSecrets: true });
  await admin.query("SET app.test_vertical_mode='explicit'");
  await admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'X1 raw owner slice')", [tenant, randomUUID()]);
  await admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$2,$3,'owner','active','Unseen owner')", [actor, tenant, actor + "@test.invalid"]);
  process.env.DATABASE_URL = connection("finnor_app", appPassword); await closePool();
  await configureTenantVertical({ tenantId: tenant, verticalKey: "private_equity", expectedVersion: 0, createdBy: actor, sourceSystem: "X1:owner-e2e" });
  const companyIds = [randomUUID(), randomUUID()];
  for (const id of companyIds) await admin.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,'Conflicting Harbor','other')", [id, tenant, "org-" + id]);
  const deal = async (index: number, registration: string) => createDeal({ ...ctx, provenance: { ...ctx.provenance, externalId: registration } },
    { targetOrganizationId: companyIds[index]!, name: "Conflicting Harbor", dealLeadEmployeeId: actor,
      signedLoiAt: new Date(Date.now() - 86400000), targetClosingAt: new Date(Date.now() + 86400000) });
  const first = await deal(0, registrationA), second = await deal(1, registrationB);
  const workstreamExternalId = "WS-" + randomUUID(), recipientExternalId = "PARTY-" + randomUUID();
  const stream = await createWorkstream({ ...ctx, provenance: { ...ctx.provenance, externalId: workstreamExternalId } },
    { dealId: String(first.row.id), kind: "financial_diligence", name: "Evidence schedule", owner: { partyType: "employee", partyId: actor } });
  const party = await addDealParty({ ...ctx, provenance: { ...ctx.provenance, externalId: recipientExternalId } },
    { dealId: String(first.row.id), party: { partyType: "external_organization", partyId: companyIds[0]! }, role: "target_management" });
  const intake = await receiveWork({ tenantId: tenant, userId: actor, channel: "console", idempotencyKey: "x1-owner-intake:" + randomUUID(),
    instruction: "Maintain the supplied standing evidence responsibility from authorized originals, with no external approval or settlement",
    activeContext: { entityType: "pe_deal", entityId: String(first.row.id) }, authorityContext: { principalId: actor, scope: "DISPOSABLE_INTERNAL_REQUEST_CREATION_ONLY" } });
  workId = intake.workId;
  for (const d of [first, second]) await attachWorkEntity(tenant, workId, { entityType: "pe_deal", entityId: String(d.row.id), source: "X1:original-owner-registration" });
  const rule = { id: "standing-request", triggerKind: "evidence_request_needed", operation: "create_deal_request", principalId: actor,
    deadlineAt, materiality: "material", postconditionRef: "x1:pe-request-created:v1", observerRef: "x1:pe-request-creation-observer:v1" };
  await admin.query(`INSERT INTO finnor_os.x1_work_mandates(tenant_id,principal_id,work_id,institution_id,revision,rules,valid_from,expires_at)
    VALUES($1,$2,$3,$4,'r1',$5::jsonb,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')`, [tenant, actor, workId, institutionId, JSON.stringify([rule])]);
  service = await authenticatedApiFixture(repo, actor, entry => traffic.push(entry));
  const policyResponse=await fetch(service.origin+`/api/policies/${tenant}/create_deal_request`,{
    method:'PUT',headers:{'content-type':'application/json',authorization:'Bearer '+service.token},
    body:JSON.stringify({policy:{scope:'DISPOSABLE_INTERNAL_REQUEST_ONLY'},requiresConfirmation:false})});
  const policyBody=await policyResponse.json();assert.equal(policyResponse.status,200,JSON.stringify(policyBody));
  await save('authenticated-standing-native-policy.json',{status:policyResponse.status,body:policyBody,
    boundary:'ACTUAL_AUTHENTICATED_ORDINARY_OWNER_POLICY_API_BEFORE_COMPILER_EXPOSURE',protectedGrantCreated:false});
  const rights = String((await admin.query("SELECT revision FROM finnor_os.authority_states WHERE tenant_id=$1", [tenant])).rows[0].revision);
  const ref = (owner: string, id: string) => ({ owner, id, version: "owner-fixture-v1", contentDigest: sha(id) });
  const now = new Date().toISOString();
  for (const [resourceId, resourceClass, unit, amount] of [["x1-compute", "COMPUTE", "request", "520"], ["x1-human", "HUMAN_ATTENTION", "seconds", "900"]]) {
    const input = parseAllocationResource({ schema: "finnor.allocation-resource.v1", resourceId, resourceClass, tenantId: tenant,
      ownerRef: ref("BUSINESS_OWNER", actor), legalEntityRef: ref("S1", String(first.row.id)), scopeRef: ref("BUSINESS_OWNER", institutionId),
      permittedRoots: [{ entityType: "pe_deal", entityId: String(first.row.id) }], rightsRef: `authority:${tenant}:${rights}`,
      unit, currency: null, kind: "CUMULATIVE_EXPENDITURE", horizon: { startAt: now, periodMs: 3600000, periods: 1 },
      sourceRef: ref("BUSINESS_OWNER", "capacity:" + resourceId), asOf: now, knowledgeAt: now,
      validUntil: new Date(Date.now() + 3600000).toISOString(), beliefPins: [],
      availability: [{ amount, basis: "REPORTED_AVAILABLE" }, { amount, basis: "REPORTED_AVAILABLE" }],
      existingUse: ["0", "0"], safetyMargin: "0", covenants: [], revoked: false, qualification: "AUTHENTICATED_OWNER_ASSERTION_UNADMITTED" });
    await putAllocationResource(ctx, input, null);
  }
  const sources = [
    { id: "crm-original", sourceClass: "crm_deals", rows: [
      { id: "deal-A", kind: "entity", entityType: "deal", registrationId: registrationA, name: "Conflicting Harbor" },
      { id: "deal-B", kind: "entity", entityType: "deal", registrationId: registrationB, name: "Conflicting Harbor" }] },
    { id: "ledger-original", sourceClass: "financial_ledger", rows: [{ id: "balance-A", kind: "quantity", registrationId: registrationA,
      factKey: "facility_balance", value: "20.00", currency: "USD", unit: "units", period: "2026-10", basis: "outstanding", occurredAt, availableAt }] },
    { id: "work-original", sourceClass: "work_tracking", rows: Array.from({length:dutyCount},(_,index)=>({ id: "request-"+index, kind: "trigger", triggerKind: "evidence_request_needed",
      registrationId: registrationA, occurredAt, availableAt, workstreamExternalId, requestedFromExternalId: recipientExternalId,
      requestText:dutyCount===1?requestText:requestText+' item '+index, requiresAcceptedDeliverable: true })) },
  ];
  const grantIds: string[] = [], sourceBindings: unknown[] = [];
  for (const source of sources) {
    const bytes = Buffer.from(JSON.stringify(source.rows)), grantId = randomUUID();
    const version = await withTenantTransaction(tenant, { userId: actor }, async db => {
      const doc = await createDocument(db, { tenantId: tenant, kind: "source_export", title: source.id,
        provenance: { sourceSystem: "owner-export", externalId: source.id, createdBy: actor } });
      return appendDocumentVersion(db, { tenantId: tenant, documentId: doc.documentId, bytes, mediaType: "application/json", format: "unknown",
        origin: "manual_upload", actor, sourceSystem: "owner-export", sourceRef: source.id, providerVersionId: "r1" });
    });
    await admin.query(`INSERT INTO finnor_os.x1_source_grants(id,tenant_id,principal_id,work_id,institution_id,source_id,source_class,
      purpose,acquisition_kind,document_id,document_version_id,protocol,revision,original_sha256,expected_object_ids,valid_from,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'standing evidence responsibility','core_export',$8,$9,'json_records','r1',$10,$11::jsonb,
        clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')`,
    [grantId, tenant, actor, workId, institutionId, source.id, source.sourceClass, version.document_id, version.id, sha(bytes), JSON.stringify(source.rows.map(r => r.id))]);
    await writeFile(join(evidence, "originals", source.id + ".json"), bytes, { mode: 0o600, flag: "wx" });
    grantIds.push(grantId); sourceBindings.push({ sourceId: source.id, sourceClass: source.sourceClass, grantId, versionId: version.id, documentId: version.document_id, sha256: sha(bytes) });
  }
  expected = { mappings: [{ sourceId: "crm-original", recordId: "deal-A", canonicalId: String(first.row.id) },
    { sourceId: "crm-original", recordId: "deal-B", canonicalId: String(second.row.id) }],
    request: { tenantId: tenant, dealId: String(first.row.id), workstreamId: String(stream.row.id), requestedFromDealPartyId: String(party.row.id),
      ownerPartyId: actor, requestText, requestedAt: occurredAt, dueAt: deadlineAt, requiresAcceptedDeliverable: true },
    requestTexts:Array.from({length:dutyCount},(_,index)=>dutyCount===1?requestText:requestText+' item '+index),
    expectedRequestCount: dutyCount, expectedCompletionMeaning: "CREATION_ONLY_NOT_FULFILLMENT_OR_APPROVAL" };
  await save("inputs-and-independent-expectations.json", { tenant, actor, institutionId, workId, rule, sourceBindings, expected });
  await admin.query(`INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,source)
    VALUES('native:p4',2,2,0,60,'explicit disposable X1 validation capacity; not protected funding')`);
  const api = async (operation: string, body: unknown, bearer: string | null = service!.token) => {
    const response = await fetch(service!.origin + "/api/company-brain/" + operation, { method: "POST",
      headers: { "content-type": "application/json", ...(bearer ? { authorization: "Bearer " + bearer } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    return { status: response.status, body: await response.json() as any };
  };
  const me = await fetch(service.origin + "/api/me", { headers: { authorization: "Bearer " + service.token } });
  const identity = await me.json(); assert.equal(me.status, 200); assert.equal(identity.tenantId, tenant); assert.equal(identity.userId, actor);
  const metadata = await api("institution-sources", { workId }); assert.equal(metadata.status, 200, JSON.stringify(metadata));
  const input = { workId, workInputId: metadata.body.workInputId, grantIds, idempotencyKey: "x1-original:" + randomUUID() };
  assert.equal((await api("institution-submit", input, null)).status, 401);
  assert.equal((await api("institution-submit", { ...input, candidate: {} })).status, 400);
  const accepted = await api("institution-submit", input); assert.equal(accepted.status, 202, JSON.stringify(accepted)); compilerId = accepted.body.requestId;
  await save("authenticated-submit.json", { identity, metadata, input, accepted, authDevBypass: false, tokenPersisted: false });
  await writeFile(join(evidence, "empty.env"), "", { mode: 0o600 });
  const env = { HOME: join(evidence, "home"), PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: join(evidence, "tmp"),
    XDG_CACHE_HOME: join(evidence, "cache"), TSX_DISABLE_CACHE: "1", DOTENV_CONFIG_PATH: join(evidence, "empty.env"),
    NODE_ENV: "test", AUTH_DEV_BYPASS: "0", FINNOR_P4_PROFILE: "ordinary_disposable", FINNOR_TEST_MANAGED_EXTENSIONS: "omit",
    DATABASE_URL: connection("finnor_worker", workerPassword), CI: "1", LOG_LEVEL: "silent", NEXT_TELEMETRY_DISABLED: "1" };
  worker = spawn(process.execPath, ["--max-old-space-size=1536", "--import=tsx", "scripts/frontier5/x1/physical-owner-worker.mts"],
    { cwd: join(repo, "finnor-os"), env, stdio: ["ignore", "pipe", "pipe"] });
  let logBytes = 0; for (const stream of [worker.stdout!, worker.stderr!]) stream.on("data", b => {
    logBytes += b.length; if (logBytes <= limits.smallCheckOutputBytes) void appendFile(join(evidence, "worker.log"), b, { mode: 0o600 });
    else worker?.kill("SIGTERM");
  });
  await save("physical-worker.json", { pid: worker.pid, parentPid: process.pid, environmentNames: Object.keys(env),
    role: "finnor_worker", actualProductionRegistrations: true, credentialsPersisted: false });
  let guardFailure: string | null = null;
  guard = setInterval(() => { void take().catch(error => { guardFailure = String(error.message); worker?.kill("SIGTERM"); }); }, 2000);
  let reading: any;
  for (let poll = 0; poll < 240; poll++) {
    if (guardFailure) throw Error(guardFailure);
    if (worker.exitCode !== null || worker.signalCode !== null) throw Error("PHYSICAL_WORKER_STOPPED_BEFORE_OWNER_OBSERVATION");
    const response = await api("institution-read", { requestId: compilerId });
    await appendFile(join(evidence, "compiler-observations.jsonl"), JSON.stringify({ at: new Date().toISOString(), response }) + "\n", { mode: 0o600 });
    assert.equal(response.status, 200, JSON.stringify(response)); reading = response.body;
    if (["OBSERVED", "CHECK_REJECTED", "FAILED", "UNKNOWN", "INVALIDATED", "PARTIAL"].includes(reading.status)) break;
    const terminal=(await admin.query(`SELECT p.status,p.failure,
      (SELECT count(*)::int FROM finnor_os.jobs j WHERE j.tenant_id=p.tenant_id
        AND j.status IN('queued','running')) active_jobs FROM finnor_os.p1_requests p
      JOIN finnor_os.x1_compiler_requests x ON x.tenant_id=p.tenant_id AND x.program_id=p.id
      WHERE x.tenant_id=$1 AND x.id=$2`,[tenant,compilerId])).rows[0];
    if(terminal?.failure&&terminal.active_jobs===0){
      await save('terminal-queue-observation.json',{at:new Date().toISOString(),terminal,
        originalFailureRetained:true,episodeRestarted:false});break;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  await save("compiler-ending-projection.json", reading);
  assert.equal(reading.status, "OBSERVED", "actual compiler/native progression: " + JSON.stringify({ status: reading.status, reason: reading.reason }));
  assert.equal((await admin.query(`SELECT count(*)::int n FROM finnor_os.x1_compiler_requests
    WHERE tenant_id=$1 AND work_id=$2`,[tenant,workId])).rows[0].n,1,
    'own native graph maintenance must not create a spurious compiler revision');
  const admission=(await admin.query(`SELECT a.receipts FROM finnor_os.x1_mapping_admissions a
    JOIN finnor_os.x1_compiler_requests r ON r.tenant_id=a.tenant_id AND r.admission_id=a.id
    WHERE r.tenant_id=$1 AND r.principal_id=$2 AND r.id=$3`,[tenant,actor,compilerId])).rows[0];
  assert.ok(admission,"actual S1 mapping admission required");
  for(const mapping of expected.mappings){
    const receipt=admission.receipts.find((r:any)=>r.sourceId===mapping.sourceId&&r.recordId===mapping.recordId);
    assert.ok(receipt,"independently expected original mapping must be admitted");
    assert.match(receipt.canonicalRef,new RegExp(`^pe_deal:${mapping.canonicalId}@v[1-9][0-9]*$`));
    const link:{entity_type:string;entity_id:string;evidence_source_id:string;evidence_version_id:string}|undefined=(await admin.query(`SELECT entity_type,entity_id,evidence_source_id,evidence_version_id FROM finnor_os.pe_evidence_links
      WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL`,[tenant,receipt.evidenceLinkId])).rows[0];
    assert.equal(link?.entity_type,"pe_deal");assert.equal(link?.entity_id,mapping.canonicalId);
    assert.equal(link?.evidence_source_id,receipt.evidenceSourceId);assert.equal(link?.evidence_version_id,receipt.evidenceVersionId);
  }
  const rows = (await admin.query(`SELECT * FROM finnor_os.pe_requests WHERE tenant_id=$1 AND deal_id=$2 AND request_text=ANY($3::text[])`, [tenant, expected.request.dealId, expected.requestTexts])).rows;
  assert.equal(rows.length, expected.expectedRequestCount);
  const allEffects:any[]=[];
  for(const expectedText of expected.requestTexts){
  const matching=rows.filter(row=>row.request_text===expectedText);assert.equal(matching.length,1);
  const row = matching[0], oracle = expected.request;
  assert.equal(row.workstream_id, oracle.workstreamId); assert.equal(row.requested_from_deal_party_id, oracle.requestedFromDealPartyId);
  assert.equal(row.owner_party_type, "employee"); assert.equal(row.owner_party_id, actor); assert.equal(row.requires_accepted_deliverable, true);
  assert.equal(new Date(row.requested_at).toISOString(), occurredAt); assert.equal(new Date(row.due_at).toISOString(), deadlineAt);
  assert.ok(new Date(row.created_at).getTime() <= Date.parse(deadlineAt)); assert.equal(row.state, "open"); assert.equal(row.fulfilled_at, null);
  const effects:{id:string;status:string;effect_status:string;authority_context:any}[] = (await admin.query(`SELECT a.id,a.status,a.authority_context,e.status effect_status FROM finnor_os.domain_actions a
    JOIN finnor_os.business_effects e ON e.tenant_id=a.tenant_id AND e.domain_action_id=a.id
    WHERE a.tenant_id=$1 AND a.id=$2 AND a.work_id=$3`, [tenant, row.id, workId])).rows;
  assert.equal(effects.length, 1); assert.equal(effects[0]!.status, "completed"); assert.equal(effects[0]!.effect_status, "verified");
  const origin=effects[0]!.authority_context;assert.equal(origin.kind,'institution_duty');
  assert.equal(origin.principal,actor);assert.equal(origin.compilerRequestId,compilerId);
  assert.equal(origin.workInputId,input.workInputId);assert.ok(origin.stableIdentity);
  allEffects.push(...effects);
  }
  const plans=(await admin.query(`SELECT id,revision,status,parent_revision_id,plan_graph FROM finnor_os.work_plan_revisions
    WHERE tenant_id=$1 AND work_id=$2 ORDER BY revision`,[tenant,workId])).rows;
  assert.ok(plans.length>=2,'native action batch followed by independent observation child');
  for(const plan of plans){assert.ok(plan.plan_graph.nodes.length<=40);
    for(const node of plan.plan_graph.nodes)assert.ok(node.dependsOn.length<=24);}
  assert.equal(plans.at(-1)!.plan_graph.nodes.filter((node:any)=>node.kind==='action').length,0);
  const linked=(await admin.query(`SELECT a.id,a.plan_node_id,a.plan_revision_id,
    n->>'kind' node_kind,n->>'actionType' node_action_type FROM finnor_os.domain_actions a
    JOIN finnor_os.work_plan_revisions p ON p.tenant_id=a.tenant_id AND p.id=a.plan_revision_id
    JOIN LATERAL jsonb_array_elements(p.plan_graph->'nodes') n ON n->>'id'=a.plan_node_id
    WHERE a.tenant_id=$1 AND a.work_id=$2 AND a.id=ANY($3::uuid[])`,[tenant,workId,rows.map(row=>row.id)])).rows;
  assert.equal(linked.length,dutyCount);assert.ok(linked.every(row=>row.node_kind==='action'&&row.node_action_type==='create_deal_request'));
  const immutableOrigin={tenantId:tenant,actionId:rows[0]!.id,predicate:'X1_ORIGINAL_ACTION_ORIGIN_IMMUTABLE'};
  await assert.rejects(admin.query(`UPDATE finnor_os.domain_actions SET authority_context=authority_context-'kind'
    WHERE tenant_id=$1 AND id=$2`,[tenant,immutableOrigin.actionId]),new RegExp(immutableOrigin.predicate));
  await save('native-origin-downgrade-refusal.json',{...immutableOrigin,actualSqlRefusal:true});
  const originalEnvelope=async()=>({episodes:(await admin!.query(`SELECT id,original_deadline,wall_deadline,parent_reservation,parent_demand
    FROM finnor_os.x1_compiler_episodes WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 ORDER BY id`,[tenant,actor,workId])).rows,
    reservations:(await admin!.query(`SELECT reservation_id,status,envelopes FROM finnor_os.s5_reservations WHERE tenant_id=$1 ORDER BY reservation_id`,[tenant])).rows,
    resources:(await admin!.query(`SELECT resource_id,revision FROM finnor_os.s5_resource_heads WHERE tenant_id=$1 ORDER BY resource_id`,[tenant])).rows});
  const beforeReplay=await originalEnvelope();
  const repeated = await api("institution-submit", input); assert.equal(repeated.status, 202); assert.equal(repeated.body.requestId, compilerId);
  const afterReplay=await originalEnvelope();assert.deepEqual(afterReplay,beforeReplay,"same original episode/reservation/resources on replay");
  assert.equal((await admin.query("SELECT count(*)::int n FROM finnor_os.pe_requests WHERE tenant_id=$1 AND request_text=ANY($2::text[])", [tenant, expected.requestTexts])).rows[0].n,dutyCount);
  results.push({ id: "A-authenticated-owner-creation", status: "PASS", observed: { compilerId, admission, rows, effects:allEffects,plans,linked,repeated, beforeReplay, afterReplay },
    basis: "ACTUAL_LOCAL_AUTH_HTTP_SQL_PHYSICAL_WORKER_NATIVE_CREATE_AND_INDEPENDENT_SQL_OBSERVER" });
} catch (error) {
  results.push({ id: "actual-owner-boundary", status: "FAIL", observed: { message: String((error as Error).message),
    stack: (error as Error).stack, cause: (error as any).cause?.message ?? null,
    sql: { code: (error as any).code ?? null, where: (error as any).where ?? null,
      internalQuery: (error as any).internalQuery ?? null, position: (error as any).position ?? null } } });
} finally {
  if (guard) clearInterval(guard);
  if (admin && workId) {
    for (const [name, sql] of [
      ["jobs", "SELECT id,type,status,attempts,protocol_version,retry_safety,claim_token,claim_fence,lease_expires_at,last_error,payload FROM finnor_os.jobs WHERE tenant_id=$1 ORDER BY id"],
      ["deliveries", "SELECT a.* FROM finnor_os.job_delivery_attempts a WHERE a.tenant_id=$1 ORDER BY started_at"],
      ["compiler", "SELECT * FROM finnor_os.x1_compiler_requests WHERE tenant_id=$1 ORDER BY revision"],
      ["compiler-events", "SELECT kind,body,created_at FROM finnor_os.x1_compiler_events WHERE tenant_id=$1 ORDER BY created_at,id"],
      ["compiler-updates", "SELECT * FROM finnor_os.x1_compiler_updates WHERE tenant_id=$1 ORDER BY created_at,id"],
      ["native", "SELECT id,status,failure,proposed,request,head_id FROM finnor_os.p1_requests WHERE tenant_id=$1"],
      ["resource-charges", "SELECT * FROM finnor_os.s5_governed_resource_charges WHERE tenant_id=$1"],
      ["deals", "SELECT id,version,source_system,external_id,status,name FROM finnor_os.pe_deals WHERE tenant_id=$1 ORDER BY id"],
      ["mapping-admissions", "SELECT * FROM finnor_os.x1_mapping_admissions WHERE tenant_id=$1"],
      ["actions", "SELECT id,status,action_type,work_id,plan_revision_id,plan_node_id,authority_context FROM finnor_os.domain_actions WHERE tenant_id=$1"],
      ["native-events", "SELECT kind,body,created_at FROM finnor_os.p1_events WHERE tenant_id=$1 ORDER BY created_at,id"],
      ["plans", "SELECT id,revision,status,parent_revision_id,plan_graph,revision_transition FROM finnor_os.work_plan_revisions WHERE tenant_id=$1 ORDER BY revision"],
    ]) { try { await save(name! + ".json", (await admin.query(sql!, [tenant])).rows); } catch (error) { await save(name! + "-read-gap.json", { predicate: String((error as Error).message) }); } }
  }
  if (worker && worker.exitCode === null && worker.signalCode === null) {
    const stopped = new Promise<void>(resolve => worker!.once("close", () => resolve())); worker.kill("SIGTERM");
    const timer = setTimeout(() => worker?.kill("SIGKILL"), 15000); await stopped; clearTimeout(timer);
  }
  await save("traffic.json", traffic);
  await service?.close(); await closePool(); await admin?.end(); await database?.stop().catch(() => {});
  await rm(join(evidence, "tmp/database"), { recursive: true, force: true });
  const currentPins = await Promise.all(sourcePaths.map(async path => ({ path, sha256: sha(await readFile(join(repo, path))) })));
  const sourceUnchanged = JSON.stringify(sourcePins) === JSON.stringify(currentPins) && freeze.source.commit === git("rev-parse", "HEAD");
  await save("results.json", { startedAt, completedAt: new Date().toISOString(), durationMs: performance.now() - started,
    status: results.length && results.every(r => r.status === "PASS") && sourceUnchanged ? "PASS_LOCAL_OWNER_SLICE" : "FAIL_OR_INCOMPLETE",
    results, expected, compilerId, workId, sourceUnchanged, peakSampledOwnedRssBytes: peakOwnedRssBytes,
    monetaryCostUsd: null, aggregateMemoryQualification: "UNKNOWN_SAMPLED_LOCAL_PROCESSES_ONLY", source: freeze.source,
    fullEngineeringOrQualificationEstablished: false, rerun: "Use a new private FINNOR_X1_OWNER_EVIDENCE directory and run the exact recorded source/runtime command" });
}
const exitCode = results.some(r => r.status === "FAIL") || !results.length ? 1 : 0;
await new Promise<void>(done => process.stdout.write(JSON.stringify({ evidence, passed: results.filter(r => r.status === "PASS").length,
  failed: results.filter(r => r.status === "FAIL").length, fullEngineeringComplete: false, exitCode }) + "\n", () => done()));
// Imported disposable DB lifecycle hooks cannot replace the recorded verdict.
process.exit(exitCode);
