import type { PoolClient } from 'pg';
import { withTenantClientTransaction } from '@finnor/db';
import type { ExperimentRef } from '../../../shared-types/src';
import type { PeMutationContext } from '../types';
import { atlasHash } from '../../../epistemic-runtime/src/policy-atlas/exact';
import { principal } from '../decision-slice/adapters';
import { r7Unavailable, R7Error, type R7BuildRow, type R7Family, type R7Parameters, type R7Query } from './contracts';

/** Guarded reads lock the actual principal against concurrent revocation.
 * PostgreSQL READ ONLY forbids that lock, even when no data is mutated. */
export const r7Tx=<T>(ctx:PeMutationContext,fn:(c:PoolClient)=>Promise<T>)=>
  withTenantClientTransaction(ctx.auth.tenantId,{userId:principal(ctx)},fn);
export async function r7Authorize(ctx:PeMutationContext,c:PoolClient) {
  if(ctx.auth.role!=='owner'||ctx.auth.userId!==principal(ctx))throw r7Unavailable();
  const user=(await c.query("SELECT id FROM finnor_os.users WHERE tenant_id=$1 AND id=$2 AND status='active' AND role='owner' FOR SHARE",
    [ctx.auth.tenantId,principal(ctx)])).rows[0];
  if(!user)throw r7Unavailable();
}
export async function r7Build(ctx:PeMutationContext,id:string,c?:PoolClient,lock=false):Promise<R7BuildRow>{
  const read=async(client:PoolClient)=>{await r7Authorize(ctx,client);
    const row=(await client.query<R7BuildRow>('SELECT * FROM finnor_os.r7_builds WHERE tenant_id=$1 AND principal_id=$2 AND id=$3'+(lock?' FOR UPDATE':''),
      [ctx.auth.tenantId,principal(ctx),id])).rows[0];if(!row)throw r7Unavailable();return row;};
  return c?read(c):r7Tx(ctx,read);
}
export async function r7Family(ctx:PeMutationContext,ref:ExperimentRef,c?:PoolClient):Promise<R7Family>{
  if(ref.owner!=='S3'||ref.version!=='r7-exact-affine-v1'||ref.id!==`affine-family:${ref.contentDigest}`)throw r7Unavailable();
  const read=async(client:PoolClient)=>{await r7Authorize(ctx,client);
    const row=(await client.query<{body:R7Family}>('SELECT body FROM finnor_os.r7_families WHERE tenant_id=$1 AND principal_id=$2 AND content_digest=$3',
      [ctx.auth.tenantId,principal(ctx),ref.contentDigest])).rows[0];
    if(!row)throw r7Unavailable();const {ref:stored,...body}=row.body;
    if(atlasHash(stored)!==atlasHash(ref)||atlasHash(body)!==ref.contentDigest)throw new R7Error('CHECK_FAILED','Immutable original family differs');
    return row.body;};return c?read(c):r7Tx(ctx,read);
}
export async function r7Parameters(ctx:PeMutationContext,family:R7Family,c?:PoolClient):Promise<R7Parameters>{
  const read=async(client:PoolClient)=>{const row=(await client.query<{body:R7Parameters}>(
    'SELECT p.body FROM finnor_os.r7_parameters p JOIN finnor_os.r7_parameter_heads h USING(tenant_id,principal_id,content_digest) WHERE h.tenant_id=$1 AND h.principal_id=$2 AND h.family_digest=$3',
    [ctx.auth.tenantId,principal(ctx),family.ref.contentDigest])).rows[0];if(!row)throw r7Unavailable();
    const {ref,...body}=row.body;if(ref.owner!=='BUSINESS_OWNER'||ref.version!=='r7-exact-affine-v1'||ref.id!==`atlas-parameters:${ref.contentDigest}`||
      atlasHash(body)!==ref.contentDigest||atlasHash(body.familyRef)!==atlasHash(family.ref))throw new R7Error('CHECK_FAILED');
    return row.body;};return c?read(c):r7Tx(ctx,read);
}
export async function r7QueryRecord(ctx:PeMutationContext,ref:ExperimentRef,c?:PoolClient):Promise<R7Query>{
  const read=async(client:PoolClient)=>{const row=(await client.query<{body:R7Query}>(
    'SELECT body FROM finnor_os.r7_queries WHERE tenant_id=$1 AND principal_id=$2 AND content_digest=$3',
    [ctx.auth.tenantId,principal(ctx),ref.contentDigest])).rows[0];if(!row)throw r7Unavailable();
    const {ref:actual,...body}=row.body;if(atlasHash(actual)!==atlasHash(ref)||atlasHash(body)!==ref.contentDigest)throw new R7Error('CHECK_FAILED');
    return row.body;};return c?read(c):r7Tx(ctx,read);
}
export async function r7Event(ctx:PeMutationContext,buildId:string,attemptId:string,kind:string,body:unknown,c?:PoolClient) {
  const write=(client:PoolClient)=>client.query(
    'INSERT INTO finnor_os.r7_events(tenant_id,principal_id,build_id,attempt_id,kind,body) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
    [ctx.auth.tenantId,principal(ctx),buildId,attemptId,kind,JSON.stringify(body)]);
  return c?write(c):r7Tx(ctx,write);
}
export async function spendR7Invocation(ctx:PeMutationContext,episodeId:string){
  return r7Tx(ctx,async c=>{
    await r7Authorize(ctx,c);
    const row=(await c.query<{deadline_at:Date;invocations:number}>(
      'UPDATE finnor_os.r7_episodes SET invocations=invocations+1 WHERE tenant_id=$1 AND principal_id=$2 AND episode_id=$3 AND invocations<max_invocations AND deadline_at>clock_timestamp() RETURNING deadline_at,invocations',
      [ctx.auth.tenantId,principal(ctx),episodeId])).rows[0];
    if(!row)throw new R7Error('LIMIT_EXCEEDED','Original episode invocation/deadline exhausted');
    return row;
  });
}
