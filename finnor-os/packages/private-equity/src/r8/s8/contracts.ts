/** Proposed ordinary generated-module review. No existing allocation payload
 * is broadened and this contract cannot issue a protected activation. */
import {z} from 'zod';
import {digest,RefSchema,type CapabilityRef} from '../../../../capability-evolution/src/contracts';
import type {SolverCapsule} from '../../../../shared-types/src/solver-capsule';
import {validateCapsule} from '../capsule';
import {hash,SPECIFICATION,GRAMMAR} from '../../../../epistemic-runtime/src/solver-synthesis/contracts';
import {OWNER_PREDICATE} from '../projection';
const text=z.string().min(1).max(256),hex=z.string().regex(/^[a-f0-9]{64}$/),instant=z.string().datetime({offset:true});
export const SOLVER_PORT_VERSION='s8-r8-solver-module-review-v1' as const;
export const solverPortRef=(kind:string,body:unknown):CapabilityRef=>({owner:'S8',id:'solver-'+kind+':'+digest(body),version:SOLVER_PORT_VERSION,contentDigest:digest(body)});
export const SolverDomainSchema=z.object({profile:z.literal(SPECIFICATION.profile),specificationDigest:hex,grammarDigest:hex,
 predicateDigest:hex,tie:z.literal(SPECIFICATION.tie),validAfter:instant,validUntil:instant}).strict();
export const SolverCandidateSchema=z.object({
 schema:z.literal('finnor.s8.solver-candidate.v1'),tenantId:text,principalId:text,rightsRef:text,
 owningInterface:z.literal('r8-s4-s5-exact-optional-v1'),capsule:z.unknown(),payloadDigest:hex,domain:SolverDomainSchema,
 dependencies:z.array(z.object({path:z.string().min(1).max(4096),sha256:hex}).strict()).min(1).max(256),
 limits:z.object({maxUses:z.number().int().min(1).max(1000),maxUseWallMs:z.number().int().min(50).max(30000)}).strict(),
 proposedAt:instant,protectedAdmission:z.literal(false),executionAuthorityGranted:z.literal(false),
}).strict();
export type SolverCandidate=z.infer<typeof SolverCandidateSchema>&{capsule:SolverCapsule;ref:CapabilityRef};
export function parseSolverCandidate(input:unknown):SolverCandidate {
 const top=z.object({ref:RefSchema}).passthrough().parse(input),{ref,...rest}=top;
 const body=SolverCandidateSchema.parse(rest),capsule=validateCapsule(body.capsule);
 if(hash(ref)!==hash(solverPortRef('candidate',body))||body.payloadDigest!==hash(capsule)||
  body.domain.specificationDigest!==hash(SPECIFICATION)||body.domain.grammarDigest!==hash(GRAMMAR)||
  body.domain.predicateDigest!==hash(OWNER_PREDICATE)||Date.parse(body.domain.validUntil)<=Date.parse(body.domain.validAfter)||
  capsule.envelope.tenantId!==body.tenantId||capsule.envelope.principalId!==body.principalId||
  new Set(body.dependencies.map(p=>p.path)).size!==body.dependencies.length)throw Error('S8_SOLVER_PREIMAGE_OR_DOMAIN_SUBSTITUTION');
 return {...body,capsule,ref};
}
export const SolverReviewSchema=z.object({schema:z.literal('finnor.s8.solver-review.v1'),tenantId:text,principalId:text,
 revisionRef:RefSchema,evaluatorId:text,registeredAt:instant,payloadDigest:hex,domainDigest:hex,
 checkerDigest:hex,runtimeDigest:hex,qualification:z.literal('FULL_ORIGINAL_D_PUBLIC_DEVELOPMENT_NOT_GATE_R8')}).strict();
export const SolverEvaluationSchema=z.object({schema:z.literal('finnor.s8.solver-evaluation.v1'),revisionRef:RefSchema,
 protocolRef:RefSchema,evaluatorId:text,payloadDigest:hex,domainDigest:hex,completedAt:instant,
 expectedSemanticReceiptDigest:hex,protectedAdmission:z.literal(false)}).strict();
export const SolverAdmissionSchema=z.object({schema:z.literal('finnor.s8.solver-admission.v1'),revisionRef:RefSchema,
 evaluationRef:RefSchema,payloadDigest:hex,domainDigest:hex,protectionDomain:z.literal('DISPOSABLE_TEST_AUTHORITY'),
 executionAuthorityGranted:z.literal(false)}).strict();
export const SolverActivationSchema=z.object({schema:z.literal('finnor.s8.solver-activation.v1'),revisionRef:RefSchema,
 admissionRef:RefSchema,expectedGeneration:z.number().int().min(0),predecessorRef:RefSchema.nullable(),
 mode:z.literal('DIAGNOSTIC'),validUntil:instant,executionAuthorityGranted:z.literal(false)}).strict();
export const SolverRevocationSchema=z.object({schema:z.literal('finnor.s8.solver-revocation.v1'),revisionRef:RefSchema,
 expectedAdmissionRef:RefSchema,expectedGeneration:z.number().int().min(0),reason:text,predecessorRef:RefSchema.nullable()}).strict();
export const SolverUseSchema=z.object({revisionRef:RefSchema,admissionRef:RefSchema,tenantId:text,principalId:text,
 rightsRef:text,inputDigest:hex,workInputDigest:hex,originalDeadlineAt:instant,mode:z.literal('DIAGNOSTIC')}).strict();
export interface SolverUseLease {
 schema:'finnor.s8.solver-use.v1';ref:CapabilityRef;revisionRef:CapabilityRef;admissionRef:CapabilityRef;
 capsuleRef:CapabilityRef;payloadDigest:string;inputDigest:string;workInputDigest:string;rightsRef:string;
 generation:number;expiresAt:string;mode:'DIAGNOSTIC';protectedExecution:false;executionAuthorityGranted:false;
}
