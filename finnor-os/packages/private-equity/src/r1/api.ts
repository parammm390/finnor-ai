import {env as runtimeEnvironment} from 'node:process';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {PoolClient} from 'pg';
import type {ExperimentRef,R1WorkProjection} from '@finnor/shared-types';
import {ExperimentRefSchema,parseExactInformationModel,epistemicHash} from '@finnor/epistemic-runtime';
import type {PeMutationContext,PeWorldRootRef} from '../types';
import {authorize,principal,sha,stable,tx,unavailable} from '../evidence-execution/store';
import {requestRow,assertProgramCurrent} from '../program-synthesis/store';
import {resolveSearchOwners,recheckSearchOwners} from '../compute-search/owners';
import {resolveExactControlSource,type ExactSourceRow,lockExactSourceCurrent} from './source';
import {r1SourceCut} from './runtime';
import {r1AffectedDependencyClosure,r1DependencySeeds,enqueueR1DependencyContinuation} from './dependencies';
import {readEnterpriseContingentPolicy} from '../enterprise-control';
import {readR1Eligibility,readExactControlReview} from './review';
import {readEnterpriseAllocation} from '../enterprise-allocation';
import {readR1Responsibility,assertR1ResponsibilityCurrent} from './responsibility';

export const R1_OPERATIONS=['r1-submit','r1-read','r1-projection','r1-review','r1-cancel','r1-reconcile','r1-history','r1-record'] as const;
const Submit=z.object({schema:z.literal('finnor.r1.run.v1'),problem_ref:ExperimentRefSchema,
 envelope_inputs:z.object({programId:z.string().uuid(),policyRequest:ExperimentRefSchema,maxMathSteps:z.number().int().min(1).max(4000000).default(4000000)}).strict(),
 work_rev:z.string().uuid(),domain:z.literal('finite-information-rational-v1'),grant:ExperimentRefSchema,cancel:z.literal(false).default(false),idempotencyKey:z.string().min(1).max(256)}).strict();
const Read=z.object({runId:z.string().uuid()}).strict();
const CommonSubmit=z.object({schema:z.literal('finnor.r1.run.v2'),problem_ref:ExperimentRefSchema,envelope_inputs:Submit.shape.envelope_inputs,
 existing_work_revision:z.string().uuid(),domain_profile_ref:ExperimentRefSchema,budget_grant_ref:ExperimentRefSchema,cancellation_ref:ExperimentRefSchema.nullable(),idempotencyKey:z.string().min(1).max(256)}).strict();
const CommonRead=z.object({schema:z.literal('finnor.r1.common-read.v1'),runId:z.string().uuid()}).strict();
const RecordRead=z.object({schema:z.literal('finnor.r1.record-read.v1'),runId:z.string().uuid(),ref:ExperimentRefSchema}).strict();
const Projection=z.object({workId:z.string().uuid(),root:z.object({entityType:z.string(),entityId:z.string().uuid()}).strict()}).strict();
export interface R1RunRow {id:string;tenant_id:string;principal_id:string;program_id:string;model_id:string;work_id:string;work_input_id:string;episode_id:string;request:z.infer<typeof Submit>;request_digest:string;binding:any;generation:number;status:string;original_deadline_at:Date;decision_deadline_at:Date;math_steps_used:number;claim_token:string|null;claim_fence:number|null;head_id:string|null;predicate:string|null;fallback:string|null}
export async function r1Row(ctx:PeMutationContext,id:string,c?:PoolClient,lock=false):Promise<R1RunRow>{const read=async(client:PoolClient)=>{const row=(await client.query<R1RunRow>('SELECT * FROM finnor_os.r1_runs WHERE tenant_id=$1 AND principal_id=$2 AND id=$3'+(lock?' FOR UPDATE':''),[ctx.auth.tenantId,principal(ctx),id])).rows[0];if(!row)throw unavailable();return row;};return c?read(c):tx(ctx,read,true);}
export async function r1Event(ctx:PeMutationContext,row:R1RunRow,kind:string,body:unknown,c?:PoolClient){const write=async(client:PoolClient)=>(await client.query<{id:string;digest:string}>('INSERT INTO finnor_os.r1_events(tenant_id,principal_id,run_id,kind,body,digest) VALUES($1,$2,$3,$4,$5::jsonb,$6) RETURNING id,digest',[row.tenant_id,row.principal_id,row.id,kind,stable(body),sha(body)])).rows[0]!;return c?write(c):tx(ctx,write);}
/** Expiry is lifecycle bookkeeping, never another computation allowance.
 * Both authenticated current reads and the real queue delivery use this owner.
 * Retain every accepted physical attempt and original charge for reconciliation. */
export async function expireR1Decision(ctx:PeMutationContext,id:string,c?:PoolClient):Promise<R1RunRow>{
 const close=async(client:PoolClient)=>{
  const row=await r1Row(ctx,id,client,true);
  if(row.decision_deadline_at.getTime()>Date.now()||row.head_id||!['QUEUED','RUNNING'].includes(row.status))return row;
  await client.query("UPDATE finnor_os.r1_runs SET status='UNKNOWN',predicate='R1_ORIGINAL_DECISION_DEADLINE_EXHAUSTED',fallback='FALLBACK_UNAVAILABLE_ORIGINAL_RESPONSE_DEADLINE',generation=generation+1,claim_token=NULL WHERE id=$1",[row.id]);
  await r1Event(ctx,row,'DECISION_DEADLINE_EXHAUSTED',{originalEpisode:row.episode_id,decisionDeadlineAt:row.decision_deadline_at.toISOString(),originalDeadlineAt:row.original_deadline_at.toISOString(),priorGeneration:row.generation,costsRetained:true,physicalAttemptsRetained:true,unknownResponsibilitiesReleased:false,automaticResubmission:false,executionAuthorityGranted:false},client);
  return r1Row(ctx,id,client);
 };
 return c?close(c):tx(ctx,close);
}
export async function r1Current(ctx:PeMutationContext,row:R1RunRow,c?:PoolClient){
 const q=await requestRow(ctx,row.program_id,c);await assertProgramCurrent(ctx,q,c,!!c);
 if(['CANCELLED','INVALIDATED','FAILED','PARTIAL'].includes(q.status))throw Error('R1_ORIGINAL_PROGRAM_STOPPED');
 const responsibility=await readR1Responsibility(ctx);if(responsibility.unresolved.length||responsibility.hasMore)throw Error('R1_S6_OUTSTANDING_RESPONSIBILITY_RETAINED');
 const source=await resolveExactControlSource(ctx,row.request.problem_ref);
 if(source.id!==row.model_id||source.work_input_id!==row.work_input_id||q.work_input_id!==row.work_input_id||q.episode_id!==row.episode_id)throw Error('R1_ORIGINAL_EPISODE_OR_INPUT_CHANGED');
 await recheckSearchOwners(ctx,q,{request:{policyRequest:row.request.envelope_inputs.policyRequest,computeGrant:row.request.grant},binding:row.binding});
 if(c)await lockExactSourceCurrent(ctx,source,c);
 if((await r1SourceCut()).codeDigest!==source.source_cut.codeDigest)throw Error('R1_CURRENT_SOURCE_CUT_CHANGED');
 return {q,source};
}
export async function assertR1PolicyPublished(ctx:PeMutationContext,id:string,ref:ExperimentRef){
 const row=await r1Row(ctx,id);if(!row.head_id||['QUEUED','RUNNING','INVALIDATED','CANCELLED'].includes(row.status))throw Error('R1_POLICY_PUBLICATION_FENCED');
 const head=await tx(ctx,async c=>(await c.query('SELECT body,digest,generation FROM finnor_os.r1_artifacts WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND run_id=$4 AND kind=\'HEAD\'',[row.tenant_id,row.principal_id,row.head_id,row.id])).rows[0],true);
 if(!head||sha(head.body)!==head.digest||head.generation!==row.generation||epistemicHash(head.body.policy?.ref)!==epistemicHash(ref)||row.status==='COMPLETE'&&!head.body.receipt?.relationComplete||row.status!=='COMPLETE'&&head.body.fallback!=='ORIGINAL_PATH_EXECUTED')throw Error('R1_POLICY_PUBLICATION_FENCED');
 const q=await requestRow(ctx,row.program_id);await assertProgramCurrent(ctx,q);
}
async function costs(ctx:PeMutationContext,row:R1RunRow){return tx(ctx,async c=>{const a=(await c.query('SELECT count(*)::int attempts,count(*) FILTER(WHERE status IN(\'INTENT\',\'SUBMITTED\',\'UNKNOWN\'))::int unknown FROM finnor_os.r1_attempts WHERE tenant_id=$1 AND principal_id=$2 AND run_id=$3',[row.tenant_id,row.principal_id,row.id])).rows[0];return {...a,usd:null};},true);}
export async function readR1(ctx:PeMutationContext,id:string){
 let row=await r1Row(ctx,id),q=await requestRow(ctx,row.program_id);await authorize(ctx,q.request.root,[{type:'work',id:q.work_id}]);
 if(['QUEUED','RUNNING'].includes(row.status)&&row.decision_deadline_at.getTime()<=Date.now())row=await expireR1Decision(ctx,id);
 if(!['INVALIDATED','CANCELLED'].includes(row.status)){
  try{await r1Current(ctx,row);}catch(error){
   if((error as Error).message==='Evidence resource is unavailable in the authenticated scope')throw error;
   const predicate=(error as Error).message.match(/^[A-Z][A-Z0-9_]{0,159}$/)?.[0]??'R1_CURRENT_OWNER_PREDICATE_UNPASSED';
   await tx(ctx,async c=>{const locked=await r1Row(ctx,id,c,true);if(['CANCELLED','INVALIDATED'].includes(locked.status))return;await c.query("UPDATE finnor_os.r1_runs SET status='INVALIDATED',predicate=$4,generation=generation+1,claim_token=NULL WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",[row.tenant_id,row.principal_id,id,predicate]);await r1Event(ctx,locked,'INVALIDATED',{predicate,priorHead:locked.head_id,affected:r1AffectedDependencyClosure(locked.id,r1DependencySeeds(predicate)),costsRetained:true,obligationsReleased:false},c);await enqueueR1DependencyContinuation(ctx,locked,predicate,c);});row=await r1Row(ctx,id);
  }
 }
 let head:any=null;if(row.head_id&&!['INVALIDATED','CANCELLED'].includes(row.status))head=await tx(ctx,async c=>{const h=(await c.query('SELECT body,digest,generation FROM finnor_os.r1_artifacts WHERE tenant_id=$1 AND principal_id=$2 AND run_id=$3 AND id=$4 AND kind=\'HEAD\'',[row.tenant_id,row.principal_id,row.id,row.head_id])).rows[0];if(!h||sha(h.body)!==h.digest||h.generation!==row.generation)throw Error('R1_IMMUTABLE_HEAD_CHANGED');return h.body;},true);
 await authorize(ctx,q.request.root,[{type:'work',id:q.work_id}]);
 const retained=await tx(ctx,async c=>({artifacts:(await c.query('SELECT id,kind,digest FROM finnor_os.r1_artifacts WHERE tenant_id=$1 AND principal_id=$2 AND run_id=$3 ORDER BY created_at,id',[row.tenant_id,row.principal_id,row.id])).rows,
  attempts:(await c.query('SELECT id,stage,status,child_pid,digest FROM finnor_os.r1_attempts WHERE tenant_id=$1 AND principal_id=$2 AND run_id=$3 ORDER BY created_at,id',[row.tenant_id,row.principal_id,row.id])).rows,
  events:(await c.query('SELECT id,kind,body,digest FROM finnor_os.r1_events WHERE tenant_id=$1 AND principal_id=$2 AND run_id=$3 ORDER BY created_at,id',[row.tenant_id,row.principal_id,row.id])).rows}),true);
 if(retained.events.some(e=>sha(e.body)!==e.digest))throw Error('R1_IMMUTABLE_LIFECYCLE_CHANGED');
 const refs=retained.artifacts.map(a=>({owner:'R1',id:'artifact:'+a.id,version:'finnor.r1.immutable-artifact.v1',contentDigest:a.digest,kind:a.kind}));
 const eventRefs=retained.events.map(e=>({owner:'R1',id:'event:'+e.id,version:'finnor.r1.lifecycle-event.v1',contentDigest:e.digest,kind:e.kind}));
 return {schema:'finnor.r1.current-reader.v1',id:row.id,workId:row.work_id,workRevision:row.work_input_id,status:row.status,predicate:row.predicate,fallback:row.fallback,head,costs:await costs(ctx,row),
  artifact_ref:head?refs.find(r=>r.id==='artifact:'+row.head_id)??null:null,incumbent_ref:head?.policy?.ref??null,resource_receipts:refs.filter(r=>r.kind!=='HEAD'),lifecycle_event_refs:eventRefs,
  unresolved_claims:['CAUSAL_ADEQUACY','INDEPENDENT_DOMAIN_ADMISSION','PROTECTED_GAIN','ECONOMIC_RELEASE',...(!head?.evaluation?.completeSearch?['COMPLETE_POLICY_SEARCH']:[]),...(!head?.receipt?.relationComplete?['COMPLETE_RELATION']:[])],
  attempts:retained.attempts,originalEpisode:row.episode_id,originalDeadlineAt:row.original_deadline_at.toISOString(),decisionDeadlineAt:row.decision_deadline_at.toISOString(),originalGrant:row.request.grant,
  cancellation:{requested:row.status==='CANCELLED',generation:row.generation,ref:(()=>{const e=eventRefs.find(e=>e.kind==='CANCELLED');return e?{owner:e.owner,id:e.id,version:e.version,contentDigest:e.contentDigest}:null;})(),physicallyReleasedComputeOnly:true,unknownResponsibilitiesReleased:false},responsibility:await readR1Responsibility(ctx),qualification:'SUPPLIED_MODEL_RELATIVE_UNADMITTED',executionAuthorityGranted:false};
}
async function commonResult(ctx:PeMutationContext,id:string){
 const current=await readR1(ctx,id),anchor=current.lifecycle_event_refs.find(e=>e.kind==='ACCEPTED');
 if(!anchor)throw Error('R1_ORIGINAL_ACCEPTED_LIFECYCLE_REQUIRED');
 return {...current,schema:'finnor.r1.common-result.v1',status:['QUEUED','RUNNING','CANCELLED','PARTIAL'].includes(current.status)?'INCOMPLETE':['COMPLETE','INCOMPLETE','INFEASIBLE','UNSUPPORTED','INVALIDATED','UNKNOWN'].includes(current.status)?current.status:'UNKNOWN',runtime_status:current.status,
  artifact_envelope:current.head?.envelope.artifactEnvelope??null,
  unresolved_claim_refs:current.unresolved_claims.map(claim_id=>({...anchor,claim_id})),
  resource_receipt_refs:current.head?.envelope.artifactEnvelope?.resource_receipt_refs??[...current.resource_receipts,...current.lifecycle_event_refs.filter(e=>e.kind==='COMMON_PREPARATION_CHARGED')]};
}
export async function handleR1Operation(ctx:PeMutationContext,operation:string,body:unknown):Promise<{status:number;body:unknown}>{
 if(operation==='r1-submit'){
  const common=typeof body==='object'&&body!==null&&(body as {schema?:unknown}).schema==='finnor.r1.run.v2'?CommonSubmit.parse(body):null;
  if(common&&epistemicHash(common.domain_profile_ref)!==epistemicHash(common.problem_ref))throw Error('R1_ORIGINAL_S3_DOMAIN_PROFILE_REQUIRED');
  if(common?.cancellation_ref){
   const ref=common.cancellation_ref;
   if(ref.owner!=='R1'||ref.version!=='finnor.r1.lifecycle-event.v1'||!/^event:[a-f0-9-]{36}$/.test(ref.id))throw unavailable();
   const cancelled=await tx(ctx,async c=>(await c.query('SELECT e.run_id,e.body,e.digest,r.request,r.work_input_id,r.status FROM finnor_os.r1_events e JOIN finnor_os.r1_runs r ON r.id=e.run_id AND r.tenant_id=e.tenant_id AND r.principal_id=e.principal_id WHERE e.tenant_id=$1 AND e.principal_id=$2 AND e.id=$3 AND e.kind=\'CANCELLED\'',[ctx.auth.tenantId,principal(ctx),ref.id.slice(6)])).rows[0],true);
   if(!cancelled||cancelled.status!=='CANCELLED'||cancelled.digest!==ref.contentDigest||sha(cancelled.body)!==ref.contentDigest||cancelled.work_input_id!==common.existing_work_revision||epistemicHash(cancelled.request.problem_ref)!==epistemicHash(common.problem_ref)||epistemicHash(cancelled.request.grant)!==epistemicHash(common.budget_grant_ref)||epistemicHash(cancelled.request.envelope_inputs)!==epistemicHash(common.envelope_inputs))throw unavailable();
   return {status:200,body:await commonResult(ctx,cancelled.run_id)};
  }
  const input=Submit.parse(common?{schema:'finnor.r1.run.v1',problem_ref:common.problem_ref,envelope_inputs:common.envelope_inputs,work_rev:common.existing_work_revision,domain:'finite-information-rational-v1',grant:common.budget_grant_ref,cancel:false,idempotencyKey:common.idempotencyKey}:body),q=await requestRow(ctx,input.envelope_inputs.programId),source=await resolveExactControlSource(ctx,input.problem_ref);await assertProgramCurrent(ctx,q);
  if(runtimeEnvironment.NODE_ENV==='production'||process.env.FINNOR_P4_PROFILE!=='ordinary_disposable')throw Error('R1_PROTECTED_DOMAIN_ADMISSION_AND_FUNDING_UNAVAILABLE');
  if(q.work_input_id!==input.work_rev||source.work_input_id!==input.work_rev||q.work_id!==source.work_id||epistemicHash(q.request.root)!==epistemicHash(source.belief_pins[0]?.root))throw Error('R1_EXACT_WORK_AND_SOURCE_BINDING_REQUIRED');
 const baseline=await readEnterpriseContingentPolicy(ctx,input.envelope_inputs.policyRequest);if(baseline.exactProfile?.modelDigest!==source.model_digest||epistemicHash(baseline.mandateRef)!==epistemicHash(source.mandate.ref))throw Error('R1_SAME_ORIGINAL_EXACT_S4_INPUT_REQUIRED');
 const issued=await readEnterpriseAllocation(ctx,input.grant);
 const preparation=await tx(ctx,async c=>(await c.query('SELECT id,body,digest FROM finnor_os.r1_preparation_receipts WHERE tenant_id=$1 AND principal_id=$2 AND model_id=$3 ORDER BY created_at,id LIMIT 257',[source.tenant_id,source.principal_id,source.id])).rows,true);
 if(!preparation.length||preparation.length>256||preparation.some(r=>sha(r.body)!==r.digest))throw Error('R1_COMPLETE_SOURCE_PREPARATION_RECEIPTS_REQUIRED');
 const commonPreparation={schema:'finnor.r1.common-preparation.v1',source:preparation,originalS4:{policyRef:baseline.ref,asOf:baseline.knowledgeAt,compute:baseline.compute,mathSteps:baseline.exactProfile?.evaluation.stats.steps},originalS5:{grantRef:issued.certificate.ref,asOf:issued.certificate.validFrom,compute:issued.certificate.compute},allocation:'CHARGE_COMMON_PREPARATION_IDENTICALLY_TO_OFF_AND_ON',usd:null,aggregateSimultaneousPeak:null};
 const coldMathSteps=preparation.reduce((n,r)=>n+Number(r.body.mathSteps),0)+Number(baseline.exactProfile?.evaluation.stats.steps??0);
 if(!Number.isSafeInteger(coldMathSteps)||coldMathSteps>=input.envelope_inputs.maxMathSteps)throw Error('R1_ORIGINAL_MATH_GRANT_EXHAUSTED_BY_PREPARATION');
 const binding=await resolveSearchOwners(ctx,q,{schema:'finnor.compute-search-request.v1',programId:q.id,mode:'ordinary_disposable',policyRequest:input.envelope_inputs.policyRequest,computeGrant:input.grant,limits:{maxUnits:8,maxParallel:1},strategy:'FIXED_SEQUENTIAL',requestedKinds:[],routeIds:[],idempotencyKey:input.idempotencyKey}),digest=sha(input);
  const result=await tx(ctx,async c=>{
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,4711))',[ctx.auth.tenantId+':'+principal(ctx)+':'+input.idempotencyKey]);
   const prior=(await c.query('SELECT id,request_digest,status FROM finnor_os.r1_runs WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',[ctx.auth.tenantId,principal(ctx),input.idempotencyKey])).rows[0];
   if(prior){if(prior.request_digest!==digest)throw Error('R1_IDEMPOTENCY_CONFLICT');return {runId:prior.id,status:prior.status,replayed:true};}
   await assertProgramCurrent(ctx,q,c,true);await lockExactSourceCurrent(ctx,source,c);await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['s5-portfolio:'+q.tenant_id]);await assertR1ResponsibilityCurrent(ctx,c);
   const episode=(await c.query('SELECT deadline_at FROM finnor_os.p1_episodes WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 FOR SHARE',[q.tenant_id,q.principal_id,q.episode_id])).rows[0];if(!episode||episode.deadline_at.getTime()<=Date.now())throw Error('R1_ORIGINAL_EPISODE_EXPIRED');
   const decisionDeadlineAt=new Date(Math.min(episode.deadline_at.getTime(),Date.now()+source.mandate.search.deadlineMs,Date.parse(binding.validUntil),Date.parse(source.mandate.validUntil)));
   const id=randomUUID();await c.query('INSERT INTO finnor_os.r1_runs(id,tenant_id,principal_id,program_id,model_id,work_id,work_input_id,episode_id,idempotency_key,request,request_digest,binding,original_deadline_at,decision_deadline_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb,$13,$14)',[id,q.tenant_id,q.principal_id,q.id,source.id,q.work_id,q.work_input_id,q.episode_id,input.idempotencyKey,stable(input),digest,stable(binding),episode.deadline_at,decisionDeadlineAt]);
   await c.query('UPDATE finnor_os.r1_runs SET math_steps_used=$2 WHERE id=$1',[id,coldMathSteps]);
   const row=await r1Row(ctx,id,c);await r1Event(ctx,row,'COMMON_PREPARATION_CHARGED',{...commonPreparation,coldMathSteps,originalEpisode:row.episode_id,originalGrant:input.grant},c);await r1Event(ctx,row,'ACCEPTED',{lifecycle:'proposed',sourceRef:source.ref,workRevision:q.work_input_id,originalEpisode:q.episode_id,originalDeadlineAt:episode.deadline_at.toISOString(),decisionDeadlineAt:decisionDeadlineAt.toISOString(),grant:input.grant,probabilityLawQualified:false,admissionGranted:false,unresolvedClaims:['CAUSAL_ADEQUACY','INDEPENDENT_DOMAIN_ADMISSION','PROTECTED_GAIN','ECONOMIC_RELEASE','COMPLETE_POLICY_SEARCH','COMPLETE_RELATION']},c);
   await c.query("INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,protocol_version,retry_safety) VALUES($1,'run_certified_state_reduction_v1',$2::jsonb,$3,'interactive',1,'reconcilable') ON CONFLICT(idempotency_key) DO NOTHING",[q.tenant_id,stable({tenantId:q.tenant_id,principalId:q.principal_id,runId:id,generation:1,originalDeadlineAt:episode.deadline_at.toISOString(),decisionDeadlineAt:decisionDeadlineAt.toISOString()}),'r1:'+id+':1']);
   return {runId:id,workId:q.work_id,workRevision:q.work_input_id,status:'QUEUED',replayed:false};
  });return {status:202,body:common?{...await commonResult(ctx,result.runId),runId:result.runId,replayed:result.replayed}:result};
 }
 if(operation==='r1-record'){
  const input=RecordRead.parse(body),row=await r1Row(ctx,input.runId),q=await requestRow(ctx,row.program_id);
  await authorize(ctx,q.request.root,[{type:'work',id:q.work_id}]);
  const ref=input.ref,match=/^(artifact|event|r1-preparation):([a-f0-9-]{36})$/.exec(ref.id);
  if(!match)throw unavailable();
  const type=match[1],record=await tx(ctx,async c=>{
   if(type==='artifact'&&ref.owner==='R1'&&ref.version==='finnor.r1.immutable-artifact.v1')return (await c.query('SELECT kind,body,digest FROM finnor_os.r1_artifacts WHERE tenant_id=$1 AND principal_id=$2 AND run_id=$3 AND id=$4',[row.tenant_id,row.principal_id,row.id,match[2]])).rows[0];
   if(type==='event'&&ref.owner==='R1'&&ref.version==='finnor.r1.lifecycle-event.v1')return (await c.query('SELECT kind,body,digest FROM finnor_os.r1_events WHERE tenant_id=$1 AND principal_id=$2 AND run_id=$3 AND id=$4',[row.tenant_id,row.principal_id,row.id,match[2]])).rows[0];
   if(type==='r1-preparation'&&ref.owner==='S3'&&ref.version==='finnor.r1.source-preparation.v1')return (await c.query("SELECT 'SOURCE_PREPARATION' AS kind,body,digest FROM finnor_os.r1_preparation_receipts WHERE tenant_id=$1 AND principal_id=$2 AND model_id=$3 AND id=$4",[row.tenant_id,row.principal_id,row.model_id,match[2]])).rows[0];
  },true);
  if(!record||record.digest!==ref.contentDigest||sha(record.body)!==ref.contentDigest)throw unavailable();
  await authorize(ctx,q.request.root,[{type:'work',id:q.work_id}]);
  return {status:200,body:{schema:'finnor.r1.record.v1',runId:row.id,ref,kind:record.kind,body:record.body,currentValidityAsserted:false,executionAuthorityGranted:false}};
 }
 if(operation==='r1-projection'){
  const input=Projection.parse(body);await authorize(ctx,input.root as PeWorldRootRef,[{type:'work',id:input.workId}]);
  const rows=await tx(ctx,async c=>(await c.query('SELECT id FROM finnor_os.r1_runs WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 ORDER BY created_at DESC LIMIT 16',[ctx.auth.tenantId,principal(ctx),input.workId])).rows,true),runs:R1WorkProjection['runs']=[];
  for(const row of rows){const r=await r1Row(ctx,row.id),q=await requestRow(ctx,r.program_id);if(stable(q.request.root)!==stable(input.root))continue;const current=await readR1(ctx,row.id);runs.push({id:r.id,status:current.status,predicate:current.predicate,envelope:current.head?.envelope??null,policyRef:current.head?.policy?.ref??null,beforeStates:current.head?.beforeStates??0,afterStates:current.head?.candidate?.blocks.length??null,costs:current.costs,qualification:'SUPPLIED_MODEL_RELATIVE_UNADMITTED',fallback:current.fallback});}
  const eligibility=await readR1Eligibility(ctx,input.workId,input.root as PeWorldRootRef);
  await authorize(ctx,input.root as PeWorldRootRef,[{type:'work',id:input.workId}]);return {status:200,body:{schema:'finnor.r1.work-projection.v1',workId:input.workId,workRevision:runs[0]?.envelope?.workRevision??eligibility.candidates[0]?.workRevision??null,runs,eligibility}};
 }
 const commonRead=operation==='r1-read'&&typeof body==='object'&&body!==null&&(body as {schema?:unknown}).schema==='finnor.r1.common-read.v1';
 const id=(commonRead?CommonRead:Read).parse(body).runId,row=await r1Row(ctx,id),q=await requestRow(ctx,row.program_id);await authorize(ctx,q.request.root,[{type:'work',id:q.work_id}]);
 if(operation==='r1-read')return {status:200,body:commonRead?await commonResult(ctx,id):await readR1(ctx,id)};
 if(operation==='r1-review'){const current=await readR1(ctx,id),review=current.head?.policy?.ref?await readExactControlReview(ctx,current.head.policy.ref):null;return {status:200,body:{...current,head:current.head?{envelope:current.head.envelope,beforeStates:current.head.beforeStates,afterStates:current.head.receipt?.relationComplete?current.head.candidate?.blocks.length??null:null,relationComplete:current.head.receipt?.relationComplete??false,searchComplete:current.head.evaluation.completeSearch,stats:current.head.evaluation.stats,originalPolicyProjection:current.head.projection,checkerPredicate:current.head.receipt?.predicate}:null,review}};}
 if(operation==='r1-history'){const events=await tx(ctx,async c=>(await c.query('SELECT id,kind,body,digest,created_at FROM finnor_os.r1_events WHERE tenant_id=$1 AND principal_id=$2 AND run_id=$3 ORDER BY created_at,id LIMIT 257',[row.tenant_id,row.principal_id,id])).rows,true);return {status:200,body:{runId:id,events:events.slice(0,256),hasMore:events.length>256,headIsCurrent:false,authority:false}};}
 if(operation==='r1-cancel'){
  await tx(ctx,async c=>{const locked=await r1Row(ctx,id,c,true);if(locked.status==='CANCELLED')return;await c.query("UPDATE finnor_os.r1_runs SET status='CANCELLED',generation=generation+1,claim_token=NULL,predicate='USER_CANCELLED' WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",[row.tenant_id,row.principal_id,id]);await r1Event(ctx,locked,'CANCELLED',{priorHead:locked.head_id,physicalWorkCostsRetained:true,obligationsReleased:false},c);});return {status:200,body:await readR1(ctx,id)};
 }
 if(operation==='r1-reconcile'){
  // Reconciliation observes actual failed/expired delivery, retains costs and
  // UNKNOWN work. It never silently renews the original deadline or resubmits.
  await tx(ctx,async c=>{const locked=await r1Row(ctx,id,c,true);const outstanding=(await c.query("SELECT a.id,a.status,j.status job_status,j.lease_expires_at FROM finnor_os.r1_attempts a JOIN finnor_os.job_delivery_attempts d ON d.id=a.delivery_id JOIN finnor_os.jobs j ON j.id=d.job_id WHERE a.tenant_id=$1 AND a.principal_id=$2 AND a.run_id=$3 AND a.status IN('INTENT','SUBMITTED') FOR UPDATE OF a",[row.tenant_id,row.principal_id,id])).rows;
   for(const a of outstanding)if(a.job_status!=='running'||a.lease_expires_at?.getTime()<Date.now()){await c.query("UPDATE finnor_os.r1_attempts SET status='UNKNOWN' WHERE id=$1",[a.id]);await r1Event(ctx,locked,'PHYSICAL_OUTCOME_UNKNOWN_RETAINED',{attemptId:a.id,mathReservationRetained:true,grantChargeRetained:true,automaticResubmission:false},c);}
   if(outstanding.some(a=>a.job_status!=='running'||a.lease_expires_at?.getTime()<Date.now())&&!['CANCELLED','INVALIDATED'].includes(locked.status))await c.query("UPDATE finnor_os.r1_runs SET status='UNKNOWN',predicate='PHYSICAL_OUTCOME_UNKNOWN_RETAINED',claim_token=NULL WHERE id=$1",[id]);
  });return {status:200,body:await readR1(ctx,id)};
 }
 throw Error('R1_UNKNOWN_OPERATION');
}
