import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createServer,type Server} from 'node:http';
import {uniformAlgorithmSourcePaths} from '../../../packages/capability-evolution/src/source-closure';
import {digest,byteDigest} from '../../../packages/capability-evolution/src/contracts';
import {createCapabilityLifecycle} from '../../s8/lifecycle-fixture.mts';
import {createEconomicLedger} from '../../s7/ledger-fixture.mts';
import {lifecycleCall} from '../../x3/s8-installed.mts';

export async function verifyUniformS8(f:{
 env:any;evidence:string;tenant:string;principal:string;evaluator:string;discoveryId:string;assignment:any;
 api:(role:'owner'|'evaluator',operation:string,body:unknown)=>Promise<{status:number;body:any}>;
 artifact:(name:string,value:unknown)=>Promise<void>;builtApi:boolean;
}){
 const ok=(r:{status:number;body:any})=>{assert.equal(r.status,200,JSON.stringify(r));return r.body;};
 const original=(await f.env.admin.query('SELECT binding FROM finnor_os.y5_discoveries WHERE tenant_id=$1 AND id=$2',[f.tenant,f.discoveryId])).rows[0].binding;
 const rightsRef=digest({rightsRef:original.originalProblem.mandate.rightsRef,authorityRevision:original.authorityRevision,work:original.work});
 const sourcePins=await Promise.all((await uniformAlgorithmSourcePaths()).map(async path=>({path,sha256:byteDigest(await readFile(path))})));
 assert(sourcePins.length<=256);
 const names=['FINNOR_S8_UNIFORM_ALGORITHM_CONSUMER_CONFIG','FINNOR_S8_UNIFORM_ALGORITHM_CONSUMER_ROOT','FINNOR_S6_OWNER_TRANSPORT_CONFIG','FINNOR_S6_OWNER_TRANSPORT_ROOT'];
 const previous=Object.fromEntries(names.map(name=>[name,process.env[name]]));
 const ledger=await createEconomicLedger(f.tenant,f.principal,randomUUID(),{capabilityLifecycle:true,rightsRef,financialPrincipal:f.evaluator});
 const service=await createCapabilityLifecycle({tenant:f.tenant,principal:f.principal,evaluator:f.evaluator,promoter:randomUUID(),rightsRef,sourcePins});
 let proxy:Server|undefined,closed=false;
 const close=async()=>{if(closed)return;closed=true;try{
  proxy?.closeAllConnections();if(proxy?.listening)await new Promise<void>(yes=>proxy!.close(()=>yes()));
  await service.stop();await ledger.stop();
 }finally{for(const name of names){if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name];}}};
 const report:any={schema:'finnor.y5.s8-e2e.v1',scope:'SIGNED_DISPOSABLE_ENGINEERING_NOT_PROTECTED_CUSTODY',sourcePins,
  protectedAdmission:false,productionActive:false,executionAuthorityGranted:false};
 try{
  const configuration=JSON.parse(await readFile(service.configPath,'utf8'));
  configuration.signedPolicy=service.signed({...service.policy,actors:service.policy.actors.map(a=>a.id==='proposer'?{...a,roles:['PROPOSER','CONSUMER']}:a)},'release');
  await writeFile(service.configPath,JSON.stringify(configuration),{mode:0o600});
  const tokenPath=join(service.root,'uniform-proposer.token'),configPath=join(service.root,'uniform-consumer.json');
  await writeFile(tokenPath,service.tokens.proposer!,{mode:0o600});await service.start();
  let lose=true,lostAcceptance:any;
  proxy=createServer(async(req,res)=>{
   try{
    assert.equal(req.method,'POST');assert.equal(req.url,'/command');
    const chunks:Buffer[]=[];let size=0;
    for await(const chunk of req){size+=chunk.length;assert(size<=262144);chunks.push(chunk);}
    const bytes=Buffer.concat(chunks),command=JSON.parse(bytes.toString());
    const real=await fetch(service.endpoint()+'/command',{method:'POST',headers:{authorization:String(req.headers.authorization??''),'content-type':'application/json'},
     body:bytes,redirect:'error',signal:AbortSignal.timeout(30000)});
    const answer=Buffer.from(await real.arrayBuffer());assert(answer.length<=262144);
    if(lose&&command.operation==='UNIFORM_ALGORITHM_PROPOSE'){
     assert.equal(real.status,200);lose=false;lostAcceptance={requestId:command.requestId,body:JSON.parse(answer.toString()),actualNativeAcceptance:true};res.destroy();return;
    }
    res.writeHead(real.status,{'content-type':'application/json'});res.end(answer);
   }catch{if(!res.headersSent)res.writeHead(502);if(!res.writableEnded)res.end('{"code":"DISPOSABLE_TRANSPORT_UNAVAILABLE"}');}
  });
  await new Promise<void>(yes=>proxy!.listen(0,'127.0.0.1',yes));const address=proxy.address();assert(address&&typeof address!=='string');
  const bind=async()=>{
   const policy={schema:'finnor.s8.uniform-algorithm-consumer-policy.v1',domain:'DISPOSABLE_TEST_AUTHORITY',tenantId:f.tenant,principalId:f.principal,rightsRef,
    endpoint:'http://127.0.0.1:'+address.port,tokenPath,tokenHash:byteDigest(service.tokens.proposer!),sourcePins,validAfter:service.after,validUntil:service.until,timeoutMs:30000};
   await writeFile(configPath,JSON.stringify(service.signed(policy,'release')),{mode:0o600});
   process.env[names[0]!]=configPath;process.env[names[1]!]=service.pub('release');if(f.builtApi)await f.env.http.restartApi();
  };
  await bind();
  const call=(role:string,operation:string,body:unknown)=>lifecycleCall(service,role,operation,body);
  const request={discoveryId:f.discoveryId,idempotencyKey:'s8-original-proposal'};
  const lost=await f.api('owner','s8-propose',request);assert(lost.status>=500&&lost.status<600,JSON.stringify(lost));assert(lostAcceptance);
  const pending=(await f.env.admin.query("SELECT kind,body FROM finnor_os.y5_events WHERE tenant_id=$1 AND discovery_id=$2 AND event_key=$3",
   [f.tenant,f.discoveryId,'s8-proposal-register:'+request.idempotencyKey])).rows;
  assert.equal(pending.length,1);
  const retry=await Promise.all([f.api('owner','s8-propose',request),f.api('owner','s8-propose',request)]);
  const proposed=ok(retry[0]!),candidate=proposed.candidate;assert.deepEqual(ok(retry[1]!),proposed);
  assert.equal(pending[0].body.candidate.ref.id,candidate.ref.id);
  const history=ok(await call('reader','READ',{}));assert.equal(history.history.filter((r:any)=>r.operation==='UNIFORM_ALGORITHM_PROPOSE').length,1);
  const before=ok(await call('consumer','UNIFORM_ALGORITHM_CURRENT',{revisionRef:candidate.ref}));assert.equal(before.current,false);
  const protocol={schema:'finnor.s8.uniform-algorithm-protocol.v1',revisionRef:candidate.ref,evaluatorId:f.evaluator,nativeEvaluationId:f.assignment.evaluationId,
   assignmentDigest:f.assignment.assignmentDigest,payloadDigest:digest(candidate.payload),domainDigest:digest(candidate.domain),registeredAt:new Date().toISOString(),
   qualification:'PREREGISTERED_PUBLIC_NATIVE_KERNEL_AND_ORIGINAL_S5_REPLAY_NOT_PROTECTED'};
  const self=await call('proposer','UNIFORM_ALGORITHM_REGISTER',service.signed(protocol,'evaluator'));assert.equal(self.status,403);
  const preconsumedAssignment=ok(await f.api('owner','assign-evaluation',{discoveryId:f.discoveryId,evaluatorId:f.evaluator,idempotencyKey:'s8-owner-preconsume'}));
  const allocation=(await f.env.admin.query('SELECT request FROM finnor_os.y5_discoveries WHERE tenant_id=$1 AND id=$2',[f.tenant,f.discoveryId])).rows[0].request.allocation;
  const preconsumedInput={discoveryId:f.discoveryId,allocation,idempotencyKey:'independent-evaluation:'+preconsumedAssignment.evaluationId,fallback:'NONE'};
  const preconsumedUse=await f.api('owner','consume',preconsumedInput);
  assert.equal(preconsumedUse.status,403,JSON.stringify(preconsumedUse));assert.equal(preconsumedUse.body.code,'Y5_RESERVED_EVALUATION_USE_KEY');
  const reservedUses=(await f.env.admin.query('SELECT count(*)::int AS n FROM finnor_os.y5_uses WHERE tenant_id=$1 AND discovery_id=$2 AND idempotency_key=$3',
   [f.tenant,f.discoveryId,preconsumedInput.idempotencyKey])).rows[0].n;
  assert.equal(reservedUses,0);
  report.ownerPreconsume={assignment:preconsumedAssignment,input:preconsumedInput,refusal:preconsumedUse,reservedUses};
  const registered=ok(await call('evaluator','UNIFORM_ALGORITHM_REGISTER',service.signed(protocol,'evaluator')));
  const native=ok(await f.api('evaluator','evaluate',{evaluationId:f.assignment.evaluationId}));
  await f.artifact('independent-native-evaluation.json',native);assert.equal(native.disposition,'SUPPORTED_DEVELOPMENT');
  const evaluation={schema:'finnor.s8.uniform-algorithm-evaluation.v1',revisionRef:candidate.ref,protocolRef:registered.ref,evaluatorId:f.evaluator,
   nativeEvaluationId:f.assignment.evaluationId,assignmentDigest:f.assignment.assignmentDigest,payloadDigest:digest(candidate.payload),domainDigest:digest(candidate.domain),
   resultsDigest:digest(native),completedAt:native.completedAt,disposition:native.disposition,protectedAdmission:false};
  const substitute=await call('evaluator','UNIFORM_ALGORITHM_EVALUATE',service.signed({...evaluation,resultsDigest:'0'.repeat(64)},'evaluator'));
  assert.equal(substitute.status,409);assert.equal(substitute.body.code,'S8_UNIFORM_ALGORITHM_EVALUATION_BINDING');
  const evaluated=ok(await call('evaluator','UNIFORM_ALGORITHM_EVALUATE',service.signed(evaluation,'evaluator')));
  const admission={schema:'finnor.s8.uniform-algorithm-admission.v1',revisionRef:candidate.ref,evaluationRef:evaluated.ref,payloadDigest:digest(candidate.payload),
   domainDigest:digest(candidate.domain),protectionDomain:'DISPOSABLE_TEST_AUTHORITY',protectedAdmission:false,executionAuthorityGranted:false};
  const selfAdmission=await call('proposer','UNIFORM_ALGORITHM_ADMIT',service.signed(admission,'promoter'));assert.equal(selfAdmission.status,403);
  const admitted=ok(await call('promoter','UNIFORM_ALGORITHM_ADMIT',service.signed(admission,'promoter')));
  const current=ok(await f.api('owner','admission',{discoveryId:f.discoveryId,revisionRef:candidate.ref}));assert.equal(current.current,true);
  await service.stop();await service.start();await bind();
  const replay=ok(await f.api('owner','admission',{discoveryId:f.discoveryId,revisionRef:candidate.ref}));assert.equal(replay.current,true);
  Object.assign(report,{lost,lostAcceptance,pending,oneNativeProposal:true,concurrentSameOriginal:true,proposed,before,self,registered,native,substitute,evaluated,selfAdmission,admitted,current,replay,
   ownerPreconsumeRefused:preconsumedUse.status});
  await f.artifact('s8.json',report);
  return {evaluation:native,close,afterNativeInvalidation:async()=>{
   const blocked=await f.api('owner','admission',{discoveryId:f.discoveryId,revisionRef:candidate.ref});assert.equal(blocked.status,409);
   const cold=ok(await call('consumer','UNIFORM_ALGORITHM_CURRENT',{revisionRef:candidate.ref}));assert.equal(cold.current,false);assert.equal(cold.candidate,null);
   const revoked=ok(await call('promoter','UNIFORM_ALGORITHM_REVOKE',service.signed({schema:'finnor.s8.uniform-algorithm-revocation.v1',revisionRef:candidate.ref,
    expectedAdmissionRef:admitted.ref,reason:'Native invalidation retains proof and costs but withdraws future uses'},'promoter')));
   await service.stop();await service.start();await bind();
   const sticky=ok(await call('consumer','UNIFORM_ALGORITHM_CURRENT',{revisionRef:candidate.ref}));assert.equal(sticky.current,false);
   const retained=ok(await call('reader','READ',{}));assert(retained.history.some((r:any)=>r.operation==='UNIFORM_ALGORITHM_ADMIT'));assert(retained.history.some((r:any)=>r.operation==='UNIFORM_ALGORITHM_REVOKE'));
   report.invalidation={blocked,cold,revoked,sticky,historyRetained:true};report.status='PASS';await f.artifact('s8.json',report);
  }};
 }catch(error){await f.artifact('s8-failure.json',{error:String(error),stack:(error as Error).stack,report});await close();throw error;}
}
