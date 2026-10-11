import { z } from "zod"

const quantity = z.object({
  numerator: z.string().regex(/^(0|[1-9][0-9]{0,255})$/),
  denominator: z.string().regex(/^[1-9][0-9]{0,255}$/),
})
const ref = z.object({ owner: z.string(), id: z.string(), version: z.string(), contentDigest: z.string().regex(/^[a-f0-9]{64}$/) })
const time = z.object({ start: z.string().datetime(), end: z.string().datetime() })
const condition = z.object({
  lawId: z.string(), premise: z.string(), status: z.string(), basis: z.string(), reason: z.string(), prospective: z.boolean(),
})
const costBasis = z.object({
  currency: z.string(), unit: z.string(), valuationAt: z.string(), ownerShare: quantity, horizon: time, discount: z.string(),
})
const plan = z.object({
  identification: z.enum(["CONDITIONAL", "INVARIANT", "UNIDENTIFIED", "UNKNOWN"]),
  basis: z.literal("MODEL_RELATIVE_EXACT"),
  selected: z.object({
    mask: z.number().int().min(0).max(255), bundleIds: z.array(z.string()).max(8),
    totalCost: quantity, completion: quantity, schedule: z.unknown(), resourceUse: z.unknown(),
  }).nullable(),
  commonFunctional: z.object({ status: z.enum(["PROVED", "NOT_PROVED"]), basis: z.string(), premises: z.array(z.string()) }),
  minimality: z.object({
    status: z.enum(["PROVED", "UNKNOWN"]), masks: z.number().int().min(1).max(256),
    pairs: z.number().int().min(1).max(2048), unresolvedMasks: z.array(z.number().int()).max(256), basis: z.string(),
  }),
  masks: z.array(z.object({
    mask: z.number().int(), bundleIds: z.array(z.string()).max(8), status: z.string(),
    totalCost: quantity.nullable(), completion: quantity, sufficientForFamily: z.boolean(), reasons: z.array(z.string()),
  })).max(256),
  pairs: z.array(z.object({
    mask: z.number().int(), graphId: z.string(), structural: z.string(), data: z.string(), sufficient: z.boolean(),
    lawId: z.string().nullable(), proofId: z.string().nullable(), functional: z.string().nullable(),
    conditions: z.array(condition).max(32), reasons: z.array(z.string()),
  })).max(2048),
  assumptions: z.array(z.string()), graphTruthEstablished: z.literal(false), effectEstimate: z.null(),
  attributionGranted: z.literal(false), executionAuthorityGranted: z.literal(false), admission: z.null(),
})
/** Display validation never supplies rights, graph truth or checker admission. */
export const IdentificationWorkViewSchema = z.object({
  schema: z.literal("finnor.r4.work-view.v1"), workId: z.string().uuid(),
  root: z.object({ entityType: z.string(), entityId: z.string().uuid() }),
  profile: z.object({
    id: z.string().uuid(), ref, workRevision: z.string().uuid(), budgetGrantRef: ref,
    query: z.object({
      id: z.string(), outcomes: z.array(z.string()), treatments: z.array(z.string()), conditions: z.array(z.string()),
      estimandRef: z.string(), scope: z.object({ population: z.string(), intervention: z.string(), time, units: z.record(z.string()) }),
    }),
    graphIds: z.array(z.string()).max(8), costBasis, scheduleUnit: z.literal("second"), qualification: z.string(),
    validUntil: z.string().datetime(),
    menu: z.array(z.object({
      id: z.string(), costItemIds: z.array(z.string()), schedule: z.object({ after: z.array(z.string()), earliestStart: quantity, duration: quantity }),
    })).max(8),
    graphTruthEstablished: z.literal(false), executionAuthorityGranted: z.literal(false),
  }).nullable(),
  run: z.object({
    id: z.string().uuid(), status: z.string(), workRevision: z.string().uuid(), artifactRef: ref.nullable(), plan: plan.nullable(),
    gaps: z.array(z.string()), provisional: z.boolean(), currentUseGranted: z.boolean(),
    costs: z.object({
      actualComputeUSD: z.null(), actualAcquisitionUSD: z.null(), status: z.literal("MATERIAL_METERS_INCOMPLETE"),
      attempts: z.array(z.object({
        id: z.string().uuid(), kind: z.string(), status: z.string(), elapsedMs: z.number().nullable(),
        chargedNativeAttempts: z.number(), terminationObserved: z.boolean(), responsibility: z.string(),
      })),
    }),
  }).nullable(),
  reason: z.string().nullable(), executionAuthorityGranted: z.literal(false), attributionGranted: z.literal(false),
})
export type IdentificationWorkView = z.infer<typeof IdentificationWorkViewSchema>
export const IdentificationConsumerViewSchema = z.object({
  executionAuthorityGranted: z.literal(false), reservationGranted: z.literal(false), attributionGranted: z.literal(false),
  decision: z.object({
    review: z.object({ status: z.string(), utilityUnchanged: z.literal(true), actualInformationValue: z.null() }),
    acquisitionFallbackAbsence: z.string(), executionAuthorityGranted: z.literal(false),
  }),
})
export function exactIdentificationQuantity(value: z.infer<typeof quantity>): string {
  return value.denominator === "1" ? value.numerator : `${value.numerator}/${value.denominator}`
}
