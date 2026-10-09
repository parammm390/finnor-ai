import {env as runtimeEnvironment} from 'node:process';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {PoolClient} from 'pg';
import type {JobExecutionContext} from '../../../../apps/worker/src/queue';
import {acquireComputeResourceLeases,renewComputeResourceLeases,releaseComputeResourceLeases,withDatabaseExecutionDeadline,executionDeadlineMilliseconds,DatabaseExecutionDeadlineError,ComputeCapacityUnavailableError} from '@finnor/db';
import type {ControlQuotient,ControlQuotientReceipt,ExactControlEvaluation,ExactControlPolicyProfile,R1WorkEnvelope,S4ComputeInvocation} from '@finnor/shared-types';
import {checkControlQuotient,buildExactControlPolicy,EXACT_S4_VERSION,epistemicHash} from '@finnor/epistemic-runtime';
import type {PeMutationContext} from '../types';
import {tx,sha,stable} from '../evidence-execution/store';
import {assertProgramCurrent,requestRow,trace} from '../program-synthesis/store';
import {chargeOriginalNativeGrant} from '../compute-search/native-grant';
import {publishEnterpriseExactControlPolicy} from '../enterprise-control';
import {lockExactSourceCurrent,type ExactSourceRow} from './source';
import {r1Current,r1Row,r1Event,expireR1Decision,type R1RunRow} from './api';
import {r1SourceCut} from './runtime';
import {executeR1Native} from './native';
import {assertR1ResponsibilityCurrent} from './responsibility';
import {r1AffectedDependencyClosure,r1DependencySeeds,enqueueR1DependencyContinuation} from './dependencies';
import {createR1ArtifactEnvelope} from './envelope';
const Payload=z.object({tenantId:z.string().uuid(),principalId:z.string().uuid(),runId:z.string().uuid(),generation:z.number().int().positive(),originalDeadlineAt:z.string().datetime(),decisionDeadlineAt:z.string().datetime()}).strict();
type Stage='PRODUCE'|'CHECK'|'S4_EVALUATE'|'ORIGINAL_FALLBACK';
async function queueFence(c:PoolClient,r:R1RunRow,x:Readonly<JobExecutionContext>){
 const job=(await c.query("SELECT id FROM finnor_os.jobs WHERE id=$1 AND tenant_id=$2 AND type='run_certified_state_reduction_v1' AND status='running' AND claim_token=$3 AND claim_fence=$4 AND protocol_version=1 AND lease_expires_at>clock_timestamp() FOR SHARE",[x.jobId,r.tenant_id,x.claimToken,x.claimFence])).rows[0];if(!job)throw Error('R1_ACTUAL_CURRENT_QUEUE_CLAIM_REQUIRED');
 const locked=(await c.query<R1RunRow>('SELECT * FROM finnor_os.r1_runs WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 FOR UPDATE',[r.id,r.tenant_id,r.principal_id])).rows[0];
 if(!locked||locked.generation!==r.generation||locked.status!=='RUNNING'||locked.claim_token!==x.claimToken||!Number.isSafeInteger(Number(x.claimFence))||Number(locked.claim_fence)!==Number(x.claimFence))throw Error('R1_CURRENT_RUN_PUBLICATION_FENCED');return locked;
}
async function grantFence(c:PoolClient,r:R1RunRow){
 const reservation=(await c.query('SELECT status,revocation_reason,envelopes FROM finnor_os.s5_reservations WHERE tenant_id=$1 AND allocation_digest=$2 FOR SHARE',[r.tenant_id,r.request.grant.contentDigest])).rows[0];
 if(!reservation||reservation.status==='RELEASED'||reservation.revocation_reason||stable(reservation.envelopes.find((e:any)=>e.resourceId===r.binding.resourceId))!==stable(r.binding.resourceEnvelope)||Date.parse(r.binding.validUntil)<=Date.now())throw Error('R1_ORIGINAL_S5_RESERVATION_REVOKED_OR_CHANGED');
 const resource=(await c.query('SELECT r.content_digest FROM finnor_os.s5_resources r JOIN finnor_os.s5_resource_heads h USING(tenant_id,resource_id,revision) WHERE r.tenant_id=$1 AND r.resource_id=$2 FOR SHARE OF h,r',[r.tenant_id,r.binding.resourceId])).rows[0];if(resource?.content_digest!==r.binding.resourceRef.contentDigest)throw Error('R1_ORIGINAL_COMPUTE_RESOURCE_REVISED');
}
async function artifact(ctx:PeMutationContext,r:R1RunRow,kind:string,body:unknown,c?:PoolClient){
 const id=randomUUID(),digest=sha(body);const put=(client:PoolClient)=>client.query('INSERT INTO finnor_os.r1_artifacts(id,tenant_id,principal_id,run_id,generation,kind,body,digest) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT DO NOTHING',[id,r.tenant_id,r.principal_id,r.id,r.generation,kind,stable(body),digest]);if(c)await put(c);else await tx(ctx,put);return {id,digest};
}
async function admit(ctx:PeMutationContext,r:R1RunRow,s:ExactSourceRow,x:Readonly<JobExecutionContext>,stage:Stage,reserve:number){
 // Same original P1 counters, S5 portfolio lock and native grant counter as P2.
 await r1Current(ctx,r);
 return tx(ctx,async c=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['s5-portfolio:'+r.tenant_id]);
  const locked=await queueFence(c,r,x),q=await requestRow(ctx,r.program_id,c);await assertProgramCurrent(ctx,q,c,true);await lockExactSourceCurrent(ctx,s,c);await grantFence(c,r);await assertR1ResponsibilityCurrent(ctx,c);
  if((await c.query('SELECT id FROM finnor_os.r1_attempts WHERE tenant_id=$1 AND principal_id=$2 AND delivery_id=$3 AND stage=$4',[r.tenant_id,r.principal_id,x.deliveryAttemptId,stage])).rowCount)throw Error('R1_PHYSICAL_STAGE_ALREADY_ADMITTED');
  const step=await c.query('UPDATE finnor_os.r1_runs SET math_steps_used=math_steps_used+$2 WHERE id=$1 AND math_steps_used+$2<=$3 RETURNING math_steps_used',[r.id,reserve,r.request.envelope_inputs.maxMathSteps]);if(!step.rowCount)throw Error('R1_ORIGINAL_MATH_GRANT_EXHAUSTED');
  await chargeOriginalNativeGrant(c,{tenantId:r.tenant_id,principalId:r.principal_id,grantDigest:r.request.grant.contentDigest,resourceId:r.binding.resourceId,capacity:r.binding.capacity,predicate:'R1_ORIGINAL_S5_COMPUTE_ENVELOPE_EXHAUSTED'});
  const parent=await c.query('UPDATE finnor_os.p1_episodes SET steps_used=steps_used+1,attempts_used=attempts_used+1 WHERE id=$1 AND tenant_id=$2 AND principal_id=$3 AND steps_used+1<=max_steps AND attempts_used+1<=max_attempts AND deadline_at>clock_timestamp() AND deadline_at=$4 RETURNING steps_used,attempts_used',[r.episode_id,r.tenant_id,r.principal_id,r.original_deadline_at]);if(!parent.rowCount)throw Error('R1_ORIGINAL_P1_EPISODE_EXHAUSTED');
  const id=randomUUID(),body={stage,jobId:x.jobId,deliveryId:x.deliveryAttemptId,claimFence:x.claimFence,originalEpisode:r.episode_id,originalDeadlineAt:r.original_deadline_at.toISOString(),grantRef:r.request.grant,chargedNativeAttempts:1,mathReservation:reserve,originalMathUsed:Number(locked.math_steps_used),parent:parent.rows[0],usd:null};
  await c.query("INSERT INTO finnor_os.r1_attempts(id,tenant_id,principal_id,run_id,delivery_id,stage,claim_fence,status,body,digest) VALUES($1,$2,$3,$4,$5,$6,$7,'INTENT',$8::jsonb,$9)",[id,r.tenant_id,r.principal_id,r.id,x.deliveryAttemptId,stage,x.claimFence,stable(body),sha(body)]);await r1Event(ctx,r,'PHYSICAL_INTENT',{attemptId:id,...body},c);await trace(ctx,q,'R1_ORIGINAL_GRANT_CHARGED',{runId:r.id,attemptId:id,...body},c);return {id,body};
 });
}
async function attemptUpdate(ctx:PeMutationContext,r:R1RunRow,a:{id:string;body:any},status:string,delta:any,x:Readonly<JobExecutionContext>,settle?:number){
 return tx(ctx,async c=>{const old=(await c.query('SELECT status,body FROM finnor_os.r1_attempts WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 FOR UPDATE',[r.tenant_id,r.principal_id,a.id])).rows[0];if(!old)throw Error('R1_ATTEMPT_NOT_FOUND');
  if(status==='SUBMITTED')await queueFence(c,r,x);
  const body={...old.body,...delta};await c.query('UPDATE finnor_os.r1_attempts SET status=$4,child_pid=$5,body=$6::jsonb,digest=$7 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',[r.tenant_id,r.principal_id,a.id,status,body.childPid??null,stable(body),sha(body)]);
  if(settle!==undefined){const retained=Math.min(a.body.mathReservation,Math.max(0,Math.ceil(settle)));await c.query('UPDATE finnor_os.r1_runs SET math_steps_used=math_steps_used-$2 WHERE id=$1 AND math_steps_used>=$2',[r.id,a.body.mathReservation-retained]);}
  await r1Event(ctx,r,'PHYSICAL_'+status,{attemptId:a.id,...body},c);return body;
 });
}
export async function runCertifiedStateReductionJob(payload:Record<string,unknown>,x?:Readonly<JobExecutionContext>):Promise<void>{
 const p=Payload.parse(payload);if(!x||x.protocolVersion!==1||x.tenantId!==p.tenantId)throw Error('R1_ACTUAL_DURABLE_JOB_CONTEXT_REQUIRED');
 const deadline=Date.parse(p.decisionDeadlineAt),monotone=performance.now()+Math.max(0,deadline-Date.now());
 const closeExpired=()=>withDatabaseExecutionDeadline(performance.now()+1000,async()=>{
  // A spent computation clock still needs a bounded, fenced metadata drain.
  // This path admits no child, grant charge, policy or HEAD publication.
  const ctx:PeMutationContext={auth:{tenantId:p.tenantId,userId:p.principalId,employeeId:p.principalId,role:'owner'},provenance:{sourceSystem:'R1:decision-deadline',createdBy:p.principalId}};
  return tx(ctx,async c=>{
   const job=(await c.query("SELECT id FROM finnor_os.jobs WHERE id=$1 AND tenant_id=$2 AND type='run_certified_state_reduction_v1' AND status='running' AND claim_token=$3 AND claim_fence=$4 AND protocol_version=1 AND lease_expires_at>clock_timestamp() FOR SHARE",[x.jobId,p.tenantId,x.claimToken,x.claimFence])).rows[0];if(!job)throw Error('R1_ACTUAL_CURRENT_QUEUE_CLAIM_REQUIRED');
   const row=await r1Row(ctx,p.runId,c,true);
   if(row.original_deadline_at.getTime()!==Date.parse(p.originalDeadlineAt)||row.decision_deadline_at.getTime()!==deadline||deadline>row.original_deadline_at.getTime())throw Error('R1_ORIGINAL_DELIVERY_DEADLINE_REQUIRED');
   if(row.generation!==p.generation||!['QUEUED','RUNNING'].includes(row.status))return true;
   const expired=await expireR1Decision(ctx,row.id,c);return !['QUEUED','RUNNING'].includes(expired.status);
  });
 });
 if(Date.now()>=deadline){await closeExpired();return;}
 try{await withDatabaseExecutionDeadline(monotone,()=>run(p,x,deadline,monotone));}
 catch(error){if(!(error instanceof DatabaseExecutionDeadlineError))throw error;if(!await closeExpired())throw error;}
}
async function run(p:z.infer<typeof Payload>,x:Readonly<JobExecutionContext>,deadline:number,monotone:number){
 const ctx:PeMutationContext={auth:{tenantId:p.tenantId,userId:p.principalId,employeeId:p.principalId,role:'owner'},provenance:{sourceSystem:'R1:exact-reduction',createdBy:p.principalId}},controller=new AbortController();
 let r=await r1Row(ctx,p.runId);if(r.generation!==p.generation||!['QUEUED','RUNNING'].includes(r.status))return;
 if(r.original_deadline_at.getTime()!==Date.parse(p.originalDeadlineAt)||r.decision_deadline_at.getTime()!==deadline||deadline>r.original_deadline_at.getTime())throw Error('R1_ORIGINAL_DELIVERY_DEADLINE_REQUIRED');
 let leases:Awaited<ReturnType<typeof acquireComputeResourceLeases>>=[],released=false;
 const start=performance.now(),cpu=process.cpuUsage(),rss=process.memoryUsage().rss,physical:any[]=[];
 try{
  if(runtimeEnvironment.NODE_ENV==='production'||process.env.FINNOR_P4_PROFILE!=='ordinary_disposable')throw Error('R1_PROTECTED_DOMAIN_ADMISSION_AND_FUNDING_UNAVAILABLE');
  const {source}=await r1Current(ctx,r);await r1SourceCut();
  await tx(ctx,async c=>{const locked=await r1Row(ctx,r.id,c,true);if(locked.generation!==p.generation||!['QUEUED','RUNNING'].includes(locked.status))throw Error('R1_CURRENT_RUN_PUBLICATION_FENCED');
   if((await c.query("SELECT id FROM finnor_os.r1_attempts WHERE run_id=$1 AND status IN('INTENT','SUBMITTED','UNKNOWN')",[r.id])).rowCount)throw Error('R1_UNKNOWN_PHYSICAL_WORK_REQUIRES_RECONCILIATION');
   await c.query("UPDATE finnor_os.r1_runs SET status='RUNNING',claim_token=$2,claim_fence=$3 WHERE id=$1",[r.id,x.claimToken,x.claimFence]);});r=await r1Row(ctx,r.id);
  leases=await acquireComputeResourceLeases({resourceKeys:['native:p2'],requiredResourceKeys:['native:p2'],tenantId:r.tenant_id,workloadClass:'INTERACTIVE',ownerId:'r1:'+x.deliveryAttemptId});
  x.registerHeartbeat(()=>withDatabaseExecutionDeadline(monotone,async()=>{if(released)return true;try{executionDeadlineMilliseconds();const current=await r1Row(ctx,r.id);if(current.generation!==r.generation||current.status!=='RUNNING'||current.claim_token!==x.claimToken){controller.abort();return false;}const renewed=await renewComputeResourceLeases(leases);if(!renewed)controller.abort();return renewed;}catch{controller.abort();return false;}}));
  const native=async(stage:Exclude<Stage,'CHECK'>,reuse?:unknown)=>{
   const a=await admit(ctx,r,source,x,stage,Math.max(1,Math.min(1000000,Math.floor(r.request.envelope_inputs.maxMathSteps/4))));let returned=false;
   try{const result=await executeR1Native({stage,modelBytes:source.model_bytes,deadlineAt:deadline,maxSteps:a.body.mathReservation,reuse},controller.signal,pid=>attemptUpdate(ctx,r,a,'SUBMITTED',{childPid:pid,submittedAt:new Date().toISOString()},x).then(()=>undefined));returned=true;physical.push(result);await artifact(ctx,r,stage+'_RETURN',result);await attemptUpdate(ctx,r,a,'RETURNED',{resultDigest:sha(result),physical:result.physical},x,result.physical.mathSteps);return result.result;}
   catch(error){if(!returned)await attemptUpdate(ctx,r,a,'UNKNOWN',{predicate:safe(error),physicalOutcome:'UNKNOWN',mathReservationRetained:true,grantChargeRetained:true},x);throw error;}
  };
  let candidate:ControlQuotient|null=null,receipt:ControlQuotientReceipt|null=null,evaluation:ExactControlEvaluation|null=null,predicate:string|null=null,fallback:string|null=null;
  try{
   const proposed=await native('PRODUCE');if(proposed.schema!=='finnor.control-quotient.v1')throw Error(proposed.predicate??'R1_PRODUCER_NO_COMPLETE_CANDIDATE');candidate=proposed;
   const a=await admit(ctx,r,source,x,'CHECK',Math.max(1,Math.min(1000000,Math.floor(r.request.envelope_inputs.maxMathSteps/4))));
   receipt=await checkControlQuotient(source.model_bytes,candidate!,{deadlineAt:deadline,maxSteps:a.body.mathReservation,signal:controller.signal,onProcess:pid=>attemptUpdate(ctx,r,a,'SUBMITTED',{childPid:pid,submittedAt:new Date().toISOString()},x).then(()=>undefined)});
   const unknown=receipt.status==='UNKNOWN';await artifact(ctx,r,'CHECK_RECEIPT',receipt);await attemptUpdate(ctx,r,a,unknown?'UNKNOWN':'RETURNED',{receipt,physicalOutcome:unknown?'UNKNOWN':'RETURNED',grantChargeRetained:true},x,unknown?undefined:receipt.steps);
   await r1Current(ctx,r);if(receipt.status!=='COMPLETE'||!receipt.relationComplete)throw Error(receipt.predicate);
   if(candidate!.blocks.length===JSON.parse(source.model_bytes).states.length)predicate='R1_NO_REDUCTION_ORIGINAL_PATH_PREFERRED';
   else {evaluation=await native('S4_EVALUATE',{candidate,receipt});if(evaluation?.status!=='COMPLETE'||!evaluation.completeSearch)throw Error(evaluation?.reasons?.[0]??'R1_POLICY_SEARCH_INCOMPLETE');}
  }catch(error){predicate=safe(error);}
  if(!evaluation||evaluation.status!=='COMPLETE'){
   // Real child, same bytes/arithmetic, remaining original clock and funding.
   await r1Current(ctx,r);evaluation=await native('ORIGINAL_FALLBACK');fallback='ORIGINAL_PATH_EXECUTED';
  }
  const cut=await r1SourceCut(),used=process.cpuUsage(cpu),compute:S4ComputeInvocation={schema:'finnor.model-compute-invocation.v1',semanticOwner:'S4',id:'',tenantId:r.tenant_id,principalId:r.principal_id,rightsRef:source.mandate.rightsRef,inputRef:source.ref.id,outputRefs:[],requestedRoute:'LOCAL_FIXED_SCENARIO_SEARCH',actualRoute:'LOCAL_FIXED_SCENARIO_SEARCH',fallbacks:fallback?[predicate??fallback]:[],backend:{name:'finnor-nonanticipative-scenario-search',version:EXACT_S4_VERSION,sourceDigests:cut.files,nodeVersion:process.version,deterministicReplayClaimed:false},attempts:[{startedAt:new Date(Date.now()-(performance.now()-start)).toISOString(),finishedAt:new Date().toISOString(),status:evaluation!.status==='COMPLETE'?'POLICY_AVAILABLE':evaluation!.status==='INFEASIBLE'?'INFEASIBLE':evaluation!.status==='UNKNOWN'?'UNCERTAINTY_UNRESOLVED':'MODEL_UNSUPPORTED'}],usage:{elapsedMs:performance.now()-start,cpuUserMicros:used.user,cpuSystemMicros:used.system,rssBeforeBytes:rss,rssAfterBytes:process.memoryUsage().rss,expansions:evaluation!.stats.continuationEvaluations,transitionEvaluations:evaluation!.stats.steps,accountingScope:'PROCESS_INTERVAL_INCLUSIVE_NOT_CONTAINER_PEAK'},cost:{money:null,pricebookRef:null,status:'LOCAL_COST_UNMETERED',externalCalls:0},upstreamComputeRefs:physical.map(v=>sha(v)),admission:{status:'BLOCKED_EXTERNAL',receipt:null}};compute.id='model-compute:'+epistemicHash(compute);
  const profile:ExactControlPolicyProfile={schema:'finnor.s4.exact-policy-profile.v2',durableRunId:r.id,sourceRef:source.ref,modelBytes:source.model_bytes,modelDigest:source.model_digest,candidate:fallback?null:candidate,receipt:fallback?null:receipt,evaluation:evaluation!,authoritativeQuantities:'ORIGINAL_EXACT_SOURCE',legacyNumbers:'PRESENTATION_ONLY',dependencyDigest:epistemicHash(source.dependencies),beliefPins:source.belief_pins,sourceDigests:cut.files};
  // Materializing the original owner policy is real parent work. Reserve its
  // arithmetic under this same run and charge an original P1 step before use;
  // it does not invent another physical attempt or S5 funding grant.
  const projectionReservation=await tx(ctx,async c=>{await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['s5-portfolio:'+r.tenant_id]);const locked=await queueFence(c,r,x);await lockExactSourceCurrent(ctx,source,c);await grantFence(c,r);await assertR1ResponsibilityCurrent(ctx,c);const reserve=Math.min(1000000,r.request.envelope_inputs.maxMathSteps-Number(locked.math_steps_used));if(reserve<1)throw Error('R1_ORIGINAL_MATH_GRANT_EXHAUSTED');await c.query('UPDATE finnor_os.r1_runs SET math_steps_used=math_steps_used+$2 WHERE id=$1',[r.id,reserve]);const parent=await c.query('UPDATE finnor_os.p1_episodes SET steps_used=steps_used+1 WHERE id=$1 AND steps_used+1<=max_steps AND deadline_at=$2 AND deadline_at>clock_timestamp() RETURNING steps_used',[r.episode_id,r.original_deadline_at]);if(!parent.rowCount)throw Error('R1_ORIGINAL_P1_EPISODE_EXHAUSTED');await r1Event(ctx,r,'OWNER_PROJECTION_INTENT',{mathReservation:reserve,originalEpisode:r.episode_id,originalDeadlineAt:r.original_deadline_at.toISOString(),decisionDeadlineAt:r.decision_deadline_at.toISOString(),nativeAttemptCharged:false},c);return reserve;});
  const projectionAccount={steps:0},projectionStart=performance.now(),projectionCpu=process.cpuUsage(),projectionRss=process.memoryUsage().rss;
  const policy=buildExactControlPolicy(source.mandate,profile,compute,new Date().toISOString(),{deadlineAt:deadline,maxSteps:projectionReservation,account:projectionAccount,signal:controller.signal});
  const projectionUsage=process.cpuUsage(projectionCpu),projection={mathSteps:projectionAccount.steps,elapsedMs:performance.now()-projectionStart,cpuUserMicros:projectionUsage.user,cpuSystemMicros:projectionUsage.system,rssBeforeBytes:projectionRss,rssAfterBytes:process.memoryUsage().rss,usd:null,scope:'OWNER_ORIGINAL_POLICY_PROJECTION_PROCESS_INTERVAL_NOT_PEAK'};
  await tx(ctx,async c=>{await queueFence(c,r,x);await c.query('UPDATE finnor_os.r1_runs SET math_steps_used=math_steps_used-$2 WHERE id=$1 AND math_steps_used>=$2',[r.id,projectionReservation-projectionAccount.steps]);await r1Event(ctx,r,'OWNER_PROJECTION_RETURNED',projection,c);});
  if(policy)await publishEnterpriseExactControlPolicy(ctx,policy);
  // Prepared files remain fenced by durableRunId until this head commits.
  await r1Current(ctx,r);
  await tx(ctx,async c=>{
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['s5-portfolio:'+r.tenant_id]);await queueFence(c,r,x);const q=await requestRow(ctx,r.program_id,c);await assertProgramCurrent(ctx,q,c,true);await lockExactSourceCurrent(ctx,source,c);await grantFence(c,r);await assertR1ResponsibilityCurrent(ctx,c);if(Date.now()>=deadline)throw Error('R1_ORIGINAL_PUBLICATION_DEADLINE');
   const envelopeBody={schema:'finnor.r1.producer-envelope.v1' as const,workId:r.work_id,workRevision:r.work_input_id,tenantId:r.tenant_id,principalId:r.principal_id,baseCommit:cut.baseCommit,codeDigest:cut.codeDigest,lockDigest:cut.lockDigest,independentAdmissionRef:null,inputRefs:[source.ref,r.request.envelope_inputs.policyRequest,r.request.grant],inputDigest:source.source_digest,asOf:new Date().toISOString(),rightsRef:source.mandate.rightsRef,domain:'finite-information-rational-v1' as const,assumptions:JSON.parse(source.model_bytes).assumptions,grammar:'ORIGINAL_S4_CATALOGUE' as const,checkerBasis:'INDEPENDENT_ORIGINAL_BYTES_FRACTION' as const,claims:receipt?.relationComplete?['COMPLETE_SUPPLIED_INFORMATION_RELATION']:[],gaps:['CAUSAL_ADEQUACY_UNQUALIFIED','INDEPENDENT_ADMISSION_UNAVAILABLE','PROTECTED_COMPARISON_NOT_RUN','USD_AND_AGGREGATE_PEAK_UNMETERED'],resourceRefs:[r.binding.resourceRef,r.binding.reservationRef],grantRef:r.request.grant,dependencies:source.dependencies,lifecycle:receipt?.relationComplete?'CHECKED' as const:'UNKNOWN' as const,searchComplete:evaluation!.completeSearch,relationComplete:receipt?.relationComplete??false};
   if(receipt?.status==='COMPLETE'&&receipt.relationComplete)await r1Event(ctx,r,'DEVELOPMENT_VERIFIED',{lifecycle:'development-verified',claim:'COMPLETE_SUPPLIED_INFORMATION_RELATION',sourceRef:source.ref,checkerDigest:receipt.checkerDigest,checkerVersion:receipt.checkerVersion,domainQualified:false,s8Admitted:false,active:false,executionAuthorityGranted:false},c);
   const artifactEnvelope=await createR1ArtifactEnvelope(ctx,r,source,receipt,c,(kind,body)=>artifact(ctx,r,kind,body,c));
   const envelopeValue={...envelopeBody,artifactEnvelope};
   const envelope:R1WorkEnvelope={...envelopeValue,ref:{owner:'R1',id:'control-quotient:'+r.id,version:'r1-native-refinement-v1',contentDigest:sha(envelopeValue)}};
   const status=!fallback&&receipt?.relationComplete&&evaluation!.completeSearch?'COMPLETE':evaluation!.status==='INFEASIBLE'?'INFEASIBLE':evaluation!.status==='UNKNOWN'?'UNKNOWN':evaluation!.status==='UNSUPPORTED'?'UNSUPPORTED':'INCOMPLETE';
   const head={schema:'finnor.r1.head.v1',envelope,beforeStates:JSON.parse(source.model_bytes).states.length,candidate,receipt,evaluation,policy:policy?{ref:policy.ref,value:policy.certificate.valueBounds,admission:policy.admission}:null,predicate,fallback,compute,physical,projection,originalEpisode:r.episode_id,originalDeadlineAt:r.original_deadline_at.toISOString(),decisionDeadlineAt:r.decision_deadline_at.toISOString(),originalGrant:r.request.grant,authority:false};const saved=await artifact(ctx,r,'HEAD',head,c);
   await c.query('UPDATE finnor_os.r1_runs SET status=$2,head_id=$3,predicate=$4,fallback=$5,claim_token=NULL WHERE id=$1',[r.id,status,saved.id,predicate,fallback]);await r1Event(ctx,r,'PUBLISHED',{headId:saved.id,digest:saved.digest,status,policyRef:policy?.ref??null,originalEpisode:r.episode_id,admissionGranted:false},c);
  });
 }catch(error){
  controller.abort();if(error instanceof DatabaseExecutionDeadlineError)throw error;
  try{await tx(ctx,async c=>{const locked=await r1Row(ctx,r.id,c,true);if(locked.generation!==r.generation||['CANCELLED','INVALIDATED'].includes(locked.status))return;const predicate=safe(error),invalid=/CURRENT|REVISED|REVISION|RIGHTS|CHANGED|FENCED|S6|LIABILITY|OBLIGATION|METHOD/.test(predicate);await c.query("UPDATE finnor_os.r1_runs SET status=$2,predicate=$3,fallback=$4,claim_token=NULL,generation=generation+$5 WHERE id=$1",[r.id,invalid?'INVALIDATED':'UNKNOWN',predicate,invalid?'FALLBACK_UNAVAILABLE_CURRENT_OWNER_FENCED':'FALLBACK_UNAVAILABLE_ORIGINAL_REMAINING_GRANT',invalid?1:0]);await r1Event(ctx,locked,'STOPPED_WITH_RETAINED_WORK',{predicate,physicalResults:physical.map(v=>sha(v)),affected:r1AffectedDependencyClosure(r.id,r1DependencySeeds(predicate)),costsRetained:true,unknownLiabilitiesRetained:true,executionAuthorityGranted:false},c);if(invalid)await enqueueR1DependencyContinuation(ctx,locked,predicate,c);});}catch{ /* Spent original deadline: reconciliation retains durable attempts. */ }
  throw error;
 }finally{released=true;controller.abort();if(leases.length)await releaseComputeResourceLeases(leases,'r1_physical_work_finished').catch(()=>undefined);}
}
function safe(error:unknown){if(error instanceof ComputeCapacityUnavailableError)return 'R1_SHARED_PHYSICAL_CAPACITY_UNAVAILABLE';const value=(error as Error)?.message;return typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,159}$/.test(value)?value:'R1_OWNER_OR_PROCESS_PREDICATE_UNPASSED';}
