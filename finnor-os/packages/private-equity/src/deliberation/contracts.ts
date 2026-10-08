import {z} from 'zod';
import {FinancialSemanticsSchema,EvidenceRootSchema} from '@finnor/shared-types';
import {ComputeSearchRequestSchema} from '../compute-search/contracts';
export const M2_VERSION='m2-bounded-deliberation-v1';
export const RefSchema=z.object({owner:z.string().min(1).max(128),id:z.string().min(1).max(512),version:z.string().min(1).max(128),contentDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const SourceInspectionSchema=z.object({sourceId:z.string().uuid(),versionId:z.string().uuid(),contentDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const DeliberationRequestSchema=ComputeSearchRequestSchema.omit({schema:true,deliberation:true}).extend({schema:z.literal('finnor.deliberation-request.v1'),valueEvidenceRef:RefSchema.nullable().default(null),sourceInspectionRef:SourceInspectionSchema.nullable().default(null)}).strict();
export const CalibrationRequestSchema=z.object({root:EvidenceRootSchema,workId:z.string().uuid(),policyRequest:RefSchema,sourceId:z.string().uuid(),versionId:z.string().uuid(),datasetDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const DeliberationEvidenceReadSchema=z.object({searchId:z.string().uuid(),ref:RefSchema}).strict();
const fileDigest=z.object({file:z.string().min(1).max(256),digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const ExecutableModuleV1Schema=z.object({
 schema:z.literal('finnor.m2.executable-module.v1'),source:z.string().max(65536),sourceDigest:z.string().length(64),
 emitted:z.string().max(131072),emittedDigest:z.string().length(64),entrypoint:z.literal('deliberate'),producerCodeDigest:z.string().length(64),
 compiler:z.object({name:z.literal('typescript'),version:z.string().max(80),implementationDigest:z.string().length(64),optionsDigest:z.string().length(64),libraries:z.array(fileDigest).max(256),librariesDigest:z.string().length(64),diagnostics:z.array(z.string()).max(0)}).strict(),
 runtime:z.object({node:z.string().max(80),binaryDigest:z.string().length(64),imageDigest:z.null(),kind:z.literal('REGISTERED_BOUNDED_VM_NO_PROTECTED_ISOLATION')}).strict(),
 config:z.object({maxUnits:z.literal(8),maxParallel:z.literal(2),maxChains:z.literal(256),executionTimeoutMs:z.literal(25),maxRuns:z.literal(32),maxInputBytes:z.literal(65536),maxOutputBytes:z.literal(131072)}).strict(),
 featureSchema:z.literal('finnor.m2.module-snapshot.v2'),estimatorVersion:z.literal('m2-stratified-eventual-loss-v1'),estimatorConfigDigest:z.string().length(64),hostSourceDigests:z.array(fileDigest).max(16),producerAdmission:z.null(),
}).strict();
export const CurrentExecutableModuleBodySchema=ExecutableModuleV1Schema.extend({
 schema:z.literal('finnor.m2.executable-module.v2'),
 config:ExecutableModuleV1Schema.shape.config.extend({controlUnitLifecycle:z.literal('BOUNDED_EPISODE_CONTINUATION')}).strict(),
}).strict();
// Historical v1 bodies remain readable as evidence, not executable under a v2
// current binding. Admission always compares the actual current module ref.
export const ExecutableModuleBodySchema=z.union([ExecutableModuleV1Schema,CurrentExecutableModuleBodySchema]);
export const DeliberationModuleReaderSchema=z.object({ref:RefSchema,body:ExecutableModuleBodySchema}).strict();
const unit=z.object({id:z.string().uuid(),kind:z.enum(['EXECUTE_P1','VERIFY_P1','MODEL_REFINE','INSPECT_SOURCE']),status:z.enum(['PENDING','QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED','UNKNOWN']),prerequisites:z.array(z.string().uuid()).max(8),mechanism:z.string().min(1).max(256),steps:z.number().int().min(0).max(4096),durationMs:z.number().finite().nonnegative().nullable(),correlationGroup:z.string().max(128)}).strict();
const probability=z.number().finite().min(0).max(1).nullable();
export const ModuleValueModelSchema=z.object({
 ref:RefSchema,datasetDigest:z.string().length(64),configDigest:z.string().length(64),
 estimatorVersion:z.literal('m2-stratified-eventual-loss-v1'),
 objectiveRef:RefSchema,lossUnit:z.string().max(128),
 scope:z.literal('PUBLIC_FINITE_MECHANICS_UNADMITTED'),fieldRoutingAdmitted:z.literal(false),
 bins:z.array(z.object({
  key:z.string().max(600),mechanism:z.enum(['EXECUTE_CHECK_CHAIN','UNVERIFIED_EXECUTION']),
  beforeLoss:z.number().finite().nullable(),predictedGain:z.number().finite().nullable(),
  completionProbability:probability,acceptanceProbability:probability,
  meanElapsedMs:z.number().finite().nonnegative().nullable(),
  qualifiedPublicDiagnostic:z.boolean(),population:z.number().int().min(0).max(256),
  calibrationPopulation:z.number().int().min(0).max(256),
  intervals:z.array(z.object({level:z.number().finite().min(0).max(1),radius:z.number().finite().nonnegative().nullable()}).strict()).max(4),
 }).strict()).max(2),
}).strict();
export const ModuleSnapshotSchema=z.object({units:z.array(unit).max(8),incumbentQualified:z.boolean(),lossGap:z.number().finite().nonnegative().max(1e9).nullable(),nativeAttemptCost:z.number().finite().nonnegative().nullable(),delayMsCost:z.number().finite().nonnegative().nullable(),remainingAttempts:z.number().int().min(0).max(8),remainingMs:z.number().finite().max(3600000),maxParallel:z.number().int().min(1).max(2),strategy:z.enum(['ADAPTIVE','FIXED_SEQUENTIAL','FIXED_WIDE']),active:z.number().int().min(0).max(8),sourceObligation:z.boolean(),sourcePremiseChanged:z.boolean(),unknownAttempt:z.boolean(),valueModel:ModuleValueModelSchema.nullable()}).strict();
const chain=z.object({
 unitIds:z.array(z.string().uuid()).max(8),conditionalGain:z.number().finite().nullable(),
 incrementalCost:z.number().finite().nonnegative().nullable(),delayLoss:z.number().finite().nonnegative().nullable(),
 netUpper:z.number().finite().nullable(),completionProbability:probability,acceptanceProbability:probability,
 expectedGain:z.number().finite().nullable(),expectedNet:z.number().finite().nullable(),
 gainInterval:z.object({lower:z.number().finite(),upper:z.number().finite(),nominalCoverage:z.literal(.9),kind:z.literal('EMPIRICAL_PUBLIC_RESIDUAL_DIAGNOSTIC')}).strict().nullable(),
 futureControllerCalls:z.number().int().min(0).max(8),
 predictedCompletionDelayMs:z.number().finite().nonnegative().nullable(),
 costSupport:z.literal('KNOWN_NATIVE_MINIMUM_FORWARD_CONTROLLER_TIME_AND_BILLING_UNKNOWN'),
 support:z.enum(['PUBLIC_MODEL_RELATIVE_DIAGNOSTIC','UNAVAILABLE']),
}).strict();
export const ModuleProposalSchema=z.object({schema:z.literal('finnor.m2.module-proposal.v1'),selectedUnitIds:z.array(z.string().uuid()).max(2),chains:z.array(chain).max(256),visited:z.number().int().min(1).max(256),parallel:z.number().int().min(1).max(2),stop:z.boolean(),ownerWait:z.boolean(),reason:z.string().max(160).nullable(),heuristic:z.boolean(),boundUpper:z.number().finite().nullable(),selection:z.enum(['CHECK_BOTTLENECK_DISTINCT_MECHANISM_HEURISTIC','EXHAUSTIVE_FINITE_CONDITIONAL_CHAIN_UPPER_BOUND','PUBLIC_DIAGNOSTIC_EVENTUAL_LOSS_SELECTION']),completionAndAcceptanceAreSeparate:z.literal(true),opinionCountIsInformation:z.literal(false),businessSelectionOwner:z.literal('S4')}).strict();
const ModuleRunV1Schema=z.object({
 schema:z.literal('finnor.m2.module-run.v1'),id:z.string().uuid(),executed:z.literal(true),
 moduleDigest:z.string().regex(/^[a-f0-9]{64}$/),input:ModuleSnapshotSchema,inputDigest:z.string().regex(/^[a-f0-9]{64}$/),
 output:ModuleProposalSchema,outputDigest:z.string().regex(/^[a-f0-9]{64}$/),elapsedMs:z.number().finite().nonnegative(),cpuMicros:z.number().finite().nonnegative(),
 runtime:ExecutableModuleV1Schema.shape.runtime,configDigest:z.string().regex(/^[a-f0-9]{64}$/),compilerDigest:z.string().regex(/^[a-f0-9]{64}$/),
 costUSD:z.null(),stepCharge:z.number().int().min(1).max(256),qualification:z.literal('EXECUTED_REGISTERED_VM_PROPOSAL_P2_MUST_ADMIT_NO_AUTHORITY'),
}).strict();
export const CurrentModuleRunReceiptSchema=ModuleRunV1Schema.extend({
 schema:z.literal('finnor.m2.module-run.v2'),
 execution:z.object({
  attemptId:z.string().uuid(),deliveryAttemptId:z.string().uuid(),jobId:z.string().uuid(),
  // PostgreSQL bigint claim fences are strings in actual queue deliveries.
  claimFence:z.union([z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),z.string().regex(/^[1-9][0-9]{0,18}$/)]),
  unitId:z.string().uuid(),unitBodyDigest:z.string().regex(/^[a-f0-9]{64}$/),unitInvocation:z.number().int().min(1).max(32),
  originalEpisode:z.string().uuid(),originalDeadlineAt:z.string().datetime({offset:true}),controlUnitLifecycle:z.literal('BOUNDED_EPISODE_CONTINUATION'),
 }).strict(),
}).strict();
export const ModuleRunReceiptSchema=z.union([ModuleRunV1Schema,CurrentModuleRunReceiptSchema]);
const value=z.object({value:z.string().max(2048),semantics:FinancialSemanticsSchema,truthClass:z.literal('DERIVED_VALUE'),witnessIds:z.array(z.string().max(512)).max(16000)}).strict();
const check=z.object({id:z.string().max(256),method:z.literal('POSTGRES_NUMERIC_ACCEPTED_EXPRESSION'),status:z.enum(['PASS','FAIL']),expected:z.string().max(2048),actual:z.string().max(2048).nullable(),unit:z.string().max(128),currencyCode:z.string().nullable(),qualification:z.literal('FINITE_ACCEPTED_EXPRESSION_NOT_BUSINESS_PREMISE_OR_SEALED_EVALUATION')}).strict();
const incumbent=z.object({moduleId:z.string().max(128),unitId:z.string().uuid(),values:z.record(value).refine(v=>Object.keys(v).length<=16),checks:z.array(check).min(1).max(32),sourceResultDigest:z.string().length(64),inputDigest:z.string().length(64),acceptanceDigest:z.string().length(64)}).strict();
const envelope=z.object({schema:z.literal('finnor.m2.producer-envelope.v1'),id:z.string().uuid(),revision:z.number().int().positive(),tenantId:z.string().uuid(),principalId:z.string().uuid(),work:z.object({id:z.string().uuid(),revision:z.string().uuid(),inputDigest:z.string().length(64),planRevisionId:z.string().uuid()}).strict(),mandateRef:RefSchema,parents:z.array(RefSchema).max(8),inputs:z.array(z.object({kind:z.string().max(80),digest:z.string().length(64),knownAt:z.string().datetime({offset:true})}).strict()).max(16),rightsRef:z.string().max(512),ownerRevisionVector:z.array(z.object({owner:z.string().max(80),ref:RefSchema}).strict()).max(16),producerAdmission:z.null(),executionAuthorityGranted:z.literal(false),codeDigest:z.string().length(64),runtime:z.object({node:z.string().max(80),binaryDigest:z.string().length(64),imageDigest:z.null(),kind:z.literal('REGISTERED_BOUNDED_VM_NO_PROTECTED_ISOLATION')}).strict(),actualInvocations:z.array(RefSchema).max(32),domain:z.string().max(256),invalidationKeys:z.array(z.string().max(512)).max(256),currentGrant:RefSchema,costLedger:z.object({owner:z.literal('P2'),searchId:z.string().uuid(),physicalAttempts:z.number().int().nonnegative(),controllerRuns:z.number().int().min(0).max(32),usd:z.null()}).strict(),state:z.enum(['PROPOSED','TESTED','ADMITTED','INVALIDATED','FAILED'])}).strict();
const prediction=z.object({lossUnit:z.string().max(128),expectedGain:z.number().finite().nullable(),conditionalGain:z.number().finite().nullable(),completionProbability:probability,acceptanceProbability:probability,knownNativeCost:z.number().finite().nonnegative().nullable(),delayLoss:z.number().finite().nonnegative().nullable(),completionDelayMs:z.number().finite().nonnegative().nullable(),costUSD:z.null(),support:z.enum(['PUBLIC_MODEL_RELATIVE_DIAGNOSTIC','FINITE_CONDITIONAL_ONLY','UNAVAILABLE']),evidenceRef:RefSchema.nullable(),nonadditiveChain:z.literal(true)}).strict();
export const BoundedWorkUnitSchema=z.object({
 unitId:z.string().uuid(),kind:z.enum(['CONTROL_M2','EXECUTE_P1','VERIFY_P1','MODEL_REFINE','INSPECT_SOURCE']),meaning:z.string().max(256),prerequisites:z.array(z.string().uuid()).max(8),owner:z.literal('P2'),routeIds:z.array(z.string().max(64)).max(4),
 target:z.object({programmeRef:RefSchema,root:EvidenceRootSchema,sourceInspectionRef:SourceInspectionSchema.nullable()}).strict(),
 inputs:z.object({workRevision:z.string().uuid(),inputDigest:z.string().length(64),sourceResultDigest:z.string().length(64),acceptanceDigest:z.string().length(64),utilityRef:RefSchema,valueEvidenceRef:RefSchema.nullable(),moduleRef:RefSchema.nullable()}).strict(),
 expectedResult:z.object({kind:z.enum(['MODULE_PROPOSAL','NUMERICAL_VALUES','INDEPENDENT_ACCEPTANCE_CHECKS','NATIVE_MODULE_PROPOSAL','SOURCE_OBJECT_INSPECTION']),outputKeys:z.array(z.string().max(128)).max(16),qualification:z.string().max(256)}).strict(),
 checker:z.object({owner:z.enum(['P1','M2']),method:z.enum(['POSTGRES_NUMERIC_ACCEPTED_EXPRESSION','BOUNDED_TYPED_MODULE_PROPOSAL','EXACT_SOURCE_ENTITY_PERIOD_UNIT_DIGEST']),acceptanceDigest:z.string().length(64),independentlyAcceptedRequired:z.literal(true)}).strict(),
 resources:z.object({episodeId:z.string().uuid(),deadlineAt:z.string().datetime({offset:true}),maxAttempts:z.number().int().positive(),maxSteps:z.number().int().positive(),maxCandidates:z.number().int().positive(),maxUnits:z.number().int().min(2).max(8),maxParallel:z.number().int().min(1).max(2),selectedUnitSteps:z.number().int().min(1).max(4096),currentGrant:RefSchema,sourcePermissionsRef:z.string().max(512)}).strict(),
 admission:z.object({logicalState:z.enum(['QUEUED','RUNNING']),physicalState:z.string().max(32),attemptId:z.string().uuid().nullable(),producerAdmission:z.null(),executionAuthorityGranted:z.literal(false)}).strict(),
 estimate:prediction,
 correlation:z.object({premiseDigest:z.string().length(64),equivalenceGroup:z.string().length(64),independentPremises:z.literal(1),novelty:z.enum(['INDEPENDENT_NUMERICAL_CHECK','MATERIAL_SOURCE_QUERY','PROCEDURAL_ALTERNATIVE','UNVERIFIED_PROPOSAL','CONTROLLER_ONLY'])}).strict(),
 lifecycle:z.object({cancelPath:z.literal('/api/company-brain/deliberation-cancel'),reconcilePath:z.literal('/api/company-brain/deliberation-reconcile'),retry:z.literal('ORIGINAL_EPISODE_ONLY_RECONCILE_UNKNOWN_BEFORE_ANY_RETRY'),latePublication:z.literal('FENCED_COST_ONLY'),newBudgetGranted:z.literal(false)}).strict(),
}).strict();
const attemptHistory=z.object({attemptId:z.string().uuid(),unitId:z.string().uuid(),status:z.string().max(32),receiptDigest:z.string().length(64),chargedNativeAttempts:z.number().int().min(0).max(1),steps:z.number().int().nonnegative(),requestedRoute:z.string().max(128),requestedModel:z.string().max(128).nullable(),actualProvider:z.string().max(128).nullable(),actualModel:z.string().max(128).nullable(),usage:z.object({inputTokens:z.number().int().nonnegative(),outputTokens:z.number().int().nonnegative()}).strict().nullable(),elapsedMs:z.number().finite().nonnegative().nullable(),submittedAt:z.string().nullable(),physicalOutcome:z.string().max(80).nullable(),responsibility:z.enum(['AWAIT_RETURN','RECONCILE_UNKNOWN','RETAIN_USAGE_AND_RECONCILE_BILLING']),liabilityRetained:z.literal(true),refundGranted:z.literal(false),costUSD:z.null(),invoiceRef:z.null(),corrections:z.array(RefSchema).max(32)}).strict();
const preparation=z.object({ref:RefSchema,kind:z.enum(['M2_REGISTERED_SEMANTIC_COMPILATION','BOUNDED_PUBLIC_DEVELOPMENT_FIT_CALIBRATION_AND_EVALUATION']),elapsedMs:z.number().finite().nonnegative(),cpuMicros:z.number().finite().nonnegative(),costUSD:z.null(),chargedAsEpisodeAttempt:z.literal(false),accounting:z.literal('SHARED_OR_DEVELOPMENT_PREPARATION_NONADDITIVE_NOT_S5_FUNDING')}).strict();
export const MissingOwnerRequestSchema=z.object({schema:z.literal('finnor.m2.missing-owner-request.v1'),owner:z.enum(['S4','S2','S5','S6','S8','M3','M4','M5']),work:envelope.shape.work,policyRequest:RefSchema,utilityRef:RefSchema,mandateRef:RefSchema,originalComputeGrant:RefSchema,resourceRef:RefSchema,sourceRef:SourceInspectionSchema.nullable(),sourceResultDigest:z.string().length(64).nullable(),inputDigest:z.string().length(64).nullable(),metacontroller:RefSchema,domain:z.string().max(256),required:z.string().max(320),actualOwnerPort:z.string().max(256).nullable(),observedContract:z.object({commit:z.string().regex(/^[a-f0-9]{40}$/),tree:z.string().regex(/^[a-f0-9]{40}$/),handoffSha256:z.string().length(64),status:z.string().max(128)}).strict().nullable(),observedObjectDigest:z.string().length(64).nullable(),operativeClause:z.object({id:z.string().max(128),text:z.string().max(4000),changesPremise:z.boolean()}).strict().nullable(),responseRef:z.null(),authorityGranted:z.literal(false),newFundingRequested:z.literal(false)}).strict();
const PolicyDraftSchema=z.object({schema:z.literal('finnor.deliberation-policy.v1'),ref:RefSchema,version:z.literal(M2_VERSION),status:z.string().max(32),envelope,
 policyRequest:RefSchema,computeGrant:RefSchema,
 frontier:z.array(z.object({candidateId:z.string().max(128),unitId:z.string().uuid(),kind:z.string().max(32),status:z.string().max(32),premiseDigest:z.string().length(64),moduleId:z.string().max(128).nullable(),prerequisites:z.array(z.string().uuid()).max(8),accepted:z.boolean(),support:z.enum(['INDEPENDENT_CURRENT_SQL_CHECK','UNVERIFIED','COST_ONLY']),completion:z.boolean(),resultDigest:z.string().length(64).nullable(),programmeRef:RefSchema,businessProgramRef:z.null(),challengeRef:z.null(),candidateRole:z.enum(['P1_PROCEDURE','M2_CONTROLLER','SOURCE_OBLIGATION']),equivalenceGroup:z.string().length(64),representation:z.string().max(80).nullable(),decisionLoss:z.object({unit:z.string().max(128),lower:z.number().finite().nullable(),upper:z.number().finite().nullable(),kind:z.enum(['OWNER_FINITE_ACCEPTED_OUTPUT_INTERVAL','UNAVAILABLE']),provenance:RefSchema.nullable(),fieldValueQualified:z.literal(false)}).strict(),independentChecks:z.array(check).max(32),unresolvedPremises:z.array(z.string().max(256)).max(16),remainingCosts:z.object({nativeAttemptsLower:z.number().int().min(0).max(1),costUSD:z.null(),delayLoss:z.number().finite().nonnegative().nullable(),priceStatus:z.literal('UNKNOWN_UNRECONCILED')}).strict()}).strict()).max(8),
 metacontroller:RefSchema,nextWork:z.array(BoundedWorkUnitSchema).max(8),marginalValueEvidence:z.array(RefSchema).max(32),incumbent:incumbent.nullable(),
 stop:z.object({heuristic:z.boolean(),reason:z.string().max(160).nullable(),technicalOnly:z.literal(true),businessSelectionOwner:z.literal('S4'),bound:z.object({upper:z.number().finite(),unit:z.string().max(256),scope:z.literal('PUBLIC_FINITE_ACCEPTED_OUTPUT_MECHANICS'),allAvailableChainsEnumerated:z.boolean(),evidenceRef:RefSchema}).strict().nullable(),remainingPredicates:z.array(z.string().max(256)).max(32)}).strict(),
 outstandingCosts:z.object({owner:z.literal('P2'),ledgerSearchId:z.string().uuid(),retained:z.literal(true),usd:z.null(),status:z.literal('UNKNOWN_UNRECONCILED'),physicalAttempts:z.number().int().nonnegative(),controllerRuns:z.number().int().nonnegative(),controllerElapsedMs:z.number().finite().nonnegative(),controllerCpuMicros:z.number().finite().nonnegative(),sunkUtilityCost:z.number().finite().nonnegative().nullable(),sunkChargedAgain:z.literal(false),attempts:z.array(z.object({attemptId:z.string().uuid(),unitId:z.string().uuid(),status:z.string().max(32),disposition:z.string().max(32),liabilityRetained:z.literal(true),mayRetry:z.literal(false),submittedAt:z.string().nullable(),endpointKey:z.string().nullable()}).strict()).max(32),history:z.array(attemptHistory).max(32),preparation:z.array(preparation).max(32),originalParentCostWitness:z.object({digest:z.string().length(64),attempts:z.number().int().nonnegative(),steps:z.number().int().nonnegative(),wallMs:z.number().finite().nonnegative(),nativeInvocationCount:z.number().int().nonnegative(),modelInvocationCount:z.number().int().nonnegative()}).strict(),accountingScope:z.literal('P2_ATTEMPTS_OVERLAP_P1_PARENT_NOT_SUMMED_PREPARATION_NONADDITIVE'),unknownCosts:z.array(z.string().max(128)).max(16),externalEffectOwner:z.literal('S6')}).strict(),
 utilityConversion:z.object({ref:RefSchema,unit:z.string().max(256),scope:z.literal('PUBLIC_FINITE_ACCEPTED_OUTPUT_MECHANICS'),lossWithoutQualifiedResult:z.number().finite(),lossWithQualifiedResult:z.number().finite(),nativeAttemptCost:z.number().finite().nonnegative(),controllerMsCost:z.number().finite().nonnegative(),delayMsCost:z.number().finite().nonnegative(),qualification:z.literal('SUPPLIED_MODEL_RELATIVE_UTILITY_NOT_BILLING_OR_FIELD_WEALTH')}).strict().nullable(),
 qualifications:z.array(z.string().max(256)).max(48)}).strict();
// Original reference types remain references. The bounded projection is a
// materialized current view whose component bytes are also persisted and read.
export const DeliberationPolicySchema=PolicyDraftSchema.omit({frontier:true,incumbent:true,stop:true,outstandingCosts:true}).extend({
 frontier:RefSchema,incumbent:RefSchema.nullable(),stop:RefSchema,outstandingCosts:RefSchema,ownerRequests:z.array(RefSchema).max(8),
 projection:z.object({frontier:PolicyDraftSchema.shape.frontier,incumbent:PolicyDraftSchema.shape.incumbent,stop:PolicyDraftSchema.shape.stop,outstandingCosts:PolicyDraftSchema.shape.outstandingCosts}).strict(),
}).strict();
export const DeliberationCurrentReaderSchema=z.object({
 schema:z.literal('finnor.m2.current-reader.v1'),searchId:z.string().uuid(),programId:z.string().uuid(),
 status:z.enum(['ACCEPTED','RUNNING','WAITING','STOPPED','FAILED','CANCELLED','INVALIDATED']),
 reason:z.string().max(160).nullable(),policy:DeliberationPolicySchema,planRef:RefSchema,protectedAdmission:z.literal(false),
}).strict();
export const DeliberationProjectionSchema=z.object({
 schema:z.literal('finnor.m2.work-projection.v1'),workId:z.string().uuid(),
 policies:z.array(DeliberationCurrentReaderSchema).max(20),
 eligiblePrograms:z.array(z.object({programId:z.string().uuid(),status:z.enum(['QUEUED','WAITING']),
  workRevision:z.string().uuid(),policyRequest:RefSchema,computeGrant:RefSchema}).strict()).max(20),
}).strict();
export type ModuleSnapshot=z.infer<typeof ModuleSnapshotSchema>;
export type ModuleProposal=z.infer<typeof ModuleProposalSchema>;
export type DeliberationPolicy=z.infer<typeof DeliberationPolicySchema>;
export function boundedObject(raw:unknown,maxBytes=65536){let nodes=0;const seen=new Set<object>(),todo:Array<[unknown,number]>=[[raw,0]];while(todo.length){const [v,d]=todo.pop()!;if(++nodes>8192||d>24)throw Error('M2_DECODER_BOUND');if(v&&typeof v==='object'){if(seen.has(v))throw Error('M2_CYCLIC_OR_SHARED_INPUT');seen.add(v);for(const x of Object.values(v))todo.push([x,d+1]);}}if(Buffer.byteLength(JSON.stringify(raw)??'')>maxBytes)throw Error('M2_BYTE_BOUND');}
