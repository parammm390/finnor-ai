import {z} from 'zod';
import type {WorkEconomicAnchor} from '../../../shared-types/src/work-economic';

const uuid=z.string().uuid(),digest=z.string().regex(/^[a-f0-9]{64}$/),text=z.string().min(1).max(4096);
export const WorkEconomicRefSchema=z.object({owner:text.max(128),id:text,version:text.max(256),contentDigest:digest}).strict();
export const WorkEconomicAnchorSchema:z.ZodType<WorkEconomicAnchor>=z.object({
 workId:uuid,workInputId:uuid,objectiveLoopId:uuid,objectiveRevision:z.number().int().positive(),objectiveDigest:digest,
 successConditionHash:digest,criterionIndex:z.number().int().min(0).max(63),criterionHash:digest,dealId:uuid,currency:z.string().regex(/^[A-Z]{3}$/),
}).strict();
const binding={anchor:WorkEconomicAnchorSchema,replacesBindingRef:WorkEconomicRefSchema.optional(),idempotencyKey:text.max(200)};
export const WORK_ECONOMIC_OPERATIONS=['work-context','register-work','bind-work'] as const;
export const WorkEconomicOperationSchemas={
 'work-context':z.object({workId:uuid,criterionIndex:z.number().int().min(0).max(63).optional()}).strict(),
 'register-work':z.object({...binding,estimand:z.unknown(),rightsRef:text}).strict(),
 'bind-work':z.object({...binding,estimandRef:WorkEconomicRefSchema}).strict(),
} satisfies Record<(typeof WORK_ECONOMIC_OPERATIONS)[number],z.ZodTypeAny>;
export const WorkEconomicBindingSchema=z.object({schema:z.literal('finnor.s7.work-economic-binding.v1'),anchor:WorkEconomicAnchorSchema,
 estimandRef:WorkEconomicRefSchema,requestDigest:digest,measurementScope:z.literal('FUTURE_INTERVENTION_FROM_REGISTERED_CUT'),
 completionSatisfied:z.literal(false),causalCreditGranted:z.literal(false),executionAuthorityGranted:z.literal(false),
}).strict();
