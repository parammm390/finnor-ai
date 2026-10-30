import {z} from 'zod';
import {beginWorkQueryExecution,finishWorkQueryExecution} from '@finnor/db';
import type {OperationalQueryOptions} from '@finnor/read-models';
import type {PrimaryDiligenceQueryResult} from '@finnor/shared-types';
import type {PeMutationContext} from '../types';
import {authorizeBeliefResources} from '../enterprise-beliefs';
import {actor,currentActor,currentFinding,hash,programme,tx,unavailable} from './store';

const requestSchema=z.object({intent:z.literal('primary_diligence_v1'),workId:z.string().uuid()}).strict();

export interface PrimaryDiligenceObservation{
 programmeId:string|null;workInputId:string|null;status:string;current:boolean;definitionDigest:string|null;
 findingDigests:Array<{assertionId:string;findingDigest:string}>;underwritingRunId:string|null;nativeOwnerConsumed:boolean;
}

/** Re-derives every field from owner rows at read time. A stored consumer row alone never
 * proves currentness: each finding of the programme must pass the owner's own current-finding
 * predicate and the exact Work input before consumption counts. Values are never returned. */
export async function observePrimaryDiligence(ctx:PeMutationContext,workId:string,workInputId:string):Promise<PrimaryDiligenceObservation>{
 await currentActor(ctx);
 try{await authorizeBeliefResources(ctx,[{type:'work',id:workId}]);}catch{throw unavailable();}
 const id=await tx(ctx,async c=>(await c.query<{id:string}>(
  'SELECT id::text FROM finnor_os.v2_programmes WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 ORDER BY created_at DESC,id DESC LIMIT 1',
  [ctx.auth.tenantId,actor(ctx),workId])).rows[0]?.id,true);
 if(!id)return {programmeId:null,workInputId:null,status:'NOT_STARTED',current:false,definitionDigest:null,findingDigests:[],underwritingRunId:null,nativeOwnerConsumed:false};
 const p=await programme(ctx,id);
 const rows=await tx(ctx,async c=>(await c.query<{id:string;digest:string;assertion_id:string}>(
  'SELECT DISTINCT ON(assertion_id) id::text,digest,assertion_id::text FROM finnor_os.v2_findings WHERE tenant_id=$1 AND principal_id=$2 AND programme_id=$3 ORDER BY assertion_id,created_at DESC,id DESC',
  [ctx.auth.tenantId,actor(ctx),p.id])).rows,true);
 let current=p.work_input_id===workInputId&&!p.invalidated&&!p.cancellation_requested_at&&rows.length>0;
 const verified:typeof rows=[];
 for(const row of rows){
  if(!current)break;
  try{await currentFinding(ctx,row.id);verified.push(row);}catch{current=false;}
 }
 let underwritingRunId:string|null=null;
 if(current){
  underwritingRunId=await tx(ctx,async c=>(await c.query<{id:string}>(
   `SELECT d.consumer_id::text id FROM finnor_os.v2_consumer_dependencies d
    JOIN finnor_os.underwriting_runs r ON r.tenant_id=d.tenant_id AND r.id=d.consumer_id
    WHERE d.tenant_id=$1 AND d.consumer_type='underwriting_run' AND d.finding_id=ANY($2::uuid[]) AND r.work_id=$3
    ORDER BY d.created_at DESC,d.consumer_id DESC LIMIT 1`,
   [ctx.auth.tenantId,verified.map(r=>r.id),workId])).rows[0]?.id??null,true);
 }
 return {programmeId:p.id,workInputId:p.work_input_id,status:current?p.status:'STALE',current,definitionDigest:p.intake_digest,
  findingDigests:current?verified.map(r=>({assertionId:r.assertion_id,findingDigest:r.digest})):[],
  underwritingRunId,nativeOwnerConsumed:current&&underwritingRunId!==null};
}

export async function executePrimaryDiligenceQuery(tenantId:string,raw:unknown,options:OperationalQueryOptions={}):Promise<PrimaryDiligenceQueryResult>{
 const started=performance.now();
 const request=requestSchema.parse(raw),principalId=options.employeeId??options.userId;
 if(!principalId||options.workId!==request.workId||!options.workInputId)throw Error('R12_NATIVE_CURRENT_PRINCIPAL_WORK_INPUT_REQUIRED');
 const ctx:PeMutationContext={auth:{tenantId,userId:principalId,employeeId:principalId,role:'owner'}};
 const seen=await observePrimaryDiligence(ctx,request.workId,options.workInputId);
 const data={programmeId:seen.programmeId,workId:request.workId,workInputId:options.workInputId,status:seen.status,current:seen.current,
  definitionDigest:seen.definitionDigest,findingDigests:seen.findingDigests,underwritingRunId:seen.underwritingRunId,
  nativeOwnerConsumed:seen.nativeOwnerConsumed,qualification:'LOCAL_ENGINEERING_ONLY',securityAdmission:'NOT_RUN',
  protectedAdmission:false,productionActive:false,executionAuthorityGranted:false};
 const execution=await beginWorkQueryExecution({tenantId,workId:request.workId,workInputId:options.workInputId,
  intent:request.intent as Parameters<typeof beginWorkQueryExecution>[0]['intent'],request,
  executionKey:options.executionKey??'r12:read:'+hash({request,data})});
 try{
  const asOf=new Date().toISOString(),source={kind:'canonical_postgres' as const,
   tables:['v2_programmes','v2_findings','v2_consumer_dependencies','underwriting_runs','work_inputs']};
  const result={kind:'operational_query_result' as const,status:seen.current&&seen.nativeOwnerConsumed&&seen.status==='COMPLETE'?'ok' as const:'partial' as const,
   data,version:1 as const,intent:request.intent,source,asOf,count:1,truncated:false,
   page:{limit:1,returned:1,totalCount:1,totalCountExact:true,hasMore:false,nextCursor:null,truncated:false},meta:{version:1 as const,source,asOf},
   execution:{id:execution.id,workId:execution.workId,workInputId:execution.workInputId,executionKey:execution.executionKey,status:'succeeded' as const}};
  await finishWorkQueryExecution({tenantId,executionId:execution.id,status:'succeeded',rowCount:1,durationMs:performance.now()-started,resultSummary:data});
  return result;
 }catch(error){
  await finishWorkQueryExecution({tenantId,executionId:execution.id,status:'failed',rowCount:0,durationMs:performance.now()-started,
   failure:{code:'R12_CURRENT_PRIMARY_DILIGENCE_OBSERVATION_UNAVAILABLE'}});throw error;
 }
}
