/** Real, separate ordinary S8 server. Disposable keys demonstrate mechanics,
 * not protected evaluation, performance admission, or business authority. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createCapabilityLifecycle} from './lifecycle-fixture.mts';
import {requiredCapabilitySourcePaths} from '../../packages/capability-evolution/src/source-closure';
import {requiredSolverReviewSourcePaths,solverReviewDependencies} from '../../packages/private-equity/src/r8/s8/source-closure';
import {solverPortRef} from '../../packages/private-equity/src/r8/s8/contracts';
import {hash,SPECIFICATION,GRAMMAR} from '../../packages/epistemic-runtime/src/solver-synthesis/contracts';
import {OWNER_PREDICATE} from '../../packages/private-equity/src/r8/projection';
import {canonical} from '../../packages/governed-execution/src/protocol';
import {byteDigest} from '../../packages/capability-evolution/src/contracts';
import {createEconomicLedger} from '../s7/ledger-fixture.mts';
export async function reviewSolver(input:{
 capsule:any;tenant:string;principal:string;rights:string;
 save:(name:string,value:unknown)=>Promise<unknown>;
 select:()=>Promise<any>;native:()=>Promise<any>;
 whileActive?:()=>Promise<void>;
}){
 const pins=async(paths:string[])=>Promise.all(paths.map(async path=>({path,sha256:byteDigest(await readFile(path))})));
 const sourcePins=await pins(requiredCapabilitySourcePaths),reviewPins=await pins(requiredSolverReviewSourcePaths);
 const service=await createCapabilityLifecycle({tenant:input.tenant,principal:input.principal,evaluator:randomUUID(),
  promoter:randomUUID(),rightsRef:input.rights,sourcePins,solverReview:{contract:'s8-r8-solver-module-review-v1',sourcePins:reviewPins}});
 const history:any[]=[];
 let ledger:Awaited<ReturnType<typeof createEconomicLedger>>|undefined;
 const previousTransport={config:process.env.FINNOR_S6_OWNER_TRANSPORT_CONFIG,root:process.env.FINNOR_S6_OWNER_TRANSPORT_ROOT};
 async function call(role:string,operation:string,body:any){
  const start=performance.now();
  try{
   const remaining=Date.parse(input.capsule.envelope.originalDeadlineAt)-Date.now();
   if(remaining<1)throw Error('S8_ORIGINAL_REVIEW_DEADLINE_EXHAUSTED');
   const response=await fetch(service.endpoint()+'/command',{method:'POST',
    headers:{authorization:'Bearer '+service.tokens[role],'content-type':'application/json'},
    body:canonical({requestId:operation+':'+randomUUID(),operation,body}),redirect:'error',
    signal:AbortSignal.timeout(Math.min(operation==='SOLVER_EVALUATE'?650000:30000,remaining))});
   const result={status:response.status,body:await response.json() as any};
   history.push({operation,role,status:result.status,code:result.body.code??null,wallMs:performance.now()-start});
   await input.save('s8/history.json',history);return result;
  }catch(error){
   const cause=error instanceof Error?error.cause as {name?:string;message?:string;code?:string}|undefined:undefined;
   const failure={operation,role,status:null,code:'TRANSPORT_OR_ORIGINAL_DEADLINE_FAILURE',wallMs:performance.now()-start,
    error:error instanceof Error?{name:error.name,message:error.message}:String(error),
    cause:cause?{name:cause.name,message:cause.message,code:cause.code}:null,child:service.snapshot(),
    qualification:'OBSERVED_FAILURE_NOT_SYNTHETIC_OWNER_EVALUATION'};
   history.push(failure);await input.save('s8/history.json',history);await input.save('s8/transport-failure.json',failure);throw error;
  }
 }
 function success(result:any){assert.equal(result.status,200,JSON.stringify(result));return result.body;}
 function refused(result:any){assert.notEqual(result.status,200,JSON.stringify(result));return result.body;}
 const previous={config:process.env.FINNOR_S8_SOLVER_CONSUMER_CONFIG,root:process.env.FINNOR_S8_SOLVER_CONSUMER_ROOT};
 async function consumer(candidate:any,admitted:any,until:string){
  const tokenPath=join(service.root,'consumer.token'),config=join(service.root,'consumer.json');
  await writeFile(tokenPath,service.tokens.consumer!,{mode:0o600});
  const body={schema:'finnor.s8.solver-consumer-policy.v1',contract:'s8-r8-solver-module-review-v1',
   domain:'DISPOSABLE_TEST_AUTHORITY',tenantId:input.tenant,principalId:input.principal,rightsRef:input.rights,
   endpoint:service.endpoint(),tokenPath,tokenHash:byteDigest(service.tokens.consumer!),revisionRef:candidate.ref,
   admissionRef:admitted.ref,capsuleRef:input.capsule.ref,validAfter:service.after,validUntil:until,timeoutMs:10000};
  await writeFile(config,JSON.stringify(service.signed(body,'release')),{mode:0o600});
  process.env.FINNOR_S8_SOLVER_CONSUMER_CONFIG=config;process.env.FINNOR_S8_SOLVER_CONSUMER_ROOT=service.pub('release');
 }
 try{
  // The existing S8 owner requires its actual canonical S6 continuity anchor.
  // Use the real disposable ledger process rather than bypassing that owner.
  ledger=await createEconomicLedger(input.tenant,input.principal,randomUUID(),{capabilityLifecycle:true,rightsRef:input.rights});
  await service.start();
  const body={schema:'finnor.s8.solver-candidate.v1',tenantId:input.tenant,principalId:input.principal,rightsRef:input.rights,
   owningInterface:'r8-s4-s5-exact-optional-v1',capsule:input.capsule,payloadDigest:hash(input.capsule),
   domain:{profile:SPECIFICATION.profile,specificationDigest:hash(SPECIFICATION),grammarDigest:hash(GRAMMAR),predicateDigest:hash(OWNER_PREDICATE),
    tie:SPECIFICATION.tie,validAfter:service.after,validUntil:new Date(Math.min(Date.parse(service.until),Date.parse(input.capsule.envelope.originalDeadlineAt))).toISOString()},
   dependencies:solverReviewDependencies(sourcePins,reviewPins),limits:{maxUses:5,maxUseWallMs:30000},proposedAt:new Date().toISOString(),
   protectedAdmission:false,executionAuthorityGranted:false};
  const candidate={...body,ref:solverPortRef('candidate',body)};
  success(await call('proposer','SOLVER_PROPOSE',candidate));
  const before=success(await call('reader','SOLVER_READ',{}));assert.equal(before.revisions[0].admissionRef,null);
  await input.save('s8/producer-cannot-admit.json',refused(await call('proposer','SOLVER_ADMIT',{})));
  const evaluator=service.policy.evaluatorKeys[0]!.principalId;
  const protocol={schema:'finnor.s8.solver-review.v1',tenantId:input.tenant,principalId:input.principal,revisionRef:candidate.ref,
   evaluatorId:evaluator,registeredAt:new Date().toISOString(),payloadDigest:body.payloadDigest,domainDigest:hash(body.domain),
   checkerDigest:input.capsule.receipt.checkerDigest,runtimeDigest:input.capsule.runtime.identityDigest,
   qualification:'FULL_ORIGINAL_D_PUBLIC_DEVELOPMENT_NOT_GATE_R8'};
  const registered=success(await call('evaluator','SOLVER_REGISTER',service.signed(protocol,'evaluator')));
  const evaluation={schema:'finnor.s8.solver-evaluation.v1',revisionRef:candidate.ref,protocolRef:registered.ref,
   evaluatorId:evaluator,payloadDigest:body.payloadDigest,domainDigest:hash(body.domain),completedAt:new Date().toISOString(),
   expectedSemanticReceiptDigest:hash(input.capsule.receipt),protectedAdmission:false};
  const evaluated=success(await call('evaluator','SOLVER_EVALUATE',service.signed(evaluation,'evaluator')));
  assert.equal(evaluated.evaluation.receipt.checkedInputs,262144);assert.equal(evaluated.evaluation.receipt.checkedPairs,2097152);
  assert.equal(evaluated.evaluation.protectedAdmission,false);await input.save('s8/owner-evaluation.json',evaluated);
  const admission={schema:'finnor.s8.solver-admission.v1',revisionRef:candidate.ref,evaluationRef:evaluated.ref,
   payloadDigest:body.payloadDigest,domainDigest:hash(body.domain),protectionDomain:'DISPOSABLE_TEST_AUTHORITY',executionAuthorityGranted:false};
  const admitted=success(await call('promoter','SOLVER_ADMIT',service.signed(admission,'promoter')));
  const activation={schema:'finnor.s8.solver-activation.v1',revisionRef:candidate.ref,admissionRef:admitted.ref,expectedGeneration:0,
   predecessorRef:null,mode:'DIAGNOSTIC',validUntil:body.domain.validUntil,executionAuthorityGranted:false};
  success(await call('promoter','SOLVER_ACTIVATE',service.signed(activation,'promoter')));
  await consumer(candidate,admitted,body.domain.validUntil);
  const reused=await input.select();assert.equal(reused.actualRoute,'R8_ACTUAL_EMITTED_BYTES');
  assert.equal(reused.independentS5.check.objective,'9');assert.equal(reused.reservation,null);await input.save('s8/actual-original-consumer-reuse.json',reused);
  const snapshot=success(await call('reader','SOLVER_READ',{}));assert.equal(snapshot.uses.length,1);
  const lease=snapshot.uses[0];success(await call('consumer','SOLVER_CURRENT',{lease}));
  await service.stop();await service.start();await consumer(candidate,admitted,body.domain.validUntil);
  const restarted=success(await call('reader','SOLVER_READ',{}));assert.deepEqual(restarted,snapshot);
  await input.save('s8/journal-restart.json',restarted);
  await input.whileActive?.();
  const revoked=success(await call('promoter','SOLVER_REVOKE',service.signed({schema:'finnor.s8.solver-revocation.v1',
   revisionRef:candidate.ref,expectedAdmissionRef:admitted.ref,expectedGeneration:1,reason:'REGISTERED_DISPOSABLE_REVOCATION_CHALLENGE',predecessorRef:null},'promoter')));
  await input.save('s8/revoked-current-lease.json',refused(await call('consumer','SOLVER_CURRENT',{lease})));
  const fallback=await input.select();assert.equal(fallback.actualRoute,'SCIPY_HIGHS_ROBUST_MILP');assert.equal(fallback.independentS5.check.objective,'9');
  await input.save('s8/revoked-executed-fallback.json',fallback);
  const native=await input.native();assert.equal(native.actualRoute,'SCIPY_HIGHS_ROBUST_MILP');assert.equal(native.independentS5.check.objective,reused.independentS5.check.objective);
  await input.save('s8/matched-native-diagnostic.json',{native,reused,fallback,history,causalEconomics:'UNKNOWN_PUBLIC_DEVELOPMENT_CASE',
   qualification:'EXACT_SAME_CURRENT_ORIGINAL_OWNER_PROBLEM_NO_HELDOUT_WEALTH_OR_PROTECTED_GATE_CLAIM'});
  return {candidateRef:candidate.ref,evaluationRef:evaluated.ref,admissionRef:admitted.ref,revocationRef:revoked.ref,
   separateFullDomainInputs:262144,separateSubsetPairs:2097152,reuseActualRoute:reused.actualRoute,revokedActualRoute:fallback.actualRoute,
   protectedAdmission:false,executionAuthorityGranted:false};
 }finally{
  await service.stop();
  await ledger?.stop();
  for(const [key,value]of Object.entries(previous)){
   const name=key==='config'?'FINNOR_S8_SOLVER_CONSUMER_CONFIG':'FINNOR_S8_SOLVER_CONSUMER_ROOT';
   if(value===undefined)delete process.env[name];else process.env[name]=value;
  }
  for(const [key,value]of Object.entries(previousTransport)){
   const name=key==='config'?'FINNOR_S6_OWNER_TRANSPORT_CONFIG':'FINNOR_S6_OWNER_TRANSPORT_ROOT';
   if(value===undefined)delete process.env[name];else process.env[name]=value;
  }
 }
}
