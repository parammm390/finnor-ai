/** Mounted proof transport only. Product routes, auth, Work and queue are real.
 * Control endpoints prepare native inputs, run ordinary workers and read SQL. */
import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {receiveWork,createEmployeeConversationThread,updateEmployeeConversationThreadContext} from '@finnor/db';
import {startMountedFrontend} from '../x3/mounted-fixture.mts';
import {artifact} from '../x3/environment.mts';

export async function learningMountedFixture(f:{
 e:any;evidence:string;tenant:string;root:any;people:Record<string,string>;main:any;compilation:any;
 values:(label:string,currency:string,lines:readonly string[],bank:string,isTransfer?:boolean)=>Promise<any>;
 command:(app:any,action:string,record:any,input?:unknown,who?:string)=>Promise<any>;
 worker:()=>Promise<any>;
}){
 const {e,evidence,tenant,root,people}=f;
 assert.equal(process.env.FINNOR_X5_BUILT_API,'1','MOUNTED_PROOF_REQUIRES_EMITTED_API');
 const ok=(r:any)=>{assert.equal(r.status,200,JSON.stringify(r));return r.body;};
 const training=(await e.admin.query('SELECT request FROM finnor_os.x5_compilations WHERE tenant_id=$1 AND id=$2',[tenant,f.compilation.compilationId])).rows[0].request;
 const works:any[]=[],threads:any[]=[];
 for(let index=0;index<2;index++){
  const work=await receiveWork({tenantId:tenant,userId:people.analyst!,channel:'console',
   instruction:'Explicit bounded experience-to-policy Work, mounted development proof '+index,
   idempotencyKey:randomUUID(),entityAttachments:[{...root,source:'X5:mounted-fixture'}]});
  const thread=await createEmployeeConversationThread({tenantId:tenant,ownerEmployeeId:people.analyst!,title:'X5 learned policy Work '+index});
  await updateEmployeeConversationThreadContext({tenantId:tenant,ownerEmployeeId:people.analyst!,threadId:thread.id,activeWorkId:work.workId,activeReferences:[root]});
  works.push(work);threads.push(thread);
 }
 const partnerThread=await createEmployeeConversationThread({tenantId:tenant,ownerEmployeeId:people.partner!,title:'X5 separate current principal'});
 await updateEmployeeConversationThreadContext({tenantId:tenant,ownerEmployeeId:people.partner!,threadId:partnerThread.id,activeWorkId:works[0].workId,activeReferences:[root]});
 let delay:any,mounted:Awaited<ReturnType<typeof startMountedFrontend>>|undefined,stop!:()=>void,closed=false,fresh=0;
 const stopped=new Promise<void>(yes=>stop=yes);
 const control=createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  try{
   if(req.url==='/worker'&&req.method==='POST'){res.end(JSON.stringify(await f.worker()));return;}
   if(req.url==='/fresh'&&req.method==='POST'){
    const input=await f.values('mounted-fresh-'+(++fresh),'USD',['3100','4900'],'8000');
    const record=ok(await f.command(f.main,'create',null,input)).record;
    await artifact(evidence,'browser-fresh/'+fresh+'.json',{input,record});res.end(JSON.stringify(record));return;
   }
   if(req.url==='/approve'&&req.method==='POST'){
    const record=(await e.admin.query("SELECT id FROM finnor_os.x3_records WHERE tenant_id=$1 AND application_id=$2 AND values->>'memo' LIKE 'Private development memo mounted-fresh-%' AND state='RECONCILED' ORDER BY created_at DESC LIMIT 1",[tenant,f.main.id])).rows[0];
    assert(record);
    const token=await e.http.login(people.analyst),before=ok(await e.http.api(token,'company-brain','application-record',{applicationId:f.main.id,recordId:record.id}));
    const approved=ok(await f.command(f.main,'approve',before,{},'partner'));assert.equal(approved.record.state,'APPROVED');res.end(JSON.stringify(approved));return;
   }
   if(['/delay-execute','/delay-list'].includes(req.url??'')&&req.method==='POST'){
    assert(!delay,'ONE_RESPONSE_GATE_AT_A_TIME');
    delay=e.http.delay(req.url==='/delay-execute'?f.main.id:works[0].workId,req.url==='/delay-execute'?'learning-execute':'learning-list');res.end('{}');return;
   }
   if(req.url==='/delay-status'){res.end(JSON.stringify({waiting:delay?.waiting()??false}));return;}
   if(['/release','/release-error'].includes(req.url??'')&&req.method==='POST'){delay?.release(req.url==='/release-error');delay=undefined;res.end('{}');return;}
   if(req.url==='/auth-short-lived'&&req.method==='POST'){e.http.setTokenLifetimeSeconds(150);res.end('{}');return;}
   if(req.url==='/auth-long-lived'&&req.method==='POST'){e.http.setTokenLifetimeSeconds(3600);res.end('{}');return;}
   if(req.url==='/auth-status'){res.end(JSON.stringify(e.http.authObservations()));return;}
   if(req.url==='/observe'){
    const compilations=(await e.admin.query(`SELECT id,work_id,status,head_release_id,attempt_count,use_count,data_bytes,deadline_at
     FROM finnor_os.x5_compilations WHERE tenant_id=$1 ORDER BY created_at`,[tenant])).rows;
    const consents=(await e.admin.query(`SELECT r.id,r.application_id,r.body,v.created_at revoked_at
     FROM finnor_os.x5_training_rights r LEFT JOIN finnor_os.x5_rights_revocations v ON v.tenant_id=r.tenant_id AND v.consent_id=r.id
     WHERE r.tenant_id=$1 ORDER BY r.created_at`,[tenant])).rows;
    const uses=(await e.admin.query('SELECT id,compilation_id,request,status,result FROM finnor_os.x5_uses WHERE tenant_id=$1 ORDER BY created_at',[tenant])).rows;
    const records=(await e.admin.query('SELECT id,application_id,state,values,concurrency_revision,pending_effect_id FROM finnor_os.x3_records WHERE tenant_id=$1 ORDER BY created_at',[tenant])).rows;
    const events=(await e.admin.query('SELECT id::text,application_id,record_id,kind,actor_id,body FROM finnor_os.x3_events WHERE tenant_id=$1 ORDER BY id',[tenant])).rows;
    const deliveries=(await e.admin.query(`SELECT j.id,j.type,j.payload->>'useId' use_id,j.status,d.id delivery_id,d.claim_fence,d.outcome
     FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts d ON d.job_id=j.id WHERE j.tenant_id=$1 ORDER BY d.started_at`,[tenant])).rows;
    const observed={compilations,consents,uses,records,events,deliveries,auth:e.http.authObservations()};
    await artifact(evidence,'browser-sql-readback.json',observed);res.end(JSON.stringify(observed));return;
   }
   if(req.url==='/stop'&&req.method==='POST'){res.end('{}');stop();return;}
   res.writeHead(404);res.end('{}');
  }catch(error){res.writeHead(500);res.end(JSON.stringify({error:String(error)}));}
 });
 const close=async()=>{
  if(closed)return;closed=true;delay?.release();delay=undefined;
  control.closeAllConnections();if(control.listening)await new Promise<void>(yes=>control.close(()=>yes()));
  await mounted?.close();
 };
 try{
  await new Promise<void>(yes=>control.listen(0,'127.0.0.1',yes));const address=control.address();assert(address&&typeof address!=='string');
  mounted=await startMountedFrontend(evidence,e.http);
  const sourceDeadline=(await e.admin.query('SELECT deadline_at FROM finnor_os.x3_applications WHERE tenant_id=$1 AND id=$2',[tenant,f.main.id])).rows[0].deadline_at;
  const url=(id:string)=>mounted!.base+'/centropy/investigations/'+id+'?root='+encodeURIComponent(JSON.stringify(root));
  const data={schema:'finnor.x5.mounted-fixture.v1',base:mounted.base,control:'http://127.0.0.1:'+address.port,
   url:url(threads[0].id),otherUrl:url(threads[1].id),partnerUrl:url(partnerThread.id),workId:works[0].workId,otherWorkId:works[1].workId,
   tenant,root,principal:people.analyst,partner:people.partner,email:people.analyst+'@x5.example.test',partnerEmail:people.partner+'@x5.example.test',
   sourceApplicationId:f.main.id,experience:training.experience.map((v:any)=>({applicationId:v.applicationId,recordIds:v.recordIds})),
   knowledgeCut:new Date().toISOString(),validUntil:sourceDeadline.toISOString(),csp:mounted.csp,
   qualification:'EMITTED_NEXT16_FRONTEND_NEXT15_API_REAL_SIGNED_DISPOSABLE_AUTH_AND_ORDINARY_RLS_NOT_PROTECTED',
   extraEligibleScientificAssignments:0,credentialsRetained:false,
   rerun:'FINNOR_X5_BUILT_API=1 FINNOR_X5_PHASE=browser FINNOR_X5_EVIDENCE_DIR=<new absolute directory> node --import=tsx scripts/x5/run-installed.mts; then run scripts/x5/browser-checks.mts in the same evidence directory'};
  await artifact(evidence,'browser-fixture.json',data);
  console.log('X5_MOUNTED_FIXTURE_READY',evidence);
  const signal=()=>{delay?.release();stop();};process.once('SIGTERM',signal);process.once('SIGINT',signal);
  try{await stopped;}finally{process.off('SIGTERM',signal);process.off('SIGINT',signal);}
  return data;
 }finally{await close();}
}
