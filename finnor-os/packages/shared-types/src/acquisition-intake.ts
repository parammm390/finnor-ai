import type {z} from 'zod';
import type {UnderwritingExplicitInputSchema} from './underwriting-inputs';
import type {AcquisitionMandateView} from './acquisition-decisions';
import type {PrimaryUnderwritingScope,VReference} from './primary-diligence';

export interface AcquisitionIntakeDraft {
 dealId:string;modelVersionId:string;mandateId:string;grantId:string;sourceProfileIds:string[];consentIds:string[];
 assertions:Array<{nodeId:string;assertionId:string;question:string;rationale:string;materialityThreshold:string;knownGaps:string[];observationPredicates:string[]}>;
 explicitInputs:Record<string,z.infer<typeof UnderwritingExplicitInputSchema>>;
 acquisition:Omit<AcquisitionMandateView,'dealId'|'workId'|'baseRunId'>;
}
export interface AcquisitionIntakeContext {
 dealId:string;
 models:Array<{id:string;name:string;investmentCaseId:string;caseTitle:string;version:string}>;
 model:null|{id:string;investmentCaseId:string;name:string;version:string;semanticHash:string;periods:string[];
  primaryInputs:Array<{id:string;label:string;scope:PrimaryUnderwritingScope}>;
  parameters:Array<{id:string;label:string;valueType:string;unit:string;currency?:string;shape:'scalar'|'series';required:boolean}>;
  outputs:Array<{id:string;label:string;unit:'money'|'rate'|'multiple'|'ratio'|'count';currency?:string}>};
 mandates:Array<{ref:VReference;objective:string;assertionIds:string[];authorityProfileId:string;sourceProfileIds:string[];deadline:string;environment:'DEVELOPMENT'|'LIVE'}>;
 grants:Array<{ref:VReference;mandateId:string;maximumMicroUsd:string;maximumRequests:number;expiresAt:string}>;
 sources:Array<{ref:VReference;issuer:string;system:string;sourceClass:string;fields:string[];participants:string[];observationPredicates:string[];expiresAt:string}>;
 consents:Array<{ref:VReference;sourceProfileIds:string[];participants:string[];periodStart:string;periodEnd:string;expiresAt:string}>;
 authorityGranted:false;
}
