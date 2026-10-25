import {z} from 'zod';
import {beginWorkQueryExecution,finishWorkQueryExecution} from '@finnor/db';
import type {OperationalQueryOptions} from '@finnor/read-models';
import type {PrimaryDiligenceQueryRequest,PrimaryDiligenceQueryResult} from '@finnor/shared-types';
import type {PeMutationContext} from '../types';
import {actor,authorize,currentActor,hash,tx} from './store';
import {readPrimary,readPrimaryContext} from './api';

const schema=z.object({intent:z.literal('primary_diligence_v1'),workId:z.string().uuid(),dealId:z.string().uuid(),programmeId:z.string().uuid().optional()}).strict();
export async function executePrimaryDiligenceQuery(tenantId:string,body:PrimaryDiligenceQueryRequest,options:OperationalQueryOptions={}):Promise<PrimaryDiligenceQueryResult>{
 const request=schema.parse(body),principal=options.employeeId??options.userId;
 if(!principal||options.workId!==request.workId||!options.workInputId)throw Error('PRIMARY_AUTHENTICATED_WORK_INPUT_REQUIRED');
 const ctx:PeMutationContext={auth:{tenantId,userId:principal,employeeId:principal,role:'owner'}},root={entityType:'pe_deal' as const,entityId:request.dealId};
 await authorize(ctx,root,request.workId);
 const assertCurrent=()=>tx(ctx,async c=>{
  await currentActor(ctx,c);
  const current=(await c.query('SELECT id::text FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[tenantId,request.workId])).rows[0];
  if(current?.id!==options.workInputId)throw Error('PRIMARY_WORK_REVISION_CHANGED');
 },true);
 await assertCurrent();
 let data:Record<string,unknown>;
 if(request.programmeId){
  const read=await readPrimary(ctx,request.programmeId);
  if(read.workId!==request.workId||read.workRevision!==options.workInputId||read.root.entityType!==root.entityType||read.root.entityId!==root.entityId)throw Error('PRIMARY_QUERY_SCOPE_MISMATCH');
  data={...read};
 }else{
  data={...await readPrimaryContext(ctx,root),status:'WORKSPACE',workId:request.workId,workRevision:options.workInputId,
   requiredMandateFields:['assertions','mandateRef','authorityProfileRef','budgetGrantRef','sourceProfileRefs','consentRefs','referenceSemanticsRefs'],independentlyEstablished:false};
 }
 await assertCurrent();
 const started=performance.now(),execution=await beginWorkQueryExecution({tenantId,workId:request.workId,workInputId:options.workInputId,intent:request.intent,request:{...request},executionKey:options.executionKey??'primary:'+hash({request,input:options.workInputId,data})});
 const asOf=new Date().toISOString(),source={kind:'canonical_postgres' as const,tables:['v2_programmes','v2_findings','primary_governance_versions','work_inputs']};
 const result:PrimaryDiligenceQueryResult={kind:'operational_query_result',status:data.status==='WORKSPACE'||data.status==='COMPLETE'?'ok':'partial',data,version:1,intent:request.intent,source,asOf,count:1,truncated:false,
  page:{limit:1,returned:1,totalCount:1,totalCountExact:true,hasMore:false,nextCursor:null,truncated:false},meta:{version:1,source,asOf},execution:{id:execution.id,workId:execution.workId,workInputId:execution.workInputId,executionKey:execution.executionKey,status:'succeeded'}};
 await finishWorkQueryExecution({tenantId,executionId:execution.id,status:'succeeded',rowCount:1,durationMs:performance.now()-started,resultSummary:{programmeId:request.programmeId??null,status:data.status,principalId:actor(ctx),executionAuthorityGranted:false}});
 return result;
}
