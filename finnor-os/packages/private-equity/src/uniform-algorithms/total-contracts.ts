import {z} from 'zod';
import type {ResolvedTotalSpecification} from '../../../shared-types/src/total-algorithm-theory';
import type {AllocationEpisodeCut} from '../allocation-experience';
import type {TotalTaskBinding} from '../allocation-total-task';
import {TotalTaskBindingSchema} from '../allocation-total-task';
import {matchingTotalTaskRequests} from '../allocation-total-episodes';
import type {DiscoveryFenceRow} from './store';
import type {UniformEnvironment} from './source-cut';
import type {revisions} from '../owner-context';
import {ExperimentRefSchema} from '../../../epistemic-runtime/src/experiments';
import {parseResolvedTotalSpecification} from '../../../epistemic-runtime/src/uniform-algorithms/total/capsule';
import {totalSearchLimitsSchema} from '../../../epistemic-runtime/src/uniform-algorithms/total/search';
import {epistemicHash} from '../../../epistemic-runtime/src/source-precedence';
import {RootSchema,SubmitSchema,digest,fail} from './contracts';

export const TotalSubmitSchema=z.object({
 schema:z.literal('finnor.y5.total-discovery-request.v2'),root:RootSchema,workId:z.string().uuid(),
 taskWorkId:z.string().uuid(),idempotencyKey:z.string().min(1).max(256),
 limits:SubmitSchema.shape.limits.extend(totalSearchLimitsSchema.shape).strict(),
 baselineManifestRef:ExperimentRefSchema.nullable(),
}).strict();
export const TotalConsumeSchema=z.object({discoveryId:z.string().uuid(),taskWorkId:z.string().uuid(),
 idempotencyKey:z.string().min(1).max(256)}).strict();
export const TotalReadSchema=z.object({discoveryId:z.string().uuid(),includeCapsule:z.boolean().optional(),
 includeHistory:z.boolean().optional()}).strict();
export const totalSelectionRule='ALL_ORIGINAL_S5_EPISODES_FOR_AUTHENTICATED_PRINCIPAL' as const;
export interface TotalDevelopmentProjection{
 schema:'finnor.y5.total-development-projection.v2';status:'COMPLETE';
 sequences:{requestRef:AllocationEpisodeCut['records'][number]['ref'];taskWorkId:string;
  taskRef:z.infer<typeof ExperimentRefSchema>;resultRef:z.infer<typeof ExperimentRefSchema>;
  status:'MODEL_ACCEPTED'|'UNKNOWN'|'REFUSED';values:string[]}[];
 qualification:'COMPLETE_SAME_MEANING_TYPED_TASK_REQUESTS_MODEL_ONLY_ALLOCATION_CONTEXT_NOT_SEMANTIC_EVIDENCE';
}
export interface TotalOwnerBinding{
 schema:'finnor.y5.total-owner-binding.v2';work:{id:string;digest:string};
 specification:ResolvedTotalSpecification;originalTask:TotalTaskBinding;episodeCut:AllocationEpisodeCut;
 projection:TotalDevelopmentProjection;developmentInputs:string[][];environment:UniformEnvironment;
 authorityRevision:string;dependencies:Awaited<ReturnType<typeof revisions>>;
}
export interface TotalDiscoveryRow extends DiscoveryFenceRow{
 request:z.infer<typeof TotalSubmitSchema>;binding:TotalOwnerBinding;
}
export function isTotalDiscovery(a:{request:unknown}):a is TotalDiscoveryRow{
 return !!a.request&&typeof a.request==='object'&&
  (a.request as {schema?:unknown}).schema==='finnor.y5.total-discovery-request.v2';
}
export function totalGenericProbes(){
 const alphabet=['-1','0','1'],generic:string[][]=[[]];
 for(const x of alphabet){generic.push([x]);for(const y of alphabet)generic.push([x,y]);}
 return generic;
}
export function assembleTotalDevelopment(cut:AllocationEpisodeCut,task:TotalTaskBinding){
 const sequences:TotalDevelopmentProjection['sequences']=matchingTotalTaskRequests(cut.records,task).map(r=>({requestRef:r.record.ref,
  taskWorkId:r.detail.task.workId,taskRef:r.detail.task.sourceRef,resultRef:r.resultRef,
  status:r.result.status,values:r.detail.task.instance.values}));
 const projection:TotalDevelopmentProjection={schema:'finnor.y5.total-development-projection.v2',status:'COMPLETE',sequences,
  qualification:'COMPLETE_SAME_MEANING_TYPED_TASK_REQUESTS_MODEL_ONLY_ALLOCATION_CONTEXT_NOT_SEMANTIC_EVIDENCE'};
 return {projection,developmentInputs:[...sequences.map(s=>s.values),task.instance.values,...totalGenericProbes()]};
}
export function assertTotalEpisodeCut(cut:AllocationEpisodeCut,task:TotalTaskBinding){
 if(!cut||cut.schema!=='finnor.s5.owner-episode-cut.v1'||cut.selectionRule!==totalSelectionRule||
  !Array.isArray(cut.records)||!Array.isArray(cut.acceptedAllocations)||!Array.isArray(cut.episodes)||
  cut.records.length>1024||cut.acceptedAllocations.length>64||cut.episodes.length>32)
  fail('Y5_TOTAL_COMPLETE_OWNER_CENSUS_REQUIRED');
 const {cutDigest,...body}=cut;
 if(epistemicHash(body)!==cutDigest)fail('Y5_TOTAL_OWNER_CENSUS_INTEGRITY');
 if(cut.records.some(r=>r.body.tenantId!==cut.tenantId||r.body.principalId!==cut.principalId))
  fail('Y5_TOTAL_OWNER_CENSUS_PRINCIPAL_MISMATCH');
 const accepted=matchingTotalTaskRequests(cut.records,task).filter(r=>r.result.status==='MODEL_ACCEPTED');
 if(new Set(accepted.map(r=>r.detail.task.workId)).size<2||
  new Set(accepted.map(r=>digest(r.detail.task.instance))).size<2)
  fail('Y5_TOTAL_TWO_DISTINCT_SAME_MEANING_MODEL_ACCEPTED_TASKS_REQUIRED');
}
export function validateTotalDiscovery(row:DiscoveryFenceRow&{request:unknown;binding:unknown}):TotalDiscoveryRow{
 const request=TotalSubmitSchema.parse(row.request),binding=row.binding as TotalOwnerBinding;
 if(digest(request)!==row.request_digest||!binding||binding.schema!=='finnor.y5.total-owner-binding.v2')
  fail('Y5_TOTAL_STORED_BINDING_INTEGRITY');
 parseResolvedTotalSpecification(binding.specification);
 const task=TotalTaskBindingSchema.parse(binding.originalTask);assertTotalEpisodeCut(binding.episodeCut,task);
 const expected=assembleTotalDevelopment(binding.episodeCut,task);
 if(binding.episodeCut.tenantId!==row.tenant_id||binding.episodeCut.principalId!==row.principal_id||
  task.workId!==request.taskWorkId||digest(task.instance.specificationRef)!==digest(binding.specification.sourceRef)||
  task.specificationDigest!==digest(binding.specification)||digest(binding.projection)!==digest(expected.projection)||
  digest(binding.developmentInputs)!==digest(expected.developmentInputs)||
  task.sourceRef.id!==task.work.id||request.workId!==row.work_id||
  request.root.entityId!==row.root_id||request.root.entityType!==row.root_type||
  binding.projection?.status!=='COMPLETE'||!Array.isArray(binding.developmentInputs)||
  binding.developmentInputs.length<1||binding.developmentInputs.length>64||
  binding.developmentInputs.some(xs=>!Array.isArray(xs)||xs.length>12||xs.some(x=>typeof x!=='string'||
   !/^(?:0|-?[1-9][0-9]*)$/.test(x)||x.replace('-','').length>512))||
  !Array.isArray(binding.dependencies)||typeof binding.work?.digest!=='string'||typeof binding.environment?.sourceDigest!=='string')
  fail('Y5_TOTAL_STORED_BINDING_INTEGRITY');
 return {...row,request,binding};
}
