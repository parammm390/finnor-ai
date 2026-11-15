/** Failure-first physical recovery. Runner supplies existing disposable databases. */
import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile,appendFile} from 'node:fs/promises';
import {join,resolve,isAbsolute} from 'node:path';
import pg from 'pg';
import {closePool,getPool} from '@finnor/db';
import {currentCodeIdentity,codeIdentity} from '../../packages/private-equity/src/evidence-execution/store';
import {prepareNativeOwnerFixture} from './native-stories.mjs';
import {nativeHttpFixture} from '../p7/native-http-fixture.mjs';
import {recoveryWorker} from './recovery-worker.mjs';
import {recoveryCut} from './recovery-observe.mjs';
import {originalRequest} from './original-recovery-request.mjs';

const repo=resolve(import.meta.dirname,'../../..'),destination=process.env.FINNOR_W1_RECOVERY_EVIDENCE??'';
assert(destination&&isAbsolute(destination),'ABSOLUTE_NEW_EVIDENCE_DIRECTORY_REQUIRED');
assert(['broken','repaired'].includes(process.env.FINNOR_W1_RECOVERY_PHASE??''),'EXPLICIT_FROZEN_PHASE_REQUIRED');
assert(['A','B'].includes(process.env.FINNOR_W1_RECOVERY_TRACK??''),'RUNNER_BOUNDED_TRACK_REQUIRED');
const pause=(ms:number)=>new Promise<void>(yes=>setTimeout(yes,ms));
const initialIdentity=await codeIdentity();
assert.equal(initialIdentity.digest,(await currentCodeIdentity()).digest);
const record:any={schema:'finnor.w1.physical-recovery.v2',phase:process.env.FINNOR_W1_RECOVERY_PHASE,
 startedAt:new Date().toISOString(),productionIdentity:initialIdentity,node:{executable:process.execPath,version:process.version,pid:process.pid,parentPid:process.ppid},
 limits:{observerMs:120000,runnerMs:300000,originalBusinessDeadlineMs:300000},cases:[],
 nativeOracle:{status:'NOT_APPLICABLE',reason:'Original no-fit fixtures; no CONTROL_W1 or positive capsule consumption. Existing positive native oracle remains unchanged.'},
 qualification:'DISPOSABLE_LOCAL_RECOVERY_ONLY',protectedAdmission:false,productionActivated:false,authorityGranted:false,
 billingUSD:null,completeChildUsage:null};
const save=()=>writeFile(join(destination,'observations.json'),JSON.stringify(record,null,2)+'\n',{mode:0o600});
await save();

function databaseUrls(track:'A'|'B'){
 const keys=['ADMIN','APP','WORKER'] as const;
 const urls=keys.map(role=>{
  const raw=process.env['FINNOR_W1_RECOVERY_'+track+'_'+role+'_URL'];
  assert(raw,'RUNNER_EXISTING_DATABASE_URL_REQUIRED:'+track+':'+role);
  const u=new URL(raw);
  assert(['postgres:','postgresql:'].includes(u.protocol)&&['127.0.0.1','localhost','[::1]'].includes(u.hostname),
   'EXPLICIT_LOOPBACK_DATABASE_REQUIRED');
  assert(!u.searchParams.has('host')&&!u.searchParams.has('hostaddr')&&!u.searchParams.has('service'),
   'DATABASE_TARGET_OVERRIDE_FORBIDDEN');
  if(role!=='ADMIN')assert.equal(u.username,role==='APP'?'finnor_app':'finnor_worker');
  return {raw,url:u};
 });
 const [admin,app,worker]=urls;
 assert(admin&&app&&worker,'THREE_ORIGINAL_DATABASE_URLS_REQUIRED');
 const target=(u:URL)=>u.hostname+':'+(u.port||'5432')+u.pathname;
 assert(urls.every(u=>target(u.url)===target(admin.url)),'ONE_ORIGINAL_DATABASE_PER_CASE_REQUIRED');
 return {admin:admin.raw,app:app.raw,worker:worker.raw,target:target(admin.url)};
}
const aUrls=databaseUrls('A'),bUrls=databaseUrls('B');
assert.notEqual(aUrls.target,bUrls.target,'TRACK_B_NEEDS_A_SEPARATE_DISPOSABLE_DATABASE');

async function register(queue:any,p2:boolean){
 const contracts=(await import('../../packages/db/compute-contract')).PRODUCTION_JOB_CONTRACTS;
 if(!p2){
  queue.register('run_harness_program_v1',(await import('../../packages/private-equity/src/program-synthesis/worker')).runHarnessProgramJob,contracts.run_harness_program_v1);
  queue.register('run_evidence_derivation_v1',(await import('../../packages/private-equity/src/evidence-execution/worker')).runEvidenceDerivationJob,contracts.run_evidence_derivation_v1);
 }else queue.register('run_compute_search_unit_v1',(await import('../../packages/private-equity/src/compute-search/worker')).runComputeSearchUnitJob,contracts.run_compute_search_unit_v1);
}

async function runCase(track:'A'|'B',urls:ReturnType<typeof databaseUrls>){
 const dir=join(destination,track),start=performance.now(),usageStart=process.resourceUsage(),end=start+120000;
 await mkdir(dir,{recursive:false});
 const c:any={track,node:record.node,startedAt:new Date().toISOString(),cuts:[],calls:[],workers:[],status:'IN_PROGRESS',
  limits:{observerMs:120000,originalBusinessDeadlineMs:300000},engineering:{costUSD:null,completeChildUsage:null}};
 record.cases.push(c);await save();
 let admin:pg.Client|undefined,holder:pg.Client|undefined,http:Awaited<ReturnType<typeof nativeHttpFixture>>|undefined;
 let fixture:any=null,searchId:string|undefined;
 const queues:Array<Awaited<ReturnType<typeof recoveryWorker>>>=[];
 const checkBound=()=>assert(performance.now()<end,'OBSERVER_120S_BOUND');
 const checkpoint=async(label:string)=>{
  assert(admin&&fixture&&searchId,'ORIGINAL_FIXTURE_CUSTODY_REQUIRED');checkBound();
  const cut=await recoveryCut(admin,fixture.p.programId,searchId,label,dir);c.cuts.push(cut);await save();return cut;
 };
 const makeQueue=async(label:string)=>{
  checkBound();const q=await recoveryWorker(urls.worker,dir,track+':'+label,end);queues.push(q);
  c.workers.push({label,pid:q.pid,identity:q.identity,applicationName:q.applicationName,trace:'worker-'+q.pid+'.jsonl'});
  await save();return q;
 };
 const waitFor=async(predicate:()=>Promise<boolean>,name:string,localMs=12000)=>{
  const deadline=Math.min(end,performance.now()+localMs);
  while(performance.now()<deadline){if(await predicate())return;await pause(75);}
  throw Error(name);
 };
 try{
  await closePool();
  process.env.DATABASE_URL=urls.app;process.env.FINNOR_P2_WORKER_DATABASE_URL=urls.worker;
  process.env.AUTH_DEV_BYPASS='1';process.env.NODE_ENV='test';process.env.FINNOR_P4_PROFILE='ordinary_disposable';
  process.env.FINNOR_TEST_MANAGED_EXTENSIONS='omit';
  process.env.FINNOR_M1_PROFILE='DISPOSABLE_NATIVE';
  process.env.FINNOR_M1_STORE=join(dir,'m1-store');process.env.FINNOR_S3_MODEL_STORE=join(dir,'s3-store');
  process.env.FINNOR_S4_POLICY_STORE=join(dir,'s4-store');
  admin=new pg.Client({connectionString:urls.admin,application_name:'w1-recovery-observer-'+track,statement_timeout:5000});
  await admin.connect();await admin.query("SET app.test_vertical_mode='explicit'");
  const empty=(await admin.query(`SELECT (SELECT count(*)::int FROM finnor_os.p1_requests) parents,
   (SELECT count(*)::int FROM finnor_os.jobs WHERE status IN('queued','running')) live_jobs`)).rows[0];
  assert.equal(empty.parents,0,'FRESH_ALREADY_MIGRATED_FIXTURE_REQUIRED');assert.equal(empty.live_jobs,0,'DEDICATED_DISPOSABLE_DATABASE_REQUIRED');
  const policies=(await admin.query("SELECT * FROM finnor_os.compute_resource_policies WHERE resource_key IN('native:p2','native:p4') ORDER BY resource_key")).rows;
  assert.equal(policies.length,2,'RUNNER_EXISTING_NATIVE_CAPACITY_POLICIES_REQUIRED');
  assert(policies.every(p=>p.capacity>=1&&p.per_tenant_capacity>=1),'RUNNER_NATIVE_CAPACITY_REQUIRED');
  assert.equal(policies.find(p=>p.resource_key==='native:p2')?.lease_seconds,60,'ORIGINAL_60S_PHYSICAL_LEASE_POLICY_REQUIRED');
  const app=(await getPool().query(`SELECT current_user role,rolsuper,rolbypassrls,
   pg_has_role('finnor_app','finnor_worker','MEMBER') app_inherits_worker FROM pg_roles WHERE rolname=current_user`)).rows[0];
  assert.equal(app.role,'finnor_app');assert(!app.rolsuper&&!app.rolbypassrls&&!app.app_inherits_worker);
  c.boundaries={app,policies,setupBypass:'1',scoredBypass:'0'};
  const stage=await makeQueue('P1-P4-stage');await register(stage,false);
  const post=(await import('../../apps/api/app/api/company-brain/[operation]/route')).POST;
  const api=async(operation:string,body:any,identity?:{tenant:string;actor:string})=>{
   assert(identity,'SETUP_IDENTITY_REQUIRED');
   const response=await post(new Request('http://localhost/api/company-brain/'+operation,{method:'POST',
    headers:{'content-type':'application/json','x-tenant-id':identity.tenant,'x-user-id':identity.actor},body:JSON.stringify(body)}),
    {params:Promise.resolve({operation})});
   return {status:response.status,body:await response.json()};
  };
  const foreign=randomUUID();
  fixture=await prepareNativeOwnerFixture({admin,queue:stage,evidence:dir,repo,api,request:originalRequest,
   periodStart:'2025-01-01T00:00:00.000Z',periodEnd:'2025-12-31T00:00:00.000Z',validAt:'2026-01-01T00:00:00.000Z'},{
   beforeFit:async owner=>{await admin!.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')",
    [foreign,owner.tenant,foreign+'@physical-recovery.invalid']);},
  });
  checkBound();http=await nativeHttpFixture(admin,fixture.f.tenant,fixture.f.principal,foreign);
  assert.equal(process.env.AUTH_DEV_BYPASS,'0');
  const call=async(operation:string,body:any,identity:'actor'|'other'|'anonymous'='actor')=>{
   checkBound();assert.equal(process.env.AUTH_DEV_BYPASS,'0');
   const before=performance.now(),startedAt=new Date().toISOString();
   const result=await http!.call(operation,body,identity);
   const receipt={operation,identity,startedAt,completedAt:new Date().toISOString(),wallMs:performance.now()-before,...result};
   c.calls.push(receipt);await appendFile(join(dir,'http-calls.jsonl'),JSON.stringify(receipt)+'\n',{mode:0o600});await save();return result;
  };
  const anonymous=await call('economic-orchestration-projection',{root:fixture.f.root,workId:fixture.p.workId},'anonymous');
  assert.equal(anonymous.status,401);
  const accepted=await call('economic-orchestration-submit',{...fixture.search,schema:'finnor.economic-orchestration-request.v1',
   orchestration:{schema:'finnor.economic-orchestration-options.v1',purposeRef:'physical-recovery-'+track,
    populationRef:'original-Work-only',domainRef:'P1_LIABILITY_ARITHMETIC',responseRef:null,observationSplit:'TRAIN'}});
  assert.equal(accepted.status,202,JSON.stringify(accepted));searchId=(accepted.body as any).searchId;assert(searchId);
  const foreignResponse=await call('economic-orchestration-read',{searchId},'other');assert.equal(foreignResponse.status,404);
  c.auth={bypass:false,anonymousStatus:anonymous.status,foreignStatus:foreignResponse.status};
  for(let decision=0;decision<40;decision++){
   checkBound();const ready=(await admin.query(`SELECT context FROM finnor_os.p2_requests s WHERE id=$1
    AND EXISTS(SELECT 1 FROM finnor_os.jobs j WHERE j.payload->>'searchId'=s.id::text
    AND j.type='run_compute_search_unit_v1' AND j.protocol_version=3 AND j.status='queued')`,[searchId])).rows[0];
   if(ready?.context)break;
   const ran=await stage.tick();await pause(ran?25:2050);
  }
  await stage.close();
  const selected=await checkpoint('selected');
  const selectedJobs=selected.jobs.filter((j:any)=>j.type==='run_compute_search_unit_v1'&&j.status==='queued');
  assert.equal(selectedJobs.length,1,'ONE_ORIGINAL_NO_FIT_FALLBACK_REQUIRED');
  const job=selectedJobs[0],unit=selected.units.find((u:any)=>u.id===job.payload.unitId);
  assert(unit&&unit.kind==='EXECUTE_P1'&&unit.status==='QUEUED');
  assert.equal(job.protocol_version,3);assert.equal(selected.attempts.length,0);assert.equal(selected.capsules.length,0);
  assert.equal(selected.search.request.orchestration.responseRef,null);
  assert.equal(job.idempotency_key,`p2:${searchId}:${unit.generation}:${unit.id}:admission:${unit.attempts}:w1-plan:${job.payload.w1SelectionGroupRef}`);
  assert(/^[0-9a-f]{64}$/.test(job.payload.w1SelectionGroupRef),'ORIGINAL_SELECTION_GROUP_REQUIRED');
  c.original={programId:fixture.p.programId,searchId,unitId:unit.id,jobId:job.id,admissionCount:unit.attempts,
   generation:unit.generation,selectionGroupRef:job.payload.w1SelectionGroupRef,workId:selected.parent.work_id,
   workInputId:selected.parent.work_input_id,episodeId:selected.episode.id,deadlineAt:selected.episode.deadline_at,
   grant:selected.search.request.computeGrant};
  holder=new pg.Client({connectionString:urls.admin,application_name:'w1-recovery-holder-'+track,statement_timeout:5000});
  await holder.connect();await holder.query('BEGIN');
  const holderPid=(await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  if(track==='A')await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['s5-portfolio:'+fixture.f.tenant]);
  else await holder.query('LOCK TABLE finnor_os.p1_events IN SHARE MODE');
  c.gate={holderPid,kind:track==='A'?'EXISTING_S5_PORTFOLIO_ADVISORY':'P1_EVENTS_SHARE_LOCK',heldAt:new Date().toISOString()};
  const victim=await makeQueue('victim');await register(victim,true);
  const tick=victim.tick().then(value=>({ok:true,value}),error=>({ok:false,error:String(error)}));
  await waitFor(async()=>{
   const waits=(await admin!.query(`SELECT pid,wait_event_type,pg_blocking_pids(pid) blockers,query
    FROM pg_stat_activity WHERE application_name=$1 AND usename='finnor_worker' AND wait_event_type='Lock'`,[victim.applicationName])).rows;
   const waiting=waits.some(w=>w.blockers.includes(holderPid)&&
    (track==='A'?w.query.includes('pg_advisory_xact_lock'):w.query.includes('INSERT INTO finnor_os.p1_events')));
   if(!waiting)return false;
   const durable=(await admin!.query(`SELECT j.status job_status,u.status unit_status,
    (SELECT count(*)::int FROM finnor_os.p2_attempts a WHERE a.search_id=u.search_id) physical_attempts,
    (SELECT count(*)::int FROM finnor_os.p2_attempts a WHERE a.unit_id=u.id AND a.status='SUBMITTED') submitted
    FROM finnor_os.jobs j JOIN finnor_os.p2_units u ON u.id=$2 WHERE j.id=$1`,[job.id,unit.id])).rows[0];
   return durable?.job_status==='running'&&(track==='A'?durable.unit_status==='QUEUED'&&durable.physical_attempts===0:
    durable.unit_status==='RUNNING'&&durable.physical_attempts===1&&durable.submitted===1);
  },'REAL_PHYSICAL_CONTENTION_CUT_NOT_REACHED');
  const contended=await checkpoint('contended');
  c.victimPid=victim.pid;c.kill=await victim.killExact();c.victimTick=await tick;
  await checkpoint('killed');
  await holder.query('ROLLBACK');c.gate.releasedAt=new Date().toISOString();await holder.end();holder=undefined;
  await waitFor(async()=>Number((await admin!.query('SELECT count(*) n FROM pg_stat_activity WHERE application_name=$1',[victim.applicationName])).rows[0].n)===0,
   'KILLED_WORKER_DATABASE_CONNECTIONS_DID_NOT_EXIT',5000);
  await checkpoint('released');
  const replacement=await makeQueue('replacement');assert.notEqual(replacement.pid,victim.pid);c.replacementPid=replacement.pid;
  await register(replacement,true);if(track==='A')await register(replacement,false);
  await waitFor(async()=>{
   const row=(await admin!.query("SELECT status,lease_expires_at<=clock_timestamp() expired FROM finnor_os.jobs WHERE id=$1",[job.id])).rows[0];
   assert.equal(row.status,'running','ONLY_CANONICAL_RECOVERY_MAY_CHANGE_ORIGINAL_RUNNING_JOB');return row.expired===true;
  },'ORIGINAL_QUEUE_LEASE_DID_NOT_EXPIRE_NATURALLY');
  await checkpoint('lease-expired');
  c.canonicalRecoveryCount=await replacement.recoverExpiredRunningJobs();
  await checkpoint('queue-recovered');
  const reconciled=await call('economic-orchestration-reconcile',{searchId});assert.equal(reconciled.status,200,JSON.stringify(reconciled));
  const reconciledCut=await checkpoint('reconciled');
  if(track==='A'){
   const current=reconciledCut.units.find((u:any)=>u.id===unit.id);
   if(current?.status==='QUEUED'){
    // Do not manufacture progress to hide the registered baseline failure.
    c.status='RECORDED_PRE_ADMISSION_STUCK';await checkpoint('final');
   }else{
    assert.equal(current?.status,'FAILED','TRUTHFUL_PRE_ADMISSION_FAILURE_REQUIRED');
    for(let decision=0;decision<96;decision++){
     checkBound();const status=(await admin.query('SELECT status FROM finnor_os.p1_requests WHERE id=$1',[fixture.p.programId])).rows[0].status;
     if(status==='TESTED')break;
     assert(!['FAILED','INVALIDATED','CANCELLED','PARTIAL'].includes(status),'ORIGINAL_P1_FAILED:'+status);
     const ran=await replacement.tick();await pause(ran?25:2050);
    }
    const read=await call('program-read',{programId:fixture.p.programId});assert.equal(read.status,200,JSON.stringify(read));
    c.programRead=read;assert.equal((read.body as any).status,'TESTED','ORIGINAL_P1_TESTED_REQUIRED');
    c.ownerRead=await call('economic-orchestration-read',{searchId});assert.equal(c.ownerRead.status,200);
    await checkpoint('final');c.status='RECORDED_RECOVERED';
   }
  }else{
   assert.equal(contended.attempts.length,1);
   c.physicalOutcome='MAY_HAVE_EXECUTED';
   assert.equal(reconciledCut.attempts[0]?.status,'UNKNOWN','SUBMITTED_MUST_NOT_BECOME_PROVEN_ABSENT');
   const resumed=await call('economic-orchestration-resume',{searchId});assert.equal(resumed.status,202,JSON.stringify(resumed));
   c.resumeTick=await replacement.tick();await checkpoint('resumed');
   const cancelled=await call('economic-orchestration-cancel',{searchId});assert.equal(cancelled.status,200,JSON.stringify(cancelled));
   await checkpoint('cancelled');
   const refused=await call('economic-orchestration-resume',{searchId});assert.equal(refused.status,422,JSON.stringify(refused));
   c.afterCancelTick=await replacement.tick();await checkpoint('resume-refused');
   await waitFor(async()=>Number((await admin!.query(`SELECT count(*) n FROM finnor_os.compute_resource_leases
    WHERE tenant_key=$1 AND released_at IS NULL AND expires_at>clock_timestamp()`,[fixture.f.tenant])).rows[0].n)===0,
    'ORIGINAL_PHYSICAL_LEASE_DID_NOT_EXPIRE_NATURALLY',65000);
   await checkpoint('physical-leases-expired');
   c.lateRecoveryCount=await replacement.recoverExpiredRunningJobs();
   const late=await call('economic-orchestration-reconcile',{searchId});assert.equal(late.status,200);
   c.lateTick=await replacement.tick();await checkpoint('final');c.status='RECORDED_UNKNOWN_RETAINED';
  }
  assert.equal((await codeIdentity()).digest,initialIdentity.digest);checkBound();
 }catch(error){
  c.status='DRIVER_FAILED';c.error={message:String(error),stack:(error as Error).stack};
  if(admin&&fixture&&searchId)try{const cut=await recoveryCut(admin,fixture.p.programId,searchId,'failure',dir);c.cuts.push(cut);}
   catch(observerError){c.observerError=String(observerError);}
 }finally{
  if(holder){try{await holder.query('ROLLBACK');await holder.end();}catch(error){c.cleanupError=String(error);}}
  for(const queue of queues.reverse())try{await queue.close();}catch(error){c.cleanupError=String(error);}
  if(http)try{c.httpObservations=http.observed;await http.close();}catch(error){c.cleanupError=String(error);}
  try{await closePool();await admin?.end();}catch(error){c.cleanupError=String(error);}
  c.engineering={wallMs:performance.now()-start,rootResourceUsage:process.resourceUsage(),rootUsageBefore:usageStart,
   additiveWithWorkerIntervals:false,costUSD:null,completeChildUsage:null,killedDeliveryRetained:true};
  c.completedAt=new Date().toISOString();await save();
 }
}
if(process.env.FINNOR_W1_RECOVERY_TRACK==='A')await runCase('A',aUrls);
else await runCase('B',bUrls);
try{record.finalProductionIdentity=await codeIdentity();assert.equal(record.finalProductionIdentity.digest,initialIdentity.digest);}
catch(error){record.freezeFailure=String(error);}
record.network=(globalThis as any).__FINNOR_W1_READ_NETWORK_METER??null;
record.completedAt=new Date().toISOString();await save();
process.exitCode=record.freezeFailure||record.cases.some((c:any)=>c.status==='DRIVER_FAILED'||c.cleanupError)?2:0;
