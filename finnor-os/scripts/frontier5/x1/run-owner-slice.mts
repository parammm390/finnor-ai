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
import { prepareExistingOwnerUpgrade,observePreservedUpgradeOwners } from './upgrade-owner-fixture.mts';

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const evidence = process.env.FINNOR_X1_OWNER_EVIDENCE;
if (!evidence || !evidence.startsWith("/")) throw Error("FRESH_PRIVATE_X1_OWNER_EVIDENCE_REQUIRED");
const dutyCount=process.env.FINNOR_X1_OWNER_CASE==='128'?128:1;
const reportingChanges=process.env.FINNOR_X1_OWNER_MODE==='reporting_changes';
const ownerInputs=process.env.FINNOR_X1_OWNER_MODE==='owner_inputs';
const fullDomain=process.env.FINNOR_X1_OWNER_MODE==='domain'||reportingChanges||ownerInputs;
const mounted=process.env.FINNOR_X1_OWNER_MODE==='mounted';
const revise=process.env.FINNOR_X1_OWNER_MODE==='revision';
const material=process.env.FINNOR_X1_OWNER_MODE==='material';
const heterogeneous=process.env.FINNOR_X1_OWNER_MODE==='heterogeneous'||fullDomain;
const canonical=process.env.FINNOR_X1_OWNER_MODE==='canonical'||fullDomain;
const recovery=process.env.FINNOR_X1_OWNER_MODE==='recovery';
const effectRecovery=process.env.FINNOR_X1_OWNER_MODE==='effect_recovery';
const ordinary=process.env.FINNOR_X1_OWNER_MODE==='ordinary'||fullDomain;
const upgrade=process.env.FINNOR_X1_OWNER_MODE==='upgrade';
const checkerCrash=process.env.FINNOR_X1_OWNER_MODE==='checker_crash';
const contention=process.env.FINNOR_X1_OWNER_MODE==='contention';
const unsupported=process.env.FINNOR_X1_OWNER_MODE==='unsupported';
const cancelObserved=process.env.FINNOR_X1_OWNER_MODE==='cancel_observed';
if(process.env.FINNOR_X1_OWNER_MODE&&!['api','mounted','revision','material','heterogeneous','canonical','recovery','effect_recovery','ordinary','domain','owner_inputs','reporting_changes','upgrade','checker_crash','contention','unsupported','cancel_observed'].includes(process.env.FINNOR_X1_OWNER_MODE))
  throw Error('EXACT_REGISTERED_OWNER_MODE_REQUIRED');
if((mounted||material||heterogeneous||canonical||recovery||effectRecovery||ordinary||upgrade||checkerCrash||contention||unsupported||cancelObserved)&&dutyCount!==1)throw Error('NAMED_ONE_DUTY_SCENARIO_REQUIRED');
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
  'finnor-os/scripts/frontier5/x1/upgrade-owner-fixture.mts',
  "finnor-os/scripts/frontier5/x1/physical-owner-worker.mts", "finnor-os/packages/db/migrations-bundle.ts",
  "finnor-os/package-lock.json", "scope-frontier5/x1-institutional-programme-compiler/profile.json"];
const sourcePins = await Promise.all(sourcePaths.map(async path => ({ path, sha256: sha(await readFile(join(repo, path))) })));
const freeze = { source: { commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"),
  dirty: git("status", "--porcelain=v1", "-uall"),dirtyDiffDigest:sha(git('diff','--binary')), pins: sourcePins }, startedAt,
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  profile: "DISPOSABLE_LOCAL_AUTH_SERVICE_ACTUAL_BEARER_AND_RLS", hostedSupabaseQualified: false,
  authDevBypass: false, expectedMigrations: 183, limits, freeBytesBefore: String(diskBefore), dutyCount,mounted,
  cases: ["A-raw-two-identity-native-request", "C-unsigned-forged-input", "D-same-key-replay", "G-restricted-roles",
    ...(material?['B-ledger-correction']:[]),...(heterogeneous?['A-eight-class-original-corpus']:[]),
    ...(canonical?['A-fourteen-canonical-kinds']:[]),...(recovery?['D-compiler-before-publication-death']:[]),
    ...(effectRecovery?['D-effect-submit-lost-ack']:[]),
    ...(ordinary?['A-all-ordinary-operations']:[]),
    ...(upgrade?['G-existing-schema-upgrade-and-jobs']:[]),
    ...(fullDomain?['A-full-declared-source-and-owner-domain']:[]),
    ...(reportingChanges?['B-report-meaning-exception-and-cosmetic-change']:[]),
    ...(checkerCrash?['F-physical-checker-crash-and-compatible-resume']:[]),
    ...(contention?['E-original-shared-parent-contention']:[]),...(unsupported?['F-mixed-unsupported-rule']:[]),
    ...(cancelObserved?['E-cancel-observed-standing-continuation']:[])],
  omitted: "Full B–H, physical interruption, mounted browser, clean built installation/upgrade and protected qualification remain distinct required evidence" };
await writeFile(join(evidence, "freeze.json"), JSON.stringify(freeze, null, 2) + "\n", { mode: 0o600, flag: "wx" });
const results: any[] = [], traffic: unknown[] = [];
let database: EmbeddedPostgres | undefined, admin: pg.Client | undefined;
let publicationBlocker:pg.Client|undefined;
let acknowledgementBlocker:pg.Client|undefined,effectRecoveryProof:any;
let checkerCrashProof:any;
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
  const legacyUpgrade=upgrade?await prepareExistingOwnerUpgrade({repo,databaseUrl:connection('x1_fixture',password),
    applicationUrl:connection('finnor_app',appPassword),appPassword,workerUrl:connection('finnor_worker',workerPassword),
    workerPassword,commit:freeze.source.commit,
    expectedMigrationCount:freeze.expectedMigrations}):null;
  if(legacyUpgrade)await save('existing-schema-upgrade-starting-proof.json',legacyUpgrade);
  const migrated=await migrate(connection("x1_fixture", password));
  assert.equal(migrated.length,upgrade?0:freeze.expectedMigrations);
  const migrations=legacyUpgrade?[...legacyUpgrade.oldMigrations,...legacyUpgrade.additiveMigrations]:migrated;
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
  const deal = async (index: number, registration: string) => createDeal({ ...ctx, provenance: { ...ctx.provenance,
    ...(fullDomain?{sourceSystem:'existing-crm-owner'}:{}),externalId: registration } },
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
  const rules=unsupported?[rule,{...rule,id:'approval-conditioned-request',approvalCondition:'Current independent committee approval must be supplied; its meaning is not defined by this record'}]
    :ordinary?[rule,{...rule,id:'standing-workstream',triggerKind:'diligence_stream_needed',operation:'open_workstream',
      postconditionRef:'x1:pe-workstream-created:v1',observerRef:'x1:pe-workstream-creation-observer:v1'},
      {...rule,id:'standing-finding',triggerKind:'material_finding_observed',operation:'record_finding',
        postconditionRef:'x1:pe-finding-created:v1',observerRef:'x1:pe-finding-creation-observer:v1'}]:[rule];
  if(!ownerInputs)await admin.query(`INSERT INTO finnor_os.x1_work_mandates(tenant_id,principal_id,work_id,institution_id,revision,rules,valid_from,expires_at)
    VALUES($1,$2,$3,$4,'r1',$5::jsonb,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')`, [tenant, actor, workId, institutionId, JSON.stringify(rules)]);
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
  if(ordinary)for(const operation of ['open_workstream','record_finding']){
    const response:Response=await fetch(service.origin+`/api/policies/${tenant}/${operation}`,{
      method:'PUT',headers:{'content-type':'application/json',authorization:'Bearer '+service.token},
      body:JSON.stringify({policy:{scope:'DISPOSABLE_INTERNAL_CREATION_ONLY'},requiresConfirmation:false})});
    const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));
    await save('authenticated-standing-native-policy-'+operation+'.json',{status:response.status,body,
      beforeCompilerExposure:true,protectedGrantCreated:false});
  }
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
  const ordinaryFields={workstreamName:'Independent diligence '+randomUUID(),findingStatement:'Original material observation '+randomUUID()};
  if(ordinary)sources.find(source=>source.id==='work-original')!.rows.push(
    {id:'new-stream',kind:'trigger',triggerKind:'diligence_stream_needed',registrationId:registrationA,
      occurredAt,availableAt,workstreamKind:'financial_diligence',workstreamName:ordinaryFields.workstreamName},
    {id:'new-finding',kind:'trigger',triggerKind:'material_finding_observed',registrationId:registrationA,
      occurredAt,availableAt,workstreamExternalId,findingStatement:ordinaryFields.findingStatement,
      findingSeverity:'high',requiredForWorkstreamCompletion:true});
  if(heterogeneous)sources=await heterogeneousOwnerSources({registrationA,registrationB,occurredAt,availableAt,
    workRecords:sources.find(source=>source.id==='work-original')!.rows});
  const canonicalFixture=canonical?await canonicalOwnerSources({ctx,admin,institutionId,workId,
    dealId:String(first.row.id),companyId:companyIds[0]!,organizationKey:'org-'+companyIds[0]!,
    workstreamId:String(stream.row.id),requestedFromDealPartyId:String(party.row.id),occurredAt,availableAt,fullDomain}):null;
  if(canonicalFixture){sources.push(...canonicalFixture.sources);await save('canonical-owner-starting-state.json',canonicalFixture);}
  const grantIds: string[] = [], sourceBindings: Array<{sourceId:string;sourceClass:string;protocol:string;
    expectedObjectIds:string[];grantId:string;versionId:string;documentId:string;sha256:string}> = [];
  for (const source of sources) {
    const bytes = source.bytes??Buffer.from(JSON.stringify(source.rows)), grantId = randomUUID(),protocol=source.protocol??'json_records';
    const version = await withTenantTransaction(tenant, { userId: actor }, async db => {
      const doc = await createDocument(db, { tenantId: tenant, kind: "source_export", title: source.id,
        provenance: { sourceSystem: "owner-export", externalId: source.id, createdBy: actor } });
      return appendDocumentVersion(db, { tenantId: tenant, documentId: doc.documentId, bytes, mediaType: source.mediaType??"application/octet-stream", format: "unknown",
        origin: "manual_upload", actor, sourceSystem: "owner-export", sourceRef: source.id, providerVersionId: "r1" });
    });
    if(!ownerInputs)await admin.query(`INSERT INTO finnor_os.x1_source_grants(id,tenant_id,principal_id,work_id,institution_id,source_id,source_class,
      purpose,acquisition_kind,document_id,document_version_id,protocol,revision,original_sha256,expected_object_ids,valid_from,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'standing evidence responsibility','core_export',$8,$9,$10,'r1',$11,$12::jsonb,
        clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour')`,
    [grantId, tenant, actor, workId, institutionId, source.id, source.sourceClass, version.document_id, version.id,protocol,sha(bytes), JSON.stringify(source.rows.map(r => r.id))]);
    await writeFile(join(evidence, "originals", source.id + '.'+(source.extension??'json')), bytes, { mode: 0o600, flag: "wx" });
    if(!ownerInputs)grantIds.push(grantId); sourceBindings.push({ sourceId: source.id, sourceClass: source.sourceClass,protocol,
      expectedObjectIds:source.rows.map(r=>{assert.equal(typeof r.id,'string');return r.id as string;}),grantId, versionId: version.id, documentId: version.document_id, sha256: sha(bytes) });
  }
  expected = { mappings: [{ sourceId: "crm-original", recordId: "deal-A", canonicalId: String(first.row.id) },
    { sourceId: "crm-original", recordId: "deal-B", canonicalId: String(second.row.id) }],
    request: { tenantId: tenant, dealId: String(first.row.id), workstreamId: String(stream.row.id), requestedFromDealPartyId: String(party.row.id),
      ownerPartyId: actor, requestText, requestedAt: occurredAt, dueAt: deadlineAt, requiresAcceptedDeliverable: true },
    requestTexts:Array.from({length:dutyCount},(_,index)=>dutyCount===1?requestText:requestText+' item '+index),
    expectedRequestCount: dutyCount, expectedCompletionMeaning: "CREATION_ONLY_NOT_FULFILLMENT_OR_APPROVAL" };
  expected.quantityAssertions=[{sourceId:'ledger-original',recordId:'balance-A',factKey:'facility_balance',value:'20.00',
    currency:'USD',unit:'units',period:'2026-10',basis:'outstanding',occurredAt,availableAt,
    nativeType:'pe_deal',canonicalId:String(first.row.id)}];
  if(heterogeneous)expected.quantityAssertions.push({sourceId:'lender-original',recordId:'lender-A',factKey:'outstanding',value:'20.00',
    currency:'USD',unit:'units',period:'2026-10',basis:'outstanding',occurredAt,availableAt,
    nativeType:'pe_deal',canonicalId:String(first.row.id)});
  if(fullDomain)expected.quantityAssertions.push({sourceId:'expense-owner-original',recordId:'expense-A',factKey:'travel_expense',value:'17.50',
    currency:'USD',unit:'dollars',period:'2026-10',basis:'submitted_unapproved',occurredAt,availableAt,
    nativeType:'user',canonicalId:actor});
  if(ordinary)expected.ordinary={...ordinaryFields,dealId:String(first.row.id),existingWorkstreamId:String(stream.row.id),
    ownerPartyType:'employee',ownerPartyId:actor,workstreamKind:'financial_diligence',workstreamState:'not_started',
    findingState:'open',severity:'high',materiality:'material',requiredForWorkstreamCompletion:true,
    obligationDenominator:3,expectedNativeEffects:3};
  if(material)expected.correction={sourceId:'ledger-original',recordId:'balance-A',value:'25.00',
    currency:'USD',unit:'units',period:'2026-10',basis:'outstanding',canonicalDealId:String(first.row.id),
    affectedDutyCount:0,preservedDutyCount:1,newEffectCount:0,sourcePopulation:3};
  if(heterogeneous){
    const byteSources=sources.filter(source=>!canonicalFixture?.sources.some(canonical=>canonical.id===source.id));
    expected.mappings=byteSources.flatMap(source=>source.rows.filter(row=>row.kind==='entity').map(row=>{
      assert.ok(row.registrationId===registrationA||row.registrationId===registrationB,'independent owner identity fixture');
      return {sourceId:source.id,recordId:row.id,canonicalId:row.registrationId===registrationA?String(first.row.id):String(second.row.id)};
    }));
    assert.equal(expected.mappings.length,10);assert.equal(byteSources.length,12);
    expected.sourceCorpus={sourceClasses:[...new Set(sources.map(s=>s.sourceClass))].sort(),
      protocols:[...new Set(sources.map(s=>s.protocol??'json_records'))].sort(),sourceInstances:sources.length,
      observationRecords:sources.reduce((n,s)=>n+s.rows.length,0),
      quantities:[{sourceId:'ledger-original',recordId:'balance-A',factKey:'facility_balance',value:'20.00'},
        {sourceId:'lender-original',recordId:'lender-A',factKey:'outstanding',value:'20.00'}].map(q=>({...q,
          currency:'USD',unit:'units',period:'2026-10',basis:'outstanding',canonicalDealId:String(first.row.id)}))};
    assert.equal(expected.sourceCorpus.sourceClasses.length,fullDomain?10:8);assert.equal(expected.sourceCorpus.protocols.length,12);
  }
  if(canonicalFixture){
    expected.mappings=[...expected.mappings.map((mapping:any)=>({...mapping,nativeType:'pe_deal',kind:'deal'})),
      ...canonicalFixture.expected];
    assert.equal(expected.mappings.length,fullDomain?26:17);
    expected.canonicalKinds=JSON.parse(await readFile(join(repo,'scope-frontier5/x1-institutional-programme-compiler/profile.json'),'utf8')).canonicalTypes;
    assert.deepEqual([...new Set(expected.mappings.map((m:any)=>m.kind))].sort(),[...expected.canonicalKinds].sort());
  }
  if(unsupported)expected.unsupported={matchingRules:2,unresolvedDuties:1,ruleId:'approval-conditioned-request',
    reason:'X1_RULE_MEANING_UNSUPPORTED',unsupportedFields:['approvalCondition'],observedEffects:1,programme:'PARTIAL',fullWorkCompletionAllowed:false};
  await save("inputs-and-independent-expectations.json", { tenant, actor, institutionId, workId, rule,rules,sourceBindings, expected });
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
  if(ownerInputs){
    const expiry=new Date(Date.now()+3600000).toISOString();
    const userRules=rules.map(({postconditionRef:_postcondition,observerRef:_observer,...userRule})=>userRule);
    const mandateInput={workId,institutionId,rules:userRules,expiresAt:expiry};
    assert.equal((await api('institution-mandate',mandateInput,null)).status,401);
    assert.equal((await api('institution-mandate',{...mandateInput,rules:[{...userRules[0],observerRef:'invented'}]})).status,400);
    assert.equal((await api('institution-mandate',{...mandateInput,workId:randomUUID()})).status,404);
    assert.equal((await admin.query('SELECT count(*)::int n FROM finnor_os.x1_work_mandates WHERE tenant_id=$1',[tenant])).rows[0].n,0);
    const mandate=await api('institution-mandate',mandateInput);assert.equal(mandate.status,200,JSON.stringify(mandate));
    assert.equal(mandate.body.standing_id,mandate.body.id);assert.deepEqual(mandate.body.rules,rules);
    const repeatMandate=await api('institution-mandate',mandateInput);assert.equal(repeatMandate.status,200);
    assert.equal(repeatMandate.body.id,mandate.body.id);
    const configured=[];
    const selfConsent={institutionId,sourceClass:'personnel_benefits',purpose:'standing evidence responsibility',expiresAt:expiry};
    assert.equal((await api('institution-consent',{...selfConsent,subjectUserId:randomUUID()})).status,400);
    const consentRenewed=await api('institution-consent',selfConsent);assert.equal(consentRenewed.status,200,JSON.stringify(consentRenewed));
    assert.equal(consentRenewed.body.subject_user_id,actor);
    const consentRevoked=await api('institution-consent',{...selfConsent,revoke:true});assert.equal(consentRevoked.status,200);
    assert.ok(consentRevoked.body.revoked_at);assert.equal(consentRevoked.body.revision,consentRenewed.body.revision+1);
    const consentRestored=await api('institution-consent',selfConsent);assert.equal(consentRestored.status,200);
    assert.equal(consentRestored.body.revoked_at,null);assert.equal(consentRestored.body.revision,consentRevoked.body.revision+1);
    for(const binding of sourceBindings){
      const registration:{workId:string;documentId:string;documentVersionId:string;sourceClass:string;protocol:string;purpose:string;expiresAt:string}
        ={workId,documentId:binding.documentId,documentVersionId:binding.versionId,
        sourceClass:binding.sourceClass,protocol:binding.protocol,purpose:'standing evidence responsibility',expiresAt:expiry};
      assert.equal((await api('institution-register-source',{...registration,expectedObjectIds:binding.expectedObjectIds})).status,400);
      const registered=await api('institution-register-source',registration);assert.equal(registered.status,200,JSON.stringify(registered));
      assert.equal(registered.body.original_sha256,binding.sha256);assert.equal(registered.body.source_id,binding.sourceId);
      assert.deepEqual(registered.body.expected_object_ids,binding.expectedObjectIds);assert.equal(registered.body.principal_id,actor);
      binding.grantId=registered.body.id;grantIds.push(binding.grantId);
      const repeated=await api('institution-register-source',registration);assert.equal(repeated.status,200);
      assert.equal(repeated.body.id,binding.grantId);assert.equal(repeated.body.version,1);
      configured.push({registration,registered,repeated});
    }
    const choices=await api('institution-inputs',{workId});assert.equal(choices.status,200);
    assert.equal(choices.body.mandate.id,mandate.body.id);
    for(const binding of sourceBindings)assert.ok(choices.body.documents.some((d:any)=>d.document_id===binding.documentId&&d.version_id===binding.versionId));
    const actualGrants=(await admin.query(`SELECT id::text,source_id,expected_object_ids,original_sha256,version
      FROM finnor_os.x1_source_grants WHERE tenant_id=$1 ORDER BY source_id`,[tenant])).rows;
    assert.equal(actualGrants.length,sources.length);
    await save('authenticated-owner-input-independent-proof.json',{mandateInput,mandate,repeatMandate,configured,
      choices,actualGrants,sourceBindings,consentRenewed,consentRevoked,consentRestored,
      oracle:'PRE_EXPOSURE_LITERAL_RAW_OBJECT_IDS_BYTE_HASHES_AND_STANDING_RULES',
      privilegedMandateWrites:0,privilegedSourceGrantWrites:0,applicationRole:'finnor_app',executionAuthorityGranted:false});
    results.push({id:'G-authenticated-owner-inputs',status:'PASS',observed:{sources:sources.length,mandateRules:rules.length,
      privilegedInputWrites:0,idempotent:true},basis:'ACTUAL_AUTHENTICATED_HTTP_NATIVE_AUTHORITY_CORE_AND_RESTRICTED_SQL_INPUT_OWNER'});
    await save('inputs-and-independent-expectations.json',{tenant,actor,institutionId,workId,rule,rules,sourceBindings,expected});
  }
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
    ...(upgrade?{FINNOR_COMMIT_SHA:freeze.source.commit,FINNOR_RELEASE_SOURCE:'x1-local-source-runner-not-built-release'}:{}),
    ...(recovery||effectRecovery?{WORKER_JOB_LEASE_SECONDS:'5'}:{}),
    ...(effectRecovery?{FINNOR_STEP_LEASE_SECONDS:'5'}:{}) };
  if(recovery||effectRecovery){publicationBlocker=new pg.Client({connectionString:connection('x1_fixture',password)});
    await publicationBlocker.connect();await publicationBlocker.query('BEGIN');
    await publicationBlocker.query(effectRecovery?'LOCK TABLE finnor_os.pe_requests IN SHARE MODE'
      :'LOCK TABLE finnor_os.x1_mapping_admissions IN SHARE MODE');}
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
  if(checkerCrash){
    const exactEnvelope=async()=>({episodes:(await admin!.query(`SELECT id,original_deadline,wall_deadline,parent_reservation,parent_demand
      FROM finnor_os.x1_compiler_episodes WHERE tenant_id=$1 ORDER BY id`,[tenant])).rows,
      reservations:(await admin!.query(`SELECT reservation_id,envelopes FROM finnor_os.s5_reservations
        WHERE tenant_id=$1 ORDER BY reservation_id`,[tenant])).rows});
    let checkerTree:Array<{pid:number;ppid:number;argv:string}>=[];
    for(let poll=0;poll<600;poll++){
      if(guardFailure)throw Error(guardFailure);
      const processes=execFileSync('ps',['-axo','pid=,ppid=,command='],{encoding:'utf8',timeout:5000,maxBuffer:8*1024*1024})
        .split('\n').map(line=>/^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean)
        .map(match=>({pid:Number(match![1]),ppid:Number(match![2]),argv:match![3]!}));
      const root=processes.find(p=>p.ppid===worker!.pid&&p.argv.includes('/tsx/dist/cli.mjs')
        &&p.argv.includes('/scripts/frontier5/x1/checker-command.mts'));
      if(root){
        const owned=new Set([root.pid]);for(let cursor=0;cursor<3;cursor++)for(const p of processes)if(owned.has(p.ppid))owned.add(p.pid);
        checkerTree=processes.filter(p=>owned.has(p.pid));
        for(const p of [...checkerTree].reverse())process.kill(p.pid,'SIGKILL');break;
      }
      await new Promise(resolve=>setTimeout(resolve,25));
    }
    assert.ok(checkerTree.length>0,'actual independent checker child owned by this physical worker');
    await save('checker-crash-physical-process.json',{at:new Date().toISOString(),workerPid:worker.pid,checkerTree,
      signal:'SIGKILL',workerRetained:true,credentialsExposed:false});
    let refused:any,quarantine:any;
    for(let poll=0;poll<60;poll++){
      if(guardFailure)throw Error(guardFailure);
      refused=await api('institution-read',{requestId:compilerId});assert.equal(refused.status,200);
      quarantine=(await admin.query(`SELECT id,status,last_error,attempts FROM finnor_os.jobs WHERE tenant_id=$1
        AND type='run_x1_institution_compiler_v1' AND payload->>'requestId'=$2 ORDER BY id`,[tenant,compilerId])).rows[0];
      if(refused.body.status==='UNKNOWN'&&quarantine.status==='quarantined')break;
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    assert.equal(refused.body.status,'UNKNOWN');assert.equal(refused.body.reason,'X1_CHECKER_PROCESS_REFUSED');
    assert.equal(quarantine.status,'quarantined');assert.ok(quarantine.last_error.includes('X1_CHECKER_PROCESS_REFUSED'));
    for(const table of ['x1_mapping_admissions','x1_compiler_artifacts','domain_actions','pe_requests'])
      assert.equal((await admin.query(`SELECT count(*)::int n FROM finnor_os.${table} WHERE tenant_id=$1`,[tenant])).rows[0].n,0);
    const before=await exactEnvelope();assert.equal(before.episodes.length,1);assert.equal(before.reservations.length,1);
    const resumed=await api('institution-resume',{requestId:compilerId});assert.equal(resumed.status,202);
    assert.equal(resumed.body.requestId,compilerId);assert.equal(resumed.body.originalParentRetained,true);
    assert.deepEqual(await exactEnvelope(),before);
    checkerCrashProof={checkerTree,workerPid:worker.pid,refused,quarantine,before,resumed,
      actualCompatibleContinuation:'EXISTING_AUTHENTICATED_INSTITUTION_RESUME_NO_ALGORITHM_SUBSTITUTION'};
    await save('checker-crash-original-refusal-and-resume.json',checkerCrashProof);
  }
  if(effectRecovery){
    const originalEnvelope=async()=>({episodes:(await admin!.query(`SELECT id,original_deadline,wall_deadline,
      parent_reservation,parent_demand FROM finnor_os.x1_compiler_episodes WHERE tenant_id=$1 ORDER BY id`,[tenant])).rows,
      reservations:(await admin!.query(`SELECT reservation_id,envelopes FROM finnor_os.s5_reservations
        WHERE tenant_id=$1 ORDER BY reservation_id`,[tenant])).rows});
    let ownerWait:any,attempt:any;
    for(let poll=0;poll<240;poll++){
      if(guardFailure)throw Error(guardFailure);
      ownerWait=(await admin.query(`SELECT pid,wait_event_type,wait_event,query,pg_blocking_pids(pid) blocking_pids
        FROM pg_stat_activity WHERE usename='finnor_worker' AND wait_event_type='Lock'
          AND query ILIKE '%insert%pe_requests%'`)).rows[0];
      attempt=(await admin.query(`SELECT o.id,o.workflow_step_id,o.business_effect_id,o.request_hash,o.status,o.response,
        s.domain_action_id,s.claim_fence,s.dispatch_generation,s.effect_commit_at,s.execution_state,
        e.status effect_status FROM finnor_os.integration_operations o
        JOIN finnor_os.workflow_steps s ON s.tenant_id=o.tenant_id AND s.id=o.workflow_step_id
        JOIN finnor_os.business_effects e ON e.tenant_id=o.tenant_id AND e.id=o.business_effect_id
        WHERE o.tenant_id=$1 AND o.provider='finnor_plugin_runtime'`,[tenant])).rows[0];
      if(ownerWait&&attempt?.status==='running')break;
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    assert.ok(ownerWait&&attempt,'actual native owner insert wait after effect commit journal');
    assert.equal(attempt.response,null);assert.equal(attempt.effect_status,'executing');
    const before=await originalEnvelope();
    acknowledgementBlocker=new pg.Client({connectionString:connection('x1_fixture',password)});
    await acknowledgementBlocker.connect();await acknowledgementBlocker.query('BEGIN');
    await acknowledgementBlocker.query('SELECT id FROM finnor_os.integration_operations WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenant,attempt.id]);
    await publicationBlocker!.query('ROLLBACK');await publicationBlocker!.end();publicationBlocker=undefined;
    let ackWait:any,created:any;
    for(let poll=0;poll<80;poll++){
      if(guardFailure)throw Error(guardFailure);
      ackWait=(await admin.query(`SELECT pid,wait_event_type,wait_event,query,pg_blocking_pids(pid) blocking_pids
        FROM pg_stat_activity WHERE usename='finnor_worker' AND wait_event_type='Lock'
          AND query ILIKE '%update%integration_operations%'`)).rows[0];
      created=(await admin.query(`SELECT * FROM finnor_os.pe_requests WHERE tenant_id=$1
        AND request_text=$2`,[tenant,expected.requestTexts[0]])).rows;
      if(ackWait&&created.length===1)break;
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    assert.ok(ackWait,'actual acknowledgement write blocked after canonical commit');assert.equal(created.length,1);
    assert.equal(created[0].id,attempt.domain_action_id,'same preallocated original action identity');
    const unacknowledged=(await admin.query('SELECT status,response,verification_status FROM finnor_os.integration_operations WHERE tenant_id=$1 AND id=$2',[tenant,attempt.id])).rows[0];
    assert.equal(unacknowledged.status,'running');assert.equal(unacknowledged.response,null);
    const firstPid=worker.pid,stopped=new Promise<void>(resolve=>worker!.once('close',()=>resolve()));
    worker.kill('SIGKILL');await stopped;assert.equal(worker.signalCode,'SIGKILL');
    await acknowledgementBlocker.query('ROLLBACK');await acknowledgementBlocker.end();acknowledgementBlocker=undefined;
    effectRecoveryProof={before,attempt,ownerWait,ackWait,created,unacknowledged,firstPid,
      actualProcessDeath:true,originalEpisodeNotRestarted:true};
    await save('effect-recovery-physical-lost-ack.json',effectRecoveryProof);
    worker=startWorker();await save('effect-recovery-physical-worker.json',{pid:worker.pid,firstPid,
      environmentNames:Object.keys(env),sameOriginalStepAndJobLeases:true});
  }
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
      // The native owner can finish between the HTTP read and this independent
      // queue cut. Re-read its actual authenticated projection before closing;
      // never substitute the SQL status for an API response.
      const finalRead=await api('institution-read',{requestId:compilerId});
      assert.equal(finalRead.status,200);reading=finalRead.body;
      await save('terminal-queue-observation.json',{at:new Date().toISOString(),terminal,
        finalAuthenticatedRead:finalRead,originalFailureRetained:true,episodeRestarted:false});break;
    }
    await new Promise(resolve => setTimeout(resolve, dutyCount===128?2000:1000));
  }
  await save("compiler-ending-projection.json", reading);
  assert.equal(reading.status,unsupported?'PARTIAL':"OBSERVED", "actual compiler/native progression: " + JSON.stringify({ status: reading.status, reason: reading.reason }));
  assert.equal((await admin.query(`SELECT count(*)::int n FROM finnor_os.x1_compiler_requests
    WHERE tenant_id=$1 AND work_id=$2`,[tenant,workId])).rows[0].n,1,
    'own native graph maintenance must not create a spurious compiler revision');
  const admission=(await admin.query(`SELECT a.receipts FROM finnor_os.x1_mapping_admissions a
    JOIN finnor_os.x1_compiler_requests r ON r.tenant_id=a.tenant_id AND r.admission_id=a.id
    WHERE r.tenant_id=$1 AND r.principal_id=$2 AND r.id=$3`,[tenant,actor,compilerId])).rows[0];
  assert.ok(admission,"actual S1 mapping admission required");
  assert.equal(reading.costs.physicalCompute.phases.PUBLICATION?.deliveries,1,'one actual compiler publication measurement');
  assert.ok(reading.costs.physicalCompute.phases.PUBLICATION.attributedElapsedMs>0);
  await save('publication-compute-independent-readback.json',reading.costs.physicalCompute);
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
  const quantityReceipts=admission.receipts.filter((receipt:any)=>receipt.assertionKind==='QUANTITY');
  assert.equal(quantityReceipts.length,expected.quantityAssertions.length);
  const quantityOwnerProofs:Array<{oracle:any;receipt:any;record:{snapshot:Record<string,any>;as_of:Date;
    entity_refs:Array<{type:string;id:string}>}}> = [];
  for(const oracle of expected.quantityAssertions){
    const receipt=quantityReceipts.find((item:any)=>item.sourceId===oracle.sourceId&&item.recordId===oracle.recordId);
    assert.ok(receipt,'every original contextual quantity must reach its semantic evidence owner');
    const record:{snapshot:Record<string,any>;as_of:Date;entity_refs:Array<{type:string;id:string}>}=(await admin.query(`SELECT v.snapshot,v.as_of,ch.entity_refs FROM finnor_os.evidence_source_versions v
      JOIN finnor_os.evidence_chunks ch ON ch.tenant_id=v.tenant_id AND ch.source_id=v.source_id AND ch.version_id=v.id
      WHERE v.tenant_id=$1 AND v.source_id=$2 AND v.id=$3`,[tenant,receipt.evidenceSourceId,receipt.evidenceVersionId])).rows[0];
    assert.ok(record);const q:Record<string,any>=record.snapshot.sourceQuantity;
    assert.equal(q.schema,'finnor.x1.source-quantity-assertion.v1');
    assert.equal(q.classification,'SOURCE_ASSERTION_ATTACHED_NOT_SETTLED_TRUTH');assert.equal(q.executionAuthorityGranted,false);
    for(const field of ['sourceId','recordId','factKey','value','currency','unit','period','basis','occurredAt','availableAt'])
      assert.equal(q[field],oracle[field],'independent original semantic quantity '+field);
    assert.match(q.canonicalRef,new RegExp('^'+oracle.nativeType+':'+oracle.canonicalId+'@(v[1-9][0-9]*|s[a-f0-9]{64})$'));
    assert.equal(new Date(record.as_of).toISOString(),oracle.occurredAt);
    assert.ok(record.entity_refs.some((ref:any)=>ref.type===oracle.nativeType&&ref.id===oracle.canonicalId));
    const source=sourceBindings.find((binding:any)=>binding.sourceId===oracle.sourceId) as any;
    assert.equal(record.snapshot.documentId,source.documentId);assert.equal(record.snapshot.documentVersionId,source.versionId);
    assert.equal(record.snapshot.originalSha256,source.sha256);assert.equal(q.sourceRevision,'r1');
    assert.equal(q.knowledgeCut,reading.artifact.envelope.knowledge_cut);assert.equal(receipt.disposition,'SOURCE_ASSERTION_ATTACHED_NOT_SETTLED_TRUTH');
    if(oracle.nativeType==='pe_deal')assert.equal(receipt.evidenceAttachmentKind,'PE_EVIDENCE_LINK');
    else assert.equal(receipt.evidenceAttachmentKind,'CORE_EVIDENCE_ENTITY_REF');
    quantityOwnerProofs.push({oracle,receipt,record});
  }
  await save('quantity-semantic-owner-independent-proof.json',{identityMappingDenominator:expected.mappings.length,
    quantityDenominator:expected.quantityAssertions.length,proofs:quantityOwnerProofs,
    expectationsNotCandidateDerived:true,settledFinancialTruthEstablished:false,paymentAuthorityEstablished:false});
  results.push({id:'A-quantitative-semantic-owner-assertions',status:'PASS',observed:{identityMappingDenominator:expected.mappings.length,
    quantityDenominator:expected.quantityAssertions.length},basis:'ACTUAL_INDEPENDENT_RAW_EXPECTATIONS_IMMUTABLE_MEMORY_QUANTITY_CONTEXT_ENTITY_REFS_PE_ATTACHMENT_AND_ORIGINAL_CORE_PROVENANCE'});
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
  if(ordinary){
    const oracle=expected.ordinary;
    const streams=(await admin.query(`SELECT * FROM finnor_os.pe_workstreams
      WHERE tenant_id=$1 AND deal_id=$2 AND name=$3`,[tenant,oracle.dealId,oracle.workstreamName])).rows;
    const findings=(await admin.query(`SELECT * FROM finnor_os.pe_findings
      WHERE tenant_id=$1 AND deal_id=$2 AND statement=$3`,[tenant,oracle.dealId,oracle.findingStatement])).rows;
    assert.equal(streams.length,1);assert.equal(findings.length,1);
    const stream=streams[0],finding=findings[0];
    assert.equal(stream.kind,oracle.workstreamKind);assert.equal(stream.state,oracle.workstreamState);
    assert.equal(finding.state,oracle.findingState);assert.equal(finding.workstream_id,oracle.existingWorkstreamId);
    for(const [key,value] of Object.entries({severity:oracle.severity,materiality:oracle.materiality,
      required_for_workstream_completion:oracle.requiredForWorkstreamCompletion}))assert.equal(finding[key],value);
    for(const row of [stream,finding]){
      assert.equal(row.owner_party_type,oracle.ownerPartyType);assert.equal(row.owner_party_id,oracle.ownerPartyId);
      assert.equal(row.archived_at,null);assert.ok(new Date(row.created_at).getTime()<=Date.parse(deadlineAt));
    }
    for(const field of ['completed_at','cancelled_at'])assert.equal(stream[field],null);
    for(const field of ['disposition','resolved_at','accepted_at','superseded_at','related_request_id','related_deliverable_id'])assert.equal(finding[field],null);
    const effects=(await admin.query(`SELECT a.id,a.action_type,a.status,a.authority_context,e.status effect_status
      FROM finnor_os.domain_actions a JOIN finnor_os.business_effects e
        ON e.tenant_id=a.tenant_id AND e.domain_action_id=a.id WHERE a.tenant_id=$1 AND a.work_id=$2
        AND a.id=ANY($3::uuid[]) ORDER BY a.action_type`,[tenant,workId,[stream.id,finding.id]])).rows;
    assert.deepEqual(effects.map(row=>row.action_type),['open_workstream','record_finding']);
    for(const effect of effects){assert.equal(effect.status,'completed');assert.equal(effect.effect_status,'verified');
      assert.equal(effect.authority_context.kind,'institution_duty');assert.equal(effect.authority_context.principal,actor);
      assert.equal(effect.authority_context.compilerRequestId,compilerId);assert.equal(effect.authority_context.workInputId,input.workInputId);}
    allEffects.push(...effects);
    const actual=(await admin.query(`SELECT a.candidate,a.check_result FROM finnor_os.x1_compiler_requests r
      JOIN finnor_os.x1_compiler_artifacts a ON a.tenant_id=r.tenant_id AND a.id=r.artifact_id
      WHERE r.tenant_id=$1 AND r.id=$2`,[tenant,compilerId])).rows[0];
    assert.equal(actual.candidate.obligations.length,3);assert.equal(actual.check_result.obligationDenominator,3);
    assert.equal(allEffects.length,3);
    await save('ordinary-three-operations-independent-proof.json',{oracle,streams,findings,effects:allEffects,actual,
      originalExpectationsNotCandidateDerived:true,completionMeaning:'EXACT_CREATION_ONLY'});
    results.push({id:'A-all-ordinary-operations',status:'PASS',observed:{nativeEffects:3,obligationDenominator:3,
      operationClasses:['create_deal_request','open_workstream','record_finding']},
      basis:'ACTUAL_AUTHENTICATED_POLICIES_RAW_TRIGGER_RULES_PHYSICAL_WORKER_THREE_NATIVE_OWNERS_INDEPENDENT_SQL'});
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
    WHERE a.tenant_id=$1 AND a.work_id=$2 AND a.id=ANY($3::uuid[])`,[tenant,workId,allEffects.map(row=>row.id)])).rows;
  assert.equal(linked.length,ordinary?3:dutyCount);assert.ok(linked.every(row=>row.node_kind==='action'
    &&(ordinary?['create_deal_request','open_workstream','record_finding']:['create_deal_request']).includes(row.node_action_type)));
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
    if(unsupported)break;
    if(completion?.work_status==='completed'&&completion.objective_state==='completed'
      &&completion.plan_status==='completed')break;
    if(['failed','blocked','cancelled'].includes(completion?.objective_state))break;
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  await save('native-work-completion.json',completion);
  if(unsupported){
    assert.notEqual(completion?.work_status,'completed','unresolved material duty prevents full Work completion');
    assert.notEqual(completion.objective_state,'completed');assert.notEqual(completion.completion_proof?.verified,true);
    const native=(await admin.query(`SELECT request FROM finnor_os.p1_requests
      WHERE tenant_id=$1 AND id=(SELECT program_id FROM finnor_os.x1_compiler_requests WHERE tenant_id=$1 AND id=$2)`,
      [tenant,compilerId])).rows[0];
    const unresolved=native.request.institution.unresolved;assert.equal(unresolved.length,1);
    assert.equal(unresolved[0].reason,expected.unsupported.reason);assert.equal(unresolved[0].ruleId,expected.unsupported.ruleId);
    assert.equal(unresolved[0].originalDeadline,deadlineAt);assert.deepEqual(unresolved[0].unsupportedFields,expected.unsupported.unsupportedFields);
    assert.match(unresolved[0].ruleDigest,/^[a-f0-9]{64}$/);assert.ok(unresolved[0].stableIdentity);
    const actual=(await admin.query(`SELECT a.candidate,a.check_result FROM finnor_os.x1_compiler_requests r
      JOIN finnor_os.x1_compiler_artifacts a ON a.tenant_id=r.tenant_id AND a.id=r.artifact_id
      WHERE r.tenant_id=$1 AND r.id=$2`,[tenant,compilerId])).rows[0];
    assert.equal(actual.candidate.obligations.length,2);assert.equal(actual.check_result.obligationDenominator,2);
    assert.ok(reading.artifact.unresolved_interpretations.some((gap:any)=>gap.reason===expected.unsupported.reason
      &&gap.alternatives?.includes('Interpret approvalCondition in standing rule '+expected.unsupported.ruleId)));
    await save('mixed-unsupported-independent-proof.json',{expectation:expected.unsupported,actual,unresolved,
      completion,supportedCanonicalRequests:rows,effects:allEffects,originalEnvelope:beforeReplay,
      humanOrFallbackCredit:0,fullWorkCompleted:false,missingApprovalNotInvented:true});
    results.push({id:'F-mixed-unsupported-rule',status:'PASS',observed:{unresolved,completion,obligationDenominator:2,observedEffects:1},
      basis:'ACTUAL_INDEPENDENTLY_CHECKED_FULL_DUTY_POPULATION_SUPPORTED_NATIVE_EFFECT_AND_EXACT_PARTIAL_INTERVENTION'});
  }else{
    assert.equal(completion?.work_status,'completed','actual native Work completion');
    assert.equal(completion.objective_state,'completed','same native Objective completes');
    assert.equal(completion.success_verification?.state,'verified','actual native success-condition verification');
    assert.equal(completion.plan_status,'completed');assert.equal(completion.completion_proof?.verified,true);
  }
  results.push({ id: unsupported?'A-supported-independent-native-creation':"A-authenticated-owner-creation", status: "PASS", observed: { compilerId, admission, rows, effects:allEffects,plans,linked,repeated, beforeReplay, afterReplay },
    basis: "ACTUAL_LOCAL_AUTH_HTTP_SQL_PHYSICAL_WORKER_NATIVE_CREATE_AND_INDEPENDENT_SQL_OBSERVER" });
  if(heterogeneous){
    const actual=(await admin.query(`SELECT a.candidate,a.check_result,a.body,a.body_digest
      FROM finnor_os.x1_compiler_requests r JOIN finnor_os.x1_compiler_artifacts a ON a.tenant_id=r.tenant_id AND a.id=r.artifact_id
      WHERE r.tenant_id=$1 AND r.id=$2`,[tenant,compilerId])).rows[0];
    assert.ok(actual);assert.equal(actual.check_result.disposition,'ACCEPTED_DEVELOPMENT');
    assert.equal(actual.candidate.coverage.length,expected.sourceCorpus.sourceInstances);
    assert.equal(actual.candidate.mappings.length,expected.mappings.length);assert.equal(actual.candidate.quantities.length,fullDomain?3:2);
    for(const oracle of expected.sourceCorpus.quantities){
      const found=actual.candidate.quantities.filter((q:any)=>q.sourceId===oracle.sourceId&&q.recordId===oracle.recordId);
      assert.equal(found.length,1);for(const field of ['factKey','value','currency','unit','period','basis'])assert.equal(found[0][field],oracle[field]);
      assert.match(found[0].canonicalRef,new RegExp(`^pe_deal:${oracle.canonicalDealId}@v[1-9][0-9]*$`));
    }
    assert.equal(actual.candidate.obligations.length,ordinary?3:1);assert.equal(actual.candidate.unresolved.length,0);
    assert.equal(Object.keys(actual.body).length,14);assert.equal(Object.keys(actual.body.envelope).length,34);
    assert.equal(actual.body.envelope.source_refs.length,expected.sourceCorpus.sourceInstances);
    assert.deepEqual(Object.keys(actual.body.envelope.source_revision_vector).sort(),sources.map(s=>s.id).sort());
    assert.equal(actual.body.inferred_source_mapping_refs.length,expected.mappings.length+actual.candidate.quantities.length);
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
    assert.equal(admission.receipts.filter((receipt:any)=>receipt.assertionKind!=='QUANTITY').length,fullDomain?26:17);
    const currentConsent=(await admin.query(`SELECT b.registration_id,b.subject_user_id,c.revision,c.expires_at
      FROM finnor_os.x1_subject_identity_bindings b JOIN finnor_os.x1_subject_consents c
        ON c.tenant_id=b.tenant_id AND c.subject_user_id=b.subject_user_id AND c.institution_id=b.institution_id
      WHERE b.tenant_id=$1 AND b.source_id='person-owner-original' AND c.source_class='personnel_benefits'
        AND b.revoked_at IS NULL AND c.revoked_at IS NULL`,[tenant])).rows;
    assert.equal(currentConsent.length,1);assert.equal(currentConsent[0].subject_user_id,actor);
    assert.equal((await admin.query('SELECT count(*)::int n FROM finnor_os.pe_requests WHERE tenant_id=$1',[tenant])).rows[0].n,2);
    if(fullDomain){
      const links=JSON.parse(JSON.stringify((await admin.query(`SELECT * FROM finnor_os.pe_fund_vehicle_links
        WHERE tenant_id=$1 AND fund_id=ANY($2::uuid[]) AND vehicle_id=ANY($3::uuid[]) ORDER BY fund_id,vehicle_id`,
        [tenant,canonicalFixture.funds,canonicalFixture.vehicles])).rows));
      assert.equal(links.length,2);const original=links.find((link:any)=>link.id===canonicalFixture.originalLink.id);
      assert.deepEqual(original,canonicalFixture.originalLink,'existing actual arbitrary relationship ID/preimage retained');
      const created=links.find((link:any)=>link.id!==canonicalFixture.originalLink.id);
      assert.equal(created.fund_id,canonicalFixture.funds[1]);assert.equal(created.vehicle_id,canonicalFixture.vehicles[1]);
      assert.equal(created.relationship_kind,'other');assert.equal(new Date(created.valid_from).toISOString(),occurredAt);
      assert.equal(created.valid_to,null);assert.equal(created.superseded_at,null);
      const vehicleReceipts=admission.receipts.filter((receipt:any)=>/^pe_vehicle:/.test(receipt.canonicalRef));
      assert.equal(vehicleReceipts.length,2);assert.deepEqual(vehicleReceipts.map((receipt:any)=>receipt.relationId).sort(),links.map((link:any)=>link.id).sort());
      const artifact=(await admin.query(`SELECT a.candidate,a.body FROM finnor_os.x1_compiler_artifacts a
        JOIN finnor_os.x1_compiler_requests r ON r.tenant_id=a.tenant_id AND r.artifact_id=a.id WHERE r.tenant_id=$1 AND r.id=$2`,
        [tenant,compilerId])).rows[0];
      assert.equal(artifact.candidate.relations.length,2);
      const expense=artifact.candidate.quantities.filter((q:any)=>q.sourceId==='expense-owner-original');assert.equal(expense.length,1);
      for(const [field,value] of Object.entries({recordId:'expense-A',factKey:'travel_expense',value:'17.50',currency:'USD',
        unit:'dollars',period:'2026-10',basis:'submitted_unapproved'}))assert.equal(expense[0][field],value);
      assert.match(expense[0].canonicalRef,new RegExp('^user:'+actor+'@s[a-f0-9]{64}$'));
      for(const link of links)assert.ok(artifact.body.canonical_entity_and_relation_refs.some((ref:any)=>ref.ref===link.id));
      await save('full-domain-independent-proof.json',{sourceClasses:expected.sourceCorpus.sourceClasses,protocols:expected.sourceCorpus.protocols,
        sourceInstances:sources.length,mappingCount:26,canonicalKinds:expected.canonicalKinds,links,expense,completion,
        originalLegacyOwnersReused:true,originalRelationshipPreserved:true,newRelationshipCreated:true,
        ordinaryEffects:allEffects.length,protectedQualification:false});
      results.push({id:'A-full-declared-source-and-owner-domain',status:'PASS',observed:{sourceClasses:10,directProtocols:12,
        sourceInstances:15,mappingCount:26,canonicalKinds:14,ordinaryEffects:3,links,completion},
        basis:'ACTUAL_RAW_ALL_CLASSES_SENSITIVE_CONSENT_LEGACY_WORK_SCOPED_IDENTITIES_RELATION_REUSE_AND_NEW_OWNER_LINK_NATIVE_OPERATIONS'});
    }
    await save('fourteen-canonical-kind-independent-proof.json',{expectedKinds:expected.canonicalKinds,
      expectedMappings:expected.mappings,actualAdmission:admission,currentConsent,completion,
      actualPreexistingRequestId:canonicalFixture.existingRequestId,additionalNativeEffects:1,
      allExpectedEvidenceReferencesChecked:true,protectedQualification:false});
    results.push({id:'A-fourteen-canonical-kinds',status:'PASS',observed:{kinds:expected.canonicalKinds,
      mappings:17,additionalEffects:1,currentConsent,completion},basis:'ACTUAL_PREEXPOSURE_CANONICAL_OWNERS_SENSITIVE_CONSENT_S1_ADMISSIONS_AND_NATIVE_COMPLETION'});
  }
  if(mounted)await save('mounted-canonical-completion.json',{compilerId,workId,completion,
    browserEvidenceRequired:true,mountedPassEstablished:false});
  const meteredApiRows=async()=>JSON.parse(JSON.stringify((await admin!.query(`SELECT record_id,content_digest,body->'payload' payload
    FROM finnor_os.s7_economic_records WHERE tenant_id=$1 AND principal_id=$2 AND kind='COMPUTE'
      AND body->'payload'->>'schema'='finnor.x1.api-compute.v1' AND body->'payload'->>'workId'=$3
      ORDER BY knowledge_at,record_id`,[tenant,actor,workId])).rows));
  const apiMetersBefore=await meteredApiRows();
  const statusRead=await api('institution-status',{requestId:compilerId});assert.equal(statusRead.status,200);
  const repeatRead=await api('institution-read',{requestId:compilerId});assert.equal(repeatRead.status,200);
  const refusedRead=await api('institution-status',{requestId:compilerId,unexpected:'actual refused invocation'});
  assert.equal(refusedRead.status,400);
  const priorApiIds=new Set(apiMetersBefore.map((row:any)=>row.record_id)),allApiMeters=await meteredApiRows();
  const newApiMeters=allApiMeters.filter((row:any)=>!priorApiIds.has(row.record_id));assert.equal(newApiMeters.length,3);
  assert.deepEqual(newApiMeters.map((row:any)=>row.payload.statusCode).sort(),[200,200,400]);
  assert.equal(new Set(allApiMeters.map((row:any)=>row.payload.invocationId)).size,allApiMeters.length);
  const compilerEpisode=(await admin.query('SELECT episode_id FROM finnor_os.x1_compiler_requests WHERE tenant_id=$1 AND id=$2',[tenant,compilerId])).rows[0].episode_id;
  for(const row of newApiMeters){
    const p=row.payload;assert.equal(p.episodeId,compilerEpisode);assert.equal(p.requestId,compilerId);
    assert.ok(Number.isFinite(p.elapsedMs)&&p.elapsedMs>0);assert.equal(p.businessWorkCredit,0);
    assert.deepEqual(p.parentReservation,reading.costs.parentReservation);
    assert.equal(p.money,null);assert.equal(p.humanSeconds,null);assert.equal(p.aggregatePeakMemoryBytes,null);
  }
  assert.ok(repeatRead.body.costs.physicalCompute.phases.AUTHENTICATED_API.deliveries>=apiMetersBefore.length+1,
    'actual S7 owner preimage consumer includes the preceding status call');
  await save('authenticated-api-compute-independent-proof.json',{beforeCount:apiMetersBefore.length,
    newRecords:newApiMeters,allInvocationCount:allApiMeters.length,
    ownerReadback:repeatRead.body.costs.physicalCompute,rawFailureCostsRetained:true,originalParentRetained:true});
  results.push({id:'G-authenticated-api-compute-attribution',status:'PASS',observed:{actualNewRecords:3,
    statusCodes:[200,200,400],originalParentRetained:true},basis:'ACTUAL_AUTHENTICATED_API_DISPOSITIONS_IMMUTABLE_S7_SQL_AND_OWNER_PREIMAGE_READ'});
  if(legacyUpgrade){
    let compatible:any,retired:any;
    for(let poll=0;poll<60;poll++){
      if(guardFailure)throw Error(guardFailure);
      compatible=(await admin.query('SELECT * FROM finnor_os.jobs WHERE id=$1',[legacyUpgrade.probeId])).rows[0];
      retired=(await admin.query('SELECT * FROM finnor_os.jobs WHERE id=$1',[legacyUpgrade.retiredId])).rows[0];
      if(compatible?.status==='completed'&&retired?.status==='quarantined')break;
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    assert.equal(compatible.status,'completed');assert.equal(compatible.protocol_version,1);
    assert.equal(compatible.payload.commitSha,freeze.source.commit);assert.equal(compatible.attempts,1);
    assert.equal(retired.status,'quarantined');assert.match(retired.last_error,/RETIRED_VERTICAL/);assert.equal(retired.attempts,0);
    const claims=(await admin.query(`SELECT job_id,outcome,protocol_version,claim_fence,finished_at
      FROM finnor_os.job_delivery_attempts WHERE job_id=ANY($1::uuid[]) ORDER BY job_id`,
      [[legacyUpgrade.probeId,legacyUpgrade.retiredId]])).rows;
    assert.equal(claims.length,1);assert.equal(claims[0].job_id,legacyUpgrade.probeId);assert.equal(claims[0].outcome,'completed');
    const ending=await observePreservedUpgradeOwners(admin,legacyUpgrade);assert.deepEqual(ending,legacyUpgrade.starting);
    const newJobs=(await admin.query(`SELECT type,protocol_version,status,count(*)::int count FROM finnor_os.jobs
      WHERE tenant_id=$1 GROUP BY type,protocol_version,status ORDER BY type,protocol_version,status`,[tenant])).rows;
    assert.ok(newJobs.some(row=>row.type==='run_x1_institution_compiler_v1'&&row.protocol_version===1&&row.status==='completed'));
    assert.ok(newJobs.some(row=>row.type==='run_workflow_step_v2'&&row.protocol_version===2&&row.status==='completed'));
    await save('existing-schema-upgrade-ending-proof.json',{starting:legacyUpgrade,ending,compatible,retired,claims,newJobs,completion,
      protectedAuthorityCreated:false,claimDomain:'ACTUAL_PRE_X1_SCHEMA_ADDITIVE_UPGRADE_NATIVE_OWNER_DATA_AND_JOB_COMPATIBILITY',
      finalBuiltInstallationEstablished:false});
    results.push({id:'G-existing-schema-upgrade-and-jobs',status:'PASS',observed:{oldHead:legacyUpgrade.oldHead,
      applied:legacyUpgrade.additiveMigrations,secondPassApplied:0,compatibleJob:compatible.id,retiredJob:retired.id,
      oldRowsAndBytesPreserved:true,newJobs,completion},basis:'ACTUAL_IMMUTABLE_BASE_SQL_NATIVE_LEGACY_OWNER_FIXTURE_ADDITIVE_UPGRADE_PHYSICAL_MIXED_JOB_DELIVERY'});
  }
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
  if(effectRecovery){
    const operation=(await admin.query(`SELECT * FROM finnor_os.integration_operations
      WHERE tenant_id=$1 AND id=$2`,[tenant,effectRecoveryProof.attempt.id])).rows[0];
    assert.equal(operation.status,'unknown','executor acknowledgement uncertainty retained');
    assert.equal(operation.response,null,'no invented executor response');assert.equal(operation.verification_status,'verified');
    assert.equal(operation.workflow_step_id,effectRecoveryProof.attempt.workflow_step_id);
    assert.equal(operation.business_effect_id,effectRecoveryProof.attempt.business_effect_id);
    assert.equal(operation.request_hash,effectRecoveryProof.attempt.request_hash);
    const after={episodes:(await admin.query(`SELECT id,original_deadline,wall_deadline,parent_reservation,parent_demand
      FROM finnor_os.x1_compiler_episodes WHERE tenant_id=$1 ORDER BY id`,[tenant])).rows,
      reservations:(await admin.query(`SELECT reservation_id,envelopes FROM finnor_os.s5_reservations
        WHERE tenant_id=$1 ORDER BY reservation_id`,[tenant])).rows};
    assert.deepEqual(after,effectRecoveryProof.before);
    const step=(await admin.query(`SELECT s.*,c.outcome claim_outcome FROM finnor_os.workflow_steps s
      JOIN finnor_os.workflow_step_claims c ON c.tenant_id=s.tenant_id AND c.workflow_step_id=s.id
      WHERE s.tenant_id=$1 AND s.id=$2 ORDER BY c.claimed_at DESC LIMIT 1`,[tenant,operation.workflow_step_id])).rows[0];
    assert.equal(step.claim_fence,effectRecoveryProof.attempt.claim_fence,'no new executor claim');
    assert.equal(step.dispatch_generation,effectRecoveryProof.attempt.dispatch_generation);assert.equal(step.status,'completed');
    const cases=(await admin.query('SELECT * FROM finnor_os.reconciliation_cases WHERE tenant_id=$1 AND related_step_id=$2',[tenant,step.id])).rows;
    assert.equal(cases.length,1);assert.equal(cases[0].status,'resolved');assert.equal(cases[0].resolution_outcome,'happened_as_intended');
    await save('effect-recovery-independent-native-completion.json',{...effectRecoveryProof,after,operation,step,cases,completion,
      originalEffects:allEffects,canonicalRequests:rows,executorReplayCount:0,acknowledgementStillUnknown:true});
    results.push({id:'D-effect-submit-lost-ack',status:'PASS',observed:{operationId:operation.id,step,completion},
      basis:'ACTUAL_CANONICAL_COMMIT_LOST_ACK_SIGKILL_SAME_IDENTITY_UNKNOWN_JOURNAL_READ_ONLY_OWNER_SETTLEMENT'});
  }
  if(checkerCrash){
    const history=(await admin.query(`SELECT id,attempts,acquisition_calls,original_deadline,wall_deadline,parent_reservation,parent_demand
      FROM finnor_os.x1_compiler_episodes WHERE tenant_id=$1`,[tenant])).rows;
    assert.equal(history.length,1);assert.equal(history[0].attempts,2);assert.equal(history[0].acquisition_calls,6);
    assert.deepEqual(Object.fromEntries(Object.keys(checkerCrashProof.before.episodes[0]).map(key=>[key,history[0][key]])),
      checkerCrashProof.before.episodes[0]);
    const compilerJobs=(await admin.query(`SELECT id,status,attempts,payload,claim_fence FROM finnor_os.jobs
      WHERE tenant_id=$1 AND type='run_x1_institution_compiler_v1' AND payload->>'requestId'=$2 ORDER BY id`,[tenant,compilerId])).rows;
    assert.equal(compilerJobs.length,2);assert.deepEqual(compilerJobs.map(job=>job.status).sort(),['completed','quarantined']);
    assert.equal(reading.costs.physicalCompute.phases.COMPILE.deliveries,2);
    await save('checker-crash-compatible-native-completion.json',{...checkerCrashProof,history,compilerJobs,
      actualCosts:reading.costs,completion,rows,effects:allEffects,originalFailureAndCostRetained:true,
      oneOriginalRequestAndEpisode:true,alternativeAlgorithmClaimed:false});
    results.push({id:'F-physical-checker-crash-and-compatible-resume',status:'PASS',observed:{compilerJobs,history,completion},
      basis:'ACTUAL_CHECKER_SIGKILL_UNKNOWN_QUARANTINE_ORIGINAL_PARENT_AUTH_RESUME_SECOND_CHECKER_AND_NATIVE_COMPLETION'});
  }
  if(reportingChanges){
    const initialObjective=(await admin.query('SELECT * FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND work_id=$2',[tenant,workId])).rows[0];
    const originalProof=sha(JSON.stringify(completion.completion_proof)),originalPlanId=completion.plan_id;
    const originalEnvelopeBefore=await originalEnvelope();let previousRequest=compilerId;
    const replaceSources=async(variants:Array<{sourceId:string;bytes:Buffer}>)=>withTenantTransaction(tenant,{userId:actor},async(db,c)=>{
      const replacements=[];
      for(const variant of variants){
        const original=(await c.query<{id:string;document_id:string;version:number}>(`SELECT id::text,document_id::text,version
          FROM finnor_os.x1_source_grants WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND source_id=$4
          ORDER BY version DESC LIMIT 1 FOR UPDATE`,[tenant,actor,workId,variant.sourceId])).rows[0]!;
        const revision='r'+(original.version+1),source=sources.find(source=>source.id===variant.sourceId)!;
        const version=await appendDocumentVersion(db,{tenantId:tenant,documentId:original.document_id,bytes:variant.bytes,
          mediaType:source.mediaType??'application/octet-stream',format:'unknown',origin:'manual_upload',actor,
          sourceSystem:'owner-export',sourceRef:variant.sourceId,providerVersionId:revision});
        const grant=(await c.query(`INSERT INTO finnor_os.x1_source_grants
          (tenant_id,principal_id,work_id,institution_id,source_id,source_class,purpose,acquisition_kind,
            document_id,document_version_id,protocol,revision,original_sha256,expected_object_ids,version,valid_from,expires_at)
          SELECT tenant_id,principal_id,work_id,institution_id,source_id,source_class,purpose,acquisition_kind,
            document_id,$4,protocol,$5,$6,expected_object_ids,version+1,valid_from,expires_at
          FROM finnor_os.x1_source_grants WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 RETURNING id::text,version,source_id`,
          [tenant,actor,original.id,version.id,revision,sha(variant.bytes)])).rows[0];
        replacements.push({grant,versionId:version.id,originalId:original.id,revision,sha256:sha(variant.bytes)});
        await writeFile(join(evidence,'originals',variant.sourceId+'-'+revision+'.bin'),variant.bytes,{mode:0o600,flag:'wx'});
      }
      return replacements;
    });
    const ledgerSource=sources.find(source=>source.id==='ledger-original')!,mailSource=sources.find(source=>source.id==='mail-original')!;
    const crmSource=sources.find(source=>source.id==='crm-original')!,lenderSource=sources.find(source=>source.id==='lender-original')!;
    const changes=[
      {id:'financial-mail-cosmetic',variants:[{sourceId:ledgerSource.id,bytes:Buffer.from(ledgerSource.bytes!.toString().replace('\t20.00\t','\t25.00\t'))},
        {sourceId:crmSource.id,bytes:Buffer.from(crmSource.bytes!.toString().replaceAll('Conflicting Harbor','Changed cosmetic label'))},
        {sourceId:mailSource.id,bytes:Buffer.from(mailSource.bytes!.toString()+'An exception remains requested. The owner has not supplied any approval.\r\n')}],
        expectedSemanticSource:'ledger-original',lenderUnknown:false},
      {id:'lender-field-meaning',variants:[{sourceId:lenderSource.id,bytes:Buffer.from(lenderSource.bytes!.toString().replace('<th>Outstanding</th>','<th>Committed</th>'))}],
        expectedSemanticSource:'lender-original',lenderUnknown:true},
      {id:'explicit-current-lender-assertion',variants:[{sourceId:lenderSource.id,bytes:lenderSource.bytes!}],
        expectedSemanticSource:'lender-original',lenderUnknown:false},
    ];
    for(const change of changes){
      const replacements=await replaceSources(change.variants);
      const stale=await api('institution-read',{requestId:previousRequest});assert.equal(stale.status,200);
      assert.equal(stale.body.status,'INVALIDATED');assert.equal(stale.body.artifact,null);assert.equal(stale.body.programme,null);
      let next:any,response:any,ending:any;
      for(let poll=0;poll<180;poll++){
        if(guardFailure)throw Error(guardFailure);
        next=(await admin.query(`SELECT id::text,parent_request_id,episode_id,revision,status FROM finnor_os.x1_compiler_requests
          WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 ORDER BY revision DESC LIMIT 1`,[tenant,actor,workId])).rows[0];
        if(next.id!==previousRequest){
          response=await api('institution-read',{requestId:next.id});assert.equal(response.status,200,JSON.stringify(response));
          if(['UNKNOWN','FAILED','CHECK_REJECTED','INVALIDATED','CANCELLED'].includes(response.body.status)){
            await save('reporting-change-'+change.id+'-failure.json',{change,replacements,next,response});
            throw Error('ACTUAL_REPORTING_CHANGE_REFUSAL:'+response.body.status+':'+response.body.reason);
          }
          ending=(await admin.query(`SELECT w.status work_status,l.id objective_id,l.state objective_state,
            l.success_verification,p.id plan_id,p.status plan_status,p.completion_proof
            FROM finnor_os.works w JOIN finnor_os.work_objective_loops l ON l.tenant_id=w.tenant_id AND l.work_id=w.id
            JOIN finnor_os.work_plan_revisions p ON p.tenant_id=l.tenant_id AND p.objective_loop_id=l.id
            WHERE w.tenant_id=$1 AND w.id=$2 ORDER BY p.revision DESC LIMIT 1`,[tenant,workId])).rows[0];
          if(response.body.status==='OBSERVED'&&ending.work_status==='completed'&&ending.plan_status==='completed')break;
        }
        await new Promise(resolve=>setTimeout(resolve,1000));
      }
      assert.notEqual(next.id,previousRequest);assert.equal(next.parent_request_id,previousRequest);
      assert.equal(response.body.status,'OBSERVED');assert.equal(ending.work_status,'completed');assert.equal(ending.objective_state,'completed');
      assert.equal(ending.objective_id,initialObjective.id);assert.equal(ending.completion_proof.verified,true);
      const current:{candidate:any;body:any;input_manifest:any;dependency_graph:any}=(await admin.query(`SELECT a.candidate,a.body,a.input_manifest,a.dependency_graph
        FROM finnor_os.x1_compiler_artifacts a JOIN finnor_os.x1_compiler_requests r
          ON r.tenant_id=a.tenant_id AND r.artifact_id=a.id WHERE r.tenant_id=$1 AND r.id=$2`,[tenant,next.id])).rows[0];
      assert.equal(current.candidate.coverage.length,15);assert.equal(current.candidate.mappings.length,26);
      assert.equal(current.candidate.obligations.length,3);assert.equal(response.body.programme.program.observedPostconditions.length,3);
      const assertions:Array<Record<string,any>>=(await admin.query(`SELECT a.receipts FROM finnor_os.x1_mapping_admissions a
        JOIN finnor_os.x1_compiler_requests r ON r.tenant_id=a.tenant_id AND r.admission_id=a.id
        WHERE r.tenant_id=$1 AND r.id=$2`,[tenant,next.id])).rows[0].receipts;
      const originalQuantityVersions=[];
      for(const initial of quantityOwnerProofs){
        const retained:{snapshot:Record<string,any>;as_of:Date}=(await admin.query(`SELECT snapshot,as_of FROM finnor_os.evidence_source_versions
          WHERE tenant_id=$1 AND id=$2`,[tenant,initial.receipt.evidenceVersionId])).rows[0];
        assert.deepEqual(retained.snapshot,initial.record.snapshot,'original immutable quantity context retained');
        assert.equal(new Date(retained.as_of).toISOString(),new Date(initial.record.as_of).toISOString());
        originalQuantityVersions.push({id:initial.receipt.evidenceVersionId,snapshot:retained.snapshot});
      }
      const currentQuantityVersions=[];
      const quantityOracles=expected.quantityAssertions.filter((oracle:any)=>!(change.lenderUnknown&&oracle.sourceId==='lender-original'))
        .map((oracle:any)=>({...oracle,...(oracle.sourceId==='ledger-original'?{value:'25.00'}:{})}));
      assert.equal(assertions.filter((receipt:any)=>receipt.assertionKind==='QUANTITY').length,quantityOracles.length);
      for(const oracle of quantityOracles){
        const receipt=assertions.find((item:any)=>item.assertionKind==='QUANTITY'&&item.sourceId===oracle.sourceId&&item.recordId===oracle.recordId);
        assert.ok(receipt);const stored:{snapshot:Record<string,any>}=(await admin.query('SELECT snapshot FROM finnor_os.evidence_source_versions WHERE tenant_id=$1 AND id=$2',
          [tenant,receipt.evidenceVersionId])).rows[0];const claim:Record<string,any>=stored.snapshot.sourceQuantity;
        for(const field of ['sourceId','recordId','factKey','value','currency','unit','period','basis','occurredAt','availableAt'])assert.equal(claim[field],oracle[field]);
        assert.equal(claim.knowledgeCut,current.body.envelope.knowledge_cut);
        assert.equal(claim.classification,'SOURCE_ASSERTION_ATTACHED_NOT_SETTLED_TRUTH');
        currentQuantityVersions.push({receipt,snapshot:stored.snapshot});
      }
      const ledger=current.candidate.quantities.filter((q:any)=>q.sourceId==='ledger-original');assert.equal(ledger.length,1);
      assert.equal(ledger[0].value,'25.00');assert.equal(ledger[0].currency,'USD');assert.equal(ledger[0].basis,'outstanding');
      const lender=current.candidate.quantities.filter((q:any)=>q.sourceId==='lender-original');
      assert.equal(lender.length,change.lenderUnknown?0:1);
      const unknown=current.candidate.unresolved.filter((gap:any)=>gap.sourceId==='lender-original'&&gap.recordId==='lender-A');
      assert.equal(unknown.length,change.lenderUnknown?1:0);
      if(change.lenderUnknown){assert.equal(unknown[0].reason,'DESCRIPTIVE_CROSS_REFERENCE_NOT_IDENTITY_OR_NORM');
        assert.deepEqual(unknown[0].alternatives,[`pe_deal:${String(first.row.id)}@v1`]);
        assert.ok(current.body.unresolved_interpretations.some((gap:any)=>gap.witnessRefs.includes(unknown[0].witness)));}
      const update:{changedDependencyIds:string[];affectedPriorDutyIds:string[];affectedCurrentDutyIds:string[];preservedCurrentDutyIds:string[]}=(await admin.query(`SELECT body FROM finnor_os.x1_compiler_events
        WHERE tenant_id=$1 AND request_id=$2 AND kind='P7_EXACT_AFFECTED_UPDATE' ORDER BY created_at DESC LIMIT 1`,[tenant,next.id])).rows[0].body;
      assert.deepEqual(update.changedDependencyIds,[JSON.stringify(['source-semantics',change.expectedSemanticSource])]);
      assert.equal(update.affectedPriorDutyIds.length,0);assert.equal(update.affectedCurrentDutyIds.length,0);
      assert.equal(update.preservedCurrentDutyIds.length,3);
      const finalObjective:Record<string,any>=(await admin.query('SELECT * FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND work_id=$2',[tenant,workId])).rows[0];
      for(const field of ['max_steps','max_actions','max_queries','max_waits','max_node_attempts','deadline_at'])
        assert.deepEqual(finalObjective[field],initialObjective[field],'original objective envelope '+field);
      for(const field of ['step_count','query_count','action_count','node_attempt_count'])assert.ok(finalObjective[field]>=initialObjective[field]);
      assert.deepEqual(await originalEnvelope(),originalEnvelopeBefore);
      assert.equal(sha(JSON.stringify((await admin.query('SELECT completion_proof FROM finnor_os.work_plan_revisions WHERE tenant_id=$1 AND id=$2',
        [tenant,originalPlanId])).rows[0].completion_proof)),originalProof);
      assert.equal((await admin.query('SELECT count(*)::int n FROM finnor_os.domain_actions WHERE tenant_id=$1 AND work_id=$2',[tenant,workId])).rows[0].n,3);
      await save('reporting-change-'+change.id+'-independent-proof.json',{change,replacements,stale,next,response,current,update,ending,
        originalQuantityVersions,currentQuantityVersions,
        originalEnvelope:originalEnvelopeBefore,initialObjective,finalObjective,originalCreationEffectsRetained:allEffects,
        newBusinessWorkCredit:0,exceptionApprovalSupplied:false});
      previousRequest=next.id;
    }
    const finalEpisode=(await admin.query(`SELECT attempts,acquisition_calls FROM finnor_os.x1_compiler_episodes WHERE tenant_id=$1
      AND id=(SELECT episode_id FROM finnor_os.x1_compiler_requests WHERE tenant_id=$1 AND id=$2)`,[tenant,previousRequest])).rows[0];
    assert.equal(finalEpisode.attempts,4);assert.equal(finalEpisode.acquisition_calls,60);
    results.push({id:'B-report-meaning-exception-and-cosmetic-change',status:'PASS',observed:{automaticChildren:3,
      originalSourcePopulation:15,originalDutiesPreserved:3,totalNativeEffects:3,episode:finalEpisode},
      basis:'ACTUAL_SOURCE_OWNER_CHANGES_AUTOMATIC_P7_MINIMAL_SEMANTIC_CLOSURE_LENDER_UNKNOWN_SAME_NATIVE_OBJECTIVE_AND_PARENT'});
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
        AND payload->>'requestId'=$2 AND type='run_x1_institution_compiler_v1' LIMIT 1`,
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
  if(cancelObserved){
    const priorProofDigest=sha(JSON.stringify(completion.completion_proof));
    const cancelled=await api('institution-cancel',{requestId:compilerId});
    await save('observed-standing-cancellation.json',{cancelled,priorCompletion:completion,originalEnvelope:beforeReplay});
    assert.equal(cancelled.status,200);assert.equal(cancelled.body.status,'CANCELLED','observed standing continuation can be stopped');
    assert.equal(cancelled.body.exposureRetained,true);
    const stopped=await api('institution-read',{requestId:compilerId});assert.equal(stopped.status,200);
    assert.equal(stopped.body.status,'CANCELLED');assert.equal(stopped.body.artifact,null);assert.equal(stopped.body.programme,null);
    const ledger=(await admin.query<{id:string;document_id:string}>(`SELECT id::text,document_id::text FROM finnor_os.x1_source_grants
      WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND source_id='ledger-original' AND version=1`,[tenant,actor,workId])).rows[0]!;
    const corrected=Buffer.from(JSON.stringify(sources.find(s=>s.id==='ledger-original')!.rows.map(row=>({...row,value:'25.00'}))));
    const version=await withTenantTransaction(tenant,{userId:actor},async db=>appendDocumentVersion(db,{tenantId:tenant,
      documentId:ledger.document_id,bytes:corrected,mediaType:'application/json',format:'unknown',origin:'manual_upload',
      actor,sourceSystem:'owner-export',sourceRef:'ledger-original',providerVersionId:'r2'}));
    await admin.query(`INSERT INTO finnor_os.x1_source_grants
      (tenant_id,principal_id,work_id,institution_id,source_id,source_class,purpose,acquisition_kind,
        document_id,document_version_id,protocol,revision,original_sha256,expected_object_ids,version,valid_from,expires_at)
      SELECT tenant_id,principal_id,work_id,institution_id,source_id,source_class,purpose,acquisition_kind,
        document_id,$4,protocol,'r2',$5,expected_object_ids,2,valid_from,expires_at
      FROM finnor_os.x1_source_grants WHERE tenant_id=$1 AND principal_id=$2 AND id=$3`,
      [tenant,actor,ledger.id,version.id,sha(corrected)]);
    await writeFile(join(evidence,'originals/ledger-after-cancel.json'),corrected,{mode:0o600,flag:'wx'});
    const state=(await admin.query(`SELECT r.status,r.generation,
      (SELECT count(*)::int FROM finnor_os.x1_compiler_requests WHERE tenant_id=r.tenant_id AND work_id=r.work_id) compiler_count,
      (SELECT count(*)::int FROM finnor_os.x1_compiler_updates WHERE tenant_id=r.tenant_id AND work_id=r.work_id) update_count
      FROM finnor_os.x1_compiler_requests r WHERE tenant_id=$1 AND id=$2`,[tenant,compilerId])).rows[0];
    assert.equal(state.status,'CANCELLED');assert.equal(state.compiler_count,1);assert.equal(state.update_count,0);
    assert.deepEqual(await originalEnvelope(),beforeReplay,'consumed original parent/resource envelope retained');
    assert.equal((await admin.query('SELECT count(*)::int n FROM finnor_os.pe_requests WHERE tenant_id=$1',[tenant])).rows[0].n,1);
    const retained=(await admin.query('SELECT completion_proof,status FROM finnor_os.work_plan_revisions WHERE tenant_id=$1 AND id=$2',
      [tenant,completion.plan_id])).rows[0];assert.equal(retained.status,'completed');assert.equal(sha(JSON.stringify(retained.completion_proof)),priorProofDigest);
    assert.equal((await admin.query('SELECT status FROM finnor_os.works WHERE tenant_id=$1 AND id=$2',[tenant,workId])).rows[0].status,'completed');
    await save('cancel-observed-standing-independent-proof.json',{cancelled,stopped,state,
      originalEnvelope:await originalEnvelope(),priorCompletionProofDigest:priorProofDigest,
      ownerRevisionCreated:true,newCompilerChildren:0,newEffects:0,consumedReservationReleased:false});
    results.push({id:'E-cancel-observed-standing-continuation',status:'PASS',observed:{cancelled,state},
      basis:'ACTUAL_AUTHENTICATED_CANCEL_AFTER_NATIVE_COMPLETION_AND_SOURCE_OWNER_CHANGE_NO_FUTURE_COMPILER_OR_DUPLICATE_EFFECT'});
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
  if(acknowledgementBlocker){await acknowledgementBlocker.query('ROLLBACK').catch(()=>{});await acknowledgementBlocker.end().catch(()=>{});}
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
