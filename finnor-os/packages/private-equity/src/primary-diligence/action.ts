import {and,eq} from 'drizzle-orm';
import {domainActions,withTenant} from '@finnor/db';
import {PrimaryDiligenceActionSchema,type BusinessEffectSet,type PrimaryIntake} from '@finnor/shared-types';
import {actor,hash,tx,type Programme} from './store';
import type {PeMutationContext} from '../types';

export function primaryActionIntake(payload:Record<string,unknown>,workId:string,idempotencyKey:string):PrimaryIntake{
 const {dealId,...input}=PrimaryDiligenceActionSchema.parse(Object.fromEntries(Object.entries(payload).filter(([key])=>!['tenantId','workId','idempotencyKey'].includes(key))));
 return {...input,schema:'finnor.primary-diligence.v1',root:{entityType:'pe_deal',entityId:dealId},workId,idempotencyKey};
}
export async function observePrimaryCreation(tenantId:string,effect:BusinessEffectSet):Promise<Record<string,unknown>|null>{
 const principal=await withTenant(tenantId,async db=>(await db.select({id:domainActions.initiatedBy}).from(domainActions).where(and(eq(domainActions.tenantId,tenantId),eq(domainActions.id,effect.source.domainActionId))).limit(1))[0]?.id);
 if(!principal||!effect.source.workId)return null;
 const ctx:PeMutationContext={auth:{tenantId,userId:principal,employeeId:principal,role:'owner'}},expected=primaryActionIntake(effect.delta.values,effect.source.workId,effect.source.domainActionId);
 return tx(ctx,async c=>{
  const rows=(await c.query<Programme>('SELECT * FROM finnor_os.v2_programmes WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3 LIMIT 2',[tenantId,actor(ctx),effect.source.domainActionId])).rows;
  const row=rows[0];
  if(rows.length!==1||!row||row.work_id!==expected.workId||row.work_input_id!==expected.expectedWorkInputId||row.intake_digest!==hash(row.intake)||row.intake_digest!==hash(expected))return null;
  return {exists:true,id:row.id,workId:row.work_id,workInputId:row.work_input_id,status:row.status,analysisCompleted:false};
 },true);
}
