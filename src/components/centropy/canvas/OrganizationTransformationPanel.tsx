"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { z } from "zod"
import { CentropyApiError, centropyGet, centropyPost } from "../lib/api"
import { useCentropyAuth } from "../lib/centropy-auth"
import { onBusinessInvalidation } from "../lib/business-invalidation"
import { usePrivateRequestScope } from "../lib/use-private-request-scope"
import { userMessage } from "../lib/user-message"

const id = z.string().uuid(), key = z.string().min(1).max(240), digest = z.string().regex(/^[a-f0-9]{64}$/)
const reference = z.object({ owner: key, id: key, version: key, contentDigest: digest })
const evidence = z.array(z.object({ field: z.string().min(1).max(160), ref: reference }).strict()).max(64)
const role = z.object({ id: key, principalId: id, teamId: key, kind: z.enum(["HUMAN", "DIGITAL", "PROVIDER"]),
  capabilities: z.array(key).max(64), availableSeconds: z.number(), committedSeconds: z.number(),
  compensationMinor: z.number(), benefitsDigest: key, safetyDigest: key, accessibilityDigest: key,
  authorityRefs: z.array(reference).max(32) })
const node = z.object({ id: key, kind: key, roleId: key, operation: key, after: z.array(key).max(64),
  requiredEvidence: z.array(key).max(64), mandatory: z.boolean(), effortSeconds: z.number() })
const asset = z.object({ id: key, kind: key, processId: key, nodeId: key,
  inputFields: z.array(key).max(64), outputFields: z.array(key).max(65), grantsAuthority: z.literal(false) })
const alternative = z.object({ id: key, kind: key, roles: z.array(role).max(64),
  processes: z.array(z.object({ id: key, family: key, serviceId: key, teamIds: z.array(key).max(4),
    nodes: z.array(node).max(64) })).max(32), constructedAssets: z.array(asset).max(1024),
  migrationHumanSeconds: z.number(), addedOperationHumanSeconds: z.number(),
  migrationCostMinor: z.number().nullable(), predictedImprovementSeconds: z.number().nullable(),
  predictionBasis: key, unresolved: z.array(z.string()).max(2048) })
const program = z.object({ schema: z.literal("finnor.organization-transformation-program.v1"),
  principalId: id, workId: id, workInputId: id, revision: z.number().int().nonnegative(),
  status: key, originalDeadline: z.string(), originalDigest: digest,
  recommendedAlternativeId: key, selectedAlternativeId: key.nullable(),
  alternatives: z.array(alternative).min(1).max(32),
  adoptions: z.array(z.object({ roleId: key, principalId: id, termsDigest: digest, state: key })).max(64),
  originalObligations: z.array(z.object({ id: key, workId: id, deadline: z.string(), state: key,
    consumedMinor: z.number().nullable(), unresolvedMinor: z.number().nullable(), currency: z.string().nullable() })).max(1024),
  originalResourceConstraints: z.array(z.object({ id: key, reservationStatus: key, originalDeadline: z.string(),
    originalWorks: z.array(z.object({ workId: id, initialMeaningDigest: digest })).max(1024),
    nativeOwners: z.array(z.object({ owner: key, id, status: key })).max(2048).optional(),
    monetaryExposure: z.object({ consumedMinor: z.null(), unresolvedMinor: z.null(), currency: z.null() }) })).max(1024),
  unresolved: z.array(z.string()).max(4096),
  claims: z.object({ actualAdoption: z.union([z.literal(false), z.literal("AUTHENTICATED_DECISIONS_ONLY")]),
    observedOperation: z.boolean(), fieldBenefit: z.literal(false), protectedAdmission: z.literal(false),
    newAuthorityGranted: z.literal(false) }) })
const use = z.object({ process_id: key, role_id: key, work_id: id, use_key: key,
  result: z.object({ behavior: key, approvalGranted: z.literal(false),
    externalEffectDispatched: z.literal(false), fullCostStatus: key }) })
const ownerRead = z.object({ access: z.literal("OWNER"), requestId: id, workId: id, workInputId: id,
  revision: z.number().int().nonnegative(), status: key, programDigest: digest.nullable(), originalDeadline: z.string(),
  program: program.nullable(), check: z.object({ status: key, programDigest: digest }).nullable(),
  currentness: z.object({ status: z.enum(["CURRENT", "INVALIDATED"]), affectedProcessIds: z.array(key).max(32) }),
  nativeUses: z.array(use).max(1024), pendingNativeWork: z.boolean(), lastError: z.string().nullable(),
  continuationRoutes: z.array(z.object({ obligationId: key, workId: id, processId: key,
    originalDeadline: z.string(), useKeys: z.array(key).max(1024) })).max(1024),
  continuationDiagnostics: z.array(z.object({ event_key: key, kind: key, created_at: z.string(),
    result: z.object({ status: key, originalWorkId: id, originalActionId: id,
      originalCoreActionStatus: key, originalCoreEffectStatus: key, originalExecutionOwner: z.enum(["CORE", "S6"]).optional(),
      unknownMoneyRetained: z.literal(true) }) })).max(16),
  transitionDiagnostics: z.array(z.object({ event_key: key, kind: key, created_at: z.string(),
    errors: z.array(z.string()).max(8192) })).max(16) })
const currentness = z.object({ status: z.enum(["CURRENT", "INVALIDATED"]), phase: key.nullable(),
  revision: z.number().int().nonnegative().nullable(), pendingNativeWork: z.boolean() })
const offer = z.object({ request_id: id, role_id: key, alternative_id: key, terms_digest: digest,
  expires_at: z.string(), revoked_at: z.string().nullable(), currentness,
  availableDecisions: z.array(z.enum(["ADOPT", "DECLINE", "REVOKE"])).max(3),
  disclosure: z.object({ requestId: id, workId: id, alternativeId: key, roleId: key, role,
    originalDeadline: z.string(), originalServiceIds: z.array(key).max(32),
    processes: z.array(z.object({ id: key, family: key, serviceId: key, constructedAssets: z.array(asset).max(1024),
      originalControls: z.array(z.object({ id: key, kind: key, roleId: key, requiredEvidence: z.array(key).max(64) })).max(64) })).max(32),
    employmentChanged: z.literal(false), originalLiabilitiesRetained: z.literal(true),
    actualUseEstablished: z.literal(false), fieldBenefitEstablished: z.literal(false) }).nullable() })
const offersRead = z.object({ access: z.literal("PARTICIPANT"), offers: z.array(offer).max(128),
  parentPrivateDataDisclosed: z.literal(false) })
const participantRead = z.object({ access: z.literal("PARTICIPANT"), requestId: id, offers: z.array(offer).max(128),
  decisions: z.array(z.object({ role_id: key, decision: z.enum(["ADOPT", "DECLINE", "REVOKE"]),
    terms_digest: digest, created_at: z.string() })).max(1024), selfUses: z.array(use).max(1024),
  parentPrivateDataDisclosed: z.literal(false) })
const packet = z.object({ requestId: id, useKey: key, processId: key, workId: id, recipientPrincipalId: id,
  control: z.object({ id: key, kind: key, roleId: key, mandatory: z.boolean(), requiredEvidence: z.array(key).max(64) }),
  termsDigest: digest, packetRef: reference, disclosureDigest: digest, currentness,
  disclosure: z.object({ originalWorkId: id, originalMeaningDigest: digest, preparedEvidence: evidence,
    approvalGranted: z.literal(false), externalEffectRequested: z.literal(false), sourceDocumentsReviewed: z.literal(false) }),
  read: z.object({ readRef: reference, acknowledgedAt: z.string() }).nullable() })
const packetsRead = z.object({ access: z.literal("ORIGINAL_CONTROL_RECIPIENT"), packets: z.array(packet).max(128),
  parentPrivateDataDisclosed: z.literal(false), unavailablePacketCount: z.number().int().nonnegative(),
  approvalGranted: z.literal(false), externalEffectDispatched: z.literal(false) })
const originalRead = z.object({ workId: id, originalInput: z.object({ workInputId: id, originalDeadline: z.string(),
  purpose: z.string(), currentInterval: z.boolean(), sourceClass: z.enum(["CONTROLLED", "FIELD"]) }).nullable(),
  executionAuthorityGranted: z.literal(false) })
const trialUnit = z.object({ unitId: id, workId: id, workInputId: id, workInputDigest: digest,
  enrollmentRef: reference }).refine(value => value.unitId === value.workInputId)
const nativeAssignment = z.object({ ref: reference, body: z.object({
  schema: z.literal("finnor.s2.w5-native-assignment.v1"), assignmentId: id, trialRef: reference,
  tenantId: id, principalId: id, requestId: id, unit: trialUnit, processId: key, selectedAlternativeDigest: digest,
  arm: z.enum(["ORIGINAL", "TRANSFORMED"]), performerRoleId: key, performerPrincipalId: id,
  assignedAt: z.string().datetime({ offset: true }), executionAuthorityGranted: z.literal(false),
}) }).refine(value => value.ref.owner === "S2" && value.ref.version === "w5-native-assignment-v1" &&
  value.ref.id === "w5-assignment:" + value.ref.contentDigest)
const selfTrialRead = z.object({ access: z.literal("PARTICIPANT"), requestId: id,
  currentness: z.enum(["CURRENT", "INVALIDATED"]), assignments: z.array(nativeAssignment).max(512),
  mailboxes: z.array(z.object({ assignmentRef: reference, idempotencyKey: key, packetRef: reference,
    jobId: id, jobStatus: key })).max(512),
  parentPrivateDataDisclosed: z.literal(false), executionAuthorityGranted: z.literal(false) })
const ownerTrialRead = z.object({ access: z.literal("OWNER"), requestId: id,
  trial: z.object({ ref: reference, body: z.object({
    schema: z.literal("finnor.s2.w5-prospective-trial.v1"), trialId: id, principalId: id, requestId: id,
    parentWorkId: id, parentWorkInputId: id, originalDigest: digest, selectedAlternativeId: key,
    selectedAlternativeDigest: digest, registeredRevision: z.number().int().nonnegative(),
    processId: key, evaluatorPrincipalId: id, originalDeadline: z.string().datetime({ offset: true }),
    assignment: z.object({ kind: z.literal("INDEPENDENT_BERNOULLI"), transformedNumerator: z.number().int().min(1).max(999999),
      denominator: z.literal(1000000), entropy: z.literal("NODE_CRYPTO_RANDOMINT") }),
    analysis: z.object({ kind: z.literal("BOUNDED_HT_HOEFFDING_FIXED_FINAL_LOOK"),
      minimumPerArm: z.number().int().min(20).max(100000), confidence: z.number().min(0.9).max(0.999) }),
    units: z.array(trialUnit).min(40).max(512), executionAuthorityGranted: z.literal(false),
  }) }).nullable(), assignments: z.array(nativeAssignment).max(512),
  observedAssignmentIds: z.array(id).max(512).optional(),
  assignmentCheck: z.object({ status: key }).optional(), executionAuthorityGranted: z.literal(false) })
const registrationInput = z.object({ units: z.array(z.object({ workId: id, workInputId: id,
  enrollmentRef: reference.refine(value => value.owner === "S1") }).strict()).min(40).max(512) }).strict()
type Owner = z.infer<typeof ownerRead>
type Offer = z.infer<typeof offer>
type Packet = z.infer<typeof packet>
type View = { owner: Owner | null; participant: z.infer<typeof participantRead> | null;
  offers: Offer[]; packets: z.infer<typeof packetsRead>; original: z.infer<typeof originalRead> | null;
  selfTrial: z.infer<typeof selfTrialRead> | null; ownerTrial: z.infer<typeof ownerTrialRead> | null }
type Scoped<T> = { key: string; value: T }
const evaluationRead = z.object({ requestId: id,
  currentness: z.literal("HISTORICAL_ASSESSMENT_NOT_AUTOMATICALLY_REQUALIFIED"),
  evaluation: z.object({ schema: z.literal("finnor.organization-native-operating-evaluation.v1"),
    requestId: id, originalWorkId: id, originalWorkInputId: id, programRevision: z.number().int().nonnegative(),
    originalDeadline: z.string(), status: z.literal("UNIDENTIFIED"), gaps: z.array(z.string()).max(4096),
    originalCount: z.number().int().nonnegative(), transformedCount: z.number().int().nonnegative(),
    improvementSeconds: z.number().finite().nullable(), lowerConfidenceBoundSeconds: z.number().finite().nullable(),
    bound: z.enum(["BOUNDED_HT_HOEFFDING_FIXED_FINAL_LOOK", "DESCRIPTIVE_UNADMITTED_NOT_A_CAUSAL_BOUND"]).optional(),
    causalContext: z.object({ assignmentVerified: z.boolean(), causalTaskEstimateIdentified: z.boolean().optional(),
      registeredTaskElapsedMarginEstablished: z.boolean().optional(), causalBenefitEstablished: z.literal(false),
      taskElapsedEstimateIsFullCostOrWealthBenefit: z.literal(false).optional() }).optional(),
    actualNativeUseObserved: z.boolean(), humanFieldAdoptionEstablished: z.literal(false),
    fieldBenefitEstablished: z.literal(false), recommendedDisposition: key,
    fullCost: z.object({ status: z.literal("UNKNOWN"), monetaryCostMinor: z.null(),
      humanSupervisionSeconds: z.null(), computeComplete: z.boolean(),
      computeRecords: z.array(z.object({ ref: reference })).max(1024) }) }).nullable() })
const label = (value: string) => value.replaceAll("_", " ").toLowerCase()
const date = (value: string) => new Date(value).toLocaleString()
const base = "organization/transformation-programs/"

/** Role is part of the scope, not just a rendering condition. Every read and
 * mutation also belongs to one monotone request generation. No server imports. */
export function OrganizationTransformationPanel({ workId, onChanged }: { workId: string; onChanged?: () => void }) {
  const auth = useCentropyAuth(), isOwner = auth.role === "owner"
  const principalId = auth.session?.user.id
  const scope = usePrivateRequestScope(JSON.stringify(["organization", workId, auth.role,
    auth.loading, auth.roleLoading, Boolean(auth.roleError), Boolean(auth.authError)]), "WORKFORCE_PARTICIPANT")
  const { key: scopeKey, isCurrent: scopeIsCurrent, invalidate: invalidateScope } = scope
  const allowed = scope.allowed && !auth.loading && !auth.roleLoading
  const [stored, setStored] = useState<Scoped<View> | null>(null)
  const [assessment, setAssessment] = useState<Scoped<z.infer<typeof evaluationRead>> | null>(null)
  const [message, setMessage] = useState<Scoped<string> | null>(null)
  const [draft, setDraft] = useState<Scoped<{ offer: string; process: string; text: string;
    operatingWorkId: string; assignmentId: string | null }> | null>(null)
  const [rosterDraft, setRosterDraft] = useState<Scoped<string> | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [reading, setReading] = useState<string | null>(null)
  const generation = useRef(0), inFlight = useRef<{ key: string; serial: number } | null>(null)
  const transport = useRef<AbortController | null>(null)
  const mutation = useRef<{ key: string; serial: number } | null>(null)
  const head = useRef<{ key: string; revisions: Map<string, number> }>({ key: scope.key, revisions: new Map() })
  if (head.current.key !== scope.key) {
    head.current = { key: scope.key, revisions: new Map() }
    generation.current += 1
  }
  const view = allowed && stored?.key === scope.key ? stored.value : null
  const owner = isOwner ? view?.owner ?? null : null
  const graph = owner?.currentness.status === "CURRENT" ? owner.program : null
  const working = busy === scope.key
  const currentDraft = draft?.key === scope.key ? draft.value : null
  const currentRoster = rosterDraft?.key === scope.key ? rosterDraft.value : ""
  const currentAssessment = assessment?.key === scope.key ? assessment.value : null

  const refresh = useCallback(async () => {
    const key = scopeKey
    if (mutation.current?.key === key) return
    if (inFlight.current?.key === key && inFlight.current.serial === generation.current) return
    transport.current?.abort()
    const controller = new AbortController()
    transport.current = controller
    const serial = ++generation.current
    const current = () => scopeIsCurrent(key) && serial === generation.current
    setStored(null); setAssessment(null); setMessage(null); setDraft(null); setRosterDraft(null)
    if (!allowed || !navigator.onLine || document.visibilityState === "hidden") return
    inFlight.current = { key, serial }; setReading(key)
    try {
      const maybeOwner = async () => {
        if (!isOwner) return null
        try {
          const value = z.discriminatedUnion("access", [ownerRead, participantRead])
            .parse(await centropyGet(base + "read", { workId }, controller.signal))
          return value.access === "OWNER" ? value : null
        } catch (error) {
          if (error instanceof CentropyApiError && error.status === 404) return null
          throw error
        }
      }
      const [own, listing, mailbox] = await Promise.all([
        maybeOwner(), centropyGet(base + "offers", { workId }, controller.signal).then(value => offersRead.parse(value)),
        centropyGet(base + "packets", { workId }, controller.signal).then(value => packetsRead.parse(value)),
      ])
      if (!current()) return
      const requestIds = [...new Set(listing.offers.map(item => item.request_id))]
      if (requestIds.length > 1) throw Error("The original Work has conflicting organization episodes")
      const trialRequestId = own?.requestId ?? requestIds[0]
      const maybeTrial = async <T,>(schema: z.ZodType<T>, audience?: "SELF") => {
        if (!trialRequestId) return null
        try { return schema.parse(await centropyGet(base + "trial",
          { requestId: trialRequestId, ...(audience ? { audience } : {}) }, controller.signal)) } catch (error) {
          if (error instanceof CentropyApiError && error.status === 404) return null
          throw error
        }
      }
      const maybeOriginal = async () => {
        if (!isOwner) return null
        try { return originalRead.parse(await centropyGet(base + "input", { workId }, controller.signal)) } catch (error) {
          if (error instanceof CentropyApiError && (error.status === 404 || !own && error.status === 403)) return null
          throw error
        }
      }
      const [self, evaluation, ownTrial, selfTrial, original] = await Promise.all([
        !own && requestIds[0] ? centropyGet(base + "read", { requestId: requestIds[0], workId }, controller.signal)
          .then(value => participantRead.parse(value)) : Promise.resolve(null),
        own ? centropyGet(base + "evaluation", { requestId: own.requestId }, controller.signal)
          .then(value => evaluationRead.parse(value)) : Promise.resolve(null),
        own?.currentness.status === "CURRENT" ? maybeTrial(ownerTrialRead) : Promise.resolve(null),
        listing.offers.length ? maybeTrial(selfTrialRead, "SELF") : Promise.resolve(null),
        maybeOriginal(),
      ])
      if (!current()) return
      const selfOffers = self?.offers ?? listing.offers
      if (own && (own.workId !== workId || own.program && (own.program.workId !== workId ||
          own.program.principalId !== principalId ||
          own.program.workInputId !== own.workInputId || own.program.revision !== own.revision ||
          own.check?.status !== "CHECKED" || own.check.programDigest !== own.programDigest)) ||
          original && original.workId !== workId || self && self.requestId !== requestIds[0] ||
          evaluation && (evaluation.requestId !== own?.requestId || evaluation.evaluation &&
            (evaluation.evaluation.requestId !== own?.requestId || evaluation.evaluation.originalWorkId !== workId)) ||
          selfOffers.some(item => item.disclosure && (item.disclosure.workId !== workId ||
            item.disclosure.role.principalId !== principalId ||
            item.disclosure.requestId !== item.request_id || item.disclosure.roleId !== item.role_id ||
            item.disclosure.alternativeId !== item.alternative_id)) ||
          mailbox.packets.some(item => item.workId !== workId || item.disclosure.originalWorkId !== item.workId ||
            item.recipientPrincipalId !== principalId || item.currentness.status !== "CURRENT" ||
            item.currentness.revision === null) ||
          selfTrial && (selfTrial.requestId !== trialRequestId ||
            selfTrial.currentness === "INVALIDATED" && (selfTrial.assignments.length > 0 || selfTrial.mailboxes.length > 0) ||
            selfTrial.assignments.some(item => item.body.requestId !== trialRequestId ||
              item.body.performerPrincipalId !== principalId ||
              !selfOffers.some(offered => offered.request_id === item.body.requestId && offered.role_id === item.body.performerRoleId)) ||
            selfTrial.mailboxes.some(item => !selfTrial.assignments.some(assigned => assigned.body.arm === "TRANSFORMED" &&
              assigned.ref.id === item.assignmentRef.id && assigned.ref.contentDigest === item.assignmentRef.contentDigest))) ||
          ownTrial && (ownTrial.requestId !== own?.requestId || ownTrial.trial &&
            (ownTrial.trial.body.requestId !== own?.requestId || ownTrial.trial.body.parentWorkId !== workId ||
              ownTrial.trial.body.parentWorkInputId !== own?.workInputId || ownTrial.trial.body.principalId !== principalId ||
              ownTrial.trial.body.originalDigest !== own?.program?.originalDigest ||
              ownTrial.trial.body.selectedAlternativeId !== own?.program?.selectedAlternativeId ||
              ownTrial.trial.body.registeredRevision > (own?.revision ?? -1) ||
              Date.parse(ownTrial.trial.body.originalDeadline) !== Date.parse(own?.originalDeadline ?? "")) ||
            !ownTrial.trial && ownTrial.assignments.length > 0))
        throw Error("The current original Work and your exact native terms could not be verified")
      const batchRevisions = new Map<string, number>()
      let revisionError: Error | null = null
      const remember = (requestId: string, revision: number) => {
        const prior = head.current.revisions.get(requestId) ?? -1
        head.current.revisions.set(requestId, Math.max(prior, revision))
        if (batchRevisions.has(requestId) && batchRevisions.get(requestId) !== revision)
          revisionError ??= Error("Organization revisions changed while reading. The mixed snapshot was withdrawn")
        if (prior > revision)
          revisionError ??= Error("An older organization revision was withdrawn")
        batchRevisions.set(requestId, revision)
      }
      if (own) remember(own.requestId, own.revision)
      for (const item of selfOffers) if (item.currentness.revision !== null)
        remember(item.request_id, item.currentness.revision)
      for (const item of mailbox.packets) remember(item.requestId, item.currentness.revision!)
      if (revisionError) throw revisionError
      setStored({ key, value: { owner: own, participant: self, offers: selfOffers, packets: mailbox, original,
        ownerTrial: ownTrial, selfTrial } })
      setAssessment(evaluation ? { key, value: evaluation } : null)
    } catch (error) {
      controller.abort()
      if (current()) setMessage({ key, value: userMessage(error, "Current authorized organization unavailable") })
    } finally {
      if (transport.current === controller) transport.current = null
      if (inFlight.current?.key === key && inFlight.current.serial === serial) {
        inFlight.current = null; setReading(null)
      }
    }
  }, [allowed, isOwner, principalId, scopeIsCurrent, scopeKey, workId])

  useEffect(() => {
    setBusy(null); setDraft(null); setRosterDraft(null); void refresh()
    return () => { generation.current += 1; transport.current?.abort(); transport.current = null }
  }, [refresh])
  useEffect(() => {
    const withdraw = () => {
      transport.current?.abort(); transport.current = null; mutation.current = null
      generation.current += 1; inFlight.current = null
      setStored(null); setAssessment(null); setDraft(null); setRosterDraft(null); setMessage(null); setBusy(null); invalidateScope()
    }
    window.addEventListener("offline", withdraw); window.addEventListener("online", withdraw)
    document.addEventListener("visibilitychange", withdraw)
    const unsubscribe = onBusinessInvalidation(signal => {
      if (signal.tags.some(tag => ["work", "workforce", "agents", "authority", "source", "workspace"].includes(tag))) withdraw()
    })
    return () => {
      window.removeEventListener("offline", withdraw); window.removeEventListener("online", withdraw)
      document.removeEventListener("visibilitychange", withdraw); unsubscribe()
    }
  }, [invalidateScope])
  useEffect(() => {
    if (!allowed || working || reading === scope.key || currentDraft?.text || currentDraft?.operatingWorkId || currentRoster.trim()) return
    const pending = owner?.pendingNativeWork || view?.offers.some(item => item.currentness.pendingNativeWork)
    const timer = window.setTimeout(() => void refresh(), pending ? 3000 : 15000)
    return () => window.clearTimeout(timer)
  }, [allowed, currentDraft?.text, currentDraft?.operatingWorkId, currentRoster, owner?.pendingNativeWork, reading, refresh, scope.key, view, working])

  async function mutate(
    operation: "action" | "adoption" | "process-use" | "trial" | "packet-read" | "submit" | "continuation" | "evaluation",
    body: unknown,
  ) {
    const key = scope.key
    if (mutation.current || working || !allowed || !scope.isCurrent(key) || !navigator.onLine || document.visibilityState === "hidden") return
    transport.current?.abort()
    const controller = new AbortController()
    transport.current = controller
    const serial = ++generation.current
    const marker = { key, serial }
    mutation.current = marker
    const current = () => scope.isCurrent(key) && serial === generation.current
    setStored(null); setAssessment(null); setDraft(null); setRosterDraft(null); setMessage(null); setBusy(key)
    try {
      await centropyPost(base + operation, body, controller.signal)
      if (current()) {
        mutation.current = null; setBusy(null)
        await refresh()
        if (scope.isCurrent(key)) onChanged?.()
      }
    } catch {
      if (current()) setMessage({ key, value:
        "The response is uncertain. Refresh the original native record before another action. No request was retried." })
    } finally {
      if (transport.current === controller) transport.current = null
      if (mutation.current === marker) { mutation.current = null; if (scope.isCurrent(key)) setBusy(null) }
    }
  }
  async function ownerAction(action: Record<string, unknown>) {
    if (!owner || !isOwner || owner.pendingNativeWork) return
    await mutate("action", { requestId: owner.requestId, expectedRevision: owner.revision,
      idempotencyKey: "organization-ui:" + crypto.randomUUID(), action })
  }
  async function decide(item: Offer, decision: "ADOPT" | "DECLINE" | "REVOKE") {
    if (!item.availableDecisions.includes(decision) ||
        decision !== "REVOKE" && (!item.disclosure || item.currentness.status !== "CURRENT")) return
    await mutate("adoption", { requestId: item.request_id, roleId: item.role_id, alternativeId: item.alternative_id,
      termsDigest: item.terms_digest, decision, idempotencyKey: "organization-ui:" + crypto.randomUUID() })
  }
  async function prepare(item: Offer, processId: string) {
    if (currentDraft?.offer !== item.role_id || currentDraft.process !== processId || item.currentness.status !== "CURRENT" ||
        decisionFor(item) !== "ADOPT" || !["TRIAL", "ACTIVE"].includes(item.currentness.phase ?? "") ||
        item.currentness.pendingNativeWork || view?.selfTrial?.currentness === "INVALIDATED") return
    const assignments = assignmentsFor(item, processId)
    const assigned = assignments.find(value => value.body.assignmentId === currentDraft.assignmentId)
    if (currentDraft.assignmentId && !assigned || assignments.length && !assigned ||
        assigned && (assigned.body.arm !== "TRANSFORMED" || assigned.body.unit.workId !== currentDraft.operatingWorkId ||
          mailboxFor(assigned.ref.id))) return
    const operatingWork = id.safeParse(currentDraft.operatingWorkId)
    if (!operatingWork.success || operatingWork.data === workId) {
      setMessage({ key: scope.key, value: "Select the genuine transformed assignment or enter the actual existing nontrial operating Work." }); return
    }
    let input: z.infer<typeof evidence>
    try { input = evidence.parse(JSON.parse(currentDraft.text)) } catch {
      setMessage({ key: scope.key, value: "Enter the actual current source references for each required evidence field." }); return
    }
    await mutate("process-use", { requestId: item.request_id, processId, roleId: item.role_id, workId: operatingWork.data,
      ...(assigned ? { trialAssignmentRef: assigned.ref } : {}),
      evidence: input, idempotencyKey: "organization-ui:" + crypto.randomUUID() })
  }
  async function registerTrial() {
    if (!owner || !graph || graph.status !== "TRIAL" || owner.pendingNativeWork || view?.ownerTrial?.trial !== null) return
    let registration: z.infer<typeof registrationInput>
    try {
      registration = registrationInput.parse(JSON.parse(currentRoster))
      if (new Set(registration.units.map(unit => unit.workId)).size !== registration.units.length ||
          new Set(registration.units.map(unit => unit.workInputId)).size !== registration.units.length ||
          registration.units.some(unit => unit.workId === workId)) throw Error("Original units must be distinct")
    } catch {
      setMessage({ key: scope.key, value: "Enter 40–512 distinct genuine operating Work/input pairs and their actual S1 enrollment references. No arm, seed or probability input is accepted." }); return
    }
    await mutate("trial", { requestId: owner.requestId, expectedRevision: owner.revision, units: registration.units,
      idempotencyKey: "organization-ui:" + crypto.randomUUID() })
  }
  async function acknowledge(item: Packet) {
    if (item.recipientPrincipalId !== principalId || item.currentness.status !== "CURRENT" ||
        item.currentness.pendingNativeWork || item.read) return
    await mutate("packet-read", { requestId: item.requestId, useKey: item.useKey, controlId: item.control.id,
      termsDigest: item.termsDigest, packetRef: item.packetRef, disclosureDigest: item.disclosureDigest,
      idempotencyKey: "organization-ui:" + crypto.randomUUID() })
  }
  const decisionFor = (item: Offer) => view?.participant?.decisions.filter(value => value.role_id === item.role_id).at(-1)?.decision ??
    (graph?.adoptions.find(value => value.roleId === item.role_id && value.principalId === principalId)?.state === "ADOPTED" ? "ADOPT" : null)
  const assignmentsFor = (item: Offer, processId?: string) => view?.selfTrial?.currentness === "CURRENT"
    ? view.selfTrial.assignments.filter(value => value.body.requestId === item.request_id &&
      value.body.performerRoleId === item.role_id && (!processId || value.body.processId === processId)) : []
  const mailboxFor = (assignmentRefId: string) => view?.selfTrial?.mailboxes.find(value => value.assignmentRef.id === assignmentRefId)
  const recorded = currentAssessment?.evaluation
  const assessmentMatches = owner?.currentness.status === "CURRENT" && owner.program && recorded &&
    recorded.requestId === owner.requestId && recorded.originalWorkId === workId &&
    recorded.originalWorkInputId === owner.workInputId && recorded.programRevision === owner.revision &&
    Date.parse(recorded.originalDeadline) === Date.parse(owner.originalDeadline)
  const estimate = assessmentMatches ? recorded : null
  const identifiedTaskEstimate = estimate?.bound === "BOUNDED_HT_HOEFFDING_FIXED_FINAL_LOOK" &&
    estimate.causalContext?.assignmentVerified === true && estimate.causalContext.causalTaskEstimateIdentified === true &&
    estimate.improvementSeconds !== null && estimate.lowerConfidenceBoundSeconds !== null
  if (!allowed || view && !owner && !view.original?.originalInput && !view.offers.length && !view.packets.packets.length) return null
  return <section className="ct-canvas-block" aria-label="Organization transformation programme" data-organization-work={workId}>
    <header><div><span className="ct-eyebrow">ORIGINAL ORGANIZATION</span><h3>Organization transformation</h3></div>
      <button type="button" disabled={working} onClick={() => void refresh()}>Refresh current original terms</button></header>
    <p>Improve evidence and coordination without changing employment, mandatory controls, original Work, deadlines or resource ceilings.
      Selection, self-adoption, actual use and business benefit are separate.</p>
    <p role="status">{message?.key === scope.key ? message.value : working ? "Submitting one authenticated request…" :
      owner ? `Revision ${owner.revision} · ${label(owner.status)}${owner.pendingNativeWork ? " · native work pending" : ""}` :
        view ? "Your currently authorized contracts only." : "Reading current authorized organization…"}</p>
    {view?.original?.originalInput && !owner && isOwner ? <div>
      <p>{view.original.originalInput.purpose}. Original deadline {date(view.original.originalInput.originalDeadline)}.</p>
      <button type="button" disabled={working || !view.original.originalInput.currentInterval}
        onClick={() => void mutate("submit", { workId, workInputId: view.original!.originalInput!.workInputId,
          idempotencyKey: "organization-ui:" + crypto.randomUUID() })}>Compile this immutable original input</button>
    </div> : null}
    {owner?.currentness.status === "INVALIDATED" ? <p role="alert">Current source or authority no longer supports this proposal.
      The private graph is withdrawn. Existing responsibility and possible effects remain retained.</p> : null}
    {owner?.lastError ? <p role="alert">Native result: {label(owner.lastError)}. No unresolved obligation was discarded.</p> : null}
    {owner && graph ? <>
      <p>Original deadline {date(graph.originalDeadline)}. No new execution authority or protected admission is granted.</p>
      <section aria-label="Alternative operating processes"><h4>Retain or change the operating process</h4>
        {graph.alternatives.map(item => <details key={item.id}><summary>{label(item.kind)}
          {item.id === graph.recommendedAlternativeId ? " · unqualified compiler recommendation" : ""}
          {item.id === graph.selectedAlternativeId ? " · selected" : ""}</summary>
          <p>Migration effort hypothesis {item.migrationHumanSeconds} seconds; added operating effort hypothesis {item.addedOperationHumanSeconds} seconds.
            Migration money {item.migrationCostMinor === null ? "unknown" : `${item.migrationCostMinor} original minor units`}.
            Prediction: {label(item.predictionBasis)}, not causal gain or cash savings.</p>
          {item.processes.map(process => <table key={process.id}><caption>{process.id} · {label(process.family)} · service {process.serviceId}</caption>
            <thead><tr><th scope="col">Node</th><th scope="col">Accountable role</th><th scope="col">Original control and dependencies</th></tr></thead>
            <tbody>{process.nodes.map(step => <tr key={step.id}><td>{step.id}<p>{label(step.kind)} · {step.operation}</p></td>
              <td>{step.roleId}</td><td>{step.mandatory ? "Mandatory control retained" : "No approval authority"}
                <p>After {step.after.join(", ") || "original entry"}. Evidence: {step.requiredEvidence.join(", ") || "none declared"}.</p></td></tr>)}</tbody></table>)}
          <details><summary>Exact role protections and authority references</summary><pre>{JSON.stringify(item.roles, null, 2)}</pre></details>
          {!graph.selectedAlternativeId ? <button type="button" disabled={working || owner.pendingNativeWork}
            onClick={() => void ownerAction({ kind: "SELECT", alternativeId: item.id })}>
            {item.kind === "RETAIN" ? "Retain the original arrangement" : "Select this alternative, without adopting for anyone"}</button> : null}
        </details>)}
      </section>
      <section aria-label="Retained original responsibilities"><h4>Original responsibilities stay with their owners</h4>
        <p>{graph.originalObligations.length} original obligation records; {graph.originalResourceConstraints.length} existing S5 constraints.
          Resource quantities, attempts and salaried time are not cash observations.</p>
        {graph.originalObligations.map(item => <p key={item.id}>{item.id} · {label(item.state)} · original Work {item.workId} · deadline {date(item.deadline)}.
          Consumed money {item.consumedMinor ?? "unknown"}; unresolved money {item.unresolvedMinor ?? "unknown"}; currency {item.currency ?? "unknown"}.</p>)}
        {graph.originalResourceConstraints.map(item => <p key={item.id}>{item.id} · {label(item.reservationStatus)} · deadline {date(item.originalDeadline)}.
          {item.originalWorks.length ? ` ${item.originalWorks.length} genuine original Work links.` : " Company hold, no invented Work."}
          {item.nativeOwners?.length ? ` ${item.nativeOwners.map(value => value.owner).join(", ")} original owner bindings retained.` : ""}
          {" "}Monetary exposure unknown.</p>)}
      </section>
      <section aria-label="Owner transition requests"><h4>Request a native checked transition</h4>
        <button type="button" disabled={working || owner.pendingNativeWork || graph.status !== "ADOPTED"}
          onClick={() => void ownerAction({ kind: "MIGRATE", stage: "TRIAL" })}>Request trial after exact self-adoption</button>
        <button type="button" disabled={working || owner.pendingNativeWork || graph.status !== "TRIAL" || !graph.claims.observedOperation}
          onClick={() => void ownerAction({ kind: "MIGRATE", stage: "ACTIVE" })}>Request active operation, not field qualification</button>
      </section>
      <section aria-label="Prospective native operating units"><h4>One predeclared operating-unit population</h4>
        {view?.ownerTrial?.trial ? <>
          <p>{view.ownerTrial.trial.body.units.length} original registered units.
            {view.ownerTrial.assignments.length} stored assignment records; {view.ownerTrial.observedAssignmentIds?.length ?? "unknown"} independent outcome records.
            These counts do not establish service, native provenance, scientific admission or business benefit.</p>
          <p>Original transformed probability {view.ownerTrial.trial.body.assignment.transformedNumerator}/{
            view.ownerTrial.trial.body.assignment.denominator}. Native cryptographic draws are immutable.
            No arm swap, new seed or replacement draw is available.</p>
          <p>Structural assignment checker: {label(view.ownerTrial.assignmentCheck?.status ?? "UNVERIFIED")}.
            Owning causal and full-cost evaluation is still required.</p>
        </> : view?.ownerTrial?.trial === null ? <>
          <p>No native trial is registered. The server must verify the existing authenticated preregistration,
            complete pristine real units, unchanged original resources and independent evaluator before assignment.
            This is not staffing, field-research or effect approval.</p>
          <label>Complete original unit roster, JSON with a units array of workId, workInputId and enrollmentRef
            <textarea value={currentRoster} maxLength={262144} disabled={working || owner.pendingNativeWork || graph.status !== "TRIAL"}
              onChange={event => setRosterDraft({ key: scope.key, value: event.target.value })} /></label>
          <button type="button" disabled={working || owner.pendingNativeWork || graph.status !== "TRIAL" || !currentRoster.trim()}
            onClick={() => void registerTrial()}>Register the original roster once, without choosing arms</button>
        </> : <p>Current trial context is unavailable. No registration or new random draw is offered.</p>}
      </section>
    </> : null}
    {owner ? <div>
      <button type="button" disabled={working || owner.pendingNativeWork} onClick={() => void ownerAction({ kind: "RECONCILE" })}>Reconcile existing responsibility, without effect replay</button>
      <button type="button" disabled={working || owner.pendingNativeWork} onClick={() => void ownerAction({ kind: "ROLLBACK" })}>Request lawful rollback, retain unresolved obligations</button>
      <button type="button" disabled={working || owner.pendingNativeWork} onClick={() => void ownerAction({ kind: "CANCEL" })}>Cancel the proposal, not original obligations</button>
      {owner.transitionDiagnostics.length ? <details><summary>Recorded blocked transition reasons, not a new disposition</summary>
        {owner.transitionDiagnostics.map(item => <p key={item.event_key}>{date(item.created_at)}: {item.errors.join("; ")}</p>)}</details> : null}
      {owner.continuationRoutes.length ? <section aria-label="Original effect continuity"><h4>Continue only the original owner&apos;s responsibility</h4>
        <p>A prepared packet is not approval. S6 continuation reads its actual original owner only.
          Core may continue only its already approved, never-dispatched original action.
          Original reservations remain authoritative. UNKNOWN and existing execution are observed, never blindly replayed.</p>
        {owner.continuationRoutes.flatMap(route => route.useKeys.map(useKey => <div key={route.obligationId + ":" + useKey}>
          <p>Original obligation {route.obligationId}. Work {route.workId}. Deadline {date(route.originalDeadline)}.</p>
          <button type="button" disabled={working || owner.pendingNativeWork || !graph}
            onClick={() => void mutate("continuation", { requestId: owner.requestId, expectedRevision: owner.revision,
              obligationId: route.obligationId, processId: route.processId, workId: route.workId, useKey,
              idempotencyKey: "organization-ui:" + crypto.randomUUID() })}>
            Request continuity from the same original owner, without new approval
          </button>
        </div>))}
        {owner.continuationDiagnostics.map(item => <p key={item.event_key}>{label(item.result.status)}.
          {" "}{item.result.originalExecutionOwner ?? "Original"} execution owner.
          Original action {item.result.originalActionId}: {label(item.result.originalCoreActionStatus)}.
          Effect {label(item.result.originalCoreEffectStatus)}. Unobserved money remains unknown.</p>)}
      </section> : null}
      <section aria-label="Native causal and full-cost assessment"><h4>Assess actual use without inventing business benefit</h4>
        <button type="button" disabled={working || owner.pendingNativeWork}
          onClick={() => void mutate("evaluation", { requestId: owner.requestId,
            idempotencyKey: "organization-ui:" + crypto.randomUUID() })}>Assess complete native observations and cost gaps</button>
        {estimate ? <div>
          <p>{label(estimate.status)}. Historical assessment only.
            Current unit, source and native heads have not been requalified by this read.</p>
          <p>Recorded then: {estimate.originalCount} original-arm and {estimate.transformedCount} transformed-arm observations.</p>
          {identifiedTaskEstimate ? <p>Recorded bounded task-elapsed estimate {estimate.improvementSeconds} seconds;
            lower confidence bound {estimate.lowerConfidenceBoundSeconds} seconds.
            This fixed-final-look estimate is not full-cost, wealth, field or scientific benefit.</p> :
            <p>Recorded task-elapsed effect was unidentified or unadmitted. Point value {estimate.improvementSeconds ?? "unknown"} seconds
              does not establish causal business benefit.</p>}
          <p>At that assessment: {estimate.fullCost.computeRecords.length} verified S7 local compute records.
            Coverage {estimate.fullCost.computeComplete ? "complete for recorded native phases" : "incomplete"}.
            Money, migration and human supervision remain unknown. Field benefit is not established.</p>
          <p>Disposition recorded then: {label(estimate.recommendedDisposition)}, subject to the lawful obligation bridge.</p>
          <details><summary>Separate unresolved qualification gaps</summary><ul>
            {estimate.gaps.map(gap => <li key={gap}>{label(gap)}</li>)}
          </ul></details>
        </div> : <p>{currentAssessment?.evaluation ? "The earlier assessment does not match the current original context and is withdrawn." : "No native operating assessment recorded."}</p>}
      </section>
    </div> : null}
    {view?.offers.map(item => <article key={item.request_id + ":" + item.role_id} aria-label={`Your organization role ${item.role_id}`}>
      <h4>Your exact role: {item.role_id}</h4>
      {item.disclosure ? <>
        <p>{label(item.disclosure.role.kind)} · team {item.disclosure.role.teamId}. Original deadline {date(item.disclosure.originalDeadline)}.
          Required services: {item.disclosure.originalServiceIds.join(", ")}. Your latest decision: {label(decisionFor(item) ?? "UNOBSERVED")}.</p>
        <details><summary>Read exact role terms and unchanged protections</summary><pre>{JSON.stringify(item.disclosure.role, null, 2)}</pre>
          <p>Exact terms digest {item.terms_digest}. Employment and original liabilities are unchanged.</p></details>
      </> : <p role="alert">Current original terms were withdrawn. Only revocation of your own historical decision remains available.</p>}
      {item.availableDecisions.map(decision => <button type="button" key={decision}
        disabled={working || decision !== "REVOKE" && (item.currentness.pendingNativeWork || decisionFor(item) === decision)}
        onClick={() => void decide(item, decision)}>{decision === "ADOPT" ? "I adopt these exact role terms" :
          decision === "DECLINE" ? "I decline these exact role terms" : "I revoke my own adoption"}</button>)}
      {view?.selfTrial?.currentness === "INVALIDATED" ? <p role="alert">Your operating assignments are withdrawn because current terms or unit input changed.
        Existing jobs and possible effects are not replaced.</p> : null}
      {assignmentsFor(item).length ? <details><summary>Your own original operating assignments</summary>
        {assignmentsFor(item).map(assigned => <p key={assigned.ref.id}>Work {assigned.body.unit.workId};
          input {assigned.body.unit.workInputId}: {label(assigned.body.arm)} arm.
          {assigned.body.arm === "ORIGINAL" ? " Original-arm units have no transformed-use control." :
            mailboxFor(assigned.ref.id) ? ` Original mailbox ${mailboxFor(assigned.ref.id)!.jobId}: ${label(mailboxFor(assigned.ref.id)!.jobStatus)}. Read-only; no replacement or requeue is offered.` :
              " This committed transformed assignment has no submitted mailbox in this readback."}</p>)}
      </details> : null}
      {item.disclosure?.processes.filter(process => process.constructedAssets.length > 0).map(process => {
        const assignments = assignmentsFor(item, process.id), transformed = assignments.filter(value =>
          value.body.arm === "TRANSFORMED" && !mailboxFor(value.ref.id))
        const canPrepare = decisionFor(item) === "ADOPT" && ["TRIAL", "ACTIVE"].includes(item.currentness.phase ?? "") &&
          !item.currentness.pendingNativeWork && item.currentness.status === "CURRENT" &&
          view?.selfTrial?.currentness !== "INVALIDATED" && (!assignments.length || transformed.length > 0)
        const activeDraft = currentDraft?.offer === item.role_id && currentDraft.process === process.id ? currentDraft : null
        const text = activeDraft?.text ?? ""
        return <div key={process.id}><p>{process.id} · required current evidence fields: {
          [...new Set(process.constructedAssets.flatMap(value => value.inputFields))].join(", ")}.</p>
          {canPrepare ? <>
            {assignments.length ? <label>Your immutable transformed operating unit
              <select value={activeDraft?.assignmentId ?? ""} disabled={working} onChange={event => {
                const assigned = transformed.find(value => value.body.assignmentId === event.target.value)
                setDraft({ key: scope.key, value: { offer: item.role_id, process: process.id, text: "",
                  operatingWorkId: assigned?.body.unit.workId ?? "", assignmentId: assigned?.body.assignmentId ?? null } })
              }}><option value="">Select your actual assignment</option>
                {transformed.map(value => <option key={value.ref.id} value={value.body.assignmentId}>{value.body.unit.workId}</option>)}
              </select></label> : <label>Actual existing nontrial operating Work, not the programme Work
              <input value={activeDraft?.operatingWorkId ?? ""} maxLength={36} disabled={working} onChange={event =>
                setDraft({ key: scope.key, value: { offer: item.role_id, process: process.id, text: "",
                  operatingWorkId: event.target.value, assignmentId: null } })} /></label>}
            <label>Actual current source references, JSON
              <textarea value={text} maxLength={65536} disabled={working || !activeDraft?.operatingWorkId}
                onChange={event => setDraft({ key: scope.key, value: { offer: item.role_id, process: process.id,
                  operatingWorkId: activeDraft?.operatingWorkId ?? "", assignmentId: activeDraft?.assignmentId ?? null,
                  text: event.target.value } })} /></label>
            <p>Only genuine authorized operating Work is accepted. Pending, original-arm or foreign assignments cannot be bypassed.
              A committed mailbox cannot be replaced after an uncertain response.</p>
            <button type="button" disabled={working || !text.trim() || !id.safeParse(activeDraft?.operatingWorkId).success ||
              activeDraft?.operatingWorkId === workId ||
              assignments.length > 0 && !activeDraft?.assignmentId} onClick={() => void prepare(item, process.id)}>
              Prepare evidence for the unchanged original recipient</button></> : <p>Actual trial, exact self-adoption and current evidence are required before use.</p>}
        </div>
      })}
    </article>)}
    {view?.packets.packets.map(item => <article key={item.requestId + ":" + item.useKey + ":" + item.control.id}
      aria-label={`Your original control packet ${item.control.id}`}>
      <h4>Prepared packet for your unchanged {label(item.control.kind)} control</h4>
      <p>Control {item.control.id}. This is a reference packet, not underlying document review, Core approval or effect authorization.</p>
      <pre>{JSON.stringify(item.disclosure.preparedEvidence, null, 2)}</pre>
      <p>Packet digest {item.disclosureDigest}.</p>
      {item.read ? <p>Your reference-packet read was acknowledged at {date(item.read.acknowledgedAt)}. Core approval is still separate.</p> :
        <button type="button" disabled={working || item.currentness.pendingNativeWork}
          onClick={() => void acknowledge(item)}>I read this exact reference packet, not approve its effect</button>}
    </article>)}
    {view ? <section aria-label="Observed operation and qualification"><h4>Observed use is not business benefit</h4>
      <p>{(owner?.nativeUses ?? view.participant?.selfUses ?? []).length} visible native process-use records.
        Causal business value, complete monetary cost, human supervision, assistance and field benefit are not established by this panel.</p>
      {(owner?.nativeUses ?? view.participant?.selfUses ?? []).map(item => <p key={item.use_key}>{item.process_id} · {label(item.result.behavior)}.
        Original approval remains required; full costs {label(item.result.fullCostStatus)}.</p>)}
    </section> : null}
  </section>
}
