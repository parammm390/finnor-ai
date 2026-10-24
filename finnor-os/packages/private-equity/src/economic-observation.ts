/** S7 independently reads native S5 state/history and persists a measurement in
 * its existing immutable economic record owner. No reward or causal estimate. */
import type {PoolClient} from 'pg';
import type {PeMutationContext} from './types';
import type {EconomicObligation} from './economic-obligations';
import {persistEconomicRecordTx} from './economic-store';
import {readEconomicReservationTx,economicResourceTotals} from './economic-allocation';
import {same,digest,fail} from './economic-action-theory/contracts';
import {decimal} from './economic-action-theory/finite';
export async function observeEconomicRightTransitionTx(ctx:PeMutationContext,c:PoolClient,obligation:EconomicObligation){
 const held=await readEconomicReservationTx(ctx,c,obligation.reservationRef,true);
 const history=(await c.query<{revision:number;body:Record<string,any>}>(
  "SELECT revision,body FROM finnor_os.s5_history WHERE tenant_id=$1 AND subject_id=$2 AND operation='ECONOMIC_RIGHT_TRANSITION' AND body->'effectRef'->>'id'=$3",
  [ctx.auth.tenantId,obligation.reservationRef.id,obligation.effectRef.id])).rows;
 if(history.length!==1)fail('S7_ECONOMIC_EXACT_OWNER_OBSERVATION_UNAVAILABLE');
 const observation=history[0]!,body=observation.body;
 if(observation.revision!==obligation.preparedReservationRevision+1||!same(body.obligationRef,obligation.ref)||
  !same(body.consumptionRef,obligation.consumptionRef)||!same(body.effectRef,obligation.effectRef)||
  !same(body.before,obligation.before)||!same(body.after,obligation.after)||body.capacityDelta!=='0'||body.accountableEnvelopeUnchanged!==true)
  fail('S7_ECONOMIC_OBSERVATION_SEMANTIC_SUBSTITUTION');
 const before=economicResourceTotals(held.economicState.bindings,obligation.before),after=economicResourceTotals(held.economicState.bindings,obligation.after);
 if([...before].some(([id,total])=>after.get(id)!==total))fail('S7_ECONOMIC_OBSERVATION_CAPACITY_CHANGED');
 const original=(await c.query('SELECT envelopes FROM finnor_os.s5_reservations WHERE tenant_id=$1 AND reservation_id=$2',[ctx.auth.tenantId,obligation.reservationRef.id])).rows[0];
 if(!original||!same(original.envelopes,held.origin.envelopes))fail('S7_ECONOMIC_ACCOUNTABLE_ENVELOPE_CHANGED');
 return persistEconomicRecordTx(ctx,{kind:'MEASUREMENT',payload:{schema:'finnor.s7.economic-right-observation.v1',obligationRef:obligation.ref,
  effectRef:obligation.effectRef,reservationRef:obligation.reservationRef,consumptionRef:obligation.consumptionRef,
  ownerHistoryRevision:observation.revision,ownerHistoryDigest:digest(body),before:obligation.before,after:obligation.after,
  resourceTotals:Object.fromEntries([...after].map(([id,n])=>[id,decimal(n)])),capacityDelta:'0',accountableEnvelopeUnchanged:true,
  currentStateMayBeLater:held.revision>observation.revision,source:'CANONICAL_S5_HISTORY_READ_IN_SEPARATE_TRANSACTION',
  protectionDomain:'DISPOSABLE_LOCAL_DEVELOPMENT',externalSettlementEstablished:false,financialEfficacyEstablished:false},
  rightsRef:held.certificate.rightsRef,idempotencyKey:'y1-observe:'+obligation.effectRef.id,semanticRequestDigest:digest({obligationRef:obligation.ref,ownerHistoryDigest:digest(body)}),
  validAt:obligation.preparedAt,horizon:'H0',uncertainty:'INTERNAL_RIGHT_STATE_ONLY_NOT_EXTERNAL_SETTLEMENT_OR_ECONOMIC_VALUE',
  dependencies:[obligation.ref,obligation.effectRef,obligation.reservationRef]},c);
}
