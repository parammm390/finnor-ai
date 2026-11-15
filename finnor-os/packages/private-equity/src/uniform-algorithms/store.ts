import type {PoolClient} from 'pg';
import type {z} from 'zod';
import {employeeAuthoritySnapshotTx,canExerciseAuthorityTx} from '@finnor/authority';
import type {PeMutationContext,PeWorldRootRef} from '../types';
import type {CanonicalAllocationProblem} from '../../../shared-types/src/allocation';
import type {AlgorithmTheoryCapsule} from '../../../shared-types/src/algorithm-theory';
import {authorize,closingTx,principal,revisions,unavailable} from '../owner-context';
import {workCutTx,assertAuthorityTemporalBoundsTx} from '../enterprise-applications/store';
import {currentUniformEnvironment,type UniformEnvironment} from './source-cut';
import {digest,fail,SubmitSchema,type UniformJob} from './contracts';
import {isTotalDiscovery,validateTotalDiscovery,type TotalDiscoveryRow} from './total-contracts';
export {isTotalDiscovery,type TotalDiscoveryRow} from './total-contracts';
export {principal};
export interface DiscoveryFenceRow{
 tenant_id:string;principal_id:string;id:string;work_id:string;root_type:PeWorldRootRef['entityType'];root_id:string;
 episode_id:string;request_digest:string;
 deadline_at:Date;generation:number;attempt_count:number;use_count:number;max_attempts:number;max_uses:number;status:string;result_digest:string|null;
}
export interface DiscoveryRow extends DiscoveryFenceRow{
 request:z.infer<typeof SubmitSchema>;
 binding:{work:{id:string;digest:string};problemIdentity:string;originalProblem:CanonicalAllocationProblem;environment:UniformEnvironment;authorityRevision:string;
  dependencies:Awaited<ReturnType<typeof revisions>>};
}
export const tx=<T>(ctx:PeMutationContext,fn:(c:PoolClient,authorityValidUntil:string|null)=>Promise<T>)=>closingTx(ctx,async c=>{
 const a=await employeeAuthoritySnapshotTx(ctx.auth,c),result=await fn(c,a.validUntil);
 if(a.validUntil)await assertAuthorityTemporalBoundsTx(c,[a.validUntil]);return result;
});
export async function authorizeTx(ctx:PeMutationContext,c:PoolClient,root:PeWorldRootRef,workId:string){
 if(ctx.auth.role!=='owner'||ctx.auth.userId!==principal(ctx))throw unavailable();
 const active=(await c.query("SELECT id FROM finnor_os.users WHERE tenant_id=$1 AND id=$2 AND role='owner' AND status='active' FOR SHARE",[ctx.auth.tenantId,principal(ctx)])).rows[0];
 if(!active)throw unavailable();
 await authorize(ctx,root,[{type:'work',id:workId}],[],c);
 if(!await canExerciseAuthorityTx(ctx.auth,{operation:'query',capability:'query:pe_world_state',resource:{type:root.entityType,id:root.entityId},risk:'low'},c))throw unavailable();
}
export async function commonDiscoveryTx(ctx:PeMutationContext,c:PoolClient,id:string,lock=false):Promise<DiscoveryRow|TotalDiscoveryRow>{
 const row=(await c.query<DiscoveryRow>('SELECT * FROM finnor_os.y5_discoveries WHERE tenant_id=$1 AND principal_id=$2 AND id=$3'+(lock?' FOR UPDATE':''),[ctx.auth.tenantId,principal(ctx),id])).rows[0];
 if(!row)throw unavailable();await authorizeTx(ctx,c,{entityType:row.root_type,entityId:row.root_id},row.work_id);
 if(isTotalDiscovery(row))return validateTotalDiscovery(row);
 if(!SubmitSchema.safeParse(row.request).success||digest(row.request)!==row.request_digest)
  fail('Y5_STORED_DISCOVERY_PROTOCOL_OR_INTEGRITY');
 return row;
}
export async function discoveryTx(ctx:PeMutationContext,c:PoolClient,id:string,lock=false):Promise<DiscoveryRow>{
 const row=await commonDiscoveryTx(ctx,c,id,lock);
 if(isTotalDiscovery(row))fail('Y5_TOTAL_V2_REQUIRES_TYPED_OWNER_PROTOCOL');
 return row;
}
export async function problemCutTx(ctx:PeMutationContext,c:PoolClient,root:PeWorldRootRef,workId:string){
 const authority=await employeeAuthoritySnapshotTx(ctx.auth,c);
 const dependencies=await revisions(ctx,['rights:tenant','m3:s5-complete','m3:s6-effects',
  'm3:root:'+root.entityType+':'+root.entityId,'canonical:'+root.entityType+':'+root.entityId,'work-inputs:'+workId],c,true);
 return {authorityRevision:String(authority.revision),dependencies,work:await workCutTx(c,{tenant_id:ctx.auth.tenantId,work_id:workId})};
}
export async function currentTx(ctx:PeMutationContext,c:PoolClient,a:DiscoveryRow){
 if(['CANCELLED','INVALIDATED'].includes(a.status)||a.deadline_at.getTime()<=Date.now())fail('Y5_ORIGINAL_ALLOCATION_CANCELLED_STALE_OR_EXPIRED');
 const work=await workCutTx(c,a);
 if(digest(work)!==digest(a.binding.work))fail('Y5_CURRENT_WORK_INPUT_CHANGED');
 const authority=await employeeAuthoritySnapshotTx(ctx.auth,c);
 if(String(authority.revision)!==a.binding.authorityRevision)fail('Y5_CURRENT_AUTHORITY_REVISION_CHANGED');
 if(!a.binding.dependencies||digest(await revisions(ctx,a.binding.dependencies.map(d=>d.key),c,true))!==digest(a.binding.dependencies))
  fail('Y5_ORIGINAL_SOURCE_OR_RESPONSIBILITY_CHANGED');
 const row=(await c.query('SELECT status,current_owner_id FROM finnor_os.works WHERE tenant_id=$1 AND id=$2 FOR SHARE',[a.tenant_id,a.work_id])).rows[0];
 if(!row||['failed','cancelled','completed'].includes(row.status)||row.current_owner_id&&row.current_owner_id!==a.principal_id)fail('Y5_CURRENT_WORK_OWNER_CHANGED');
 if(digest(await currentUniformEnvironment())!==digest(a.binding.environment))fail('Y5_METHOD_OR_CHECKER_CHANGED');
 await assertAuthorityTemporalBoundsTx(c,[a.deadline_at.toISOString()]);
}
export async function eventTx(c:PoolClient,a:DiscoveryFenceRow,key:string,kind:string,body:unknown){
 await c.query('INSERT INTO finnor_os.y5_events(tenant_id,principal_id,discovery_id,event_key,kind,body) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(tenant_id,principal_id,discovery_id,event_key) DO NOTHING',
  [a.tenant_id,a.principal_id,a.id,key,kind,JSON.stringify(body)]);
}
export async function capsuleTx(c:PoolClient,a:DiscoveryRow):Promise<AlgorithmTheoryCapsule|null>{
 if(!a.result_digest)return null;
 const row=(await c.query<{body:AlgorithmTheoryCapsule}>('SELECT body FROM finnor_os.y5_capsules WHERE tenant_id=$1 AND principal_id=$2 AND discovery_id=$3 AND content_digest=$4',[a.tenant_id,a.principal_id,a.id,a.result_digest])).rows[0];
 if(!row||digest(row.body)!==a.result_digest)fail('Y5_IMMUTABLE_CAPSULE_INTEGRITY');return row.body;
}
export async function enqueueTx(c:PoolClient,p:UniformJob,maxAttempts:number){
 return (await c.query<{id:string}>("INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,protocol_version,max_attempts,lane) VALUES($1,'discover_uniform_algorithm_v1',$2::jsonb,$3,1,$4,'batch') RETURNING id",
  [p.tenantId,JSON.stringify(p),'y5:'+p.discoveryId+':'+p.generation,maxAttempts])).rows[0]!.id;
}
