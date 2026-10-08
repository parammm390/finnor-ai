import {z} from 'zod';
import {ExperimentRefSchema} from '@finnor/epistemic-runtime';
const reference=z.object({obligationRef:ExperimentRefSchema}).strict();
const origin=z.string().max(2048).refine(value=>{try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&url.origin===value;}catch{return false;}},'Exact HTTPS origin without credentials required');
const deliveryPosition={workflowStepId:z.string().uuid(),claimFence:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),dispatchGeneration:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),runVersion:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)};
/** Recovery keeps the original step fence and binds the new physical job claim.
 * It permits only never-attempted original members, never mutation replay. */
export const GovernedDeliveryFenceSchema=z.union([
 z.object({...deliveryPosition,claimToken:z.string().uuid()}).strict(),
 z.object({...deliveryPosition,kind:z.literal('RECOVERY'),jobId:z.string().uuid(),jobDeliveryAttemptId:z.string().uuid(),jobClaimToken:z.string().uuid(),jobClaimFence:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}).strict(),
]);
const execution=z.object({request:z.object({ref:ExperimentRefSchema,ir:z.record(z.unknown()),admissions:z.array(z.unknown()).min(1).max(64)}).strict(),authorization:z.object({body:z.record(z.unknown()),signature:z.string().min(1).max(256)}).strict()}).strict();
export const GovernedRequestBindingSchema=z.object({
 exposureId:z.string().min(1).max(256),methodRef:ExperimentRefSchema.refine(ref=>ref.owner==='S8'&&ref.version==='json-field-replace-v1','Exact S8 method version required'),
 providerOrigin:origin,applicationAccountId:z.string().uuid(),recordKey:z.string().min(1).max(1024).refine(value=>!/[\u0000-\u001f\u007f]/.test(value)),
 field:z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/).refine(value=>!['constructor','prototype','__proto__'].includes(value)),
 expectedVersion:z.string().min(1).max(512).refine(value=>!/[\u0000-\u001f\u007f]/.test(value)),
}).strict();
export const ObligationOperationSchemas={prepare:z.object({preparationRef:ExperimentRefSchema,allocationRef:ExperimentRefSchema,consumptionRef:ExperimentRefSchema}).strict(),read:reference,validate:reference,'read-commitment':reference,
 'budget-status':reference,
 'read-execution-handoff':reference,
 'check-budget':reference.extend({requestRef:ExperimentRefSchema.refine(ref=>ref.owner==='S6'&&ref.version==='s6-conditional-json-v1'&&ref.id===`request-ir:${ref.contentDigest}`),memberId:z.string().regex(/^request-member:[a-f0-9]{64}$/),phase:z.enum(['EXECUTION','RECOVERY','HUMAN']),ordinal:z.number().int().min(1).max(64),units:z.number().int().min(1).max(100000),nonce:z.string().uuid()}).strict(),
 'check-dispatch':z.object({obligationRef:ExperimentRefSchema,requestRef:ExperimentRefSchema.refine(ref=>ref.owner==='S6'&&ref.version==='s6-conditional-json-v1'&&ref.id===`request-ir:${ref.contentDigest}`),memberId:z.string().regex(/^request-member:[a-f0-9]{64}$/),nonce:z.string().uuid(),delivery:GovernedDeliveryFenceSchema.optional()}).strict(),
 'execute-request':execution.extend({delivery:GovernedDeliveryFenceSchema.optional()}).strict(),'reconcile-request':execution,
 'schedule-request':execution,'cancel-delivery':reference.extend({workflowRunId:z.string().uuid(),expectedVersion:z.number().int().nonnegative()}).strict(),
 'compile-request':z.object({obligationRef:ExperimentRefSchema,bindings:z.array(GovernedRequestBindingSchema).min(1).max(64)}).strict()};
