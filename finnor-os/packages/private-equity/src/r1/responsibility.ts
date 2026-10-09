import type {PeMutationContext} from '../types';
import type {PoolClient} from 'pg';
import {tx,sha} from '../evidence-execution/store';
/** S6's actual durable responsibility is authoritative. Caller-supplied empty
 * model obligations cannot clear an outstanding provider/effect outcome. */
export async function readR1Responsibility(ctx:PeMutationContext,client?:PoolClient){
 const read=async(c:PoolClient)=>(await c.query("SELECT id,status,to_jsonb(e) body FROM finnor_os.business_effects e WHERE tenant_id=$1 AND status NOT IN ('verified','cancelled','compensated') ORDER BY id LIMIT 257"+(client?' FOR SHARE':''),[ctx.auth.tenantId])).rows;
 const rows=client?await read(client):await tx(ctx,read,true);
 return {owner:'S6' as const,unresolved:rows.slice(0,256).map(r=>({id:r.id,status:r.status,ref:{owner:'S6',id:'business-effect:'+r.id,version:'DURABLE_S6_ROW_OBSERVATION_NOT_SETTLEMENT',contentDigest:sha(r.body)}})),hasMore:rows.length>256,queriedAt:new Date().toISOString(),responsibilityReleased:false};
}
/** The S6 prepare owner uses this same S5 portfolio lock. Check while holding
 * it at physical admission and head publication, including empty portfolios. */
export async function assertR1ResponsibilityCurrent(ctx:PeMutationContext,c:PoolClient){
 const r=await readR1Responsibility(ctx,c);if(r.unresolved.length||r.hasMore)throw Error('R1_S6_OUTSTANDING_RESPONSIBILITY_RETAINED');
}
