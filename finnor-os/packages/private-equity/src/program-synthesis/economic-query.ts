import {z} from 'zod';
import {beginWorkQueryExecution,finishWorkQueryExecution} from '@finnor/db';
import type {OperationalQueryOptions} from '@finnor/read-models';
import type {EconomicProgrammeQueryRequest,EconomicProgrammeQueryResult} from '@finnor/shared-types';
import {readEconomicProgramme,programmeTx} from '../economic-control';
import {withS5PortfolioTransaction as transaction} from '../allocation-store';
import {digest,fail} from '../economic-action-theory/contracts';
import type {PeMutationContext} from '../types';
export const EconomicProgrammeQuerySchema=z.object({intent:z.literal('economic_programme_v1'),programmeId:z.string().uuid(),workId:z.string().uuid()}).strict();
export async function executeEconomicProgrammeQuery(tenantId:string,raw:EconomicProgrammeQueryRequest,options:OperationalQueryOptions={}):Promise<EconomicProgrammeQueryResult>{
 const input=EconomicProgrammeQuerySchema.parse(raw),actor=options.employeeId??options.userId;
 if(!actor||options.workId!==input.workId||!options.workInputId)fail('Y1_AUTHENTICATED_EXACT_QUERY_WORK_REQUIRED',403);
 const ctx:PeMutationContext={auth:{tenantId,userId:actor,employeeId:actor,role:'owner'}},
  programme=await transaction(ctx,c=>programmeTx(ctx,c,input.programmeId,false));
 if(programme.workId!==input.workId||programme.workInputId!==options.workInputId)fail('Y1_QUERY_WORK_REVISION_REQUIRED',404);
 const current=await readEconomicProgramme(ctx,input.programmeId),started=performance.now();
 const execution=await beginWorkQueryExecution({tenantId,workId:input.workId,workInputId:programme.workInputId,intent:input.intent,
  request:{...input},executionKey:options.executionKey??'y1-query:'+digest({input,current})});
 try{
  const asOf=new Date().toISOString(),source={kind:'canonical_postgres' as const,tables:['s4_economic_programmes','s5_history','s6_economic_obligation_origins','business_effects','s7_economic_records']};
  const result:EconomicProgrammeQueryResult={kind:'operational_query_result',status:current.status==='OBSERVED'?'ok':'partial',
   version:1,intent:input.intent,data:current,source,asOf,count:1,truncated:false,
   page:{limit:1,returned:1,totalCount:1,totalCountExact:true,hasMore:false,nextCursor:null,truncated:false},meta:{version:1,source,asOf},
   execution:{id:execution.id,workId:execution.workId,workInputId:execution.workInputId,executionKey:execution.executionKey,status:'succeeded'}};
  await finishWorkQueryExecution({tenantId,executionId:execution.id,status:'succeeded',rowCount:1,durationMs:performance.now()-started,resultSummary:{
   programmeId:programme.id,status:current.status,observedGoalDigest:current.observedGoalDigest,financialEfficacyEstablished:false}});
  return result;
 }catch(error){
  await finishWorkQueryExecution({tenantId,executionId:execution.id,status:'failed',rowCount:0,durationMs:performance.now()-started,
   failure:{code:'Y1_CANONICAL_PROGRAMME_QUERY_UNAVAILABLE'}});throw error;
 }
}
