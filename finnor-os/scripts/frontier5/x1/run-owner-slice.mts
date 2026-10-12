import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { createServer } from "node:net";
import { createServer as createHttpServer,type Server } from 'node:http';
import { spawn, execFileSync } from "node:child_process";
import { mkdir, writeFile, appendFile, readFile, rm } from "node:fs/promises";
import { statfsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "../../../packages/db/migrate";
import { closePool, withTenantTransaction, configureTenantVertical, receiveWork, attachWorkEntity,
  createEmployeeConversationThread,updateEmployeeConversationThreadContext } from "@finnor/db";
import { createDeal, createWorkstream, addDealParty, type PeMutationContext } from "@finnor/private-equity";
import { createDocument, appendDocumentVersion } from "@finnor/data-platform";
import { putAllocationResource } from "../../../packages/private-equity/src/allocation-store";
import { parseAllocationResource } from "../../../packages/epistemic-runtime/src/allocation-contracts";
import { authenticatedApiFixture } from "./authenticated-api-fixture.mts";
import { heterogeneousOwnerSources,type OwnerSource } from './owner-source-corpus.mts';
import { canonicalOwnerSources } from './canonical-owner-corpus.mts';

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const evidence = process.env.FINNOR_X1_OWNER_EVIDENCE;
if (!evidence || !evidence.startsWith("/")) throw Error("FRESH_PRIVATE_X1_OWNER_EVIDENCE_REQUIRED");
const dutyCount=process.env.FINNOR_X1_OWNER_CASE==='128'?128:1;
const mounted=process.env.FINNOR_X1_OWNER_MODE==='mounted';
const revise=process.env.FINNOR_X1_OWNER_MODE==='revision';
const material=process.env.FINNOR_X1_OWNER_MODE==='material';
const heterogeneous=process.env.FINNOR_X1_OWNER_MODE==='heterogeneous';
const canonical=process.env.FINNOR_X1_OWNER_MODE==='canonical';
const recovery=process.env.FINNOR_X1_OWNER_MODE==='recovery';
const contention=process.env.FINNOR_X1_OWNER_MODE==='contention';
if(process.env.FINNOR_X1_OWNER_MODE&&!['api','mounted','revision','material','heterogeneous','canonical','recovery','contention'].includes(process.env.FINNOR_X1_OWNER_MODE))
  throw Error('EXACT_REGISTERED_OWNER_MODE_REQUIRED');
if((mounted||material||heterogeneous||canonical||recovery||contention)&&dutyCount!==1)throw Error('NAMED_ONE_DUTY_SCENARIO_REQUIRED');
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
  'finnor-os/scripts/frontier5/x1/owner-source-corpus.mts',
  'finnor-os/scripts/frontier5/x1/canonical-owner-corpus.mts',
  "finnor-os/scripts/frontier5/x1/physical-owner-worker.mts", "finnor-os/packages/db/migrations-bundle.ts",
  "finnor-os/package-lock.json", "scope-frontier5/x1-institutional-programme-compiler/profile.json"];
const sourcePins = await Promise.all(sourcePaths.map(async path => ({ path, sha256: sha(await readFile(join(repo, path))) })));
const freeze = { source: { commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"),
  dirty: git("status", "--porcelain=v1", "-uall"),dirtyDiffDigest:sha(git('diff','--binary')), pins: sourcePins }, startedAt,
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  profile: "DISPOSABLE_LOCAL_AUTH_SERVICE_ACTUAL_BEARER_AND_RLS", hostedSupabaseQualified: false,
  authDevBypass: false, expectedMigrations: 181, limits, freeBytesBefore: String(diskBefore), dutyCount,mounted,
  cases: ["A-raw-two-identity-native-request", "C-unsigned-forged-input", "D-same-key-replay", "G-restricted-roles",
    ...(material?['B-ledger-correction']:[]),...(heterogeneous?['A-eight-class-original-corpus']:[]),
    ...(canonical?['A-fourteen-canonical-kinds']:[]),...(recovery?['D-compiler-before-publication-death']:[]),
    ...(contention?['E-original-shared-parent-contention']:[])],
  omitted: "Full B–H, physical interruption, mounted browser, clean built installation/upgrade and protected qualification remain distinct required evidence" };
await writeFile(join(evidence, "freeze.json"), JSON.stringify(freeze, null, 2) + "\n", { mode: 0o600, flag: "wx" });
const results: any[] = [], traffic: unknown[] = [];
let database: EmbeddedPostgres | undefined, admin: pg.Client | undefined;
let publicationBlocker:pg.Client|undefined;
let service: Awaited<ReturnType<typeof authenticatedApiFixture>> | undefined, worker: ReturnType<typeof spawn> | undefined;
let frontend:ReturnType<typeof spawn>|undefined;
let mountedControl:Server|undefined;
let mountedRevisionVerified=false;
let revokeOnHeldRead=false,heldReadReleased=false;
let delayedRead:{entered:boolean;requestId:string|null;status:number|null;promise:Promise<void>;release:()=>void}|null=null;
const releaseDelayedRead=()=>delayedRead?.release();
const readDelayedRead=()=>delayedRead;
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
const freePort=()=>new Promise<number>((yes,no)=>{const socket=createServer();socket.once('error',no);
  socket.listen(0,'127.0.0.1',()=>{const address=socket.address();if(!address||typeof address==='string')return no(Error('PORT_UNAVAILABLE'));
    socket.close(()=>yes(address.port));});});
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
  const frontendPort=mounted?await freePort():null,frontendOrigin=frontendPort?'http://127.0.0.1:'+frontendPort:null;
  const revokeFixturePrincipal=async()=>{
    const controlDb=new pg.Client({connectionString:connection('x1_fixture',password)});
    try{await controlDb.connect();const rows=(await controlDb.query(`UPDATE finnor_os.users SET status='suspended'
      WHERE tenant_id=$1 AND id=$2 RETURNING id,status`,[tenant,actor])).rows;
      await save('mounted-actual-principal-revocation.json',{at:new Date().toISOString(),rows,
        authority:(await controlDb.query('SELECT revision FROM finnor_os.authority_states WHERE tenant_id=$1',[tenant])).rows});
      return rows.length===1;
    }finally{await controlDb.end();}
  };
  service = await authenticatedApiFixture(repo, actor, entry => traffic.push(entry),
    frontendOrigin?{frontendOrigin,afterResponse:async(path,body,status)=>{
      if(path==='/api/company-brain/institution-read'&&mountedRevisionVerified&&delayedRead&&!delayedRead.entered){
        delayedRead.entered=true;delayedRead.requestId=JSON.parse(body).requestId;delayedRead.status=status;
        await save('mounted-delayed-response-entered.json',{at:new Date().toISOString(),
          requestId:delayedRead.requestId,status,actualHandlerCompleted:true});
        if(revokeOnHeldRead)await revokeFixturePrincipal();
        await delayedRead.promise;
      }
    }}:{});
  const profileResponse=await fetch(service.origin+'/api/workforce/profiles',{
    method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+service.token},
    body:JSON.stringify({key:'x1-disposable-native',name:'Disposable native responsibility query and check executor',
      capabilityGrants:[{kind:'query',capability:'query:harness_program_v1'},
        {kind:'check',capability:'check:objective_success'}],
      autonomyLimits:{maxActions:1,maxQueries:8,maxReplans:6,maxPlannerCalls:8,maxWallClockMs:3600000},
      planningHints:{qualification:'DISPOSABLE_ORDINARY_NO_PROTECTED_ADMISSION'}})});
  const profileBody=await profileResponse.json();assert.equal(profileResponse.status,201,JSON.stringify(profileBody));
  await save('authenticated-native-query-profile.json',{status:profileResponse.status,body:profileBody,
    boundary:'ACTUAL_AUTHENTICATED_WORKFORCE_CONFIGURATION_BEFORE_COMPILER_EXPOSURE',protectedGrantCreated:false});
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
  let sources:OwnerSource[] = [
    { id: "crm-original", sourceClass: "crm_deals", rows: [
      { id: "deal-A", kind: "entity", entityType: "deal", registrationId: registrationA, name: "Conflicting Harbor" },
      { id: "deal-B", kind: "entity", entityType: "deal", registrationId: registrationB, name: "Conflicting Harbor" }] },
    { id: "ledger-original", sourceClass: "financial_ledger", rows: [{ id: "balance-A", kind: "quantity", registrationId: registrationA,
      factKey: "facility_balance", value: "20.00", currency: "USD", unit: "units", period: "2026-10", basis: "outstanding", occurredAt, availableAt }] },
    { id: "work-original", sourceClass: "work_tracking", rows: Array.from({length:dutyCount},(_,index)=>({ id: "request-"+index, kind: "trigger", triggerKind: "evidence_request_needed",
      registrationId: registrationA, occurredAt, availableAt, workstreamExternalId, requestedFromExternalId: recipientExternalId,
      requestText:dutyCount===1?requestText:requestText+' item '+index, requiresAcceptedDeliverable: true })) },
  ];
  if(heterogeneous)sources=await heterogeneousOwnerSources({registrationA,registrationB,occurredAt,availableAt,
    workRecords:sources.find(source=>source.id==='work-original')!.rows});
  const canonicalFixture=canonical?await canonicalOwnerSources({ctx,admin,institutionId,workId,
    dealId:String(first.row.id),companyId:companyIds[0]!,organizationKey:'org-'+companyIds[0]!,
    workstreamId:String(stream.row.id),requestedFromDealPartyId:String(party.row.id),occurredAt,availableAt}):null;
  if(canonicalFixture){sources.push(...canonicalFixture.sources);await save('canonical-owner-starting-state.json',canonicalFixture);}
  const grantIds: string[] = [], sourceBindings: unknown[] = [];
  for (const source of sources) {
    const bytes = source.bytes??Buffer.from(JSON.stringify(source.rows)), grantId = randomUUID(),protocol=source.protocol??'json_records';
    const version = await withTenantTransaction(tenant, { userId: actor }, async db => {
      const doc = await createDocument(db, { tenantId: tenant, kind: "source_export", title: source.id,
        provenance: { sourceSystem: "owner-export", externalId: source.id, createdBy: actor } });
      return appendDocumentVersion(db, { tenantId: tenant, documentId: doc.documentId, bytes, mediaType: source.mediaType??"application/octet-stream", format: "unknown",
        origin: "manual_upload", actor, sourceSystem: "owner-export", sourceRef: source.id, providerVersionId: "r1" });
    });
    await admin.query(`INSERT INTO finnor_os.x1_source_grants(id,tenant_id,principal_id,work_id,institution_id,source_id,source_class,
      purpose,acquisition_kind,document_id,document_version_id,protocol,revision,original_sha256,expected_object_ids,valid_from,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'standing evidence responsibility','core_export',$8,$9,$10,'r1',$11,$12::jsonb,
        clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')`,
    [grantId, tenant, actor, workId, institutionId, source.id, source.sourceClass, version.document_id, version.id,protocol,sha(bytes), JSON.stringify(source.rows.map(r => r.id))]);
    await writeFile(join(evidence, "originals", source.id + '.'+(source.extension??'json')), bytes, { mode: 0o600, flag: "wx" });
    grantIds.push(grantId); sourceBindings.push({ sourceId: source.id, sourceClass: source.sourceClass,protocol,
      expectedObjectIds:source.rows.map(r=>r.id),grantId, versionId: version.id, documentId: version.document_id, sha256: sha(bytes) });
  }
  expected = { mappings: [{ sourceId: "crm-original", recordId: "deal-A", canonicalId: String(first.row.id) },
    { sourceId: "crm-original", recordId: "deal-B", canonicalId: String(second.row.id) }],
    request: { tenantId: tenant, dealId: String(first.row.id), workstreamId: String(stream.row.id), requestedFromDealPartyId: String(party.row.id),
      ownerPartyId: actor, requestText, requestedAt: occurredAt, dueAt: deadlineAt, requiresAcceptedDeliverable: true },
    requestTexts:Array.from({length:dutyCount},(_,index)=>dutyCount===1?requestText:requestText+' item '+index),
    expectedRequestCount: dutyCount, expectedCompletionMeaning: "CREATION_ONLY_NOT_FULFILLMENT_OR_APPROVAL" };
  if(material)expected.correction={sourceId:'ledger-original',recordId:'balance-A',value:'25.00',
    currency:'USD',unit:'units',period:'2026-10',basis:'outstanding',canonicalDealId:String(first.row.id),
    affectedDutyCount:0,preservedDutyCount:1,newEffectCount:0,sourcePopulation:3};
  if(heterogeneous){
    expected.mappings=sources.flatMap(source=>source.rows.filter(row=>row.kind==='entity').map(row=>{
      assert.ok(row.registrationId===registrationA||row.registrationId===registrationB,'independent owner identity fixture');
      return {sourceId:source.id,recordId:row.id,canonicalId:row.registrationId===registrationA?String(first.row.id):String(second.row.id)};
    }));
    assert.equal(expected.mappings.length,10);assert.equal(sources.length,12);
    expected.sourceCorpus={sourceClasses:[...new Set(sources.map(s=>s.sourceClass))].sort(),
      protocols:[...new Set(sources.map(s=>s.protocol??'json_records'))].sort(),sourceInstances:12,observationRecords:13,
      quantities:[{sourceId:'ledger-original',recordId:'balance-A',factKey:'facility_balance',value:'20.00'},
        {sourceId:'lender-original',recordId:'lender-A',factKey:'outstanding',value:'20.00'}].map(q=>({...q,
          currency:'USD',unit:'units',period:'2026-10',basis:'outstanding',canonicalDealId:String(first.row.id)}))};
    assert.equal(expected.sourceCorpus.sourceClasses.length,8);assert.equal(expected.sourceCorpus.protocols.length,12);
  }
  if(canonicalFixture){
    expected.mappings=[...expected.mappings.map((mapping:any)=>({...mapping,nativeType:'pe_deal',kind:'deal'})),
      ...canonicalFixture.expected];
    assert.equal(expected.mappings.length,17);
    expected.canonicalKinds=JSON.parse(await readFile(join(repo,'scope-frontier5/x1-institutional-programme-compiler/profile.json'),'utf8')).canonicalTypes;
    assert.deepEqual([...new Set(expected.mappings.map((m:any)=>m.kind))].sort(),[...expected.canonicalKinds].sort());
  }
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
  const accepted = mounted?null:await api("institution-submit", input);
  if(accepted){assert.equal(accepted.status, 202, JSON.stringify(accepted));compilerId=accepted.body.requestId;}
  await save("authenticated-submit.json", { identity, metadata, input, accepted, authDevBypass: false, tokenPersisted: false });
  await writeFile(join(evidence, "empty.env"), "", { mode: 0o600 });
  const env = { HOME: join(evidence, "home"), PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: join(evidence, "tmp"),
    XDG_CACHE_HOME: join(evidence, "cache"), TSX_DISABLE_CACHE: "1", DOTENV_CONFIG_PATH: join(evidence, "empty.env"),
    NODE_ENV: "test", AUTH_DEV_BYPASS: "0", FINNOR_P4_PROFILE: "ordinary_disposable", FINNOR_TEST_MANAGED_EXTENSIONS: "omit",
    DATABASE_URL: connection("finnor_worker", workerPassword), CI: "1", LOG_LEVEL: "silent", NEXT_TELEMETRY_DISABLED: "1",
    ...(recovery?{WORKER_JOB_LEASE_SECONDS:'5'}:{}) };
  if(recovery){publicationBlocker=new pg.Client({connectionString:connection('x1_fixture',password)});
    await publicationBlocker.connect();await publicationBlocker.query('BEGIN');
    await publicationBlocker.query('LOCK TABLE finnor_os.x1_mapping_admissions IN SHARE MODE');}
  let logBytes=0;
  const startWorker=()=>{
    const child=spawn(process.execPath,["--max-old-space-size=1536","--import=tsx","scripts/frontier5/x1/physical-owner-worker.mts"],
      {cwd:join(repo,'finnor-os'),env,stdio:['ignore','pipe','pipe']});
    for(const stream of [child.stdout!,child.stderr!])stream.on('data',b=>{
      logBytes+=b.length;if(logBytes<=limits.smallCheckOutputBytes)void appendFile(join(evidence,'worker.log'),b,{mode:0o600});
      else child.kill('SIGTERM');
    });return child;
  };
  worker=startWorker();
  await save("physical-worker.json", { pid: worker.pid, parentPid: process.pid, environmentNames: Object.keys(env),
    role: "finnor_worker", actualProductionRegistrations: true, credentialsPersisted: false });
  let guardFailure: string | null = null;
  guard = setInterval(() => { void take().catch(error => { guardFailure = String(error.message); worker?.kill("SIGTERM"); }); }, 2000);
  if(recovery){
    const originalRecoveryEnvelope=async()=>({episodes:(await admin!.query(`SELECT id,work_id,original_deadline,wall_deadline,parent_reservation,parent_demand
      FROM finnor_os.x1_compiler_episodes WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3`,[tenant,actor,workId])).rows,
      resources:(await admin!.query('SELECT resource_id,revision FROM finnor_os.s5_resource_heads WHERE tenant_id=$1 ORDER BY resource_id',[tenant])).rows});
    let blocked:any,claimed:any;
    for(let poll=0;poll<240;poll++){
      if(guardFailure)throw Error(guardFailure);
      blocked=(await admin.query(`SELECT pid,wait_event_type,wait_event,pg_blocking_pids(pid) blocking_pids
        FROM pg_stat_activity WHERE usename='finnor_worker' AND wait_event_type='Lock'
          AND (query LIKE '%x1_mapping_admissions%' OR query LIKE '%x1_publish_mapping_admission%')`,[])).rows[0];
      claimed=(await admin.query(`SELECT j.id,j.status,j.claim_token,j.claim_fence,j.lease_expires_at,j.attempts,
        q.status compiler_status,q.episode_id,q.work_input_id,q.grant_ids FROM finnor_os.jobs j
        JOIN finnor_os.x1_compiler_requests q ON q.tenant_id=j.tenant_id AND q.id=(j.payload->>'requestId')::uuid
        WHERE j.tenant_id=$1 AND q.id=$2 AND j.type='run_x1_institution_compiler_v1' AND j.status='running'`,[tenant,compilerId])).rows[0];
      if(blocked&&claimed?.compiler_status==='RUNNING')break;
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    assert.ok(blocked&&claimed,'actual mapping-admission SQL lock and compiler physical claim');
    const before=await originalRecoveryEnvelope(),firstPid=worker.pid;
    const stopped=new Promise<void>(resolve=>worker!.once('close',()=>resolve()));worker.kill('SIGKILL');await stopped;
    assert.equal(worker.signalCode,'SIGKILL');
    await publicationBlocker!.query('ROLLBACK');await publicationBlocker!.end();publicationBlocker=undefined;
    for(const table of ['x1_mapping_admissions','x1_compiler_artifacts','domain_actions','pe_requests'])
      assert.equal((await admin.query(`SELECT count(*)::int n FROM finnor_os.${table} WHERE tenant_id=$1`,[tenant])).rows[0].n,0,
        'independent pre-publication absence '+table);
    await save('recovery-physical-interruption.json',{at:new Date().toISOString(),firstPid,signal:'SIGKILL',blocked,claimed,before,
      ownerInsertionWasBlocked:true,actualProcessDeath:true,originalEpisodeNotRestarted:true});
    worker=startWorker();await save('recovery-physical-worker.json',{pid:worker.pid,firstPid,originalEnvironmentNames:Object.keys(env),
      actualQueueRecovery:true,originalEpisodeNotRestarted:true});
    let quarantined:any;
    for(let poll=0;poll<30;poll++){
      if(guardFailure)throw Error(guardFailure);
      quarantined=(await admin.query(`SELECT j.*,a.outcome delivery_outcome,a.failure_kind delivery_failure_kind
        FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts a ON a.job_id=j.id
        WHERE j.tenant_id=$1 AND j.id=$2 ORDER BY a.started_at DESC LIMIT 1`,[tenant,claimed.id])).rows[0];
      if(quarantined?.status==='quarantined')break;
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    assert.equal(quarantined?.status,'quarantined');assert.equal(quarantined.delivery_outcome,'reconciliation_required');
    const readback=await api('institution-read',{requestId:compilerId});
    await save('recovery-orphaned-readback.json',{quarantined,readback,before,after:await originalRecoveryEnvelope()});
    assert.equal(readback.status,200);assert.equal(readback.body.status,'UNKNOWN','actual orphaned compiler retains UNKNOWN after physical death');
    assert.equal(readback.body.artifact,null);assert.equal(readback.body.programme,null);
    const resumed=await api('institution-resume',{requestId:compilerId});
    assert.equal(resumed.status,202,JSON.stringify(resumed));assert.equal(resumed.body.requestId,compilerId);
    assert.equal(resumed.body.originalParentRetained,true);assert.deepEqual(await originalRecoveryEnvelope(),before);
    await save('recovery-authenticated-same-parent-resume.json',{resumed,before,after:await originalRecoveryEnvelope(),
      exactCompilerId:compilerId,previousPhysicalDeliveryRetained:true});
  }
  if(mounted){
    const thread=await createEmployeeConversationThread({tenantId:tenant,ownerEmployeeId:actor,title:'X1 standing evidence responsibility'});
    const other=await createEmployeeConversationThread({tenantId:tenant,ownerEmployeeId:actor,title:'X1 separate empty Work scope'});
    const root={entityType:'pe_deal',entityId:String(first.row.id)};
    await updateEmployeeConversationThreadContext({tenantId:tenant,ownerEmployeeId:actor,threadId:thread.id,
      activeWorkId:workId,activeReferences:[root]});
    await updateEmployeeConversationThreadContext({tenantId:tenant,ownerEmployeeId:actor,threadId:other.id,activeReferences:[root]});
    const controlKey=randomBytes(32).toString('hex');
    mountedControl=createHttpServer(async(req,res)=>{
      res.setHeader('content-type','application/json');
      if(req.headers.authorization!=='Bearer '+controlKey){res.writeHead(401);res.end('{}');return;}
      try{
        if(req.method==='POST'&&['/delay','/delay-and-revoke'].includes(req.url??'')){
          if(!mountedRevisionVerified){res.writeHead(409);res.end('{"predicate":"WAIT_FOR_CANONICAL_REVISION_COMPLETION"}');return;}
          if(delayedRead)throw Error('ONE_RETAINED_READ_ONLY');
          let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});
          revokeOnHeldRead=req.url==='/delay-and-revoke';
          delayedRead={entered:false,requestId:null,status:null,promise,release};res.end('{}');return;
        }
        if(req.url==='/delay-status'){res.end(JSON.stringify({entered:delayedRead?.entered??false,
          requestId:delayedRead?.requestId??null,status:delayedRead?.status??null}));return;}
        if(req.method==='POST'&&req.url==='/release'){delayedRead?.release();res.end('{}');return;}
        if(req.method==='POST'&&req.url==='/revoke'){
          res.end(JSON.stringify({revoked:await revokeFixturePrincipal()}));return;
        }
        res.writeHead(404);res.end('{}');
      }catch(error){await save('mounted-control-failure.json',{predicate:String((error as Error).message)});
        res.writeHead(500);res.end('{}');}
    });
    await new Promise<void>((resolve,reject)=>{mountedControl!.once('error',reject);mountedControl!.listen(0,'127.0.0.1',resolve);});
    const controlAddress=mountedControl.address();if(!controlAddress||typeof controlAddress==='string')throw Error('LOCAL_CONTROL_PORT_UNAVAILABLE');
    const frontendEnv={HOME:join(evidence,'home'),PATH:env.PATH,TMPDIR:join(evidence,'tmp'),
      NODE_ENV:'development',NODE_OPTIONS:'--max-old-space-size=1536',NEXT_TELEMETRY_DISABLED:'1',
      NEXT_PUBLIC_CENTROPY_TEST_MODE:'0',CENTROPY_TEST_MODE:'0',FINNOR_OS_API_URL:service.origin,
      NEXT_PUBLIC_OS_API_URL:service.origin,NEXT_PUBLIC_SUPABASE_URL:service.authOrigin,
      NEXT_PUBLIC_SUPABASE_ANON_KEY:'disposable-local-auth'};
    frontend=spawn(process.execPath,[join(repo,'node_modules/next/dist/bin/next'),'dev','--turbopack',
      '--hostname','127.0.0.1','--port',String(frontendPort)],{cwd:repo,env:frontendEnv,stdio:['ignore','pipe','pipe']});
    let frontendLogBytes=0;for(const stream of [frontend.stdout!,frontend.stderr!])stream.on('data',b=>{
      frontendLogBytes+=b.length;if(frontendLogBytes<=limits.smallCheckOutputBytes)
        void appendFile(join(evidence,'frontend.log'),b,{mode:0o600});else frontend?.kill('SIGTERM');});
    await save('mounted-private-fixture.json',{frontendOrigin,apiOrigin:service.origin,authOrigin:service.authOrigin,
      email:service.email,password:service.password,workId,threadId:thread.id,
      url:frontendOrigin+'/centropy/investigations/'+thread.id,
      otherUrl:frontendOrigin+'/centropy/investigations/'+other.id,
      controlOrigin:'http://127.0.0.1:'+controlAddress.port,controlKey,
      actor,tenant,frontendPid:frontend.pid,originalEnvelope:'Same frozen owner scenario; no profile/grant reset',
      credentials:'DISPOSABLE_LOCAL_ONLY_FILE_MODE_0600_NEVER_PUBLIC_EVIDENCE'});
    for(let poll=0;poll<240;poll++){
      if(guardFailure)throw Error(guardFailure);
      if(frontend.exitCode!==null||frontend.signalCode!==null)throw Error('MOUNTED_FRONTEND_STOPPED');
      const q=(await admin.query(`SELECT id,idempotency_key,grant_ids FROM finnor_os.x1_compiler_requests
        WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 ORDER BY revision DESC LIMIT 1`,[tenant,actor,workId])).rows[0];
      if(q){compilerId=q.id;input.idempotencyKey=q.idempotency_key;input.grantIds=q.grant_ids;
        await save('mounted-actual-submit.json',{compilerId,input,basis:'ACTUAL_UI_DURABLE_SQL_ACCEPTANCE'});break;}
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    assert.ok(compilerId,'actual mounted compile control must reach durable acceptance');
  }
  let reading: any;
  for (let poll = 0; poll < 240; poll++) {
    if (guardFailure) throw Error(guardFailure);
    if (worker.exitCode !== null || worker.signalCode !== null) throw Error("PHYSICAL_WORKER_STOPPED_BEFORE_OWNER_OBSERVATION");
    const response = await api("institution-read", { requestId: compilerId });
    const projection=response.body.programme?.program;
    await appendFile(join(evidence, "compiler-observations.jsonl"), JSON.stringify({at:new Date().toISOString(),
      response:{status:response.status,body:{requestId:response.body.requestId,status:response.body.status,
        revision:response.body.revision,reason:response.body.reason,
        nativeStatus:response.body.programme?.status,nativeReason:response.body.programme?.reason,
        observedDutyCount:projection?.observedPostconditions?.length??null,
        totalDutyCount:projection?.nodes?.length??null,deliveryCursor:projection?.deliveryCursor??null}},
      completeResponseSha256:sha(JSON.stringify(response.body)),
      completeEndingProjectionDestination:'compiler-ending-projection.json'}) + "\n", {mode:0o600});
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
    await new Promise(resolve => setTimeout(resolve, dutyCount===128?2000:1000));
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
  const actualBaseline=(await admin.query(`SELECT a.id,a.body,a.input_manifest FROM finnor_os.x1_compiler_requests r
    JOIN finnor_os.x1_compiler_artifacts a ON a.tenant_id=r.tenant_id AND a.id=r.artifact_id
    WHERE r.tenant_id=$1 AND r.id=$2`,[tenant,compilerId])).rows[0];
  assert.ok(actualBaseline?.input_manifest.baseline,'actual immutable B_live preimage');
  assert.equal(actualBaseline.input_manifest.baseline.classification,'B_live');
  assert.equal(actualBaseline.input_manifest.baseline.source.git.commit,freeze.source.commit);
  assert.equal(actualBaseline.input_manifest.baseline.source.git.tree,freeze.source.tree);
  assert.equal(actualBaseline.input_manifest.baseline.schemaState.migrations.length,freeze.expectedMigrations);
  assert.equal(actualBaseline.input_manifest.baseline.sourceGrantPins.length,grantIds.length);
  assert.equal(actualBaseline.body.envelope.baseline_manifest_ref.status,'known');
  assert.equal(actualBaseline.body.envelope.baseline_manifest_ref.digest,actualBaseline.input_manifest.baselineDigest);
  assert.equal(actualBaseline.body.envelope.parent_artifact_refs.length,0);
  await save('observed-installed-baseline.json',actualBaseline);
  for(const mapping of expected.mappings){
    const receipt=admission.receipts.find((r:any)=>r.sourceId===mapping.sourceId&&r.recordId===mapping.recordId);
    assert.ok(receipt,"independently expected original mapping must be admitted");
    const nativeType=mapping.nativeType??'pe_deal';
    assert.match(receipt.canonicalRef,new RegExp(`^${nativeType}:${mapping.canonicalId}@(v[1-9][0-9]*|s[a-f0-9]{64})$`));
    const memory=(await admin.query(`SELECT 1 FROM finnor_os.evidence_source_versions v
      JOIN finnor_os.evidence_chunks ch ON ch.tenant_id=v.tenant_id AND ch.source_id=v.source_id AND ch.version_id=v.id
      WHERE v.tenant_id=$1 AND v.id=$2 AND v.source_id=$3 AND ch.entity_refs @> $4::jsonb`,
      [tenant,receipt.evidenceVersionId,receipt.evidenceSourceId,JSON.stringify([{type:nativeType,id:mapping.canonicalId}])])).rows;
    assert.ok(memory.length,'exact actual Memory evidence entity reference');
    if(receipt.evidenceAttachmentKind==='CORE_EVIDENCE_ENTITY_REF'){
      assert.equal(receipt.evidenceLinkId,receipt.evidenceVersionId);continue;
    }
    const link:{entity_type:string;entity_id:string;evidence_source_id:string;evidence_version_id:string}|undefined=(await admin.query(`SELECT entity_type,entity_id,evidence_source_id,evidence_version_id FROM finnor_os.pe_evidence_links
      WHERE tenant_id=$1 AND id=$2 AND archived_at IS NULL`,[tenant,receipt.evidenceLinkId])).rows[0];
    assert.equal(link?.entity_type,nativeType);assert.equal(link?.entity_id,mapping.canonicalId);
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
  let completion:any;
  for(let poll=0;poll<60;poll++){
    if(guardFailure)throw Error(guardFailure);
    completion=(await admin.query(`SELECT w.status work_status,l.id objective_id,l.state objective_state,
      l.success_verification,p.id plan_id,p.status plan_status,p.completion_proof
      FROM finnor_os.works w JOIN finnor_os.work_objective_loops l ON l.tenant_id=w.tenant_id AND l.work_id=w.id
      JOIN finnor_os.work_plan_revisions p ON p.tenant_id=l.tenant_id AND p.objective_loop_id=l.id
      WHERE w.tenant_id=$1 AND w.id=$2 ORDER BY p.revision DESC LIMIT 1`,[tenant,workId])).rows[0];
    await appendFile(join(evidence,'native-work-completion-observations.jsonl'),JSON.stringify({
      at:new Date().toISOString(),completion})+'\n',{mode:0o600});
    if(completion?.work_status==='completed'&&completion.objective_state==='completed'
      &&completion.plan_status==='completed')break;
    if(['failed','blocked','cancelled'].includes(completion?.objective_state))break;
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  await save('native-work-completion.json',completion);
  assert.equal(completion?.work_status,'completed','actual native Work completion');
  assert.equal(completion.objective_state,'completed','same native Objective completes');
  assert.equal(completion.success_verification?.state,'verified','actual native success-condition verification');
  assert.equal(completion.plan_status,'completed');assert.equal(completion.completion_proof?.verified,true);
  results.push({ id: "A-authenticated-owner-creation", status: "PASS", observed: { compilerId, admission, rows, effects:allEffects,plans,linked,repeated, beforeReplay, afterReplay },
    basis: "ACTUAL_LOCAL_AUTH_HTTP_SQL_PHYSICAL_WORKER_NATIVE_CREATE_AND_INDEPENDENT_SQL_OBSERVER" });
  if(heterogeneous){
    const actual=(await admin.query(`SELECT a.candidate,a.check_result,a.body,a.body_digest
      FROM finnor_os.x1_compiler_requests r JOIN finnor_os.x1_compiler_artifacts a ON a.tenant_id=r.tenant_id AND a.id=r.artifact_id
      WHERE r.tenant_id=$1 AND r.id=$2`,[tenant,compilerId])).rows[0];
    assert.ok(actual);assert.equal(actual.check_result.disposition,'ACCEPTED_DEVELOPMENT');
    assert.equal(actual.candidate.coverage.length,expected.sourceCorpus.sourceInstances);
    assert.equal(actual.candidate.mappings.length,expected.mappings.length);assert.equal(actual.candidate.quantities.length,2);
    for(const oracle of expected.sourceCorpus.quantities){
      const found=actual.candidate.quantities.filter((q:any)=>q.sourceId===oracle.sourceId&&q.recordId===oracle.recordId);
      assert.equal(found.length,1);for(const field of ['factKey','value','currency','unit','period','basis'])assert.equal(found[0][field],oracle[field]);
      assert.match(found[0].canonicalRef,new RegExp(`^pe_deal:${oracle.canonicalDealId}@v[1-9][0-9]*$`));
    }
    assert.equal(actual.candidate.obligations.length,1);assert.equal(actual.candidate.unresolved.length,0);
    assert.equal(Object.keys(actual.body).length,14);assert.equal(Object.keys(actual.body.envelope).length,34);
    assert.equal(actual.body.envelope.source_refs.length,expected.sourceCorpus.sourceInstances);
    assert.deepEqual(Object.keys(actual.body.envelope.source_revision_vector).sort(),sources.map(s=>s.id).sort());
    assert.equal(actual.body.inferred_source_mapping_refs.length,expected.mappings.length);
    await save('heterogeneous-original-corpus-independent-proof.json',{expectations:expected.sourceCorpus,
      expectedMappings:expected.mappings,sourceBindings,actual,completion,
      nativeRequestCount:rows.length,independentOracleNotCandidateDerived:true,
      claimDomain:'EIGHT_CLASSES_TWELVE_DIRECT_BYTE_PROTOCOLS_AND_NATIVE_REQUEST_COMPLETION_ONLY',
      allCanonicalKindsEstablished:false,protectedQualification:false});
    results.push({id:'A-eight-class-original-corpus',status:'PASS',observed:{classes:expected.sourceCorpus.sourceClasses,
      protocols:expected.sourceCorpus.protocols,mappingCount:10,quantityCount:2,dutyCount:1,
      fullFieldStructure:{program:14,envelope:34},completion},basis:'ACTUAL_AUTHENTICATED_CORE_ORIGINALS_SEPARATE_CHECK_S1_NATIVE_WORK_AND_INDEPENDENT_SQL'});
  }
  if(canonicalFixture){
    assert.equal(admission.receipts.length,17);
    const currentConsent=(await admin.query(`SELECT b.registration_id,b.subject_user_id,c.revision,c.expires_at
      FROM finnor_os.x1_subject_identity_bindings b JOIN finnor_os.x1_subject_consents c
        ON c.tenant_id=b.tenant_id AND c.subject_user_id=b.subject_user_id AND c.institution_id=b.institution_id
      WHERE b.tenant_id=$1 AND b.source_id='person-owner-original' AND c.source_class='personnel_benefits'
        AND b.revoked_at IS NULL AND c.revoked_at IS NULL`,[tenant])).rows;
    assert.equal(currentConsent.length,1);assert.equal(currentConsent[0].subject_user_id,actor);
    assert.equal((await admin.query('SELECT count(*)::int n FROM finnor_os.pe_requests WHERE tenant_id=$1',[tenant])).rows[0].n,2);
    await save('fourteen-canonical-kind-independent-proof.json',{expectedKinds:expected.canonicalKinds,
      expectedMappings:expected.mappings,actualAdmission:admission,currentConsent,completion,
      actualPreexistingRequestId:canonicalFixture.existingRequestId,additionalNativeEffects:1,
      allExpectedEvidenceReferencesChecked:true,protectedQualification:false});
    results.push({id:'A-fourteen-canonical-kinds',status:'PASS',observed:{kinds:expected.canonicalKinds,
      mappings:17,additionalEffects:1,currentConsent,completion},basis:'ACTUAL_PREEXPOSURE_CANONICAL_OWNERS_SENSITIVE_CONSENT_S1_ADMISSIONS_AND_NATIVE_COMPLETION'});
  }
  if(mounted)await save('mounted-canonical-completion.json',{compilerId,workId,completion,
    browserEvidenceRequired:true,mountedPassEstablished:false});
  if(recovery){
    const history=(await admin.query(`SELECT e.id,e.attempts,e.acquisition_calls,r.id request_id,r.episode_id,r.grant_ids,r.work_input_id
      FROM finnor_os.x1_compiler_episodes e JOIN finnor_os.x1_compiler_requests r ON r.tenant_id=e.tenant_id AND r.episode_id=e.id
      WHERE r.tenant_id=$1 AND r.id=$2`,[tenant,compilerId])).rows[0];
    assert.equal(history.attempts,2);assert.equal(history.request_id,compilerId);
    await save('recovery-independent-native-completion.json',{history,completion,rows,effects:allEffects,
      noDuplicateRequestOrAction:true,exactOneOriginalEpisode:true,effectLostAckEstablished:false});
    results.push({id:'D-compiler-before-publication-death',status:'PASS',observed:{history,completion},
      basis:'ACTUAL_WORKER_SIGKILL_SQL_LOCK_QUEUE_QUARANTINE_AUTHENTICATED_SAME_PARENT_RESUME_AND_INDEPENDENT_NATIVE_COMPLETION'});
  }
  if(contention){
    const firstProofDigest=sha(JSON.stringify(completion.completion_proof));
    const other=await receiveWork({tenantId:tenant,userId:actor,channel:'console',idempotencyKey:'x1-contending-work:'+randomUUID(),
      instruction:'Maintain the same admitted evidence responsibility within the existing shared resource pool',
      activeContext:{entityType:'pe_deal',entityId:String(first.row.id)},authorityContext:{principalId:actor,scope:'DISPOSABLE_INTERNAL_REQUEST_CREATION_ONLY'}});
    await attachWorkEntity(tenant,other.workId,{entityType:'pe_deal',entityId:String(first.row.id),source:'X1:ordinary-contention-fixture'});
    await admin.query(`INSERT INTO finnor_os.x1_work_mandates(tenant_id,principal_id,work_id,institution_id,revision,rules,valid_from,expires_at)
      SELECT tenant_id,principal_id,$4,institution_id,revision,rules,valid_from,expires_at FROM finnor_os.x1_work_mandates
      WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3`,[tenant,actor,workId,other.workId]);
    const otherGrants=(await admin.query(`INSERT INTO finnor_os.x1_source_grants
      (tenant_id,principal_id,work_id,institution_id,source_id,source_class,purpose,acquisition_kind,
        document_id,document_version_id,protocol,revision,original_sha256,expected_object_ids,version,valid_from,expires_at)
      SELECT tenant_id,principal_id,$4,institution_id,source_id,source_class,purpose,acquisition_kind,
        document_id,document_version_id,protocol,revision,original_sha256,expected_object_ids,version,valid_from,expires_at
      FROM finnor_os.x1_source_grants WHERE tenant_id=$1 AND principal_id=$2 AND id=ANY($3::uuid[]) RETURNING id::text`,
      [tenant,actor,grantIds,other.workId])).rows.map(row=>row.id);
    assert.equal(otherGrants.length,grantIds.length);
    const sources=await api('institution-sources',{workId:other.workId});assert.equal(sources.status,200);
    const submitted=await api('institution-submit',{workId:other.workId,workInputId:sources.body.workInputId,
      grantIds:otherGrants,idempotencyKey:'x1-contending-compiler:'+randomUUID()});assert.equal(submitted.status,202);
    let refused:any,job:any;
    for(let poll=0;poll<90;poll++){
      if(guardFailure)throw Error(guardFailure);
      refused=await api('institution-read',{requestId:submitted.body.requestId});
      job=(await admin.query(`SELECT type,status,last_error FROM finnor_os.jobs WHERE tenant_id=$1
        AND payload->>'requestId'=$2 AND type='run_x1_institution_compiler_v1' ORDER BY created_at DESC LIMIT 1`,
        [tenant,submitted.body.requestId])).rows[0];
      if(['UNKNOWN','FAILED','INVALIDATED','PARTIAL','CHECK_REJECTED'].includes(refused.body.status))break;
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    await save('shared-parent-capacity-refusal.json',{submitted,refused,job,firstOriginalEnvelope:beforeReplay,
      secondWorkId:other.workId,sameExistingResourcePool:true,capacityRefilled:false});
    assert.equal(refused.status,200);assert.equal(refused.body.status,'UNKNOWN');
    assert.ok(String(job?.last_error).includes('S5 shared resource capacity exhausted'),'intended actual S5 shared-capacity boundary');
    assert.equal((await admin.query('SELECT count(*)::int n FROM finnor_os.s5_reservations WHERE tenant_id=$1',[tenant])).rows[0].n,1);
    const secondOwner=(await admin.query('SELECT program_id FROM finnor_os.x1_compiler_requests WHERE tenant_id=$1 AND id=$2',
      [tenant,submitted.body.requestId])).rows[0];assert.equal(secondOwner.program_id,null);
    const cancelled=await api('institution-cancel',{requestId:submitted.body.requestId});assert.equal(cancelled.status,200);
    assert.equal(cancelled.body.status,'CANCELLED');assert.equal(cancelled.body.exposureRetained,false);
    assert.deepEqual(await originalEnvelope(),beforeReplay,'first original S5 reservation/resources unaffected by refused cancellation');
    assert.equal((await admin.query('SELECT count(*)::int n FROM finnor_os.domain_actions WHERE tenant_id=$1',[tenant])).rows[0].n,1);
    assert.equal((await admin.query('SELECT count(*)::int n FROM finnor_os.pe_requests WHERE tenant_id=$1',[tenant])).rows[0].n,1);
    const retained=(await admin.query('SELECT status,completion_proof FROM finnor_os.work_plan_revisions WHERE tenant_id=$1 AND id=$2',
      [tenant,completion.plan_id])).rows[0];assert.equal(retained.status,'completed');assert.equal(sha(JSON.stringify(retained.completion_proof)),firstProofDigest);
    await save('shared-parent-contention-independent-proof.json',{submitted,refused,job,cancelled,
      before:beforeReplay,after:await originalEnvelope(),firstCompletionProofDigest:firstProofDigest,
      additionalReservations:0,additionalEffects:0,fullConcurrencySuiteEstablished:false});
    results.push({id:'E-original-shared-parent-contention',status:'PASS',observed:{submitted,refused,cancelled,originalEnvelope:beforeReplay},
      basis:'ACTUAL_SECOND_AUTHENTICATED_WORK_PHYSICAL_COMPILER_S5_CAPACITY_REFUSAL_AND_CANCELLATION_FIRST_OWNER_UNCHANGED'});
  }
  if(revise||mounted||material){
    const initialObjective=(await admin.query('SELECT * FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND work_id=$2',
      [tenant,workId])).rows[0];
    const initialProof=sha(JSON.stringify(completion.completion_proof)),initialPlanId=completion.plan_id;
    let revised:any;
    if(revise)revised=await api('institution-revise',{...input,parentRequestId:compilerId,idempotencyKey:'x1-revision:'+randomUUID()});
    if(material){
      const ledger=(await admin.query<{id:string;document_id:string}>(`SELECT id::text,document_id::text
        FROM finnor_os.x1_source_grants WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3
          AND source_id='ledger-original' AND version=1`,[tenant,actor,workId])).rows[0]!;
      assert.ok(ledger,'original authorized ledger grant');
      const corrected=Buffer.from(JSON.stringify(sources.find(source=>source.id==='ledger-original')!.rows
        .map(record=>({...record,value:expected.correction.value}))));
      await writeFile(join(evidence,'originals/ledger-corrected.json'),corrected,{mode:0o600,flag:'wx'});
      const version=await withTenantTransaction(tenant,{userId:actor},async db=>appendDocumentVersion(db,{
        tenantId:tenant,documentId:ledger.document_id,bytes:corrected,mediaType:'application/json',format:'unknown',
        origin:'manual_upload',actor,sourceSystem:'owner-export',sourceRef:'ledger-original',providerVersionId:'r2'}));
      const replacement=(await admin.query(`INSERT INTO finnor_os.x1_source_grants
        (tenant_id,principal_id,work_id,institution_id,source_id,source_class,purpose,acquisition_kind,
          document_id,document_version_id,protocol,revision,original_sha256,expected_object_ids,version,valid_from,expires_at)
        SELECT tenant_id,principal_id,work_id,institution_id,source_id,source_class,purpose,acquisition_kind,
          document_id,$4,protocol,'r2',$5,expected_object_ids,version+1,valid_from,expires_at
        FROM finnor_os.x1_source_grants WHERE tenant_id=$1 AND principal_id=$2 AND id=$3
        RETURNING id::text,source_id,version,revision,valid_from,expires_at`,
        [tenant,actor,ledger.id,version.id,sha(corrected)])).rows[0];
      assert.ok(replacement);assert.equal(replacement.version,2);
      const withdrawn=await api('institution-read',{requestId:compilerId});
      assert.equal(withdrawn.status,200);assert.equal(withdrawn.body.status,'INVALIDATED');
      assert.equal(withdrawn.body.artifact,null);assert.equal(withdrawn.body.programme,null);
      await save('material-owner-correction.json',{at:new Date().toISOString(),originalGrantId:ledger.id,
        replacement,coreVersionId:version.id,originalBytesRetained:true,independentExpectation:expected.correction,
        withdrawn,automaticWorkerRequired:true,observerCalledRevise:false});
    }
    if(!revise)for(let poll=0;poll<90;poll++){
      if(guardFailure)throw Error(guardFailure);
      const q=(await admin.query(`SELECT id,revision,parent_request_id FROM finnor_os.x1_compiler_requests
        WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND revision=2`,[tenant,actor,workId])).rows[0];
      if(q){assert.equal(q.parent_request_id,compilerId);revised={status:202,body:{requestId:q.id,revision:q.revision},
        basis:material?'ACTUAL_OWNER_CHANGE_P7_AUTOMATIC_SQL_ACCEPTANCE':'ACTUAL_MOUNTED_REVISION_DURABLE_SQL_ACCEPTANCE'};break;}
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    assert.ok(revised,material?'actual P7 owner-change revision must reach the owner':'actual mounted revision must reach the owner');
    assert.equal(revised.status,202,JSON.stringify(revised));assert.equal(revised.body.revision,2);
    let current:any;
    for(let poll=0;poll<90;poll++){
      if(guardFailure)throw Error(guardFailure);
      const read=await api('institution-read',{requestId:revised.body.requestId});
      current=(await admin.query(`SELECT w.status work_status,l.id objective_id,l.state objective_state,
        l.success_verification,p.id plan_id,p.status plan_status,p.completion_proof
        FROM finnor_os.works w JOIN finnor_os.work_objective_loops l ON l.tenant_id=w.tenant_id AND l.work_id=w.id
        JOIN finnor_os.work_plan_revisions p ON p.tenant_id=l.tenant_id AND p.objective_loop_id=l.id
        WHERE w.tenant_id=$1 AND w.id=$2 ORDER BY p.revision DESC LIMIT 1`,[tenant,workId])).rows[0];
      await appendFile(join(evidence,'revision-observations.jsonl'),JSON.stringify({at:new Date().toISOString(),
        requestId:revised.body.requestId,status:read.body.status,reason:read.body.reason,
        nativeStatus:read.body.programme?.status,completion:current})+'\n',{mode:0o600});
      if(read.body.status==='OBSERVED'&&current?.work_status==='completed'&&current.plan_id!==initialPlanId
        &&current.plan_status==='completed')break;
      if(['FAILED','UNKNOWN','INVALIDATED','CANCELLED','PARTIAL'].includes(read.body.status))
        throw Error('ACTUAL_NATIVE_REVISION_REFUSAL:'+read.body.status+':'+read.body.reason);
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    assert.equal(current?.work_status,'completed');assert.equal(current.objective_state,'completed');
    assert.notEqual(current.plan_id,initialPlanId);assert.equal(current.completion_proof?.verified,true);
    assert.equal(current.success_verification?.state,'verified');assert.equal(current.objective_id,initialObjective.id);
    const finalObjective=(await admin.query('SELECT * FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND work_id=$2',
      [tenant,workId])).rows[0];
    for(const field of ['max_steps','max_actions','max_queries','max_waits','max_node_attempts','deadline_at'])
      assert.deepEqual(finalObjective[field],initialObjective[field],'original Objective '+field);
    for(const field of ['step_count','query_count','action_count','node_attempt_count'])
      assert.ok(finalObjective[field]>=initialObjective[field],'monotone original Objective '+field);
    assert.equal(sha(JSON.stringify((await admin.query('SELECT completion_proof FROM finnor_os.work_plan_revisions WHERE tenant_id=$1 AND id=$2',
      [tenant,initialPlanId])).rows[0].completion_proof)),initialProof);
    assert.deepEqual(await originalEnvelope(),beforeReplay,'same original episode/reservation/resources across revision');
    assert.equal((await admin.query('SELECT count(*)::int n FROM finnor_os.pe_requests WHERE tenant_id=$1 AND request_text=ANY($2::text[])',
      [tenant,expected.requestTexts])).rows[0].n,dutyCount);
    assert.equal((await admin.query('SELECT count(*)::int n FROM finnor_os.domain_actions WHERE tenant_id=$1 AND work_id=$2',
      [tenant,workId])).rows[0].n,dutyCount);
    results.push({id:material?'B-material-ledger-native-revision':'B-same-standing-input-native-revision',status:'PASS',observed:{revised,current,
      initialObjective,finalObjective,priorCompletionProofDigest:initialProof},
      basis:'ACTUAL_AUTHENTICATED_OWNER_REVISION_SAME_OBJECTIVE_ORIGINAL_PARENT_NO_DUPLICATE_EFFECT'});
    if(material){
      const artifacts=(await admin.query(`SELECT r.id request_id,r.revision,a.id artifact_id,a.body,a.body_digest,a.input_manifest,
        a.candidate,a.check_result,a.dependency_graph
        FROM finnor_os.x1_compiler_requests r JOIN finnor_os.x1_compiler_artifacts a
          ON a.tenant_id=r.tenant_id AND a.id=r.artifact_id
        WHERE r.tenant_id=$1 AND r.principal_id=$2 AND r.work_id=$3 ORDER BY r.revision`,[tenant,actor,workId])).rows;
      assert.equal(artifacts.length,2);const prior=artifacts[0],next=artifacts[1],oracle=expected.correction;
      assert.equal(next.body.envelope.parent_artifact_refs.length,1);
      assert.equal(next.body.envelope.parent_artifact_refs[0].ref,prior.artifact_id);
      assert.equal(next.body.envelope.parent_artifact_refs[0].digest,prior.body_digest);
      assert.equal(next.input_manifest.baseline.source.git.commit,freeze.source.commit);
      assert.equal(next.input_manifest.baseline.schemaState.migrations.length,freeze.expectedMigrations);
      assert.equal(next.body.envelope.baseline_manifest_ref.digest,next.input_manifest.baselineDigest);
      assert.equal(next.candidate.coverage.length,oracle.sourcePopulation);
      const quantity=next.candidate.quantities.filter((q:any)=>q.sourceId===oracle.sourceId&&q.recordId===oracle.recordId);
      assert.equal(quantity.length,1);for(const field of ['value','currency','unit','period','basis'])
        assert.equal(quantity[0][field],oracle[field],'independent corrected '+field);
      assert.match(quantity[0].canonicalRef,new RegExp(`^pe_deal:${oracle.canonicalDealId}@v[1-9][0-9]*$`));
      assert.equal(prior.candidate.quantities.find((q:any)=>q.sourceId===oracle.sourceId&&q.recordId===oracle.recordId).value,'20.00');
      assert.equal(next.check_result.disposition,'ACCEPTED_DEVELOPMENT');
      const update=(await admin.query(`SELECT body FROM finnor_os.x1_compiler_events
        WHERE tenant_id=$1 AND request_id=$2 AND kind='P7_EXACT_AFFECTED_UPDATE'`,[tenant,revised.body.requestId])).rows;
      assert.equal(update.length,1);const closure=update[0].body;
      assert.equal(closure.change,'SEMANTIC');assert.deepEqual(closure.changedDependencyIds,[JSON.stringify(['source-semantics','ledger-original'])]);
      assert.equal(closure.affectedPriorDutyIds.length,oracle.affectedDutyCount);
      assert.equal(closure.affectedCurrentDutyIds.length,oracle.affectedDutyCount);
      assert.equal(closure.preservedCurrentDutyIds.length,oracle.preservedDutyCount);
      assert.equal(closure.newDutyIds.length,0);assert.equal(closure.removedDutyIds.length,0);
      assert.equal(closure.priorEffectsAndCostsRetained,true);assert.equal(closure.authorityGranted,false);
      const updates=(await admin.query(`SELECT * FROM finnor_os.x1_compiler_updates
        WHERE tenant_id=$1 AND trigger_request_id=$2 ORDER BY created_at,id`,[tenant,compilerId])).rows;
      assert.ok(updates.some(u=>u.owner_table==='x1_source_grants'&&u.state==='SUBMITTED'
        &&u.next_request_id===revised.body.requestId),'registered P7 owner-change handoff');
      await save('material-correction-independent-proof.json',{revised,current,artifacts,closure,updates,
        independentExpectation:oracle,originalEnvelope:await originalEnvelope(),priorCompletionProofDigest:initialProof,
        noDuplicateRequestOrAction:true,observerCalledRevise:false,fullBFixtureEstablished:false});
      results.push({id:'B-ledger-correction-minimal-closure',status:'PASS',observed:{closure,
        correctedQuantity:quantity[0],sourcePopulation:next.candidate.coverage.length,priorEffectsRetained:true},
        basis:'ACTUAL_CORE_OWNER_SOURCE_GRANT_TRIGGER_P7_COMPILER_CHECK_NATIVE_COMPLETION_AND_INDEPENDENT_SQL'});
    }
    if(mounted){mountedRevisionVerified=true;await save('mounted-revision-canonical-completion.json',{revised,current,
      initialObjective,finalObjective,priorCompletionProofDigest:initialProof,
      noDuplicateRequestsOrActions:true,originalEnvelope:await originalEnvelope(),fullEngineering:false});}
  }
  if(mounted){
    for(;;){if(guardFailure)throw Error(guardFailure);
      const heldRead=readDelayedRead();
      if(heldRead?.entered&&!heldReadReleased){
        try{const rendered=JSON.parse(await readFile(join(evidence,'mounted-denial-rendered.json'),'utf8'));
          if(rendered.sourceCommit!==freeze.source.commit||rendered.workId!==workId||rendered.workspaceClosed!==true)
            throw Error('MOUNTED_DENIAL_OBSERVER_SCOPE_MISMATCH');
          releaseDelayedRead();heldReadReleased=true;
          await save('mounted-late-response-released.json',{at:new Date().toISOString(),
            afterActualBrowserDenial:true,requestId:heldRead.requestId,status:heldRead.status});
        }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      }
      try{const closed=JSON.parse(await readFile(join(evidence,'mounted-observer-close.json'),'utf8'));
        if(closed.sourceCommit!==freeze.source.commit||closed.workId!==workId)throw Error('MOUNTED_OBSERVER_SCOPE_MISMATCH');
        await save('mounted-observer-receipt.json',closed);
        assert.equal(closed.status,'PASS','actual mounted observer verdict');
        assert.ok(Array.isArray(closed.checks)&&closed.checks.length>=4
          &&closed.checks.every((check:any)=>check.status==='PASS'),'all registered mounted predicates');
        results.push({id:'G-mounted-owner-observer',status:'PASS',observed:closed,
          basis:'ACTUAL_BROWSER_WITH_SEPARATE_CANONICAL_OWNER_PROOF'});break;
      }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
  }
} catch (error) {
  results.push({ id: "actual-owner-boundary", status: "FAIL", observed: { message: String((error as Error).message),
    stack: (error as Error).stack, cause: (error as any).cause?.message ?? null,
    sql: { code: (error as any).code ?? null, where: (error as any).where ?? null,
      internalQuery: (error as any).internalQuery ?? null, position: (error as any).position ?? null } } });
} finally {
  if (guard) clearInterval(guard);
  if(publicationBlocker){await publicationBlocker.query('ROLLBACK').catch(()=>{});await publicationBlocker.end().catch(()=>{});}
  releaseDelayedRead();
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
      ["action-log", "SELECT domain_action_id,step,input,output,timestamp FROM finnor_os.action_log WHERE tenant_id=$1 ORDER BY timestamp,id"],
      ["requests", "SELECT * FROM finnor_os.pe_requests WHERE tenant_id=$1 ORDER BY id"],
      ["native-events", "SELECT kind,body,created_at FROM finnor_os.p1_events WHERE tenant_id=$1 ORDER BY created_at,id"],
      ["plans", "SELECT id,revision,status,parent_revision_id,plan_graph,revision_transition FROM finnor_os.work_plan_revisions WHERE tenant_id=$1 ORDER BY revision"],
      ["work", "SELECT * FROM finnor_os.works WHERE tenant_id=$1"],
      ["objectives", "SELECT * FROM finnor_os.work_objective_loops WHERE tenant_id=$1"],
      ["objective-steps", "SELECT * FROM finnor_os.work_objective_steps WHERE tenant_id=$1 ORDER BY step_number"],
      ["recovery-decisions", "SELECT * FROM finnor_os.work_recovery_decisions WHERE tenant_id=$1 ORDER BY created_at,id"],
      ["work-events", "SELECT * FROM finnor_os.work_events WHERE tenant_id=$1 ORDER BY work_id,seq"],
      ["agent-profiles", "SELECT * FROM finnor_os.agent_profiles WHERE tenant_id=$1 ORDER BY id"],
      ["agent-profile-revisions", "SELECT * FROM finnor_os.agent_profile_revisions WHERE tenant_id=$1 ORDER BY agent_profile_id,revision"],
      ["workforce-assignments", "SELECT * FROM finnor_os.workforce_assignments WHERE tenant_id=$1 ORDER BY created_at,id"],
      ["query-executions", "SELECT * FROM finnor_os.work_query_executions WHERE tenant_id=$1 ORDER BY created_at,id"],
    ]) { try { await save(name! + ".json", (await admin.query(sql!, [tenant])).rows); } catch (error) { await save(name! + "-read-gap.json", { predicate: String((error as Error).message) }); } }
  }
  if (worker && worker.exitCode === null && worker.signalCode === null) {
    const stopped = new Promise<void>(resolve => worker!.once("close", () => resolve())); worker.kill("SIGTERM");
    const timer = setTimeout(() => worker?.kill("SIGKILL"), 15000); await stopped; clearTimeout(timer);
  }
  if(frontend&&frontend.exitCode===null&&frontend.signalCode===null){
    const stopped=new Promise<void>(resolve=>frontend!.once('close',()=>resolve()));frontend.kill('SIGTERM');
    const timer=setTimeout(()=>frontend?.kill('SIGKILL'),15000);await stopped;clearTimeout(timer);
  }
  await save("traffic.json", traffic);
  if(mountedControl){mountedControl.closeAllConnections();await new Promise<void>(resolve=>mountedControl!.close(()=>resolve()));}
  await service?.close(); await closePool(); await admin?.end(); await database?.stop().catch(() => {});
  await rm(join(evidence, "tmp/database"), { recursive: true, force: true });
  const currentPins = await Promise.all(sourcePaths.map(async path => ({ path, sha256: sha(await readFile(join(repo, path))) })));
  const sourceUnchanged = JSON.stringify(sourcePins) === JSON.stringify(currentPins) && freeze.source.commit === git("rev-parse", "HEAD")
    &&freeze.source.dirtyDiffDigest===sha(git('diff','--binary'));
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
