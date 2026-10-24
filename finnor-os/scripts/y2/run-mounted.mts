/** Actual WORLD Work, emitted frontend/API, signed auth, native queue and
 * independent checker. Controls only delay genuine replies or fail a checker. */
import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {configureTenantVertical,createEmployeeConversationThread,updateEmployeeConversationThreadContext,receiveWork,closePool} from '@finnor/db';
import {startEnvironment,artifact,repo,hash} from '../x3/environment.mts';
import {startMountedFrontend} from '../x3/mounted-fixture.mts';
import {publicProblem,bindCanonicalInputs,decisionInput,oracleQuery} from './business-fixtures.mts';

assert(process.env.FINNOR_Y2_EVIDENCE_DIR,'EXPLICIT_Y2_MOUNTED_EVIDENCE_REQUIRED');
const evidence=resolve(process.env.FINNOR_Y2_EVIDENCE_DIR);await mkdir(evidence,{recursive:true});
process.env.FINNOR_Y2_PROFILE='ordinary_disposable';
process.env.FINNOR_Y1_PROFILE='ordinary_disposable';
process.env.FINNOR_S4_POLICY_STORE=await mkdtemp(join(tmpdir(),'finnor-y2-mounted-s4-'));
const runtime=JSON.parse(await readFile(join(repo,'finnor-os/dist-y2/manifest.json'),'utf8'));
assert.equal(hash(await readFile(join(repo,'finnor-os/dist-y2/worker-loop.mjs'))),runtime.worker.sha256);
process.env.FINNOR_Y2_ASSET_ROOT=join(repo,'finnor-os/dist-y2',runtime.assetRoot);
const e=await startEnvironment(evidence,{builtApi:true,baseHead:'0195_postx_y1_economic_action_theory.sql'});
const tenant=randomUUID(),principal=randomUUID(),peer=randomUUID(),root={entityType:'external_organization',entityId:randomUUID()},
 otherRoot={entityType:'external_organization',entityId:randomUUID()};
let mounted:Awaited<ReturnType<typeof startMountedFrontend>>|undefined,child:ChildProcess|undefined,sequence=0,logs='',delay:any,python:string|undefined;
let stop!:()=>void;const stopped=new Promise<void>(yes=>stop=yes),waits=new Map<number,{yes:(v:any)=>void;no:(e:Error)=>void}>();
async function stopWorker(){
 const old=child;if(!old)return;
 if(old.exitCode===null&&old.signalCode===null){const ended=new Promise<void>(yes=>old.once('close',()=>yes()));old.kill('SIGKILL');await ended;}
 child=undefined;assert(!/postgres(?:ql)?:\/\/|Bearer /i.test(logs),'CREDENTIAL_FREE_MOUNTED_WORKER_EVIDENCE');
 await artifact(evidence,'workers/stopped-'+sequence+'.json',{pid:old.pid,code:old.exitCode,signal:old.signalCode,logs});logs='';
}
function worker(){
 if(child)return;
 const env:NodeJS.ProcessEnv={...process.env,DATABASE_URL:e.workerUrl};delete env.FINNOR_Y2_PYTHON;if(python)env.FINNOR_Y2_PYTHON=python;
 child=spawn(process.execPath,[join(repo,'finnor-os/dist-y2/worker-loop.mjs')],{cwd:join(repo,'finnor-os'),env,stdio:['ignore','pipe','pipe','ipc']});
 for(const stream of [child.stdout!,child.stderr!])stream.on('data',b=>{logs+=b;if(logs.length>1048576)child?.kill('SIGKILL');});
 child.on('message',(value:any)=>{const w=waits.get(value.id);if(w){waits.delete(value.id);value.error?w.no(Error(value.error)):w.yes(value);}});
 child.once('error',error=>{for(const w of waits.values())w.no(error);waits.clear();});
 child.once('close',()=>{for(const w of waits.values())w.no(Error('Y2_MOUNTED_WORKER_EXIT'));waits.clear();});
}
async function tick(retry=true):Promise<any>{
 worker();const id=++sequence;
 const value=await new Promise<any>((yes,no)=>{
  const timer=setTimeout(()=>{waits.delete(id);no(Error('Y2_MOUNTED_NATIVE_TICK_DEADLINE'));},180000);
  waits.set(id,{yes:value=>{clearTimeout(timer);yes(value);},no:error=>{clearTimeout(timer);no(error);}});child!.send({id,operation:'TICK'});
 });
 assert(value.productionWorkerFactory);await artifact(evidence,'workers/tick-'+id+'.json',value);
 if(!value.claimed&&retry){await new Promise(yes=>setTimeout(yes,2100));return tick(false);}return value;
}
const fixtures:any[]=[],threads:any[]=[];let token='';
const control=createServer(async(req,res)=>{
 res.setHeader('content-type','application/json');
 try{
  const url=new URL(req.url??'/','http://127.0.0.1'),path=url.pathname;
  if(path==='/worker'&&req.method==='POST'){res.end(JSON.stringify(await tick()));return;}
  if(['/checker-unavailable','/checker-available'].includes(path)&&req.method==='POST'){
   await stopWorker();python=path==='/checker-unavailable'?'/nonexistent/y2-mounted-python':undefined;res.end('{}');return;
  }
  if(['/delay-submit','/delay-list','/delay-read','/delay-artifact','/delay-use'].includes(path)&&req.method==='POST'){
   assert(!delay,'ONE_ACTUAL_Y2_OWNER_RESPONSE_GATE');
   const operation=path==='/delay-use'?'response-use-read':'response-model-'+path.slice('/delay-'.length),
    scope=['/delay-read','/delay-artifact','/delay-use'].includes(path)?url.searchParams.get('modelId'):fixtures[0].work.workId;
   assert(scope&&/^[0-9a-f-]{36}$/.test(scope));delay=e.http!.delay(scope,operation);res.end('{}');return;
  }
  if(path==='/delay-status'){res.end(JSON.stringify({waiting:delay?.waiting()??false}));return;}
  if(['/release','/release-error'].includes(path)&&req.method==='POST'){delay?.release(path==='/release-error');delay=undefined;res.end('{}');return;}
  if(path==='/auth-short-lived'&&req.method==='POST'){e.http!.setTokenLifetimeSeconds(135);res.end('{}');return;}
  if(path==='/auth-long-lived'&&req.method==='POST'){e.http!.setTokenLifetimeSeconds(3600);res.end('{}');return;}
  if(path==='/auth-status'){res.end(JSON.stringify(e.http!.authObservations()));return;}
  if(path==='/decision'){
   const response=await e.http!.api(token,'company-brain','response-model-read',{modelId:url.searchParams.get('modelId')});
   assert.equal(response.status,200);res.end(JSON.stringify(decisionInput(response.body,tenant,principal)));return;
  }
  if(path==='/steer-other'&&req.method==='POST'){
   res.end(JSON.stringify(await receiveWork({tenantId:tenant,userId:principal,workId:fixtures[1].work.workId,channel:'console',
    instruction:'Later canonical Work steering withdraws strategic continuation, not prior commitments',idempotencyKey:randomUUID()})));return;
  }
  if(path==='/observe'){
   const value={
    models:(await e.admin.query('SELECT id,work_id,status,generation,episode_id,idempotency_key,request,candidate,artifact,admission,fallback_id FROM finnor_os.y2_models WHERE tenant_id=$1 ORDER BY created_at,id',[tenant])).rows,
    uses:(await e.admin.query('SELECT id,model_id,requested_model_id,kind,status,attempts_used,episode_id,artifact,check_result FROM finnor_os.y2_uses WHERE tenant_id=$1 ORDER BY created_at,id',[tenant])).rows,
    episodes:(await e.admin.query('SELECT id,work_id,deadline_at,attempts_used,use_attempts_used,uses_used,retained_bytes FROM finnor_os.y2_episodes WHERE tenant_id=$1',[tenant])).rows,
    events:(await e.admin.query('SELECT model_id,kind,body FROM finnor_os.y2_events WHERE tenant_id=$1 ORDER BY id',[tenant])).rows,
    deliveries:(await e.admin.query('SELECT j.id,j.type,j.status,d.claim_fence,d.outcome FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts d ON d.job_id=j.id WHERE j.tenant_id=$1 ORDER BY d.started_at',[tenant])).rows,
    auth:e.http!.authObservations(),
   };
   await artifact(evidence,'browser-sql-readback.json',value);res.end(JSON.stringify(value));return;
  }
  if(path==='/stop'&&req.method==='POST'){res.end('{}');stop();return;}
  res.writeHead(404);res.end('{}');
 }catch(error){res.writeHead(500);res.end(JSON.stringify({error:String(error)}));}
});
try{
 await e.admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'Y2 mounted public own-firm context')",[tenant,randomUUID()]);
 for(const id of [principal,peer]){
  const email=id+'@y2.example.test';
  await e.admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')",[id,tenant,email]);e.http!.register(id,email);
 }
 for(const r of [root,otherRoot])await e.admin.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,'Y2 mounted firm context','other')",[r.entityId,tenant,randomUUID()]);
 await configureTenantVertical({tenantId:tenant,verticalKey:'private_equity',expectedVersion:0,createdBy:principal,sourceSystem:'Y2:mounted-disposable'});
 for(let index=0;index<2;index++){
  const f=await bindCanonicalInputs(e.admin,tenant,principal,root,publicProblem(root,index===1),'mounted'+index);
  const thread=await createEmployeeConversationThread({tenantId:tenant,ownerEmployeeId:principal,title:'Y2 response Work '+index});
  await updateEmployeeConversationThreadContext({tenantId:tenant,ownerEmployeeId:principal,threadId:thread.id,activeWorkId:f.work.workId,activeReferences:[root]});
  fixtures.push(f);threads.push(thread);
 }
 const outsider=await createEmployeeConversationThread({tenantId:tenant,ownerEmployeeId:peer,title:'Y2 separate principal'});
 await updateEmployeeConversationThreadContext({tenantId:tenant,ownerEmployeeId:peer,threadId:outsider.id,activeWorkId:fixtures[0].work.workId,activeReferences:[root]});
 token=await e.http!.login(principal);
 await new Promise<void>(yes=>control.listen(0,'127.0.0.1',yes));const address=control.address();assert(address&&typeof address!=='string');
 mounted=await startMountedFrontend(evidence,e.http!);
 const url=(threadId:string,workId:string,r=root)=>mounted!.base+'/centropy/world?'+new URLSearchParams({
  threadId,root:JSON.stringify(r),object:JSON.stringify({namespace:'core',owner:'@finnor/db',type:'work',id:workId})});
 await artifact(evidence,'browser-fixture.json',{schema:'finnor.y2.mounted-fixture.v1',base:mounted.base,control:'http://127.0.0.1:'+address.port,
  url:url(threads[0].id,fixtures[0].work.workId),otherUrl:url(threads[1].id,fixtures[1].work.workId),
  rootSwitchUrl:url(threads[0].id,fixtures[0].work.workId,otherRoot),peerUrl:url(outsider.id,fixtures[0].work.workId),
  tenant,root,otherRoot,principal,peer,email:principal+'@y2.example.test',peerEmail:peer+'@y2.example.test',
  workId:fixtures[0].work.workId,otherWorkId:fixtures[1].work.workId,
  input:{problem:fixtures[0].request.problem,evidence:fixtures[0].request.evidence},
  otherInput:{problem:fixtures[1].request.problem,evidence:fixtures[1].request.evidence},query:oracleQuery(),
  csp:mounted.csp,credentialsRetained:false,protectedQualification:false,
  qualification:'EMITTED_NEXT16_WORLD_WORK_NEXT15_API_NATIVE_QUEUE_INDEPENDENT_CHECKER_SIGNED_DISPOSABLE_AUTH_ORDINARY_RLS'});
 console.log('Y2_MOUNTED_FIXTURE_READY',evidence);
 const signal=()=>{delay?.release();stop();};process.once('SIGTERM',signal);process.once('SIGINT',signal);
 try{await stopped;}finally{process.off('SIGTERM',signal);process.off('SIGINT',signal);}
 const result=JSON.parse(await readFile(join(evidence,'browser-results.json'),'utf8'));
 assert.equal(result.status,'PASS_MOUNTED_EMITTED_Y2_DEVELOPMENT','Stopped infrastructure alone is not browser proof');
}finally{
 delay?.release();control.closeAllConnections();if(control.listening)await new Promise<void>(yes=>control.close(()=>yes()));
 await mounted?.close();await stopWorker();await closePool();await e.close();
}
