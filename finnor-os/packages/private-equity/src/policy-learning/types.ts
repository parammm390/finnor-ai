import type {VReference,EnterpriseApplicationRelease} from '@finnor/shared-types';
import type {projectRecord} from '../enterprise-applications/service';
import type {ApplicationValues} from '../enterprise-applications/contracts';
import type {BoundedPolicy,Checkpoint,StructuralSample,ExperienceSelection} from './contracts';
import type {LearningEnvironment} from './source-cut';
import type {trainController} from './controller';
export type NativeRecord=ReturnType<typeof projectRecord>;
export interface NativeCommandEvent{
 id:string;actor_id:string;record_id:string;kind:string;request_digest:string;created_at:Date;committed_at:Date|null;transaction_id:string;
 body:{input:{actionId:string;[key:string]:unknown};before:NativeRecord|null;result:{decision:{allowed:boolean;outcome:string;evaluatedAssignments?:ApplicationValues};record:NativeRecord|null}};
}
export interface ExperienceRecordCut{
 applicationId:string;recordId:string;selected:boolean;status:'ACCEPTED'|'REJECTED';reason:string;
 historyRefs:VReference[];futureRefs:VReference[];acceptanceRef:VReference|null;reconciliationRef:VReference|null;
 consentRef:VReference;sourceRefs:VReference[];
 partition:{institution:string;application:string;structure:string;time:string;dependenceGroup:string};
 qualification:'OPERATIONAL_CONTRACT_ONLY_NO_CAUSAL_OR_FINANCIAL_REWARD';
 originalAssignment?:{workId:string;workInputId:string;workInputDigest:string;specificationDigest:string;releaseId:string;checkerDigest:string;runtimeDigest:string;
  authorPrincipalId:string;checkerPrincipalId:string;recordReference:VReference;rightsRef:VReference;unresolvedObligations:never[];effects:string;costs:EnterpriseApplicationRelease['resources']};
}
export interface AcceptedExperienceCut{
 schema:'finnor.x5.accepted-native-experience.v1';knowledgeCut:string;records:ExperienceRecordCut[];samples:StructuralSample[];
 acceptedCount:number;cutDigest:string;partitionDigest:string;positiveEvidenceRefs:VReference[];failureLabelsRetained:true;protectedCustody:false;
 qualification:'CURRENT_RIGHTS_NATIVE_INDEPENDENT_OPERATIONAL_APPROVAL_NOT_CAUSAL_REWARD_OR_PROTECTED_CUSTODY';
}
export interface ChildResources{
 pid:number;wallMs:number;cpuMicros:number;peakProcessRSSBytes:number;node:string;platform:string;architecture:string;heapLimitMiB:256;aggregatePeakMemory:null;
 supervisorWallMs?:number;sampledPeakRSSBytes?:number;outputBytes?:number;exitCode?:number;
}
export interface LearningRelease{
 schema:'finnor.x5.immutable-learning-release.v1';id:string;compilationId:string;tenantId:string;principalId:string;
 policy:BoundedPolicy;policyDigest:string;originalCheckpoint:Checkpoint;checkpoint:Checkpoint;
 training:ReturnType<typeof trainController>;experience:AcceptedExperienceCut;selections:ExperienceSelection[];
 environment:LearningEnvironment;resources:ChildResources;createdAt:string;
 job:{jobId:string;deliveryAttemptId:string;claimFence:number;workerId:string};
 developmentOnly:true;protectedAdmission:false;productionActive:false;
}
