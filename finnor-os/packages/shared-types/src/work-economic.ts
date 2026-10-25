import type {EconomicRef,OutcomeEstimand} from './economic-attribution';

export interface WorkEconomicAnchor {
 workId:string;workInputId:string;objectiveLoopId:string;objectiveRevision:number;objectiveDigest:string;
 successConditionHash:string;criterionIndex:number;criterionHash:string;dealId:string;currency:string;
}
export type WorkEconomicPlanAvailability={kind:'AVAILABLE';until:string}
 |{kind:'CURRENT'|'EXPOSURE_STARTED'|'CURRENCY_MISMATCH'|'CORRECTION_REQUIRED'};
export interface WorkEconomicContext {
 applicable:boolean;workId:string;criteria:Array<{index:number;reason:string}>;
 anchor:WorkEconomicAnchor|null;originalClause:string|null;
 state:'NOT_APPLICABLE'|'SELECT_REQUIREMENT'|'NOT_BOUND'|'TRACKING_REGISTERED'|'TRACKING_SOURCE_GAPS';
 tracking:null|{bindingRef:EconomicRef;estimandRef:EconomicRef;assignmentKind:OutcomeEstimand['assignment']['kind'];
  currency:string;assignmentAt:string;endpointAt:string;registeredLooks:string[];sourceGaps:string[];sourceQualification:string};
 choices:Array<{ref:EconomicRef;key:string;currency:string;assignmentKind:OutcomeEstimand['assignment']['kind'];assignmentAt:string;endpointAt:string;availability:WorkEconomicPlanAvailability}>;
 originalBudget:null|{deadlineAt:string;maxSteps:number;maxActions:number;maxQueries:number;stepCount:number;actionCount:number;queryCount:number};
 completionSatisfied:false;executionAuthorityGranted:false;causalCreditGranted:false;
}
