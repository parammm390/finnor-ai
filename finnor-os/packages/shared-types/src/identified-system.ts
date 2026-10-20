import type {VReference} from './primary-diligence';

export type IdentificationClaimClass = 'PREDICTIVE' | 'INTERVENTION_IDENTIFIED' | 'MECHANISM_SPECIFIC';
export type IdentificationUnknown = {kind:'UNKNOWN';reason:string};
export interface DigitalRecordTemplate {
 value:string;
 update:'PREEXISTING'|'CONTROLLED';
 visibility:'PUBLIC'|'CONTROLLED';
 features:{cohort?:number;flag?:number};
}
export interface DigitalCondition {
 id:string;
 updateTiming:-1|1|3;
 pageSize:1|2|4;
 visibility:0|1;
 costUnits:number;
 risk:number;
 exposure:number;
}
export interface DigitalIdentificationDomain {
 schema:'finnor.x4.digital-domain.v1';
 profile:'PE_FIRM_DIGITAL_RELATION_V1';
 applicationVersion:string;
 role:'analyst'|'auditor';
 records:DigitalRecordTemplate[];
 interventions:{updateTiming:Array<-1|1|3>;pageSize:Array<1|2|4>;visibility:Array<0|1>};
 ordinary:{updateTiming:-1|1|3;pageSize:1|2|4;visibility:0|1};
 withheld:{updateTiming:-1|1|3;pageSize:1|2|4;visibility:0|1};
 costUnits:number;
 assumptions:{
  deterministic:true;isolatedFreshRecords:true;noInterference:true;
  completePermittedObservations:true;sameHostClock:true;replicaVersionInvariant:true;
 };
}
export interface DigitalTrial {
 id:string;instanceId:string;applicationVersion:string;role:'analyst'|'auditor';
 controls:{updateTiming:-1|1|3;pageSize:1|2|4};
 records:Array<{id:string;features:Record<string,number>;value:string}>;
}
export type DigitalAtom =
 | {op:'TRUE'|'FALSE'}
 | {op:'EQ'|'LT'|'LE';left:string;right:{field:string}|{constant:number}}
 | {op:'NOT';arg:Exclude<DigitalAtom,{op:'NOT'}>};
export type DigitalPredicate = DigitalAtom | {op:'AND'|'OR';args:[DigitalAtom,DigitalAtom]};
export interface PredicateProgramme {
 id:string;ast:DigitalPredicate;truthHex:string;syntacticAlternatives:number;
}
export interface AffineProgramme {id:string;a:number;b:number}
export interface IdentificationFamily {
 schema:'finnor.s3.generated-digital-family.v1';
 grammar:'CONSTANT_COMPARISON_NEGATION_TWO_ATOM_BOOLEAN_AFFINE_V1';
 domainDigest:string;
 featureDomains:Record<string,number[]>;
 conditionIds:string[];
 vectorCount:number;
 atomBasis:DigitalAtom[];
 predicates:PredicateProgramme[];
 numeric:AffineProgramme[];
 rawSyntaxCount:number;
 representation:'EXACT_FINITE_BEHAVIORAL_QUOTIENT_FACTORIZED_PRODUCT';
 transport:'REGISTERED_CONDITION_RECORD_VECTORS_ONLY';
}
export interface DigitalObservation {
 experimentId:string;conditionId:string;
 records:Array<{id:string;value:string}>;
 trial:DigitalTrial;
}
export interface IdentificationRefutation {
 kind:'PREDICATE'|'AFFINE';programIds:string[];experimentId:string;
 prediction:string;observation:string;
}
export interface IdentificationAnalysis {
 predicateIds:string[];numericIds:string[];refutations:IdentificationRefutation[];
 analyzedExperimentIds:string[];
 observationalEquivalence:'ALL_SURVIVING_PROGRAMMES_RETAINED';
}
export interface DigitalForecast {
 familyDigest:string;conditionId:string;
 inclusion:Array<{mask:string;programIds:string[]}>;
 numeric:Array<{programIds:string[];values:string[]}>;
 semantics:'FROZEN_BEFORE_DISPATCH_NO_PRIORS_OR_LIKELIHOODS';
}
export interface DigitalSelectionScore {
 conditionId:string;total:number;largestPartition:number;worstCaseEliminated:number;
 costUnits:number;risk:number;exposure:number;
}
export interface DigitalExperimentProtocol {
 schema:'finnor.s2.digital-discrimination-protocol.v1';
 identificationId:string;workId:string;workInputId:string;workInputDigest:string;
 phase:'BASELINE'|'DISCOVERY'|'FRESH'|'REPLICATION'|'DECISION_USE';
 condition:DigitalCondition;trial:DigitalTrial;principalId:string;targetId:string;
 familyDigest:string;hypothesisRevisionDigest:string;forecast:DigitalForecast;
 selection:{criterion:'FINITE_MINIMAX_ELIMINATION_PER_COST';scores:DigitalSelectionScore[]}|{criterion:'REGISTERED_ORDINARY'|'WITHHELD_FRESH'|'INDEPENDENT_REPLICATION'|'CURRENT_DECISION_USE';scores:[]};
 instrumentRef:VReference;consentRef:VReference;allocationRef:VReference;
 runtimeDigest:string;checkerDigest:string;
 assignment:{unit:'FRESH_RECORD_SET';interference:'ASSUMED_ABSENT';missingness:'REFUSE';noise:'UNSUPPORTED';absoluteTolerance:0};
 timing:{clock:'SAME_HOST_DEVELOPMENT_UTC';slots:{beforeRequest:-1;betweenRequestAndStart:1;betweenStartAndCompletion:3}};
 stopping:{maxExperiments:number;maxObservationCalls:number;originalDeadlineAt:string;postHocExtension:false};
 effect:{domainActionId:string;businessEffectId:string;operationKey:string};
}
export interface IdentificationIndependentCheck {
 schema:'finnor.s3.digital-identification-check.v1';inputDigest:string;familyDigest:string;
 analysis:IdentificationAnalysis;checks:Record<string,boolean>;checkedAt:string;
 disposition:'SUPPORTED_DEVELOPMENT'|'UNSUPPORTED_OR_INCOMPLETE';
 claimClass:'PREDICTIVE'|'INTERVENTION_IDENTIFIED';
 limitations:string[];
}
export interface DigitalHttpReceipt {cursor:string|null;status:number;body:unknown;receivedAt:string}
export interface DigitalControlReceipt {controlId:string;requests:DigitalHttpReceipt[];error:string|null}
export interface DigitalInstrumentCertificate {
 schema:'finnor.s2.digital-instrument-certificate.v1';id:string;targetId:string;
 instanceId:string;applicationVersion:string;role:'analyst'|'auditor';principalId:string;
 registeredAt:string;completedAt:string;validUntil:string;instrumentDigest:string;
 controls:DigitalControlReceipt[];disposition:'VALIDATED_DEVELOPMENT'|'INVALID';
 limitations:['FINITE_KNOWN_CONTROLS_NOT_UNIVERSAL_MEASUREMENT_PROOF'];
}
export interface RawDigitalExperiment {
 protocol:DigitalExperimentProtocol;registeredAt:string;
 raw:{readbacks:DigitalHttpReceipt[];pages:DigitalHttpReceipt[]};
 instrument:DigitalInstrumentCertificate;
 effectObservation:{
  operationId:string;requestDigest:string;domainActionId:string;businessEffectId:string;
  executionState:string;status:string;trialId:string;
 };
}
export interface DigitalIdentificationCheckInput {
 domain:DigitalIdentificationDomain;family:IdentificationFamily;experiments:RawDigitalExperiment[];
 authorId:string;requestedClaimClass:IdentificationClaimClass;
}
export interface IdentifiedSystemRelease {
 schema:'finnor.identified-system-model.v1';id:string;identificationId:string;
 tenantId:string;principalId:string;replicatorId:string;
 question:{text:string;target:string;affectedDecision:string;requestedClaimClass:IdentificationClaimClass};
 domain:DigitalIdentificationDomain;family:IdentificationFamily;analysis:IdentificationAnalysis;
 familyDigest:string;check:IdentificationIndependentCheck;checkDigest:string;
 instrumentRefs:VReference[];experimentRefs:VReference[];observationRefs:VReference[];
 freshPredictionRefs:VReference[];replicationRefs:VReference[];
 canonicalFindingRef:VReference;
 environment:{sourceDigest:string;checkerDigest:string;lockDigest:string;schemaDigest:string;runtimeDigest:string};
 createdAt:string;validUntil:string;
 achievedClaimClass:'PREDICTIVE'|'INTERVENTION_IDENTIFIED';
 requestedClaimSatisfied:boolean;
 equivalence:{scope:'EXACT_REGISTERED_FINITE_DOMAIN';survivingCartesianProduct:string;uniqueHiddenMechanism:false};
 searchBoundary:{grammarCompleteWithinDomain:true;globalIdentifiabilityEstablished:false;noiseSupported:false;absoluteTolerance:0};
 qualification:'E2E_DEVELOPMENT_NOT_PROTECTED';productionActive:false;protectedAdmission:false;
}
export interface IdentificationEnvelope {
 artifact_id:string;kind:'IdentifiedSystemModel';schema_revision:'finnor.frontier-artifact-envelope.v1';
 content_digest:string;content_digest_basis:'IMMUTABLE_X4_RELEASE_BODY_V1';
 tenant_ref:{owner:'@finnor/db';table:'tenants';id:string};
 principal_ref:{owner:'@finnor/db';table:'users';tenantId:string;id:string};
 work_ref:VReference;institutional_program_ref:IdentificationUnknown;parent_artifact_refs:VReference[];
 producer_revision:VReference;baseline_manifest_ref:VReference;baseline_manifest_kind:'B_live';
 authority_grant_ref:VReference;rights_revision:string;resource_grant_ref:VReference;resource_lease_refs:VReference[];
 source_refs:VReference[];source_revision_vector:Record<string,string>;
 knowledge_cut:{at:string;meaning:'REGISTERED_RAW_EXPERIMENT_AND_CONTROL_EVIDENCE';observationRefs:VReference[]};
 admitted_domain_ref:VReference|IdentificationUnknown;
 application_fingerprints:VReference[];model_refs:VReference[];model_use:'CHECKED_FINITE_EXECUTABLE_PROGRAMMES';
 dependency_lock_digest:string;runtime_digest:string;
 observed_claims:Array<{claim:string;basis:VReference;scope:string}>;
 inferred_claims:Array<{claim:string;basis:VReference;assumptions:string[]}>;
 predicted_claims:Array<{claim:string;protocolRef:VReference;observed:boolean}>;
 unresolved_claims:Array<{claim:string;critical:boolean;value:IdentificationUnknown}>;
 postcondition_contract_refs:VReference[];independent_check_refs:VReference[];
 S6_obligation_refs:VReference[];provider_observation_refs:VReference[];
 invalidation_dependencies:{owner:'P7';refs:VReference[];currentOwnerChecksRequired:true};
 lifecycle_state:{state:string;current:boolean;developmentOnly:true;protectedAdmission:false;productionActive:false};
 lifecycle_events:{owner:'@finnor/db';table:'x4_events';identificationId:string;read:{operation:'identification-history';identificationId:string}};
 build_learning_compute_cost_refs:{events:VReference[];money:IdentificationUnknown;aggregateMemory:IdentificationUnknown;failedAndInterruptedAttemptsRetained:true};
 attributable_human_work_refs:IdentificationUnknown;
}
export interface IdentifiedSystemModel extends IdentifiedSystemRelease {envelope:IdentificationEnvelope}
