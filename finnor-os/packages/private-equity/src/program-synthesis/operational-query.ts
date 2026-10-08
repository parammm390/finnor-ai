import {z} from 'zod';
import {beginWorkQueryExecution,finishWorkQueryExecution} from '@finnor/db';
import type {OperationalQueryOptions} from '@finnor/read-models';
import type {HarnessProgramQueryRequest,HarnessProgramQueryResult} from '@finnor/shared-types';
import {tx,unavailable,sha} from '../evidence-execution/store';
import type {PeMutationContext} from '../types';
import {readCurrentProgram,requestRow} from './store';
const schema=z.object({intent:z.literal('harness_program_v1'),programId:z.string().uuid(),workId:z.string().uuid()}).strict();
/** Authenticated currentness checks precede native query execution accounting. */
export async function executeHarnessProgramQuery(tenantId:string,input:HarnessProgramQueryRequest,options:OperationalQueryOptions={}):Promise<HarnessProgramQueryResult>{
 const request=schema.parse(input),actor=options.employeeId??options.userId;if(!actor||options.workId!==request.workId||!options.workInputId)throw Error('HARNESS_AUTHENTICATED_EXACT_WORK_BINDING_REQUIRED');
 const ctx:PeMutationContext={auth:{tenantId,userId:actor,employeeId:actor,role:'owner'},provenance:{sourceSystem:'P1:canonical-query'}};
 const user=await tx(ctx,async c=>(await c.query('SELECT role,status FROM finnor_os.users WHERE tenant_id=$1 AND id=$2',[tenantId,actor])).rows[0],true);if(user?.status!=='active'||user.role!=='owner')throw unavailable();
 const q=await requestRow(ctx,request.programId);if(q.work_id!==request.workId||q.work_input_id!==options.workInputId)throw unavailable();
 const current=await readCurrentProgram(ctx,request.programId),started=performance.now();
 const execution=await beginWorkQueryExecution({tenantId,workId:request.workId,workInputId:q.work_input_id,intent:request.intent,request:{...request},executionKey:options.executionKey??'p1:read:'+sha({request,head:q.head_id,generation:q.generation})});
 try{const asOf=new Date().toISOString(),source={kind:'canonical_postgres' as const,tables:['p1_requests','p1_programs','work_plan_revisions','p4_derivations']};const result:HarnessProgramQueryResult={kind:'operational_query_result',status:current.status==='TESTED'?'ok':'partial',data:{...current},version:1,intent:request.intent,source,asOf,count:1,truncated:false,page:{limit:1,returned:1,totalCount:1,totalCountExact:true,hasMore:false,nextCursor:null,truncated:false},meta:{version:1,source,asOf},execution:{id:execution.id,workId:execution.workId,workInputId:execution.workInputId,executionKey:execution.executionKey,status:'succeeded'}};
 await finishWorkQueryExecution({tenantId,executionId:execution.id,status:'succeeded',rowCount:1,durationMs:performance.now()-started,resultSummary:{programId:q.id,workInputId:q.work_input_id,status:current.status,analyticalOnly:true}});return result;
 }catch(error){await finishWorkQueryExecution({tenantId,executionId:execution.id,status:'failed',rowCount:0,durationMs:performance.now()-started,failure:{code:'CURRENT_HARNESS_QUERY_UNAVAILABLE'}});throw error;}
}
