import type {PoolClient} from 'pg';
import type {PeMutationContext} from '../types';
import {m3Query,m3Tx,type M3QueryRow} from './v2-store';
import {m3Hash,CapitalProgramV2Error,type CapitalProgramV2Request} from './v2-contracts';

export interface CapitalRepairBudget {
 rootQueryId:string;deadlineAt:string;consumptionDigest:string;
 remaining:CapitalProgramV2Request['resource'];
 spent:{attempted:number;generated:number;refinementSteps:number;expansions:number;unknownExpansions:boolean};
 qualification:'ATTENUATED_ORIGINAL_LOGICAL_EPISODE_NOT_NEW_FINANCIAL_OR_PHYSICAL_GRANT';
}
/** Completed original parent and all linked descendants, including failures.
 * Locks prevent sibling repairs from spending the same remaining allowance. */
export async function capitalRepairBudget(ctx:PeMutationContext,parent:M3QueryRow,
 request:CapitalProgramV2Request,challengeDeadlines:string[],client?:PoolClient):Promise<CapitalRepairBudget>{
 const read=async(c:PoolClient)=>{
  const root=await m3Query(ctx,parent.acceptance.repairBudget?.rootQueryId??parent.id,c,true);
  if(root.work_id!==parent.work_id||!root.deadline_at)
   throw new CapitalProgramV2Error('CHECK_FAILED','Repair lacks its original started Work episode');
  const deadlineAt=new Date(Math.min(root.deadline_at.getTime(),...challengeDeadlines.map(Date.parse))).toISOString();
  if(Date.parse(deadlineAt)<=Date.now())
   throw new CapitalProgramV2Error('LIMIT_EXCEEDED','Original M3/challenge repair deadline exhausted');
  const rows=(await c.query<M3QueryRow>(`WITH RECURSIVE lineage AS(
   SELECT id,ARRAY[id] path,0 depth FROM finnor_os.m3_queries
    WHERE tenant_id=$1 AND principal_id=$2 AND id=$3
   UNION ALL SELECT q.id,l.path||q.id,l.depth+1 FROM finnor_os.m3_queries q JOIN lineage l ON q.parent_query_id=l.id
    WHERE q.tenant_id=$1 AND q.principal_id=$2 AND q.work_id=$4 AND l.depth<8 AND NOT q.id=ANY(l.path))
   SELECT q.* FROM finnor_os.m3_queries q JOIN lineage l ON q.id=l.id
    WHERE q.tenant_id=$1 AND q.principal_id=$2 ORDER BY q.created_at,q.id LIMIT 129 FOR UPDATE OF q`,
   [ctx.auth.tenantId,ctx.auth.employeeId??ctx.auth.userId,root.id,parent.work_id])).rows;
  if(rows.length>128)throw new CapitalProgramV2Error('LIMIT_EXCEEDED','Original M3 repair lineage exceeds its bounded accounting view');
  const deeper=await c.query(`SELECT q.id FROM finnor_os.m3_queries q
   WHERE q.tenant_id=$1 AND q.principal_id=$2 AND q.parent_query_id=ANY($3::uuid[]) AND NOT q.id=ANY($3::uuid[]) LIMIT 1`,
   [ctx.auth.tenantId,ctx.auth.employeeId??ctx.auth.userId,rows.map(q=>q.id)]);
  if(deeper.rowCount)throw new CapitalProgramV2Error('LIMIT_EXCEEDED','Original M3 repair ancestry exceeds eight generations');
  if(rows.some(q=>['QUEUED','RUNNING'].includes(q.status)))
   throw new CapitalProgramV2Error('CONFLICT','An original M3 repair episode still has active construction');
  const events=(await c.query<{query_id:string;attempt_id:string;kind:string;body:Record<string,any>}>(
   "SELECT query_id,attempt_id,kind,body FROM finnor_os.m3_events WHERE tenant_id=$1 AND principal_id=$2 AND query_id=ANY($3::uuid[]) AND kind IN('CANDIDATE','CHECK','FAILED','FENCED') ORDER BY created_at,id LIMIT 8193",
   [ctx.auth.tenantId,ctx.auth.employeeId??ctx.auth.userId,rows.map(q=>q.id)])).rows;
  if(events.length>8192)throw new CapitalProgramV2Error('LIMIT_EXCEEDED','Original M3 repair event accounting exceeds its complete bounded view');
  const pending=new Set<string>();
  let expansions=0,unknownExpansions=false;
  for(const event of events){
   const identity=event.query_id+':'+event.attempt_id+':'+(event.body.descriptor?.semanticDigest??event.body.candidate?.semanticDigest??'');
   if(event.kind==='CANDIDATE'&&event.body.phase==='STARTED')pending.add(identity);
   if((event.kind==='CHECK'&&event.body.candidate)||(event.kind==='CANDIDATE'&&event.body.phase==='BLOCKED'))pending.delete(identity);
   const used=event.body.ownerCompute?.usage?.expansions;
   if(used!==undefined){
    if(!Number.isSafeInteger(used)||used<0)throw new CapitalProgramV2Error('CHECK_FAILED','Original owner expansion accounting is invalid');
    expansions+=used;
   }
   if(event.body.unknownPhysicalCost===true)unknownExpansions=true;
   if(event.kind==='CHECK'&&event.body.failure&&event.body.candidate?.moduleRef)unknownExpansions=true;
  }
  unknownExpansions||=pending.size>0;
  const spent={attempted:rows.reduce((n,q)=>n+q.attempted,0),generated:rows.reduce((n,q)=>n+q.generated,0),
   refinementSteps:rows.reduce((n,q)=>n+q.refinement_steps,0),expansions,unknownExpansions};
  const limits=root.request.resource,remaining={...request.resource};
  for(const key of Object.keys(remaining) as Array<keyof typeof remaining>)remaining[key]=Math.min(remaining[key],limits[key]);
  remaining.deadlineMs=Math.min(remaining.deadlineMs,Math.max(0,Date.parse(deadlineAt)-Date.now()));
  remaining.maxAttempts=Math.max(0,Math.min(remaining.maxAttempts,limits.maxAttempts-spent.attempted));
  remaining.maxGenerated=Math.max(0,Math.min(remaining.maxGenerated,limits.maxGenerated-spent.generated));
  remaining.maxRefinementSteps=Math.max(0,Math.min(remaining.maxRefinementSteps,limits.maxRefinementSteps-spent.refinementSteps));
  remaining.maxExpansions=unknownExpansions?0:Math.max(0,Math.min(remaining.maxExpansions,limits.maxExpansions-expansions));
  if(remaining.maxAttempts<1||remaining.maxGenerated<1)
   throw new CapitalProgramV2Error('LIMIT_EXCEEDED','Original M3 repair construction allowance exhausted');
  return {rootQueryId:root.id,deadlineAt,remaining,spent,consumptionDigest:m3Hash({root:root.id,spent,
   rows:rows.map(q=>({id:q.id,status:q.status,attempted:q.attempted,generated:q.generated,refinementSteps:q.refinement_steps})),events}),
   qualification:'ATTENUATED_ORIGINAL_LOGICAL_EPISODE_NOT_NEW_FINANCIAL_OR_PHYSICAL_GRANT' as const};
 };
 return client?read(client):m3Tx(ctx,read);
}
