"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { centropyPost, CentropyApiError } from "@/components/centropy/lib/api"
import { getCurrentAccessGeneration, getCurrentSessionKey, useCentropyAuth } from "@/components/centropy/lib/centropy-auth"
import { onBusinessInvalidation } from "@/components/centropy/lib/business-invalidation"
import {
  CoalitionAllocationViewSchema, CoalitionConsumptionViewSchema, CoalitionConsentHistoryViewSchema,
  CoalitionScheduleViewSchema, CoalitionSelectionViewSchema, CoalitionWorkAccessViewSchema,
  assertCoalitionAllocationScope, assertCoalitionConsumptionBinding, assertCoalitionScheduleBinding,
  assertCoalitionSelectionScope, coalitionRef, readCoalitionPointers, sameCoalitionRef, writeCoalitionPointers,
  type CoalitionAllocationView, type CoalitionConsentHistoryView, type CoalitionIdentity,
  type CoalitionPointers, type CoalitionProgrammeView, type CoalitionRefView, type CoalitionRoot,
  type CoalitionScheduleView, type CoalitionSelectionView,
} from "./coalition-programme-view"

type Readback = {
  selection: CoalitionSelectionView | null; allocation: CoalitionAllocationView | null
  schedule: CoalitionScheduleView | null; history: CoalitionConsentHistoryView | null
  issues: string[]; readAt: string
}
type Scoped<T> = { scope: string; epoch: number; value: T }
const words = (value: string) => value.toLowerCase().replaceAll("_", " ")
const ownerUnavailable = (cause: unknown) => cause instanceof CentropyApiError && ![401, 403].includes(cause.status)
const clearKey = (pointers: CoalitionPointers) => `r5-work-clear:${pointers.selectionRef.contentDigest}`
const consumeKey = (allocation: CoalitionAllocationView) => `r5-work-consume:${allocation.certificate.ref.contentDigest}`

/** Keep mounted when M3 becomes INVALIDATED. Later responsibilities belong to
 * their canonical S5/S6 readbacks, not a rewritten producer snapshot. */
export function CoalitionProgrammeReview({ programme, scope, authorized, workId, root, workRevision }: {
  programme: CoalitionProgrammeView | null; scope: string; authorized: boolean
  workId: string; root: CoalitionRoot; workRevision?: string | null
}) {
  const auth = useCentropyAuth(), pathname = usePathname(), search = useSearchParams()
  const sessionScope = useRef({ token: auth.session?.access_token, version: 0 })
  if (sessionScope.current.token !== auth.session?.access_token)
    sessionScope.current = { token: auth.session?.access_token, version: sessionScope.current.version + 1 }
  const sessionKey = auth.session ? `${auth.session.user.id}:${getCurrentAccessGeneration()}:${auth.session.access_token}` : null
  const permitted = Boolean(authorized && auth.session && auth.role === "owner" && !auth.loading &&
    !auth.roleLoading && !auth.roleError && sessionKey === getCurrentSessionKey())
  const identity: CoalitionIdentity = { userId: auth.session?.user.id ?? "signed-out", workId, root, workRevision }
  const restored = readCoalitionPointers(search, identity)
  const seed = programme?.original.owner.workId === workId && programme.owners.s4SelectionRef
    ? { selectionRef: programme.owners.s4SelectionRef, allocationRef: null, consumptionRef: null, scheduleRef: null, clearRequested: false }
    : null
  const pointers: CoalitionPointers | null = restored.kind === "INVALID" ? null : restored.pointers ?? seed
  const malformed = restored.kind === "INVALID"
  const pointerKey = [
    pointers?.selectionRef.contentDigest ?? "", pointers?.allocationRef?.contentDigest ?? "",
    pointers?.consumptionRef?.contentDigest ?? "", pointers?.scheduleRef?.contentDigest ?? "",
  ].join(":")
  const viewScope = JSON.stringify([scope, identity.userId, sessionKey, sessionScope.current.version, workId,
    root.entityType, root.entityId, workRevision, pathname, restored.kind === "INVALID", pointerKey])
  const [readback, setReadback] = useState<Scoped<Readback> | null>(null)
  const [message, setMessage] = useState<Scoped<{ text: string; error: boolean }> | null>(null)
  const [command, setCommand] = useState<Scoped<string> | null>(null)
  const epoch = useRef(0), context = useRef({ scope: viewScope, permitted }), reading = useRef<number | null>(null)
  const writing = useRef<{ epoch: number; path: string } | null>(null)
  context.current = { scope: viewScope, permitted }
  const clear = useCallback(() => { setReadback(null) }, [])
  const active = useCallback((generation: number) => generation === epoch.current &&
    context.current.scope === viewScope && context.current.permitted &&
    sessionKey !== null && sessionKey === getCurrentSessionKey() && document.visibilityState === "visible",
  [sessionKey, viewScope])
  const current = permitted && readback?.scope === viewScope && readback.epoch === epoch.current ? readback.value : null
  const selection = current?.selection && Date.parse(current.selection.validUntil) > Date.now() ? current.selection : null
  const allocation = current?.allocation ?? null, schedule = current?.schedule ?? null
  const busy = permitted && command?.scope === viewScope
  const notice = message?.scope === viewScope && message.epoch === epoch.current ? message.value : null
  const snapshot = selection && programme && sameCoalitionRef(programme.owners.s4SelectionRef, selection.ref) &&
    sameCoalitionRef(programme.originalRef, selection.originalRef) &&
    programme.candidate?.originalDigest === selection.candidate.originalDigest &&
    programme.checker?.candidateDigest === selection.checker.candidateDigest ? programme : null

  const refresh = useCallback(async (generation: number) => {
    // Centropy shares pending reads within a session. Drain the old generation
    // before reauthorizing, rather than accepting its promise under a new epoch.
    if (!active(generation) || reading.current !== null) return
    reading.current = generation
    try {
      const access = CoalitionWorkAccessViewSchema.parse(await centropyPost("company-brain/capital-program-context",
        { workId, root: { entityType: root.entityType, entityId: root.entityId } }))
      if (!active(generation)) return
      if (access.workId !== workId) throw Error("Work scope differs.")
      const [selectionDigest, allocationDigest, consumptionDigest, scheduleDigest] = pointerKey.split(":")
      const pointers: CoalitionPointers | null = selectionDigest ? {
        selectionRef: coalitionRef("selection", selectionDigest),
        allocationRef: allocationDigest ? coalitionRef("allocation", allocationDigest) : null,
        consumptionRef: consumptionDigest ? coalitionRef("consumption", consumptionDigest) : null,
        scheduleRef: scheduleDigest ? coalitionRef("schedule", scheduleDigest) : null, clearRequested: false,
      } : null
      if (!pointers) {
        clear()
        setMessage({ scope: viewScope, epoch: generation, value: { error: malformed,
          text: malformed ? "Malformed scoped coalition references. Values cleared."
            : "No canonical S4 coalition selection is available. Native output is not a current selected programme." } })
        return
      }
      let nextSelection: CoalitionSelectionView | null = null
      let nextAllocation: CoalitionAllocationView | null = null
      let nextSchedule: CoalitionScheduleView | null = null
      let nextHistory: CoalitionConsentHistoryView | null = null
      const issues: string[] = []
      try {
        const value = CoalitionSelectionViewSchema.parse(await centropyPost("policies/coalition-read",
          { selectionRef: pointers.selectionRef }))
        if (!active(generation)) return
        assertCoalitionSelectionScope(value, pointers.selectionRef,
          { workId, root: { entityType: root.entityType, entityId: root.entityId } })
        if (Date.parse(value.validUntil) <= Date.now() || workRevision && workRevision !== value.workRevision)
          issues.push("Current S4 revision or validity differs. Mathematical values are hidden.")
        else nextSelection = value
      } catch (cause) {
        if (!active(generation)) return
        if (!ownerUnavailable(cause)) throw cause
        issues.push("Current S4 selection could not be reauthorized. Mathematical values are hidden; retained responsibility is read separately.")
      }
      if (pointers.allocationRef) {
        nextAllocation = CoalitionAllocationViewSchema.parse(await centropyPost("allocations/coalition-read",
          { allocationRef: pointers.allocationRef }))
        if (!active(generation)) return
        assertCoalitionAllocationScope(nextAllocation, pointers.allocationRef, pointers,
          { workId, root: { entityType: root.entityType, entityId: root.entityId } })
      }
      if (pointers.scheduleRef && nextAllocation) {
        try {
          nextSchedule = CoalitionScheduleViewSchema.parse(await centropyPost("obligations/coalition-read",
            { scheduleRef: pointers.scheduleRef }))
          if (!active(generation)) return
          assertCoalitionScheduleBinding(nextSchedule, pointers, nextAllocation)
          nextHistory = CoalitionConsentHistoryViewSchema.parse(await centropyPost("obligations/coalition-consent-history",
            { scheduleRef: pointers.scheduleRef }))
          if (!active(generation)) return
          if (nextHistory.some(report => !sameCoalitionRef(report.scheduleRef, nextSchedule?.ref) ||
            report.proposalVersion !== nextSchedule?.proposalVersion ||
            !nextSchedule?.requiredConsents.some(party => party.partyId === report.partyId)))
            throw Error("Consent history binds different proposal terms.")
        } catch (cause) {
          if (!active(generation)) return
          if (!ownerUnavailable(cause)) throw cause
          nextSchedule = null; nextHistory = null
          issues.push("S6 schedule/history is unavailable in the current access scope. Private schedule values cleared; no responsibility is presumed released.")
        }
      }
      if (!active(generation)) return
      setReadback({ scope: viewScope, epoch: generation, value: {
        selection: nextSelection, allocation: nextAllocation, schedule: nextSchedule,
        history: nextHistory, issues, readAt: new Date().toISOString(),
      } })
      setMessage({ scope: viewScope, epoch: generation, value: { error: false,
        text: nextSelection ? "S4 selection reauthorized. S5/S6 responsibilities are separate ordinary owner readbacks, not agreement or execution authority."
          : "No current mathematical selection claim. Any displayed S5/S6 responsibility is retained canonical owner state." } })
    } catch (cause) {
      if (!active(generation)) return
      clear()
      setMessage({ scope: viewScope, epoch: generation, value: { error: true,
        text: cause instanceof CentropyApiError && [401, 403, 404].includes(cause.status)
          ? "Coalition values are unavailable in the current access scope. Private values cleared; retained references do not imply release."
          : "Canonical coalition readback could not be verified. Values cleared; pending responsibility remains unknown until authorized readback." } })
    } finally { if (reading.current === generation) reading.current = null }
  }, [active, clear, pointerKey, malformed, root.entityType, root.entityId, viewScope, workId, workRevision])

  useEffect(() => {
    const requestEpoch = epoch
    requestEpoch.current++; clear(); setMessage(null); setCommand(null); writing.current = null
    if (!permitted) return
    let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      clearTimeout(timer)
      if (cancelled) return
      if (document.visibilityState === "visible" && writing.current === null) await refresh(epoch.current)
      if (!cancelled) timer = setTimeout(() => void tick(), 10000)
    }
    const invalidate = () => { epoch.current++; clear() }
    const visible = () => { invalidate(); if (document.visibilityState === "visible") void tick() }
    const unsubscribe = onBusinessInvalidation(signal => {
      if (!signal.tags.some(tag => ["work", "company-brain", "source", "authority", "artifact", "receipt", "underwriting"].includes(tag))) return
      // The acknowledged local write is followed by canonical reads. Keep its
      // response fenced to this context without losing its durable owner ref.
      if (signal.source === "mutation" && writing.current?.path === signal.path) { clear(); return }
      invalidate(); void tick()
    })
    void tick()
    window.addEventListener("pagehide", invalidate); window.addEventListener("pageshow", visible)
    document.addEventListener("visibilitychange", visible)
    return () => {
      cancelled = true; requestEpoch.current++; clearTimeout(timer); unsubscribe()
      window.removeEventListener("pagehide", invalidate); window.removeEventListener("pageshow", visible)
      document.removeEventListener("visibilitychange", visible)
    }
  }, [permitted, refresh, clear])
  useEffect(() => {
    if (!selection) return
    const timer = setTimeout(() => {
      epoch.current++; clear()
      if (document.visibilityState === "visible") void refresh(epoch.current)
    }, Math.min(2147483647, Math.max(0, Date.parse(selection.validUntil) - Date.now())))
    return () => clearTimeout(timer)
  }, [selection, clear, refresh])

  function pin(next: CoalitionPointers) {
    const params = writeCoalitionPointers(new URLSearchParams(window.location.search), identity, next)
    // Next's supported native history integration writes the recovery marker
    // synchronously before S5 can invalidate the original M3 snapshot.
    window.history.replaceState(null, "", `${pathname}?${params.toString()}${window.location.hash}`)
  }
  function recheck() {
    if (!permitted || writing.current !== null) return
    epoch.current++; clear(); void refresh(epoch.current)
  }
  async function perform(path: string, run: (generation: number) => Promise<void>) {
    if (!current || !pointers || writing.current !== null || !active(epoch.current) ||
      readback?.epoch !== epoch.current) return
    const generation = ++epoch.current
    writing.current = { epoch: generation, path }
    setCommand({ scope: viewScope, epoch: generation, value: path }); clear(); setMessage(null)
    try { await run(generation) }
    catch (cause) {
      if (!active(generation)) return
      clear()
      setMessage({ scope: viewScope, epoch: generation, value: { error: true,
        text: cause instanceof CentropyApiError && [401, 403, 404].includes(cause.status)
          ? "Current owner access refused this step. Private values cleared. No release, agreement or settlement is inferred."
          : cause instanceof CentropyApiError && [400, 409, 422].includes(cause.status)
            ? "Owner currentness, disposable profile or planning gate refused this step. Recheck canonical state; no business authority is granted."
            : "The planning response could not be verified and may already be durable. Recheck owners and recover the same request; never assume rollback or repeat an effect." } })
    } finally {
      if (writing.current?.epoch === generation) { writing.current = null; setCommand(null) }
    }
  }
  function reserve() {
    if (!pointers || pointers.allocationRef || !selection && !pointers.clearRequested) return
    const requested = { ...pointers, clearRequested: true }
    void perform("allocations/coalition-clear", async generation => {
      pin(requested)
      const value = CoalitionAllocationViewSchema.parse(await centropyPost("allocations/coalition-clear",
        { selectionRef: requested.selectionRef, idempotencyKey: clearKey(requested) }))
      if (!active(generation)) return
      assertCoalitionAllocationScope(value, value.certificate.ref, requested, identity)
      pin({ ...requested, allocationRef: value.certificate.ref })
    })
  }
  function consume() {
    if (!pointers || !selection || !allocation?.reservation || pointers.consumptionRef ||
      allocation.reservation.revocationReason || !["RESERVED", "CONSUMPTION_PENDING"].includes(allocation.reservation.status)) return
    void perform("allocations/coalition-consume", async generation => {
      const value = CoalitionConsumptionViewSchema.parse(await centropyPost("allocations/coalition-consume",
        { allocationRef: allocation.certificate.ref, idempotencyKey: consumeKey(allocation) }))
      if (!active(generation)) return
      assertCoalitionConsumptionBinding(value, allocation)
      if (value.idempotencyKey !== consumeKey(allocation)) throw Error("Consumption request identity differs.")
      pin({ ...pointers, consumptionRef: value.ref })
    })
  }
  function prepare() {
    if (!pointers?.consumptionRef || !selection || !allocation?.reservation ||
      allocation.reservation.status !== "CONSUMPTION_PENDING" || pointers.scheduleRef) return
    void perform("obligations/coalition-prepare", async generation => {
      const value = CoalitionScheduleViewSchema.parse(await centropyPost("obligations/coalition-prepare",
        { allocationRef: allocation.certificate.ref, consumptionRef: pointers.consumptionRef }))
      if (!active(generation)) return
      const next = { ...pointers, scheduleRef: value.ref }
      assertCoalitionScheduleBinding(value, next, allocation); pin(next)
    })
  }

  const reservation = allocation?.reservation
  return <section aria-label="Coalition programme review" className="ct-capital-program__exact" aria-busy={busy}>
    <h4>Coalition programme review</h4>
    <p>Proposed membership, programmes, grants and signed payment quantities under a supplied model. Signed quantities are not signatures.
      Selection, mathematical feasibility, ordinary reservation, consent, admission, execution and settlement stay separate.</p>
    <p role="status" aria-live="polite">{!permitted ? "Sign in with current owner Work access. Private coalition output is hidden."
      : notice?.text ?? "Reauthorizing current Work and immutable coalition owner references."}</p>
    {permitted && notice?.error ? <p role="alert">{notice.text}</p> : null}
    <div className="ct-capital-program__actions">
      <button type="button" disabled={!permitted || busy} onClick={recheck}>Recheck coalition owners</button>
      {current && pointers && !pointers.allocationRef ? <button type="button" disabled={busy || !selection && !pointers.clearRequested} onClick={reserve}>
        {pointers.clearRequested ? "Recover the same S5 clearance request" : "Request actual joint S5 reservation"}</button> : null}
      {allocation && !pointers?.consumptionRef ? <button type="button" disabled={busy || !selection || !reservation ||
        Boolean(reservation.revocationReason) || !["RESERVED", "CONSUMPTION_PENDING"].includes(reservation.status)} onClick={consume}>
        {reservation?.status === "CONSUMPTION_PENDING" ? "Recover the same S5 consumption receipt" : "Record one joint S5 handoff intention"}</button> : null}
      {pointers?.consumptionRef && !pointers.scheduleRef ? <button type="button" disabled={busy || !selection ||
        reservation?.status !== "CONSUMPTION_PENDING"} onClick={prepare}>Prepare proposed S6 schedule</button> : null}
      {schedule ? <button type="button" disabled={busy} onClick={recheck}>Reauthorize and read consent-report history</button> : null}
    </div>
    <p>No effect, provider call, invitation, signature, acceptance report or release is automated. Rechecks and reloads are read-only.
      S5 controls the one complete joint envelope; individual coalitions cannot spend it separately.</p>
    {current?.issues.length ? <ul>{current.issues.map(issue => <li key={issue}>{issue}</li>)}</ul> : null}
    {restored.kind === "FOREIGN" && permitted ? <p>URL references belong to another user, Work or root and are not used.</p> : null}
    {permitted && pointers ? <details><summary>Scoped durable owner references</summary>
      <p>References alone establish no currentness or authority. Private bodies are not persisted in the URL.</p>
      <Witness value={{ selectionRef: pointers.selectionRef, allocationRef: pointers.allocationRef,
        consumptionRef: pointers.consumptionRef, scheduleRef: pointers.scheduleRef }} />
    </details> : null}
    {selection ? <SelectedProposal selection={selection} snapshot={snapshot} /> : null}
    {selection && programme && !snapshot ? <p>The supplied producer snapshot does not match these restored owner references.
      It is not joined to their values or responsibility.</p> : null}
    {allocation ? <section aria-label="Canonical joint S5 responsibility">
      <h5>Canonical joint S5 responsibility</h5>
      <p>Original point check: {allocation.certificate.check.feasible ? "feasible" : "not feasible"}.
        This is not a canonical constrained-family optimum. The certificate is an immutable original check, not a claim that all inputs remain current.</p>
      <Reference value={allocation.certificate.ref} />
      {reservation ? <>
        <p>S5 reservation state at authorized readback: <strong>{words(reservation.status)}</strong>; revision {reservation.revision}.
          Origin {reservation.createdAt}. Origin validity limit {allocation.certificate.validUntil}.
          {reservation.revocationReason ? ` Owner revocation reason: ${reservation.revocationReason}.` : ""}</p>
        <Reference value={reservation.ref} />
        {reservation.status === "CONSUMPTION_PENDING" ? <p>The complete joint envelope is retained for an intended S6 handoff.
          Actual external consumption and settlement remain unestablished. Cancellation or invalidation does not release this responsibility.</p> : null}
        <details><summary>Exact complete joint envelope and canonical point witnesses</summary>
          <Witness value={{ envelopes: reservation.envelopes, witnesses: allocation.certificate.check.witnesses,
            scenarioValues: allocation.certificate.check.scenarioValues, demandBindings: allocation.certificate.policyBindings }} />
        </details>
      </> : <p>No canonical reservation was returned. Absence is not a release receipt.</p>}
      {pointers?.consumptionRef ? <p>An immutable consumption reference is retained. Its URL presence is not an external consumption receipt.
        S6 preparation validates the actual S5 intention joins.</p> : null}
      <p>Reservation state is not banking readback, party consent, signing authority or S7 economic credit.</p>
    </section> : null}
    {schedule ? <RecordedSchedule schedule={schedule} history={current?.history ?? null}
      currentSelection={Boolean(selection)} /> : null}
    {current ? <p>Authenticated canonical readback {current.readAt}. Model, rights, resource, consent, event and method changes require reauthorization.
      Earlier origins and unknown liabilities are not erased.</p> : null}
  </section>
}

function Reference({ value }: { value: CoalitionRefView }) {
  return <p><code>{value.owner} · {value.id} · {value.version} · {value.contentDigest}</code></p>
}
function Witness({ value }: { value: unknown }) {
  return <pre tabIndex={0}>{JSON.stringify(value, null, 2)}</pre>
}
function SelectedProposal({ selection, snapshot }: { selection: CoalitionSelectionView; snapshot: CoalitionProgrammeView | null }) {
  const original = selection.original, candidate = selection.candidate
  const selected = candidate.programmeOptions.filter(option => selection.selectedOptionIds.includes(option.id))
  const alternatives = candidate.programmeOptions.filter(option => !selection.selectedOptionIds.includes(option.id))
  return <section aria-label="Proposed coalition members and programmes">
    <h5>Reauthorized S4 model-relative selection</h5>
    <Reference value={selection.ref} />
    <p>Selected objective {selection.value} {original.unit}, currency {original.currency}, valued {original.valuationDate}.
      Owner objective {words(original.objective.kind)} on jointly indexed supplied worlds. No additional value is credited for redistributing it.</p>
    <p>Independent mathematical lower {selection.checker.lower ?? "unknown"}; upper {selection.checker.upper ?? "unknown"} {original.unit}.
      {snapshot ? ` Immutable R5 envelope ${words(snapshot.status)}; lower ${snapshot.lower ?? "unknown"}, upper ${snapshot.upper ?? "unknown"}, gap ${snapshot.gap ?? "unknown"}.`
        : " Original R5 envelope/gap is unavailable in this owner readback; it is not reconstructed or declared current."}</p>
    <p>This S4 record itself grants no executable qualification. Any separate ordinary P1 module and handoff require P1 reauthorization.
      S8 admission and activation are not granted here.
      No coalition/core/stability, R3 truthfulness, real acceptance or economic gain is established.</p>
    {snapshot?.owners.p1ProgrammeRef ? <details><summary>Ordinary P1 module named by the immutable producer</summary>
      <Reference value={snapshot.owners.p1ProgrammeRef} />
      <p>This original reference is not a current P1 readback or proof of an executed handoff. This view sends only explicitly requested stagewise planning calls, not that P1 module.</p>
    </details> : null}
    <h5>Proposed participants and outside options</h5>
    <ul>{original.parties.map(party => <li key={party.id}>
      <strong>{party.id}</strong><Reference value={party.partyRef} />
      <p>Independent acceptance is unobserved. Required consent <code>{party.requiredConsentRef.id}</code>.
        Invitations are not recorded or sent by this view. Owner objective weight {party.ownerObjectiveWeight}.</p>
      <ul>{original.worlds.map(world => <li key={world.id}>World {world.id}: outside option {party.outsideOptions[world.id] ?? "unknown"} {original.unit}.</li>)}</ul>
      <details><summary>Original rights, outside-option and settled-funding witnesses for {party.id}</summary>
        <Witness value={{ rightsRef: party.rightsRef, outsideOptionRef: party.outsideOptionRef, fundingRef: party.fundingRef,
          settledCash: party.settledCash, artifactConsentEntry: snapshot?.consents.find(consent => consent.partyId === party.id) ?? null }} />
        <p>An artifact consent entry, including one labeled accepted, is not an independently observed signature or agreement.</p>
      </details>
    </li>)}</ul>
    <h5>Selected proposed programmes and grants</h5>
    <div className="ct-capital-program__candidates">{selected.map(option => <article key={option.id}>
      <h5>{option.id}</h5><p>Proposed coalition members: {option.members.join(", ")}. Membership alone does not force action.</p>
      <ol>{option.steps.map((step, index) => {
        const operation = original.grammar.operators.find(operator => operator.id === step.operatorId)
        return <li key={index}>{operation ? words(operation.kind) : "unknown operation"} {step.operatorId}.
          <Witness value={{ terms: step.terms, proposedGrants: step.grants,
            operationRef: operation?.operationRef ?? null, modelRef: operation?.modelRef ?? null }} />
        </li>
      })}</ol>
      <p>Grants are modeled choices, not independent spending rights. Required consents: {option.requiredConsents.join(", ") || "none declared by this option"}.</p>
      <details><summary>Exact joint-world payoff, outgoing cash, resource occupation and item witnesses</summary>
        <Witness value={{ grossPayoffs: option.grossPayoffs, cashFlows: option.cashFlows, cashOutflows: option.cashOutflows,
          resourceUse: option.resourceUse, itemIds: option.itemIds, exclusiveItems: option.exclusiveItems }} />
        <p>These are original owner fields. No client netting, rounding, duplicated wealth credit or assumed zero is applied.</p>
      </details>
    </article>)}</div>
    <h5>Observable proposed signed payments</h5>
    <p>Positive pays the named participant; negative identifies funding owed by that participant.
      Conservation and participation are conditional model checks, not consent or settled cash. Future collections are not treated as earlier settled funding.</p>
    <ol>{candidate.division.map((payment, index) => <li key={index}>Event {payment.eventId}, received token {payment.token},
      date {original.dates[payment.date] ?? "unknown date"}, operation <code>{payment.operationRef.id}</code>.
      <Witness value={{ signedAmounts: payment.amounts, event: original.events.find(event => event.id === payment.eventId) ?? null }} />
    </li>)}</ol>
    <p>Amounts use {original.unit}/{original.currency}, valuation date {original.valuationDate}.
      Supplied event tokens in a world are assumptions, not observations that an event occurred.</p>
    <details><summary>Original accounting, transaction costs, liabilities and resource assumptions</summary>
      <Witness value={{ dates: original.dates, discountFactors: original.discountFactors, resources: original.resources,
        obligationsRef: original.obligationsRef, controlDemand: original.controlDemand ?? null,
        operators: original.grammar.operators }} />
      <p>One membership decision period does not erase later maturity or liabilities. No employment or benefit reduction is assumed.</p>
    </details>
    <details><summary>Model, spillover assumptions and known gaps</summary>
      <p>No cross-coalition strategic spillover is supplied as an assumption, not inferred from missing fields.
        Shared shocks/worlds may remain correlated. Causal adequacy and omitted real mechanisms are unqualified.</p>
      <Witness value={{ model: original.model, grammarRef: original.grammar.ref, objective: original.objective,
        unresolvedFamilyClaims: candidate.family.unresolved }} />
      {snapshot ? <><p>Immutable producer gaps at publication are retained verbatim. Later S5/S6 receipts do not rewrite them or complete the original M3 snapshot.</p>
        <ul>{snapshot.unresolvedClaims.map((claim, index) => <li key={index}>{claim.claim}: {claim.reason}</li>)}</ul>
        <Witness value={{ originalOwnerRefs: snapshot.owners, lifecycle: snapshot.lifecycle }} /></>
        : <p>Producer gap/history bytes are unavailable here. No missing producer claim is presumed closed.</p>}
    </details>
    <details><summary>Independent checker provenance, coverage and costs</summary>
      <p>Checker {words(selection.checker.disposition)} for its exposed mathematical claims.
        {selection.checker.coverage.partitions ?? "Unknown"} partitions; {selection.checker.coverage.programmeOptions} programme options;
        {selection.checker.coverage.worlds} original worlds; {selection.checker.coverage.transferVariables} transfer variables.
        Producer family {candidate.family.complete ? "reported complete" : "incomplete"}. Counts alone are not full R5 delivery or enterprise throughput.</p>
      <Witness value={{ claims: selection.checker.claims, witnesses: selection.checker.witnesses,
        provenance: selection.checker.provenance ?? null, nativeBasis: candidate.nativeBasis,
        frozenTie: selection.tie, originalRef: selection.originalRef, nativeComponentRef: selection.nativeComponentRef }} />
      {snapshot ? <p>Producer charged CPU {snapshot.costs.cpuMs} ms; aggregate sampled peak {snapshot.costs.aggregateSampledPeakBytes} bytes.
        These are supplied producer meters, not a qualified installed/container peak or total economic cost.</p>
        : <p>Quantified producer costs are unavailable in this readback. Physical references are retained, not converted to invented zero costs.</p>}
      <p>Dollars, complete human/data/build/integration costs, protected comparison and field economic value remain unknown/unqualified.</p>
    </details>
    <details><summary>Generated alternatives, not independently selected winners</summary>
      <p>{alternatives.length} generated alternatives; this bounded display shows the first {Math.min(32, alternatives.length)}.
        Display truncation does not alter or establish search completeness. Unselected options are not represented as individually feasible winners.</p>
      <Witness value={alternatives.slice(0, 32).map(option => ({
        id: option.id, members: option.members, steps: option.steps, requiredConsents: option.requiredConsents,
      }))} />
    </details>
  </section>
}
function RecordedSchedule({ schedule, history, currentSelection }: {
  schedule: CoalitionScheduleView; history: CoalitionConsentHistoryView | null; currentSelection: boolean
}) {
  return <section aria-label="Recorded proposed S6 schedule and consent history">
    <h5>Recorded proposed S6 schedule</h5>
    <Reference value={schedule.ref} />
    <p>{words(schedule.status)}. {currentSelection && Date.parse(schedule.validUntil) > Date.now()
      ? "Owner selection was reauthorized; this schedule still grants no effect authority."
      : "Retained historical responsibility only; current selection or validity is unavailable."}
      Proposal version <code>{schedule.proposalVersion}</code>. Independently observed acceptance, provider admission and settlement are absent.</p>
    <p>Accounting {schedule.accounting.unit}/{schedule.accounting.currency}, valued {schedule.accounting.valuationDate}.
      All payment/signing provider operations are unadmitted. No effect has been executed by this leaf.</p>
    <ol>{schedule.payments.map(payment => <li key={payment.proposedEffectIdentity}>
      Observable event {payment.event.id}, token {payment.division.token}, payment date {payment.dateAt}.
      Available from original date index {payment.event.availableDate}. Operation <code>{payment.division.operationRef.id}</code>.
      <ul>{payment.legs.map(leg => <li key={leg.partyId}>{leg.partyId}: signed amount {leg.amount} {schedule.accounting.unit}/{schedule.accounting.currency}.
        Target <code>{leg.targetRef.id}</code>; funding <code>{leg.fundingRef.id}</code>.</li>)}</ul>
      <details><summary>Original observable event, funding and proposed effect identity</summary><Witness value={payment} /></details>
      <p>Requires independent contract-event evidence and exact payment readback. A proposed effect identity is not an actual effect or settlement.</p>
    </li>)}</ol>
    <h5>Missing independent consents</h5>
    <ul>{schedule.requiredConsents.map(party => <li key={party.partyId}>{party.partyId}: proposed, independent acceptance unobserved.
      Requirement <code>{party.requirementRef.id}</code>.</li>)}</ul>
    <details open><summary>Ordinary S6 consent-report history</summary>
      <p>Reports are not participant signatures or independent acceptance. A reported acceptance cannot establish agreed membership, admission or settlement.</p>
      {history === null ? <p>History is unavailable, not empty.</p> : !history.length ? <p>No ordinary response reports were returned.</p>
        : <ol>{history.map(report => <li key={report.ref.contentDigest}>{report.recordedAt}: {report.partyId},
          {report.reportedStatus === "REPORTED_ACCEPTED" ? " ordinary reported acceptance, not independently observed" : ` ${words(report.reportedStatus)}, ordinary owner report`}.
          <details><summary>Retained report and permissioned evidence identity</summary><Witness value={report} /></details>
        </li>)}</ol>}
    </details>
    <details><summary>Immutable S4/S5/S6 joins and complete proposed programmes</summary>
      <Witness value={{ selectionRef: schedule.selectionRef, allocationRef: schedule.allocationRef,
        reservationRef: schedule.reservationRef, consumptionRef: schedule.consumptionRef, originalRef: schedule.originalRef,
        workRevision: schedule.workRevision, candidateDigest: schedule.candidateDigest,
        selectedProgrammes: schedule.selectedProgrammes, accounting: schedule.accounting }} />
    </details>
  </section>
}
