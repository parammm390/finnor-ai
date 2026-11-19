import { z } from "zod"

export const growthId = z.string().uuid()
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const instant = z.string().datetime({ offset: true })
export const growthSource = z.object({ sourceId: growthId, versionId: growthId, contentDigest: digest }).strict()
export const growthNativeRef = z.object({ owner: z.string(), id: z.string(), version: z.string(), contentDigest: digest }).strict()
export const growthMoney = z.object({ currency: z.string().regex(/^[A-Z]{3}$/), minor: z.string().regex(/^(0|[1-9]\d{0,14})$/) }).strict()
export const growthScope = z.object({ tenantId: growthId, principalId: growthId, companyId: growthId,
  workId: growthId, businessAssignmentId: z.string() }).strict()
const offer = z.object({
  id: z.string(), demandId: z.string(), termsDigest: digest, capabilityIds: z.array(z.string()).max(32),
  unitPrice: growthMoney, unitLifecycleCost: growthMoney, maximumUnits: z.number().int().positive(),
  deliveryLeadHours: z.number().positive(), supportHours: z.number().positive(), claims: z.array(z.string()).max(1024),
  exclusions: z.array(z.string()).max(32), refunds: z.string(), warranty: z.string(), disclosure: z.string(),
  accountingPolicySource: growthSource,
}).passthrough()
const program = z.object({
  scope: growthScope, originalDeadlineAt: instant, marketRevision: z.string(), offers: z.array(offer).max(32),
  hypotheses: z.array(z.object({ demandId: z.string(), problem: z.string(),
    alternatives: z.array(z.string()), selectionBias: z.array(z.string()) }).passthrough()).max(32),
  assignedExposure: z.array(z.object({ buyerId: growthId, offerId: z.string(), termsDigest: digest })).max(256),
  protocol: z.object({ closesAt: instant, maxContacts: z.number(), maxMoney: growthMoney,
    maxHumanSeconds: z.number(), populationSource: growthSource }).passthrough(),
  admitted: z.literal(false), fieldValidated: z.literal(false), productionActive: z.literal(false),
}).passthrough()
const projection = z.object({
  currentness: z.enum(["CURRENT", "STALE"]), validationState: z.string(), decision: z.string(),
  counts: z.object({ assigned: z.number(), responded: z.number(), interested: z.number(),
    declined: z.number(), nonresponse: z.number(), accepted: z.number(),
    independentEligibleAccepted: z.number(), delivered: z.number(), repetitions: z.number() }),
  commitments: z.array(z.object({ buyerId: growthId, offerId: z.string(), quantity: z.number(),
    deliveredQuantity: z.number(), acceptedDeliveryQuantity: z.number(), state: z.string(),
    supportUntil: instant, continuingObligations: z.array(z.string()) }).passthrough()).max(256),
  accounting: z.object({ currency: z.string(), bookingsMinor: z.string(), collectedMinor: z.string(),
    recognizedMinor: z.string(), deferredMinor: z.string(), receivableMinor: z.string(),
    refundedMinor: z.string(), refundRequestedMinor: z.string(), missingCostCategories: z.array(z.string()),
    incrementalNetAfterTaxMinor: z.string().nullable() }).passthrough(),
  gaps: z.array(z.string()), originalFailures: z.array(z.string()),
  fieldValidated: z.literal(false), s7ProfitQualified: z.literal(false), admissionGranted: z.literal(false),
  executionAuthorityGranted: z.literal(false),
}).passthrough()
export const growthViewSchema = z.object({
  scope: z.object({ tenantId: growthId, principalId: growthId, workId: growthId }),
  preparedOutcomes: z.array(z.object({ source: growthSource, workInputId: growthId,
    budgetObligationRef: growthNativeRef, scope: growthScope, originalMeaning: z.string(),
    question: z.string(), originalDeadlineAt: instant, permittedPurpose: z.string() })).max(32),
  requests: z.array(z.object({ requestId: growthId, status: z.string(), originalDeadlineAt: instant,
    artifactDigest: digest.nullable(), program: program.nullable(), projection: projection.nullable(),
    nativeEffects: z.array(z.object({ ref: growthNativeRef, kind: z.enum(["OFFER", "DELIVER", "COLLECT", "REFUND"]),
      state: z.enum(["VERIFIED", "UNKNOWN", "NOT_ATTEMPTED"]),
      originalIdentityReadback: z.boolean(), buyerId: growthId, offerId: z.string() }).passthrough()).max(1024),
    gaps: z.array(z.string()), product: z.object({ scope: growthScope, purpose: z.string(), currentUntil: instant,
      accountingPolicySource: growthSource, participants: z.array(z.object({ id: growthId, label: z.string(),
        role: z.enum(["BUYER", "OPERATOR", "ACCOUNTANT", "INDEPENDENT_OBSERVER"]) })),
      protocols: z.array(z.object({ id: growthId, participantId: growthId, role: z.string(),
        expiresAt: instant, status: z.enum(["INVITED", "CONSENTED", "REVOKED", "EXPIRED"]) })).max(256),
    }) }).passthrough()).max(32),
  complete: z.boolean(), qualification: z.literal("CONTROLLED_DEVELOPMENT_ONLY"),
  fieldValidated: z.literal(false), admissionGranted: z.literal(false),
})
export const growthInboxSchema = z.object({
  scope: z.object({ tenantId: growthId, principalId: growthId }), complete: z.boolean(),
  protocols: z.array(z.object({ id: growthId, requestId: growthId.nullable(), role: z.string(),
    purpose: z.string(), permittedKinds: z.array(z.string()), expiresAt: instant,
    status: z.enum(["INVITED", "CONSENTED", "REVOKED", "EXPIRED"]),
    disclosure: z.object({ scope: growthScope, offer: offer.optional(), buyerId: growthId.optional(),
      marketRevision: z.string().optional(), populationSource: growthSource.optional(),
      testClosesAt: instant.optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional(),
      evidenceKinds: z.array(z.string()) }).passthrough().nullable(),
  }).passthrough().transform(p => Date.parse(p.expiresAt) <= Date.now() || p.status === "REVOKED" || p.status === "EXPIRED"
    ? { ...p, status: p.status === "REVOKED" ? "REVOKED" as const : "EXPIRED" as const,
      disclosure: null, permittedKinds: [] } : p)).max(256),
})
export const growthProgressSchema = z.object({
  protocolId: growthId, participantId: growthId, scope: growthScope, expiresAt: instant, complete: z.boolean(),
  events: z.array(z.object({ source: growthSource, authorId: growthId, role: z.string(),
    receivedAt: instant, evidenceClass: z.enum(["CONTROLLED", "REPLAYED"]),
    body: z.object({ kind: z.string(), scope: growthScope, at: instant, quantity: z.number().optional(),
      response: z.string().optional(), accepted: z.boolean().optional(), status: z.string().optional(),
      amount: growthMoney.optional(), issueId: z.string().optional() }).passthrough(),
  })).max(128),
  executions: z.array(z.object({ source: growthSource, operation: z.enum(["OFFER", "DELIVER", "COLLECT", "REFUND"]),
    quantity: z.number().nullable(), amount: growthMoney.nullable(), obligationRef: growthNativeRef })).max(64),
  evidence: z.array(z.object({ source: growthSource, kind: z.string(), subjectId: z.string(),
    validFrom: instant, validUntil: instant, data: z.object({ buyerId: growthId.nullable(),
      offerId: z.string().nullable(), termsDigest: digest.nullable(), amount: growthMoney.nullable(),
      category: z.string().nullable() }) })).max(64),
  qualification: z.literal("CONTROLLED_DEVELOPMENT_ONLY"), physicalTruthEstablished: z.literal(false),
  fieldValidated: z.literal(false),
})
export type GrowthView = z.infer<typeof growthViewSchema>
export type GrowthRequest = GrowthView["requests"][number]
export type GrowthProtocol = z.infer<typeof growthInboxSchema>["protocols"][number]
export type GrowthProgress = z.infer<typeof growthProgressSchema>
export type GrowthScope = z.infer<typeof growthScope>
export type GrowthSource = z.infer<typeof growthSource>
export type GrowthMutation = (run: (current: () => boolean) => Promise<unknown>) => Promise<void>
export const growthLabel = (value: string) => value.replaceAll("_", " ").toLowerCase()
export const growthAmount = (value: { currency: string; minor: string }) => `${BigInt(value.minor).toLocaleString()} minor ${value.currency} units`
export const growthSameScope = (a: GrowthScope, b: GrowthScope) => a.tenantId === b.tenantId
  && a.principalId === b.principalId && a.companyId === b.companyId && a.workId === b.workId
  && a.businessAssignmentId === b.businessAssignmentId
export const growthS1Ref = (source: GrowthSource) => ({ owner: "S1", id: source.versionId,
  version: "evidence-source-version-v1", contentDigest: source.contentDigest })
