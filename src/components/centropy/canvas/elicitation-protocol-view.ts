import { z } from "zod"
const id = z.string().uuid(), text = z.string().min(1).max(2048)
const ref = z.object({ owner: text, id: text, version: text, contentDigest: z.string().regex(/^[a-f0-9]{64}$/) })
export const ElicitationProgramTargetViewSchema = z.object({
  grammar: z.literal("r3-m3-report-extension-v1"), queryId: id,
  programRef: ref, candidateDigest: z.string().regex(/^[a-f0-9]{64}$/), policyRef: ref,
}).strict()
export type ElicitationProgramTargetView = z.infer<typeof ElicitationProgramTargetViewSchema>
const quantity = z.object({ numerator: z.string().max(128).regex(/^(?:0|-?[1-9]\d*)$/), denominator: z.string().max(128).regex(/^[1-9]\d*$/) })
const source = z.object({ sourceId: id, versionId: id, contentDigest: z.string() })
export const ElicitationContextViewSchema = z.object({
  schema: z.literal("finnor.r3.work-context.v2"), workId: id, workRevision: id,
  root: z.object({ entityType: text, entityId: id }),
  declarations: z.array(z.object({ problem_ref: source, domain_profile_ref: ref, mandateRef: ref,
    supportedParties: z.number().int(), qualification: z.literal("UNQUALIFIED") })).max(16),
  incumbentPolicies: z.array(z.object({ ref, mandateRef: ref })).max(16),
  budgetGrants: z.array(z.object({ ref, validUntil: z.string().datetime({ offset: true }) })).max(16),
  requests: z.array(z.object({ requestId: id, status: text, workRevision: id })).max(16),
  executionAuthorityGranted: z.literal(false),
})
const transfer = z.object({ partyId: text, dateId: text, amount: quantity, currency: text, unit: text, dueAt: text, eventId: text })
const row = z.object({ reports: z.array(text).length(4), outcomeId: text, schedule: z.array(transfer).min(4).max(32) })
export const ElicitationReviewViewSchema = z.object({
  schema: z.literal("finnor.r3.work-review.v1"), requestId: id, workId: id, workRevision: id, tenantId: id, principalId: id,
  status: text, deadlineAt: text, reason: z.string().nullable(), provisional: z.boolean(),
  protocol: z.object({
    ref, envelope: z.object({ work: z.object({ id, revision: id }), gaps: z.array(z.object({ reason: text, status: text })),
      lifecycle: z.object({ domainQualified: z.literal(false), s8Admitted: z.literal(false), active: z.literal(false) }) }).passthrough(),
    problem: z.object({ binding: z.object({ root: z.object({ entityType: text, entityId: id }), programTarget: ElicitationProgramTargetViewSchema.optional() }).passthrough(),
      parties: z.array(z.object({ id: text, reportingPrincipalId: id, types: z.array(z.object({ id: text })).length(3) })).length(4),
      dates: z.array(z.object({ id: text, at: text, grossOutflowCap: quantity, escrowCap: quantity })),
      assumptions: z.array(text), constraints: z.object({ netTransferMinimum: quantity, netTransferMaximum: quantity, ownerLiabilityCap: quantity }).passthrough(),
      resources: z.array(z.object({ resourceId: text, unit: text, availability: z.array(quantity), baseline: z.array(quantity) }).passthrough()),
    }).passthrough(),
    rule: z.object({ table: z.array(row).length(81), search: z.object({ optimum: text, trace: z.record(z.unknown()) }).passthrough() }),
    check: z.object({ accepted: z.literal(true), basis: z.literal("MODEL_RELATIVE_EXACT"),
      counts: z.object({ profiles: z.literal(81), deviations: z.literal(648), participation: z.literal(324) }),
      objective: quantity, upper: quantity.nullable(), optimizationGap: quantity.nullable(),
      minimumIncentiveMargin: quantity, minimumParticipationMargin: quantity, maximumDeviationGain: quantity,
    }).passthrough(),
    agreementEstablished: z.literal(false), settlementEstablished: z.literal(false), executionAuthorityGranted: z.literal(false),
  }).passthrough().nullable(),
  usePolicy: z.object({ ref }).passthrough().nullable(), allocation: z.record(z.unknown()).nullable(), schedules: z.record(z.unknown()).nullable(),
  reportState: z.object({ reports: z.array(z.string()), reportEventIds: z.record(z.string()), closed: z.boolean(), complete: z.boolean(),
    noAgreement: z.boolean(), acceptanceComplete: z.boolean(), acceptedParties: z.array(text) }).passthrough().nullable(),
  costs: z.record(z.unknown()),
  agreementEstablished: z.literal(false), settlementEstablished: z.literal(false), executionAuthorityGranted: z.literal(false),
})
export type ElicitationReviewView = z.infer<typeof ElicitationReviewViewSchema>
export type ElicitationContextView = z.infer<typeof ElicitationContextViewSchema>
/** Display only. Never use IEEE-754 for a choice, payment or feasibility sign. */
export const exactElicitationText = (q: { numerator: string; denominator: string } | null) =>
  q ? q.denominator === "1" ? q.numerator : `${q.numerator}/${q.denominator}` : "UNKNOWN"
