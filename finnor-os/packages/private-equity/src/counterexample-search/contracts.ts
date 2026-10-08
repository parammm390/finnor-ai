import { z } from 'zod';
import { epistemicHash } from '../../../epistemic-runtime/src/source-precedence';
import type { ExperimentRef } from '@finnor/shared-types';
import type { CurrentSlice } from '../decision-slice/service';
import type { NativeBinding, DecisionNode, DecisionEdge } from '../decision-slice/contracts';

export const M4_VERSION = 'm4-bounded-original-input-v1' as const;
const uuid=z.string().uuid(), text=z.string().min(1).max(256), digest=z.string().regex(/^[a-f0-9]{64}$/);
export const RefSchema=z.object({owner:text,id:z.string().min(1).max(512),version:text,contentDigest:digest}).strict();
export const M4RefSchema=RefSchema.extend({owner:z.literal('M4'),version:z.literal(M4_VERSION)}).strict();
export type M4Ref=z.infer<typeof M4RefSchema>;
export const CapitalProgramRefSchema=RefSchema.extend({owner:z.literal('M3')}).strict();
export type CapitalProgramRef=z.infer<typeof CapitalProgramRefSchema>;
export const ref=(kind:string,body:unknown):M4Ref=>{
  const contentDigest=epistemicHash(body);return {owner:'M4',id:`${kind}:${contentDigest}`,version:M4_VERSION,contentDigest};
};
export const hash=epistemicHash;
export const copy=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
export const DecimalSchema=z.string().max(48).regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,18})?$/);
export const ClaimKindSchema=z.enum(['UNIVERSAL_DETERMINISTIC','MODEL_WORST_CASE','EXACT_SOURCE','EXACT_EFFECT',
  'PROBABILITY','EXPECTATION','CAUSAL','EX_ANTE_QUALITY','AGREEMENT']);
export type ClaimKind=z.infer<typeof ClaimKindSchema>;
export const LimitsSchema=z.object({
  deadlineMs:z.number().int().min(1).max(30000),maxTargets:z.number().int().min(1).max(64),
  maxCells:z.number().int().min(1).max(128),maxTrials:z.number().int().min(1).max(512),
  maxReductions:z.number().int().min(0).max(64),maxWitnesses:z.number().int().min(1).max(32),
  maxBytes:z.number().int().min(1024).max(4194304),
}).strict();
const mechanics=z.object({kind:z.literal('MECHANICAL_BOUND'),candidateId:text,nodeId:text,
  relation:z.enum(['LTE','GTE','EQ']),value:DecimalSchema,unit:text,currency:z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
  claimKind:ClaimKindSchema}).strict();
const nativeCheck=z.object({kind:z.literal('NATIVE_CHECK'),candidateId:text,nodeId:text,claimKind:ClaimKindSchema}).strict();
const sourceLiteral=z.object({kind:z.literal('SOURCE_LITERAL'),entityType:text,entityId:text,
  field:z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/).refine(s=>!['constructor','prototype','__proto__'].includes(s)),
  expected:z.union([z.string().max(2048),z.boolean(),z.null()]),claimKind:ClaimKindSchema,
  interpretation:z.enum(['EXACT_RECORDED_LITERAL','LEGAL_MEANING'])}).strict();
const p4Term=z.object({kind:z.literal('P4_TERM'),derivationId:uuid,output:text,expected:DecimalSchema,unit:text,
  entityType:text,entityId:uuid,claimKind:ClaimKindSchema}).strict();
const allocation=z.object({kind:z.literal('ALLOCATION_SELECTION'),selectedPolicyIds:z.array(text).max(8),
  claimKind:ClaimKindSchema}).strict();
const allocationBound=z.object({kind:z.literal('ALLOCATION_BOUND'),bound:DecimalSchema,
  claimKind:ClaimKindSchema}).strict();
const world=z.object({kind:z.literal('POLICY_BOUND'),policyId:text,minimum:DecimalSchema,unit:text,
  claimKind:ClaimKindSchema}).strict();
const fixture=z.object({kind:z.literal('EFFECT_FIXTURE'),fixture:z.enum(['CORRECT','WRONG_TARGET','WRONG_AMOUNT','CLEAR','UNKNOWN']),
  request:z.object({entityId:z.enum(['C_01','C_010']),field:z.enum(['credit_limit','note']),operation:z.enum(['SET','CLEAR']),
    value:z.union([DecimalSchema,z.null()]),unit:z.enum(['USD','TEXT']),currency:z.enum(['USD']).nullable(),
    idempotencyKey:z.string().min(1).max(128)}).strict(),claimKind:ClaimKindSchema}).strict();
export const EvaluationSchema=z.discriminatedUnion('kind',[mechanics,nativeCheck,sourceLiteral,p4Term,allocation,allocationBound,world,fixture]);
export type Evaluation=z.infer<typeof EvaluationSchema>;
export const DomainSchema=z.object({parameters:z.array(z.object({candidateId:text,nodeId:text,
  values:z.array(DecimalSchema).min(1).max(4)}).strict()).max(8),maxCombination:z.number().int().min(1).max(3)}).strict();
export const DiagnosticRequestSchema=z.object({schema:z.literal('finnor.m4.diagnostic-request.v1'),workId:uuid,
  sliceRef:RefSchema,idempotencyKey:z.string().min(1).max(200),evaluations:z.array(EvaluationSchema).min(1).max(16),
  domain:DomainSchema,limits:LimitsSchema}).strict().superRefine((request,ctx)=>{
    request.evaluations.forEach((e,index)=>{
      if(e.kind==='EFFECT_FIXTURE'&&(e.request.operation==='CLEAR'&&e.request.value!==null||
        e.request.field==='credit_limit'&&(e.request.unit!=='USD'||e.request.currency!=='USD')||
        e.request.field==='note'&&(e.request.unit!=='TEXT'||e.request.currency!==null)))
        ctx.addIssue({code:z.ZodIssueCode.custom,path:['evaluations',index,'request'],message:'Exact fixture operation, field, unit and currency contract required'});
    });
  });
export type DiagnosticRequest=z.infer<typeof DiagnosticRequestSchema>;
export const ChallengeRequestSchema=z.object({schema:z.literal('finnor.m4.challenge-request.v1'),workId:uuid,
  candidate:CapitalProgramRefSchema,idempotencyKey:z.string().min(1).max(200),limits:LimitsSchema}).strict();
export type ChallengeRequest=z.infer<typeof ChallengeRequestSchema>;
export const SearchIdSchema=z.object({searchId:uuid}).strict();
export const SearchReadSchema=SearchIdSchema.extend({readMode:z.enum(['CURRENT','ISSUED_HISTORY']).default('CURRENT')}).strict();
export type SearchReadMode=z.infer<typeof SearchReadSchema>['readMode'];
export const ReplaySchema=SearchIdSchema.extend({witnessRef:M4RefSchema}).strict();
export const RepairSchema=SearchIdSchema.extend({replacement:z.union([DiagnosticRequestSchema,ChallengeRequestSchema])}).strict();
export type WitnessClass='GROUNDING_INTERPRETATION'|'NUMERICAL_CONTRACT'|'POLICY_WORLD'|'EFFECT_INTERFACE';
export interface CoverageGap {
  ref:M4Ref;claimRef:M4Ref|null;targetRef:M4Ref|null;dependencyRefs:ExperimentRef[];
  reason:string;detail:string;fatal:boolean;attempted:number;requiredOwner:string;nextEvidenceRequest:string|null;
}
export function gap(reason:string,detail:string,claimRef:M4Ref|null=null,fatal=false,requiredOwner='M4',attempted=0):CoverageGap{
  const body={claimRef,targetRef:null,dependencyRefs:[],reason,detail,fatal,attempted,requiredOwner,nextEvidenceRequest:null};
  return {ref:ref('coverage-gap',body),...body};
}
export interface CandidateClaim {
  ref:M4Ref;evaluation:Evaluation;kind:ClaimKind;predicateDigest:string;ownerPredicateRef:ExperimentRef;
  regionIds:string[];dependencyRefs:ExperimentRef[];quantifiedDomainRef:M4Ref;
  semantics:{entity:string|null;unit:string|null;currency:string|null;time:unknown;informationCut:string};
  qualification:string;
}
export interface FaultTarget {ref:M4Ref;claimRef:M4Ref;class:WitnessClass;regionIds:string[];operators:string[];
  checker:string;reason:string;requiredContextDigest:string}
export interface FaultGraph {
  schema:'finnor.m4.fault-dependency-graph.v1';ref:M4Ref;sourceSliceRef:ExperimentRef;sourceGraphRef:ExperimentRef;
  nodes:DecisionNode[];edges:DecisionEdge[];qualification:'M4_DIAGNOSTIC_CLOSURE_NOT_A_MODIFIED_M1_GRAPH';
}
export interface Component {candidateId:string;nodeId:string;value:string}
export interface Proposal {ref:M4Ref;targetRef:M4Ref;claimRef:M4Ref;components:Component[];worldId:string|null;
  contextDigest:string;predicateDigest:string;qualification:string}
export interface Validation {
  status:'VALID'|'INVALID'|'UNRESOLVED';reason:string;failureKey:string|null;qualification:string;
  native:{checker:string;observed:unknown;trace:unknown};
  independent:{checker:string;observed:unknown;trace:unknown};
  predicate:{expected:unknown;relation:string;location:string;unit:string|null};
  material:boolean;
}
export interface ValidatedCounterexample {
  ref:M4Ref;class:WitnessClass;claimRef:M4Ref;targetRef:M4Ref;candidateIdentity:string;contextDigest:string;
  original:Proposal;minimized:Proposal;validation:Validation;
  minimization:{status:'ONE_MINIMAL_RECORDED_DELETIONS'|'SUFFICIENT_NOT_MINIMAL';trace:Array<{
    proposalRef:M4Ref;removed:Component;outcome:'FAIL'|'PASS'|'UNRESOLVED';reason:string}>;
    relation:'SAME_CANDIDATE_CLAIM_CONTEXT_AND_FAILURE';globallySmallest:false};
  replay:{operation:'counterexample-witness-replay';readOnly:true;effectReexecution:false};
}
export interface FrozenDiagnostic {
  schema:'finnor.m4.frozen-diagnostic.v1'|'finnor.m4.frozen-challenge.v1';request:DiagnosticRequest;slice:CurrentSlice['slice'];
  binding:NativeBinding;graph:CurrentSlice['projectionInput']['graph'];faultGraph:FaultGraph;claims:CandidateClaim[];targets:FaultTarget[];
  gaps:CoverageGap[];contextDigest:string;identityDigest:string;domainRef:M4Ref;
  p4:Array<{evaluationIndex:number;body:import('@finnor/shared-types').EvidenceDerivation}>;
  code:{digest:string;files:Array<{path:string;sha256:string}>};plan:{id:string|null;digest:string};
  revisions:import('@finnor/shared-types').EvidenceDependency[];
  schemaDigest:string;
  capital?:{submission:ChallengeRequest;context:import('../capital-program/challenge-reader').CapitalChallengeContext};
}
export interface ProducerEnvelope {
  producer:{owner:'M4';version:typeof M4_VERSION;schema:'finnor.m4.producer-envelope.v1'};
  identity:{tenantId:string;principalId:string;workId:string;workInputId:string;contextDigest:string;sourceDigest:string};
  runtime:{node:string;platform:string;architecture:string;imageAttestation:null};
  evaluation:{protocol:'FROZEN_ORIGINAL_PREDICATE_V1';independentAdmission:null};
  resources:{profile:'DISPOSABLE_TRUSTED_NATIVE';protectedFunding:null;aggregateOSLimits:'UNQUALIFIED'};
  cost:{usd:null;status:'UNMETERED';upstreamChargesDuplicated:false};
  qualification:'H0_H1_DEVELOPMENT_NOT_H2';executionAuthorityGranted:false;
}
/** Normative original contract. A diagnostic never inhabits this type. */
export interface ChallengeResult extends ProducerEnvelope {
  schema:'finnor.m4.challenge-result.v1';ref:M4Ref;
  envelope:{
    id:string;tenant:{id:string;principalId:string;sharingScope:'PRIVATE_PRINCIPAL'};
    mandateOrChange:ExperimentRef;work:{id:string;inputId:string;inputDigest:string};parents:ExperimentRef[];
    inputs:{candidate:CapitalProgramRef;moduleRefs:ExperimentRef[];moduleDigests:string[];graphRef:ExperimentRef;
      claims:ExperimentRef[];contextDigest:string;inputDigest:string};
    rights:CurrentSlice['slice']['envelope']['rights'];owners:Array<{key:string;digest:string}>;
    producer:{owner:'M4';version:typeof M4_VERSION;sourceDigest:string;schemaDigest:string};
    runtime:ProducerEnvelope['runtime'];domain:{ref:M4Ref;qualified:'FINITE_OWNER_CLAIMS_H0_H1';independentAdmission:null};
    invalidation:import('@finnor/shared-types').EvidenceDependency[];
    computeGrant:{searchId:string;deadlineAt:string;limits:DiagnosticRequest['limits'];financialFunding:null;aggregateOSLimits:'UNQUALIFIED'};
    costs:OwnerArtifactDiagnostic['ledger']&{upstreamChargesDuplicated:false};state:'TESTED';
  };
  candidate:CapitalProgramRef;claims:M4Ref[];searchedDomain:M4Ref;independentWitnesses:M4Ref[];
  unresolved:M4Ref[];repairDependencies:M4Ref;result:'FAILURE_WITNESS'|'NO_WITNESS_WITHIN_BUDGET'|'BLOCKED';
  claimRecords:CandidateClaim[];witnessRecords:ValidatedCounterexample[];coverageGaps:CoverageGap[];
  domainRecord:OwnerArtifactDiagnostic['searchedDomain'];repairClosure:OwnerArtifactDiagnostic['repairDependencies'];
  coverage:OwnerArtifactDiagnostic['coverage'];ledger:OwnerArtifactDiagnostic['ledger'];
  parentResultRef:M4Ref|null;repairReplay:OwnerArtifactDiagnostic['repairReplay'];
}
export type SearchReport=OwnerArtifactDiagnostic|ChallengeResult;
export const reportWitnesses=(report:SearchReport)=>report.schema==='finnor.m4.challenge-result.v1'?report.witnessRecords:report.witnesses;
export const reportClaims=(report:SearchReport)=>report.schema==='finnor.m4.challenge-result.v1'?report.claimRecords:report.claims;
export interface OwnerArtifactDiagnostic extends ProducerEnvelope {
  schema:'finnor.m4.owner-artifact-diagnostic.v1';ref:M4Ref;target:{sliceRef:ExperimentRef;ownerRefs:ExperimentRef[]};
  claims:CandidateClaim[];searchedDomain:{ref:M4Ref;definition:DiagnosticRequest['domain'];globalAbsenceClaimsPermitted:false};
  witnesses:ValidatedCounterexample[];unresolved:CoverageGap[];
  repairDependencies:{ref:M4Ref;regions:DecisionNode[];claimRefs:M4Ref[];ownerRefs:ExperimentRef[];
    faultGraphRef:M4Ref;sourceSliceGraphRef:ExperimentRef;
    affectedUses:string[];request:'OWNER_REPAIR_OR_S4_FALLBACK';authorityGranted:false};
  result:'FAILURE_WITNESS'|'NO_WITNESS_WITHIN_BUDGET'|'BLOCKED';
  coverage:{generatedCells:number;checkedCells:number;invalidCells:number;unresolvedCells:number;
    totalDeclaredCells:number;untestedCells:number;completeFiniteDeclaredCells:boolean;unrestrictedCompleteness:false};
  ledger:{trials:number;attempts:number;cpuUserMicros:number;cpuSystemMicros:number;wallMs:number;
    rssBeforeBytes:number;rssAfterBytes:number;measurementScope:'PROCESS_INTERVAL_NOT_AGGREGATE_OS';
    unknownAttemptCosts:boolean;usd:null;modelCalls:0};
  parentResultRef:M4Ref|null;repairReplay:Array<{witnessRef:M4Ref;outcome:string;scopeChange:string|null}>;
}
/** Read-only reconstruction, not a late result publication or a ChallengeResult. */
export interface RetainedPartialEvidence {
  schema:'finnor.m4.retained-partial-evidence.v1';ref:M4Ref;searchId:string;
  candidateIdentity:string;contextDigest:string;result:'FAILURE_WITNESS'|'BLOCKED';
  acceptedChecks:Array<{eventId:string;retainedAt:string;proposal:Proposal;validation:Validation}>;
  incomplete:true;published:false;currentUsePermitted:false;effectReexecution:false;
  unresolved:CoverageGap[];
}
export class ChallengeError extends Error{
  constructor(readonly code:'INVALID_REQUEST'|'UNAVAILABLE'|'STALE_INPUT'|'CONFLICT'|'LIMIT_EXCEEDED'|'CANCELLED'|
    'CHECK_FAILED'|'CONFIGURATION_REQUIRED'|'PENDING_M3_READER',message:string){super(message);this.name='ChallengeError';}
}
export const unavailable=()=>new ChallengeError('UNAVAILABLE','Permitted challenge resource is unavailable');
/** Bound direct callers as well as wire JSON before Zod walks an adversarial graph. */
export function assertBounded(value:unknown,maxBytes=65536):void{
  const seen=new Set<object>(),pending:Array<{v:unknown;depth:number}>=[{v:value,depth:0}];let count=0;
  while(pending.length){const {v,depth}=pending.pop()!;if(++count>20000||depth>24)throw new ChallengeError('LIMIT_EXCEEDED','Challenge decoding envelope exceeded');
    if(v&&typeof v==='object'){if(seen.has(v))throw new ChallengeError('INVALID_REQUEST','Cyclic or aliased challenge data');seen.add(v);
      const entries=Object.entries(v);if(entries.length>2048)throw new ChallengeError('LIMIT_EXCEEDED','Challenge member envelope exceeded');
      for(const [key,child]of entries){if(['__proto__','prototype','constructor'].includes(key))throw new ChallengeError('INVALID_REQUEST','Reserved challenge field');pending.push({v:child,depth:depth+1});}}
    if(typeof v==='number'&&!Number.isFinite(v))throw new ChallengeError('INVALID_REQUEST','Nonfinite challenge quantity');
  }
  if(Buffer.byteLength(JSON.stringify(value))>maxBytes)throw new ChallengeError('LIMIT_EXCEEDED','Challenge byte envelope exceeded');
}
