import type {ExperimentRef} from './experiments';
import type {BeliefViewPin} from './enterprise-beliefs';
import type {ControlObservation} from './contingent-control';

export interface ControlRational {numerator:string;denominator:string}
export type ExactResourceVector=Record<string,ControlRational>;
export interface ExactControlAction {
 id:string;kind:'INQUIRE'|'INTERVENE'|'WAIT'|'STOP';earliestPeriod:number;lastPeriod:number;atMostOnce:boolean;
 precondition:{afterActionIds:string[];observations:Array<{instrumentId:string;tokens:string[]}>};
 protocolRef:ExperimentRef|null;informationDelayPeriods:number;resources:ExactResourceVector;occupancy:ExactResourceVector;
 occupationPeriods:number;cost:ControlRational;costUnit:string;tailLiability:ControlRational;humanSeconds:ControlRational;
 exposures:Record<string,ControlRational[]>;
}
export interface ExactControlSemantics {
 rights:{rightsRef:string;revision:number;availableInstruments:string[]};
 pendingObservations:Array<{instrumentId:string;availablePeriod:number;tokens:string[];sourceRef:ExperimentRef}>;
 maturity:unknown[];optionConditions:unknown[];exposureSchedules:Record<string,ControlRational[]>;exposureLocks:string[];
 resources:{capacity:ExactResourceVector;totalLimit:ExactResourceVector;used:ExactResourceVector;reserved:ExactResourceVector;
  occupancy:Record<string,ControlRational[]>;couplings:Array<{id:string;weights:ExactResourceVector;maximum:ControlRational}>;
  worldUse:Record<string,{used:ExactResourceVector;occupancy:Record<string,ControlRational[]>;humanUsed:ControlRational;computeUsed:ControlRational}>};
 liquidity:unknown[];covenants:unknown[];humanUsed:ControlRational;humanLimit:ControlRational;computeUsed:ControlRational;computeLimit:ControlRational;
 staffing:unknown[];compensation:unknown[];employeeBenefits:unknown[];
 obligations:Array<{ref:ExperimentRef;effectRef:ExperimentRef;status:'KNOWN_PENDING'|'UNKNOWN'|'PARTIAL'|'SETTLED';[key:string]:unknown}>;
 accruedUtility:Record<string,ControlRational>;terminalLiabilities:Record<string,ControlRational|null>;terminalUtility:Record<string,ControlRational>;
 stopped:boolean;
}
export interface ExactControlOutcome {
 worldId:string;mass:ControlRational;grossUtility:ControlRational;immediateUtility:ControlRational;resourceDelta:ExactResourceVector;
 occupancyDelta:Record<string,ControlRational[]>;humanDelta:ControlRational;obligations:ExactControlSemantics['obligations'];successor:string;
}
export interface ExactInformationState {
 id:string;period:number;history:string[];observations:ControlObservation[];worlds:string[];semantics:ExactControlSemantics;
 transitions:Array<{actionId:string;outcomes:ExactControlOutcome[]}>;
}
export interface ExactInformationModel {
 schema:'finnor.s3.exact-information-model.v1';profile:'finite-information-rational-v1';id:string;tenantId:string;principalId:string;
 rightsRef:string;root:{entityType:string;entityId:string};mandateRef:ExperimentRef;sourceRefs:ExperimentRef[];assumptions:string[];
 encoding:{kind:'EXACT_RATIONAL_SOURCE';originalNumericModelRef:null};
 horizon:{startAt:string;periodMs:number;periods:number};units:{utility:string;resources:Record<string,string>;
  money:{currency:string;unit:string;valuationAt:string;ownerShare:ControlRational;timeBasis:'DECLARED_FINITE_PERIODS';discountConventionRef:ExperimentRef;qualification:'SUPPLIED_OWNER_ASSERTION_UNADMITTED'}};
 economics:{minimumUtility:ControlRational;discountFactors:ControlRational[];terminalLiability:ControlRational;normalization:ControlRational};
 uncertainty:{kind:'FIXED_COMPLETE_WORLDS'|'EXACT_PROBABILITY_LAW';worlds:string[];lawRef:ExperimentRef|null;qualificationRef:ExperimentRef|null;worldWeights:Record<string,ControlRational>};
 actions:ExactControlAction[];observationInstruments:Array<{id:string;sourceRef:ExperimentRef;delayPeriods:number;afterActionIds:string[];tokens:string[];rightsRef:string;
  measurement?:{schema:'finnor.s2.exact-recorded-coarsening.v1';root:{entityType:string;entityId:string};seriesId:string;unit:string;bins:Array<{token:string;lowerInclusive:ControlRational;upperExclusive:ControlRational}>}} >;
 roots:string[];states:ExactInformationState[];
}
export interface ControlQuotient {
 schema:'finnor.control-quotient.v1';producerVersion:'r1-native-refinement-v1';modelDigest:string;profile:'finite-information-rational-v1';
 blocks:Array<{id:string;members:string[];label:unknown;transitions:unknown}>;
 stateToBlock:Record<string,string>;roots:string[];
 lift:Array<{stateId:string;blockId:string;period:number;history:string[];observations:ControlObservation[]}>;
 witness:{kind:'COMPLETE_LABELLED_INFORMATION_BISIMULATION';iterations:number;checkedStates:number;qualification:'SUPPLIED_MODEL_RELATIVE_NO_AUTHORITY'};
}
export interface ControlQuotientReceipt {
 schema:'finnor.r1.independent-check.v1';checkerVersion:'r1-python-fraction-v1';status:'COMPLETE'|'INCOMPLETE'|'UNSUPPORTED'|'UNKNOWN';
 predicate:string;modelDigest:string;candidateDigest:string;checkerDigest:string;profile:'finite-information-rational-v1';
 relationComplete:boolean;probabilityLawQualified:false;causalQualification:'UNQUALIFIED';executionAuthorityGranted:false;
 steps:number;pythonVersion:string;elapsedMs:number;transportElapsedMs:number;
 physical:{pid:number;parentPid:number;executable:string;executableDigest:string;cpuUserMicros:number;cpuSystemMicros:number;
  maxRssNative:number;maxRssUnit:'PLATFORM_NATIVE';platform:string;aggregateSimultaneousPeakKnown:false;usd:null}|null;
}
export interface ExactControlEvaluation {
 schema:'finnor.s4.exact-continuation.v2';status:'COMPLETE'|'INCOMPLETE'|'INFEASIBLE'|'UNSUPPORTED'|'UNKNOWN';
 modelDigest:string;values:Record<string,ControlRational|null>;optimalActions:Record<string,string[]>;
 selectedActions:Record<string,string>;selectedWorldValues:Record<string,ControlRational>;
 family:Record<string,Array<{actionId:string|null;worldValues:Record<string,ControlRational>;children:Record<string,number>}>>;
 selectedFamily:Record<string,number>;root:string;
 stats:{steps:number;continuationEvaluations:number;reuseHits:number;classesEvaluated:number;policyAlternatives:number};
 reasons:string[];arithmetic:'EXACT_BOUNDED_BIGINT_RATIONAL';completeSearch:boolean;
 incumbent:{kind:'FULL_HORIZON_STOP';worldValues:Record<string,ControlRational>;actions:Record<string,string>;checked:boolean}|null;
}
export interface ExactControlPolicyProfile {
 schema:'finnor.s4.exact-policy-profile.v2';durableRunId?:string;sourceRef:ExperimentRef;modelBytes:string;modelDigest:string;
 candidate:ControlQuotient|null;receipt:ControlQuotientReceipt|null;evaluation:ExactControlEvaluation;
 authoritativeQuantities:'ORIGINAL_EXACT_SOURCE';legacyNumbers:'PRESENTATION_ONLY';
 dependencyDigest:string;beliefPins:BeliefViewPin[];sourceDigests:Array<{path:string;sha256:string}>;
}
/** PRD logical envelope mapped to existing Work/S3/S4/S5 and immutable R1
 * records. These references confer no admission, reservation or effect grant. */
export interface R1ArtifactEnvelope {
 schema:'finnor.r1.artifact-envelope.v1';artifact_id:string;artifact_kind:'ControlQuotient';artifact_schema_revision:'finnor.control-quotient.v1';
 work_ref:ExperimentRef;work_revision:string;tenant_ref:{owner:'@finnor/db';id:string};baseline_manifest_ref:ExperimentRef;
 producer_ref:{code_digest:string;dependency_lock_digest:string;admission_ref:null};
 input_refs:Array<{owner_ref:ExperimentRef;revision:string;content_digest:string;as_of:string|null;rights_revision:number|null}>;
 domain_ref:ExperimentRef;assumptions_ref:ExperimentRef;programme_grammar_ref:ExperimentRef;
 check_basis:'MODEL_RELATIVE_EXACT'|'MODEL_RELATIVE_BOUNDED'|'REFERENCE_QUALIFIED'|'UNKNOWN';
 claims:Array<{claim_id:string;statement_ref:ExperimentRef;domain_ref:ExperimentRef;checker_receipt_ref:ExperimentRef}>;
 gaps:Array<{kind:string;reason:string;affected_claim_ids:string[]}>;
 resource_receipt_refs:ExperimentRef[];budget_grant_ref:ExperimentRef;
 invalidation_dependency_refs:Array<{key:string;revision:number;digest:string|null;nodeIds:string[]}>;
 lifecycle_event_refs:ExperimentRef[];
}
export interface R1WorkEnvelope {
 schema:'finnor.r1.producer-envelope.v1';ref:ExperimentRef;workId:string;workRevision:string;tenantId:string;principalId:string;
 baseCommit:string;codeDigest:string;lockDigest:string;independentAdmissionRef:ExperimentRef|null;
 inputRefs:ExperimentRef[];inputDigest:string;asOf:string;rightsRef:string;domain:'finite-information-rational-v1';
 assumptions:string[];grammar:'ORIGINAL_S4_CATALOGUE';checkerBasis:'INDEPENDENT_ORIGINAL_BYTES_FRACTION';
 claims:string[];gaps:string[];resourceRefs:ExperimentRef[];grantRef:ExperimentRef;dependencies:Array<{key:string;revision:number;digest:string|null;nodeIds:string[]}>;
 lifecycle:'PROPOSED'|'CHECKED'|'INVALIDATED'|'CANCELLED'|'UNKNOWN';searchComplete:boolean;relationComplete:boolean;
 artifactEnvelope:R1ArtifactEnvelope;
}
export interface R1WorkProjection {
 schema:'finnor.r1.work-projection.v1';workId:string;workRevision:string|null;
 runs:Array<{id:string;status:string;predicate:string|null;envelope:R1WorkEnvelope|null;
  policyRef:ExperimentRef|null;beforeStates:number;afterStates:number|null;costs:{attempts:number;usd:null;unknown:number};
  qualification:'SUPPLIED_MODEL_RELATIVE_UNADMITTED';fallback:string|null}>;
}
