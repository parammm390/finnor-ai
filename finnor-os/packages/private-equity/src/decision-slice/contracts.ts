import { z } from 'zod';
import type { BeliefView, BeliefViewPin, ContingentPolicy, InterventionModel, ExperimentRef,
  CanonicalAllocationProblem, AllocationCertificate, EvidenceDerivation } from '@finnor/shared-types';
import type { UnderwritingModelIR, UnderwritingInputSnapshot } from '@finnor/underwriting';
import type { InterventionControlSnapshot } from '../../../epistemic-runtime/src/intervention-control';
import type { AllocationSnapshot } from '../allocation-store';
import { epistemicHash } from '../../../epistemic-runtime/src/source-precedence';
import { EvidenceUnderwritingBindingSchema } from '../evidence-execution/consumer';

export const M1_VERSION = 'm1-exact-dependency-v1';
const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const RefSchema = z.object({owner:z.string().min(1).max(128),id:z.string().min(1).max(512),
  version:z.string().min(1).max(128),contentDigest:digest}).strict();
const instant = z.string().datetime({offset:true});
export const ResourceSchema = z.object({
  deadlineMs:z.number().int().min(1).max(30000),
  maxNodes:z.number().int().min(1).max(10000),
  maxBytes:z.number().int().min(1024).max(8*1024*1024),
  maxDemands:z.number().int().min(1).max(128),
}).strict();
const UnderwritingSourceSchema = z.object({kind:z.literal('UNDERWRITING'),investmentCaseId:uuid,
  modelVersionId:uuid,scenarioIds:z.array(uuid).max(16).optional(),worldAt:instant.optional(),
  evidenceDerivationInputs:z.record(z.string().min(1).max(240),EvidenceUnderwritingBindingSchema)
    .refine(value=>Object.keys(value).length<=16,'At most16 P4 inputs').optional()}).strict();
const PolicySourceSchema = z.object({kind:z.literal('POLICY'),policyRefs:z.array(RefSchema).min(1).max(16),
  incumbentRef:RefSchema.nullable().optional(),allocationRef:RefSchema.nullable().optional()}).strict();
const AllocationSourceSchema = z.object({kind:z.literal('ALLOCATION'),allocationRef:RefSchema}).strict();
export const RequestSchema = z.object({
  schema:z.literal('finnor.decision-slice-request.v1'),workId:uuid,
  source:z.discriminatedUnion('kind',[UnderwritingSourceSchema,PolicySourceSchema,AllocationSourceSchema]),
  purpose:z.enum(['MODEL_EVIDENCE','ACQUISITION','FINANCING']),
  financingChange:z.boolean().optional(),validAt:instant.optional(),knowledgeAt:instant.optional(),
  resource:ResourceSchema,
}).strict();
export type DecisionSliceRequest = z.infer<typeof RequestSchema>;
export type DecisionSource = DecisionSliceRequest['source'];
export type M1Ref = ExperimentRef & {owner:'M1';version:typeof M1_VERSION};
export const m1Ref = (kind:string,value:unknown):M1Ref => {
  const contentDigest=epistemicHash(value);
  return {owner:'M1',id:`${kind}:${contentDigest}`,version:M1_VERSION,contentDigest};
};
export const copyJson = <T>(value:T):T => JSON.parse(JSON.stringify(value));
export const same = (a:unknown,b:unknown):boolean => epistemicHash(a)===epistemicHash(b);

export class DecisionSliceError extends Error {
  constructor(readonly code:'INVALID_REQUEST'|'UNAVAILABLE'|'STALE_INPUT'|'LIMIT_EXCEEDED'|'CONFLICT'|'CANCELLED'|'CHECK_FAILED'|'CONFIGURATION_REQUIRED',
    readonly message:string) { super(message);this.name='DecisionSliceError'; }
}
export const unavailable = () => new DecisionSliceError('UNAVAILABLE','Permitted decision context is unavailable');
export const assertBounded = (value:unknown,maxBytes=8*1024*1024):void => {
  if(Buffer.byteLength(JSON.stringify(value))>maxBytes)throw new DecisionSliceError('LIMIT_EXCEEDED','Decision object exceeds its byte envelope');
};
export interface WorkBinding {
  id:string;inputId:string;inputDigest:string;status:string;ref:{owner:'@finnor/db';id:string;version:string;contentDigest:string};
}
export interface UnderwritingBinding {
  candidateId:string;modelRef:ExperimentRef;scenarioRef:ExperimentRef|null;definition:UnderwritingModelIR;
  modelDigest:string;input:UnderwritingInputSnapshot;
  inputQualifications:Array<{nodeId:string;status:string;reasons:string[];witnesses:unknown[]}>;
}
export interface PolicyBinding {
  policy:ContingentPolicy;model:InterventionModel;kernel:InterventionControlSnapshot;
}
export interface Gap {
  id:string;code:string;status:'UNKNOWN'|'CONTRADICTORY'|'PENDING_DEPENDENCY'|'INSUFFICIENT_COVERAGE'|'UNSUPPORTED';
  affectedRoots:string[];requirement:string;requiredProducer:'S1'|'S2'|'S3'|'S4'|'S5'|'P4';
}
export interface NativeBinding {
  schema:'finnor.m1.native-binding.v1';tenantId:string;principalId:string;request:DecisionSliceRequest;
  work:WorkBinding;views:BeliefView[];underwriting:UnderwritingBinding[];policies:PolicyBinding[];p4:EvidenceDerivation[];
  allocation:{problem:CanonicalAllocationProblem;certificate:AllocationCertificate;reservationRef:ExperimentRef|null}|null;
  resourceSnapshot:AllocationSnapshot|null;
  obligations:Array<{id:string;digest:string;status:string}>;
  gaps:Gap[];dependencyVector:Array<{key:string;digest:string}>;
  validUntil:string;qualifications:string[];
}
export type NodeKind = 'NATIVE_VARIABLE'|'OWNER_OBJECT'|'STATE'|'EXPOSURE'|'JOINT_INTERACTION'|'RESOURCE'|'COVENANT'|
  'OUTSTANDING_COMMITMENT'|'OBLIGATION'|'AUTHORITY'|'CONTRACTUAL'|'TIMING'|'OBSERVATION'|'MODEL_ASSUMPTION';
export interface DecisionNode {
  id:string;nativeId:string;kind:NodeKind;candidateId:string|null;ownerRef:ExperimentRef;
  unit:string|null;currency:string|null;periods:unknown[];definitionDigest:string;
  qualification:string;status:string;
}
export interface DecisionEdge {
  from:string;to:string;kind:'COMPUTATIONAL'|'MODEL_RELATIVE_RESPONSE'|'CONTRACTUAL'|'OBSERVATIONAL'|'OWNER_CURRENTNESS'|'PROVENANCE';
  expressionDigest:string;lagPeriods:number|null;
}
export interface DecisionGraph {
  schema:'finnor.decision-dependency-graph.v1';bindingDigest:string;nodes:DecisionNode[];
  edges:DecisionEdge[];roots:Array<{id:string;criterion:string;hard:boolean}>;
  solverGroups:Array<{id:string;members:string[];semantics:unknown;status:string}>;
  gaps:Gap[];ref:M1Ref;
}
export interface ProjectionWitness {
  schema:'finnor.m1.exact-projection-witness.v1';bindingDigest:string;graphDigest:string;rootIds:string[];
  retainedIds:string[];omittedIds:string[];method:'COMPLETE_DECLARED_BACKWARD_CLOSURE';
  uncertaintyDomain:'SUPPLIED_NATIVE_MODELS_AND_RECORDED_OWNER_OBJECTS';
  numericalLossBound:null;projectionBudgetRef:null;
  limitations:string[];
}
export interface ProjectionCheck {
  schema:'finnor.m1.projection-check.v1';status:'CHECKED'|'REJECTED';reasons:string[];
  witnessDigest:string;checker:'M1_SEPARATE_DECLARED_GRAPH_CHECKER_V1';
  exactPreservation:boolean;independentlyAdmitted:false;executionAuthorityGranted:false;
}
export interface ProjectionInput {binding:NativeBinding;graph:DecisionGraph}
export interface EvidenceDemand {
  schema:'finnor.decision-evidence-demand.v1';ref:M1Ref;tenantId:string;principalId:string;
  work:WorkBinding;candidateId:string|null;variableIds:string[];affectedRoots:string[];
  requiredProducer:'NATIVE'|'P4'|'S1'|'S2'|'S3'|'S4'|'S5';
  protocol:'NATIVE_OWNER_READ_V1'|'finnor.evidence-request.v1'|'OWNER_CONTRACT_REQUEST_V1';
  semantics:{entityRefs:unknown[];consolidation:string;periods:unknown[];unit:string|null;currency:string|null;
    scale:string;instrument:string;sourceStanding:string;coverage:string};
  permittedOperations:string[];pins:BeliefViewPin[];
  deadlineAt:string;resource:DecisionSliceRequest['resource'];
  status:'NATIVE_RESOLVED'|'P4_RESOLVED'|'UNKNOWN'|'CONTRADICTORY'|'PENDING_DEPENDENCY'|'INSUFFICIENT_COVERAGE'|'UNSUPPORTED';
  reason:string;nativeWitnessRefs:unknown[];execution?:{operation:'evidence-read';queryId:string;derivationId:string;output:string};
}
export interface ContextRevision {
  schema:'finnor.m1.working-context.v1';ref:M1Ref;parentRef:M1Ref|null;sliceDigest:string;
  revision:number;qualifiedDigest:string;
  verifiedRefs:Array<{variableId:string;ownerRef:ExperimentRef;status:string}>;
  estimates:Array<{variableId:string;qualification:string}>;
  contradictions:unknown[];unresolved:Gap[];selectedHandles:string[];
  notes:string[];agenda:string[];patchDigest:string|null;
}
export interface DecisionSlice {
  schema:'finnor.decision-slice.v1';ref:M1Ref;
  envelope:{
    tenantId:string;principalId:string;sharingScope:'PRIVATE_PRINCIPAL';work:WorkBinding;
    mandateRefs:ExperimentRef[];allowedChangeEnvelopeRef:WorkBinding['ref']|null;
    parents:ExperimentRef[];inputDigest:string;validAt:string;knowledgeAt:string;validUntil:string;
    rights:BeliefView['rights'][];ownerVector:NativeBinding['dependencyVector'];producerVersion:typeof M1_VERSION;
    sourceDigests:Array<{path:string;sha256:string}>;runtime:{nodeVersion:string;platform:string;architecture:string;imageAttestation:null};
    invocationRef:M1Ref;computeAllocationRef:null;cost:{money:null;status:'UNMETERED';accountingDestination:'M1_PRIVATE_PREPARED_ATTEMPT';
      upstreamComputeRefs:string[];upstreamChargesDuplicated:false;
      upstreamP4:Array<{derivationRef:ExperimentRef;queryId:string;jobId:string;deliveryAttemptId:string;
        sourceAcquisitionReceipts:unknown[];nativeExecutionReceipts:unknown[];unreconciledAttemptIds:string[];
        accountingOwner:'P4';countedAsNewM1Work:false;usd:null;status:'LOCAL_COST_UNMETERED'}>};
    admission:{status:'BLOCKED_EXTERNAL';receipt:null};state:'PROPOSED_TESTED';executionAuthorityGranted:false;
  };
  policyRequest:{ref:M1Ref;kind:'NATIVE_S4_POLICY_REQUEST'|'WORK_NUMERICAL_REQUEST_S4_MANDATE_UNAVAILABLE';mandateRefs:ExperimentRef[];candidateRefs:ExperimentRef[];incumbentRefs:ExperimentRef[]};
  candidateDependencies:DecisionGraph;
  materialVariables:DecisionNode[];derivedEvidence:Array<{producer:'NATIVE'|'P4';ownerRef:ExperimentRef;qualification:string;inputDigest:string}>;
  workingContext:{seedRef:M1Ref;qualifiedDigest:string};
  inquirySuggestions:Array<{schema:'finnor.m1.s2-protocol-suggestion.v1';premiseId:string;affectedRoots:string[];requirement:string;
    status:'PROPOSED_ONLY';measurementLaw:null;exposureGranted:false;selectionOwner:'S4'}>;
  projectionLoss:null;projectionLossReason:string;
  projectionBudgetRequest:{schema:'finnor.m1.s4-projection-budget-request.v1';mandateRefs:ExperimentRef[];
    requestedContract:string[];authorizationGranted:false};
  projectionSupport:{status:'EXACT_DEPENDENCY_PRESERVATION';witness:ProjectionWitness;check:ProjectionCheck};
  evidenceDemands:EvidenceDemand[];unresolvedCoverage:Gap[];
  fullEvidenceHandles:{ref:M1Ref;views:Array<{root:BeliefView['root'];pin:BeliefViewPin;ownerViewRef:string;coverage:BeliefView['coverage']}>;
    retrievalOperation:'belief-view';allPermittedSourcesAccessibleByOwner:true;globalAbsenceClaimsPermitted:false;
    p4:Array<{ownerRef:ExperimentRef;queryId:string;retrievalOperation:string;handles:EvidenceDerivation['sourceHandles']}>};
  limitations:string[];
}
export const PatchSchema=z.object({
  notes:z.array(z.string().max(2000)).max(32).optional(),
  agenda:z.array(z.string().max(512)).max(32).optional(),
  selectedHandles:z.array(z.string().min(1).max(1024)).max(128).optional(),
}).strict().refine(p=>Object.keys(p).length>0,'A presentation patch must change a permitted field');
export const p4Ref=(derivation:EvidenceDerivation):ExperimentRef=>({
  owner:'P4',id:derivation.id,version:derivation.code.version,contentDigest:epistemicHash(derivation),
});
