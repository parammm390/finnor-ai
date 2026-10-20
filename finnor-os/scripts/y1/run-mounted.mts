/** Disposable mounted Work proof. Only native business inputs, signed local
 * auth, real emitted routes and ordinary createWorker ticks are permitted. */
import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdir,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {configureTenantVertical,createEmployeeConversationThread,updateEmployeeConversationThreadContext,receiveWork,closePool,isImmutableWorkStatus} from '@finnor/db';
import {startEnvironment,artifact,repo,hash} from '../x3/environment.mts';
import {startMountedFrontend} from '../x3/mounted-fixture.mts';
import {publicProblem,bindCanonicalInputs,resourceInput} from './business-fixtures.mts';

assert(process.env.FINNOR_Y1_EVIDENCE_DIR,'EXPLICIT_Y1_MOUNTED_EVIDENCE_REQUIRED');
const evidence=resolve(process.env.FINNOR_Y1_EVIDENCE_DIR);
await mkdir(evidence,{recursive:true});
process.env.FINNOR_Y1_PROFILE='ordinary_disposable';
const runtime=JSON.parse(await readFile(join(repo,'finnor-os/dist-y1/manifest.json'),'utf8'));
assert.equal(hash(await readFile(join(repo,'finnor-os/dist-y1/worker-loop.mjs'))),runtime.worker.sha256);
process.env.FINNOR_Y1_ASSET_ROOT=join(repo,'finnor-os/dist-y1',runtime.assetRoot);
const e=await startEnvironment(evidence,{builtApi:true,baseHead:'0194_x_phase_charge_phase_union.sql'});
const tenant=randomUUID(),principal=randomUUID(),peer=randomUUID(),root={entityType:'external_organization',entityId:randomUUID()};
let mounted:Awaited<ReturnType<typeof startMountedFrontend>>|undefined,child:ChildProcess|undefined,sequence=0,logs='',delay:any;
let stop!:()=>void;const stopped=new Promise<void>(yes=>stop=yes),waits=new Map<number,{yes:(v:any)=>void;no:(e:Error)=>void}>();
function worker(){
 if(child)return;
 child=spawn(process.execPath,[join(repo,'finnor-os/dist-y1/worker-loop.mjs')],{
  cwd:join(repo,'finnor-os'),env:{...process.env,DATABASE_URL:e.workerUrl},stdio:['ignore','pipe','pipe','ipc']});
 for(const stream of [child.stdout!,child.stderr!])stream.on('data',b=>{logs+=b;assert(logs.length<=1048576);});
 child.on('message',(value:any)=>{const w=waits.get(value.id);if(w){waits.delete(value.id);value.error?w.no(Error(value.error)):w.yes(value);}});
 child.once('error',error=>{for(const w of waits.values())w.no(error);waits.clear();});
 child.once('close',()=>{for(const w of waits.values())w.no(Error('Y1_MOUNTED_WORKER_EXIT'));waits.clear();});
}
async function tick(retry=true):Promise<any>{
 worker();const id=++sequence;
 const value=await new Promise<any>((yes,no)=>{
  const timer=setTimeout(()=>{waits.delete(id);no(Error('Y1_MOUNTED_NATIVE_TICK_DEADLINE'));},180000);
  waits.set(id,{yes:value=>{clearTimeout(timer);yes(value);},no:error=>{clearTimeout(timer);no(error);}});
  child!.send({id,operation:'TICK'});
 });
 assert(value.productionWorkerFactory);await artifact(evidence,'workers/tick-'+id+'.json',value);
 if(!value.claimed&&retry){await new Promise(yes=>setTimeout(yes,2100));return tick(false);}
 return value;
}
const fixtures:any[]=[],threads:any[]=[];
const control=createServer(async(req,res)=>{
 res.setHeader('content-type','application/json');
 try{
  if(req.url==='/worker'&&req.method==='POST'){res.end(JSON.stringify(await tick()));return;}
  if(['/delay-submit','/delay-list','/delay-read','/delay-artifact'].includes(req.url??'')&&req.method==='POST'){
   assert(!delay,'ONE_ACTUAL_OWNER_RESPONSE_GATE');
   const operation='economic-theory-'+req.url!.slice('/delay-'.length);
   const latest=(await e.admin.query('SELECT id FROM finnor_os.y1_requests WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',
    [tenant,fixtures[0].work.workId])).rows[0]?.id;
   delay=e.http!.delay(['economic-theory-read','economic-theory-artifact'].includes(operation)?latest:fixtures[0].work.workId,operation);
   res.end('{}');return;
  }
  if(req.url==='/delay-status'){res.end(JSON.stringify({waiting:delay?.waiting()??false}));return;}
  if(['/release','/release-error'].includes(req.url??'')&&req.method==='POST'){delay?.release(req.url==='/release-error');delay=undefined;res.end('{}');return;}
  if(req.url==='/auth-short-lived'&&req.method==='POST'){e.http!.setTokenLifetimeSeconds(135);res.end('{}');return;}
  if(req.url==='/auth-long-lived'&&req.method==='POST'){e.http!.setTokenLifetimeSeconds(3600);res.end('{}');return;}
  if(req.url==='/auth-status'){res.end(JSON.stringify(e.http!.authObservations()));return;}
  if(['/steer','/steer-other'].includes(req.url??'')&&req.method==='POST'){
   const value=await receiveWork({tenantId:tenant,userId:principal,workId:fixtures[req.url==='/steer-other'?1:0].work.workId,channel:'console',
    instruction:'Explicit later mounted steering input invalidates the old construction cut',idempotencyKey:randomUUID()});
   res.end(JSON.stringify(value));return;
  }
  if(req.url==='/observe'){
   const value={
    works:(await e.admin.query('SELECT id,status FROM finnor_os.works WHERE tenant_id=$1',[tenant])).rows.map(row=>({...row,immutable:isImmutableWorkStatus(row.status)})),
    invalidations:(await e.admin.query("SELECT theory_id,body FROM finnor_os.y1_events WHERE tenant_id=$1 AND kind='P7_INVALIDATION'",[tenant])).rows,
    theories:(await e.admin.query('SELECT id,work_id,status,generation,episode_id,idempotency_key,request FROM finnor_os.y1_requests WHERE tenant_id=$1 ORDER BY created_at,id',[tenant])).rows,
    episodes:(await e.admin.query('SELECT id,work_id,deadline_at,attempts_used,search_steps_used,semantic_applications_used,retained_bytes,uses_used FROM finnor_os.y1_episodes WHERE tenant_id=$1',[tenant])).rows,
    programmes:(await e.admin.query('SELECT id,work_id,body FROM finnor_os.s4_economic_programmes WHERE tenant_id=$1',[tenant])).rows,
    obligations:(await e.admin.query('SELECT programme_id,effect_id,body FROM finnor_os.s6_economic_obligation_origins WHERE tenant_id=$1',[tenant])).rows,
    effects:(await e.admin.query('SELECT id,status,operation_class,observed_result,verification FROM finnor_os.business_effects WHERE tenant_id=$1',[tenant])).rows,
    reservations:(await e.admin.query('SELECT reservation_id,status,revision,economic_state FROM finnor_os.s5_reservations WHERE tenant_id=$1',[tenant])).rows,
    deliveries:(await e.admin.query('SELECT j.id,j.type,j.status,d.id delivery_id,d.claim_fence,d.outcome FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts d ON d.job_id=j.id WHERE j.tenant_id=$1 ORDER BY d.started_at',[tenant])).rows,
    auth:e.http!.authObservations(),
   };
   await artifact(evidence,'browser-sql-readback.json',value);res.end(JSON.stringify(value));return;
  }
  if(req.url==='/stop'&&req.method==='POST'){res.end('{}');stop();return;}
  res.writeHead(404);res.end('{}');
 }catch(error){res.writeHead(500);res.end(JSON.stringify({error:String(error)}));}
});
try{
 await e.admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'Y1 mounted disposable firm')",[tenant,randomUUID()]);
 for(const id of [principal,peer]){
  const email=id+'@y1.example.test';
  await e.admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')",[id,tenant,email]);
  e.http!.register(id,email);
 }
 await e.admin.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,'y1-mounted','Y1 mounted finite context','other')",[root.entityId,tenant]);
 await configureTenantVertical({tenantId:tenant,verticalKey:'private_equity',expectedVersion:0,createdBy:principal,sourceSystem:'Y1:mounted-disposable'});
 const horizon={startAt:new Date(Date.now()-3600000).toISOString(),periodMs:7200000,periods:1},
  period={startAt:horizon.startAt,endAt:new Date(Date.parse(horizon.startAt)+horizon.periodMs).toISOString()};
 for(let index=0;index<2;index++){
  const f=await bindCanonicalInputs(e.admin,tenant,principal,root,publicProblem(root,period,'mounted'+index),'mounted'+index);
  const thread=await createEmployeeConversationThread({tenantId:tenant,ownerEmployeeId:principal,title:'Y1 economic Work '+index});
  await updateEmployeeConversationThreadContext({tenantId:tenant,ownerEmployeeId:principal,threadId:thread.id,activeWorkId:f.work.workId,activeReferences:[root]});
  fixtures.push(f);threads.push(thread);
 }
 const outsider=await createEmployeeConversationThread({tenantId:tenant,ownerEmployeeId:peer,title:'Y1 separate principal'});
 await updateEmployeeConversationThreadContext({tenantId:tenant,ownerEmployeeId:peer,threadId:outsider.id,activeWorkId:fixtures[0].work.workId,activeReferences:[root]});
 const token=await e.http!.login(principal),resourceResponse=await e.http!.api(token,'allocations','resource',{resource:resourceInput(tenant,principal,root,horizon,'mounted')});
 assert.equal(resourceResponse.status,200,JSON.stringify(resourceResponse));const resource=resourceResponse.body;
 await new Promise<void>(yes=>control.listen(0,'127.0.0.1',yes));const address=control.address();assert(address&&typeof address!=='string');
 mounted=await startMountedFrontend(evidence,e.http!);
 const url=(threadId:string,workId:string)=>mounted!.base+'/centropy/world?'+new URLSearchParams({
  threadId,root:JSON.stringify(root),object:JSON.stringify({namespace:'core',owner:'@finnor/db',type:'work',id:workId})});
 await artifact(evidence,'browser-fixture.json',{schema:'finnor.y1.mounted-fixture.v1',base:mounted.base,
  control:'http://127.0.0.1:'+address.port,url:url(threads[0].id,fixtures[0].work.workId),
  otherUrl:url(threads[1].id,fixtures[1].work.workId),peerUrl:url(outsider.id,fixtures[0].work.workId),
  tenant,root,principal,peer,email:principal+'@y1.example.test',peerEmail:peer+'@y1.example.test',
  workId:fixtures[0].work.workId,otherWorkId:fixtures[1].work.workId,problem:fixtures[0].request.problem,otherProblem:fixtures[1].request.problem,
  resource,csp:mounted.csp,credentialsRetained:false,protectedQualification:false,
  qualification:'EMITTED_NEXT16_WORLD_WORK_NEXT15_API_NATIVE_QUEUE_AND_CHECKER_REAL_SIGNED_DISPOSABLE_AUTH_ORDINARY_RLS'});
 console.log('Y1_MOUNTED_FIXTURE_READY',evidence);
 const signal=()=>{delay?.release();stop();};process.once('SIGTERM',signal);process.once('SIGINT',signal);
 try{await stopped;}finally{process.off('SIGTERM',signal);process.off('SIGINT',signal);}
 const result=JSON.parse(await readFile(join(evidence,'browser-results.json'),'utf8'));
 assert.equal(result.status,'PASS_MOUNTED_EMITTED_Y1_DEVELOPMENT','A stopped fixture is not browser proof');
}finally{
 delay?.release();control.closeAllConnections();if(control.listening)await new Promise<void>(yes=>control.close(()=>yes()));
 await mounted?.close();
 if(child&&child.exitCode===null&&child.signalCode===null){const end=new Promise<void>(yes=>child!.once('close',()=>yes()));child.kill('SIGKILL');await end;}
 assert(!/postgres(?:ql)?:\/\/|Bearer /i.test(logs));await artifact(evidence,'workers/terminal.json',{pid:child?.pid,code:child?.exitCode,signal:child?.signalCode,logs});
 await closePool();await e.close();
}
