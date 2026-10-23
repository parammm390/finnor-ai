/** Canonical S6 origin and native Business Effect specialization. Internal right
 * transitions are NOT the external json-field-replace-v1 method. */
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {PeMutationContext} from './types';
import {programmeTx,type EconomicProgramme} from './economic-control';
import {readEconomicReservationTx,moveEconomicRightsTx,commitS5EconomicReferenceTx} from './economic-allocation';
import {withS5PortfolioTransaction as transaction} from './allocation-store';
import {principal,developmentOnly,theoryTx,eventTx,chargeOwnerStorageTx} from './economic-action-theory/store';
import {digest,reference,same,fail,type EconomicRef,type State} from './economic-action-theory/contracts';
import {applyOperator} from './economic-action-theory/finite';
import {observeEconomicRightTransitionTx} from './economic-observation';
import {economicStepIntent} from './program-synthesis/economic-native';
export interface EconomicObligation {
 schema:'finnor.s6.economic-obligation.v1';ref:EconomicRef;tenantId:string;principalId:string;programmeId:string;programmeRef:EconomicRef;
 theoryId:string;theoryRef:EconomicRef;stepIndex:number;operatorId:string;parameters:State;before:State;after:State;
 reservationRef:EconomicRef;preparedReservationRevision:number;consumptionRef:EconomicRef;effectRef:EconomicRef;domainActionId:string;
 method:'S5_RESERVATION_RIGHT_TRANSITION_V1';possibleExternalEffects:false;responsibility:'RECONCILE_ORIGINAL_NATIVE_EFFECT_BEFORE_RETRY';
 executionAuthorityGranted:false;protectedReceipt:null;preparedAt:string;
}
async function originTx(ctx:PeMutationContext,c:PoolClient,programme:EconomicProgramme,index:number){
 const r=(await c.query<{body:EconomicObligation;status:string;observed_result:unknown;verification:unknown;
  effect:Record<string,any>;semantic_hash:string;scope_hash:string;operation_class:string;action_payload:unknown;action_type:string}>(`SELECT o.body,e.status,e.observed_result,e.verification,
   e.effect,e.semantic_hash,e.scope_hash,e.operation_class,a.payload action_payload,a.action_type
  FROM finnor_os.s6_economic_obligation_origins o JOIN finnor_os.business_effects e ON e.tenant_id=o.tenant_id AND e.id=o.effect_id
  JOIN finnor_os.domain_actions a ON a.tenant_id=o.tenant_id AND a.id=o.domain_action_id AND e.domain_action_id=a.id
  WHERE o.tenant_id=$1 AND o.principal_id=$2 AND o.programme_id=$3 AND o.step_index=$4 FOR UPDATE OF e`,
  [ctx.auth.tenantId,principal(ctx),programme.id,index])).rows[0];
 if(r){
  const {ref,...body}=r.body,step=programme.steps[index];
  const {semanticHash,scopeHash,...effectBody}=r.effect;
  if(!same(ref,reference('S6','economic-obligation',body))||!step||!same(body.programmeRef,programme.ref)||
   !same(body.before,step.before)||!same(body.after,step.after)||body.operatorId!==step.operatorId||!same(body.parameters,step.parameters)||
   !same(body.theoryRef,programme.theoryRef)||!same(body.reservationRef,programme.reservationRef)||body.method!=='S5_RESERVATION_RIGHT_TRANSITION_V1')
   fail('S6_ECONOMIC_ORIGIN_BINDING');
  if(r.semantic_hash!==body.effectRef.contentDigest||semanticHash!==r.semantic_hash||digest(effectBody)!==r.semantic_hash||
   scopeHash!==r.scope_hash||digest(effectBody.targets)!==r.scope_hash||r.operation_class!=='internal_write'||
   effectBody.operationClass!=='internal_write'||effectBody.externalEconomicEffect!==false||
   effectBody.source?.domainActionId!==body.domainActionId||effectBody.source?.workId!==programme.workId||
   effectBody.source?.planRevisionId!==programme.planRevisionId||r.action_type!=='execute_economic_right_transition'||
   !same(r.action_payload,effectBody.delta?.values)||!same(effectBody.delta?.values,
    economicStepIntent(body.theoryRef,programme.id,body.reservationRef,index,step)))
   fail('S6_ECONOMIC_NATIVE_EFFECT_PREIMAGE');
 }
 return r;
}
export async function prepareEconomicObligation(ctx:PeMutationContext,programmeId:string,index:number,fence:(c:PoolClient)=>Promise<void>){
 developmentOnly();
 return transaction(ctx,async c=>{
  const programme=await programmeTx(ctx,c,programmeId);await fence(c);
  if(!Number.isSafeInteger(index)||index<0||index>=programme.steps.length)fail('S6_ECONOMIC_STEP_DOMAIN');
  const prior=await originTx(ctx,c,programme,index);if(prior)return prior.body;
  if(index){
   const previous=await originTx(ctx,c,programme,index-1);
   if(previous?.status!=='verified')fail('S6_ECONOMIC_PREDECESSOR_OBSERVATION_REQUIRED');
  }
  const step=programme.steps[index]!,row=await theoryTx(ctx,c,programme.theoryId),held=await readEconomicReservationTx(ctx,c,programme.reservationRef);
  const operator=row.candidate!.operators.find(o=>o.id===step.operatorId);
  if(!operator||!same(applyOperator(row.request.problem,operator,held.economicState.state,step.parameters),step.after)||
   !same(held.economicState.state,step.before)||index===0&&held.revision!==programme.initialRevision)
   fail('S6_ECONOMIC_EXACT_COMPILED_SEMANTICS_REQUIRED',409);
  const pending=(await c.query(`SELECT 1 FROM finnor_os.s5_consumptions co JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id)
   WHERE co.tenant_id=$1 AND co.reservation_id=$2 AND st.status<>'RECONCILED' LIMIT 1`,[row.tenant_id,programme.reservationRef.id])).rows[0];
  if(pending)fail('S6_ECONOMIC_UNRESOLVED_OR_COMPETING_INTENT');
  const consumptionBody={schema:'finnor.s5.economic-rights-consumption.v1',tenantId:row.tenant_id,principalId:row.principal_id,
   certificateRef:held.certificate.ref,reservationRef:programme.reservationRef,policyRef:programme.ref,nodeId:String(index),
   before:step.before,after:step.after,operatorId:step.operatorId,parameters:step.parameters,theoryRef:programme.theoryRef,
   status:'INTENDED_PENDING_S6',effectRef:null,executionAuthorityGranted:false};
  const consumption={...consumptionBody,ref:reference('S5','economic-rights-consumption',consumptionBody)};
  await c.query('INSERT INTO finnor_os.s5_consumptions(tenant_id,principal_id,consumption_id,reservation_id,policy_id,node_id,idempotency_key,request_digest,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)',
   [row.tenant_id,row.principal_id,consumption.ref.id,programme.reservationRef.id,programme.ref.id,String(index),'y1-consume:'+programme.id+':'+index,digest(consumptionBody),JSON.stringify(consumption)]);
  await c.query("INSERT INTO finnor_os.s5_consumption_states(tenant_id,consumption_id,status,revision) VALUES($1,$2,'INTENDED_PENDING_S6',1)",[row.tenant_id,consumption.ref.id]);
  await c.query("UPDATE finnor_os.s5_reservations SET status=CASE WHEN status='RESERVED' THEN 'CONSUMPTION_PENDING' ELSE status END,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND reservation_id=$2",[row.tenant_id,programme.reservationRef.id]);
  const actionId=randomUUID(),effectId=randomUUID();
  const effectBody={schema:'finnor.business-effect-set.v1',schemaVersion:1,id:effectId,operationClass:'internal_write',
   source:{domainActionId:actionId,workId:programme.workId,planRevisionId:programme.planRevisionId},
   targets:[{kind:['external_organization','external_contact'].includes(programme.root.entityType)?'party':'entity',type:programme.root.entityType,id:programme.root.entityId}],
   delta:{kind:'economic_reservation_right_transition',values:economicStepIntent(programme.theoryRef,programme.id,programme.reservationRef,index,step)},
   authority:{basis:'CURRENT_S1_S4_S5_S8_DISPOSABLE_INTERNAL_ONLY'},recovery:{mode:'READ_ORIGINAL_S5_HISTORY_BEFORE_RETRY'},
   externalEconomicEffect:false};
  const effectHash=digest(effectBody),effectRef:EconomicRef={owner:'S6',id:effectId,version:'business-effect-v1',contentDigest:effectHash};
  await chargeOwnerStorageTx(c,row,[effectBody,effectBody.delta,consumption],131072);
  await c.query("INSERT INTO finnor_os.domain_actions(id,tenant_id,action_type,payload,status,summary,initiated_by,work_id,plan_revision_id,plan_node_id) VALUES($1,$2,'execute_economic_right_transition',$3::jsonb,'draft','Y1 exact disposable internal reservation-right intent',$4,$5,$6,$7)",
   [actionId,row.tenant_id,JSON.stringify(effectBody.delta.values),row.principal_id,programme.workId,programme.planRevisionId,step.planNodeId]);
  await c.query("INSERT INTO finnor_os.business_effects(id,tenant_id,domain_action_id,semantic_hash,scope_hash,operation_class,effect,status) VALUES($1,$2,$3,$4,$5,'internal_write',$6::jsonb,'compiled')",
   [effectId,row.tenant_id,actionId,effectHash,digest(effectBody.targets),JSON.stringify({...effectBody,semanticHash:effectHash,scopeHash:digest(effectBody.targets)})]);
  await c.query('UPDATE finnor_os.domain_actions SET business_effect_id=$3 WHERE tenant_id=$1 AND id=$2',[row.tenant_id,actionId,effectId]);
  const body:Omit<EconomicObligation,'ref'>={schema:'finnor.s6.economic-obligation.v1',tenantId:row.tenant_id,principalId:row.principal_id,
   programmeId:programme.id,programmeRef:programme.ref,theoryId:row.id,theoryRef:programme.theoryRef,stepIndex:index,
   operatorId:step.operatorId,parameters:step.parameters,before:step.before,after:step.after,reservationRef:programme.reservationRef,
   preparedReservationRevision:held.revision+1,consumptionRef:consumption.ref,effectRef,domainActionId:actionId,
   method:'S5_RESERVATION_RIGHT_TRANSITION_V1',possibleExternalEffects:false,
   responsibility:'RECONCILE_ORIGINAL_NATIVE_EFFECT_BEFORE_RETRY',executionAuthorityGranted:false,protectedReceipt:null,preparedAt:new Date().toISOString()};
  const obligation:EconomicObligation={...body,ref:reference('S6','economic-obligation',body)};
  await c.query('INSERT INTO finnor_os.s6_economic_obligation_origins(tenant_id,obligation_id,principal_id,programme_id,step_index,consumption_id,effect_id,domain_action_id,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)',
   [row.tenant_id,obligation.ref.id,row.principal_id,programme.id,index,consumption.ref.id,effectId,actionId,JSON.stringify(obligation)]);
  await c.query('UPDATE finnor_os.s5_consumption_states SET effect_ref=$3::jsonb,revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND consumption_id=$2',[row.tenant_id,consumption.ref.id,JSON.stringify(effectRef)]);
  await commitS5EconomicReferenceTx(ctx,c,consumption,held.certificate.rightsRef);
  await eventTx(c,row,'S6_ECONOMIC_OBLIGATION_PREPARED','obligation:'+programme.id+':'+index,{obligationRef:obligation.ref,consumptionRef:consumption.ref,
   effectRef,authorityGranted:false,externalEffects:false});
  return obligation;
 });
}
export async function executeEconomicObligation(ctx:PeMutationContext,programmeId:string,index:number,fence:(c:PoolClient)=>Promise<void>){
 developmentOnly();
 return transaction(ctx,async c=>{
  const programme=await programmeTx(ctx,c,programmeId);await fence(c);
  const native=await originTx(ctx,c,programme,index);if(!native)fail('S6_ECONOMIC_NATIVE_ORIGIN_REQUIRED');
  if(['executed','verified'].includes(native.status))return {obligation:native.body,status:native.status,replayed:true};
  if(native.status!=='compiled')fail('S6_ECONOMIC_UNKNOWN_REQUIRES_RECONCILIATION');
  const obligation=native.body,row=await theoryTx(ctx,c,programme.theoryId),consumption=(await c.query(
   'SELECT co.body,st.status,st.effect_ref FROM finnor_os.s5_consumptions co JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id) WHERE co.tenant_id=$1 AND co.consumption_id=$2 FOR UPDATE OF st',
   [ctx.auth.tenantId,obligation.consumptionRef.id])).rows[0];
  if(!consumption||!same(consumption.body.ref,obligation.consumptionRef)||consumption.status!=='INTENDED_PENDING_S6'||!same(consumption.effect_ref,obligation.effectRef))fail('S6_ECONOMIC_CONSUMPTION_FENCE');
  const revision=await moveEconomicRightsTx(ctx,c,{reservationRef:obligation.reservationRef,expectedRevision:obligation.preparedReservationRevision,
   before:obligation.before,after:obligation.after,problem:row.request.problem,obligationRef:obligation.ref,effectRef:obligation.effectRef,consumptionRef:obligation.consumptionRef});
  await c.query("UPDATE finnor_os.business_effects SET status='executed',execution_started_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",[ctx.auth.tenantId,obligation.effectRef.id]);
  await c.query("UPDATE finnor_os.domain_actions SET status='executing' WHERE tenant_id=$1 AND id=$2",[ctx.auth.tenantId,obligation.domainActionId]);
  await eventTx(c,row,'S6_INTERNAL_OWNER_COMMITTED','owner-commit:'+programme.id+':'+index,{obligationRef:obligation.ref,effectRef:obligation.effectRef,
   reservationRevision:revision,settlementEstablished:false,canonicalObservationRequired:true});
  return {obligation,status:'executed',replayed:false};
 });
}
export async function reconcileEconomicObligation(ctx:PeMutationContext,programmeId:string,index:number,fence:(c:PoolClient)=>Promise<void>){
 return transaction(ctx,async c=>{
  const programme=await programmeTx(ctx,c,programmeId,false);await fence(c);
  const native=await originTx(ctx,c,programme,index);if(!native)fail('S6_ECONOMIC_NATIVE_ORIGIN_REQUIRED');
  if(native.status==='verified')return {status:'OBSERVED',obligation:native.body,observation:native.verification,replayed:true};
  if(native.status!=='executed')return {status:'UNKNOWN',obligation:native.body,observation:null,blindRetryPermitted:false};
  // A fresh transaction reads canonical S5 history. Producer success and effect
  // acknowledgements cannot satisfy the observation predicate.
  const observation=await observeEconomicRightTransitionTx(ctx,c,native.body);
  await c.query("UPDATE finnor_os.business_effects SET status='verified',observed_result=$3::jsonb,verification=$4::jsonb,observed_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
   [ctx.auth.tenantId,native.body.effectRef.id,JSON.stringify(observation.record.payload),JSON.stringify({canonicalObservationRef:observation.record.ref,
    criterion:'EXACT_NATIVE_S5_HISTORY_AND_UNCHANGED_ACCOUNTABLE_ENVELOPE',externalSettlementEstablished:false})]);
  await c.query("UPDATE finnor_os.s5_consumption_states SET status='RECONCILED',revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND consumption_id=$2",[ctx.auth.tenantId,native.body.consumptionRef.id]);
  await c.query("UPDATE finnor_os.domain_actions SET status='completed' WHERE tenant_id=$1 AND id=$2",[ctx.auth.tenantId,native.body.domainActionId]);
  const row=await theoryTx(ctx,c,programme.theoryId);
  await eventTx(c,row,'S7_CANONICAL_OBSERVATION','observation:'+programme.id+':'+index,{obligationRef:native.body.ref,observationRef:observation.record.ref,
   externalSettlementEstablished:false,financialEfficacyEstablished:false});
  return {status:'OBSERVED',obligation:native.body,observation:observation.record.ref,replayed:false};
 });
}
