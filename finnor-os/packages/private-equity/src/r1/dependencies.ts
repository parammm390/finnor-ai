import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {JobExecutionContext} from '../../../../apps/worker/src/queue';
import {affectedClosure} from '../live-recompilation/contracts';
import {tx,sha,stable} from '../evidence-execution/store';
import {r1Row,r1Event,type R1RunRow} from './api';
import type {PeMutationContext} from '../types';
export type R1DependencyKind='SOURCE'|'RIGHTS'|'WORK'|'METHOD'|'GRANT'|'OBSERVATION'|'TIMING'|'OBLIGATION'|'MANDATE';
const inputs:R1DependencyKind[]=['SOURCE','RIGHTS','WORK','METHOD','GRANT','OBSERVATION','TIMING','OBLIGATION','MANDATE'];
export function r1DependencySeeds(predicate:string):R1DependencyKind[]{
 if(/WORK|INPUT|PROGRAM_STOPPED|EPISODE/.test(predicate))return ['WORK'];
 if(/METHOD|SOURCE_CUT|LOADED_SOURCE/.test(predicate))return ['METHOD'];
 if(/S6|LIABILITY|OBLIGATION/.test(predicate))return ['OBLIGATION'];
 if(/GRANT|S5|COMPUTE_RESOURCE|COMPUTE_HORIZON/.test(predicate))return ['GRANT'];
 if(/EXPIRED|DEADLINE|TIMING/.test(predicate))return ['TIMING'];
 if(/RIGHTS|MEMBERSHIP/.test(predicate))return ['SOURCE','RIGHTS'];
 return ['SOURCE'];
}
/** P7's complete closure, extended by a structural versioned owner graph.
 * These are dependency nodes, not invented analytical HarnessNode operators. */
export function r1AffectedDependencyClosure(runId:string,seeds:R1DependencyKind[]){
 const ids=[...inputs,'QUOTIENT','CHECK','S4_POLICY','S5_DEMAND','WORK_VIEW'];
 const edges:Record<string,string[]>={...Object.fromEntries(inputs.map(i=>[i,[]])),QUOTIENT:[...inputs],CHECK:['QUOTIENT','SOURCE','METHOD'],S4_POLICY:['CHECK',...inputs],S5_DEMAND:['S4_POLICY','GRANT','OBLIGATION'],WORK_VIEW:['S4_POLICY','S5_DEMAND','RIGHTS','WORK']};
 const graph=ids.map(id=>({id:runId+':'+id,dependsOn:edges[id]!.map(parent=>runId+':'+parent)}));
 const closure=affectedClosure(graph,seeds.map(id=>runId+':'+id));
 return {schema:'finnor.r1.p7-dependency-adapter.v1',seeds,affected:closure.affectedNodes.map(n=>n.id),kept:closure.keptNodes.map(n=>n.id),originalEpisodeRetained:true,obligationsReleased:false};
}
export async function enqueueR1DependencyContinuation(ctx:PeMutationContext,row:R1RunRow,predicate:string,c:PoolClient){
 const payload={schema:'finnor.r1.p7-invalidation.v1',tenantId:row.tenant_id,principalId:row.principal_id,runId:row.id,generation:row.generation+1,predicate,seeds:r1DependencySeeds(predicate),priorHeadId:row.head_id,originalEpisode:row.episode_id,originalDeadlineAt:row.original_deadline_at.toISOString()};
 await c.query("INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,protocol_version,retry_safety) VALUES($1,'run_r1_dependency_continuation_v1',$2::jsonb,$3,'interactive',1,'locally_idempotent') ON CONFLICT(idempotency_key) DO NOTHING",[row.tenant_id,stable(payload),'r1-p7:'+row.id+':'+payload.generation]);
 await r1Event(ctx,row,'P7_DEPENDENCY_HANDOFF',{payloadDigest:sha(payload),affected:r1AffectedDependencyClosure(row.id,payload.seeds),originalEpisode:row.episode_id,newSearchBudgetGranted:false},c);
}
/** Called by the real P7 queue handler. Publication is an immutable invalidation
 * patch, never a stale financial claim or a new programme/grant/obligation. */
export async function runR1DependencyContinuation(payload:Record<string,unknown>,execution?:Readonly<JobExecutionContext>){
 if(!execution||typeof execution.tenantId!=='string'||execution.protocolVersion!==1||execution.retrySafety!=='locally_idempotent'||execution.tenantId!==payload.tenantId||payload.schema!=='finnor.r1.p7-invalidation.v1'||typeof payload.principalId!=='string'||typeof payload.runId!=='string'||!Number.isSafeInteger(payload.generation)||!Array.isArray(payload.seeds)||payload.seeds.some(s=>!inputs.includes(s as R1DependencyKind)))throw Error('R1_P7_ACTUAL_VERSIONED_JOB_CONTEXT_REQUIRED');
 const ctx:PeMutationContext={auth:{tenantId:execution.tenantId,userId:payload.principalId,employeeId:payload.principalId,role:'owner'}};
 await tx(ctx,async c=>{
  if(!(await c.query("SELECT id FROM finnor_os.jobs WHERE tenant_id=$1 AND id=$2 AND type='run_r1_dependency_continuation_v1' AND status='running' AND claim_token=$3 AND claim_fence=$4 AND protocol_version=1 AND lease_expires_at>clock_timestamp() FOR SHARE",[execution.tenantId,execution.jobId,execution.claimToken,execution.claimFence])).rowCount)throw Error('R1_P7_CANONICAL_CLAIM_FENCED');
  const row=await r1Row(ctx,payload.runId as string,c,true);if(row.generation!==payload.generation||row.status!=='INVALIDATED')return;
  if(row.episode_id!==payload.originalEpisode||row.original_deadline_at.toISOString()!==payload.originalDeadlineAt)throw Error('R1_P7_ORIGINAL_EPISODE_BINDING_REQUIRED');
  if((await c.query("SELECT id FROM finnor_os.r1_artifacts WHERE run_id=$1 AND generation=$2 AND kind='P7_INVALIDATION_PATCH'",[row.id,row.generation])).rowCount)return;
  const closure=r1AffectedDependencyClosure(row.id,payload.seeds as R1DependencyKind[]),id=randomUUID();
  const body={schema:'finnor.r1.p7-continuation-patch.v1',runId:row.id,workId:row.work_id,workRevision:row.work_input_id,priorHeadId:payload.priorHeadId,
   trigger:{predicate:payload.predicate,payloadDigest:sha(payload)},closure,originalEpisode:row.episode_id,originalDeadlineAt:row.original_deadline_at.toISOString(),
   disposition:'INVALIDATED_RECOMPILE_CURRENT_OWNER_INPUT_REQUIRED',keptNodesAreHistorical:true,claimPublication:false,newEpisodeGranted:false,newComputeGrantGranted:false,
   outstandingResponsibility:'RETAINED_BY_ORIGINAL_S6_OWNER',costsReleased:false,executionAuthorityGranted:false,
   runtime:{workerId:execution.workerId,jobId:execution.jobId,deliveryAttemptId:execution.deliveryAttemptId,claimFence:Number(execution.claimFence)}};
  await c.query("INSERT INTO finnor_os.r1_artifacts(id,tenant_id,principal_id,run_id,generation,kind,body,digest) VALUES($1,$2,$3,$4,$5,'P7_INVALIDATION_PATCH',$6::jsonb,$7)",[id,row.tenant_id,row.principal_id,row.id,row.generation,stable(body),sha(body)]);
  await r1Event(ctx,row,'P7_INVALIDATION_PATCH_PUBLISHED',{artifactId:id,digest:sha(body),affected:closure.affected,kept:closure.kept,currentClaim:false,responsibilityReleased:false},c);
 });
}
