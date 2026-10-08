import { withTenantTransaction } from '@finnor/db';
import type { AllocationClearingInput, AllocationClearingResult, AllocationCertificate, AllocationConsumption, AllocationResource, AllocationOutstandingCommitment, CanonicalAllocationProblem, ContingentPolicy, ControlDecisionInput, DurableObligation, ExperimentRef, ResolvedPolicyAllocation, S5ExperienceEvent } from '@finnor/shared-types';
import { assertAllocationProblem, allocationRef, ALLOCATION_ADMISSION, AllocationContractError, parseAllocationResource, parseJointAllocationModel, prepareS5Experience, sameAllocationRef, S5_VERSION } from '../../epistemic-runtime/src/allocation-contracts';
import { verifyCanonicalAllocation } from '../../epistemic-runtime/src/allocation-checker';
import { certifyAllocationOptimizationAsync, verifyAllocationCertificateAsync } from '../../epistemic-runtime/src/allocation-verifier';
import { allocationSourcesCurrent, produceAllocationCandidate } from '../../epistemic-runtime/src/allocation-producer';
import { parseEconomicMandate, immutableControl, parseControlDecision } from '../../epistemic-runtime/src/control-contracts';
import { epistemicHash } from '../../epistemic-runtime/src/source-precedence';
import { ExperimentRefSchema } from '../../epistemic-runtime/src/experiments';
import { readEnterpriseContingentPolicy, chooseEnterpriseControlBranch } from './enterprise-control';
import { validateBeliefViewPin } from './enterprise-beliefs';
import { readAllocationSnapshot, putAllocationResource, persistAllocationProposal, readStoredAllocation, readAllocationReplay, commitAllocationReservation, readAllocationConsumptions, recordAllocationConsumption, releaseUntouchedAllocation, retainAllocationReconciliation, persistAllocationExperience,applyProtectedAllocationSettlement,retainProtectedAllocationAttempt } from './allocation-store';
import {readOwnerTransportEvent} from '../../governed-execution/src/owner-transport';
import type { PeMutationContext } from './types';
import {recheckAllocationCapability} from '../../capability-evolution/src/consumer';
import type {CapabilityUseLease} from '../../capability-evolution/src/lifecycle';

const actor=(ctx:PeMutationContext)=>ctx.auth.employeeId??ctx.auth.userId;
const denied=()=>new AllocationContractError('PERMITTED_CONTEXT_UNAVAILABLE','Permitted S5 context is unavailable');
/** Bound independent owner reads without skipping their current rights/source
 * checks. Await the whole batch on refusal so no detached read outlives clearing. */
async function readCurrentPolicies(ctx:PeMutationContext,refs:ExperimentRef[]):Promise<ContingentPolicy[]>{
 const policies:ContingentPolicy[]=[];
 for(let start=0;start<refs.length;start+=4){const batch=await Promise.allSettled(refs.slice(start,start+4).map(ref=>readEnterpriseContingentPolicy(ctx,ref)));const failure=batch.find(r=>r.status==='rejected');if(failure?.status==='rejected')throw failure.reason;for(const read of batch)if(read.status==='fulfilled')policies.push(read.value);}
 return policies;
}
function rebuilt(problem:CanonicalAllocationProblem,resources:AllocationResource[],outstanding:AllocationOutstandingCommitment[],knowledgeAt=problem.knowledgeAt):CanonicalAllocationProblem {
  const {ref,...body}=problem,updated={...body,resources,outstanding,knowledgeAt,snapshotDigest:epistemicHash({resources,outstanding})};return {...updated,ref:allocationRef('S5','allocation-problem',updated)};
}
async function currentPins(ctx:PeMutationContext,resources:AllocationResource[]):Promise<void>{
  for(const resource of resources){if(resource.tenantId!==ctx.auth.tenantId||resource.ownerRef.id!==actor(ctx))throw denied();
    for(const pin of resource.beliefPins)if(pin.tenantId!==ctx.auth.tenantId||pin.principalId!==actor(ctx)||(await validateBeliefViewPin(ctx,pin)).status!=='CURRENT')throw new AllocationContractError('STALE_INPUT','Resource source or rights witness is no longer current');}
}
export async function registerEnterpriseAllocationResource(ctx:PeMutationContext,input:{resource:unknown;expectedRef?:ExperimentRef|null}){
  const resource=parseAllocationResource(input.resource);if(resource.tenantId!==ctx.auth.tenantId||resource.ownerRef.id!==actor(ctx)||Date.parse(resource.knowledgeAt)>Date.now())throw denied();await currentPins(ctx,[resource as AllocationResource]);
  return putAllocationResource(ctx,resource,input.expectedRef??null);
}
export const listEnterpriseAllocationResources=(ctx:PeMutationContext)=>readAllocationSnapshot(ctx);
async function unaccountedNativeEffects(ctx:PeMutationContext):Promise<number>{
  return withTenantTransaction(ctx.auth.tenantId,{userId:actor(ctx),readOnly:true},async(_db,c)=>{
    const rows=await c.query("SELECT count(*)::int AS n FROM finnor_os.business_effects WHERE tenant_id=$1 AND status NOT IN ('verified','cancelled','compensated')",[ctx.auth.tenantId]);return rows.rows[0].n;
  });
}
export async function clearEnterprisePortfolio(ctx:PeMutationContext,input:AllocationClearingInput):Promise<AllocationClearingResult>{
  const started=performance.now(),m=parseEconomicMandate(input.mandate),joint=parseJointAllocationModel(input.jointModel);
  if(ctx.auth.role!=='owner'||m.tenantId!==ctx.auth.tenantId||m.principalId!==actor(ctx)||m.businessOwnerRef.id!==actor(ctx))throw denied();
  const requestDigest=epistemicHash(input),previous=await readAllocationReplay(ctx,input.idempotencyKey,requestDigest);
  if(previous?.reservation)return immutableControl({schema:'finnor.s5.clearing-result.v1',status:'FEASIBLE',reasons:['DURABLE_SEMANTIC_REPLAY_CURRENT_CLEARANCE_REQUIRES_VALIDATE'],certificate:previous.certificate,reservation:previous.reservation,experience:[],compute:previous.certificate.compute,executionAuthorityGranted:false,protectedReceipt:null});
  const experience:S5ExperienceEvent[]=[prepareS5Experience(m,'REQUEST',`allocation-request:${requestDigest}`,{input,requestDigest})];await persistAllocationExperience(ctx,experience);
  let candidatePersisted=false;
  const decisionUsage=()=>({elapsedMs:performance.now()-started,deadlineMs:m.search.deadlineMs,scope:'WHOLE_S5_OWNER_INCLUDING_RESOLUTION_CONTENTION_COMMIT' as const});
  const failure=async(status:AllocationClearingResult['status'],reasons:string[],compute:AllocationClearingResult['compute']=null)=>{
    const event=prepareS5Experience(m,'REFUSAL',`allocation-request:${requestDigest}`,{status,reasons,compute});experience.push(event);if(compute&&!candidatePersisted)experience.push(prepareS5Experience(m,'COST',compute.id,{compute}));await persistAllocationExperience(ctx,experience.slice(1));
    return immutableControl({schema:'finnor.s5.clearing-result.v1' as const,status,reasons,certificate:null,reservation:null,experience,compute,decisionUsage:decisionUsage(),executionAuthorityGranted:false as const,protectedReceipt:null});
  };
  if(Date.now()>=Date.parse(m.validUntil)||Date.now()<Date.parse(m.knowledgeAt))return failure('STALE_INPUT',['MANDATE_KNOWLEDGE_OR_VALIDITY_CHANGED']);
  if(await unaccountedNativeEffects(ctx))return failure('UNCERTAINTY_UNRESOLVED',['NATIVE_UNRECONCILED_EFFECTS_REQUIRE_S6_QUALIFIED_RESOURCE_ACCOUNTING']);
  const snapshot=await readAllocationSnapshot(ctx);await currentPins(ctx,snapshot.resources);
  if(input.resourceRefs.length!==snapshot.resources.length||input.resourceRefs.some(ref=>!snapshot.resources.some(r=>sameAllocationRef(r.ref,ref))))return failure('STALE_INPUT',['CURRENT_COMPLETE_RESOURCE_REGISTRY_REQUIRED']);
  const policies=await readCurrentPolicies(ctx,input.policyRefs);
  const now=new Date().toISOString(),validUntil=new Date(Math.min(Date.parse(m.validUntil),Date.parse(joint.validUntil),...policies.map(p=>Date.parse(p.validUntil)),...snapshot.resources.map(r=>Date.parse(r.validUntil)))).toISOString();
  const body:Omit<CanonicalAllocationProblem,'ref'>={schema:'finnor.allocation-problem.v1',tenantId:ctx.auth.tenantId,principalId:actor(ctx),episodeId:m.episodeId,mandate:m,policies,resources:snapshot.resources,jointModel:joint,demandBindings:input.demandBindings,funding:input.funding,outstanding:snapshot.outstanding,snapshotDigest:snapshot.snapshotDigest,knowledgeAt:now,validUntil,methodVersion:S5_VERSION};
  const problem:CanonicalAllocationProblem={...body,ref:allocationRef('S5','allocation-problem',body)};assertAllocationProblem(problem);
  if(snapshot.resources.some(r=>r.revoked||r.availability.some(a=>a.amount===null||a.basis!=='REPORTED_AVAILABLE')))return failure('UNCERTAINTY_UNRESOLVED',['RESOURCE_RIGHTS_OR_AVAILABILITY_UNRESOLVED']);
  // Existing obligations must be feasible in their own right. An empty selected
  // portfolio never conceals a resource/covenant breach requiring owner recovery.
  const empty=verifyCanonicalAllocation(problem,[]);
  if(empty.reasons.some(reason=>/RESOURCE_LIMIT|COVENANT_LIMIT|OUTSTANDING_COMMITMENT|RESOURCE_KNOWLEDGE/.test(reason)))return failure('INFEASIBLE',['EXISTING_OBLIGATIONS_ALREADY_VIOLATE_CANONICAL_LIMITS',...empty.reasons]);
  const deadlineAt=started+m.search.deadlineMs,produced=await produceAllocationCandidate(problem,deadlineAt);
  if(produced.selectedPolicyIds===null)return failure(produced.status,produced.reasons,produced.compute);
  let checked;try{checked=await certifyAllocationOptimizationAsync(problem,produced.selectedPolicyIds,{deadlineAt,searchTermination:produced.compute.usage.backend.termination as string??produced.status,solverUpperBoundEstimate:produced.solverUpperBoundEstimate,dualProposal:produced.dualProposal});}
  catch(e){if(e instanceof AllocationContractError&&e.code==='INVALID_CANDIDATE')return failure('INVALID_CANDIDATE',[e.message,'CANONICAL_EXACT_CHECK_REJECTED_NUMERICAL_PRODUCER'],produced.compute);if(e instanceof AllocationContractError&&e.code==='LIMIT_EXCEEDED')return failure('SEARCH_EXHAUSTED',[e.message],produced.compute);throw e;}
  const selected=new Set(checked.check.selectedPolicyIds);
  const certificateBody:Omit<AllocationCertificate,'ref'>={schema:'finnor.allocation-certificate.v1',semanticOwner:'S5',version:S5_VERSION,tenantId:ctx.auth.tenantId,principalId:actor(ctx),episodeId:m.episodeId,mandateRef:m.ref,rightsRef:m.rightsRef,
    policyBindings:policies.filter(policy=>selected.has(policy.ref.id)).map(policy=>({policyRef:policy.ref,demandDigest:policy.demand.contentDigest})),jointModelRef:joint.ref,resourceRefs:snapshot.resources.map(r=>r.ref),obligationsDigest:epistemicHash({outstanding:problem.outstanding,existingUse:problem.resources.map(r=>({resourceRef:r.ref,existingUse:r.existingUse})),policyObligations:problem.policies.map(p=>p.problem.obligations)}),snapshotDigest:problem.snapshotDigest,problemRef:problem.ref,validFrom:now,validUntil,check:checked.check,optimization:checked.optimization,compute:produced.compute,status:'PROPOSED_CHECKED',qualification:'MODEL_RELATIVE_FINITE_JOINT_PATHS_ORDINARY_RESERVATION',admission:ALLOCATION_ADMISSION};
  const certificate:AllocationCertificate={...certificateBody,ref:allocationRef('S5','allocation-certificate',certificateBody)};
  // Complete all scientific/source owner readbacks before the short SQL commit.
  // S6 must recheck these once more at consequential egress; no authority grant.
  await readCurrentPolicies(ctx,policies.map(policy=>policy.ref));await currentPins(ctx,snapshot.resources);
  if(!await allocationSourcesCurrent(produced.compute.backend.sourceDigests))return failure('STALE_INPUT',['S5_LOADED_METHOD_CHANGED_BEFORE_COMMIT'],produced.compute);
  const capability=produced.compute.usage.backend.capabilityLease as CapabilityUseLease|undefined;
  if(capability&&capability.mode!=='SHADOW')try{await recheckAllocationCapability(problem,capability);}catch(error){return failure('STALE_INPUT',[error instanceof Error?error.message:'S8_CAPABILITY_RECHECK_FAILED'],produced.compute);}
  if(performance.now()>=deadlineAt)return failure('SEARCH_EXHAUSTED',['WHOLE_OWNER_DECISION_BUDGET_EXHAUSTED_BEFORE_COMMIT'],produced.compute);
  await persistAllocationProposal(ctx,problem,certificate);candidatePersisted=true;
  try{const reservation=await commitAllocationReservation(ctx,problem,certificate,input.idempotencyKey,requestDigest,async(resources,outstanding)=>verifyCanonicalAllocation(rebuilt(problem,resources,outstanding),checked.check.selectedPolicyIds),deadlineAt);

    return immutableControl({schema:'finnor.s5.clearing-result.v1',status:'FEASIBLE',reasons:produced.status==='SEARCH_EXHAUSTED'?['CHECKED_INCUMBENT_WITH_SUPPORTED_REMAINING_GAP']:[],certificate,reservation,experience,compute:produced.compute,decisionUsage:decisionUsage(),executionAuthorityGranted:false,protectedReceipt:null});
  }catch(e){if(e instanceof AllocationContractError&&e.code==='LIMIT_EXCEEDED')return failure('SEARCH_EXHAUSTED',[e.message],produced.compute);if(e instanceof AllocationContractError&&e.code==='STALE_INPUT')return failure('STALE_INPUT',[e.message,'RECLEAR_CURRENT_REVISIONS_WITHIN_OWNER_BUDGET'],produced.compute);throw e;}
}
export async function readEnterpriseAllocation(ctx:PeMutationContext,value:unknown){
  const ref=ExperimentRefSchema.parse(value),issued=await readStoredAllocation(ctx,ref);await verifyAllocationCertificateAsync(issued.problem,issued.certificate);
  return immutableControl({...issued,consumptions:await readAllocationConsumptions(ctx,ref),executionAuthorityGranted:false,protectedReceipt:null});
}
/** Read S5's original qualified settlement and its independently protected S6
 * counterpart. No current action lease, new settlement or release is granted. */
export async function readEnterpriseAllocationSettlement(ctx:PeMutationContext,input:{allocationRef:ExperimentRef;consumptionRef:ExperimentRef;settlementEventId:string}){
 const issued=await readEnterpriseAllocation(ctx,input.allocationRef),use=issued.consumptions.find(u=>sameAllocationRef(u.ref,input.consumptionRef));
 if(!issued.reservation||!use||use.status!=='RECONCILED'||!use.effectRef)throw denied();
 const rows=await withTenantTransaction(ctx.auth.tenantId,{userId:actor(ctx),readOnly:true},async(_db,c)=>(await c.query("SELECT body FROM finnor_os.s5_history WHERE tenant_id=$1 AND subject_id=$2 AND operation='PROTECTED_S6_SETTLEMENT' ORDER BY revision DESC LIMIT 2",[ctx.auth.tenantId,use.ref.id])).rows);
 if(rows.length!==1)throw denied();
 const proof=rows[0].body,event=await readOwnerTransportEvent({semanticOwner:'S5',tenantId:ctx.auth.tenantId,principalId:actor(ctx)},input.settlementEventId),d=event.event.detail;
 if(!sameAllocationRef(proof.costs,{status:'UNMETERED',externalCost:null,recoveryCost:null,humanCost:null,releaseSufficient:false})||proof.event?.eventId!==input.settlementEventId||!sameAllocationRef(proof.event,event.event)||!sameAllocationRef(proof.receipt,event.receipt)||proof.resourceEnvelopeRetained!==true
  ||event.receipt.protectedExecution!==true||event.receipt.semanticOwner!=='S6'||event.event.type!=='VERIFICATION'||d?.status!=='VERIFIED'
  ||!sameAllocationRef(d.allocationRef,input.allocationRef)||!sameAllocationRef(d.consumptionRef,use.ref)||!sameAllocationRef(d.reservationRef,issued.reservation.ref)
  ||d.effectRef?.id!==use.effectRef.id||d.effectRef?.semanticHash!==use.effectRef.contentDigest||!sameAllocationRef(proof.obligationRef,d.obligationRef))throw denied();
 return immutableControl({allocationRef:input.allocationRef,consumption:use,reservation:issued.reservation,obligationRef:proof.obligationRef,event:event.event,receipt:event.receipt,costs:proof.costs,
  resourceEnvelopeRetained:true,releaseGranted:false,executionAuthorityGranted:false,qualification:'NATIVE_S5_SETTLEMENT_AND_MATCHED_PROTECTED_S6_READBACK_NO_COST_OR_RELEASE_AUTHORITY'});
}
async function validateAllocationState(ctx:PeMutationContext,value:unknown){
  const ref=ExperimentRefSchema.parse(value),issued=await readEnterpriseAllocation(ctx,ref),reasons:string[]=[];
  if(!issued.reservation||issued.reservation.status==='RELEASED')reasons.push('DURABLE_RESERVATION_REQUIRED');
  if(issued.reservation?.revocationReason)reasons.push(issued.reservation.revocationReason);
  if(Date.now()>=Date.parse(issued.certificate.validUntil))reasons.push('CERTIFICATE_EXPIRED_ACCOUNTABLE_EXPOSURE_RETAINED');
  if(!await allocationSourcesCurrent(issued.certificate.compute.backend.sourceDigests))reasons.push('S5_LOADED_METHOD_CHANGED');
  const capability=issued.certificate.compute.usage.backend.capabilityLease as CapabilityUseLease|undefined;
  if(capability&&capability.mode!=='SHADOW')try{await recheckAllocationCapability(issued.problem,capability);}catch{reasons.push('S8_CAPABILITY_REVOKED_OR_CHANGED_ACCOUNTABLE_EXPOSURE_RETAINED');}
  const current=await readAllocationSnapshot(ctx);if(!sameAllocationRef(current.resources,issued.problem.resources))reasons.push('RESOURCE_REVISION_OR_RIGHTS_CHANGED');
  for(const policy of issued.problem.policies)try{await readEnterpriseContingentPolicy(ctx,policy.ref);}catch{reasons.push('POLICY_MODEL_SOURCE_OR_RIGHTS_CHANGED');}
  try{await currentPins(ctx,current.resources);const other=current.outstanding.filter(o=>!sameAllocationRef(o.reservationRef,issued.reservation?.ref)),check=verifyCanonicalAllocation(rebuilt(issued.problem,current.resources,other,new Date().toISOString()),issued.certificate.check.selectedPolicyIds);
    if(!check.feasible||!sameAllocationRef(check.envelopes,issued.certificate.check.envelopes))reasons.push(...check.reasons.length?check.reasons:['CURRENT_RESERVED_ENVELOPE_CHANGED']);}
  catch(e){reasons.push(e instanceof Error?e.message:'CURRENT_RESOURCE_CHECK_UNAVAILABLE');}
  if(reasons.length)await persistAllocationExperience(ctx,[prepareS5Experience(issued.problem.mandate,'INVALIDATION',ref.id,{reasons,reservationRef:issued.reservation?.ref??null,exposureRetained:true},[ref.id])]);
  const validation=immutableControl({status:reasons.length?'STALE_INPUT' as const:'CURRENT' as const,reasons,allocationRef:ref,reservationRef:issued.reservation?.ref??null,conditionalClearance:!reasons.length,executionAuthorityGranted:false as const,protectedReceipt:null});
  return {issued,validation};
}
export async function validateEnterpriseAllocation(ctx:PeMutationContext,value:unknown){
  return (await validateAllocationState(ctx,value)).validation;
}
export async function resolveEnterprisePolicyAllocation(ctx:PeMutationContext,value:unknown,policy:ContingentPolicy,knowledgeAt:string):Promise<ResolvedPolicyAllocation|null>{
  if(!value)return null;const ref=ExperimentRefSchema.parse(value);
  if(ref.owner!=='S5'||ref.version!==S5_VERSION||ref.id!==`allocation-certificate:${ref.contentDigest}`)return null;
  let state;try{state=await validateAllocationState(ctx,ref);}catch(error){if(error instanceof AllocationContractError&&['PERMITTED_CONTEXT_UNAVAILABLE','STALE_INPUT'].includes(error.code))return null;throw error;}
  const {issued,validation}=state;
  if(validation.status!=='CURRENT'||Date.parse(knowledgeAt)<Date.parse(issued.certificate.validFrom)||Date.parse(knowledgeAt)>Date.now()+1000||!issued.certificate.policyBindings.some(p=>sameAllocationRef(p.policyRef,policy.ref)&&p.demandDigest===policy.demand.contentDigest)||!sameAllocationRef(issued.certificate.mandateRef,policy.mandateRef)||issued.certificate.rightsRef!==policy.bindings.rightsRef)return null;
  return immutableControl({owner:'S5',ref,policyRef:policy.ref,mandateRef:policy.mandateRef,demandDigest:policy.demand.contentDigest,rightsRef:policy.bindings.rightsRef,validUntil:issued.certificate.validUntil,revoked:false});
}
export async function consumeEnterpriseAllocation(ctx:PeMutationContext,input:{allocationRef:ExperimentRef;policyRef:ExperimentRef;decision?:unknown;measurements?:Array<{protocol?:unknown;events:unknown[]}>;idempotencyKey:string}){
  const issued=await readEnterpriseAllocation(ctx,input.allocationRef),requestDigest=epistemicHash(input),previous=issued.consumptions.find(c=>c.idempotencyKey===input.idempotencyKey);
  if(previous){if(previous.requestDigest!==requestDigest)throw new AllocationContractError('IDEMPOTENCY_CONFLICT','S5 consumption retry changed semantic payload');return immutableControl({consumption:previous,choice:null,semanticReplay:true,executionAuthorityGranted:false,protectedReceipt:null});}
  const policy=await readEnterpriseContingentPolicy(ctx,input.policyRef),decision=parseControlDecision(input.decision);
  if(!issued.reservation||!await resolveEnterprisePolicyAllocation(ctx,input.allocationRef,policy,decision.knowledgeAt))throw new AllocationContractError('STALE_INPUT','Current owner-resolved allocation required before consumption');
  const choice=await chooseEnterpriseControlBranch(ctx,{...input,allocationRef:input.allocationRef});if(choice.status!=='POLICY_AVAILABLE'||!choice.nodeId)throw new AllocationContractError('INVALID_CANDIDATE',`S4 lawful branch required:${choice.status}:${choice.reasons.join(',')}`);
  const compatible=issued.problem.jointModel.scenarios.filter(s=>s.policyPaths.find(p=>sameAllocationRef(p.policyRef,policy.ref))?.nodeIds.includes(choice.nodeId!)).map(s=>s.id);
  const body:Omit<AllocationConsumption,'ref'>={schema:'finnor.allocation-consumption.v1',reservationRef:issued.reservation.ref,certificateRef:input.allocationRef,policyRef:policy.ref,demandDigest:policy.demand.contentDigest,nodeId:choice.nodeId,decisionRef:choice.ref,idempotencyKey:input.idempotencyKey,requestDigest,createdAt:new Date().toISOString(),status:'INTENDED_PENDING_S6',compatibleScenarioIds:compatible,effectRef:null,envelope:issued.certificate.check.envelopes,executionAuthorityGranted:false,protectedReceipt:null};
  const consumption=await recordAllocationConsumption(ctx,issued.reservation.ref,body,compatible,async(resources,outstanding)=>verifyCanonicalAllocation(rebuilt(issued.problem,resources,outstanding.filter(o=>!sameAllocationRef(o.reservationRef,issued.reservation!.ref)),new Date().toISOString()),issued.certificate.check.selectedPolicyIds));
return immutableControl({consumption,choice,executionAuthorityGranted:false,protectedReceipt:null});
}
export async function releaseEnterpriseAllocation(ctx:PeMutationContext,input:{allocationRef:ExperimentRef;idempotencyKey:string}){
  const issued=await readEnterpriseAllocation(ctx,input.allocationRef),reservation=await releaseUntouchedAllocation(ctx,input.allocationRef,input.idempotencyKey);
return immutableControl({reservation,executionAuthorityGranted:false,protectedReceipt:null});
}
export async function reconcileEnterpriseAllocation(ctx:PeMutationContext,input:{allocationRef:ExperimentRef}){
  const issued=await readEnterpriseAllocation(ctx,input.allocationRef);if(!issued.reservation)throw denied();
  // Native records can expose outstanding attempts/acknowledgements. None is
  // reclassified as a protected allocation-bound actual-consumption receipt.
  const native=await withTenantTransaction(ctx.auth.tenantId,{userId:actor(ctx),readOnly:true},async(_db,c)=>{
    const rows=await c.query("SELECT id,semantic_hash,status,verification,observed_at,authorized_at FROM finnor_os.business_effects WHERE tenant_id=$1 AND status NOT IN ('verified','cancelled','compensated') ORDER BY created_at DESC LIMIT 257",[ctx.auth.tenantId]);if(rows.rows.length>256)throw new AllocationContractError('LIMIT_EXCEEDED','Native reconciliation readback bound exceeded');return rows.rows;});
  const observed=JSON.parse(JSON.stringify(native));
  const reservation=await retainAllocationReconciliation(ctx,input.allocationRef,issued.reservation.revision,{observed,consumptions:issued.consumptions,protectedS6AllocationBinding:'UNAVAILABLE'});
  const result={status:issued.consumptions.length?'UNKNOWN_OUTCOME_RETAINED':'NO_HANDOFF_RECORDED',reservation,observedNativeEffects:observed,qualifiedActualConsumption:null,qualifiedSettlement:null,requiredOwner:'S6',executionAuthorityGranted:false as const,protectedReceipt:null};
return immutableControl(result);
}
export async function recordEnterpriseAllocationAssessment(ctx:PeMutationContext,input:{allocationRef:ExperimentRef;reason:string;humanSeconds:number;evidenceRefs:ExperimentRef[]}){
  const issued=await readEnterpriseAllocation(ctx,input.allocationRef);if(input.humanSeconds>issued.problem.mandate.search.maxHumanSeconds)throw new AllocationContractError('LIMIT_EXCEEDED','Human review demand exceeds authorized envelope');
  const event=prepareS5Experience(issued.problem.mandate,'OVERRIDE',input.allocationRef.id,{...input,applied:false,requiresBusinessOwnerRevisionAndReclearing:true},[input.allocationRef.id]);await persistAllocationExperience(ctx,[event]);return {event,applied:false,executionAuthorityGranted:false,protectedReceipt:null};
}

/** S5 independently resolves native joins and protected intent/observations. An
 * executor callback or receipt-shaped request body cannot reconcile consumption. */
export async function settleEnterpriseAllocation(ctx:PeMutationContext,input:{allocationRef:ExperimentRef;consumptionRef:ExperimentRef;settlementEventId:string}){
 const issued=await readEnterpriseAllocation(ctx,input.allocationRef),use=issued.consumptions.find(u=>sameAllocationRef(u.ref,input.consumptionRef));if(!use?.effectRef||!issued.reservation)throw denied();
 const scope={semanticOwner:'S5',tenantId:ctx.auth.tenantId,principalId:actor(ctx)},settlement=await readOwnerTransportEvent(scope,input.settlementEventId),detail=settlement.event.detail;
 const protectedEvent=(row:typeof settlement,type:string)=>{if(row.receipt.protectedExecution!==true||row.receipt.semanticOwner!=='S6'||row.event.type!==type||row.event.detail?.schema!=='finnor.s6.protected-execution.v1')throw new AllocationContractError('BLOCKED_AUTHORITY','Protected execution evidence required');};
 protectedEvent(settlement,'VERIFICATION');
 if(detail.status!=='VERIFIED'||!sameAllocationRef(detail.allocationRef,input.allocationRef)||!sameAllocationRef(detail.consumptionRef,use.ref)||!sameAllocationRef(detail.reservationRef,issued.reservation.ref)||detail.effectRef?.id!==use.effectRef.id||detail.effectRef?.semanticHash!==use.effectRef.contentDigest||!Array.isArray(detail.observationEventIds)||detail.observationEventIds.length<1||detail.observationEventIds.length>64||new Set(detail.observationEventIds).size!==detail.observationEventIds.length)throw denied();
 const {readEnterpriseDurableObligation}=await import('./enterprise-obligations');const obligation=await readEnterpriseDurableObligation(ctx,detail.obligationRef);
 if(!sameAllocationRef(obligation.allocationRef,input.allocationRef)||!sameAllocationRef(obligation.consumptionRef,use.ref)||!sameAllocationRef(obligation.effectRef,detail.effectRef)||detail.memberCount!==obligation.intervention.channels.length||detail.observationEventIds.length!==detail.memberCount)throw denied();
 const intent=await readOwnerTransportEvent(scope,detail.intentEventId);protectedEvent(intent,'INTENT');
 if(!sameAllocationRef(intent.event.detail.obligationRef,obligation.ref)||!sameAllocationRef(intent.event.detail.requestRef,detail.requestRef)||intent.receipt.sequence>=settlement.receipt.sequence)throw denied();
 const request=intent.event.detail.request,ir=request?.ir;
 if(!ir||epistemicHash(ir)!==detail.requestRef.contentDigest||!sameAllocationRef(request.ref,detail.requestRef)||!sameAllocationRef(ir.obligationRef,obligation.ref)||!sameAllocationRef(ir.effectRef,obligation.effectRef)||!Array.isArray(ir.members)||ir.members.length!==detail.memberCount)throw denied();
 const seen=new Set<string>();
 for(const id of detail.observationEventIds){const observed=await readOwnerTransportEvent(scope,id);protectedEvent(observed,'OBSERVATION');const d=observed.event.detail,member=ir.members.find((m:any)=>m.memberId===d.memberId),channel=obligation.intervention.channels.find(c=>member?.semantic?.exposureId===c.exposureId),record=d.observed;
  if(!channel||!member||seen.has(member.memberId)||member.memberId!==`request-member:${epistemicHash([obligation.ref,channel.exposureId])}`||!sameAllocationRef(d.obligationRef,obligation.ref)||!sameAllocationRef(d.requestRef,detail.requestRef)||d.status!=='MATCHED'||d.operationId!==`effect-member:${epistemicHash([obligation.ref,request.ref,member.memberId])}`||observed.receipt.sequence<=intent.receipt.sequence||observed.receipt.sequence>=settlement.receipt.sequence||!record||record.applicationAccountId!==member.request.applicationAccountId||record.recordKey!==member.request.recordKey||record.lastOperationId!==d.operationId||record.version===member.request.expectedVersion||!sameAllocationRef(record.fields,member.request.changes)||Object.keys(member.request.changes).length!==1||Object.values(member.request.changes)[0]!==channel.doses[0]||!sameAllocationRef(member.semantic.target,channel.target)||member.semantic.operation!==channel.operation||member.semantic.unit!==channel.unit)throw denied();seen.add(member.memberId);
 }
 return applyProtectedAllocationSettlement(ctx,{...input,obligation,event:settlement.event,receipt:settlement.receipt});
}

/** S5 owns whether its retained-liability accounting revision preserves the
 * original envelope. This does not grant spending, release or effect authority. */
export async function assessEnterpriseAllocationContinuation(ctx:PeMutationContext,obligation:DurableObligation){
 const issued=await readEnterpriseAllocation(ctx,obligation.allocationRef),r=issued.reservation,use=issued.consumptions.find(u=>sameAllocationRef(u.ref,obligation.consumptionRef));
 if(!r||r.revocationReason||r.status!=='UNKNOWN_OUTCOME'||r.revision!==obligation.preconditions.reservationRevision+1||!use||use.status!=='UNKNOWN_OUTCOME'||!sameAllocationRef(r.ref,obligation.reservationRef)||!sameAllocationRef(use.envelope,obligation.resourceEnvelope)||use.effectRef?.id!==obligation.effectRef.id||use.effectRef?.contentDigest!==obligation.effectRef.semanticHash)throw denied();
 const rows=await withTenantTransaction(ctx.auth.tenantId,{userId:actor(ctx),readOnly:true},async(_db,c)=>(await c.query("SELECT body FROM finnor_os.s5_history WHERE tenant_id=$1 AND subject_id=$2 AND operation='PROTECTED_S6_ATTEMPT' ORDER BY revision LIMIT 64",[ctx.auth.tenantId,use.ref.id])).rows);
 const proof=rows.map(row=>row.body).find(p=>{
  const t=p.reservationTransition;
  return t?.schema==='finnor.s5.retained-attempt-transition.v1'&&sameAllocationRef(p.obligationRef,obligation.ref)&&sameAllocationRef(t.reservationRef,r.ref)&&t.before?.revision===obligation.preconditions.reservationRevision&&['RESERVED','CONSUMPTION_PENDING'].includes(t.before.status)&&t.after?.revision===r.revision&&t.after.status==='UNKNOWN_OUTCOME'&&sameAllocationRef(t.before.envelopes,t.after.envelopes)&&sameAllocationRef(t.after.envelopes,r.envelopes)&&sameAllocationRef(t.consumptionEnvelope,obligation.resourceEnvelope)&&p.resourceEnvelopeRetained===true&&p.qualifiedActualConsumption===null&&p.qualifiedSettlement===null;
 });
 if(!proof)throw denied();
 const accepted=await readOwnerTransportEvent({semanticOwner:'S5',tenantId:ctx.auth.tenantId,principalId:actor(ctx)},proof.event.eventId),d=accepted.event.detail;
 if(accepted.receipt.protectedExecution!==true||accepted.receipt.semanticOwner!=='S6'||accepted.event.type!=='ATTEMPT'||!sameAllocationRef(accepted.event,proof.event)||!sameAllocationRef(accepted.receipt,proof.receipt)||d?.schema!=='finnor.s6.protected-execution.v1'||!sameAllocationRef(d.obligationRef,obligation.ref)||!sameAllocationRef(d.allocationRef,obligation.allocationRef)||!sameAllocationRef(d.reservationRef,r.ref)||!sameAllocationRef(d.consumptionRef,use.ref)||!sameAllocationRef(d.effectRef,obligation.effectRef)||!sameAllocationRef(d.resourceEnvelope,obligation.resourceEnvelope)||!obligation.intervention.channels.some(c=>d.memberId===`request-member:${epistemicHash([obligation.ref,c.exposureId])}`))throw denied();
 return {reservationRevision:r.revision,attemptEventId:accepted.event.eventId,resourceEnvelopeRetained:true as const,releaseGranted:false as const};
}

/** Resolve possible delivery back to the actual protected ATTEMPT, retaining S5
 * liabilities through reordered notifications, owner/process death and read faults. */
export async function recordEnterpriseAllocationAttempt(ctx:PeMutationContext,input:{allocationRef:ExperimentRef;consumptionRef:ExperimentRef;executionEventId:string}){
 const issued=await readEnterpriseAllocation(ctx,input.allocationRef),use=issued.consumptions.find(u=>sameAllocationRef(u.ref,input.consumptionRef));if(!issued.reservation||!use?.effectRef)throw denied();
 const scope={semanticOwner:'S5',tenantId:ctx.auth.tenantId,principalId:actor(ctx)};let proof=await readOwnerTransportEvent(scope,input.executionEventId);
 const seen=new Set<string>();
 for(let hop=0;;hop++){
  const d=proof.event.detail;
  if(proof.receipt.protectedExecution!==true||proof.receipt.semanticOwner!=='S6'||d?.schema!=='finnor.s6.protected-execution.v1'||!sameAllocationRef(d.allocationRef,input.allocationRef)||!sameAllocationRef(d.consumptionRef,use.ref)||!sameAllocationRef(d.reservationRef,issued.reservation.ref)||d.effectRef?.id!==use.effectRef.id||d.effectRef?.semanticHash!==use.effectRef.contentDigest||seen.has(proof.event.eventId))throw denied();seen.add(proof.event.eventId);
  if(proof.event.type==='ATTEMPT')break;
  const operator=d.kind==='OPERATOR_TAKEOVER'&&d.status==='READ_ONLY_RESPONSIBILITY_TAKEN_OVER'&&d.automaticMutationRetry===false&&d.newMutationAuthorityGranted===false&&d.attemptFenceOrBudgetReset===false&&d.resourceReleaseGranted===false&&d.funding?.phase==='HUMAN'&&d.funding?.status==='RESERVED';
  const reconciliation=proof.event.type==='RECONCILIATION'&&(['CURRENT_AUTHORITY','OBSERVATION_ATTEMPT','OBSERVATION_BUDGET_EXHAUSTED'].includes(d.kind)||operator);
  if(hop>=255||!reconciliation&&!['ACKNOWLEDGMENT','OBSERVATION','VERIFICATION'].includes(proof.event.type)||!Array.isArray(proof.event.causalParents)||proof.event.causalParents.length!==1)throw new AllocationContractError('BLOCKED_AUTHORITY','No authenticated possible-egress attempt supports the notification');
  const parent=await readOwnerTransportEvent(scope,proof.event.causalParents[0]);if(parent.receipt.sequence>=proof.receipt.sequence)throw denied();proof=parent;
 }
 const {readEnterpriseDurableObligation}=await import('./enterprise-obligations'),obligation=await readEnterpriseDurableObligation(ctx,proof.event.detail.obligationRef);
 if(!sameAllocationRef(obligation.allocationRef,input.allocationRef)||!sameAllocationRef(obligation.consumptionRef,use.ref)||!sameAllocationRef(obligation.effectRef,proof.event.detail.effectRef)||!obligation.intervention.channels.some(c=>proof.event.detail.memberId===`request-member:${epistemicHash([obligation.ref,c.exposureId])}`))throw denied();
 return retainProtectedAllocationAttempt(ctx,{...input,obligation,event:proof.event,receipt:proof.receipt});
}
