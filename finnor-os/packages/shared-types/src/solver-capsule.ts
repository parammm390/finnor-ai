import {z} from 'zod';
import type {ExperimentRef} from './experiments';
import type {NativeModule} from '../../private-equity/src/program-synthesis/contracts';
import type {IntegerProgram,SemanticReceipt,SourcePin,Trial,Counterexample,RuntimeIdentity} from '../../epistemic-runtime/src/solver-synthesis/contracts';

export const R8_VERSION='r8-solver-capsule-v1' as const;
const ref=z.object({owner:z.string().min(1).max(128),id:z.string().min(1).max(512),
 version:z.string().min(1).max(128),contentDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const SolverRequestSchema=z.object({
 schema:z.literal('finnor.r8.synthesis-request.v1'),workId:z.string().uuid(),
 policyRefs:z.array(ref).length(3),resourceRefs:z.array(ref).min(1).max(16),mandate: z.unknown(),jointModel:z.unknown(),
 demandBindings:z.array(z.unknown()).max(96),funding:z.array(z.unknown()).length(3),
 idempotencyKey:z.string().min(1).max(200),parentRequestId:z.string().uuid().optional(),
 limits:z.object({deadlineMs:z.number().int().min(1000).max(3600000),maxRounds:z.number().int().min(2).max(16)}).strict(),
}).strict();
export type SolverRequest=z.infer<typeof SolverRequestSchema>;
export type SolverStatus='COMPLETE'|'INCOMPLETE'|'INFEASIBLE'|'UNSUPPORTED'|'INVALIDATED'|'UNKNOWN';
export type SolverRuntimePin=Omit<RuntimeIdentity,'inventory'>&{identityDigest:string;manifestRef:ExperimentRef};
export interface SolverCapsule {
 schema:'finnor.solver-capsule.v1';ref:ExperimentRef;kind:'SolverCapsule';schemaRevision:typeof R8_VERSION;
 profile:'r8-three-optional-projects-integer-v1';status:'COMPLETE';checkBasis:'MODEL_RELATIVE_EXACT';
 envelope:{
  tenantId:string;principalId:string;sharingScope:'PRIVATE_PRINCIPAL';
  work:{id:string;revision:string;inputDigest:string};baselineManifest:{commit:string;tree:string};
  producer:{sourcePins:SourcePin[];codeDigest:string;lockDigest:string;admission:null};
  ownerInputs:Array<{ref:ExperimentRef;asOf:string;rightsRevision:string}>;
  problemRef:ExperimentRef;domainProfileRef:ExperimentRef;budgetGrantRef:ExperimentRef;cancellationRef:ExperimentRef;
  originalDeadlineAt:string;parentRequestId:string|null;
 };
 program:IntegerProgram;module:NativeModule;runtime:SolverRuntimePin;receipt:SemanticReceipt;semanticSourcePins:SourcePin[];
 specificationDigest:string;grammarDigest:string;tie:'MINIMUM_CANONICAL_MASK';
 applicability:{predicateDigest:string;predicate:'LOSSLESS_CURRENT_S4_S5_THREE_OPTIONAL_INTEGER_PROJECTS';
  excluded:string[];currentProblemDigest:string;invalidationRefs:ExperimentRef[]};
 ownerOutputMapping:Array<{slot:number;originalPolicyRef:ExperimentRef;demandDigest:string}>;
 trials:Trial[];counterexamples:Counterexample[];resources:unknown[];
 fallback:{ref:ExperimentRef;basis:'ORIGINAL_S5_CANONICAL_FULL_ROUTE_UNADMITTED';protectedAdmitted:false};
 s8AdmissionRef:null;protectedActivation:false;executionAuthorityGranted:false;
 gaps:Array<{claim:string;status:'UNKNOWN'|'BLOCKED_EXTERNAL';reason:string}>;
 monetary:{amount:null;currency:null;unit:'OWNER_WEALTH';valuationDate:null;ownerShare:null;timeBasis:null;discount:null;status:'UNKNOWN';reason:string};
 lifecycle:Array<{state:'DEVELOPMENT_VERIFIED';at:string;evidenceRef:ExperimentRef}>;
}
export interface SolverRunInputs {
 envelope_inputs:SolverCapsule['envelope'];problem_ref:ExperimentRef;
 existing_work_revision:SolverCapsule['envelope']['work'];domain_profile_ref:ExperimentRef;
 budget_grant_ref:ExperimentRef;cancellation_ref:ExperimentRef;
}
export interface SolverRunResult {
 artifact:SolverCapsule|null;status:SolverStatus;incumbent:SolverCapsule|null;
 unresolvedClaims:SolverCapsule['gaps'];resourceReceipts:unknown[];
}
