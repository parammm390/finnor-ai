/** Previously registered real owner-boundary campaign. Inputs come through
 * actual fitted S3/issued S4/complete S5 owners; fixtures issue no R8 receipts. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,writeFile,appendFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {spawnSync,spawn,type ChildProcess} from 'node:child_process';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import {migrate} from '../../packages/db/migrate';
import {closePool,receiveWork,attachWorkEntity,withTenantTransaction,CURRENT_MIGRATION_HEAD,COMPUTE_CUTOVER_EPOCH} from '@finnor/db';
import {createUpstreamFixtureSupport} from '../s5/owner-fixture.mts';
import {POST} from '../../apps/api/app/api/company-brain/[operation]/route';
import {POST as allocations} from '../../apps/api/app/api/allocations/[operation]/route';
import {POST as interventions} from '../../apps/api/app/api/interventions/[operation]/route';
import {resolveSolverOwners} from '../../packages/private-equity/src/r8/owners';
import {solverRow,readCapsule} from '../../packages/private-equity/src/r8/store';
import {assertCoverage} from '../../packages/epistemic-runtime/src/solver-synthesis/checker';
import {hash} from '../../packages/epistemic-runtime/src/solver-synthesis/contracts';
import {reviewSolver} from './solver-review.mts';
import {mountedSolverFixture} from './browser-fixture.mts';

const output=resolve(process.env.FINNOR_R8_EVIDENCE_DIR!),selected=process.env.FINNOR_R8_CASE_FILTER?.split(',');
const startedAt=new Date().toISOString(),cases:any[]=[],calls:any[]=[],children=new Set<ChildProcess>();
type Termination={code:number|null;signal:NodeJS.Signals|null};
const childClosures=new WeakMap<ChildProcess,Promise<Termination>>();
const save=async(name:string,value:unknown)=>{const path=join(output,name);await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});return path;};
const delay=(ms:number)=>new Promise(yes=>setTimeout(yes,ms));
const originalDeadlineCap=process.env.FINNOR_R8_ORIGINAL_DEADLINE_CAP?Date.parse(process.env.FINNOR_R8_ORIGINAL_DEADLINE_CAP):Date.now()+3600000;
const requestedDeadlineMs=()=>Math.min(3600000,originalDeadlineCap-Date.now()-1000);
async function results(){await save('results.json',{schema:'finnor.r8.owner-e2e.v1',startedAt,finishedAt:new Date().toISOString(),cases,calls,
 runtime:{node:process.version,platform:process.platform,architecture:process.arch,migration:CURRENT_MIGRATION_HEAD},
 selection:selected??'REGISTERED_SUPPORTED_LOCAL_CASES',unmatchedSelection:selected?.filter(id=>!cases.some(c=>c.id===id))??[],
 qualification:'Actual ordinary-role API/SQL/production queue/separate worker/S3/S4/S5 and isolated scientific bytes. Header authentication here is not JWT/hosted or protected qualification.',
 costs:{usd:null,humanSeconds:null,aggregatePeakMemoryBytes:null},rerun:'FINNOR_R8_RUNTIME_MANIFEST=<sealed-runtime> FINNOR_S3_PYTHON=<sealed-python> FINNOR_S5_PYTHON=<sealed-python> python3 finnor-os/scripts/r8/run-local.py'});}
async function challenge(id:string,predicate:string,run:()=>Promise<unknown>){
 if(selected&&!selected.includes(id))return;const start=performance.now();
 try{cases.push({id,predicate,status:'PASS',observed:await run(),elapsedMs:performance.now()-start});}
 catch(error){cases.push({id,predicate,status:'FAIL',observed:{message:String(error),stack:(error as Error).stack},elapsedMs:performance.now()-start});}
 console.log(JSON.stringify(cases.at(-1)));await results();
}
async function api(f:any,operation:string,body:unknown,handler=POST){
 const start=performance.now(),response=await handler(new Request('http://127.0.0.1/api/company-brain/'+operation,{
  method:'POST',headers:{'content-type':'application/json','x-tenant-id':f.tenant,'x-user-id':f.principal},body:JSON.stringify(body),
 }),{params:Promise.resolve({operation})}),data=await response.json();
 calls.push({operation,status:response.status,wallMs:performance.now()-start});return {status:response.status,body:data};
}
function ok(result:any,status=200){assert.equal(result.status,status,JSON.stringify(result));return result.body;}
const directory=await mkdtemp(join(tmpdir(),'finnor-r8-pg-')),port=await new Promise<number>((yes,no)=>{
 const server=createServer();server.once('error',no);server.listen(0,'127.0.0.1',()=>{const address=server.address();
  if(!address||typeof address==='string')return no(Error('PG_PORT'));server.close(()=>yes(address.port));});
});
const postgres=new EmbeddedPostgres({databaseDir:directory,user:'finnor',password:'finnor',port,persistent:false,onLog:()=>undefined});
let admin:pg.Client|undefined,f:any,request:any,accepted:any,capsule:any,worker:ChildProcess|undefined;
let budgetWorkId:string,verifierWorkId:string,contenderWorkId:string;
let workerDatabaseUrl:string|undefined;
let mountedReached=false;
async function workerCustody(){
 const records=admin?(await admin.query("SELECT request_id,category,record_key,body FROM finnor_os.r8_records WHERE category IN ('PROCESS','RESOURCE') ORDER BY created_at,record_key")).rows:[];
 const groups=new Set(records.filter(row=>row.category==='PROCESS').map(row=>Number(row.body.group)));
 const processCensus=spawnSync('ps',['-axo','pid=,ppid=,pgid=,stat=,comm='],{encoding:'utf8'});
 const census=processCensus.stdout.split('\n').filter(line=>groups.has(Number(line.trim().split(/\s+/)[2])));
 const occupancy=admin?(await admin.query("SELECT resource_key,owner_id,fence,lease_expires_at,released_at FROM finnor_os.compute_resource_leases WHERE resource_key='provider:r8-scientific' ORDER BY owner_id,fence")).rows:[];
 return {records,census,censusExit:processCensus.status,occupancy,qualification:'OBSERVED_CUSTODY_NO_FIXTURE_CAPACITY_RELEASE'};
}
async function stopWorker(child:ChildProcess|undefined,name:string){
 if(!child)return;
 const before=await workerCustody().catch(error=>({unavailable:String(error)}));
 const closed=childClosures.get(child)!;
 const wait=(ms:number)=>new Promise<Termination|null>(yes=>{
  const timer=setTimeout(()=>yes(null),ms);closed.then(value=>{clearTimeout(timer);yes(value);});
 });
 let signalError:string|null=null,forced=false;
 try{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');}catch(error){signalError=String(error);}
 let termination=await wait(15000);
 if(!termination){
  forced=true;try{child.kill('SIGKILL');}catch(error){signalError=String(error);}termination=await wait(5000);
 }
 const after=await workerCustody().catch(error=>({unavailable:String(error)}));
 await save('fault/worker-stop-'+name+'.json',{pid:child.pid,before,termination,forced,signalError,after,
  rule:'Test cleanup is not a product physical-close receipt and never releases unknown leases'});
 assert(termination,'OWNED_WORKER_CLOSE_NOT_OBSERVED');
 assert.equal(forced,false,'OWNED_WORKER_GRACEFUL_CLOSE_NOT_OBSERVED');
 assert.equal(signalError,null,'OWNED_WORKER_SIGNAL_REFUSED');
}
async function mounted(){
 mountedReached=true;
 await challenge('mounted-built-authenticated-work','Actual mounted existing Work reaches built authenticated API/SQL/worker and clears private state across reload and Work switches',async()=>{
  assert(capsule);return mountedSolverFixture({fixture:f,request,accepted,output,save,launchWorker});
 });
}
async function launchWorker(){
 const child=spawn(process.execPath,['--import=tsx','scripts/r8/worker-entry.mts'],{env:{...process.env,FINNOR_WORKLOAD_CLASS:'HEAVY',
  DATABASE_URL:workerDatabaseUrl,WORKER_JOB_LEASE_SECONDS:'3'},stdio:['ignore','pipe','pipe']});children.add(child);
 let log='';child.stdout!.on('data',bytes=>{log+=bytes;console.log(bytes.toString().trim());});
 child.stderr!.on('data',bytes=>{log+=bytes;});
 childClosures.set(child,new Promise(yes=>child.once('close',(code,signal)=>yes({code,signal}))));
 child.on('close',()=>{children.delete(child);void writeFile(join(output,'worker-'+child.pid+'.log'),log,{mode:0o600}).catch(error=>console.error(error));});
 for(let n=0;n<150;n++){if(log.includes('"status":"READY"'))return child;if(child.exitCode!==null)throw Error('WORKER_BOOT:'+log);await delay(100);}
 throw Error('WORKER_READINESS_UNOBSERVED:'+log);
}
try{
 await postgres.initialise();await appendFile(join(directory,'postgresql.conf'),'\ntrack_commit_timestamp=on\n');await postgres.start();await postgres.createDatabase('r8_owner');
 const url='postgres://finnor:finnor@127.0.0.1:'+port+'/r8_owner';const migrations=await migrate(url);
 admin=new pg.Client({connectionString:url});await admin.connect();
 await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app';ALTER ROLE finnor_worker LOGIN PASSWORD 'r8_disposable_worker'");
 workerDatabaseUrl='postgres://finnor_worker:r8_disposable_worker@127.0.0.1:'+port+'/r8_owner';
 // The canonical queue refuses preparing cutovers and application-role global
 // discovery. Configure only this disposable database, not a protected release.
 await admin.query("UPDATE finnor_os.compute_plane_cutover SET state='authoritative',accepted_job_epoch=$1,minimum_claim_epoch=$1,enforce_known_job_types=true,legacy_tenant_writes_allowed=false,activated_release_sha=$2,activated_at=clock_timestamp() WHERE singleton=true",
  [COMPUTE_CUTOVER_EPOCH,'4a90ed33ca96afa252c51f511fea279e0034cddb']);
 await admin.query("SET app.test_vertical_mode='explicit'");process.env.DATABASE_URL='postgres://finnor_app:finnor_app@127.0.0.1:'+port+'/r8_owner';await closePool();
 await admin.query("INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,enabled,source) VALUES('provider:r8-scientific',1,1,0,660,true,'Disposable R8 lease exceeds every bounded child lifetime; memory/finance remain unqualified') ON CONFLICT DO NOTHING");
 const generated=spawnSync(process.env.FINNOR_S3_PYTHON!,['scripts/s3/reference.py'],{input:JSON.stringify({operation:'equivalent'}),encoding:'utf8',timeout:30000});
 assert.equal(generated.status,0,generated.stderr);const day=86400000;
 const support=createUpstreamFixtureSupport({admin:()=>admin,generatedRows:JSON.parse(generated.stdout).rows,
  begin:new Date(Math.floor(Date.now()/day)*day-128*day).toISOString(),day,fixtures:{},
  api:(scope:any,operation:string,body:unknown,handler=allocations)=>api(scope,operation,body,handler),artifact:save});
 f=await support.fixture('r8-original-projects',1,[{id:'cash',unit:'USD',capacity:21,totalLimit:21}]);
 f.workId=(await receiveWork({tenantId:f.tenant,userId:f.principal,instruction:'Prepare an exact bounded solver for these three original optional owner projects',
  channel:'console',idempotencyKey:'r8-work'})).workId;
 const deal=await (await import('@finnor/private-equity')).createDeal(f.ctx,{targetOrganizationId:f.root.entityId,
  name:'R8 ordinary mounted owner computation',dealLeadEmployeeId:f.principal,signedLoiAt:new Date(),targetClosingAt:new Date(Date.now()+86400000)});
 f.browserRoot={entityType:'pe_deal',entityId:String(deal.row.id)};
 await attachWorkEntity(f.tenant,f.workId,{...f.browserRoot,relationship:'about',source:'r8-disposable-mounted-owner'});
 await attachWorkEntity(f.tenant,f.workId,{...f.root,relationship:'about',source:'r8-disposable-owner-input'});
 for(const kind of ['budget','verifier','contender']){
  const workId=(await receiveWork({tenantId:f.tenant,userId:f.principal,instruction:'Registered R8 '+kind+' boundary',
   channel:'console',idempotencyKey:'r8-'+kind})).workId;
  await attachWorkEntity(f.tenant,workId,{...f.root,relationship:'about',source:'r8-registered-fault-owner'});
  if(kind==='budget')budgetWorkId=workId;else if(kind==='verifier')verifierWorkId=workId;else contenderWorkId=workId;
 }
 // Work/root membership changes the actual S1 dependency closure. Refit through
 // its owner before issuing policies; never conceal an old belief witness.
 const refitted=ok(await api(f,'fit',{request:f.model.request},interventions));
 assert.equal(refitted.status,'FITTED');f.model=refitted.model;
 for(const [i,cost]of [1,1,1].entries())await support.policy(f,'project-'+i,{cash:cost});
 await support.resource(f,'cash','USD','STOCK',['7','7']);
 request={schema:'finnor.r8.synthesis-request.v1',workId:f.workId,...support.clearing(f,{'project-0':['3'],'project-1':['3'],'project-2':['3']}),
  limits:{deadlineMs:requestedDeadlineMs(),maxRounds:16}};
 await save('inputs.json',{request,policies:f.policies,resources:f.resources,workId:f.workId,migrations});
 await challenge('current-native-owner-projection','Actual issued S3/S4/S5/Work profiles reach lossless all-eight-subset projection with original IDs and ordinary nonbypass role',async()=>{
  const binding=await resolveSolverOwners(f.ctx,request);await save('owner-binding.json',binding);
  assert(binding.projection,JSON.stringify(binding.unsupportedReasons));assert.equal(binding.projection.checks.length,8);
  assert.deepEqual(binding.projection.input,[1,1,1,3,3,3]);
  const role=await withTenantTransaction(f.tenant,{userId:f.principal,readOnly:true},async(_db,c)=>(await c.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]);
  assert.equal(role.rolsuper,false);assert.equal(role.rolbypassrls,false);return {role,projection:binding.projection};
 });
 await challenge('durable-whole-domain-owner-worker','Actual submit/read/API/SQL/queue/separate worker retain genuine failed trials and independently accept all 262144 emitted inputs/2097152 pairs with no business writes',async()=>{
  try{
  accepted=ok(await api(f,'solver-request',request),202);assert.equal(accepted.status,'QUEUED');
  const replay=ok(await api(f,'solver-request',request),202);assert.equal(replay.requestId,accepted.requestId);
  worker=await launchWorker();
  const deadline=Date.now()+1050000;let value:any,killed=false,recovery:any;
  do{value=ok(await api(f,'solver-read',{requestId:accepted.requestId}));
   const chunks=(await admin!.query("SELECT body,digest FROM finnor_os.r8_records WHERE request_id=$1 AND category='CHUNK' ORDER BY created_at",[accepted.requestId])).rows;
   if(!killed&&chunks.length>0&&value.status==='RUNNING'){
    const originalGrant=value.originalGrant,oldPid=worker.pid,records=(await admin!.query(
     "SELECT category,record_key,body,digest FROM finnor_os.r8_records WHERE request_id=$1 ORDER BY created_at",[accepted.requestId])).rows;
    const stopped=new Promise(resolve=>worker!.once('close',(code,signal)=>resolve({code,signal})));
    worker.kill('SIGKILL');const termination=await stopped;killed=true;
    await save('fault/worker-killed-after-accepted-chunk.json',{oldPid,termination,originalGrant,chunks,records});
    worker=await launchWorker();recovery={oldPid,replacementPid:worker.pid,originalGrant,acceptedChunkDigests:chunks.map((chunk:any)=>chunk.digest)};
   }
   if(!['QUEUED','RUNNING'].includes(value.status))break;await delay(2000);
  }while(Date.now()<deadline);
  await save('readback.json',value);
  const durable=(await admin!.query('SELECT category,record_key,digest,body,created_at FROM finnor_os.r8_records WHERE request_id=$1 ORDER BY created_at,record_key',[accepted.requestId])).rows;
  await save('durable-records.json',durable);assert.equal(value.status,'COMPLETE',JSON.stringify(value));
  const row=await solverRow(f.ctx,accepted.requestId);capsule=await readCapsule(f.ctx,row);assert(capsule);assertCoverage(capsule.receipt);
  assert.equal(capsule.receipt.checkedInputs,262144);assert.equal(capsule.receipt.checkedPairs,2097152);
  assert(capsule.counterexamples.length>0);assert(capsule.trials.some((trial:any)=>trial.status==='REJECTED'));
  assert(durable.filter((record:any)=>record.category==='CHUNK').length>=64);
  assert(durable.filter((record:any)=>record.category==='RESOURCE').every((record:any)=>record.body.physicalGroupClosed===true));
  assert.equal((await admin!.query('SELECT count(*)::int n FROM finnor_os.s5_reservations WHERE tenant_id=$1',[f.tenant])).rows[0].n,0);
  assert.equal((await admin!.query('SELECT count(*)::int n FROM finnor_os.business_effects WHERE tenant_id=$1',[f.tenant])).rows[0].n,0);
  assert(killed,'REAL_ACCEPTED_CHUNK_WORKER_DEATH_NOT_REACHED');
  assert.equal(value.originalGrant.id,recovery.originalGrant.id);assert.equal(value.originalGrant.deadline_at,recovery.originalGrant.deadline_at);
  assert.equal(value.originalGrant.attempts_used,2);
  for(const digest of recovery.acceptedChunkDigests)assert(durable.some((record:any)=>record.category==='CHUNK'&&record.digest===digest));
  const optimization=capsule.resources[0].optimization;
  assert.equal(optimization.status,'COMPLETE');assert.equal(optimization.globalCheapestClaim,false);
  await save('fault/unchanged-grant-recovery.json',{recovery,after:value.originalGrant,optimization});
  await save('capsule.json',capsule);return {requestId:row.id,capsuleRef:capsule.ref,receipt:hash(capsule.receipt),workerPid:worker!.pid,recovery,optimization,
   rounds:capsule.trials.length,counterexamples:capsule.counterexamples.length,checkedInputs:262144,checkedPairs:2097152,protected:false};
  }catch(error){await save('fault/durable-acceptance-refusal.json',{message:String(error),stack:(error as Error).stack});throw error;}
  finally{const owned=worker;worker=undefined;await stopWorker(owned,'durable');}
 });
 await challenge('native-fallback-original-grant','Missing separate S8 admission executes strongest original SciPy/HiGHS full route then original independent S5 check inside unchanged Work grant',async()=>{
  assert(accepted);const before=ok(await api(f,'solver-read',{requestId:accepted.requestId}));
  const fallback=ok(await api(f,'solver-selection',{requestId:accepted.requestId}));
  assert.equal(fallback.actualRoute,'SCIPY_HIGHS_ROBUST_MILP');assert.equal(fallback.independentS5.check.objective,'9');assert.equal(fallback.reservation,null);
  const after=ok(await api(f,'solver-read',{requestId:accepted.requestId}));assert.equal(before.originalGrant.deadline_at,after.originalGrant.deadline_at);
  assert(after.records.some((record:any)=>record.category==='FALLBACK'));await save('executed-fallback.json',{before,fallback,after});return fallback;
 });
 await challenge('private-scope-grant-and-compute-contention','Real tenant/principal API refusals, immutable original grant, and occupied aggregate scientific capacity cannot disclose or amplify work',async()=>{
  assert(accepted);const foreign=await support.fixture('r8-foreign-scope',1,[{id:'cash',unit:'USD',capacity:21,totalLimit:21}]);
  const denied=await api(foreign,'solver-read',{requestId:accepted.requestId});assert.equal(denied.status,404);
  assert(!JSON.stringify(denied).includes(accepted.requestId));
  const before=ok(await api(f,'solver-read',{requestId:accepted.requestId}));
  const amplified=ok(await api(f,'solver-request',{...request,idempotencyKey:randomUUID(),limits:{deadlineMs:3600000,maxRounds:16}}),202);
  assert.equal(amplified.originalGrant.id,before.originalGrant.id);
  assert.equal(amplified.originalGrant.deadline_at,before.originalGrant.deadline_at);
  ok(await api(f,'solver-cancel',{requestId:amplified.requestId}));
  const governor=await import('@finnor/db'),leases=await governor.acquireComputeResourceLeases({tenantId:f.tenant,
   ownerId:'registered-r8-contention',workloadClass:'HEAVY',resourceKeys:['provider:r8-scientific'],requiredResourceKeys:['provider:r8-scientific']});
  let refusal='';try{await governor.acquireComputeResourceLeases({tenantId:f.tenant,ownerId:'second-r8-contender',
   workloadClass:'HEAVY',resourceKeys:['provider:r8-scientific'],requiredResourceKeys:['provider:r8-scientific']});}
  catch(error){refusal=String(error);}finally{await governor.releaseComputeResourceLeases(leases,'registered-contention-physical-owner-closed');}
  assert(refusal);const occupancy=(await admin!.query("SELECT owner_id,released_at FROM finnor_os.compute_resource_leases WHERE resource_key='provider:r8-scientific' ORDER BY owner_id,fence")).rows;
  await save('fault/scope-grant-compute-contention.json',{denied,before:before.originalGrant,amplified,refusal,occupancy});return {denied,refusal,originalGrant:before.originalGrant};
 });
 await challenge('verifier-death-and-budget-fallback','A real checker is SIGKILLed and a separate original two-round Work exhausts search; both execute the exact current full S5 route without renewing either grant',async()=>{
  worker=await launchWorker();const observations:any[]=[];
  try{
   for(const fault of ['verifier','budget']){
    const submitted=ok(await api(f,'solver-request',{...request,workId:fault==='verifier'?verifierWorkId:budgetWorkId,
     idempotencyKey:randomUUID(),limits:{deadlineMs:requestedDeadlineMs(),maxRounds:fault==='budget'?2:16}}),202);
    const deadline=Date.now()+180000;let killed:any=null,value:any;
    do{
     if(fault==='verifier'&&!killed){
      const groups=(await admin!.query("SELECT body FROM finnor_os.r8_records WHERE request_id=$1 AND category='PROCESS' AND body->'identity'->'args' @> $2::jsonb ORDER BY created_at DESC",
       [submitted.requestId,JSON.stringify([resolve('packages/epistemic-runtime/src/solver-synthesis/reference.py')])])).rows;
      const census=spawnSync('ps',['-axo','pid=,pgid=,comm='],{encoding:'utf8'});
      for(const group of groups){
       const child=census.stdout.split('\n').map(line=>line.trim().split(/\s+/)).find(parts=>Number(parts[1])===group.body.group&&Number(parts[0])!==group.body.group&&/python/.test(parts[2]??''));
       if(child){process.kill(Number(child[0]),'SIGKILL');killed={pid:Number(child[0]),group:group.body.group,signal:'SIGKILL',census:census.stdout};break;}
      }
     }
     value=ok(await api(f,'solver-read',{requestId:submitted.requestId}));
     if(!['QUEUED','RUNNING'].includes(value.status))break;await delay(fault==='verifier'?20:500);
    }while(Date.now()<deadline);
    if(fault==='verifier')assert(killed,'ACTUAL_CHECKER_DEATH_NOT_REACHED');
    assert(['INCOMPLETE','UNKNOWN'].includes(value.status),JSON.stringify(value));
    assert.equal(value.artifactAvailable,false);
    if(fault==='budget')assert.equal(value.originalGrant.rounds_used,2);
    const before=value.originalGrant,fallback=ok(await api(f,'solver-selection',{requestId:submitted.requestId}));
    assert.equal(fallback.actualRoute,'SCIPY_HIGHS_ROBUST_MILP');assert.equal(fallback.independentS5.check.objective,'9');
    const after=ok(await api(f,'solver-read',{requestId:submitted.requestId})).originalGrant;
    assert.deepEqual(after,before);observations.push({fault,submitted,killed,value,fallback,before,after});
   }
   await save('fault/verifier-death-budget-executed-fallback.json',observations);return observations;
  }finally{const owned=worker;worker=undefined;await stopWorker(owned,'verifier-budget');}
 });
 await challenge('locked-principal-publication-revocation','A real full-domain checker reaches its final accepted chunk, publication blocks on the actual principal, and revocation fences the artifact without erasing the grant or checked children',async()=>{
  assert(capsule);
  const pub=await support.fixture('r8-publication-principal',1,[{id:'cash',unit:'USD',capacity:21,totalLimit:21}]);
  pub.workId=(await receiveWork({tenantId:pub.tenant,userId:pub.principal,instruction:'Registered real publication lock and revocation',channel:'console',idempotencyKey:'r8-publish-fault'})).workId;
  await attachWorkEntity(pub.tenant,pub.workId,{...pub.root,relationship:'about',source:'r8-publication-owner'});
  pub.model=ok(await api(pub,'fit',{request:pub.model.request},interventions)).model;
  for(let i=0;i<3;i++)await support.policy(pub,'project-'+i,{cash:1});
  await support.resource(pub,'cash','USD','STOCK',['7','7']);
  const child=ok(await api(pub,'solver-request',{schema:'finnor.r8.synthesis-request.v1',workId:pub.workId,
   ...support.clearing(pub,{'project-0':['3'],'project-1':['3'],'project-2':['3']}),limits:{deadlineMs:requestedDeadlineMs(),maxRounds:16}}),202);
  const before=child.originalGrant,lock=new pg.Client({connectionString:url});await lock.connect();let locked=false;
  worker=await launchWorker();
  try{
   const deadline=Date.now()+600000;let reached=false;
   while(Date.now()<deadline){
    const retained=(await admin!.query("SELECT 1 FROM finnor_os.r8_records WHERE request_id=$1 AND category='CHUNK' AND body->>'start'='258048'",[child.requestId])).rowCount;
    if(retained){await lock.query('BEGIN');await lock.query('SELECT id FROM finnor_os.users WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[pub.tenant,pub.principal]);locked=true;reached=true;break;}
    await delay(20);
   }
   assert(reached,'FINAL_INDEPENDENT_ACCEPTED_CHUNK_NOT_REACHED');
   const waitUntil=Date.now()+30000;let blocked:any[]=[];
   while(Date.now()<waitUntil){
    blocked=(await admin!.query("SELECT pid,wait_event_type,wait_event,query FROM pg_stat_activity WHERE wait_event_type='Lock' AND (query LIKE '%R8_ACCEPTANCE_PRINCIPAL_FENCE%' OR query LIKE '%R8_CAPSULE_PRINCIPAL_FENCE%') AND pid<>pg_backend_pid()")).rows;
    if(blocked.length)break;await delay(50);
   }
   assert(blocked.length,'ACTUAL_PRINCIPAL_PUBLICATION_LOCK_NOT_REACHED');
   await lock.query("UPDATE finnor_os.users SET status='suspended' WHERE tenant_id=$1 AND id=$2",[pub.tenant,pub.principal]);
   await lock.query('COMMIT');locked=false;
   await delay(1500);
   const rows=(await admin!.query("SELECT id,status,failure,capsule_digest FROM finnor_os.r8_requests WHERE id=ANY($1::uuid[])",[[accepted.requestId,child.requestId]])).rows;
   const count=(await admin!.query("SELECT count(*)::int n FROM finnor_os.r8_records WHERE request_id=$1 AND category='CAPSULE'",[child.requestId])).rows[0].n;
   const after=(await admin!.query("SELECT * FROM finnor_os.r8_grants WHERE id=$1",[before.id])).rows[0];
   assert.equal(count,0);assert.equal(new Date(after.deadline_at).toISOString(),before.deadline_at);
   assert(rows.find((row:any)=>row.id===accepted.requestId).capsule_digest);
   await save('fault/locked-principal-publication-revocation.json',{child,before,after,blocked,rows,newCapsules:count});
   return {newCapsules:count,originalArtifactRetained:true,blockedPublicationPids:blocked.map(row=>row.pid),originalGrantId:before.id};
  }finally{
   if(locked)await lock.query('ROLLBACK');await lock.end();
   const owned=worker;worker=undefined;await stopWorker(owned,'publication');
  }
 });
 await challenge('separated-s8-full-review-reuse-revoke','Separate actual ordinary S8 owner executes full D, then distinct evaluator/promoter admission, emitted S5 reuse, restart and revocation cause executed original native fallback',async()=>{
  assert(capsule,'ACCEPTED_CAPSULE_PREREQUISITE');
  return reviewSolver({capsule,tenant:f.tenant,principal:f.principal,rights:'s5-owner-rights',save,
   select:async()=>ok(await api(f,'solver-selection',{requestId:accepted.requestId})),
   native:async()=>ok(await api(f,'solver-native-comparison',{requestId:accepted.requestId})),
   whileActive:mounted});
 });
 if(!mountedReached)await mounted();
 await challenge('source-resource-invalidation','Actual owner resource change invalidates the Work use without replacing the abstract semantic theorem or erasing incurred work',async()=>{
  assert(capsule);const theorem=hash(capsule.receipt);
  const before=ok(await api(f,'solver-read',{requestId:accepted.requestId}));assert.equal(before.status,'COMPLETE');assert.equal(before.artifactAvailable,true);
  const {ref:expectedRef,revision,priorRef,...original}=f.resources[0];
  const updated={...original,availability:original.availability.map((entry:any)=>({...entry,amount:'6'}))};
  const resource=ok(await api(f,'resource',{resource:updated,expectedRef},allocations));
  try{
   const readback=ok(await api(f,'resources',{},allocations)).resources.find((row:any)=>row.resourceId===original.resourceId);
   assert.deepEqual(readback.ref,resource.ref);assert.notDeepEqual(readback.ref,expectedRef);
   assert(readback.availability.every((entry:any)=>entry.amount==='6'));
   const stale=await api(f,'solver-selection',{requestId:accepted.requestId});assert.notEqual(stale.status,200);
   assert.equal(hash(capsule.receipt),theorem);
   const count=(await admin!.query("SELECT count(*)::int n FROM finnor_os.r8_records WHERE request_id=$1 AND category='CAPSULE'",[accepted.requestId])).rows[0].n;
   const afterGrant=(await admin!.query('SELECT id,deadline_at,max_rounds,rounds_used,attempts_used FROM finnor_os.r8_grants WHERE id=$1',[before.originalGrant.id])).rows[0];
   assert.equal(new Date(afterGrant.deadline_at).toISOString(),before.originalGrant.deadline_at);
   assert.equal(afterGrant.rounds_used,before.originalGrant.rounds_used);assert.equal(afterGrant.attempts_used,before.originalGrant.attempts_used);
   assert.equal(count,1);await save('fault/resource-invalidation.json',{before,expectedRef,updated,resource,readback,stale,theorem,count,afterGrant});
   return {staleStatus:stale.status,originalTheoremRetained:true};
  }finally{
   const restored=ok(await api(f,'resource',{resource:original,expectedRef:resource.ref},allocations));
   f.resources=f.resources.map((row:any)=>row.resourceId===restored.resourceId?restored:row);
   await save('fault/resource-restoration-new-owner-revision.json',{restored,
    rule:'Restoring availability creates a new revision; it does not make the old capsule current'});
  }
 });
 await challenge('two-work-capital-and-unknown-responsibility','Two actual Works share one canonical S5 capacity; concurrent reservations remain bounded and UNKNOWN consumption cannot be hidden by a capsule or release',async()=>{
  assert(capsule);
  const currentRequest={...request,resourceRefs:f.resources.map((row:any)=>row.ref)};
  const contender=ok(await api(f,'solver-request',{...currentRequest,workId:contenderWorkId,idempotencyKey:randomUUID()}),202);
  assert.equal(contender.status,'QUEUED');ok(await api(f,'solver-cancel',{requestId:contender.requestId}));
 const originalPolicies=[...f.policies];
 const contenderPolicies=[];for(let i=0;i<3;i++)contenderPolicies.push(await support.policy(f,'contender-'+i,{cash:1}));
 const base={...currentRequest};delete (base as any).schema;delete (base as any).workId;delete (base as any).limits;
 const other=support.clearing(f,{'contender-0':['3'],'contender-1':['3'],'contender-2':['3']},[],[],contenderPolicies);
 const inputs=[base,other];
 const workIds=[f.workId,contenderWorkId];
 const attempts=await Promise.all(inputs.map((input,index)=>api(f,'clear',{...input,idempotencyKey:'r8-capital-work-'+workIds[index]},allocations)));
  const successful=attempts.filter(result=>result.status===200&&result.body.reservation);
  for(let i=successful.length;i<2;i++){
   const missing=inputs.find(input=>!successful.some(result=>result.body.certificate.check.selectedPolicyIds.some((id:string)=>input.policyRefs.some((ref:any)=>ref.id===id))));
   assert(missing,'DISJOINT_WORK_POLICY_SET_NOT_IDENTIFIED');
   const next=ok(await api(f,'clear',{...missing,idempotencyKey:'r8-capital-retry-'+i},allocations));assert(next.reservation);successful.push({status:200,body:next});
  }
 const held=(await admin!.query("SELECT reservation_id AS id,status,envelopes FROM finnor_os.s5_reservations WHERE tenant_id=$1 ORDER BY reservation_id",[f.tenant])).rows;
  const total=held.reduce((sum:number,row:any)=>sum+Number(row.envelopes.find((entry:any)=>entry.resourceId==='cash').quantities[0]),0);
  assert.equal(total,6);assert(total<=7);assert.equal(held.length,2);
  const stale=await api(f,'solver-selection',{requestId:accepted.requestId});assert.notEqual(stale.status,200);
 const spare=[];for(let i=0;i<3;i++)spare.push(await support.policy(f,'spare-'+i,{cash:1}));
 const remaining=support.clearing(f,{'spare-0':['3'],'spare-1':['3'],'spare-2':['3']},[],[],spare);
 const unsupported=ok(await api(f,'solver-request',{...request,...remaining,workId:contenderWorkId,idempotencyKey:randomUUID()}),202);
  assert.equal(unsupported.status,'UNSUPPORTED');const before=unsupported.originalGrant;
  const fallback=ok(await api(f,'solver-selection',{requestId:unsupported.requestId}));
  assert.equal(fallback.actualRoute,'SCIPY_HIGHS_ROBUST_MILP');assert.equal(fallback.independentS5.check.objective,'3');
  assert.deepEqual(ok(await api(f,'solver-read',{requestId:unsupported.requestId})).originalGrant,before);
  assert(successful[0],'ACTUAL_RESERVATION_PREREQUISITE');
  const first=successful[0].body,policy=f.policies.find((policy:any)=>policy.ref.id===first.certificate.check.selectedPolicyIds[0]);
  assert(policy,'ACTUAL_SELECTED_POLICY_PREREQUISITE');const policyRef=policy.ref;
  const consumed=ok(await api(f,'consume',{allocationRef:first.certificate.ref,policyRef,
   decision:{knowledgeAt:new Date().toISOString(),period:0,actionHistory:[],observations:[],rightsRef:f.mandate.rightsRef,obligations:[],allocationRefs:[first.certificate.ref]},
   idempotencyKey:'r8-unknown-responsibility'},allocations));
  const unknown=ok(await api(f,'reconcile',{allocationRef:first.certificate.ref},allocations));assert.equal(unknown.reservation.status,'UNKNOWN_OUTCOME');
  const release=await api(f,'release',{allocationRef:first.certificate.ref,idempotencyKey:'r8-must-not-clear-unknown'},allocations);assert.notEqual(release.status,200);
  const refused=await api(f,'solver-selection',{requestId:unsupported.requestId});assert.notEqual(refused.status,200);
 await save('fault/two-work-capital-unknown.json',{workIds,originalPolicies:originalPolicies.map((policy:any)=>policy.ref),contenderPolicies:contenderPolicies.map(policy=>policy.ref),sparePolicies:spare.map(policy=>policy.ref),attempts,successful,held,total,stale,unsupported,fallback,consumed,unknown,release,refused});
  return {heldCapital:total,capacity:7,reservations:2,unsupportedFallbackExecuted:true,unknownStatus:unknown.reservation.status,noPhysicalBusinessAttempt:true};
 });
 await results();
}catch(error){cases.push({id:'actual-setup',status:'FAIL',observed:{message:String(error),stack:(error as Error).stack}});await results();throw error;}
finally{
 const cleanup=await Promise.allSettled([...children].map(child=>stopWorker(child,'final-'+child.pid)));
 await save('fault/final-owned-worker-cleanup.json',cleanup.map(result=>result.status==='fulfilled'?{status:result.status}:{status:result.status,reason:String(result.reason)}));
 if(cleanup.some(result=>result.status==='rejected'))process.exitCode=1;
 await closePool();await admin?.end();await postgres.stop();
}
if(!cases.length||cases.some(c=>c.status!=='PASS')||selected?.some(id=>!cases.some(c=>c.id===id)))process.exitCode=1;
