import { z } from "zod"
import { CapitalRefViewSchema } from "./capital-ref-view"

export const COALITION_VIEW_VERSION = "r5-joint-coalition-rational-v1"
const S5_VERSION = "s5-joint-finite-v1"
const text = z.string().min(1).max(256)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const digestOrUnavailable = z.union([digest, z.literal("")])
const instant = z.string().datetime({ offset: true })
const quantity = z.string().max(1025).regex(/^-?(?:0|[1-9]\d*)(?:\/[1-9]\d*|\.\d+)?$/)
const date = z.number().int().min(0).max(23)
const series = z.array(quantity).min(1).max(24)
const ref = CapitalRefViewSchema.extend({ owner: text, id: z.string().min(1).max(512), version: text }).strict()
const root = z.object({ entityType: text, entityId: z.string().uuid() })
const source = z.object({ sourceId: z.string().uuid(), versionId: z.string().uuid(), contentDigest: digest })
const atom = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("CONSTANT") }),
  z.object({ kind: z.literal("TERM"), id: text }),
  z.object({ kind: z.literal("GRANT"), resourceId: text, date }),
  z.object({ kind: z.literal("MEMBER"), partyId: text }),
  z.object({ kind: z.literal("MEMBER_PAIR"), parties: z.tuple([text, text]) }),
])
const equation = z.object({
  itemId: text, ownerPartyId: text, kind: z.enum(["CASH", "RESIDUAL_ASSET", "LIABILITY"]),
  unit: text, currency: z.string().regex(/^[A-Z]{3}$/), date,
  terms: z.array(z.object({ coefficientId: text,
    feature: z.union([atom, z.object({ kind: z.literal("PRODUCT"), left: atom, right: atom })]),
  })).min(1).max(64),
})
const operator = z.object({
  id: text, operationRef: ref, modelRef: ref, kind: z.enum(["INTERVENE", "WAIT", "STOP"]),
  eligibleParties: z.array(text).min(1).max(8), requiredParties: z.array(text).max(8),
  minMembers: z.number().int().min(1).max(8), maxMembers: z.number().int().min(1).max(8),
  termChoices: z.array(z.record(quantity)).min(1).max(64),
  grantChoices: z.array(z.record(series)).min(1).max(64),
  equations: z.array(equation).max(256), costs: z.array(equation).max(256),
  requiresAfter: z.array(text).max(8), exclusiveItems: z.array(text).max(256),
  consentRequired: z.array(text).max(8),
})
const event = z.object({
  id: text, eventRef: ref, availableDate: date, tokens: z.array(text).min(1).max(32),
})
const division = z.object({
  eventId: text, token: text, date, operationRef: ref, amounts: z.record(quantity),
})
const nativeBudget = z.object({
  maxPaths: z.number().int(), maxHistories: z.number().int(), maxVariables: z.number().int(),
  maxRows: z.number().int(), maxProofBytes: z.number().int(), cpuMs: z.number().int(),
  memoryMiB: z.number().int(), maxNativeCalls: z.number().int(),
})
const original = z.object({
  schema: z.literal("finnor.r5.original.v1"), version: z.literal(COALITION_VIEW_VERSION),
  profile: z.literal("EIGHT_PARTIES_FINITE_JOINT_GRAMMAR_OBSERVABLE_DIVISION"),
  parties: z.array(z.object({
    id: text, partyRef: ref, rightsRef: ref, outsideOptionRef: ref, fundingRef: ref, requiredConsentRef: ref,
    outsideOptions: z.record(quantity), settledCash: z.record(series), ownerObjectiveWeight: quantity,
  })).min(1).max(8),
  worlds: z.array(z.object({
    id: text, coefficients: z.record(quantity), eventTokens: z.record(text),
  })).min(1).max(32),
  dates: z.array(instant).min(1).max(24), unit: text, currency: z.string().regex(/^[A-Z]{3}$/),
  valuationDate: instant, discountFactors: series, events: z.array(event).min(1).max(32),
  transfers: z.array(z.object({
    eventId: text, token: text, date, operationRef: ref, bounds: z.record(z.tuple([quantity, quantity])),
  })).min(1).max(768),
  grammar: z.object({
    ref, operators: z.array(operator).min(1).max(8), maxSteps: z.number().int().min(1).max(8),
    admittedCoalitions: z.literal("ALL_ELIGIBLE_NONEMPTY_SUBSETS"),
  }),
  model: z.object({
    ref, qualification: z.literal("SUPPLIED_FINITE_MODEL_UNADMITTED"),
    noStrategicSpillover: z.literal("SUPPLIED_NO_CROSS_COALITION_SPILLOVER"),
    omittedMechanisms: z.array(text).max(128),
  }),
  objective: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("ROBUST"), mandateRef: ref }),
    z.object({ kind: z.literal("EXPECTED"), mandateRef: ref, qualifiedLawRef: ref, probabilities: z.record(quantity) }),
  ]),
  resources: z.array(z.object({
    id: text, sourceRef: ref, unit: text, available: z.record(series),
    kind: z.enum(["CUMULATIVE_EXPENDITURE", "OCCUPANCY", "FLOW"]),
  })).min(1).max(32),
  obligationsRef: ref,
  controlDemand: z.object({
    schema: z.literal("finnor.r5.control-demand.v1"),
    dimensions: z.array(z.object({
      dimensionId: text, totalResourceId: text.nullable(), occupancyResourceId: text.nullable(),
    })).max(16),
    humanSecondsByOperator: z.record(quantity),
    staffing: z.literal("NO_EXISTING_EMPLOYMENT_OR_BENEFIT_CHANGE"),
    terminalLiabilityResourceId: text.nullable(),
  }).optional(),
  owner: z.object({
    tenantId: text, principalId: text, workId: text, workRevision: text, originalEpisodeId: text,
    originalBudgetGrantRef: ref, originalDeadline: instant,
    dependencies: z.array(z.object({ key: text, revision: z.number().int().nonnegative() })).max(4096),
  }),
  limits: z.object({
    maxProgrammeOptions: z.number().int().min(1).max(100000),
    maxEncodingBytes: z.number().int().min(1024).max(8388608), native: nativeBudget,
  }),
})
const option = z.object({
  id: text, members: z.array(text).min(1).max(8),
  steps: z.array(z.object({ operatorId: text, terms: z.record(quantity), grants: z.record(series) })).min(1).max(8),
  itemIds: z.array(text), exclusiveItems: z.array(text),
  grossPayoffs: z.record(z.record(quantity)), cashFlows: z.record(z.record(series)),
  cashOutflows: z.record(z.record(series)), resourceUse: z.record(series), requiredConsents: z.array(text).max(8),
})
const candidate = z.object({
  schema: z.literal("finnor.r5.candidate.v1"), originalDigest: digest,
  programmeOptions: z.array(option).max(100000), selectedOptionIds: z.array(text).max(8),
  division: z.array(division).max(768), objective: quantity,
  family: z.object({ complete: z.boolean(), generatedOptions: z.number().int().nonnegative(), unresolved: z.array(z.string()) }),
  nativeBasis: z.object({
    runtimeRef: ref, originalEncodingDigest: digestOrUnavailable, modelSha256: digestOrUnavailable, proofSha256: digest.nullable(),
    viprRef: ref.nullable(), physicalRefs: z.array(ref),
  }),
})
const checkerIdentity = z.object({ path: z.string().min(1).max(4096), sha256: digest })
const checker = z.object({
  schema: z.literal("finnor.r5.independent-check.v1"), originalDigest: digest, candidateDigest: digest,
  disposition: z.enum(["ACCEPTED", "REJECTED", "INCOMPLETE"]), feasible: z.boolean(),
  lower: quantity.nullable(), upper: quantity.nullable(), claims: z.array(z.string()),
  witnesses: z.array(z.object({ boundary: z.string(), coordinate: z.string(), observed: z.string(), required: z.string() })),
  coverage: z.object({
    parties: z.number().int(), worlds: z.number().int(), partitions: z.number().int().nullable(),
    programmeOptions: z.number().int(), transferVariables: z.number().int(),
  }),
  provenance: z.object({
    runtimeRef: ref, physicalRef: ref, checkerIdentity, nativeProofRefs: z.array(ref),
  }).optional(),
})

/** Display validation is not mathematical checking, source currentness or admission. */
export const CoalitionProgrammeViewSchema = z.object({
  schema: z.literal("finnor.coalition-programme.v1"), version: z.literal(COALITION_VIEW_VERSION), ref,
  status: z.enum(["COMPLETE", "INCOMPLETE", "INFEASIBLE", "UNSUPPORTED", "INVALIDATED", "UNKNOWN"]),
  originalRef: ref, original, candidate: candidate.nullable(), checker: checker.nullable(), nativeComponentRef: ref.optional(),
  lower: quantity.nullable(), upper: quantity.nullable(), gap: quantity.nullable(),
  consents: z.array(z.object({
    partyId: text, proposalVersion: digest, requirementRef: ref,
    status: z.enum(["PROPOSED", "ACCEPTED", "DECLINED", "NO_RESPONSE", "WITHDRAWN"]), evidenceRef: ref.nullable(),
  })).max(8),
  owners: z.object({
    s4SelectionRef: ref.nullable(), s5JointReservationRef: ref.nullable(),
    s6ProposedScheduleRef: ref.nullable(), p1ProgrammeRef: ref.nullable(),
  }),
  unresolvedClaims: z.array(z.object({ claim: z.string(), reason: z.string() })),
  lifecycle: z.array(z.object({ state: z.string(), at: instant, reason: z.string() })),
  executionAuthorityGranted: z.literal(false), admission: z.object({ status: z.literal("UNQUALIFIED"), receipt: z.null() }),
  costs: z.object({ physicalRefs: z.array(ref), cpuMs: z.number().finite().nonnegative(), aggregateSampledPeakBytes: z.number().finite().nonnegative(), money: z.null() }),
})
export const CoalitionSelectionViewSchema = z.object({
  schema: z.literal("finnor.s4.coalition-selection.v1"), version: z.literal(COALITION_VIEW_VERSION), ref,
  tenantId: text, principalId: text, workId: text, workRevision: text, rightsRef: text, source, sourceRoot: root,
  dependencies: z.array(z.object({ key: text, revision: z.number().int().nonnegative(), nodeIds: z.array(text), digest: digest.nullable() })),
  resourceSnapshotDigest: digest, runtimeRef: ref, original, originalRef: ref, candidate, checker,
  incumbentPolicyRef: ref, mandateRef: ref, nativeComponentRef: ref,
  selectedOptionIds: z.array(text).min(1).max(8), value: quantity, demandDigest: digest,
  tie: z.object({ rule: text, originalCandidateDigest: digest, checkerIdentity, physicalRef: ref }),
  validUntil: instant, knowledgeAt: instant, qualification: z.literal("EXACT_SUPPLIED_JOINT_MODEL_UNADMITTED"),
  programmeExecutableQualified: z.literal(false), executionAuthorityGranted: z.literal(false), reservationGranted: z.literal(false),
})
const horizon = z.object({ startAt: instant, periodMs: z.number().int().positive(), periods: z.number().int().min(1).max(24) })
const envelope = z.object({
  resourceId: text, unit: text, kind: z.enum(["STOCK", "FLOW", "OCCUPANCY", "CUMULATIVE_EXPENDITURE", "EXPOSURE"]),
  horizon, quantities: z.array(quantity).max(24), minimumQuantities: z.array(quantity).max(24),
})
const allocationCheck = z.object({
  schema: z.literal("finnor.allocation-check.v1"), problemRef: ref, selectedPolicyIds: z.array(text), feasible: z.boolean(),
  reasons: z.array(z.string()), objective: quantity.nullable(),
  scenarioValues: z.array(z.object({ scenarioId: text, value: quantity })), envelopes: z.array(envelope).max(32),
  witnesses: z.array(z.object({
    constraintId: text, scenarioId: text, period: date, used: quantity, maximum: quantity, margin: quantity,
  })),
  numericalSemantics: z.literal("EXACT_DECIMAL_RATIONAL_ZERO_FEASIBILITY_TOLERANCE"), executionAuthorityGranted: z.literal(false),
})
export const CoalitionAllocationViewSchema = z.object({
  problem: z.object({
    schema: z.literal("finnor.s5.coalition-allocation-problem.v1"), ref, tenantId: text, principalId: text,
    selection: CoalitionSelectionViewSchema, snapshotDigest: digest,
  }),
  certificate: z.object({
    schema: z.literal("finnor.s5.coalition-allocation-certificate.v1"), ref, tenantId: text, principalId: text,
    selectionRef: ref, problemRef: ref, mandateRef: ref, rightsRef: text, snapshotDigest: digest, validUntil: instant,
    policyBindings: z.array(z.object({ policyRef: ref, demandDigest: digest })).min(1).max(1), check: allocationCheck,
    qualification: z.literal("ORIGINAL_CANONICAL_POINT_NOT_CONSTRAINED_FAMILY_OPTIMUM"),
    executionAuthorityGranted: z.literal(false), protectedReceipt: z.null(),
  }),
  reservation: z.object({
    schema: z.literal("finnor.allocation-reservation.v1"), ref, certificateRef: ref, tenantId: text, principalId: text,
    idempotencyKey: text, requestDigest: digest, createdAt: instant, envelopes: z.array(envelope).max(32),
    status: z.enum(["RESERVED", "CONSUMPTION_PENDING", "UNKNOWN_OUTCOME", "PARTIALLY_RECONCILED", "SETTLED_RETAINED", "RELEASED"]),
    revocationReason: z.string().nullable(), revision: z.number().int().positive(),
    executionAuthorityGranted: z.literal(false), protectedReceipt: z.null(),
  }).nullable(),
})
export const CoalitionConsumptionViewSchema = z.object({
  schema: z.literal("finnor.allocation-consumption.v1"), ref, reservationRef: ref, certificateRef: ref, policyRef: ref,
  demandDigest: digest, nodeId: text, decisionRef: ref, idempotencyKey: text,
  requestDigest: digest, createdAt: instant, status: z.enum(["INTENDED_PENDING_S6", "UNKNOWN_OUTCOME", "RECONCILED"]),
  compatibleScenarioIds: z.array(text).max(32), effectRef: ref.nullable(), envelope: z.array(envelope).max(32),
  executionAuthorityGranted: z.literal(false), protectedReceipt: z.null(),
})
export const CoalitionScheduleViewSchema = z.object({
  schema: z.literal("finnor.s6.coalition-proposed-schedule.v1"), ref, tenantId: text, principalId: text,
  workId: text, workRevision: text, rightsRef: text, selectionRef: ref, allocationRef: ref, reservationRef: ref, consumptionRef: ref,
  proposalVersion: digest, originalRef: ref, candidateDigest: digest, validUntil: instant,
  selectedProgrammes: z.array(option).min(1).max(8),
  payments: z.array(z.object({
    event, dateAt: instant, division,
    legs: z.array(z.object({ partyId: text, targetRef: ref, fundingRef: ref, amount: quantity })).min(1).max(8),
    proposedEffectIdentity: z.string().min(1).max(512),
    requiredObservation: z.literal("INDEPENDENT_CONTRACT_EVENT_AND_EXACT_PAYMENT_READBACK"),
    admission: z.literal("PAYMENT_SIGNING_PROVIDER_OPERATION_UNADMITTED"),
  })).max(768),
  accounting: z.object({ unit: text, currency: z.string().regex(/^[A-Z]{3}$/), valuationDate: instant, discountFactors: series }),
  requiredConsents: z.array(z.object({
    partyId: text, requirementRef: ref, status: z.literal("PROPOSED"), acceptanceObserved: z.literal(false),
  })).min(1).max(8),
  status: z.literal("PROPOSED_UNADMITTED"), executionAuthorityGranted: z.literal(false),
  settlementEstablished: z.literal(false), protectedReceipt: z.null(),
})
export const CoalitionConsentHistoryViewSchema = z.array(z.object({
  schema: z.literal("finnor.s6.coalition-consent-report.v1"), ref, scheduleRef: ref, partyId: text, proposalVersion: digest,
  reportedStatus: z.enum(["NO_RESPONSE", "DECLINED", "WITHDRAWN", "REPORTED_ACCEPTED"]), evidence: source.nullable(),
  reportedBy: text, recordedAt: instant, acceptanceObserved: z.literal(false), executionAuthorityGranted: z.literal(false),
  qualification: z.literal("ORDINARY_OWNER_REPORT_NOT_PARTY_SIGNATURE_OR_INDEPENDENT_ACCEPTANCE"),
})).max(256)
export const CoalitionWorkAccessViewSchema = z.object({ workId: z.string().uuid(), executionAuthorityGranted: z.literal(false) })

export type CoalitionRefView = z.infer<typeof ref>
export type CoalitionProgrammeView = z.infer<typeof CoalitionProgrammeViewSchema>
export type CoalitionSelectionView = z.infer<typeof CoalitionSelectionViewSchema>
export type CoalitionAllocationView = z.infer<typeof CoalitionAllocationViewSchema>
export type CoalitionConsumptionView = z.infer<typeof CoalitionConsumptionViewSchema>
export type CoalitionScheduleView = z.infer<typeof CoalitionScheduleViewSchema>
export type CoalitionConsentHistoryView = z.infer<typeof CoalitionConsentHistoryViewSchema>
export type CoalitionRoot = z.infer<typeof root>
export type CoalitionIdentity = { userId: string; workId: string; root: CoalitionRoot; workRevision?: string | null }
type CoalitionWorkScope = Pick<CoalitionIdentity, "workId" | "root">
export type CoalitionPointers = {
  selectionRef: CoalitionRefView; allocationRef: CoalitionRefView | null;
  consumptionRef: CoalitionRefView | null; scheduleRef: CoalitionRefView | null; clearRequested: boolean
}
const pointerKinds = {
  selection: { owner: "S4", prefix: "coalition-selection", version: COALITION_VIEW_VERSION },
  allocation: { owner: "S5", prefix: "coalition-allocation-certificate", version: COALITION_VIEW_VERSION },
  consumption: { owner: "S5", prefix: "allocation-consumption", version: S5_VERSION },
  schedule: { owner: "S6", prefix: "coalition-proposed-schedule", version: COALITION_VIEW_VERSION },
} as const
export function coalitionRef(kind: keyof typeof pointerKinds, contentDigest: string): CoalitionRefView {
  digest.parse(contentDigest)
  const definition = pointerKinds[kind]
  return { owner: definition.owner, id: `${definition.prefix}:${contentDigest}`, version: definition.version, contentDigest }
}
export const sameCoalitionRef = (a: CoalitionRefView | null | undefined, b: CoalitionRefView | null | undefined) =>
  Boolean(a && b && a.owner === b.owner && a.id === b.id && a.version === b.version && a.contentDigest === b.contentDigest)
const requireBinding = (condition: boolean) => { if (!condition) throw Error("Coalition owner binding differs.") }

export function assertCoalitionSelectionScope(selection: CoalitionSelectionView, expected: CoalitionRefView, identity: CoalitionWorkScope) {
  requireBinding(sameCoalitionRef(selection.ref, expected) && sameCoalitionRef(selection.ref, coalitionRef("selection", selection.ref.contentDigest)) &&
    selection.workId === identity.workId && selection.sourceRoot.entityType === identity.root.entityType && selection.sourceRoot.entityId === identity.root.entityId &&
    selection.original.owner.workId === selection.workId && selection.original.owner.workRevision === selection.workRevision &&
    selection.original.owner.tenantId === selection.tenantId && selection.original.owner.principalId === selection.principalId &&
    selection.source.contentDigest === selection.originalRef.contentDigest &&
    selection.checker.originalDigest === selection.candidate.originalDigest && selection.checker.feasible && selection.checker.disposition === "ACCEPTED" &&
    selection.checker.lower === selection.value && selection.candidate.objective === selection.value &&
    JSON.stringify(selection.selectedOptionIds) === JSON.stringify(selection.candidate.selectedOptionIds) &&
    selection.selectedOptionIds.every(id => selection.candidate.programmeOptions.some(option => option.id === id)))
}
export function assertCoalitionAllocationScope(allocation: CoalitionAllocationView, expected: CoalitionRefView, pointers: CoalitionPointers, identity: CoalitionWorkScope) {
  const { problem, certificate, reservation } = allocation
  assertCoalitionSelectionScope(problem.selection, pointers.selectionRef, identity)
  requireBinding(sameCoalitionRef(certificate.ref, expected) && sameCoalitionRef(certificate.ref, coalitionRef("allocation", certificate.ref.contentDigest)) &&
    sameCoalitionRef(certificate.problemRef, problem.ref) && sameCoalitionRef(certificate.selectionRef, pointers.selectionRef) &&
    certificate.tenantId === problem.tenantId && certificate.principalId === problem.principalId &&
    problem.tenantId === problem.selection.tenantId && problem.principalId === problem.selection.principalId &&
    certificate.snapshotDigest === problem.snapshotDigest && certificate.check.feasible &&
    sameCoalitionRef(certificate.policyBindings[0]?.policyRef, pointers.selectionRef) &&
    certificate.policyBindings[0]?.demandDigest === problem.selection.demandDigest &&
    (!reservation || sameCoalitionRef(reservation.certificateRef, certificate.ref) &&
      reservation.tenantId === certificate.tenantId && reservation.principalId === certificate.principalId &&
      reservation.ref.owner === "S5" && reservation.ref.version === S5_VERSION &&
      reservation.ref.id === `allocation-reservation:${reservation.ref.contentDigest}`))
}
export function assertCoalitionConsumptionBinding(consumption: CoalitionConsumptionView, allocation: CoalitionAllocationView) {
  requireBinding(sameCoalitionRef(consumption.ref, coalitionRef("consumption", consumption.ref.contentDigest)) &&
    consumption.nodeId === "joint-coalition-programme" && consumption.status === "INTENDED_PENDING_S6" && consumption.effectRef === null &&
    sameCoalitionRef(consumption.certificateRef, allocation.certificate.ref) &&
    sameCoalitionRef(consumption.reservationRef, allocation.reservation?.ref) &&
    sameCoalitionRef(consumption.policyRef, allocation.problem.selection.ref) &&
    sameCoalitionRef(consumption.decisionRef, allocation.problem.selection.ref) &&
    consumption.demandDigest === allocation.problem.selection.demandDigest)
}
export function assertCoalitionScheduleBinding(schedule: CoalitionScheduleView, pointers: CoalitionPointers, allocation: CoalitionAllocationView) {
  const selection = allocation.problem.selection
  requireBinding(sameCoalitionRef(schedule.ref, pointers.scheduleRef) && sameCoalitionRef(schedule.ref, coalitionRef("schedule", schedule.ref.contentDigest)) &&
    sameCoalitionRef(schedule.selectionRef, pointers.selectionRef) && sameCoalitionRef(schedule.allocationRef, allocation.certificate.ref) &&
    sameCoalitionRef(schedule.reservationRef, allocation.reservation?.ref) && sameCoalitionRef(schedule.consumptionRef, pointers.consumptionRef) &&
    sameCoalitionRef(schedule.originalRef, selection.originalRef) && schedule.candidateDigest === selection.checker.candidateDigest &&
    schedule.tenantId === selection.tenantId && schedule.principalId === selection.principalId &&
    schedule.workId === selection.workId && schedule.workRevision === selection.workRevision)
}

const urlKeys = ["r5User", "r5Work", "r5RootType", "r5RootId", "r5Selection", "r5Allocation", "r5Consumption", "r5Schedule", "r5ClearRequested"] as const
type PointerRead = { kind: "BOUND"; pointers: CoalitionPointers } | { kind: "NONE" | "FOREIGN" | "INVALID"; pointers: null }
export function readCoalitionPointers(params: Pick<URLSearchParams, "get" | "getAll">, identity: CoalitionIdentity): PointerRead {
  if (!urlKeys.some(key => params.get(key) !== null)) return { kind: "NONE", pointers: null }
  if (urlKeys.some(key => params.getAll(key).length > 1) ||
    ["r5User", "r5Work", "r5RootType", "r5RootId", "r5Selection"].some(key => !params.get(key))) return { kind: "INVALID", pointers: null }
  if (params.get("r5User") !== identity.userId || params.get("r5Work") !== identity.workId ||
    params.get("r5RootType") !== identity.root.entityType || params.get("r5RootId") !== identity.root.entityId) return { kind: "FOREIGN", pointers: null }
  const selection = params.get("r5Selection"), allocation = params.get("r5Allocation")
  const consumption = params.get("r5Consumption"), schedule = params.get("r5Schedule"), requested = params.get("r5ClearRequested")
  if (![selection, allocation, consumption, schedule].every(value => value === null || digest.safeParse(value).success) ||
    consumption && !allocation || schedule && (!allocation || !consumption) || requested !== null && requested !== "1") return { kind: "INVALID", pointers: null }
  if (!selection) return { kind: "INVALID", pointers: null }
  return { kind: "BOUND", pointers: {
    selectionRef: coalitionRef("selection", selection), allocationRef: allocation ? coalitionRef("allocation", allocation) : null,
    consumptionRef: consumption ? coalitionRef("consumption", consumption) : null,
    scheduleRef: schedule ? coalitionRef("schedule", schedule) : null, clearRequested: requested === "1",
  } }
}
export function writeCoalitionPointers(params: URLSearchParams, identity: CoalitionIdentity, pointers: CoalitionPointers) {
  urlKeys.forEach(key => params.delete(key))
  params.set("r5User", identity.userId); params.set("r5Work", identity.workId)
  params.set("r5RootType", identity.root.entityType); params.set("r5RootId", identity.root.entityId)
  params.set("r5Selection", pointers.selectionRef.contentDigest)
  if (pointers.allocationRef) params.set("r5Allocation", pointers.allocationRef.contentDigest)
  if (pointers.consumptionRef) params.set("r5Consumption", pointers.consumptionRef.contentDigest)
  if (pointers.scheduleRef) params.set("r5Schedule", pointers.scheduleRef.contentDigest)
  if (pointers.clearRequested) params.set("r5ClearRequested", "1")
  return params
}
