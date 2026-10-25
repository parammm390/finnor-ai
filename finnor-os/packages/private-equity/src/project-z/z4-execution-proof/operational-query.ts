import {z} from 'zod';
import {beginWorkQueryExecution,finishWorkQueryExecution} from '@finnor/db';
import type {OperationalQueryOptions} from '@finnor/read-models';
import type {ExecutionProofQueryResult} from '@finnor/shared-types';
import type {PeMutationContext} from '../../types';
import {JOB,acceptedDefinition,sha} from './contracts';
import {artifact,authorize,current,job,original,tx,unavailable,type Capsule} from './store';
const requestSchema=z.object({intent:z.literal('execution_proof_capsule_v1'),workId:z.string().uuid()}).strict();
export async function executeExecutionProofQuery(tenantId:string,raw:unknown,options:OperationalQueryOptions={}):Promise<ExecutionProofQueryResult>{
 const started=performance.now();
 const request=requestSchema.parse(raw),actor=options.employeeId??options.userId;
 if(!actor||options.workId!==request.workId||!options.workInputId)throw Error('Z4_NATIVE_CURRENT_PRINCIPAL_WORK_INPUT_REQUIRED');
 const ctx:PeMutationContext={auth:{tenantId,userId:actor,employeeId:actor,role:'owner'}};
 const id=await tx(ctx,async c=>(await c.query<{id:string}>("SELECT id::text FROM finnor_os.jobs WHERE tenant_id=$1 AND type=$2 AND payload->>'principalId'=$3 AND payload->>'workId'=$4 LIMIT 1",
  [tenantId,JOB,actor,request.workId])).rows[0]?.id,true);
 if(!id)throw unavailable();
 const row=await job(ctx,id),o=await original(ctx,row);await authorize(ctx,o.request.root,[{type:'work',id:request.workId}]);
 if(o.request.workInputId!==options.workInputId)throw unavailable();
 let isCurrent=true;try{await current(ctx,o,{historicalRead:true});}catch{isCurrent=false;}
 let nativeOwnerConsumed=false;
 const d=row.payload.z4.delivery;
 if(isCurrent&&d?.state==='ACKNOWLEDGED'&&d.resultDigest&&row.payload.z4.capsuleDigest){
  try{
   const capsule=await artifact<Capsule>(ctx,'capsule',row.payload.z4.capsuleDigest);
   const saved=await artifact<{schema:string;sessionId:string;originalDigest:string;capsuleDigest:string;owner:string;useId:string;result:{ref:unknown}}>(ctx,'delivery',d.resultDigest);
   const native= d.owner==='S4'?await import('../../enterprise-control'):await import('../../enterprise-interventions');
   const reader=(native as unknown as Record<string,(ctx:PeMutationContext,r:unknown)=>Promise<unknown>>)[
    d.owner==='S4'?'readEnterpriseControlBranchChoice':'readEnterpriseInterventionResponse'];
   if(!reader)throw Error('Z4_NATIVE_OWNER_READER_REQUIRED');
   const actual=await reader(ctx,saved.result.ref);
   nativeOwnerConsumed=capsule.schema==='finnor.z4.execution-proof-capsule.v1'&&capsule.sessionId===id&&
    capsule.executionAuthorityGranted===false&&capsule.securityAdmission==='NOT_RUN'&&capsule.protectedAdmission==='NOT_RUN'&&
    capsule.envelope.immutableArtifactDigest===sha({originalDigest:capsule.originalDigest,checked:capsule.checked})&&
    saved.schema==='finnor.z4.native-owner-result.v1'&&saved.sessionId===id&&saved.originalDigest===row.payload.z4.originalDigest&&
    saved.capsuleDigest===row.payload.z4.capsuleDigest&&saved.useId===d.useId&&saved.owner===d.owner&&
    d.capsuleDigest===row.payload.z4.capsuleDigest&&d.owner===o.request.ownerContract.owner&&
    d.targetDigest===sha(o.request.ownerContract.owner==='S3'
     ?{modelRef:o.request.ownerContract.modelRef,query:o.request.ownerContract.query}
     :{policyRef:o.request.ownerContract.policyRef,decision:o.request.ownerContract.decision,allocationRef:o.request.ownerContract.allocationRef,measurements:[]})&&
    sha(actual)===sha(saved.result)&&
    capsule.originalDigest===row.payload.z4.originalDigest&&d.acks.includes('BEFORE')&&d.acks.includes('AFTER');
  }catch{nativeOwnerConsumed=false;}
 }
 // A successful native read must not conceal cancellation or currentness drift
 // that happened while its persisted output was being checked.
 try{
  await current(ctx,o,{historicalRead:true});
  if(sha((await job(ctx,id)).payload.z4)!==sha(row.payload.z4))isCurrent=false;
 }catch{isCurrent=false;}
 if(!isCurrent)nativeOwnerConsumed=false;
 const data={sessionId:id,workId:request.workId,workInputId:o.request.workInputId,status:isCurrent?row.payload.z4.status:'STALE',
  current:isCurrent,definitionDigest:sha(acceptedDefinition(o.request)),nativeOwnerConsumed,qualification:'LOCAL_ENGINEERING_ONLY',
  securityAdmission:'NOT_RUN',protectedAdmission:false,productionActive:false,executionAuthorityGranted:false};
 const execution=await beginWorkQueryExecution({tenantId,workId:request.workId,workInputId:o.request.workInputId,
  intent:request.intent as Parameters<typeof beginWorkQueryExecution>[0]['intent'],request,executionKey:options.executionKey??'z4:read:'+sha(data)});
 try{
  const asOf=new Date().toISOString(),source={kind:'canonical_postgres' as const,tables:['jobs','job_delivery_attempts','work_inputs','work_plan_revisions',
   's5_reservations','s5_governed_resource_charges','business_effects']};
  const result={kind:'operational_query_result' as const,status:isCurrent&&data.status==='CHECKED'&&nativeOwnerConsumed?'ok' as const:'partial' as const,
   data,version:1 as const,intent:request.intent,source,asOf,count:1,truncated:false,
   page:{limit:1,returned:1,totalCount:1,totalCountExact:true,hasMore:false,nextCursor:null,truncated:false},meta:{version:1 as const,source,asOf},
   execution:{id:execution.id,workId:execution.workId,workInputId:execution.workInputId,executionKey:execution.executionKey,status:'succeeded' as const}};
  await finishWorkQueryExecution({tenantId,executionId:execution.id,status:'succeeded',rowCount:1,durationMs:performance.now()-started,resultSummary:data});
  return result;
 }catch(error){
  await finishWorkQueryExecution({tenantId,executionId:execution.id,status:'failed',rowCount:0,durationMs:performance.now()-started,
   failure:{code:'Z4_CURRENT_NATIVE_PROOF_OBSERVATION_UNAVAILABLE'}});throw error;
 }
}
