import {z} from 'zod';
import type {EconomicMandate,ControlProblem,ControlObservation,ControlDecision} from './contingent-control';
import type {ExperimentRef} from './experiments';
import type {InterventionFeature} from './interventions';
import type {InterventionModel} from './interventions';
import type {AllocationResource,AllocationOutstandingCommitment} from './allocation';

export const R2_VERSION='r2-original-history-rational-v1' as const;
export const R2_PROFILE='S4_8_ACTIONS_8_INSTRUMENTS_24_PERIODS_S5_32_WORLDS_EXACT_FINITE' as const;
export const R2RequestSchema=z.object({
  schema:z.literal('finnor.r2.request.v1'),domainProfile:z.literal(R2_PROFILE),
  source:z.object({sourceId:z.string().uuid(),versionId:z.string().uuid(),contentDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  initialWorlds:z.array(z.string().min(1).max(128)).min(1).max(32),
  budget:z.object({maxPaths:z.number().int().min(1).max(50000),maxHistories:z.number().int().min(1).max(50000),
    maxVariables:z.number().int().min(1).max(100000),maxRows:z.number().int().min(1).max(300000),
    maxProofBytes:z.number().int().min(1024).max(8388608),cpuMs:z.number().int().min(1).max(30000),
    /** Owner/native descendant RSS plus original API admission reservation. */
    memoryMiB:z.number().int().min(128).max(2048),maxNativeCalls:z.number().int().min(1).max(128)}).strict(),
}).strict().superRefine((v,c)=>{if(new Set(v.initialWorlds).size!==v.initialWorlds.length)c.addIssue({code:'custom',path:['initialWorlds'],message:'Duplicate initial world'});});
export type R2Request=z.infer<typeof R2RequestSchema>;
export type RationalString=string;
export interface ExactWorld {
  id:string;mechanismId:string;
  initialHistory:Array<{states:Record<string,RationalString>;exposures:Record<string,RationalString>}>;
  coefficients:RationalString[][];shocks:RationalString[][];
  /** One fixed complete realization per world and inquiry period. No probabilities. */
  inquiryTokens:Record<string,string[]>;
  accruedUtility:RationalString;
}
export interface ExactControlSource {
  schema:'finnor.s3.exact-control-source.v1';qualification:'SUPPLIED_EXACT_FINITE_MODEL_UNADMITTED';
  mandateRef:ExperimentRef;problemDigest:string;modelRef:ExperimentRef;
  quantities:Record<string,RationalString>;
  accounting:{ref:ExperimentRef;entityRef:ExperimentRef;unit:string;currency:string|null;valuationDate:string;
    ownerShare:RationalString;timeBasis:{startAt:string;periodMs:number;periods:number};discountConvention:'ORIGINAL_OWNER_FACTORS'};
  mechanisms:Array<{id:string;equations:Array<{variableId:string;features:InterventionFeature[]}>}>;
  stateUnits:Record<string,string>;stateRanges:Record<string,[RationalString,RationalString]>;exposureIds:string[];
  worlds:ExactWorld[];
  completeWorldDeclaration:'ALL_DECLARED_JOINT_WORLDS_NO_PROBABILITIES';
}
export interface R2OriginalProblem {
  schema:'finnor.r2.original.v1';version:typeof R2_VERSION;profile:typeof R2_PROFILE;
  source:ExactControlSource;sourceRef:ExperimentRef;mandate:EconomicMandate;problem:ControlProblem;
  incumbentPolicyRef:ExperimentRef;
  modelRequest:InterventionModel['request'];
  /** Current original S4 belief-pin scopes, resolved by the owner, not caller permits. */
  resourceScopeRoots:Array<{entityType:string;entityId:string}>;
  modelHistory:Array<{states:Record<string,number>;exposures:Record<string,number>}>;
  permitted:{actionId:string;exposureId:string;unit:string;terms:string[];startPeriods:number[];structures:string[];
    stageFractions:string[];resourceRule:'SCALE_REGISTERED_ACTION_LINEAR';agreement:string;
    milestone?:{instrumentId:string;tokens:string[]};inquiryActionId?:string};
  protocols:Array<{ref:ExperimentRef;tokensByMechanism:Record<string,string[]>;delayPeriods:number;completeCost:string}>;
  resources:{resources:AllocationResource[];outstanding:AllocationOutstandingCommitment[];snapshotDigest:string};
  owner:{tenantId:string;principalId:string;workId:string;inputId:string;inputDigest:string;planId:string;planDigest:string;
    ownerVector:Array<{key:string;digest:string}>;dependencies:Array<{key:string;revision:number}>;
    knowledgeAt:string;validUntil:string;outstandingEffects:Array<{id:string;status:string;semantic_hash:string}>};
}
export interface R2Action {
  id:string;kind:'INQUIRE'|'INTERVENE'|'WAIT'|'STOP';cost:string;costUnit:string;resources:Record<string,string>;
  occupancy:Record<string,string>;occupationPeriods:number;tailLiability:string;earliestPeriod:number;lastPeriod:number;
  atMostOnce:boolean;exposures:Record<string,string[]>;protocolRef:ExperimentRef|null;informationDelayPeriods:number;
  humanSeconds:string;precondition?:{afterActionIds:string[];observations:Array<{instrumentId:string;tokens:string[]}>};
}
export interface R2Variant {id:string;structure:string;term:string|null;start:number|null;fraction:string|null;actions:R2Action[]}
export interface R2Decision {key:string;period:number;actionHistory:string[];observations:ControlObservation[];actionId:string}
export interface R2Violation {worldId:string;variantId:string;actionHistory:string[];period:number;constraint:string;used:string;limit:string}
export interface R2Course {id:string;worldId:string;variantId:string;decisions:R2Decision[];utility:string;
  constraints:Array<{id:string;period:number;used:string;limit:string}>;terminalLiability:string;
  resourceUse:Record<string,string[]>;supported:boolean}
export interface RationalRow {id:string;sense:'E'|'L'|'G';rhs:string;terms:Array<[string,string]>}
export interface RationalMILP {
  variables:Array<{id:string;kind:'BINARY'|'CONTINUOUS';lower:string|null;upper:string|null}>;
  objective:{sense:'min';terms:Array<[string,string]>};rows:RationalRow[];
}
export interface R2Encoding extends RationalMILP {
  schema:'finnor.r2.milp.v1';originalDigest:string;grammarDigest:string;worldDigest:string;restrictedWorlds:string[];
  variants:R2Variant[];courses:R2Course[];
  histories:Array<{key:string;variantId:string;period:number;actionHistory:string[];observations:ControlObservation[];actions:string[]}>;
  coverage:{allWorlds:string[];allVariants:string[];fullHistoriesFixed:true;bigMUsed:false;complete:true};
  tieBreak?:{basis:'ORIGINAL_VARIANT_THEN_FIXED_INFORMATION_HISTORY_ACTION_ORDER';minimumValue:string};
}
export interface ExactContingentPolicy {
  schema:'finnor.s4.exact-contingent-policy.v1';version:typeof R2_VERSION;ref:ExperimentRef;
  tenantId:string;principalId:string;episodeId:string;knowledgeAt:string;validUntil:string;mandateRef:ExperimentRef;
  originalRef:ExperimentRef;original:R2OriginalProblem;variant:R2Variant;
  decisions:R2Decision[];worldCourses:R2Course[];value:string;demandDigest:string;checkerReceipt:ExperimentRef;
  certificateRef:ExperimentRef;sourceIdentity:Array<{path:string;sha256:string}>;
  runtimeRef:ExperimentRef;
  executionAuthorityGranted:false;reservationGranted:false;admission:{status:'BLOCKED_EXTERNAL';receipt:null};
}
export interface R2CheckReceipt {
  schema:'finnor.r2.independent-check.v1';ref:ExperimentRef;checkerVersion:typeof R2_VERSION;
  originalDigest:string;encodingDigest:string|null;policyDigest:string|null;
  disposition:'ACCEPTED'|'REJECTED'|'INCOMPLETE';claims:string[];worldValues:Array<{worldId:string;value:string}>;
  feasible:boolean|null;violations:R2Violation[];coverage:{worlds:number;variants:number;histories:number;courses:number};
  lower:string|null;upper:string|null;objectiveSense:'max_z_from_min_negative_z'|'lexicographic_original_owner_order';reason:string|null;
  provenance:{runtimeRef:ExperimentRef;physicalRef:ExperimentRef;checkerIdentity:Array<{path:string;sha256:string}>};
}
export interface JointSearchCertificate {
  schema:'finnor.joint-search-certificate.v1';semanticOwner:'R2';version:typeof R2_VERSION;ref:ExperimentRef;
  status:'COMPLETE'|'INCOMPLETE'|'INFEASIBLE'|'UNSUPPORTED'|'INVALIDATED'|'UNKNOWN';
  checkingBasis:'MODEL_RELATIVE_EXACT'|'MODEL_RELATIVE_BOUNDED'|'REFERENCE_QUALIFIED'|'UNKNOWN';
  envelope:{tenantId:string;principalId:string;work:{id:string;revision:string;contentDigest:string};
    baseline:{commit:string;tree:string};producer:{sourceDigest:string;lockDigest:string;runtimeRef:ExperimentRef;admission:{status:'BLOCKED_EXTERNAL';receipt:null}};
    ownerInputs:R2OriginalProblem['owner'];sourceRef:ExperimentRef;domainProfile:typeof R2_PROFILE;assumptions:string[];
    grammarDigest:string;modelDigest:string;constraintDigest:string;worldDigest:string;originalDigest:string;
    deadlineAt:string;budget:R2Request['budget'];invalidationDependencies:Array<{key:string;revision:number}>};
  incumbent:ExactContingentPolicy|null;lower:string|null;upper:string|null;gap:string|null;normalizedGap:string|null;
  normalization:{range:string;threshold:string;basis:'ORIGINAL_OWNER_SCORING_FROZEN_BEFORE_SEARCH'};
  exactOptimalityClaimed:boolean;proofs:Array<{restrictedWorlds:string[];encodingDigest:string;modelSha256:string;
    proofSha256:string;proofRef:ExperimentRef;artifactRef:ExperimentRef;minimizationLower:string;maximizationUpper:string;
    checkerReceipt:R2CheckReceipt;viprReceipt:ExperimentRef}>;
  infeasibilityProof:{restrictedWorlds:string[];artifactRef:ExperimentRef;proofRef:ExperimentRef;viprRef:ExperimentRef;checkerReceipt:R2CheckReceipt}|null;
  tieBreak?:{status:'CHECKED'|'UNRESOLVED';basis:'ORIGINAL_VARIANT_THEN_FIXED_INFORMATION_HISTORY_ACTION_ORDER';
    receipt:R2CheckReceipt|null;proofRef:ExperimentRef|null;artifactRef:ExperimentRef|null;viprRef:ExperimentRef|null;reason:string|null};
  iterations:Array<{index:number;restrictedWorlds:string[];candidateRef:ExperimentRef|null;candidateValue:string|null;
    lower:string|null;upper:string|null;gap:string|null;addedWorld:string|null;duplicateWitnesses:string[];
    violations:R2Violation[];adverseWorld:string|null;disposition:string}>;
  checks:R2CheckReceipt[];unresolvedClaims:Array<{claim:string;reason:string}>;
  consumer:{s4PolicyRef:ExperimentRef|null;s5:{ref:ExperimentRef;feasible:boolean;current:boolean;reservationCreated:false}|null;
    m1DecisionCoverage:'NOT_GRANTED';executionAuthorityGranted:false};
  fallback:{status:'NOT_NEEDED'|'NO_COMPATIBLE_ADMITTED_FALLBACK'|'ORDINARY_DISPOSABLE_EXECUTED';callee:string|null;reason:string|null};
  lifecycle:Array<{state:string;at:string;reason:string}>;costs:{wallMs:number;cpuMs:number;peakMemoryBytes:number;
    nativeCalls:number;phases:Array<{phase:string;wallMs:number;cpuMs:number;peakMemoryBytes:number;status:string}>;
    money:null;moneyStatus:'UNMETERED';failedAndCancelledRetained:true;buildCostRef:ExperimentRef|null};
  gaps:{unsampledModel:'UNKNOWN';identification:'UNKNOWN';fieldRegret:'UNKNOWN';economicValue:'UNKNOWN'};
}
export interface ExactBranchReview {schema:'finnor.m3.exact-branch-review.v1';ref:ExperimentRef;queryId:string;
  programRef:ExperimentRef;certificateRef:ExperimentRef;candidateDigest:string;policyRef:ExperimentRef;choice:ControlDecision;
  decision:import('./contingent-control').ControlDecisionInput;
  resourceCheckRef:ExperimentRef;executionAuthorityGranted:false;reservationCreated:false;effectRef:null}
