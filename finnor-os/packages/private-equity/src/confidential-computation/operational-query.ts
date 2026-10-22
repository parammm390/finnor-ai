import {z} from 'zod';
import {beginWorkQueryExecution,finishWorkQueryExecution} from '@finnor/db';
import type {OperationalQueryOptions} from '@finnor/read-models';
import type {ConfidentialComputationQueryRequest,ConfidentialComputationQueryResult} from '@finnor/shared-types';
import {getUnderwritingRun} from '../underwriting-repository';
import type {PeMutationContext} from '../types';
import {unavailable} from '../owner-context';
import {tx,computationTx,allCurrentTx,principal} from './store';
import {sha} from './contracts';

const schema=z.object({intent:z.literal('confidential_economic_computation_v1'),workId:z.string().uuid()}).strict();
/** Completion observations deliberately omit outputs, nonces and release
 * hashes. Only the canonical controller can turn these into a Work proof. */
export async function executeConfidentialComputationQuery(tenantId:string,input:ConfidentialComputationQueryRequest,
 options:OperationalQueryOptions={}):Promise<ConfidentialComputationQueryResult>{
 const request=schema.parse(input),actor=options.employeeId??options.userId;
 if(!actor||options.workId!==request.workId||!options.workInputId)throw Error('Y4_NATIVE_EXACT_PRINCIPAL_INPUT_REQUIRED');
 const ctx:PeMutationContext={auth:{tenantId,userId:actor,employeeId:actor,role:'owner'}};
 const observed=await tx(ctx,async c=>{
  const row=(await c.query<{id:string}>('SELECT id FROM finnor_os.y4_computations WHERE tenant_id=$1 AND work_id=$2',[tenantId,request.workId])).rows[0];
  if(!row)throw unavailable();
  const q=await computationTx(ctx,c,row.id);
  if(q.work_input_id!==options.workInputId)throw unavailable();
  let current=true;try{await allCurrentTx(ctx,c,q);}catch{current=false;}
  const imported=current&&(await c.query('SELECT 1 FROM finnor_os.y4_releases WHERE tenant_id=$1 AND computation_id=$2 AND principal_id=$3',
   [tenantId,q.id,principal(ctx)])).rowCount!==0;
  const consumers=current?(await c.query<{body:{runId:string}}>(`SELECT body FROM finnor_os.y4_events
   WHERE tenant_id=$1 AND computation_id=$2 AND actor_id=$3 AND kind='NATIVE_UNDERWRITING_CONSUMED'
   ORDER BY id DESC LIMIT 64`,[tenantId,q.id,principal(ctx)])).rows.map(r=>r.body.runId):[];
  const {workRevisionRef:_,...definition}=q.request.function;
  return {id:q.id,inputId:q.work_input_id,status:current?q.status:'INVALIDATED',current,imported,consumers,
   definitionDigest:sha(definition),generation:q.generation};
 });
 let typedConsumerCurrent=false;
 for(const id of observed.consumers){
  try{await getUnderwritingRun(ctx,id);typedConsumerCurrent=true;break;}catch{/* Current native owner refusal remains unsatisfied. */}
 }
 const data={computationId:observed.id,workId:request.workId,workInputId:observed.inputId,
  status:observed.status,current:observed.current,definitionDigest:observed.definitionDigest,
  recipientReleaseImported:observed.imported,typedConsumerCurrent,
  qualification:'LOCAL_ENGINEERING_ONLY',protectedAdmission:false,productionActive:false,executionAuthorityGranted:false};
 const started=performance.now(),execution=await beginWorkQueryExecution({tenantId,workId:request.workId,
  workInputId:observed.inputId,intent:request.intent,request,executionKey:options.executionKey??'y4:read:'+sha(data)});
 try{
  const asOf=new Date().toISOString(),source={kind:'canonical_postgres' as const,tables:['y4_computations','y4_consents','y4_releases','y4_events','underwriting_runs','work_plan_revisions']};
  const result:ConfidentialComputationQueryResult={kind:'operational_query_result',
   status:observed.current&&observed.status==='COMPUTED'&&observed.imported&&typedConsumerCurrent?'ok':'partial',
   data,version:1,intent:request.intent,source,asOf,count:1,truncated:false,
   page:{limit:1,returned:1,totalCount:1,totalCountExact:true,hasMore:false,nextCursor:null,truncated:false},
   meta:{version:1,source,asOf},execution:{id:execution.id,workId:execution.workId,workInputId:execution.workInputId,
    executionKey:execution.executionKey,status:'succeeded'}};
  await finishWorkQueryExecution({tenantId,executionId:execution.id,status:'succeeded',rowCount:1,
   durationMs:performance.now()-started,resultSummary:data});
  return result;
 }catch(error){
  await finishWorkQueryExecution({tenantId,executionId:execution.id,status:'failed',rowCount:0,
   durationMs:performance.now()-started,failure:{code:'Y4_CURRENT_NATIVE_QUERY_UNAVAILABLE'}});
  throw error;
 }
}
