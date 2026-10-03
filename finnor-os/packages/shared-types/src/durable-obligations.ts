import type { BusinessEffectRef, BusinessEffectSet } from './business-effects';
import type { ExperimentRef } from './experiments';
import type { InterventionSpecification } from './interventions';
import type { AllocationEnvelope } from './allocation';
import type { BeliefViewPin } from './enterprise-beliefs';
/** One canonical responsibility, joining existing effect and resource owners.
 * Ordinary preparation never supplies protected admission or dispatch authority. */
export interface DurableObligation {
 schema:'finnor.durable-obligation.v1';semanticOwner:'S6';ref:ExperimentRef;
 tenantId:string;principalId:string;episodeId:string;preparedAt:string;
 preparationRef:ExperimentRef;mandateRef:ExperimentRef;rightsRef:string;
 policyRef:ExperimentRef;decisionRef:ExperimentRef;nodeId:string;demandDigest:string;
 allocationRef:ExperimentRef;reservationRef:ExperimentRef;consumptionRef:ExperimentRef;
 effectRef:BusinessEffectRef;domainActionId:string;interventionRef:ExperimentRef;
 intervention:InterventionSpecification;resourceEnvelope:AllocationEnvelope[];
 preconditions:{beliefPins:BeliefViewPin[];reservationRevision:number;allocationValidUntil:string;policyValidUntil:string;interventionDigest:string};
 deadline:{businessStartAt:string;businessPeriodEndAt:string;authorityExpiresAt:string};
 method:{status:'UNADMITTED';requestIRVersion:'s6-intervention-intent-v1';providerBinding:null;admissionReceipt:null};
 settlement:{kind:'INDEPENDENT_EXACT_TARGET_CHANNEL_DOSE_OBSERVATION';memberCount:number;providerAcknowledgmentSufficient:false;executorSuccessSufficient:false};
 responsibility:{unknownOutcome:'RECONCILE_BEFORE_RETRY';cancellation:'RETAIN_POSSIBLE_EFFECTS_AND_S5_LIABILITIES';resourceReleaseOwner:'S5'};
 executionAuthorityGranted:false;protectedReceipt:null;status:'PREPARED_UNADMITTED';
}
export interface DurableObligationReadback {obligation:DurableObligation;effect:BusinessEffectSet;actionStatus:string;effectStatus:string;qualification:'ORDINARY_OWNER_BINDING_NOT_PROTECTED_SETTLEMENT'}

/** Concrete adapter proposals preserve meaning and confer no execution authority. */
export interface GovernedRequestBinding {
 exposureId:string;methodRef:ExperimentRef;providerOrigin:string;applicationAccountId:string;
 recordKey:string;field:string;expectedVersion:string;
}
export interface GovernedRequestIR {
 schema:'finnor.s6.request-ir.v1';tenantId:string;principalId:string;episodeId:string;
 obligationRef:ExperimentRef;effectRef:BusinessEffectRef;mandateRef:ExperimentRef;rightsRef:string;
 policyRef:ExperimentRef;decisionRef:ExperimentRef;allocationRef:ExperimentRef;reservationRef:ExperimentRef;
 consumptionRef:ExperimentRef;interventionRef:ExperimentRef;intervention:InterventionSpecification;
 preconditions:DurableObligation['preconditions'];deadline:DurableObligation['deadline'];resourceEnvelope:AllocationEnvelope[];
 compiler:{version:'s6-conditional-json-v1';sourceDigests:Array<{path:string;sha256:string}>};
 members:Array<{memberId:string;methodRef:ExperimentRef;
  semantic:{exposureId:string;target:InterventionSpecification['channels'][number]['target'];operation:InterventionSpecification['channels'][number]['operation'];unit:string;dose:number;intendedExposure:'REGISTERED_DOSE';permittedRefinements:[]};
  request:{kind:'CONDITIONAL_JSON_FIELDS_REPLACE';providerOrigin:string;applicationAccountId:string;recordKey:string;expectedVersion:string;changes:Record<string,number>}}>
}
