import type {PeMutationContext} from '../types';
import {readEnterpriseAllocation,validateEnterpriseAllocation} from '../enterprise-allocation';
import {readEnterpriseContingentPolicy,validateEnterpriseContingentPolicy,deriveEnterpriseDeliberationConversion} from '../enterprise-control';
import {stable} from '../evidence-execution/store';
import {assertProgramCurrent,type ProgramRow} from '../program-synthesis/store';
import type {ComputeSearchRequest} from './contracts';
/** Read the original owners. A compute semaphore or P4 envelope is never funding.
 * Native attempts have one supported SAME UNIT mapping. Dollars/tokens and
 * marginal decision-loss conversion require their actual owner contracts. */
export async function resolveSearchOwners(ctx:PeMutationContext,q:ProgramRow,r:ComputeSearchRequest) {
 await assertProgramCurrent(ctx,q);
 if(stable(q.request.ownerBindings?.policyRef)!==stable(r.policyRequest)||stable(q.request.ownerBindings?.allocationRef)!==stable(r.computeGrant))throw Error('P2_EXACT_P1_OWNER_BINDINGS_REQUIRED');
 const policy=await readEnterpriseContingentPolicy(ctx,r.policyRequest);
 const issued=await readEnterpriseAllocation(ctx,r.computeGrant),state=await validateEnterpriseAllocation(ctx,r.computeGrant);
 if(state.status!=='CURRENT'||!issued.reservation)throw Error('P2_CURRENT_S4_S5_OWNERS_REQUIRED');
 if(!issued.certificate.check.selectedPolicyIds.includes(policy.ref.id)||!issued.certificate.policyBindings.some(b=>stable(b.policyRef)===stable(policy.ref)&&b.demandDigest===policy.demand.contentDigest))throw Error('P2_SELECTED_COMPUTE_POLICY_BINDING_REQUIRED');
 if(stable(issued.certificate.mandateRef)!==stable(policy.mandateRef)||issued.certificate.rightsRef!==policy.bindings.rightsRef)throw Error('P2_OWNER_MANDATE_OR_RIGHTS_MISMATCH');
 const resources=issued.problem.resources.filter(r=>r.resourceClass==='COMPUTE'&&r.unit==='native-attempt'&&r.kind==='CUMULATIVE_EXPENDITURE');
 if(resources.length!==1)throw Error('P2_NATIVE_ATTEMPT_COMPUTE_RESOURCE_MAPPING_UNAVAILABLE');
 const resource=resources[0]!,envelope=issued.reservation.envelopes.find(e=>e.resourceId===resource.resourceId);
 if(!envelope||envelope.unit!==resource.unit||stable(envelope.horizon)!==stable(policy.mandate.horizon)||!issued.problem.demandBindings.some(b=>stable(b.policyRef)===stable(policy.ref)&&b.resourceId===resource.resourceId&&b.component==='TOTAL'&&b.conversion==='IDENTICAL_UNIT_NO_CONVERSION'))throw Error('P2_S5_SAME_UNIT_COMPUTE_ENVELOPE_REQUIRED');
 const period=Math.floor((Date.now()-Date.parse(envelope.horizon.startAt))/envelope.horizon.periodMs);
 if(period<0||period>=envelope.horizon.periods)throw Error('P2_COMPUTE_HORIZON_EXPIRED_OR_NOT_STARTED');
 const quantities=envelope.quantities.slice(0,period+1);
 if(quantities.some(n=>!/^\d+$/.test(n)))throw Error('P2_INTEGER_NATIVE_ATTEMPT_ENVELOPE_REQUIRED');
 const capacity=quantities.reduce((s,n)=>s+Number(n),0);if(!Number.isSafeInteger(capacity)||capacity<1)throw Error('P2_COMPUTE_ENVELOPE_EMPTY');
 const deliberationConversion=r.deliberation?deriveEnterpriseDeliberationConversion(policy):null;
 return {policyRequest:policy.ref,computeGrant:issued.certificate.ref,mandateRef:policy.mandateRef,utilityRef:policy.mandate.utilityRef,deliberationConversion,
  loss:{unit:policy.mandate.utility.unit,horizon:policy.mandate.horizon,risk:policy.mandate.risk,discountFactors:policy.mandate.utility.discountFactors,tail:policy.mandate.utility.tail,marginalLossConversion:null,delayLossConversion:null,qualification:'S4_OWNED_UTILITY_MARGINAL_COMPUTE_CONVERSION_UNAVAILABLE'},
  resourceId:resource.resourceId,resourceRef:resource.ref,reservationRef:issued.reservation.ref,capacity,
  validUntil:issued.certificate.validUntil,resourceEnvelope:envelope,rightsRef:policy.bindings.rightsRef,
  billing:null,protectedReceipt:null,qualification:'AUTHENTIC_ORDINARY_NATIVE_COMPUTE_ENVELOPE_NO_DOLLAR_OR_TOKEN_CONVERSION'};
}

/** Current reads re-use only immutable owner preimages. S5's validator itself
 * reads and independently verifies the issued certificate and entire current
 * portfolio; this removes a duplicate certificate solve, not a currentness check. */
export async function recheckSearchOwners(ctx:PeMutationContext,q:ProgramRow,s:any){
 if(stable(q.request.ownerBindings?.policyRef)!==stable(s.request.policyRequest)||stable(q.request.ownerBindings?.allocationRef)!==stable(s.request.computeGrant))throw Error('P2_EXACT_P1_OWNER_BINDINGS_REQUIRED');
 const policy=await readEnterpriseContingentPolicy(ctx,s.request.policyRequest);
 if(s.request.deliberation&&stable(deriveEnterpriseDeliberationConversion(policy))!==stable(s.binding.deliberationConversion))throw Error('M2_S4_UTILITY_CONVERSION_CHANGED');
 if(stable(policy.mandateRef)!==stable(s.binding.mandateRef)||stable(policy.mandate.utilityRef)!==stable(s.binding.utilityRef)||policy.bindings.rightsRef!==s.binding.rightsRef)throw Error('P2_OWNER_MANDATE_OR_RIGHTS_CHANGED');
 const state=await validateEnterpriseAllocation(ctx,s.request.computeGrant);if(state.status!=='CURRENT'||stable(state.reservationRef)!==stable(s.binding.reservationRef)||Date.now()>=Date.parse(s.binding.validUntil))throw Error('P2_S5_CURRENTNESS_UNPASSED');
 const horizon=s.binding.resourceEnvelope.horizon,period=Math.floor((Date.now()-Date.parse(horizon.startAt))/horizon.periodMs);
 if(period<0||period>=horizon.periods||s.binding.resourceEnvelope.quantities.slice(0,period+1).reduce((n:number,v:string)=>n+Number(v),0)!==s.binding.capacity)throw Error('P2_ORIGINAL_COMPUTE_HORIZON_CHANGED');
}
