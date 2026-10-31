import type {PoolClient} from 'pg';
import {employeeAuthoritySnapshotTx} from '@finnor/authority';
import type {AllocationResource,CanonicalAllocationProblem,AllocationCertificate,S5ExperienceEvent} from '../../../shared-types/src/allocation';
import type {TotalAlgorithmTheoryCapsule} from '../../../shared-types/src/total-algorithm-theory';
import {parseTotalCapsule} from '../../../epistemic-runtime/src/uniform-algorithms/total/capsule';
import {AllocationOperationSchemas,sameAllocationRef} from '../../../epistemic-runtime/src/allocation-contracts';
import {epistemicHash} from '../../../epistemic-runtime/src/source-precedence';
import {assertEnterpriseAllocationInputVisibility,assertEnterpriseAllocationSourceVisibility} from '../enterprise-allocation';
import {authorizeAllocationResourceReads} from '../allocation-store';
import {revisions} from '../owner-context';
import {recheckSharedWithinResolution,withResolutionMemo} from '../resolution-memo';
import type {PeMutationContext,PeWorldRootRef} from '../types';
import {workCutTx,assertAuthorityTemporalBoundsTx} from '../enterprise-applications/store';
import {resolveTotalTask,type TotalTaskBinding} from '../allocation-total-task';
import {assertTotalTypedSources,assertTotalTaskSourceVisibilityTx} from '../allocation-total-episodes';
import {resolveTotalSpecification} from './specification';
import {tx,authorizeTx,principal,commonDiscoveryTx} from './store';
import {currentUniformEnvironment} from './source-cut';
import {digest,fail} from './contracts';
import {isTotalDiscovery,assertTotalEpisodeCut,assembleTotalDevelopment,totalSelectionRule,totalGenericProbes,
 type TotalDiscoveryRow,type TotalOwnerBinding} from './total-contracts';
export {isTotalDiscovery,type TotalDiscoveryRow} from './total-contracts';

export async function totalDiscoveryTx(ctx:PeMutationContext,c:PoolClient,id:string,lock=false){
 const a=await commonDiscoveryTx(ctx,c,id,lock);
 if(!isTotalDiscovery(a))fail('Y5_TOTAL_V2_CAPSULE_REQUIRED');return a;
}
export async function totalCutTx(ctx:PeMutationContext,c:PoolClient,root:PeWorldRootRef,workId:string,taskWorkId:string){
 await authorizeTx(ctx,c,root,workId);await authorizeTx(ctx,c,root,taskWorkId);
 const authority=await employeeAuthoritySnapshotTx(ctx.auth,c);
 const dependencies=await revisions(ctx,['rights:tenant','m3:root:'+root.entityType+':'+root.entityId,
  'canonical:'+root.entityType+':'+root.entityId,'work-inputs:'+workId,'work-inputs:'+taskWorkId],c,true);
 return {work:await workCutTx(c,{tenant_id:ctx.auth.tenantId,work_id:workId}),
  taskWork:await workCutTx(c,{tenant_id:ctx.auth.tenantId,work_id:taskWorkId}),authorityRevision:String(authority.revision),dependencies};
}
export async function assertTotalTaskTx(ctx:PeMutationContext,c:PoolClient,root:PeWorldRootRef,task:TotalTaskBinding){
 await authorizeTx(ctx,c,root,task.workId);
 await revisions(ctx,['work-inputs:'+task.workId],c,true);
 if(digest(await workCutTx(c,{tenant_id:ctx.auth.tenantId,work_id:task.workId}))!==digest(task.work))
  fail('Y5_TOTAL_TASK_WORK_INPUT_CHANGED');
 const row=(await c.query('SELECT status,current_owner_id FROM finnor_os.works WHERE tenant_id=$1 AND id=$2 FOR SHARE',
  [ctx.auth.tenantId,task.workId])).rows[0];
 if(!row||['failed','cancelled','completed'].includes(row.status)||row.current_owner_id&&row.current_owner_id!==principal(ctx))
  fail('Y5_TOTAL_TASK_WORK_NOT_CURRENT');
}
export type TotalBindingPurpose='DISCOVERY'|'USE'|'READ'|'ADMISSION';
export async function currentTotalTx(ctx:PeMutationContext,c:PoolClient,a:TotalDiscoveryRow,purpose:TotalBindingPurpose='USE'){
 if(['CANCELLED','INVALIDATED'].includes(a.status))fail('Y5_TOTAL_CANCELLED_OR_INVALIDATED');
 if(purpose==='DISCOVERY'&&a.deadline_at.getTime()<=Date.now())fail('Y5_TOTAL_ORIGINAL_CAMPAIGN_DEADLINE');
 const root={entityType:a.root_type,entityId:a.root_id};
 const cut=await totalCutTx(ctx,c,root,a.work_id,a.request.taskWorkId);
 if(digest(cut.work)!==digest(a.binding.work))fail('Y5_CURRENT_WORK_INPUT_CHANGED');
 if(digest(cut.taskWork)!==digest(a.binding.originalTask.work))fail('Y5_TOTAL_TASK_WORK_INPUT_CHANGED');
 if(cut.authorityRevision!==a.binding.authorityRevision)fail('Y5_CURRENT_AUTHORITY_REVISION_CHANGED');
 if(digest(cut.dependencies)!==digest(a.binding.dependencies))fail('Y5_TOTAL_ORIGINAL_SOURCE_OR_RIGHTS_CHANGED');
 await assertTotalTaskTx(ctx,c,root,a.binding.originalTask);
 const row=(await c.query('SELECT status,current_owner_id FROM finnor_os.works WHERE tenant_id=$1 AND id=$2 FOR SHARE',
  [a.tenant_id,a.work_id])).rows[0];
 if(!row||['failed','cancelled','completed'].includes(row.status)||row.current_owner_id&&row.current_owner_id!==a.principal_id)
  fail('Y5_CURRENT_WORK_OWNER_CHANGED');
 if(digest(await currentUniformEnvironment())!==digest(a.binding.environment))fail('Y5_METHOD_OR_CHECKER_CHANGED');
 const acceptance=a.binding.specification.acceptance;
 await assertAuthorityTemporalBoundsTx(c,[...(purpose==='DISCOVERY'?[a.deadline_at.toISOString()]:[]),
  ...('validUntil'in acceptance?[acceptance.validUntil]:[])]);
}
export function projectTotalDevelopment(cut:TotalOwnerBinding['episodeCut'],task:TotalTaskBinding){
 assertTotalEpisodeCut(cut,task);
 const assembled=assembleTotalDevelopment(cut,task),sequences=assembled.projection.sequences;
 if(sequences.length>64-totalGenericProbes().length-1||sequences.some(s=>s.values.length>12))
  fail('Y5_TOTAL_COMPLETE_DEVELOPMENT_PROJECTION_BOUND',413);
 if(task.instance.values.length>12)fail('Y5_TOTAL_COMPLETE_TASK_DEVELOPMENT_PROJECTION_BOUND',413);
 if(assembled.developmentInputs.length>64)fail('Y5_TOTAL_COMPLETE_DEVELOPMENT_PROJECTION_BOUND',413);
 return assembled;
}
interface EventRow{event_id:string;body:S5ExperienceEvent;recorded_at:Date;known_at:Date|null}
interface ProposalRow{content_digest:string;problem:CanonicalAllocationProblem;certificate:AllocationCertificate;created_at:Date;known_at:Date|null}
function known(created:Date,committed:Date|null,declared?:string){
 if(!committed||!Number.isFinite(committed.getTime()))fail('Y5_TOTAL_HISTORICAL_COMMIT_CLOCK_REQUIRED');
 return new Date(Math.max(created.getTime(),committed.getTime(),declared?Date.parse(declared):0)).toISOString();
}
async function historicalCensusTx(ctx:PeMutationContext,c:PoolClient,b:TotalOwnerBinding){
 const cut=b.episodeCut;
 const events=(await c.query<EventRow>(`SELECT event_id,body,recorded_at,pg_xact_commit_timestamp(xmin) known_at
  FROM finnor_os.s5_experience WHERE tenant_id=$1 AND principal_id=$2
  AND greatest(recorded_at,pg_xact_commit_timestamp(xmin),(body->>'knowledgeAt')::timestamptz)<=$3
  ORDER BY recorded_at,event_id LIMIT 1025`,[ctx.auth.tenantId,principal(ctx),cut.knowledgeCut])).rows;
 const proposals=(await c.query<ProposalRow>(`SELECT content_digest,problem,certificate,created_at,pg_xact_commit_timestamp(xmin) known_at
  FROM finnor_os.s5_proposals WHERE tenant_id=$1 AND principal_id=$2 AND demand IS NULL
  AND greatest(created_at,pg_xact_commit_timestamp(xmin))<=$3 ORDER BY created_at,content_digest LIMIT 65`,
  [ctx.auth.tenantId,principal(ctx),cut.knowledgeCut])).rows;
 if(events.length>1024||proposals.length>64)fail('Y5_TOTAL_COMPLETE_HISTORICAL_CENSUS_BOUND',413);
 const records=events.map(row=>({ref:{owner:'S5',id:row.event_id,version:'s5-experience-v1',contentDigest:epistemicHash(row.body)},
  episodeId:row.body.episodeId,kind:row.body.type,knowledgeAt:known(row.recorded_at,row.known_at,row.body.knowledgeAt),body:row.body}));
 const accepted=proposals.map(p=>({problem:p.problem,certificate:p.certificate,knowledgeAt:known(p.created_at,p.known_at),
  acceptance:'ORIGINAL_S5_CERTIFICATE_INDEPENDENTLY_RECHECKED_MODEL_ONLY' as const}));
 if(digest(records)!==digest(cut.records)||digest(accepted)!==digest(cut.acceptedAllocations))
  fail('Y5_TOTAL_ORIGINAL_HISTORICAL_CENSUS_CHANGED');
 const refs=[...new Map(records.filter(r=>r.kind==='REQUEST').flatMap(r=>
  AllocationOperationSchemas.clear.parse(r.body.detail.input).resourceRefs).map(r=>[r.contentDigest,r])).values()];
 const resources=refs.length?(await c.query<{body:AllocationResource}>(
  'SELECT body FROM finnor_os.s5_resources WHERE tenant_id=$1 AND content_digest=ANY($2::text[]) ORDER BY content_digest LIMIT 129',
  [ctx.auth.tenantId,refs.map(r=>r.contentDigest)])).rows.map(r=>r.body):[];
 if(refs.length>128||refs.length!==resources.length||refs.some(ref=>!resources.some(r=>sameAllocationRef(ref,r.ref))))
  fail('Y5_TOTAL_HISTORICAL_RESOURCE_PREIMAGE_UNAVAILABLE');
 await authorizeAllocationResourceReads(ctx,c,resources);
 return {records,accepted,resources};
}
async function sourceFenceTx(ctx:PeMutationContext,c:PoolClient){
 const rows=(await c.query<{key:string}>(
  'SELECT key FROM finnor_os.p4_source_revisions WHERE tenant_id=$1 ORDER BY key LIMIT 4097',[ctx.auth.tenantId])).rows;
 if(rows.length>4096)fail('Y5_TOTAL_COMPLETE_SOURCE_FENCE_BOUND',413);
 return revisions(ctx,rows.map(r=>r.key),c,true);
}
export function resolveTotalBinding(ctx:PeMutationContext,a:TotalDiscoveryRow,purpose:TotalBindingPurpose){
 return withResolutionMemo(()=>resolveBindingOnce(ctx,a,purpose));
}
async function resolveBindingOnce(ctx:PeMutationContext,a:TotalDiscoveryRow,purpose:TotalBindingPurpose){
 const root={entityType:a.root_type,entityId:a.root_id};
 const initial=await tx(ctx,async(c,authorityValidUntil)=>{
  await authorizeTx(ctx,c,root,a.work_id);await authorizeTx(ctx,c,root,a.request.taskWorkId);
  if(purpose!=='READ')await currentTotalTx(ctx,c,a,purpose);
  return {authorityValidUntil,census:await historicalCensusTx(ctx,c,a.binding),sourceFence:await sourceFenceTx(ctx,c)};
 });
 let originalTask:TotalTaskBinding;
 if(purpose==='READ'){
  const recorded=a.binding.originalTask;originalTask=recorded;
  await tx(ctx,c=>assertTotalTaskSourceVisibilityTx(ctx,c,{input:a.request,specificationWork:a.binding.work,
   specification:a.binding.specification,task:recorded}));
 }else{
  const resolution=await resolveTotalSpecification(ctx,{root,workId:a.work_id,expectedSourceRef:a.binding.specification.sourceRef});
  if(resolution.status==='UNAVAILABLE'||digest(resolution.specification)!==digest(a.binding.specification))
   fail('Y5_TOTAL_CURRENT_SPECIFICATION_OR_POLICY_CHANGED');
  originalTask=await resolveTotalTask(ctx,root,a.request.taskWorkId,resolution.specification);
  if(digest(originalTask)!==digest(a.binding.originalTask))fail('Y5_TOTAL_ORIGINAL_TASK_CHANGED');
 }
 assertTotalEpisodeCut(a.binding.episodeCut,originalTask);
 if(digest(projectTotalDevelopment(a.binding.episodeCut,originalTask))!==
  digest({projection:a.binding.projection,developmentInputs:a.binding.developmentInputs}))
  fail('Y5_TOTAL_COMPLETE_SAME_MEANING_PROJECTION_CHANGED');
 await assertTotalTypedSources(ctx,initial.census.records,Date.now()+28500,purpose==='READ'?'READ':'CURRENT');
 for(const record of initial.census.records)if(record.kind==='REQUEST'){
  const request=AllocationOperationSchemas.clear.parse(record.body.detail.input);
  await assertEnterpriseAllocationInputVisibility(ctx,request,
   initial.census.resources.filter(r=>request.resourceRefs.some(ref=>sameAllocationRef(ref,r.ref))));
 }
 for(const accepted of initial.census.accepted)await assertEnterpriseAllocationSourceVisibility(ctx,accepted.problem);
 await recheckSharedWithinResolution();
 await tx(ctx,async c=>{
  await authorizeTx(ctx,c,root,a.work_id);await authorizeTx(ctx,c,root,a.request.taskWorkId);
  if(digest(await historicalCensusTx(ctx,c,a.binding))!==digest(initial.census)||
   digest(await sourceFenceTx(ctx,c))!==digest(initial.sourceFence))
   fail('Y5_TOTAL_SOURCE_CHANGED_DURING_OWNER_RESOLUTION');
  if(purpose!=='READ')await currentTotalTx(ctx,c,a,purpose);
 });
 return {...a.binding,sourceFence:initial.sourceFence,authorityValidUntil:initial.authorityValidUntil};
}
export async function assertTotalResolutionTx(ctx:PeMutationContext,c:PoolClient,resolution:Awaited<ReturnType<typeof resolveTotalBinding>>){
 if(digest(await sourceFenceTx(ctx,c))!==digest(resolution.sourceFence))
  fail('Y5_TOTAL_SOURCE_CHANGED_BEFORE_PUBLICATION');
 if(resolution.authorityValidUntil)try{await assertAuthorityTemporalBoundsTx(c,[resolution.authorityValidUntil]);}
 catch{fail('Y5_TOTAL_SOURCE_AUTHORITY_EXPIRED_BEFORE_PUBLICATION');}
}
export function assertTotalCapsuleBinding(capsule:TotalAlgorithmTheoryCapsule,a:TotalDiscoveryRow){
 if(digest(capsule.specification)!==digest(a.binding.specification)||capsule.origin.selectionRule!==totalSelectionRule||
  capsule.origin.episodeCutDigest!==a.binding.episodeCut.cutDigest||
  capsule.origin.developmentExamplesDigest!==digest(a.binding.developmentInputs)||
  digest(capsule.search.developmentInputs)!==digest(a.binding.developmentInputs)||
  digest(capsule.search.limits)!==digest({maxPrograms:a.request.limits.maxPrograms,maxPropositions:a.request.limits.maxPropositions,
   maxProofAttempts:a.request.limits.maxProofAttempts,maxRetainedBytes:a.request.limits.maxRetainedBytes}))
  fail('Y5_TOTAL_CAPSULE_OWNER_TARGET_CHANGED');
}
export async function totalCapsuleTx(c:PoolClient,a:TotalDiscoveryRow):Promise<TotalAlgorithmTheoryCapsule|null>{
 if(!a.result_digest)return null;
 const row=(await c.query<{body:unknown}>('SELECT body FROM finnor_os.y5_capsules WHERE tenant_id=$1 AND principal_id=$2 AND discovery_id=$3 AND content_digest=$4',
  [a.tenant_id,a.principal_id,a.id,a.result_digest])).rows[0];
 if(!row||digest(row.body)!==a.result_digest)fail('Y5_IMMUTABLE_CAPSULE_INTEGRITY');
 const capsule=parseTotalCapsule(row.body);assertTotalCapsuleBinding(capsule,a);return capsule;
}
