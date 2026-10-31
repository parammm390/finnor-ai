import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createServer,type Server} from 'node:http';

const root=resolve(import.meta.dirname,'../../../..'),os=join(root,'finnor-os');
const evidence=resolve(process.env.FINNOR_Y5_EVIDENCE_DIR??join(root,'evidence/y5-total-s8'));
const artifact=async(name:string,value:unknown)=>{
 const path=join(evidence,'total-s8',name);await mkdir(resolve(path,'..'),{recursive:true,mode:0o700});
 await writeFile(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});
};
if(process.argv.includes('--preflight')){
 try{
  await import(new URL('../../../packages/private-equity/src/uniform-algorithms/total-admission.ts',import.meta.url).href);
  await artifact('preflight.json',{status:'MODULE_PRESENT_NOT_NATIVE_VERIFIED'});
 }catch(error){await artifact('preflight.json',{status:'FAIL',error:String(error),stack:(error as Error).stack});throw error;}
}
if(process.argv.includes('--run')){
 const started=Date.now();
 await assert.rejects(readFile(join(evidence,'total-s8/results.json')),{code:'ENOENT'},'A fresh evidence directory is required');
 const flags=['--built-api','--installed-worker'].filter(flag=>process.argv.includes(flag));
 await artifact('registered-run.json',{schema:'finnor.y5.total-s8-registered-run.v2',startedAt:new Date(started).toISOString(),
  contract:'scope-postx/y5-uniform-algorithm-discovery/total-admission-contract.md',timeoutMs:420000,
  command:'node_modules/.bin/tsx scripts/postx/y5/verify-total-s8.mts --run '+flags.join(' '),requiredOwnerHook:'--with-total-s8',
  protectedAdmission:false,productionActive:false,executionAuthorityGranted:false});
 const child=spawnSync(process.execPath,['--import=tsx',join(os,'scripts/postx/y5/verify-total-owner.mts'),'--with-total-s8',...flags],{
  cwd:os,env:{...process.env,FINNOR_Y5_EVIDENCE_DIR:evidence,FINNOR_Y5_TOTAL_S8_REQUIRED:'1'},encoding:'utf8',timeout:420000,maxBuffer:1048576});
 await artifact('owner-process.json',{status:child.status,signal:child.signal,stdout:child.stdout,stderr:child.stderr});
 assert.equal(child.status,0,child.stderr);
 const result=JSON.parse(await readFile(join(evidence,'total-s8/results.json'),'utf8'));
 assert.equal(result.status,'PASS','Owner hook must actually execute the total S8 extension');
 console.log(JSON.stringify({status:'PASS',evidence,wallMs:Date.now()-started,qualification:'DISPOSABLE_NOT_PROTECTED'}));
}

export async function verifyTotalS8(f:{
 env:any;evidence:string;tenant:string;principal:string;evaluator:string;discoveryId:string;
 api:(role:'owner'|'evaluator',operation:string,body:unknown)=>Promise<{status:number;body:any}>;
 artifact:(name:string,value:unknown)=>Promise<void>;builtApi:boolean;
}){
 const {uniformAlgorithmSourcePaths,requiredCapabilitySourcePaths}=await import('../../../packages/capability-evolution/src/source-closure');
 const {digest,byteDigest}=await import('../../../packages/capability-evolution/src/contracts');
 const {createCapabilityLifecycle}=await import('../../s8/lifecycle-fixture.mts');
 const {createEconomicLedger}=await import('../../s7/ledger-fixture.mts');
 const {lifecycleCall}=await import('../../x3/s8-installed.mts');
 const {totalUniformPayload}=await import('../../../packages/private-equity/src/uniform-algorithms/total-admission');
 const save=(name:string,value:unknown)=>f.artifact('total-s8/'+name,value);
 const ok=(r:{status:number;body:any})=>{assert.equal(r.status,200,JSON.stringify(r));return r.body;};
 const read=ok(await f.api('owner','read',{discoveryId:f.discoveryId,includeCapsule:true}));
 assert.equal(read.capsule.schema,'finnor.algorithm-theory-capsule.v2');
 const row=(await f.env.admin.query('SELECT * FROM finnor_os.y5_discoveries WHERE tenant_id=$1 AND id=$2',[f.tenant,f.discoveryId])).rows[0];
 const payload=totalUniformPayload(row,read.capsule),rightsRef=payload.rightsDigest;
 const pinsFor=async(paths:string[])=>{
  const pins:Array<{path:string;sha256:string}>=[];
  for(let offset=0;offset<paths.length;offset+=16){
   const batch=await Promise.allSettled(paths.slice(offset,offset+16).map(async path=>({path,sha256:byteDigest(await readFile(path))})));
   for(const result of batch){if(result.status==='rejected')throw result.reason;pins.push(result.value);}
  }
  return pins;
 };
 const sourcePins=await pinsFor(await uniformAlgorithmSourcePaths('TOTAL_V2')),basePins=await pinsFor(requiredCapabilitySourcePaths);
 assert(sourcePins.length>256&&sourcePins.length<=4096,'Exercise the actual larger complete closure');
 const names=['FINNOR_S8_UNIFORM_ALGORITHM_CONSUMER_CONFIG','FINNOR_S8_UNIFORM_ALGORITHM_CONSUMER_ROOT','FINNOR_S6_OWNER_TRANSPORT_CONFIG','FINNOR_S6_OWNER_TRANSPORT_ROOT'];
 const previous=Object.fromEntries(names.map(name=>[name,process.env[name]]));
 const ledger=await createEconomicLedger(f.tenant,f.principal,randomUUID(),{capabilityLifecycle:true,rightsRef,financialPrincipal:f.evaluator});
 const service=await createCapabilityLifecycle({tenant:f.tenant,principal:f.principal,evaluator:f.evaluator,promoter:randomUUID(),rightsRef,sourcePins:basePins,uniformAlgorithmOwner:true});
 let closed=false,proxy:Server|undefined;
 const close=async()=>{if(closed)return;closed=true;try{
  proxy?.closeAllConnections();if(proxy?.listening)await new Promise<void>(yes=>proxy!.close(()=>yes()));
  await service.stop();await ledger.stop();}
  finally{for(const name of names){if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name];}}};
 const report:any={schema:'finnor.y5.total-s8-e2e.v2',scope:'PREREGISTERED_DISPOSABLE_TYPED_THEORY_NOT_PROTECTED',
  sourcePins,basePins,protectedAdmission:false,productionActive:false,executionAuthorityGranted:false};
 try{
  const configuration=JSON.parse(await readFile(service.configPath,'utf8'));
  configuration.signedPolicy=service.signed({...service.policy,actors:service.policy.actors.map(a=>
   a.id==='proposer'?{...a,roles:['PROPOSER','CONSUMER']}:a)},'release');
  await writeFile(service.configPath,JSON.stringify(configuration),{mode:0o600});
  const tokenPath=join(service.root,'total-proposer.token'),configPath=join(service.root,'total-consumer.json');
  await writeFile(tokenPath,service.tokens.proposer!,{mode:0o600});await service.start();
  let lose=true,lostAcceptance:unknown=null;
  proxy=createServer(async(req,res)=>{
   try{
    assert.equal(req.method,'POST');assert.equal(req.url,'/command');
    const chunks:Buffer[]=[];let size=0;
    for await(const chunk of req){size+=chunk.length;assert(size<=2097152);chunks.push(chunk);}
    const bytes=Buffer.concat(chunks),command=JSON.parse(bytes.toString());
    const real=await fetch(service.endpoint()+'/command',{method:'POST',headers:{
     authorization:String(req.headers.authorization??''),'content-type':'application/json'},body:bytes,
     redirect:'error',signal:AbortSignal.timeout(28500)});
    const answer=Buffer.from(await real.arrayBuffer());assert(answer.length<=2097152);
    if(lose&&command.operation==='UNIFORM_ALGORITHM_PROPOSE'){
     assert.equal(real.status,200);lose=false;lostAcceptance={requestId:command.requestId,body:JSON.parse(answer.toString())};
     res.destroy();return;
    }
    res.writeHead(real.status,{'content-type':'application/json'});res.end(answer);
   }catch{if(!res.headersSent)res.writeHead(502);if(!res.writableEnded)res.end('{"code":"DISPOSABLE_TRANSPORT_UNAVAILABLE"}');}
  });
  await new Promise<void>(yes=>proxy!.listen(0,'127.0.0.1',yes));
  const address=proxy.address();assert(address&&typeof address!=='string');
  const bind=async(pins=sourcePins)=>{
   const policy={schema:'finnor.s8.uniform-algorithm-consumer-policy.v2',domain:'DISPOSABLE_TEST_AUTHORITY',
    profile:'CLOSED_TOTAL_FOLD_INTEGER_LISTS_V2',tenantId:f.tenant,principalId:f.principal,rightsRef,
    endpoint:'http://127.0.0.1:'+address.port,tokenPath,tokenHash:byteDigest(service.tokens.proposer!),sourcePins:pins,
    validAfter:service.after,validUntil:service.until,timeoutMs:28500};
   await writeFile(configPath,JSON.stringify(service.signed(policy,'release')),{mode:0o600});
   process.env[names[0]!]=configPath;process.env[names[1]!]=service.pub('release');
   if(f.builtApi)await f.env.http.restartApi();
  };
  await bind();
  // Native-proof resolution behind these calls shares the 28.5 s total-method invocation budget.
  const call=(role:string,operation:string,body:unknown)=>lifecycleCall(service,role,operation,body,28500);
  const selfAssignment=await f.api('owner','assign-evaluation',{discoveryId:f.discoveryId,evaluatorId:f.principal,idempotencyKey:'self-total'});
  assert.equal(selfAssignment.status,409);
  const assignment=ok(await f.api('owner','assign-evaluation',{discoveryId:f.discoveryId,evaluatorId:f.evaluator,idempotencyKey:'total-independent'}));
  const rowBefore=(await f.env.admin.query('SELECT * FROM finnor_os.y5_evaluations WHERE tenant_id=$1 AND id=$2',[f.tenant,assignment.evaluationId])).rows[0];
  assert.equal(rowBefore.result,null);assert.equal(rowBefore.assignment.schema,'finnor.y5.total-evaluation-assignment.v2');
  const reservedUse=await f.api('owner','consume-total',{discoveryId:f.discoveryId,taskWorkId:rowBefore.assignment.originalTaskWorkId,
   idempotencyKey:rowBefore.assignment.useIdempotencyKey});
  assert.equal(reservedUse.status,403,JSON.stringify(reservedUse));assert.equal(reservedUse.body.code,'Y5_RESERVED_EVALUATION_USE_KEY');
  assert.equal((await f.api('owner','evaluate',{evaluationId:assignment.evaluationId})).status,404);
  const proposalInput={discoveryId:f.discoveryId,idempotencyKey:'total-s8-proposal'};
  const lost=await f.api('owner','s8-propose',proposalInput);assert(lost.status>=500&&lost.status<600);assert(lostAcceptance);
  const proposals=await Promise.all([f.api('owner','s8-propose',proposalInput),f.api('owner','s8-propose',proposalInput)]);
  const proposed=ok(proposals[0]!),candidate=proposed.candidate;assert.deepEqual(ok(proposals[1]!),proposed);
  assert.equal(candidate.schema,'finnor.s8.uniform-algorithm-candidate.v2');
  assert.equal(candidate.dependencies.length,sourcePins.length);
  assert.deepEqual(ok(await f.api('owner','s8-propose',{discoveryId:f.discoveryId,idempotencyKey:'total-s8-proposal'})),proposed);
  const proposalHistory=ok(await call('reader','READ',{}));
  assert.equal(proposalHistory.history.filter((r:any)=>r.operation==='UNIFORM_ALGORITHM_PROPOSE').length,1);
  const protocol={schema:'finnor.s8.uniform-algorithm-protocol.v2',revisionRef:candidate.ref,evaluatorId:f.evaluator,
   nativeEvaluationId:assignment.evaluationId,assignmentDigest:assignment.assignmentDigest,payloadDigest:digest(candidate.payload),
   domainDigest:digest(candidate.domain),registeredAt:new Date().toISOString(),
   qualification:'PREREGISTERED_PUBLIC_NATIVE_KERNEL_AND_ORIGINAL_TYPED_TASK_NOT_PROTECTED'};
  assert.equal((await call('proposer','UNIFORM_ALGORITHM_REGISTER',service.signed(protocol,'evaluator'))).status,403);
  assert.equal((await call('evaluator','UNIFORM_ALGORITHM_REGISTER',service.signed({...protocol,schema:'finnor.s8.uniform-algorithm-protocol.v1'},'evaluator'))).status,400);
  const registered=ok(await call('evaluator','UNIFORM_ALGORITHM_REGISTER',service.signed(protocol,'evaluator')));
  const unregistered=ok(await f.api('owner','s8-propose',{discoveryId:f.discoveryId,idempotencyKey:'unregistered-before-native'})).candidate;
  assert.notEqual(unregistered.ref.id,candidate.ref.id);
  const usesBefore=Number((await f.env.admin.query('SELECT use_count FROM finnor_os.y5_discoveries WHERE tenant_id=$1 AND id=$2',[f.tenant,f.discoveryId])).rows[0].use_count);
  const attempts=await Promise.all([f.api('evaluator','evaluate',{evaluationId:assignment.evaluationId}),
   f.api('evaluator','evaluate',{evaluationId:assignment.evaluationId})]);
  const observations=attempts.map(ok),native=observations.find(r=>r.disposition==='SUPPORTED_DEVELOPMENT');
  assert(native,JSON.stringify(observations));
  assert(observations.every(r=>r.status==='UNKNOWN'||digest(r)===digest(native)));
  assert.equal(native.schema,'finnor.y5.independent-total-evaluation.v2');assert.equal(native.disposition,'SUPPORTED_DEVELOPMENT');
  assert.equal(native.oracle.feasible,true);assert.equal(native.oracle.includesEmptyPrefix,true);
  assert.equal(ok(await f.api('evaluator','evaluate',{evaluationId:assignment.evaluationId})).useDigest,native.useDigest);
  const usesAfter=Number((await f.env.admin.query('SELECT use_count FROM finnor_os.y5_discoveries WHERE tenant_id=$1 AND id=$2',[f.tenant,f.discoveryId])).rows[0].use_count);
  assert.equal(usesAfter,usesBefore+1);
  const lateCandidate=ok(await f.api('owner','s8-propose',{discoveryId:f.discoveryId,idempotencyKey:'late-total-protocol'})).candidate;
  const lateProtocol={...protocol,revisionRef:lateCandidate.ref,payloadDigest:digest(lateCandidate.payload),
   domainDigest:digest(lateCandidate.domain),registeredAt:new Date().toISOString()};
  assert.equal((await call('evaluator','UNIFORM_ALGORITHM_REGISTER',service.signed(lateProtocol,'evaluator'))).status,409);
  const backdatedProtocol={...protocol,revisionRef:unregistered.ref,payloadDigest:digest(unregistered.payload),
   domainDigest:digest(unregistered.domain),registeredAt:unregistered.proposedAt};
  const backdated=await call('evaluator','UNIFORM_ALGORITHM_REGISTER',service.signed(backdatedProtocol,'evaluator'));
  assert.equal(backdated.status,409,JSON.stringify(backdated));
  const evaluation={schema:'finnor.s8.uniform-algorithm-evaluation.v2',revisionRef:candidate.ref,protocolRef:registered.ref,
   evaluatorId:f.evaluator,nativeEvaluationId:assignment.evaluationId,assignmentDigest:assignment.assignmentDigest,
   payloadDigest:digest(candidate.payload),domainDigest:digest(candidate.domain),resultsDigest:digest(native),
   completedAt:native.completedAt,disposition:native.disposition,protectedAdmission:false};
  assert.equal((await call('evaluator','UNIFORM_ALGORITHM_EVALUATE',service.signed({...evaluation,resultsDigest:'0'.repeat(64)},'evaluator'))).status,409);
  const evaluated=ok(await call('evaluator','UNIFORM_ALGORITHM_EVALUATE',service.signed(evaluation,'evaluator')));
  const admission={schema:'finnor.s8.uniform-algorithm-admission.v2',revisionRef:candidate.ref,evaluationRef:evaluated.ref,
   payloadDigest:digest(candidate.payload),domainDigest:digest(candidate.domain),protectionDomain:'DISPOSABLE_TEST_AUTHORITY',
   protectedAdmission:false,executionAuthorityGranted:false};
  assert.equal((await call('proposer','UNIFORM_ALGORITHM_ADMIT',service.signed(admission,'promoter'))).status,403);
  const admitted=ok(await call('promoter','UNIFORM_ALGORITHM_ADMIT',service.signed(admission,'promoter')));
  const current=ok(await f.api('owner','admission',{discoveryId:f.discoveryId,revisionRef:candidate.ref}));
  assert.equal(current.current,true);assert.equal(current.protectedAdmission,false);assert.equal(current.executionAuthorityGranted,false);
  const missing=sourcePins.slice(1);await bind(missing);
  assert.notEqual((await f.api('owner','admission',{discoveryId:f.discoveryId,revisionRef:candidate.ref})).status,200);
  await bind();await service.stop();await service.start();await bind();
  assert.equal(ok(await f.api('owner','admission',{discoveryId:f.discoveryId,revisionRef:candidate.ref})).current,true);
  Object.assign(report,{selfAssignment,assignment,lost,lostAcceptance,registered,native,concurrentEvaluation:observations,
   evaluated,admitted,current,usesBefore,usesAfter,postHocProtocolRefused:true,backdatedProtocolRefused:backdated.status,
   reservedEvaluationUseRefused:reservedUse.status,
   rerun:'FINNOR_Y5_EVIDENCE_DIR=<fresh> node_modules/.bin/tsx scripts/postx/y5/verify-total-s8.mts --run'});
  await save('registered-and-evaluated.json',report);
  return {close,useDigest:native.useDigest,afterNativeInvalidation:async()=>{
   assert.equal((await f.api('owner','admission',{discoveryId:f.discoveryId,revisionRef:candidate.ref})).status,409);
   const cold=ok(await call('consumer','UNIFORM_ALGORITHM_CURRENT',{revisionRef:candidate.ref}));assert.equal(cold.current,false);
   const revoked=ok(await call('promoter','UNIFORM_ALGORITHM_REVOKE',service.signed({schema:'finnor.s8.uniform-algorithm-revocation.v2',
    revisionRef:candidate.ref,expectedAdmissionRef:admitted.ref,reason:'P7 invalidation retains typed proof and cost history'},'promoter')));
   await service.stop();await service.start();await bind();
   assert.equal(ok(await call('consumer','UNIFORM_ALGORITHM_CURRENT',{revisionRef:candidate.ref})).current,false);
   const history=ok(await call('reader','READ',{}));assert(history.history.some((e:any)=>e.operation==='UNIFORM_ALGORITHM_ADMIT'));
   Object.assign(report,{status:'PASS',invalidation:{cold,revoked,stickyAfterRestart:true},historyRetained:true});
   await save('results.json',report);
  }};
 }catch(error){await save('failure.json',{status:'FAIL',error:String(error),stack:(error as Error).stack,report});await close();throw error;}
}
