/** Real disposable PostgreSQL upgrade/storage E2E. Fixture charge rows are
 * declared synthetic history, not proof of native cost or business execution. */
import {strict as assert} from "node:assert";
import {randomBytes,randomUUID,createHash} from "node:crypto";
import {mkdir,readFile,readdir,writeFile} from "node:fs/promises";
import {createServer} from "node:net";
import {join,resolve,isAbsolute} from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import {migrate} from "../../packages/db/migrate";
import {MIGRATIONS} from "../../packages/db/migrations-bundle";
import {CURRENT_MIGRATION_HEAD} from "../../packages/db/migration-head";
import {closePool} from "../../packages/db";

const out=process.env.FINNOR_X_PHASE_UPGRADE_EVIDENCE_DIR;
assert(out&&isAbsolute(out),"NEW_ABSOLUTE_UPGRADE_EVIDENCE_DIRECTORY_REQUIRED");
await mkdir(out,{mode:0o700});
const repo=resolve(import.meta.dirname,"../../.."),privateDir=join(out,"private");
await mkdir(privateDir,{mode:0o700});
const sha=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const readSql=async()=>Promise.all((await readdir(join(repo,"finnor-os/packages/db/migrations")))
 .filter(name=>name.endsWith(".sql")).sort().map(async name=>({name,sql:await readFile(join(repo,"finnor-os/packages/db/migrations",name),"utf8")})));
const files=await readSql();
assert.deepEqual(MIGRATIONS,files,"COMPLETE_BUNDLE_SQL_BYTE_PARITY_REQUIRED");
assert.equal(CURRENT_MIGRATION_HEAD,files.at(-1)?.name,"COMPLETE_MIGRATION_HEAD_REQUIRED");
const cut=async()=>({sqlDigest:sha(await readSql()),migrator:sha(await readFile(join(repo,"finnor-os/packages/db/migrate.ts"),"utf8")),
 driver:sha(await readFile(import.meta.filename,"utf8")),node:process.version});
const beginning=await cut(),cases:unknown[]=[];
const port=await new Promise<number>((yes,no)=>{const server=createServer();server.once("error",no);
 server.listen(0,"127.0.0.1",()=>{const address=server.address();assert(address&&typeof address!=="string");
 server.close(error=>error?no(error):yes(address.port));});});
const password=randomBytes(24).toString("hex");
const database=new EmbeddedPostgres({databaseDir:join(privateDir,"db"),user:"x_phase_owner",password,port,
 persistent:true,onLog:()=>undefined});
const x2=new Set(["0191_frontier5_x2_application_semantics.sql","0192_frontier5_x2_request_custody.sql",
 "0193_frontier5_x2_authority_custody.sql"]);
const bridge="0194_x_phase_charge_phase_union.sql";
const institutionPhases=["ACQUISITION","CHECK","COMPILE","PREPARATION","CONTROL","LIFECYCLE"];
const applicationPhases=["EXECUTION","RECOVERY","HUMAN","ACQUISITION","CHECKING","COMPOSITION","OBSERVATION","MAINTENANCE"];
let started=false,failed=false;
process.env.FINNOR_TEST_MANAGED_EXTENSIONS="omit";
try{
 await database.initialise();await database.start();started=true;
 for(const scenario of ["fresh-directory","populated-x1-bundle","populated-x2-directory"]){
  const name=scenario.replaceAll("-","_");await database.createDatabase(name);
  const url=`postgres://x_phase_owner:${password}@127.0.0.1:${port}/${name}`;
  const client=new pg.Client({connectionString:url});await client.connect();
  try{
   const baseline=scenario==="populated-x1-bundle"?MIGRATIONS.filter(file=>!x2.has(file.name)&&file.name!==bridge)
    :scenario==="populated-x2-directory"?MIGRATIONS.filter(file=>!file.name.includes("_x1_")&&file.name!==bridge):[];
   if(baseline.length)await migrate(url,baseline);
   else await migrate(url);
   const tenant=randomUUID(),principal=randomUUID(),digest=sha({scenario,tenant,principal});
   const reservation="fixture-reservation:"+digest,consumption="fixture-consumption:"+digest;
   await client.query("SET app.test_vertical_mode='explicit'");
   await client.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'Declared upgrade fixture')",[tenant,randomUUID()]);
   await client.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')",[principal,tenant,principal+"@test.invalid"]);
   await client.query("INSERT INTO finnor_os.s5_proposals(tenant_id,principal_id,content_digest,problem,certificate) VALUES($1,$2,$3,$4::jsonb,$4::jsonb)",
    [tenant,principal,digest,JSON.stringify({schema:"finnor.x-phase.synthetic-upgrade-fixture.v1"})]);
   await client.query("INSERT INTO finnor_os.s5_reservation_origins(tenant_id,principal_id,reservation_id,allocation_digest,body) VALUES($1,$2,$3,$4,$5::jsonb)",
    [tenant,principal,reservation,digest,JSON.stringify({schema:"finnor.x-phase.synthetic-upgrade-fixture.v1"})]);
   await client.query("INSERT INTO finnor_os.s5_reservations(tenant_id,reservation_id,allocation_digest,revision,status,envelopes) VALUES($1,$2,$3,1,'RESERVED','[]'::jsonb)",[tenant,reservation,digest]);
   await client.query("INSERT INTO finnor_os.s5_consumptions(tenant_id,principal_id,consumption_id,reservation_id,policy_id,node_id,idempotency_key,request_digest,body) VALUES($1,$2,$3,$4,'fixture','fixture',$3,$5,$6::jsonb)",
    [tenant,principal,consumption,reservation,digest,JSON.stringify({schema:"finnor.x-phase.synthetic-upgrade-fixture.v1"})]);
   const charge=async(key:string,phase:string,institution:boolean)=>client.query(
    "INSERT INTO finnor_os.s5_governed_resource_charges(tenant_id,principal_id,reservation_id,consumption_id,charge_key,phase,resource_id,unit,units,request_digest,body) VALUES($1,$2,$3,$4,$5,$6,'fixture-compute','request',1,$7,$8::jsonb)",
    [tenant,principal,reservation,consumption,key,phase,digest,JSON.stringify({
     schema:institution?"finnor.s5.institution-consumption.v1":"finnor.x-phase.synthetic-upgrade-fixture.v1",
     fixtureOnly:true,nativeCostProof:false})]);
   const originalPhases=scenario==="populated-x1-bundle"?institutionPhases:applicationPhases;
   for(const phase of originalPhases)await charge("before:"+phase,phase,scenario==="populated-x1-bundle");
   const history=async()=>(await client.query("SELECT to_jsonb(c) row FROM finnor_os.s5_governed_resource_charges c WHERE tenant_id=$1 AND charge_key LIKE 'before:%' ORDER BY charge_key",[tenant])).rows;
   const before=await history(),upgrade=await migrate(url,scenario==="populated-x1-bundle"?MIGRATIONS:undefined);
   assert.deepEqual(await history(),before,"ORIGINAL_POPULATED_CHARGE_HISTORY_CHANGED");
   assert.deepEqual(await migrate(url,MIGRATIONS),[],"BUNDLE_REPLAY_MUST_NOT_APPLY_SQL");
   assert.deepEqual(await migrate(url),[],"DIRECTORY_REPLAY_MUST_NOT_APPLY_SQL");
   for(const phase of applicationPhases)await charge("after:application:"+phase,phase,false);
   for(const phase of institutionPhases)await charge("after:institution:"+phase,phase,true);
   const refusals=[];
   for(const [phase,institution] of [["NOT_A_PHASE",true],["CHECK",false],["COMPILE",false],
    ["PREPARATION",false],["CONTROL",false],["LIFECYCLE",false]] as const){
    let error:{code?:string;constraint?:string}|undefined;
    try{await charge("negative:"+phase,phase,institution);}catch(value){error=value as typeof error;}
    assert.equal(error?.code,"23514","INVALID_PHASE_WAS_NOT_REFUSED_BY_CHECK");
    assert.equal(error?.constraint,"s5_governed_resource_charges_phase_check","WRONG_PHASE_REFUSAL_BOUNDARY");
    refusals.push({phase,institution,code:error.code,constraint:error.constraint});
   }
   assert.deepEqual(await history(),before,"ORIGINAL_HISTORY_CHANGED_DURING_NEW_CHARGES");
   const endingCount=(await client.query("SELECT count(*)::int n FROM finnor_os.s5_governed_resource_charges WHERE tenant_id=$1",[tenant])).rows[0].n;
   assert.equal(endingCount,originalPhases.length+applicationPhases.length+institutionPhases.length);
   cases.push({scenario,status:"PASS",baseline:baseline.map(file=>file.name),upgrade,retainedOriginalRows:before.length,
    originalHistoryDigest:sha(before),acceptedApplicationPhases:applicationPhases,acceptedInstitutionPhases:institutionPhases,
    refusals,endingCount,historyFixtureOnly:true,nativeCostProof:false});
  }finally{await client.end();}
 }
}catch(error){
 failed=true;cases.push({status:"FAIL",predicate:error instanceof Error?error.message:"UPGRADE_FAILED"});
}finally{
 await closePool();
 if(started)try{await database.stop();}catch{failed=true;cases.push({status:"FAIL",predicate:"OWNED_DATABASE_STOP_UNPASSED"});}
 const ending=await cut();
 if(sha(beginning)!==sha(ending)){failed=true;cases.push({status:"FAIL",predicate:"SOURCE_CUSTODY_CHANGED"});}
 const report={schema:"finnor.x-phase.peer-upgrade-e2e.v1",status:failed?"FAIL":"PASS",
  qualification:"DISPOSABLE_SQL_STORAGE_AND_HISTORY_NOT_NATIVE_COST_OR_BUSINESS_PROOF",beginning,ending,
  migrationCount:files.length,migrationHead:CURRENT_MIGRATION_HEAD,cases,
  replay:"FINNOR_X_PHASE_UPGRADE_EVIDENCE_DIR=<new-absolute-path> node --import=tsx scripts/x-phase/verify-peer-upgrade.mts"};
 await writeFile(join(out,"results.json"),JSON.stringify(report,null,2)+"\n",{flag:"wx",mode:0o600});
 console.log(JSON.stringify({status:report.status,migrationCount:files.length,cases:cases.length,evidence:out}));
}
// Embedded PostgreSQL's asynchronous exit hook receives an explicit code.
process.exit(failed?1:0);
