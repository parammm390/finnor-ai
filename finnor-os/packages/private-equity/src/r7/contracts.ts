import { z } from 'zod';
import type { ExperimentRef, AllocationReservation, AllocationConsumption } from '../../../shared-types/src';
import type { AtlasOwnerInput, AtlasProjectedChoice, AtlasQueryDisposition, DecisionAtlas } from '../../../shared-types/src/decision-atlas';
import type { AllocationResource, AllocationOutstandingCommitment } from '../../../shared-types/src';
import type { ExactAllocationCheck } from './allocation';
import { EvidenceRootSchema } from '../../../shared-types/src/evidence-execution';
import { AtlasBudgetSchema, AtlasRefSchema, DEFAULT_ATLAS_BUDGET } from '../../../epistemic-runtime/src/policy-atlas/contracts';
import { rational } from '../../../epistemic-runtime/src/policy-atlas/exact';

export class R7Error extends Error {
  constructor(readonly code: 'UNAVAILABLE'|'STALE_INPUT'|'CONFLICT'|'UNSUPPORTED'|'LIMIT_EXCEEDED'|'CHECK_FAILED'|'CONFIGURATION_REQUIRED', message=code as string) {
    super(message); this.name='R7Error';
  }
}
export const r7Unavailable=()=>new R7Error('UNAVAILABLE','Current permitted atlas context is unavailable');
const key=z.string().min(1).max(200),uuid=z.string().uuid();
const rationalValue=z.string().max(170).refine(v=>{try{rational(v,256);return true;}catch{return false;}},'Canonical exact rational required');
const id=z.object({buildId:uuid}).strict();
export const R7EventCursorSchema=z.object({at:z.string().datetime({offset:true}),id:uuid}).strict();
export const RegisterSchema=z.object({workId:uuid,root:EvidenceRootSchema,evidenceVersionId:uuid,expectedFamilyRef:AtlasRefSchema.nullable()}).strict();
export const BuildSchema=z.object({
  envelope_inputs:z.object({familyRef:AtlasRefSchema}).strict(),problem_ref:AtlasRefSchema,
  existing_work_revision:uuid,domain_profile_ref:AtlasRefSchema,budget_grant_ref:AtlasRefSchema,cancellation_ref:AtlasRefSchema,
  budget:AtlasBudgetSchema.default(DEFAULT_ATLAS_BUDGET),idempotencyKey:key,
}).strict();
export const QuerySchema=id.extend({parameterRef:AtlasRefSchema,idempotencyKey:key,
  fallback:z.enum(['DEVELOPMENT_EXACT','REQUIRE_ADMITTED']).default('REQUIRE_ADMITTED')});
export const R7OperationClasses={
  register:'MUTATION',context:'READ',build:'MUTATION',read:'READ',status:'READ',cancel:'CONTROL',
  parameters:'MUTATION',query:'MUTATION',select:'MUTATION',continue:'MUTATION',
} as const;
export const OperationSchemas={
  register:RegisterSchema,
  context:z.object({workId:uuid,root:EvidenceRootSchema}).strict(),
  build:BuildSchema, read:id.extend({eventsAfter:R7EventCursorSchema.optional()}), status:id, cancel:id,
  parameters:z.object({familyRef:AtlasRefSchema,expectedRef:AtlasRefSchema,values:z.array(rationalValue).min(1).max(4)}).strict(),
  query:QuerySchema,
  select:id.extend({queryRef:AtlasRefSchema,idempotencyKey:key}),
  continue:z.object({consumptionRef:AtlasRefSchema,decision:z.unknown(),
    measurements:z.array(z.object({protocol:z.unknown(),events:z.array(z.unknown()).max(256)}).strict()).max(8).default([]),
    idempotencyKey:key}).strict(),
} satisfies Record<keyof typeof R7OperationClasses,z.ZodTypeAny>;
export type R7BuildRequest=z.infer<typeof BuildSchema>;
export type R7QueryRequest=z.infer<typeof QuerySchema>;
export interface R7Family {
  ref:ExperimentRef;root:z.infer<typeof EvidenceRootSchema>;sourceId:string;evidenceVersionId:string;
  input:AtlasOwnerInput;episodeId:string;grantRef:ExperimentRef;cancellationRef:ExperimentRef;
}
export interface R7Parameters {
  ref:ExperimentRef;familyRef:ExperimentRef;revision:number;priorRef:ExperimentRef|null;
  values:string[];owner:'BUSINESS_OWNER';createdAt:string;
}
export interface R7Query {
  schema:'finnor.r7.query.v1';ref:ExperimentRef;buildId:string;workId:string;createdAt:string;familyRef:ExperimentRef;parameterRef:ExperimentRef;
  disposition:AtlasQueryDisposition;cellId:string|null;atlasCoverage:'COMPLETE'|'PARTIAL'|'UNKNOWN';
  choice:AtlasProjectedChoice|null;reasons:string[];fallback:{mode:string;admitted:false;physical:DecisionAtlas['physical'];fullFamilyEvaluations:number}|null;
  resourceSnapshotDigest:string;costs:{wallMs:number;membershipPredicates:number;fullFamilyEvaluations:number;money:null};
  executionAuthorityGranted:false;
}
export interface R7Selection {
  choice:AtlasProjectedChoice;reservation:AllocationReservation;consumption:AllocationConsumption;
  qualification:'ORDINARY_CURRENT_EXACT_S4_S5_INTENT_NOT_EFFECT_AUTHORITY';
  executionAuthorityGranted:false;
}
export interface R7AllocationProblem {
  schema:'finnor.s5.exact-affine-problem.v1';ref:ExperimentRef;tenantId:string;principalId:string;
  mandate:AtlasOwnerInput['source']['mandate'];sourceRef:ExperimentRef;originalPolicyRef:ExperimentRef;
  choiceRef:ExperimentRef;queryRef:ExperimentRef;resources:AllocationResource[];outstanding:AllocationOutstandingCommitment[];
  snapshotDigest:string;parameters:string[];
}
export interface R7AllocationCertificate {
  schema:'finnor.s5.exact-affine-certificate.v1';ref:ExperimentRef;version:'r7-exact-affine-v1';tenantId:string;principalId:string;
  mandateRef:ExperimentRef;rightsRef:string;policyBindings:ExactAllocationCheck['policyBindings'];problemRef:ExperimentRef;
  check:ExactAllocationCheck;snapshotDigest:string;validUntil:string;executionAuthorityGranted:false;protectedReceipt:null;
}
export type R7BuildStatus='QUEUED'|'RUNNING'|'COMPLETE'|'INCOMPLETE'|'FAILED'|'INVALIDATED'|'CANCELLED';
export interface R7BuildRow {
  id:string;tenant_id:string;principal_id:string;family_digest:string;work_id:string;
  request:R7BuildRequest;request_digest:string;input:AtlasOwnerInput;generation:number;status:R7BuildStatus;
  result_digest:string|null;active_claim_token:string|null;active_claim_fence:number|null;
  episode_id:string;deadline_at:Date;failure:{code:string;requirement:string}|null;
}
