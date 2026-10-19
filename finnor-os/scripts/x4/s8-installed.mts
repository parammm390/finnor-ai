/** Actual signed disposable S8 service and native scientific proof. Private
 * signing keys and bearer material never enter retained campaign artifacts. */
import {strict as assert} from 'node:assert';
import {randomUUID,createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createServer,type Server} from 'node:http';
import {identifiedSystemSourcePaths} from '../../packages/capability-evolution/src/source-closure';
import {digest} from '../../packages/capability-evolution/src/contracts';
import {createCapabilityLifecycle} from '../s8/lifecycle-fixture.mts';
import {createEconomicLedger} from '../s7/ledger-fixture.mts';
import {lifecycleCall} from '../x3/s8-installed.mts';
import {artifact,hash} from '../x3/environment.mts';
function sorted(v:any):string{return v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(sorted).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+sorted(v[k])).join(',')+'}';}
const scientificDigest=(v:unknown)=>createHash('sha256').update(sorted(v)).digest('hex');
export async function identificationS8Proof(f:{
 e:any;evidence:string;tenant:string;people:Record<string,string>;identificationId:string;model:any;
 api:(who:string,operation:string,body:unknown)=>Promise<any>;
}){
 const {e,evidence,tenant,people,identificationId,model,api}=f;
 const ok=(r:any)=>{assert.equal(r.status,200,JSON.stringify(r));return r.body;};
 const sourcePins=await Promise.all((await identifiedSystemSourcePaths()).map(async path=>({path,sha256:hash(await readFile(path))})));
 assert(sourcePins.length<=256);
 const consent=(await e.admin.query('SELECT c.body_digest FROM finnor_os.x4_consents c JOIN finnor_os.x4_identifications i ON i.tenant_id=c.tenant_id AND i.consent_id=c.id WHERE i.tenant_id=$1 AND i.id=$2',[tenant,identificationId])).rows[0];
 const assignment=(await e.admin.query("SELECT * FROM finnor_os.x4_assignments WHERE tenant_id=$1 AND identification_id=$2 AND status='COMPLETE' ORDER BY created_at DESC,id DESC LIMIT 1",[tenant,identificationId])).rows[0];
 assert.equal(assignment.actor_id,people.replicator);
 const experiment=(await e.admin.query('SELECT * FROM finnor_os.x4_experiments WHERE tenant_id=$1 AND id=$2',[tenant,assignment.experiment_id])).rows[0];
 const assignmentDigest=scientificDigest({request:assignment.request,protocolDigest:experiment.protocol_digest});
 const resultsDigest=scientificDigest({result:assignment.result,observation:experiment.result,checkDigest:model.checkDigest});
 const service=await createCapabilityLifecycle({tenant,principal:people.author!,evaluator:people.replicator!,promoter:randomUUID(),rightsRef:consent.body_digest,sourcePins,nativeIdentification:true});
 const names=['FINNOR_S8_IDENTIFIED_SYSTEM_CONSUMER_CONFIG','FINNOR_S8_IDENTIFIED_SYSTEM_CONSUMER_ROOT','FINNOR_S6_OWNER_TRANSPORT_CONFIG','FINNOR_S6_OWNER_TRANSPORT_ROOT'],previous=Object.fromEntries(names.map(k=>[k,process.env[k]]));
 const ledger=await createEconomicLedger(tenant,people.author!,randomUUID(),{capabilityLifecycle:true,rightsRef:consent.body_digest,financialPrincipal:people.replicator!});
 const restore=()=>{for(const k of names){if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k];}};
 const tokenPath=join(service.root,'identified-system-proposer.token'),configPath=join(service.root,'identified-system-consumer.json');
 const config={schema:'finnor.s8.identified-system-consumer-policy.v1',domain:'DISPOSABLE_TEST_AUTHORITY',tenantId:tenant,principalId:people.author!,rightsRef:consent.body_digest,
  endpoint:'',tokenPath,tokenHash:hash(service.tokens.proposer!),sourcePins,validAfter:service.after,validUntil:service.until,timeoutMs:10000};
 let proxy:Server|undefined,proxyEndpoint='',loseProposal=true,lostNativeResponse:any;
 const bind=async()=>{config.endpoint=proxyEndpoint;await writeFile(configPath,JSON.stringify(service.signed(config,'release')),{mode:0o600});process.env[names[0]!]=configPath;process.env[names[1]!]=service.pub('release');if(process.env.FINNOR_X4_BUILT_API==='1')await e.http.restartApi();};
 const call=(role:string,operation:string,body:unknown)=>lifecycleCall(service,role,operation,body);
 const report:any={schema:'finnor.x4.s8-development-proof.v1',sourcePins,assignmentDigest,resultsDigest,protectedAdmission:false,productionActive:false,executionAuthorityGranted:false,
  qualification:'SIGNED_DISPOSABLE_PROCESS_NATIVE_RAW_CHECK_AND_DISTINCT_ROLES_NOT_PROTECTED_CUSTODY'};
 let closed=false;
 const close=async()=>{if(closed)return;closed=true;try{
  proxy?.closeAllConnections();if(proxy?.listening)await new Promise<void>(yes=>proxy!.close(()=>yes()));
  await service.stop();await ledger.stop();
 }finally{restore();}};
 try{
  const configuration=JSON.parse(await readFile(service.configPath,'utf8'));
  configuration.signedPolicy=service.signed({...service.policy,actors:service.policy.actors.map(a=>a.id==='proposer'?{...a,roles:['PROPOSER','CONSUMER']}:a)},'release');
  await writeFile(service.configPath,JSON.stringify(configuration),{mode:0o600});await writeFile(tokenPath,service.tokens.proposer!,{mode:0o600});
  await service.start();
  // Real transport loss only: the actual native service accepts and journals
  // the proposal before this proxy destroys its genuine response.
  proxy=createServer(async(req,res)=>{
   try{
    assert.equal(req.method,'POST');assert.equal(req.url,'/command');
    const chunks:Buffer[]=[];let size=0;
    for await(const chunk of req){size+=chunk.length;assert(size<=262144);chunks.push(chunk);}
    const body=Buffer.concat(chunks),command=JSON.parse(body.toString());
    const native=await fetch(service.endpoint()+'/command',{method:'POST',headers:{authorization:String(req.headers.authorization??''),'content-type':'application/json'},body,
     redirect:'error',signal:AbortSignal.timeout(10000)});
    const bytes=Buffer.from(await native.arrayBuffer());assert(bytes.length<=262144);
    if(loseProposal&&command.operation==='IDENTIFIED_SYSTEM_PROPOSE'){
     assert.equal(native.status,200);loseProposal=false;lostNativeResponse={operation:command.operation,requestId:command.requestId,status:native.status,body:JSON.parse(bytes.toString()),acceptedAt:new Date().toISOString()};
     res.destroy();return;
    }
    res.writeHead(native.status,{'content-type':'application/json'});res.end(bytes);
   }catch{if(!res.headersSent)res.writeHead(502,{'content-type':'application/json'});if(!res.writableEnded)res.end('{"error":"Disposable native transport unavailable"}');}
  });
  await new Promise<void>(yes=>proxy!.listen(0,'127.0.0.1',yes));const address=proxy.address();assert(address&&typeof address!=='string');
  proxyEndpoint='http://127.0.0.1:'+address.port;await bind();
  const request={identificationId,modelId:model.id};
  const proposalInput={...request,idempotencyKey:randomUUID()},lost=await api('author','s8-propose',proposalInput);
  assert(lost.status>=500&&lost.status<600,JSON.stringify(lost));assert(lostNativeResponse,'Loss must follow actual native acceptance');
  const pending=(await e.admin.query("SELECT kind,body FROM finnor_os.x4_events WHERE tenant_id=$1 AND identification_id=$2 AND idempotency_key=ANY($3::text[])",
   [tenant,identificationId,['s8-proposal-register:'+proposalInput.idempotencyKey,'s8-propose:'+proposalInput.idempotencyKey]])).rows;
  assert.equal(pending.length,1);assert.equal(pending[0].kind,'S8_PROPOSAL_REGISTERED');
  const nativeBefore=ok(await call('reader','READ',{}));assert.equal(nativeBefore.history.filter((v:any)=>v.operation==='IDENTIFIED_SYSTEM_PROPOSE').length,1);
  const concurrent=await Promise.all([api('author','s8-propose',proposalInput),api('author','s8-propose',proposalInput)]);
  const proposed=ok(concurrent[0]),candidate=proposed.candidate;assert.deepEqual(ok(concurrent[1]),proposed);
  assert.equal(candidate.ref.id,pending[0].body.candidate.ref.id);
  const nativeAfter=ok(await call('reader','READ',{}));assert.equal(nativeAfter.history.filter((v:any)=>v.operation==='IDENTIFIED_SYSTEM_PROPOSE').length,1);
  const proposalRows=(await e.admin.query("SELECT kind,body FROM finnor_os.x4_events WHERE tenant_id=$1 AND identification_id=$2 AND idempotency_key=ANY($3::text[])",
   [tenant,identificationId,['s8-proposal-register:'+proposalInput.idempotencyKey,'s8-propose:'+proposalInput.idempotencyKey]])).rows;
  assert.equal(proposalRows.length,2);assert(proposalRows.every((v:any)=>v.body.candidate.ref.id===candidate.ref.id));
  assert.deepEqual(ok(await api('author','s8-propose',proposalInput)),proposed);
  const before=ok(await call('consumer','IDENTIFIED_SYSTEM_CURRENT',{revisionRef:candidate.ref}));assert.equal(before.current,false);
  const protocol={schema:'finnor.s8.identified-system-protocol.v1',revisionRef:candidate.ref,evaluatorId:people.replicator,nativeAssignmentId:assignment.id,
   assignmentDigest,payloadDigest:digest(candidate.payload),domainDigest:digest(candidate.domain),registeredAt:new Date().toISOString(),nativeRegisteredAt:experiment.created_at.toISOString(),
   qualification:'PREEXISTING_PREREGISTERED_NATIVE_REPLICATION_DEVELOPMENT_NOT_PROTECTED'};
  const denied=await call('proposer','IDENTIFIED_SYSTEM_REGISTER',service.signed(protocol,'evaluator'));assert.equal(denied.status,403);
  const registered=ok(await call('evaluator','IDENTIFIED_SYSTEM_REGISTER',service.signed(protocol,'evaluator')));
  const evaluation={schema:'finnor.s8.identified-system-evaluation.v1',revisionRef:candidate.ref,protocolRef:registered.ref,evaluatorId:people.replicator,nativeAssignmentId:assignment.id,
   assignmentDigest,payloadDigest:digest(candidate.payload),domainDigest:digest(candidate.domain),resultsDigest,completedAt:new Date().toISOString(),disposition:'SUPPORTED_DEVELOPMENT',protectedAdmission:false};
  const self=await call('proposer','IDENTIFIED_SYSTEM_EVALUATE',service.signed(evaluation,'evaluator'));assert.equal(self.status,403);
  const substituted=await call('evaluator','IDENTIFIED_SYSTEM_EVALUATE',service.signed({...evaluation,resultsDigest:'0'.repeat(64)},'evaluator'));
  assert.equal(substituted.status,409);assert.equal(substituted.body.code,'S8_IDENTIFIED_SYSTEM_EVALUATION_BINDING');
  const evaluated=ok(await call('evaluator','IDENTIFIED_SYSTEM_EVALUATE',service.signed(evaluation,'evaluator')));
  const admitted=ok(await call('promoter','IDENTIFIED_SYSTEM_ADMIT',service.signed({schema:'finnor.s8.identified-system-admission.v1',revisionRef:candidate.ref,evaluationRef:evaluated.ref,
   payloadDigest:digest(candidate.payload),domainDigest:digest(candidate.domain),protectionDomain:'DISPOSABLE_TEST_AUTHORITY',protectedAdmission:false,executionAuthorityGranted:false},'promoter')));
  const current=ok(await api('author','admission',{...request,revisionRef:candidate.ref}));assert.equal(current.current,true);assert.equal(current.executionAuthorityGranted,false);
  await service.stop();await service.start();await bind();
  const replay=ok(await api('author','admission',{...request,revisionRef:candidate.ref}));assert.equal(replay.current,true);
  Object.assign(report,{proposed,concurrentProposalSameImmutableIdentity:true,proposalRows,lostResponse:{lost,lostNativeResponse,pending,nativeProposalCountBefore:1,nativeProposalCountAfter:1,
   actualNativeAcceptanceBeforeDroppedResponse:true,syntheticLifecycleResponses:0},before,denied,registered,self,substituted,evaluated,admitted,current,replay,actualProcessRestart:true});
  await artifact(evidence,'s8.json',report);
  return {close,afterNativeInvalidation:async()=>{
   const native=ok(await api('author','admission',{...request,revisionRef:candidate.ref}));assert.equal(native.current,false);
   const revoked=ok(await call('promoter','IDENTIFIED_SYSTEM_REVOKE',service.signed({schema:'finnor.s8.identified-system-revocation.v1',revisionRef:candidate.ref,expectedAdmissionRef:admitted.ref,reason:'Retain native dependency invalidation and revoke future admission'},'promoter')));
   await service.stop();await service.start();await bind();
   const cold=ok(await call('consumer','IDENTIFIED_SYSTEM_CURRENT',{revisionRef:candidate.ref}));assert.equal(cold.current,false);assert.equal(cold.candidate,null);
   const history=ok(await call('reader','READ',{}));assert(history.history.some((v:any)=>v.operation==='IDENTIFIED_SYSTEM_ADMIT'));assert(history.history.some((v:any)=>v.operation==='IDENTIFIED_SYSTEM_REVOKE'));
   report.nativeInvalidation={native,revoked,cold,history,stickyAfterColdRestart:true};await artifact(evidence,'s8.json',report);return report.nativeInvalidation;
  }};
 }catch(error){await artifact(evidence,'s8-failure.json',{error:String(error),stack:(error as Error).stack});await close();throw error;}
}
