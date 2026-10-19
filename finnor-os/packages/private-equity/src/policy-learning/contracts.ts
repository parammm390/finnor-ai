import {z} from 'zod';
import {EvidenceRootSchema} from '@finnor/shared-types';
import {VReferenceSchema} from '../../../shared-types/src/primary-diligence';
import {applicationDigest,assertApplicationData,ApplicationFault} from '../enterprise-applications/contracts';

export const X5_PROFILE='PE_FIRM_DELAYED_RECONCILIATION_V1' as const;
export const X5_LIMITS=Object.freeze({records:256,samples:4096,eventsPerRecord:64,attempts:8,uses:256,storage:16*1024*1024,childWallMs:30000,childHeapMiB:256,childOutput:65536,ipcBytes:4*1024*1024});
export const FEATURE_ORDER=['bias','quantitiesKnown','exactDimensionalAgreement','observationsCurrent','noPendingEffect','initialState','reconciledState','acceptedState'] as const;
export const CONTROLLER_CLASSES=['WAIT','RECONCILE','REQUEST_INDEPENDENT_CHECK','STOP_ACCEPTED'] as const;
export const MODES=['COMPILED_ORIGINAL','COMPILED_TRAINED','NATIVE_EXACT','COMPILED_NO_NEURAL'] as const;
export type ControllerClass=typeof CONTROLLER_CLASSES[number];
export type ExecutionMode=typeof MODES[number];
export const sha=applicationDigest;
export const unknown=(reason:string)=>({kind:'UNKNOWN' as const,reason});
export function fail(code:string,status=409):never{throw new ApplicationFault(code,code,status);}
export function parse<S extends z.ZodTypeAny>(schema:S,value:unknown,maxBytes=128*1024):z.output<S>{
 assertApplicationData(value,maxBytes);return schema.parse(value);
}
const uuid=z.string().uuid(),hex=z.string().regex(/^[a-f0-9]{64}$/),instant=z.string().datetime({offset:true}),key=z.string().min(1).max(160);
export const FeaturesSchema=z.array(z.number().int().min(0).max(1)).length(8);
export const SampleSchema=z.object({features:FeaturesSchema,label:z.enum(CONTROLLER_CLASSES),evidenceDigest:hex}).strict();
export type StructuralSample=z.infer<typeof SampleSchema>;
export const CheckpointBodySchema=z.object({
 schema:z.literal('finnor.x5.controller-checkpoint.v1'),architecture:z.literal('LINEAR_SOFTMAX_F64_8X4_V1'),
 featureOrder:z.tuple([z.literal('bias'),z.literal('quantitiesKnown'),z.literal('exactDimensionalAgreement'),z.literal('observationsCurrent'),z.literal('noPendingEffect'),z.literal('initialState'),z.literal('reconciledState'),z.literal('acceptedState')]),
 classes:z.tuple([z.literal('WAIT'),z.literal('RECONCILE'),z.literal('REQUEST_INDEPENDENT_CHECK'),z.literal('STOP_ACCEPTED')]),
 weights:z.array(z.number().finite().min(-100).max(100)).length(32),
 preprocessing:z.literal('HOST_OBSERVED_STRUCTURAL_BOOLEANS_NO_IDENTIFIERS_OR_TEXT'),
 precision:z.literal('IEEE754_BINARY64'),license:z.literal('PROJECT_SOURCE_NO_EXTERNAL_WEIGHTS'),
}).strict();
export const CheckpointSchema=CheckpointBodySchema.extend({digest:hex}).strict();
export type Checkpoint=z.infer<typeof CheckpointSchema>;
export const PolicySchema=z.object({
 schema:z.literal('finnor.x5.bounded-policy.v1'),profile:z.literal(X5_PROFILE),
 input:z.literal('CURRENT_NATIVE_X3_RECORD_AND_FRESH_SEMANTIC_BINDING'),
 abstraction:z.literal('STRUCTURAL_BOOLEANS_8_V1'),instructions:z.tuple([
  z.literal('OBSERVE_CURRENT_OWNER_STATE'),z.literal('LOAD_EXACT_CONTROLLER'),z.literal('CLASSIFY'),
  z.literal('ENFORCE_NATIVE_PRECONDITIONS'),z.literal('DISPATCH_RECONCILIATION_OR_WAIT'),
  z.literal('REQUIRE_CURRENT_INDEPENDENT_ACCEPTANCE'),
 ]),
 operations:z.tuple([z.literal('X3_READ_CURRENT_RECORD'),z.literal('X3_EXACT_RECONCILIATION'),z.literal('X3_REQUEST_INDEPENDENT_APPROVAL')]),
 preconditions:z.tuple([z.literal('CURRENT_TENANT_PRINCIPAL_WORK_RIGHTS'),z.literal('COMPLETE_OBSERVATIONS'),z.literal('EXACT_DIMENSIONS'),z.literal('NO_PENDING_EFFECT'),z.literal('ORIGINAL_RESOURCES')]),
 postconditions:z.tuple([z.literal('MANDATORY_RECONCILIATION_PRECEDES_ACCEPTANCE'),z.literal('DISTINCT_CURRENT_NONAUTHOR_APPROVERS'),z.literal('NATIVE_EXACT_VALUES_UNCHANGED')]),
 guard:z.literal('CURRENT_CONSENT_AND_SOURCE_CLOSURE_AND_SUPPORTED_BINDING_AND_NATIVE_INTERPRETER'),
 failureMonitor:z.literal('NO_MODEL_AUTHORITY_NO_EFFECT_REPLAY_NO_FALSE_COMPLETION'),
 fallback:z.literal('CURRENT_NATIVE_X3_INTERPRETER_OR_WAIT_BLOCK_STOP_WITHIN_ORIGINAL_GRANT'),
 invalidation:z.literal('EVIDENCE_RIGHTS_PARTITIONS_POLICY_CHECKPOINT_OPERATIONS_CHECKER_RUNTIME_ADMISSION'),
 bounds:z.object({maxUses:z.number().int().min(1).max(256),deadlineAt:instant,childWallMs:z.literal(30000),childHeapMiB:z.literal(256)}).strict(),
}).strict();
export type BoundedPolicy=z.infer<typeof PolicySchema>;
export const ConsentBodySchema=z.object({
 schema:z.literal('finnor.x5.training-rights.v1'),applicationId:uuid,
 purposes:z.tuple([z.literal('TRAIN_STRUCTURAL_CONTROLLER'),z.literal('EXECUTE_DERIVED_POLICY')]),
 transfer:z.enum(['SOURCE_APPLICATION_ONLY','SAME_TENANT_COMPATIBLE_APPLICATIONS']),
 failures:z.literal('NONPOSITIVE_STRUCTURAL_OBSERVATIONS_ONLY'),
 data:z.literal('STRUCTURAL_BOOLEANS_ONLY_NO_TEXT_AMOUNTS_IDENTIFIERS_CREDENTIALS'),
 retention:z.literal('RETAIN_AUDIT_REVOKE_DERIVED_USE_NO_UNLEARNING_CLAIM'),
 knowledgeCut:instant,validUntil:instant,idempotencyKey:key,
}).strict();
export const ConsentRevokeSchema=z.object({consentId:uuid,reason:z.string().min(1).max(500),idempotencyKey:key}).strict();
export const SelectionSchema=z.object({applicationId:uuid,recordIds:z.array(uuid).min(1).max(256),consentId:uuid}).strict();
export type ExperienceSelection=z.infer<typeof SelectionSchema>;
export const SubmitSchema=z.object({
 schema:z.literal('finnor.x5.compile-request.v1'),root:EvidenceRootSchema,workId:uuid.optional(),workInputId:uuid.optional(),
 experience:z.array(SelectionSchema).min(1).max(16),knowledgeCut:instant,idempotencyKey:key,
 limits:z.object({deadlineMs:z.number().int().min(1000).max(3600000),maxAttempts:z.number().int().min(1).max(8),maxUses:z.number().int().min(1).max(256)}).strict(),
}).strict();
export const ReadSchema=z.object({compilationId:uuid}).strict();
export const ListSchema=z.object({root:EvidenceRootSchema,workId:uuid}).strict();
export const ControlSchema=ReadSchema.extend({reason:z.string().min(1).max(500),idempotencyKey:key}).strict();
export const RetrainSchema=ReadSchema.extend({
 experience:z.array(SelectionSchema).min(1).max(16),knowledgeCut:instant,reason:z.string().min(1).max(500),idempotencyKey:key,
}).strict();
export const RollbackSchema=ReadSchema.extend({releaseId:uuid,idempotencyKey:key}).strict();
export const AssignmentReferenceSchema=z.object({owner:z.literal('X5_ASSIGNMENT'),id:uuid,revision:z.literal('1'),contentDigest:hex}).strict();
export const AssignmentSchema=ReadSchema.extend({
 releaseId:uuid,caseId:z.string().regex(/^(F(0[1-9]|1[0-6])|R0[1-8]|C0[12]|N0[1-6])$/),
 replicas:z.array(z.object({mode:z.enum(MODES),applicationId:uuid,recordId:uuid}).strict()).length(4),idempotencyKey:key,
}).strict();
export const ExecuteSchema=ReadSchema.extend({
 releaseId:uuid,applicationId:uuid,recordId:uuid,expectedRevision:z.number().int().positive(),expectedReference:VReferenceSchema,
 mode:z.enum(MODES),idempotencyKey:key,
 stratum:z.enum(['TRANSFER','RETENTION','BOUNDARY']),assignmentRef:AssignmentReferenceSchema.optional(),
}).strict();
export const EvaluateSchema=ReadSchema.extend({releaseId:uuid,useIds:z.array(uuid).min(1).max(256),retainedUseIds:z.array(uuid).min(1).max(256),idempotencyKey:key}).strict();
export const AdmissionSchema=ReadSchema.extend({releaseId:uuid,controllerRevision:z.enum(['TRAINED','ORIGINAL_ABLATION']).default('TRAINED'),idempotencyKey:key}).strict();
export const CurrentSchema=ReadSchema.extend({releaseId:uuid,revisionRef:z.object({owner:z.string(),id:z.string(),version:z.string(),contentDigest:hex}).strict()}).strict();
export const JobSchema=z.discriminatedUnion('stage',[
 z.object({stage:z.literal('TRAIN'),tenantId:uuid,principalId:uuid,compilationId:uuid,generation:z.number().int().positive()}).strict(),
 z.object({stage:z.literal('EXECUTE'),tenantId:uuid,principalId:uuid,compilationId:uuid,generation:z.number().int().positive(),useId:uuid}).strict(),
 z.object({stage:z.literal('EVALUATE'),tenantId:uuid,principalId:uuid,compilationId:uuid,generation:z.number().int().positive(),evaluationId:uuid}).strict(),
]);
export type LearningJob=z.infer<typeof JobSchema>;
