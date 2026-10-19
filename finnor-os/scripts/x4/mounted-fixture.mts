/** Only ordinary Work/thread inputs and transport controls. Existing scientific
 * outcomes come exclusively from the live authenticated physical campaign. */
import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {receiveWork,createEmployeeConversationThread,updateEmployeeConversationThreadContext} from '@finnor/db';
import {startMountedFrontend} from '../x3/mounted-fixture.mts';
import {artifact} from '../x3/environment.mts';
export async function identificationMountedFixture(f:{
 e:any;evidence:string;tenant:string;root:any;people:Record<string,string>;identificationId:string;view:any;consent:any;request:any;
}){
 const {e,evidence,tenant,root,people,identificationId}=f;
 assert.equal(process.env.FINNOR_X4_BUILT_API,'1');
 assert(f.view.current&&f.view.model);
 const other=await receiveWork({tenantId:tenant,userId:people.author!,channel:'console',instruction:'A separate bounded scientific Work for visible question intake and scope fencing',
  idempotencyKey:randomUUID(),entityAttachments:[{...root,source:'X4:mounted-development-input'}]});
 const threads:any[]=[];
 for(const [index,workId] of [f.view.workId,other.workId].entries()){
  const thread=await createEmployeeConversationThread({tenantId:tenant,ownerEmployeeId:people.author!,title:'X4 identified system Work '+index});
  await updateEmployeeConversationThreadContext({tenantId:tenant,ownerEmployeeId:people.author!,threadId:thread.id,activeWorkId:workId,activeReferences:[root]});threads.push(thread);
 }
 const outsider=await createEmployeeConversationThread({tenantId:tenant,ownerEmployeeId:people.outsider!,title:'X4 separate unconsented principal'});
 await updateEmployeeConversationThreadContext({tenantId:tenant,ownerEmployeeId:people.outsider!,threadId:outsider.id,activeWorkId:f.view.workId,activeReferences:[root]});
 let delay:any,mounted:Awaited<ReturnType<typeof startMountedFrontend>>|undefined,stop!:()=>void;
 const stopped=new Promise<void>(yes=>stop=yes);
 const control=createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  try{
   if(['/delay-use','/delay-list','/delay-read'].includes(req.url??'')&&req.method==='POST'){
    assert(!delay,'ONE_ACTUAL_OWNER_RESPONSE_GATE');
    const operation=req.url==='/delay-list'?'identification-list':req.url==='/delay-read'?'identification-read':'identification-use';
    delay=e.http.delay(req.url==='/delay-list'?f.view.workId:identificationId,operation);res.end('{}');return;
   }
   if(req.url==='/delay-status'){res.end(JSON.stringify({waiting:delay?.waiting()??false}));return;}
   if(['/release','/release-error'].includes(req.url??'')&&req.method==='POST'){delay?.release(req.url==='/release-error');delay=undefined;res.end('{}');return;}
   if(req.url==='/auth-short-lived'&&req.method==='POST'){e.http.setTokenLifetimeSeconds(135);res.end('{}');return;}
   if(req.url==='/auth-long-lived'&&req.method==='POST'){e.http.setTokenLifetimeSeconds(3600);res.end('{}');return;}
   if(req.url==='/auth-status'){res.end(JSON.stringify(e.http.authObservations()));return;}
   if(req.url==='/observe'){
    const identifications=(await e.admin.query('SELECT id,work_id,status,generation,head_model_id,experiment_count,observation_count,analysis_count,use_count,data_bytes,deadline_at FROM finnor_os.x4_identifications WHERE tenant_id=$1 ORDER BY created_at,id',[tenant])).rows,
     uses=(await e.admin.query('SELECT id,identification_id,request,status,result,decision_id FROM finnor_os.x4_uses WHERE tenant_id=$1 ORDER BY created_at,id',[tenant])).rows,
     consents=(await e.admin.query('SELECT id,body_digest FROM finnor_os.x4_consents WHERE tenant_id=$1',[tenant])).rows,
     revocations=(await e.admin.query('SELECT consent_id,reason FROM finnor_os.x4_consent_revocations WHERE tenant_id=$1',[tenant])).rows,
     models=(await e.admin.query("SELECT id,identification_id,body_digest,body->>'checkDigest' check_digest FROM finnor_os.x4_models WHERE tenant_id=$1",[tenant])).rows,
     events=(await e.admin.query('SELECT id::text,identification_id,kind,actor_id,body FROM finnor_os.x4_events WHERE tenant_id=$1 ORDER BY id',[tenant])).rows,
     effects=(await e.admin.query('SELECT id FROM finnor_os.external_operations WHERE tenant_id=$1',[tenant])).rows;
    const value={identifications,uses,consents,revocations,models,events,effects,auth:e.http.authObservations()};
    await artifact(evidence,'browser-sql-readback.json',value);res.end(JSON.stringify(value));return;
   }
   if(req.url==='/stop'&&req.method==='POST'){res.end('{}');stop();return;}
   res.writeHead(404);res.end('{}');
  }catch(error){res.writeHead(500);res.end(JSON.stringify({error:String(error)}));}
 });
 try{
  await new Promise<void>(yes=>control.listen(0,'127.0.0.1',yes));const address=control.address();assert(address&&typeof address!=='string');
  mounted=await startMountedFrontend(evidence,e.http);
  const url=(id:string)=>mounted!.base+'/centropy/investigations/'+id+'?root='+encodeURIComponent(JSON.stringify(root));
  const data={schema:'finnor.x4.mounted-fixture.v1',base:mounted.base,control:'http://127.0.0.1:'+address.port,url:url(threads[0].id),otherUrl:url(threads[1].id),outsiderUrl:url(outsider.id),
   workId:f.view.workId,otherWorkId:other.workId,identificationId,modelId:f.view.model.id,principal:people.author,outsider:people.outsider,
   email:people.author+'@x4.example.test',outsiderEmail:people.outsider+'@x4.example.test',root,tenant,domain:f.request.domain,consentId:f.consent.consentId,
   sourceTargetId:f.request.sourceTargetId,replicationTargetId:f.request.replicationTargetId,replicator:people.replicator,validUntil:new Date(Date.now()+1200000).toISOString(),
   workstreamId:f.request.decision.workstreamId,investmentCaseId:f.request.decision.investmentCaseId,csp:mounted.csp,
   qualification:'EMITTED_NEXT16_WORK_NEXT15_API_REAL_SIGNED_DISPOSABLE_AUTH_ORDINARY_RLS_NOT_PROTECTED',credentialsRetained:false,
   physicalExperimentsCompleteBeforeMount:true,extraMountedUses:'QUEUED_ONLY_TO_TEST_EXACT_TRANSPORT_REPLAY_NO_ADDITIONAL_SCIENTIFIC_PASS',
   rerun:'FINNOR_X4_BUILT_API=1 FINNOR_X4_PHASE=browser FINNOR_X4_EVIDENCE_DIR=<new absolute directory> node --import=tsx scripts/x4/run-installed.mts; then scripts/x4/browser-checks.mts in that directory'};
  await artifact(evidence,'browser-fixture.json',data);console.log('X4_MOUNTED_FIXTURE_READY',evidence);
  const signal=()=>{delay?.release();stop();};process.once('SIGTERM',signal);process.once('SIGINT',signal);
  try{await stopped;}finally{process.off('SIGTERM',signal);process.off('SIGINT',signal);}
  const result=JSON.parse(await readFile(join(evidence,'browser-results.json'),'utf8'));
  assert.equal(result.status,'PASS_MOUNTED_EMITTED_X4_DEVELOPMENT','A stopped fixture is not a completed browser proof');
  return data;
 }finally{
  delay?.release();control.closeAllConnections();if(control.listening)await new Promise<void>(yes=>control.close(()=>yes()));await mounted?.close();
 }
}
