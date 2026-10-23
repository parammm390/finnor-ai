import type {ExperimentRef} from './experiments';
import type {ResourceQuantity} from './allocation';

export type StrategicChoice = 0 | 1;
export interface StrategicResponseProblem {
 schema:'finnor.strategic-response-problem.v1';
 actors:Array<{id:string;role:'LENDER'|'CAPITAL_PROVIDER'|'COUNTERPARTY'|'APPROVER';
  privateInformation:'OWN_OUTSIDE_OPTION_AND_OWN_PREVIOUS_CHOICE';outcomeVisibility:'PUBLIC'}>;
 rules:Array<{id:string;incentive:number;interaction:number;peerDisclosure:'LAGGED_PEER_COUNT'|'NONE';
  settlement:'ALL_ACTORS_PARTICIPATE';allocation:'JOINT_ALL_OR_NONE';transfer:'DECLARED_FIXED_INCENTIVE'}>;
 training:StrategicResponseEpisode[];holdout:StrategicResponseEpisode[];
 assumptions:{sequentialExogeneity:boolean;completeActorInformation:boolean;stablePreferences:boolean};
 transport:{status:'CONDITIONAL'|'WITHDRAWN';contexts:string[];outsideOptionRange:[number,number];
  commonSignalRange:[number,number];validUntil:string;omittedModelGap:'UNKNOWN'};
 payoff:{unit:string;currency:string;scale:'1';entityRoot:{entityType:string;entityId:string};
  accountingBasis:'GROSS_JOINT_PAYOFF_BEFORE_ACTION_COSTS';jointPayoff:ResourceQuantity};
}
export interface StrategicResponseEpisode {
 id:string;origin:'OBSERVED'|'SIMULATED'|'REQUESTED_EXPERIMENT';
 assignment:'INCUMBENT_OBSERVATIONAL'|'PERMITTED_RANDOMIZED'|'CONFOUNDED';
 execution:'OBSERVED'|'REQUESTED';observedAt:string;initial:Record<string,StrategicChoice>;
 rounds:Array<{ruleId:string;outsideOptions:Record<string,number>;commonSignal:number;choices:Record<string,StrategicChoice>}>;
}
export interface StrategicResponseHypothesis {
 id:string;bias:Record<string,number>;incentiveWeight:number;peerWeight:number;
 tie:'PARTICIPATE'|'DECLINE'|'INERTIA';
}
export interface StrategicFittedSet {
 schema:'finnor.strategic-fitted-set.v1';profileDigest:string;problemDigest:string;
 status:'FITTED'|'UNIDENTIFIED'|'NO_SUPPORTED_MODEL';
 hypotheses:StrategicResponseHypothesis[];universeSize:number;semanticApplications:number;
 training:{eligibleEpisodeIds:string[];ignoredEpisodeIds:string[]};
 holdout:{episodes:number;coveredCompleteJointTrajectories:number;empiricalCalibrationEstablished:false};
 identification:{structuralFamilies:number[];behaviorSelections:string[];
  basis:'FINITE_STRUCTURAL_CLASS_CONDITIONAL_ON_DECLARED_ASSUMPTIONS';pointIdentifiedInClass:boolean;fieldIdentificationEstablished:false};
 omittedModelGap:'UNKNOWN';probabilityWeights:null;
}
export interface StrategicForecastRequest {
 context:string;ruleIds:string[];initial:Record<string,StrategicChoice>;
 jointPrivatePaths:Array<{id:string;outsideOptions:Record<string,number[]>}>;
 sharedSignalPaths:Array<{id:string;values:number[]}>;
}
export interface StrategicPrediction {
 schema:'finnor.strategic-prediction.v1';modelDigest:string;queryDigest:string;
 trajectories:Array<{worldId:string;hypothesisId:string;privatePathId:string;signalPathId:string;
  rounds:Array<{ruleId:string;choices:Record<string,StrategicChoice>;jointPayoff:ResourceQuantity}>}>;
 probabilityWeights:null;qualification:'CONDITIONAL_JOINT_MODEL_SET_NOT_CALIBRATED_FIELD_PREDICTION';
}
export interface StrategicIndependentCheck {
 schema:'finnor.strategic-independent-check.v1';
 status:'CHECKED'|'REJECTED'|'UNKNOWN';operation:'FIT'|'PREDICT'|'DECISION';reason?:string;
 inputDigest?:string;candidateDigest?:string;profileDigest?:string;checkerDigest?:string;
 interpreterDigest?:string;interpreterVersion?:string;cpuMs?:number;peakRssBytes?:number;
 nonVacuous?:boolean;checkedWorlds?:number;executionAuthorityGranted:false;protectedQualification:false;
}
export interface StrategicResponseEnvelope {
 schema:'finnor.postx-strategic-artifact-envelope.v1';artifactKind:'StrategicResponseModel';id:string;
 tenantId:string;principalId:string;contentRef:ExperimentRef;parents:ExperimentRef[];
 work:{id:string;inputId:string;inputDigest:string};goal:{kind:'OWN_FIRM_STRATEGIC_RESPONSE';problemDigest:string};
 sourceBindings:Array<{sourceId:string;versionId:string;contentDigest:string}>;
 rights:{revision:string;principalId:string};validityDomain:{profileId:string;profileDigest:string;validUntil:string;finiteOnly:true};
 provenance:{producerVersion:string;semanticCodeDigest:string;sourcePins:Array<{path:string;sha256:string}>};
 dependencies:Array<{id:string;dependsOn:string[];kind:string;owner:string;digest:string}>;
 resourceEnvelope:{episodeId:string;deadlineAt:string;attemptsUsed:number;semanticApplicationsOccupied:number;retainedBytes:number;usesUsed:number};
 independentChecks:StrategicIndependentCheck[];
 admission:{domain:'STRATEGIC_RESPONSE_MODEL_SET';status:'UNADMITTED';protectedAdmission:false;executionAuthorityGranted:false};
 lowering:{owningInterfaces:['S3','S4','S5','S6','S7','S8','P7'];adapter:'ACTOR_LOCAL_STRATEGIC_JOINT_V1';externalEffectsSupported:false};
 recovery:{originalEpisodeRetained:true;priorCommitmentsRetained:true;fallbackId:string|null};
 uncertainty:{omittedModelGap:'UNKNOWN';fieldIdentificationEstablished:false;empiricalCalibrationEstablished:false};
 comparison:{classification:'CONSTRUCTED_DEVELOPMENT_UNQUALIFIED';qualifiedEquippedBaseline:'UNESTABLISHED'};
 costs:{wallMs:number;cpuMs:number;peakProcessRssBytes:number;checkerCpuMs:number|null;checkerPeakRssBytes:number|null;
  moneyUsd:null;humanSeconds:null;aggregatePeakMemoryBytes:null;status:'PARTIALLY_METERED';failedAttemptsRetained:true};
 status:string;qualifications:string[];createdAt:string;
}
export interface StrategicResponseModel {
 schema:'finnor.strategic-response-model.v1';envelope:StrategicResponseEnvelope;
 problem:StrategicResponseProblem;body:StrategicFittedSet;
}
