import { z } from "zod"
const ref=z.object({owner:z.string(),id:z.string(),version:z.string(),contentDigest:z.string().regex(/^[a-f0-9]{64}$/)})
const rational=z.object({numerator:z.string().regex(/^-?(0|[1-9]\d*)$/).max(512),denominator:z.string().regex(/^[1-9]\d*$/).max(512)})
const observation=z.object({instrumentId:z.string(),token:z.string(),availablePeriod:z.number().int()}).passthrough()
const costs=z.object({attempts:z.number().int().nonnegative(),unknown:z.number().int().nonnegative(),usd:z.null()})
export const R1ProjectionSchema=z.object({
 schema:z.literal("finnor.r1.work-projection.v1"),workId:z.string().uuid(),workRevision:z.string().uuid().nullable(),
 runs:z.array(z.object({id:z.string().uuid(),status:z.string(),predicate:z.string().nullable(),fallback:z.string().nullable(),policyRef:ref.nullable(),costs})).max(16),
 eligibility:z.object({candidates:z.array(z.object({programId:z.string().uuid(),workRevision:z.string().uuid(),state:z.string(),predicate:z.string().optional(),remainingNativeAttempts:z.number().int().optional(),originalDeadlineAt:z.string().optional(),request:z.object({
  schema:z.literal("finnor.r1.run.v1"),problem_ref:ref,envelope_inputs:z.object({programId:z.string().uuid(),policyRequest:ref,maxMathSteps:z.number().int()}),work_rev:z.string().uuid(),domain:z.literal("finite-information-rational-v1"),grant:ref,cancel:z.literal(false)
 }).optional()})).max(16),hasMore:z.boolean(),authority:z.literal(false),productionAdmissionAvailable:z.literal(false)})
})
export const R1ReviewSchema=z.object({
 schema:z.literal("finnor.r1.current-reader.v1"),id:z.string().uuid(),workId:z.string().uuid(),workRevision:z.string().uuid(),status:z.string(),predicate:z.string().nullable(),fallback:z.string().nullable(),costs,
 originalEpisode:z.string().uuid(),originalDeadlineAt:z.string(),decisionDeadlineAt:z.string(),executionAuthorityGranted:z.literal(false),
 head:z.object({beforeStates:z.number().int(),afterStates:z.number().int().nullable(),relationComplete:z.boolean(),searchComplete:z.boolean(),
  stats:z.object({continuationEvaluations:z.number().int(),reuseHits:z.number().int()}),checkerPredicate:z.string().optional(),
  envelope:z.object({assumptions:z.array(z.string()),gaps:z.array(z.string()),codeDigest:z.string(),lockDigest:z.string(),inputRefs:z.array(ref)}),
 }).nullable(),
 review:z.object({schema:z.literal("finnor.s4.exact-original-review.v1"),policyRef:ref,sourceRef:ref,mandateRef:ref,rightsRef:z.string(),validUntil:z.string(),knowledgeAt:z.string(),exactValue:rational.nullable(),utilityUnit:z.string(),
  originalChoices:z.array(z.object({period:z.number().int(),actionHistory:z.array(z.string()),observations:z.array(observation),optimalActions:z.array(z.string()),selectedAction:z.string().nullable()})).max(128),
  nodes:z.array(z.object({id:z.string(),period:z.number().int(),actionHistory:z.array(z.string()),observations:z.array(observation),actionId:z.string()})).max(128),
  exactDemand:z.unknown(),assumptions:z.array(z.string()),limitations:z.array(z.string()),ownerChecks:z.object({executionAuthorityGranted:z.literal(false)})
 }).nullable()
})
export const R1HistorySchema=z.object({runId:z.string().uuid(),events:z.array(z.object({id:z.string().uuid(),kind:z.string(),body:z.unknown(),digest:z.string(),created_at:z.string()})).max(256),hasMore:z.boolean(),headIsCurrent:z.literal(false),authority:z.literal(false)})
export type R1Projection=z.infer<typeof R1ProjectionSchema>
export type R1Review=z.infer<typeof R1ReviewSchema>
export type R1History=z.infer<typeof R1HistorySchema>
