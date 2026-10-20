/** Actual typed S8 lifecycle and canonical X3 consumer. Generated disposable
 * evaluators test authority mechanics, not independent protected qualification. */
import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {receiveWork} from '@finnor/db';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {requiredCapabilitySourcePaths} from '../../packages/capability-evolution/src/source-closure';
import {digest} from '../../packages/capability-evolution/src/contracts';
import {createCapabilityLifecycle} from '../s8/lifecycle-fixture.mts';
import {createEconomicLedger} from '../s7/ledger-fixture.mts';
import {artifact,hash} from './environment.mts';
export async function lifecycleCall(service:Awaited<ReturnType<typeof createCapabilityLifecycle>>,role:string,operation:string,body:unknown){
 const response=await fetch(service.endpoint()+'/command',{method:'POST',headers:{authorization:'Bearer '+service.tokens[role],'content-type':'application/json'},body:JSON.stringify({operation,requestId:randomUUID(),body}),signal:AbortSignal.timeout(10000)});
 return {status:response.status,body:await response.json() as any};
}
export async function applicationS8Proof(f:any){
 const {api,e,main,second,tenant,root,people,evidence}=f,ok=(r:any)=>{assert.equal(r.status,200,JSON.stringify(r));return r.body;};
 const installed=ok(await api('analyst','read',{applicationId:main.id,limit:100})),other=ok(await api('analyst','read',{applicationId:second.id}));
 const pins=await Promise.all(requiredCapabilitySourcePaths.map(async path=>({path,sha256:hash(await readFile(path))})));
 assert(pins.length<=128);
 const evaluator=randomUUID(),promoter=randomUUID(),rightsRef=installed.package.rights.ref;
 const names=['FINNOR_S6_OWNER_TRANSPORT_CONFIG','FINNOR_S6_OWNER_TRANSPORT_ROOT','FINNOR_S8_APPLICATION_CONSUMER_CONFIG','FINNOR_S8_APPLICATION_CONSUMER_ROOT'];
 const prior=Object.fromEntries(names.map(name=>[name,process.env[name]]));
 const ledger=await createEconomicLedger(tenant,people.analyst,randomUUID(),{capabilityLifecycle:true,rightsRef,financialPrincipal:evaluator});
 const service=await createCapabilityLifecycle({tenant,principal:people.analyst,evaluator,promoter,rightsRef,sourcePins:pins});
 try{
  const configuration=JSON.parse(await readFile(service.configPath,'utf8'));
  const policy={...service.policy,actors:service.policy.actors.map(a=>a.id==='proposer'?{...a,roles:['PROPOSER','CONSUMER']}:a)};
  configuration.signedPolicy=service.signed(policy,'release');
  await writeFile(service.configPath,JSON.stringify(configuration),{mode:0o600});
  await service.start();
  const call=(role:string,operation:string,body:unknown)=>lifecycleCall(service,role,operation,body);
  const tokenPath=join(service.root,'application-proposer.token'),configPath=join(service.root,'application-consumer.json');
  await writeFile(tokenPath,service.tokens.proposer!,{mode:0o600});
  const config={schema:'finnor.s8.application-consumer-policy.v1',domain:'DISPOSABLE_TEST_AUTHORITY',tenantId:tenant,principalId:people.analyst,rightsRef,
   endpoint:service.endpoint(),tokenPath,tokenHash:hash(service.tokens.proposer!),sourcePins:pins,validAfter:service.after,validUntil:service.until,timeoutMs:10000};
  await writeFile(configPath,JSON.stringify(service.signed(config,'release')),{mode:0o600});
  process.env.FINNOR_S8_APPLICATION_CONSUMER_CONFIG=configPath;process.env.FINNOR_S8_APPLICATION_CONSUMER_ROOT=service.pub('release');
  if(process.env.FINNOR_X3_BUILT_API==='1')await e.http.restartApi();
  const proposed=ok(await api('analyst','s8-propose',{applicationId:main.id,idempotencyKey:randomUUID()})),candidate=proposed.candidate;
  const before=ok(await call('consumer','APPLICATION_CURRENT',{revisionRef:candidate.ref}));assert.equal(before.current,false);
  const denied=await call('proposer','APPLICATION_REGISTER',{});assert.equal(denied.status,403);
  const applicationCommitments=[digest({applicationId:main.id,releaseId:installed.headReleaseId,proofs:installed.package.proofs}),digest({applicationId:second.id,releaseId:other.headReleaseId,proofs:other.package.proofs})];
  const maintenance=JSON.parse(await readFile(join(evidence,'installed-maintenance-recovery-resources.json'),'utf8'));
  assert.equal(maintenance.allPassed,true);
  const lifecycleCommitments=['BUSINESS_RULES_UNITS','IDENTITY_AUTHORIZATION_CONCURRENCY','DEPENDENCY_SCHEMA_DEPLOYMENT'].map(changeClass=>digest({changeClass,installedEvidenceDigest:digest(maintenance)}));
  const protocol={schema:'finnor.s8.application-evaluation-protocol.v1',tenantId:tenant,principalId:people.analyst,revisionRef:candidate.ref,evaluatorId:evaluator,registeredAt:new Date().toISOString(),
   payloadDigest:digest(candidate.payload),domainDigest:digest(candidate.domain),applicationCommitments,lifecycleCommitments,qualification:'PUBLIC_DEVELOPMENT_NOT_PROTECTED_X3_20_60'};
  const registered=ok(await call('evaluator','APPLICATION_REGISTER',service.signed(protocol,'evaluator')));
  const evaluation={schema:'finnor.s8.application-evaluation.v1',tenantId:tenant,principalId:people.analyst,revisionRef:candidate.ref,protocolRef:registered.ref,evaluatorId:evaluator,
   completedAt:new Date().toISOString(),payloadDigest:digest(candidate.payload),domainDigest:digest(candidate.domain),applicationCommitments,lifecycleCommitments,
   resultsDigest:digest(maintenance),completeApplicationPasses:2,completeLifecyclePasses:3,criticalViolations:0,authorityViolations:0,disposition:'SUPPORTED_DEVELOPMENT',protectedAdmission:false};
  const self=await call('proposer','APPLICATION_EVALUATE',service.signed(evaluation,'evaluator'));assert.equal(self.status,403);
  const evaluated=ok(await call('evaluator','APPLICATION_EVALUATE',service.signed(evaluation,'evaluator')));
  const admitted=ok(await call('promoter','APPLICATION_ADMIT',service.signed({schema:'finnor.s8.application-admission.v1',revisionRef:candidate.ref,evaluationRef:evaluated.ref,
   payloadDigest:digest(candidate.payload),domainDigest:digest(candidate.domain),protectionDomain:'DISPOSABLE_TEST_AUTHORITY',executionAuthorityGranted:false,protectedAdmission:false},'promoter')));
  // One signed host actor has only PROPOSER + CONSUMER, never EVALUATOR or
  // PROMOTER. The installed API uses unchanged scoped credentials for both.
  const current=ok(await api('analyst','admission',{applicationId:main.id,revisionRef:candidate.ref}));assert.equal(current.current,true);assert.equal(current.productionActive,false);
  const substituted=structuredClone(candidate);substituted.payload.programDigest='0'.repeat(64);
  const bad=await call('proposer','APPLICATION_PROPOSE',substituted);assert.equal(bad.status,409);
  const catalogue=ok(await call('consumer','APPLICATION_CATALOGUE',{applicationId:main.id,root, specificationDigest:candidate.payload.specificationDigest}));assert.equal(catalogue.reusable.length,1);
  await service.stop();await service.start();
  // Restart intentionally changes the listening port. Re-sign only this local
  // transport address; candidate, journal, admission and allocation stay fixed.
  config.endpoint=service.endpoint();await writeFile(configPath,JSON.stringify(service.signed(config,'release')),{mode:0o600});
  const replay=ok(await api('analyst','admission',{applicationId:main.id,revisionRef:candidate.ref}));assert.equal(replay.current,true);
  // Separate disposable S8 and S6 journals reuse genuine public development
  // evidence only for this negative, not another independent app result. A
  // different policy cannot replace the main owner's responsibility anchor.
  const expiryTransport=Object.fromEntries(names.slice(0,2).map(name=>[name,process.env[name]]));
  const expiryLedger=await createEconomicLedger(tenant,people.analyst,randomUUID(),{capabilityLifecycle:true,rightsRef,financialPrincipal:evaluator});
  const expiring=await createCapabilityLifecycle({tenant,principal:people.analyst,evaluator,promoter,rightsRef,sourcePins:pins});
  let evaluatorExpired:any;
  try{
   const shortUntil=new Date(Date.now()+8000).toISOString(),shortConfig=JSON.parse(await readFile(expiring.configPath,'utf8'));
   const shortPolicy={...expiring.policy,validAfter:service.after,evaluatorKeys:expiring.policy.evaluatorKeys.map(key=>({...key,validUntil:shortUntil}))};
   shortConfig.signedPolicy=expiring.signed(shortPolicy,'release');await writeFile(expiring.configPath,JSON.stringify(shortConfig),{mode:0o600});
   await expiring.start();
   const shortCall=(role:string,operation:string,body:unknown)=>lifecycleCall(expiring,role,operation,body);
   const expiryProposed=ok(await shortCall('proposer','APPLICATION_PROPOSE',candidate));
   const expiryProtocol={...protocol,registeredAt:new Date().toISOString()};
   const expiryRegistered=ok(await shortCall('evaluator','APPLICATION_REGISTER',expiring.signed(expiryProtocol,'evaluator')));
   const expiryEvaluation={...evaluation,protocolRef:expiryRegistered.ref,completedAt:new Date().toISOString()};
   const expiryEvaluated=ok(await shortCall('evaluator','APPLICATION_EVALUATE',expiring.signed(expiryEvaluation,'evaluator')));
   await new Promise(yes=>setTimeout(yes,Math.max(0,Date.parse(shortUntil)-Date.now()+50)));
   const refused=await shortCall('promoter','APPLICATION_ADMIT',expiring.signed({schema:'finnor.s8.application-admission.v1',revisionRef:candidate.ref,evaluationRef:expiryEvaluated.ref,
    payloadDigest:digest(candidate.payload),domainDigest:digest(candidate.domain),protectionDomain:'DISPOSABLE_TEST_AUTHORITY',executionAuthorityGranted:false,protectedAdmission:false},'promoter'));
   assert.equal(refused.status,403);assert.equal(refused.body.code,'INDEPENDENT_SIGNATURE_OR_AUTHORITY_INVALID');
   const current=ok(await shortCall('consumer','APPLICATION_CURRENT',{revisionRef:candidate.ref})),history=ok(await shortCall('reader','READ',{}));
   assert.equal(current.current,false);assert.equal(history.page.complete,true);assert(history.history.every((entry:any)=>entry.operation!=='APPLICATION_ADMIT'));
   assert(Date.parse(shortPolicy.validUntil)>Date.now()&&Date.parse(candidate.domain.validUntil)>Date.now());
   evaluatorExpired={expiryProposed,expiryRegistered,expiryEvaluated,refused,current,history:history.history,keyValidUntil:shortUntil,policyAndCandidateStillValid:true,
    reusedPublicDevelopmentEvidenceForNegativeControl:true,separateDisposableResponsibilityJournal:true,additionalIndependentApplicationPasses:0,protectedAdmission:false};
   await artifact(evidence,'s8-evaluator-expiry.json',evaluatorExpired);
  }finally{
   await expiring.stop();await expiryLedger.stop();
   for(const name of names.slice(0,2)){if(expiryTransport[name]===undefined)delete process.env[name];else process.env[name]=expiryTransport[name];}
  }
  // Hold a genuine current reply at the local transport boundary, then append
  // a real canonical Work input before the API's final transaction. No S8
  // answer or signature is fabricated by this timing fixture.
  let ownerCurrent:any,workChange:any,mode:'WORK'|'POLICY_EXPIRY'|'PROPOSAL_EXPIRY'='WORK',holdUntil=0;
  const proxy=createServer(async(req,res)=>{
   try{
    const chunks:Buffer[]=[];let bytes=0;
    for await(const chunk of req){bytes+=chunk.length;assert(bytes<=262144);chunks.push(chunk);}
    const upstream=await fetch(service.endpoint()+'/command',{method:'POST',headers:{authorization:String(req.headers.authorization),'content-type':'application/json'},body:Buffer.concat(chunks),signal:AbortSignal.timeout(10000)});
    const text=await upstream.text();ownerCurrent=JSON.parse(text);assert(upstream.ok);
    if(mode==='PROPOSAL_EXPIRY')assert(ownerCurrent.ref);
    else assert.equal(ownerCurrent.current,true);
    if(mode==='WORK')workChange=await receiveWork({tenantId:tenant,userId:people.analyst,workId:main.workId,channel:'console',
     instruction:'Canonical Work changed after the S8 owner returned current; this older application admission must no longer appear current.',idempotencyKey:randomUUID()});
    else await new Promise(yes=>setTimeout(yes,Math.max(0,holdUntil-Date.now()+50)));
    res.writeHead(upstream.status,{'content-type':'application/json'});res.end(text);
   }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({code:'DISPOSABLE_WORK_TIMING_FIXTURE_FAILED',error:String(error)}));}
  });
  await new Promise<void>(yes=>proxy.listen(0,'127.0.0.1',yes));const address=proxy.address();assert(address&&typeof address!=='string');
  let workChanged:any,staleProposal:any,policyExpired:any,proposalExpired:any;
  const originalUntil=config.validUntil;
  try{
   config.endpoint='http://127.0.0.1:'+address.port;
   mode='POLICY_EXPIRY';holdUntil=Date.now()+3000;config.validUntil=new Date(holdUntil).toISOString();
   await writeFile(configPath,JSON.stringify(service.signed(config,'release')),{mode:0o600});
   const expiredCurrent=ok(await api('analyst','admission',{applicationId:main.id,revisionRef:candidate.ref}));
   assert.equal(expiredCurrent.current,false);assert.equal(expiredCurrent.admission,null);assert.equal(ownerCurrent.current,true);
   assert(Date.parse(candidate.domain.validUntil)>Date.now()&&Date.parse(installed.package.validity.validUntil)>Date.now());
   policyExpired={ownerReply:ownerCurrent,result:expiredCurrent,expiredPolicyUntil:config.validUntil,candidateAndReleaseStillValid:true};
   await artifact(evidence,'s8-boundary-progress.json',{phase:'POLICY_EXPIRY',policyExpired});
   // A new, unevaluated proposal uses no new evaluation commitments. Hold
   // its genuine owner receipt past the candidate's policy intersection.
   const priorLocalProposals=(await e.admin.query("SELECT count(*)::integer n FROM finnor_os.x3_events WHERE tenant_id=$1 AND application_id=$2 AND kind='S8_PROPOSED'",[tenant,main.id])).rows[0].n;
   mode='PROPOSAL_EXPIRY';holdUntil=Date.now()+3000;config.validUntil=new Date(holdUntil).toISOString();
   await writeFile(configPath,JSON.stringify(service.signed(config,'release')),{mode:0o600});
   const proposal=await api('analyst','s8-propose',{applicationId:main.id,idempotencyKey:randomUUID()});
   assert.equal(proposal.status,409);assert.equal(proposal.body.code,'APPLICATION_ADMISSION_CONTEXT_CHANGED');
   assert(ownerCurrent.ref);
   const localProposals=(await e.admin.query("SELECT count(*)::integer n FROM finnor_os.x3_events WHERE tenant_id=$1 AND application_id=$2 AND kind='S8_PROPOSED'",[tenant,main.id])).rows[0].n;
   assert.equal(localProposals,priorLocalProposals);
   proposalExpired={ownerReply:ownerCurrent,result:proposal,expiredCandidateAndPolicyUntil:config.validUntil,priorLocalProposals,localProposals,independentEvaluationCommitmentsReused:false};
   await artifact(evidence,'s8-boundary-progress.json',{phase:'PROPOSAL_EXPIRY',policyExpired,proposalExpired});
   // Restore the original already-authorized interval, not an application
   // allocation, evaluation, admission, holdout or deadline.
   mode='WORK';config.validUntil=originalUntil;
   await writeFile(configPath,JSON.stringify(service.signed(config,'release')),{mode:0o600});
   workChanged=ok(await api('analyst','admission',{applicationId:main.id,revisionRef:candidate.ref}));assert.equal(workChanged.current,false);assert.equal(workChanged.admission,null);
   assert(ownerCurrent.current&&workChange.workInputId);
   staleProposal=await api('analyst','s8-propose',{applicationId:main.id,idempotencyKey:randomUUID()});
   assert.equal(staleProposal.status,409);assert.equal(staleProposal.body.code,'APPLICATION_ADMISSION_CONTEXT_CHANGED');
  }finally{
   proxy.closeAllConnections();await new Promise<void>(yes=>proxy.close(()=>yes()));
   config.endpoint=service.endpoint();config.validUntil=originalUntil;await writeFile(configPath,JSON.stringify(service.signed(config,'release')),{mode:0o600});
  }
  const ownerBeforeRevocation=ok(await call('consumer','APPLICATION_CURRENT',{revisionRef:candidate.ref}));assert.equal(ownerBeforeRevocation.current,true);
  const revoked=ok(await call('promoter','APPLICATION_REVOKE',service.signed({schema:'finnor.s8.application-revocation.v1',revisionRef:candidate.ref,expectedAdmissionRef:admitted.ref,reason:'PUBLIC_DEVELOPMENT_REVOCATION_PROOF'},'promoter')));
  const ownerAfterRevocation=ok(await call('consumer','APPLICATION_CURRENT',{revisionRef:candidate.ref}));assert.equal(ownerAfterRevocation.current,false);
  const after=ok(await api('analyst','admission',{applicationId:main.id,revisionRef:candidate.ref}));assert.equal(after.current,false);
  const result={id:'typed-s8-application-lifecycle',proposed,before,denied,registered,evaluated,admitted,current,bad,catalogue,replay,evaluatorExpired,policyExpired,proposalExpired,ownerCurrent,workChange,workChanged,staleProposal,ownerBeforeRevocation,revoked,ownerAfterRevocation,after,sourcePins:pins.length,
   protectedApplications:0,protectedMaintenanceEpisodes:0,productionActive:false,qualification:'DISPOSABLE_ROLE_AND_REPLAY_MECHANICS_NOT_INDEPENDENT_SCIENTIFIC_OR_PROTECTED_20_60_AUTHORITY'};
  await artifact(evidence,'s8-application.json',result);return result;
 }finally{
  await service.stop();await ledger.stop();
  for(const name of names){if(prior[name]===undefined)delete process.env[name];else process.env[name]=prior[name];}
  if(process.env.FINNOR_X3_BUILT_API==='1')await e.http.restartApi();
 }
}
