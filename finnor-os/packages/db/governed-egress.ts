/** Ordinary native entry/physical-boundary refusal. This never grants protected authority. */
import {sql} from 'drizzle-orm';
import type {Db} from './index';
import {requireProtectedAdapter,type S6AdapterClass} from '../governed-execution/src/adapter-contract';
export async function assertNativeEffectAdapterAdmission(db:Db,tenantId:string,binding:{businessEffectId?:string|null;domainActionId?:string|null},adapter:S6AdapterClass){
 if(!binding.businessEffectId&&!binding.domainActionId)return;
 const found=await db.execute(sql`SELECT o.obligation_id FROM finnor_os.s6_obligation_origins o
  WHERE o.tenant_id=${tenantId}::uuid AND (${binding.businessEffectId??null}::uuid IS NOT NULL AND o.effect_id=${binding.businessEffectId??null}::uuid
   OR ${binding.domainActionId??null}::uuid IS NOT NULL AND o.domain_action_id=${binding.domainActionId??null}::uuid) LIMIT 1`);
 if(found.rows.length)requireProtectedAdapter(adapter);
}
