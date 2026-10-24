/** Actual emitted WORLD Work and authenticated API. Loopback control schedules
 * genuine queue ticks and delayed transport, never manufactures owner replies. */
import {strict as assert} from 'node:assert';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {join,resolve} from 'node:path';
import {readFile} from 'node:fs/promises';
import {createEmployeeConversationThread,updateEmployeeConversationThreadContext,receiveWork} from '@finnor/db';
import {artifact} from '../x3/environment.mts';
import {startMountedFrontend} from '../x3/mounted-fixture.mts';
import {startHarness} from './harness.mts';
import {observationSource} from './business-fixtures.mts';

assert(process.env.FINNOR_Y3_EVIDENCE_DIR,'EXPLICIT_Y3_MOUNTED_EVIDENCE_REQUIRED');
const evidence=resolve(process.env.FINNOR_Y3_EVIDENCE_DIR),h=await startHarness(evidence,true),
 {e,tenant,principal,peer,outsider,root}=h,fixtures:any[]=[],threads:any[]=[];
let mounted:Awaited<ReturnType<typeof startMountedFrontend>>|undefined,delay:any,stopping=false,
 stop!:()=>void;const stopped=new Promise<void>(yes=>stop=yes);
const control=createServer(async(req,res)=>{
 res.setHeader('content-type','application/json');
 try{
  const url=new URL(req.url??'/','http://127.0.0.1');
  if(req.method==='POST'&&url.pathname==='/worker'){res.end(JSON.stringify(await h.tick()));return;}
  if(req.method==='POST'&&['/delay-submit','/delay-local','/delay-read'].includes(url.pathname)){
   assert(!delay,'ONE_ORIGINAL_OWNER_RESPONSE_GATE');
   const suffix=url.pathname.slice('/delay-'.length),operation='interaction-'+suffix,
    selected=url.searchParams.get('protocolId')??(await e.admin.query(
     'SELECT id FROM finnor_os.y3_requests WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',
     [tenant,fixtures[0].request.workId])).rows[0]?.id;
   if(suffix!=='submit')assert((await e.admin.query(
    'SELECT id FROM finnor_os.y3_requests WHERE tenant_id=$1 AND work_id=$2 AND id=$3',
    [tenant,fixtures[0].request.workId,selected])).rowCount===1);
   delay=e.http!.delay(suffix==='submit'?fixtures[0].request.workId:selected,operation);res.end('{}');return;
  }
  if(url.pathname==='/delay-status'){res.end(JSON.stringify({waiting:delay?.waiting()??false}));return;}
  if(req.method==='POST'&&['/release','/release-error'].includes(url.pathname)){
   delay?.release(url.pathname==='/release-error');delay=undefined;res.end('{}');return;
  }
  if(req.method==='POST'&&['/auth-short-lived','/auth-long-lived'].includes(url.pathname)){
   e.http!.setTokenLifetimeSeconds(url.pathname==='/auth-short-lived'?135:3600);res.end('{}');return;
  }
  if(url.pathname==='/auth-status'){res.end(JSON.stringify(e.http!.authObservations()));return;}
  if(req.method==='POST'&&url.pathname==='/steer-other'){
   const steering=await receiveWork({tenantId:tenant,userId:principal,workId:fixtures[1].request.workId,channel:'console',
    instruction:'Later authenticated mounted Y3 Work steering',idempotencyKey:randomUUID()});
   res.end(JSON.stringify(steering));return;
  }
  if(req.method==='POST'&&url.pathname==='/revoke'){
   await e.admin.query('UPDATE finnor_os.authority_states SET revision=revision+1 WHERE tenant_id=$1',[tenant]);
   res.end('{}');return;
  }
  if(url.pathname==='/observe'){
   const value={
    protocols:(await e.admin.query('SELECT id,work_id,status,generation,episode_id,idempotency_key,request FROM finnor_os.y3_requests WHERE tenant_id=$1 ORDER BY created_at,id',[tenant])).rows,
    episodes:(await e.admin.query('SELECT id,work_id,deadline_at,attempts_used,search_steps_used,retained_bytes,uses_used FROM finnor_os.y3_episodes WHERE tenant_id=$1',[tenant])).rows,
    terms:(await e.admin.query('SELECT id,protocol_id,revision,body FROM finnor_os.s4_interaction_terms WHERE tenant_id=$1',[tenant])).rows,
    consents:(await e.admin.query('SELECT consent_id,principal_id,protocol_id,scope,subject_digest,decision,body FROM finnor_os.s4_interaction_consents WHERE tenant_id=$1 ORDER BY id',[tenant])).rows,
    runs:(await e.admin.query('SELECT id,protocol_id,status,revision,intent,programme_id FROM finnor_os.s4_interaction_runs WHERE tenant_id=$1',[tenant])).rows,
    history:(await e.admin.query('SELECT event_id,principal_id,run_id,kind,body FROM finnor_os.s4_interaction_history WHERE tenant_id=$1 ORDER BY id',[tenant])).rows,
    bindings:(await e.admin.query('SELECT programme_id,protocol_id,run_id,body FROM finnor_os.s4_interaction_programme_bindings WHERE tenant_id=$1',[tenant])).rows,
    obligations:(await e.admin.query('SELECT programme_id,effect_id,body FROM finnor_os.s6_economic_obligation_origins WHERE tenant_id=$1',[tenant])).rows,
    effects:(await e.admin.query('SELECT id,status,operation_class,observed_result,verification FROM finnor_os.business_effects WHERE tenant_id=$1',[tenant])).rows,
    reservations:(await e.admin.query('SELECT reservation_id,status,revision,economic_state FROM finnor_os.s5_reservations WHERE tenant_id=$1',[tenant])).rows,
    auth:e.http!.authObservations(),
   };
   await artifact(evidence,'browser-sql-readback.json',value);res.end(JSON.stringify(value));return;
  }
  if(req.method==='POST'&&url.pathname==='/stop'){stopping=true;res.end('{}');stop();return;}
  res.writeHead(404);res.end('{}');
 }catch(error){res.writeHead(500);res.end(JSON.stringify({error:String(error)}));}
});
try{
 for(let i=0;i<2;i++){
  const f=await h.fixture('mounted'+i),thread=await createEmployeeConversationThread({
   tenantId:tenant,ownerEmployeeId:principal,title:'Y3 dynamic Work '+i});
  await updateEmployeeConversationThreadContext({tenantId:tenant,ownerEmployeeId:principal,threadId:thread.id,
   activeWorkId:f.request.workId,activeReferences:[root]});fixtures.push(f);threads.push(thread);
 }
 for(const id of [peer,outsider]){
  const thread=await createEmployeeConversationThread({tenantId:tenant,ownerEmployeeId:id,title:'Y3 participant-local context'});
  await updateEmployeeConversationThreadContext({tenantId:tenant,ownerEmployeeId:id,threadId:thread.id,
   activeWorkId:fixtures[0].request.workId,activeReferences:[root]});threads.push(thread);
 }
 const reservation=await h.reserve(fixtures[0],'mounted'),observation=await observationSource(
  e.admin,tenant,root,fixtures[0].request,'P0',0,'market','0');
 await new Promise<void>(yes=>control.listen(0,'127.0.0.1',yes));const address=control.address();
 assert(address&&typeof address!=='string');
 mounted=await startMountedFrontend(evidence,e.http!);
 const url=(threadId:string,workId:string)=>mounted!.base+'/centropy/world?'+new URLSearchParams({
  threadId,root:JSON.stringify(root),object:JSON.stringify({namespace:'core',owner:'@finnor/db',type:'work',id:workId})});
 await artifact(evidence,'browser-fixture.json',{schema:'finnor.y3.mounted-fixture.v1',base:mounted.base,
  control:'http://127.0.0.1:'+address.port,tenant,principal,peer,outsider,root,
  email:h.emails.get(principal),peerEmail:h.emails.get(peer),outsiderEmail:h.emails.get(outsider),
  url:url(threads[0].id,fixtures[0].request.workId),otherUrl:url(threads[1].id,fixtures[1].request.workId),
  peerUrl:url(threads[2].id,fixtures[0].request.workId),outsiderUrl:url(threads[3].id,fixtures[0].request.workId),
  workId:fixtures[0].request.workId,otherWorkId:fixtures[1].request.workId,
  input:fixtures[0].request,otherInput:fixtures[1].request,reservation:reservation.held,
  observation:{date:0,key:'market',value:'0',classification:'SOURCED_FACT',source:observation},
  csp:mounted.csp,credentialsRetained:false,protectedQualification:false,
  qualification:'EMITTED_WORLD_WORK_API_NATIVE_WORKER_EXACT_CHECKER_SIGNED_AUTH_AND_RESTRICTED_POSTGRES'});
 console.log('Y3_MOUNTED_FIXTURE_READY',evidence);
 const signal=()=>{delay?.release();stop();};process.once('SIGTERM',signal);process.once('SIGINT',signal);
 try{await stopped;}finally{process.off('SIGTERM',signal);process.off('SIGINT',signal);}
 const result=JSON.parse(await readFile(join(evidence,'browser-results.json'),'utf8'));
 assert.equal(result.status,'PASS_MOUNTED_EMITTED_Y3_DEVELOPMENT','A stopped fixture alone is not browser proof');
}finally{
 delay?.release();control.closeAllConnections();if(control.listening)await new Promise<void>(yes=>control.close(()=>yes()));
 await mounted?.close();await h.close();
 await artifact(evidence,'mounted-lifecycle.json',{status:'STOPPED',requestedStop:stopping,protectedQualification:false});
}
