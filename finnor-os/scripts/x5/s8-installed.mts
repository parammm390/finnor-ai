/** Real signed S8 journal, resolved X5 native proof and cold replay.
 * Every signer is disposable builder-controlled development authority. */
import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {requiredCapabilitySourcePaths} from '../../packages/capability-evolution/src/source-closure';
import {digest} from '../../packages/capability-evolution/src/contracts';
import {applicationDigest} from '../../packages/private-equity/src/enterprise-applications/contracts';
import {createCapabilityLifecycle} from '../s8/lifecycle-fixture.mts';
import {createEconomicLedger} from '../s7/ledger-fixture.mts';
import {lifecycleCall} from '../x3/s8-installed.mts';
import {artifact,hash} from '../x3/environment.mts';

export async function learningS8Proof(f:{
 e:any;evidence:string;tenant:string;people:Record<string,string>;compilation:any;evaluation:any;
 learn:(who:string,operation:string,body:unknown)=>Promise<any>;
}){
 const {e,evidence,tenant,people,compilation,evaluation,learn}=f;
 const ok=(r:any)=>{assert.equal(r.status,200,JSON.stringify(r));return r.body;};
 const pins=await Promise.all(requiredCapabilitySourcePaths.map(async path=>({path,sha256:hash(await readFile(path))})));
 assert(pins.length<=128);
 const names=['FINNOR_S6_OWNER_TRANSPORT_CONFIG','FINNOR_S6_OWNER_TRANSPORT_ROOT','FINNOR_S8_LEARNED_POLICY_CONSUMER_CONFIG','FINNOR_S8_LEARNED_POLICY_CONSUMER_ROOT'];
 const previous=Object.fromEntries(names.map(name=>[name,process.env[name]]));
 const restore=()=>{for(const name of names){if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name];}};
 const rights=(await e.admin.query('SELECT body FROM finnor_os.x5_releases WHERE tenant_id=$1 AND id=$2',[tenant,compilation.headReleaseId])).rows[0].body.experience.records.map((v:any)=>v.consentRef);
 const rightsRef=applicationDigest(rights);
 const ledger=await createEconomicLedger(tenant,people.analyst!,randomUUID(),{capabilityLifecycle:true,rightsRef,financialPrincipal:people.evaluator}).catch(error=>{restore();throw error;});
 const service=await createCapabilityLifecycle({tenant,principal:people.analyst!,evaluator:people.evaluator!,promoter:randomUUID(),rightsRef,sourcePins:pins})
  .catch(async error=>{try{await ledger.stop();}finally{restore();}throw error;});
 const tokenPath=join(service.root,'learning-proposer.token'),configPath=join(service.root,'learning-consumer.json');
 const config={schema:'finnor.s8.learned-policy-consumer-policy.v1',domain:'DISPOSABLE_TEST_AUTHORITY',tenantId:tenant,principalId:people.analyst!,rightsRef,
  endpoint:'',tokenPath,tokenHash:hash(service.tokens.proposer!),sourcePins:pins,validAfter:service.after,validUntil:service.until,timeoutMs:10000};
 const bind=async()=>{
  config.endpoint=service.endpoint();
  await writeFile(configPath,JSON.stringify(service.signed(config,'release')),{mode:0o600});
  process.env.FINNOR_S8_LEARNED_POLICY_CONSUMER_CONFIG=configPath;process.env.FINNOR_S8_LEARNED_POLICY_CONSUMER_ROOT=service.pub('release');
  if(process.env.FINNOR_X5_BUILT_API==='1')await e.http.restartApi();
 };
 const call=(role:string,operation:string,body:unknown)=>lifecycleCall(service,role,operation,body);
 const request={compilationId:compilation.compilationId,releaseId:compilation.headReleaseId};
 const report:any={schema:'finnor.x5.typed-s8-development-proof.v1',sourcePins:pins,protectedAdmission:false,productionActive:false,
  qualification:'ACTUAL_SIGNED_DISPOSABLE_ROLE_CURRENTNESS_AND_REPLAY_NOT_PROTECTED_INDEPENDENCE'};
 let closed=false;
 const close=async()=>{
  if(closed)return;closed=true;
  try{await service.stop();}finally{try{await ledger.stop();}finally{restore();}}
 };
 try{
  const configuration=JSON.parse(await readFile(service.configPath,'utf8'));
  configuration.signedPolicy=service.signed({...service.policy,actors:service.policy.actors.map(a=>a.id==='proposer'?{...a,roles:['PROPOSER','CONSUMER']}:a)},'release');
  await writeFile(service.configPath,JSON.stringify(configuration),{mode:0o600});
  await writeFile(tokenPath,service.tokens.proposer!,{mode:0o600});
  await service.start();await bind();
  const proposed=ok(await learn('analyst','s8-propose',{...request,controllerRevision:'TRAINED',idempotencyKey:randomUUID()})),candidate=proposed.candidate;
  const before=ok(await call('consumer','LEARNED_POLICY_CURRENT',{revisionRef:candidate.ref}));assert.equal(before.current,false);
  const protocolFor=(c:any)=>({schema:'finnor.s8.learned-policy-protocol.v1',revisionRef:c.ref,evaluatorId:people.evaluator,
   nativeEvaluationId:evaluation.id,assignmentDigest:evaluation.result.assignmentDigest,payloadDigest:digest(c.payload),domainDigest:digest(c.domain),
   registeredAt:new Date().toISOString(),qualification:'PUBLIC_DEVELOPMENT_32_SCENARIOS_FOUR_ARMS_NOT_PROTECTED'});
  const denied=await call('proposer','LEARNED_POLICY_REGISTER',service.signed(protocolFor(candidate),'evaluator'));assert.equal(denied.status,403);
  const registered=ok(await call('evaluator','LEARNED_POLICY_REGISTER',service.signed(protocolFor(candidate),'evaluator')));
  const evaluationFor=(c:any,ref:any,disposition:string)=>({schema:'finnor.s8.learned-policy-evaluation.v1',revisionRef:c.ref,protocolRef:ref,evaluatorId:people.evaluator,
   nativeEvaluationId:evaluation.id,assignmentDigest:evaluation.result.assignmentDigest,payloadDigest:digest(c.payload),domainDigest:digest(c.domain),
   // This is the native X5 commitment, not a reinterpretation through S8's
   // locale-sorted canonical encoder. The surrounding signed body is S8-owned.
   resultsDigest:applicationDigest(evaluation.result),completedAt:new Date().toISOString(),disposition,protectedAdmission:false});
  const self=await call('proposer','LEARNED_POLICY_EVALUATE',service.signed(evaluationFor(candidate,registered.ref,'SUPPORTED_DEVELOPMENT'),'evaluator'));assert.equal(self.status,403);
  const reencodedResults=await call('evaluator','LEARNED_POLICY_EVALUATE',service.signed({
   ...evaluationFor(candidate,registered.ref,'SUPPORTED_DEVELOPMENT'),resultsDigest:digest(evaluation.result),
  },'evaluator'));
  assert.equal(reencodedResults.status,409);assert.equal(reencodedResults.body.code,'S8_LEARNED_POLICY_EVALUATION_BINDING');
  const evaluated=ok(await call('evaluator','LEARNED_POLICY_EVALUATE',service.signed(evaluationFor(candidate,registered.ref,'SUPPORTED_DEVELOPMENT'),'evaluator')));
  const admissionFor=(c:any,ref:any)=>({schema:'finnor.s8.learned-policy-admission.v1',revisionRef:c.ref,evaluationRef:ref,payloadDigest:digest(c.payload),
   domainDigest:digest(c.domain),protectionDomain:'DISPOSABLE_TEST_AUTHORITY',protectedAdmission:false,executionAuthorityGranted:false});
  const admitted=ok(await call('promoter','LEARNED_POLICY_ADMIT',service.signed(admissionFor(candidate,evaluated.ref),'promoter')));
  const current=ok(await learn('analyst','admission',{...request,revisionRef:candidate.ref}));assert.equal(current.current,true);assert.equal(current.productionActive,false);
  const substitution=structuredClone(candidate);substitution.payload.checkpointDigest='0'.repeat(64);
  const substituted=await call('proposer','LEARNED_POLICY_PROPOSE',substitution);assert.equal(substituted.status,409);
  const wrongKind=structuredClone(candidate);wrongKind.payload.kind='EnterpriseApplicationPackage';
  const wrongArtifactKind=await call('proposer','LEARNED_POLICY_PROPOSE',wrongKind);assert(wrongArtifactKind.status>=400&&wrongArtifactKind.status<500);
  // The negative candidate is an immutable, separately named original checkpoint.
  // Its actual fixed-surrounding task failures are in the same native paired census.
  const harmful=ok(await learn('analyst','s8-propose',{...request,controllerRevision:'ORIGINAL_ABLATION',idempotencyKey:randomUUID()})),bad=harmful.candidate;
  assert.notEqual(bad.ref.contentDigest,candidate.ref.contentDigest);assert.equal(bad.payload.checkpointDigest,candidate.payload.originalCheckpointDigest);
  const harmfulRegistered=ok(await call('evaluator','LEARNED_POLICY_REGISTER',service.signed(protocolFor(bad),'evaluator')));
  const forgedSupported=await call('evaluator','LEARNED_POLICY_EVALUATE',service.signed(evaluationFor(bad,harmfulRegistered.ref,'SUPPORTED_DEVELOPMENT'),'evaluator'));
  assert.equal(forgedSupported.status,409);assert.equal(forgedSupported.body.code,'S8_LEARNED_POLICY_EVALUATION_BINDING');
  const harmfulEvaluated=ok(await call('evaluator','LEARNED_POLICY_EVALUATE',service.signed(evaluationFor(bad,harmfulRegistered.ref,'REFUSED_OR_INCOMPLETE'),'evaluator')));
  const harmfulAdmission=await call('promoter','LEARNED_POLICY_ADMIT',service.signed(admissionFor(bad,harmfulEvaluated.ref),'promoter'));
  assert.equal(harmfulAdmission.status,409);assert.equal(harmfulAdmission.body.code,'S8_LEARNED_POLICY_ADMISSION_BINDING');
  const harmfulCurrent=ok(await call('consumer','LEARNED_POLICY_CURRENT',{revisionRef:bad.ref}));assert.equal(harmfulCurrent.current,false);
  // Expire only a separate S8 key, not the tenant-wide native authority
  // revision. Removing and regranting native roles must not revive receipts.
  const ownerNames=names.slice(0,2),ownerPrior=Object.fromEntries(ownerNames.map(name=>[name,process.env[name]]));
  const expiryLedger=await createEconomicLedger(tenant,people.analyst!,randomUUID(),{capabilityLifecycle:true,rightsRef,financialPrincipal:people.evaluator});
  let expiryService:Awaited<ReturnType<typeof createCapabilityLifecycle>>|undefined,evaluatorExpired:any;
  let relay:ReturnType<typeof createServer>|undefined,releaseRelay:(()=>void)|undefined,transportHeld:Promise<PromiseSettledResult<any>[]>|undefined;
  try{
   expiryService=await createCapabilityLifecycle({tenant,principal:people.analyst!,evaluator:people.evaluator!,promoter:randomUUID(),rightsRef,sourcePins:pins});
   const shortUntil=new Date(Date.now()+12000).toISOString(),short=JSON.parse(await readFile(expiryService.configPath,'utf8'));
   short.signedPolicy=expiryService.signed({...expiryService.policy,evaluatorKeys:expiryService.policy.evaluatorKeys.map(key=>({...key,validUntil:shortUntil}))},'release');
   await writeFile(expiryService.configPath,JSON.stringify(short),{mode:0o600});await expiryService.start();
   const exp=expiryService,expiryCall=(role:string,operation:string,body:unknown)=>lifecycleCall(exp,role,operation,body);
   const expiryProposed=ok(await expiryCall('proposer','LEARNED_POLICY_PROPOSE',candidate));
   const expiryRegistered=ok(await expiryCall('evaluator','LEARNED_POLICY_REGISTER',exp.signed(protocolFor(candidate),'evaluator')));
   const expiryEvaluated=ok(await expiryCall('evaluator','LEARNED_POLICY_EVALUATE',exp.signed(evaluationFor(candidate,expiryRegistered.ref,'SUPPORTED_DEVELOPMENT'),'evaluator')));
   const expiryAdmitted=ok(await expiryCall('promoter','LEARNED_POLICY_ADMIT',exp.signed(admissionFor(candidate,expiryEvaluated.ref),'promoter')));
   const beforeExpiry=ok(await expiryCall('consumer','LEARNED_POLICY_CURRENT',{revisionRef:candidate.ref}));assert.equal(beforeExpiry.current,true);
   let captureReply!:(value:any)=>void,captureFailure!:(error:unknown)=>void;
   const captured=new Promise<any>((yes,no)=>{captureReply=yes;captureFailure=no;});
   const release=new Promise<void>(yes=>{releaseRelay=yes;});
   relay=createServer((req,res)=>{void(async()=>{
    assert.equal(req.method,'POST');assert.equal(req.url,'/command');
    const chunks:Buffer[]=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;assert(bytes<=65536);chunks.push(chunk);}
    const response=await fetch(exp.endpoint()+'/command',{method:'POST',headers:{authorization:req.headers.authorization??'','content-type':'application/json'},
     body:Buffer.concat(chunks),signal:AbortSignal.timeout(5000),redirect:'error'});
    const body=await response.text(),original=JSON.parse(body);
    assert.equal(response.status,200);assert.equal(original.current,true);assert.equal(original.currentUntil,shortUntil);
    assert(Date.now()<Date.parse(shortUntil),'REAL_POSITIVE_REPLY_REQUIRED_BEFORE_EXPIRY');
    captureReply({status:response.status,bodyDigest:hash(body),current:true,currentUntil:original.currentUntil,capturedAt:new Date().toISOString()});
    await release;res.writeHead(response.status,{'content-type':'application/json'});res.end(body);
   })().catch(error=>{captureFailure(error);if(!res.headersSent)res.writeHead(500);res.end('RELAY_DIAGNOSTIC_FAILED');});});
   await new Promise<void>(yes=>relay!.listen(0,'127.0.0.1',yes));
   const address=relay.address();assert(address&&typeof address!=='string');
   const relayToken=join(exp.root,'transport-consumer.token');await writeFile(relayToken,exp.tokens.consumer!,{mode:0o600});
   const relayPolicy={...config,endpoint:'http://127.0.0.1:'+address.port,tokenPath:relayToken,tokenHash:hash(exp.tokens.consumer!)};
   await writeFile(configPath,JSON.stringify(service.signed(relayPolicy,'release')),{mode:0o600});
   const policyHash=hash(await readFile(configPath));
   transportHeld=Promise.allSettled([learn('analyst','admission',{...request,revisionRef:candidate.ref}).then(result=>({result,settledAt:new Date().toISOString()}))]);
   let captureTimer:ReturnType<typeof setTimeout>|undefined,capturedReply:any;
   try{capturedReply=await Promise.race([captured,transportHeld.then(()=>{throw Error('ADMISSION_FINISHED_WITHOUT_A_HELD_POSITIVE_OWNER_REPLY');}),
    new Promise((_,no)=>{captureTimer=setTimeout(()=>no(Error('ACTUAL_POSITIVE_OWNER_REPLY_REQUIRED')),5000);})]);}
   finally{clearTimeout(captureTimer);}
   let heldCurrent:Promise<PromiseSettledResult<any>[]>|undefined,proofActuallyBlocked=false;
   await e.admin.query('BEGIN');
   try{
    await e.admin.query('SELECT id FROM finnor_os.x5_compilations WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenant,compilation.compilationId]);
    const blocker=(await e.admin.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    heldCurrent=Promise.allSettled([expiryCall('consumer','LEARNED_POLICY_CURRENT',{revisionRef:candidate.ref}).then(result=>({result,settledAt:new Date().toISOString()}))]);
    const gateUntil=Date.now()+3000;
    while(!proofActuallyBlocked){
     proofActuallyBlocked=!!(await e.admin.query("SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'",[blocker])).rowCount;
     assert(Date.now()<gateUntil,'ACTUAL_S8_NATIVE_PROOF_LOCK_REQUIRED');
     if(!proofActuallyBlocked)await new Promise(yes=>setTimeout(yes,20));
    }
    assert(Date.now()<Date.parse(shortUntil),'EVALUATOR_MUST_BE_CURRENT_BEFORE_PROOF_WAIT');
    await new Promise(yes=>setTimeout(yes,Math.max(0,Date.parse(shortUntil)-Date.now()+20)));
   }finally{await e.admin.query('COMMIT');}
   const [held]=await heldCurrent!;if(held!.status==='rejected')throw held!.reason;
   assert(Date.parse(held!.value.settledAt)>=Date.parse(shortUntil),'CURRENT_MUST_REALLY_REMAIN_PENDING_ACROSS_EXPIRY');
   const afterProofWait=ok(held!.value.result);assert.equal(afterProofWait.current,false);assert.equal(afterProofWait.candidate,null);
   releaseRelay!();
   const [transport]=await transportHeld;if(transport!.status==='rejected')throw transport!.reason;
   const transported=ok(transport!.value.result);assert.equal(transported.current,false);assert.equal(transported.admission,null);assert.equal(transported.currentUntil,null);
   assert(Date.parse(transport!.value.settledAt)>=Date.parse(capturedReply.currentUntil));
   assert.equal(hash(await readFile(configPath)),policyHash,'THE_CONSUMER_POLICY_MUST_NOT_CHANGE_DURING_THE_HELD_REPLY');
   const nativeStillCurrent=ok(await learn('analyst','read',{compilationId:compilation.compilationId}));assert.equal(nativeStillCurrent.current,true);
   const expired=await expiryCall('promoter','LEARNED_POLICY_ADMIT',exp.signed(admissionFor(candidate,expiryEvaluated.ref),'promoter'));
   assert.equal(expired.status,403);assert.equal(expired.body.code,'INDEPENDENT_SIGNATURE_OR_AUTHORITY_INVALID');
   const expiryCurrent=ok(await expiryCall('consumer','LEARNED_POLICY_CURRENT',{revisionRef:candidate.ref}));assert.equal(expiryCurrent.current,false);
   evaluatorExpired={expiryProposed,expiryRegistered,expiryEvaluated,expiryAdmitted,beforeExpiry,proofActuallyBlocked,afterProofWait,expired,expiryCurrent,keyValidUntil:shortUntil,
    positiveReplyTransport:{capturedReply,transported,settledAt:transport!.value.settledAt,consumerPolicyUnchanged:true,nativeSourceRightsAndWorkStillCurrent:nativeStillCurrent.current,exactOwnerBytesForwarded:true},
    reusedPublicNativeEvaluationForNegativeOnly:true,additionalIndependentAssignments:0};
  }finally{
   releaseRelay?.();if(transportHeld)await transportHeld;
   if(relay){relay.closeAllConnections();await new Promise<void>(yes=>relay!.close(()=>yes()));}
   await writeFile(configPath,JSON.stringify(service.signed(config,'release')),{mode:0o600});
   await expiryService?.stop();await expiryLedger.stop();
   for(const name of ownerNames){if(ownerPrior[name]===undefined)delete process.env[name];else process.env[name]=ownerPrior[name];}
  }
  await service.stop();await service.start();await bind();
  const replay=ok(await learn('analyst','admission',{...request,revisionRef:candidate.ref}));assert.equal(replay.current,true);
  Object.assign(report,{proposed,before,denied,registered,self,reencodedResults,evaluated,admitted,current,substituted,wrongArtifactKind,harmful,harmfulRegistered,forgedSupported,harmfulEvaluated,harmfulAdmission,harmfulCurrent,evaluatorExpired,replay,
   observedOldTaskFailures:evaluation.result.outcomes.filter((v:any)=>v.mode==='COMPILED_ORIGINAL'&&v.stratum!=='BOUNDARY'&&!v.complete).length,
   harmQualification:'OBSERVED_NONCOMPLETION_WITHIN_REGISTERED_FINITE_DECISION_BUDGET_NOT_AN_ELAPSED_3600_SECOND_DEADLINE_PROOF'});
  await artifact(evidence,'s8-learning.json',report);
  return {close,afterNativeRevocation:async()=>{
   const beforeRestart=ok(await call('consumer','LEARNED_POLICY_CURRENT',{revisionRef:candidate.ref}));assert.equal(beforeRestart.current,false);
   await service.stop();await service.start();await bind();
   const cold=ok(await call('consumer','LEARNED_POLICY_CURRENT',{revisionRef:candidate.ref}));assert.equal(cold.current,false);assert.equal(cold.candidate,null);
   const read=await learn('analyst','admission',{...request,revisionRef:candidate.ref});assert(read.status===403||read.status===409);
   const target=evaluation.result.outcomes.find((v:any)=>v.stratum==='RETENTION'&&v.mode==='COMPILED_ORIGINAL');
   assert(target);
   const before=(await e.admin.query('SELECT * FROM finnor_os.x3_records WHERE tenant_id=$1 AND application_id=$2 AND id=$3',[tenant,target.applicationId,target.recordId])).rows[0];
   const execution={...request,applicationId:target.applicationId,recordId:target.recordId,expectedRevision:before.concurrency_revision,
    expectedReference:{owner:'X3',id:before.id,revision:String(before.content_revision),contentDigest:before.content_digest},
    mode:'COMPILED_TRAINED',stratum:'RETENTION',idempotencyKey:randomUUID()};
   const deniedUse=await learn('analyst','execute',execution);assert.equal(deniedUse.status,403);
   const after=(await e.admin.query('SELECT * FROM finnor_os.x3_records WHERE tenant_id=$1 AND application_id=$2 AND id=$3',[tenant,target.applicationId,target.recordId])).rows[0];
   assert.deepEqual(after,before);
   const ownerRevoked=ok(await call('promoter','LEARNED_POLICY_REVOKE',service.signed({
    schema:'finnor.s8.learned-policy-revocation.v1',revisionRef:candidate.ref,expectedAdmissionRef:admitted.ref,reason:'Typed owner revocation after cold native-rights denial',
   },'promoter')));
   await service.stop();await service.start();await bind();
   const ownerCold=ok(await call('consumer','LEARNED_POLICY_CURRENT',{revisionRef:candidate.ref}));assert.equal(ownerCold.current,false);
   const history=ok(await call('reader','READ',{}));
   assert(history.history.some((v:any)=>v.operation==='LEARNED_POLICY_ADMIT'));
   assert(history.history.some((v:any)=>v.operation==='LEARNED_POLICY_REVOKE'));
   report.nativeRevocation={beforeRestart,cold,read,execution,deniedUse,before,after,ownerRevoked,ownerCold,history,actualS8ProcessRestart:true,apiColdRestart:process.env.FINNOR_X5_BUILT_API==='1'};
   await artifact(evidence,'s8-learning.json',report);return report.nativeRevocation;
  }};
 }catch(error){await close();throw error;}
}
