import {z} from 'zod';
import type {ExperimentRef} from './experiments';
import type {AllocationCheck,CanonicalAllocationProblem} from './allocation';
import type {ControlDecision,ControlDecisionInput} from './contingent-control';
import {FinancialSemanticsSchema,EvidenceUnderwritingInputsSchema} from './evidence-execution';

export const CAPITAL_PROGRAM_V2_VERSION='m3-owner-economic-v2' as const;
const uuid=z.string().uuid(),text=z.string().min(1).max(128);
export const CapitalProgramV2RefSchema=z.object({
  owner:z.string().min(1).max(128),id:z.string().min(1).max(512),version:text,
  contentDigest:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const CapitalTermSchema=z.string().max(48).regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,18})?$/)
  .refine(value=>Number.isFinite(Number(value))&&Math.abs(Number(value))<=1e9,'Economic term exceeds the owner numerical domain');
export const CapitalProgramV2ResourceSchema=z.object({
  deadlineMs:z.number().int().min(1).max(30000),maxAttempts:z.number().int().min(1).max(16),
  maxGenerated:z.number().int().min(1).max(256),maxExpansions:z.number().int().min(1).max(50000),
  maxRefinementSteps:z.number().int().min(0).max(4096),maxRefinementDepth:z.number().int().min(0).max(8),
  maxModuleBytes:z.number().int().min(1024).max(65536),maxResultBytes:z.number().int().min(1024).max(8388608),
}).strict();
export const CapitalProgramV2RequestSchema=z.object({
  schema:z.literal('finnor.capital-program-request.v2'),workId:uuid,idempotencyKey:z.string().min(1).max(200),
  incumbentPolicyRef:CapitalProgramV2RefSchema,purpose:z.enum(['COMMERCIAL','ACQUISITION','FINANCING']),
  permitted:z.object({
    actionId:text,exposureId:text,unit:text,terms:z.array(CapitalTermSchema).min(1).max(16),
    startPeriods:z.array(z.number().int().min(0).max(23)).min(1).max(24),
    structures:z.array(z.enum(['IMMEDIATE','STAGED','OBSERVABLE_STAGE','INQUIRY_OPTION','WAIT_STOP'])).min(1).max(5),
    stageFractions:z.array(CapitalTermSchema.refine(value=>Number(value)>0&&Number(value)<1,'Stage fraction must be inside (0,1)')).max(8),
    resourceRule:z.literal('SCALE_REGISTERED_ACTION_LINEAR'),
    agreement:z.enum(['UNILATERAL_PROPOSAL','COUNTERPARTY_REQUIRED']),
    milestone:z.object({instrumentId:text,tokens:z.array(text).min(1).max(16)}).strict().optional(),
    inquiryActionId:text.optional(),
  }).strict(),
  financial:z.object({investmentCaseId:uuid,modelVersionId:uuid,
    nodeId:z.string().regex(/^(?:entry\.(?:enterprise_value|financing_fees)|debt_input\.[A-Za-z0-9_-]+\.(?:opening_principal|fixed_rate))$/).max(128),
    semantics:FinancialSemanticsSchema,
    evidenceDerivationInputs:EvidenceUnderwritingInputsSchema.optional(),
  }).strict().optional(),
  challengeEvidence:z.array(z.object({searchId:uuid,
    resultRef:CapitalProgramV2RefSchema.extend({owner:z.literal('M4')}).strict(),
  }).strict()).min(1).max(8).optional(),
  resource:CapitalProgramV2ResourceSchema,
}).strict().superRefine((value,ctx)=>{
  if(value.permitted.structures.some(s=>s==='STAGED'||s==='OBSERVABLE_STAGE')&&!value.permitted.stageFractions.length)
    ctx.addIssue({code:z.ZodIssueCode.custom,path:['permitted','stageFractions'],message:'A staged domain requires an explicit bounded fraction'});
  for(const key of ['terms','startPeriods','structures','stageFractions'] as const){
    if(new Set(value.permitted[key].map(String)).size!==value.permitted[key].length)
      ctx.addIssue({code:z.ZodIssueCode.custom,path:['permitted',key],message:'Duplicate permitted economic domain value'});
  }
  if(value.challengeEvidence&&new Set(value.challengeEvidence.map(e=>e.searchId)).size!==value.challengeEvidence.length)
    ctx.addIssue({code:z.ZodIssueCode.custom,path:['challengeEvidence'],message:'Duplicate original challenge evidence'});
});
export type CapitalProgramV2Request=z.infer<typeof CapitalProgramV2RequestSchema>;
export type CapitalProgramV2Ref=ExperimentRef&{owner:'M3';version:typeof CAPITAL_PROGRAM_V2_VERSION};
export interface CapitalProgramV2Pending {
  schema:'finnor.m3.pending-request.v2';ref:CapitalProgramV2Ref;owner:'M4'|'M2'|'P1'|'P3'|'S2'|'S3'|'S4'|'S5'|'S6'|'S8'|'P4';
  requiredSchema:string;domain:string;target:ExperimentRef[];inputDigest:string;reason:string;
  remaining:CapitalProgramV2Request['resource'];deadlineAt:string|null;status:'PENDING_DEPENDENCY';executionAuthorityGranted:false;
}
export interface CapitalProgramV2Module {
  schema:'finnor.m3.executable-economic-module.v2';ref:CapitalProgramV2Ref;source:string;javascript:string;
  compiler:{name:'typescript';version:string;diagnostics:string[];typeChecked:true};
  inputDigest:string;outputDigest:string;validityDomain:string;
  refinement:Array<{id:string;parentId:string|null;task:string;rank:number;childRanks:number[];depth:number;primitive:string|null}>;
  execution:{termination:string;exitCode:number|null;provenance:Record<string,unknown>};
  checks:Array<{predicate:string;status:'PASS';qualification:string}>;
}
export interface CapitalProgramV2Candidate {
  semanticDigest:string;parentDigest:string;operator:string;structure:string;
  terms:Array<{exposureId:string;unit:string;before:string;after:string;period:number}>;
  agreement:{status:'PROPOSED';targetDigest:string;requiredStanding:string;liveAgreementRef:null};
  disposition:'CHECKED_MODEL_RELATIVE'|'REJECTED'|'BLOCKED'|'DUPLICATE';
  reason:string|null;policyRef:ExperimentRef|null;demandDigest:string|null;moduleRef:CapitalProgramV2Ref|null;
  moduleExecution:CapitalProgramV2Module['execution']|null;refinementSteps:number;
  valueBasis:'S4_ROBUST_FIXED_JOINT_WORLDS_NO_PROBABILITIES';valueBounds:[number,number]|null;
  changedResponseRecomputed:boolean;finitePolicyComplete:boolean;
  nativeFinance:{modelRef:ExperimentRef;inputDigest:string;resultDigest:string;result:unknown;qualification:string}|null;
  blockers:Array<{code:string;owner:string;requirement:string}>;
}
export interface CapitalProgramV2 {
  schema:'finnor.capital-program.v2';ref:CapitalProgramV2Ref;producerVersion:typeof CAPITAL_PROGRAM_V2_VERSION;
  originalCapability:'CapitalProgramSearch';deliveryAlias:'EconomicProgramSynthesis';
  state:'PROPOSED_TESTED'|'PROPOSED_BLOCKED';executionAuthorityGranted:false;
  envelope:{
    tenantId:string;principalId:string;sharingScope:'PRIVATE_PRINCIPAL';
    work:{id:string;inputId:string;inputDigest:string};
    plan:{id:string;semanticHash:string;workInputId:string};
    parents:ExperimentRef[];requestRef:CapitalProgramV2Ref;inputDigest:string;knowledgeAt:string;validAt:string;validUntil:string;
    ownerVector:Array<{key:string;digest:string}>;
    recompilation:{parentQueryId:string;parents:ExperimentRef[];
      changedDependencies:Array<{key:string;previousDigest:string|null;currentDigest:string|null}>}|null;
    sourceDigests:Array<{path:string;sha256:string}>;schemaDigest:string;runtime:{node:string;platform:string;architecture:string;imageAttestation:null};
    grant:{limits:CapitalProgramV2Request['resource'];qualification:string;financialFundingRef:null;aggregatePhysicalLimits:'UNENFORCED';
      deadlineAt?:string;parentEpisodeQueryId?:string|null};
    invocationRefs:string[];admission:{status:'BLOCKED_EXTERNAL';receipt:null};
  };
  mandate:ExperimentRef;programModule:CapitalProgramV2Ref|null;ownerBoundGraph:CapitalProgramV2Ref|null;
  valueUnit:string;
  evidenceSlice:ExperimentRef|null;mechanisms:ExperimentRef[];inquiries:ExperimentRef[];
  allocationRequest:ExperimentRef|null;effectProposals:ExperimentRef[];challengeEvidence:ExperimentRef[];
  candidates:CapitalProgramV2Candidate[];
  allocation:{problem:CanonicalAllocationProblem|null;checks:AllocationCheck[];qualification:string;reservationCreated:false};
  incumbentAndSearchGap:{
    incumbentDigest:string;selectedDigest:string|null;valueBounds:[number,number]|null;generatedDescriptors:number;attemptedDescriptors:number;
    remainingDescriptors:number;finiteDomainComplete:boolean;upperBound:null;globalOptimalityClaimed:false;
    modeledImprovement:number|null;unsampledModelGap:'UNKNOWN';identificationGap:'UNKNOWN';selectionQualification:string;
  };
  blockers:Array<{code:string;owner:string;requirement:string}>;pendingRequests:CapitalProgramV2Pending[];
  unresolvedBindings:Array<{field:string;requiredSchema:string;owner:string;reason:string}>;
  costs:{money:null;status:'UNMETERED';wallMs:number;cpuUserMicros:number;cpuSystemMicros:number;rssBeforeBytes:number;rssAfterBytes:number;
    outputBytes:number;generated:number;attempted:number;refinementSteps:number;expansions:number;externalModelCalls:0;
    upstreamComputeRefs:string[];upstreamChargesDuplicated:false;unknownAttemptIds:string[];failedAttemptCostsRetained:true};
  limitations:string[];
}
export type CapitalProgramV2Status='QUEUED'|'RUNNING'|'TESTED'|'PARTIAL'|'FAILED'|'INVALIDATED'|'CANCELLED';
export interface CapitalProgramV2BranchReview {
  schema:'finnor.m3.native-branch-review.v2';ref:CapitalProgramV2Ref;status:'MODEL_BRANCH_REVIEWED';
  queryId:string;programRef:CapitalProgramV2Ref;candidateDigest:string;policyRef:ExperimentRef;
  mandateRef:ExperimentRef;evidenceSlice:ExperimentRef;decision:ControlDecisionInput;choice:ControlDecision;
  qualification:'CURRENT_NATIVE_S4_REFERENCE_BRANCH_NOT_BUSINESS_SELECTION';
  executionAuthorityGranted:false;decisionCoverageGranted:false;reservationCreated:false;effectRef:null;
}
export interface CapitalProgramV2AttemptCost {
  attemptId:string;state:'RUNNING'|'FINISHED'|'FAILED'|'FENCED';
  startedAt:string;finishedAt:string|null;deadlineAt:string;
  physicalCostStatus:'PENDING_READBACK'|'UNKNOWN'|'MEASURED_SUPERVISOR_INTERVAL';
  wallMs:number|null;cpuUserMicros:number|null;cpuSystemMicros:number|null;
  money:null;aggregateChildUsageKnown:false;accountingScope:'WORKER_HANDLER_BEFORE_TERMINAL_ACCOUNTING';
}
export interface CapitalProgramV2QueryView {
  queryId:string;workId:string;status:CapitalProgramV2Status;program:CapitalProgramV2|null;
  request:CapitalProgramV2Request;deadlineAt:string|null;
  progress:{attempted:number;generated:number;refinementSteps:number};
  failure:{code:string;requirement:string}|null;parentQueryId:string|null;executionAuthorityGranted:false;
  branchReviews:CapitalProgramV2BranchReview[];
  attemptCosts:CapitalProgramV2AttemptCost[];
}
export const CapitalProgramV2Operations={
  'capital-program-submit':CapitalProgramV2RequestSchema,
  'capital-program-read':z.object({queryId:uuid}).strict(),
  'capital-program-list':z.object({workId:uuid,limit:z.number().int().min(1).max(32).optional()}).strict(),
  'capital-program-context':z.object({workId:uuid,root:z.object({entityType:text,entityId:uuid}).strict()}).strict(),
  'capital-program-ports':z.object({workId:uuid}).strict(),
  'capital-program-witness':z.object({queryId:uuid,candidateDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  'capital-program-module':z.object({queryId:uuid,moduleDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  'capital-program-cancel':z.object({queryId:uuid}).strict(),
  'capital-program-resume':z.object({queryId:uuid}).strict(),
  'capital-program-recompile':z.object({queryId:uuid,idempotencyKey:z.string().min(1).max(200),
    replacement:CapitalProgramV2RequestSchema.optional()}).strict(),
  'capital-program-select':z.object({queryId:uuid,candidateDigest:z.string().regex(/^[a-f0-9]{64}$/),idempotencyKey:z.string().min(1).max(200),
    intent:z.enum(['MODEL_BRANCH_REVIEW','OWNER_HANDOFF']).default('OWNER_HANDOFF')}).strict(),
} as const;
