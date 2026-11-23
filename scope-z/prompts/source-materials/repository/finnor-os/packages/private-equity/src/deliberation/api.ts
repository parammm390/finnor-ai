import {z} from 'zod';
import {DatabaseExecutionDeadlineError} from '@finnor/db';
import type {PeMutationContext} from '../types';
import {handleComputeSearchOperation,readComputeSearch} from '../compute-search/api';
import {currentSearch,searchRow} from '../compute-search/store';
import {requestRow} from '../program-synthesis/store';
import {readEnterpriseContingentPolicy} from '../enterprise-control';
import {SearchIdSchema,SearchProjectionSchema} from '../compute-search/contracts';
import {authorize,principal,sha,stable,tx,unavailable} from '../evidence-execution/store';
import {CalibrationRequestSchema,DeliberationRequestSchema,DeliberationEvidenceReadSchema,DeliberationCurrentReaderSchema,DeliberationProjectionSchema,boundedObject} from './contracts';
import {currentModule} from './module';
import {calibrateDecisionLoss,DecisionLossDatasetSchema} from './calibration';
import {readStoredPolicy,readStoredModule,readSourceObject} from './store';
export const DELIBERATION_OPERATIONS=['deliberation-submit','deliberation-read','deliberation-projection','deliberation-cancel','deliberation-resume','deliberation-reconcile','deliberation-calibrate','deliberation-evidence-read','deliberation-module-read'] as const;
export async function readDeliberation(ctx:PeMutationContext,id:string,prechecked?:Awaited<ReturnType<typeof readComputeSearch>>){
 // Projection already performed the authentic P2 current read. Reuse those
 // exact bytes while retaining the full post-artifact owner/source check and
 // monotone-head fences below; do not repeat that first owner solve a third time.
 const current=prechecked??await readComputeSearch(ctx,id),s=await searchRow(ctx,id);if(!s.request.deliberation||current.searchId!==id)throw unavailable();
 const q=await requestRow(ctx,s.program_id);await authorize(ctx,q.request.root,[{type:'work',id:q.work_id}]);
 const policy=await readStoredPolicy(ctx,s);
 if(stable(policy.ref)!==stable(current.plan.deliberationPolicyRef))throw Error('M2_CURRENT_POLICY_PLAN_HEAD_CHANGED');
 if(!['CANCELLED','INVALIDATED'].includes(s.status))await currentSearch(ctx,s,q);
 const latest=await searchRow(ctx,id);
 if(latest.head_id!==s.head_id||latest.generation!==s.generation||latest.revision!==s.revision)throw Error('M2_CURRENT_POLICY_PLAN_HEAD_CHANGED');
 await authorize(ctx,q.request.root,[{type:'work',id:q.work_id}]);
 return DeliberationCurrentReaderSchema.parse({schema:'finnor.m2.current-reader.v1',searchId:s.id,programId:q.id,status:current.status,reason:current.reason,policy,planRef:current.plan.deliberationPolicyRef,protectedAdmission:false});
}
export async function handleDeliberationOperation(ctx:PeMutationContext,operation:string,raw:unknown):Promise<{status:number;body:unknown}>{
 try{
  boundedObject(raw);
  if(operation==='deliberation-submit'){
   const parsed=DeliberationRequestSchema.parse(raw);if(parsed.mode!=='ordinary_disposable'||process.env.NODE_ENV==='production'||process.env.FINNOR_P4_PROFILE!=='ordinary_disposable')throw Error('M2_PROTECTED_FUNDING_AND_RUNTIME_UNAVAILABLE');
   const {schema,valueEvidenceRef,sourceInspectionRef,...request}=parsed,module=currentModule();
   return handleComputeSearchOperation(ctx,'compute-search-submit',{...request,schema:'finnor.compute-search-request.v1',deliberation:{moduleRef:module.ref,valueEvidenceRef,sourceInspectionRef}});
  }
  if(operation==='deliberation-calibrate'){
   const input=CalibrationRequestSchema.parse(raw);await authorize(ctx,input.root as any,[{type:'work',id:input.workId}]);
   const policy=await readEnterpriseContingentPolicy(ctx,input.policyRequest),source=await readSourceObject(ctx,input.root,input.sourceId,input.versionId),dataset=DecisionLossDatasetSchema.parse(source.snapshot.dataset);
   if(sha(dataset)!==input.datasetDigest||stable(dataset.objectiveRef)!==stable(policy.mandate.utilityRef)||dataset.lossUnit!==policy.mandate.utility.unit)throw Error('M2_DATASET_EXACT_OBJECTIVE_UNIT_AND_BYTES_REQUIRED');
   const started=performance.now(),cpu=process.cpuUsage(),report=calibrateDecisionLoss(dataset),usage=process.cpuUsage(cpu);
   const body={root:input.root,workId:input.workId,policyRequest:input.policyRequest,sourceRef:{owner:'S1',id:source.id,version:String(source.version_number),contentDigest:source.content_hash},sourceKnownAt:new Date(source.retrieved_at).toISOString(),validUntil:policy.validUntil,report,
    preparation:{kind:'BOUNDED_PUBLIC_DEVELOPMENT_FIT_CALIBRATION_AND_EVALUATION',rows:dataset.rows.length,maxRows:256,elapsedMs:performance.now()-started,cpuMicros:usage.user+usage.system,node:process.version,costUSD:null,chargedAsEpisodeAttempt:false,qualification:'ORDINARY_UNMETERED_DEVELOPMENT_PREPARATION_NOT_S5_FUNDING_OR_FIELD_ROUTING'}},digest=sha(body);
   await tx(ctx,c=>c.query('INSERT INTO finnor_os.m2_calibration_reports(tenant_id,principal_id,digest,source_id,version_id,body) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING',[ctx.auth.tenantId,principal(ctx),digest,input.sourceId,input.versionId,stable(body)]));
   await authorize(ctx,input.root as any,[{type:'work',id:input.workId}]);return {status:200,body:{ref:{owner:'M2',id:'m2-calibration:'+digest,version:'m2-calibration-v1',contentDigest:digest},report,sourceRef:body.sourceRef,fieldRoutingAdmitted:false}};
  }
  if(operation==='deliberation-projection'){
   const input=SearchProjectionSchema.parse(raw),result=await handleComputeSearchOperation(ctx,'compute-search-projection',{...input,methodOwner:'M2'});if(result.status!==200)return result;
   const projection=result.body as {searches:Array<Awaited<ReturnType<typeof readComputeSearch>>>,eligiblePrograms:unknown[]},policies=[];
   for(const row of projection.searches){const s=await searchRow(ctx,row.searchId);if(s.request.deliberation)policies.push(await readDeliberation(ctx,row.searchId,row));}
   return {status:200,body:DeliberationProjectionSchema.parse({schema:'finnor.m2.work-projection.v1',workId:input.workId,policies,eligiblePrograms:projection.eligiblePrograms})};
  }
  if(operation==='deliberation-evidence-read'){
   const input=DeliberationEvidenceReadSchema.parse(raw),current=await readDeliberation(ctx,input.searchId),s=await searchRow(ctx,input.searchId);
   const isValue=current.policy.marginalValueEvidence.some(r=>stable(r)===stable(input.ref)),isComponent=[current.policy.frontier,current.policy.incumbent,current.policy.stop,current.policy.outstandingCosts,...current.policy.ownerRequests].some(r=>r&&stable(r)===stable(input.ref)),isPreparation=current.policy.projection.outstandingCosts.preparation.some(p=>stable(p.ref)===stable(input.ref));
   if(!isValue&&!isComponent&&!isPreparation)throw unavailable();
   const record=await tx(ctx,async c=>(isPreparation?await c.query('SELECT body,digest FROM finnor_os.m2_preparations WHERE tenant_id=$1 AND principal_id=$2 AND digest=$3',[s.tenant_id,s.principal_id,input.ref.contentDigest]):await c.query('SELECT body,digest FROM finnor_os.'+(isValue?'m2_values':'m2_components')+' WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3 AND digest=$4',[s.tenant_id,s.principal_id,s.id,input.ref.contentDigest])).rows[0],true);
   if(!record||sha(record.body)!==record.digest)throw Error('M2_VALUE_EVIDENCE_DIGEST_MISMATCH');return {status:200,body:{ref:input.ref,evidence:record.body}};
  }
  const id=SearchIdSchema.parse(raw).searchId;
  if(operation==='deliberation-read')return {status:200,body:await readDeliberation(ctx,id)};
  if(operation==='deliberation-module-read'){
   const current=await readDeliberation(ctx,id),s=await searchRow(ctx,id),module=await readStoredModule(ctx,s);if(stable(current.policy.metacontroller)!==stable(module.ref))throw Error('M2_CURRENT_MODULE_MISMATCH');return {status:200,body:module};
  }
  if(['deliberation-cancel','deliberation-resume','deliberation-reconcile'].includes(operation)){
   const s=await searchRow(ctx,id);if(!s.request.deliberation)throw unavailable();if(operation==='deliberation-resume'&&s.reason==='M2_MATERIAL_SOURCE_PREMISE_REQUIRES_S4_RECOMPUTATION')throw Error('M2_OWNER_PREMISE_NOT_RECOMPUTED');const result=await handleComputeSearchOperation(ctx,operation.replace('deliberation-','compute-search-'),{searchId:id});if(result.status!==200&&result.status!==202)return result;return {status:result.status,body:await readDeliberation(ctx,id)};
  }
  return {status:404,body:{code:'NOT_FOUND'}};
 }catch(error){
  if(error instanceof DatabaseExecutionDeadlineError)throw error;
  if((error as any).code==='PE_ENTITY_NOT_FOUND')return {status:404,body:{code:'PE_ENTITY_NOT_FOUND',error:'Deliberation unavailable in authenticated scope'}};
  if(error instanceof z.ZodError)return {status:400,body:{code:'M2_SCHEMA_INVALID',predicate:'BOUNDED_TYPED_DELIBERATION_REQUIRED'}};
  const predicate=String((error as Error).message).match(/^[A-Z][A-Z0-9_]{0,159}$/)?.[0]??'M2_OWNER_CURRENTNESS_OR_SUPPORT_UNPASSED';return {status:422,body:{code:'M2_PREDICATE_UNPASSED',predicate}};
 }
}
