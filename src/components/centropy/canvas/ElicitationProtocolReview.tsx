"use client"
import { useCallback, useEffect, useRef, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { centropyPost } from "@/components/centropy/lib/api"
import { useCentropyAuth } from "@/components/centropy/lib/centropy-auth"
import { onBusinessInvalidation } from "@/components/centropy/lib/business-invalidation"
import { ElicitationContextViewSchema, ElicitationReviewViewSchema, exactElicitationText as exact,
  type ElicitationContextView, type ElicitationReviewView, type ElicitationProgramTargetView } from "./elicitation-protocol-view"
type Scoped<T> = { scope: string; value: T }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export function ElicitationProtocolReview({ workId, root, programTargets = [] }: {
  workId: string; root: { entityType: string; entityId: string }; programTargets?: ElicitationProgramTargetView[]
}) {
  const auth = useCentropyAuth(), router = useRouter(), pathname = usePathname(), search = useSearchParams()
  const principalId = auth.session?.user.id
  const tokenScope = useRef({ token: auth.session?.access_token, version: 0 })
  if (tokenScope.current.token !== auth.session?.access_token)
    tokenScope.current = { token: auth.session?.access_token, version: tokenScope.current.version + 1 }
  const scope = `${principalId ?? "signed-out"}:${tokenScope.current.version}:${workId}:${root.entityType}:${root.entityId}`
  const authorized = Boolean(auth.session && auth.role === "owner" && !auth.roleError && !auth.loading && !auth.roleLoading)
  const [context, setContext] = useState<Scoped<ElicitationContextView> | null>(null)
  const [review, setReview] = useState<Scoped<ElicitationReviewView> | null>(null)
  const [declarationId, setDeclarationId] = useState(""), [grantId, setGrantId] = useState("")
  const [targetId, setTargetId] = useState("")
  const selectedTarget = programTargets.find(target => `${target.queryId}:${target.candidateDigest}` === targetId)
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("Load supplied preferences and an existing compute grant.")
  const [witnesses, setWitnesses] = useState(false), [partyId, setPartyId] = useState(""), [typeId, setTypeId] = useState("")
  const [observationSource, setObservationSource] = useState(""), [observationVersion, setObservationVersion] = useState(""), [observationDigest, setObservationDigest] = useState("")
  const epoch = useRef(0), scopeRef = useRef(scope), writing = useRef<number | null>(null)
  scopeRef.current = scope
  const requestId = search.get("elicitationRequest")
  const current = authorized && review?.scope === scope && review.value.requestId === requestId ? review.value : null
  const currentContext = authorized && context?.scope === scope ? context.value : null
  const protocol = current?.protocol
  const clear = useCallback(() => { setReview(null); setWitnesses(false) }, [])
  const active = useCallback((generation: number) => authorized && generation === epoch.current && scopeRef.current === scope &&
    document.visibilityState === "visible", [scope, authorized])
  const refresh = useCallback(async (id: string, generation: number) => {
    try {
      const next = ElicitationReviewViewSchema.parse(await centropyPost("elicitation-protocols/read", { requestId: id }))
      if (!active(generation)) return
      if (next.workId !== workId || next.principalId !== principalId || next.protocol &&
        (next.protocol.envelope.work.id !== workId || next.protocol.envelope.work.revision !== next.workRevision))
        throw Error("Exact Work or principal binding differs.")
      setReview({ scope, value: next })
      if (!next.protocol) setWitnesses(false)
      setNotice(next.reason ?? (next.protocol ? "Checked proposed rule. Preferences, consent and settlement remain unqualified." : next.status))
      return next
    } catch {
      if (active(generation)) { clear(); setNotice("Current permitted rule could not be verified. Private values cleared.") }
    }
  }, [active, scope, workId, principalId, clear])
  useEffect(() => {
    epoch.current++; clear(); setContext(null); setDeclarationId(""); setGrantId(""); setTargetId(""); setPartyId(""); setTypeId("")
    setObservationSource(""); setObservationVersion(""); setObservationDigest(""); writing.current = null; setBusy(false)
  }, [scope, authorized, clear])
  useEffect(() => {
    if (!authorized || !requestId || !uuid.test(requestId)) return
    let cancelled = false, reading = false, timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      clearTimeout(timer)
      if (cancelled) return
      let delay = 4000
      if (document.visibilityState === "visible" && writing.current === null && !reading) {
        reading = true
        try { const value = await refresh(requestId, epoch.current); if (value && ["QUEUED", "RUNNING"].includes(value.status)) delay = 1000 }
        finally { reading = false }
      }
      if (!cancelled) timer = setTimeout(() => void tick(), delay)
    }
    const invalidate = () => { epoch.current++; clear(); setContext(null) }
    const visibility = () => { invalidate(); if (document.visibilityState === "visible") void tick() }
    const unsubscribe = onBusinessInvalidation(signal => {
      if ((signal.path ?? "").startsWith("elicitation-protocols/")) return
      if (signal.tags.some(tag => ["work", "company-brain", "authority", "source"].includes(tag))) { invalidate(); void tick() }
    })
    void tick(); window.addEventListener("pagehide", invalidate); document.addEventListener("visibilitychange", visibility)
    return () => { cancelled = true; epoch.current++; clearTimeout(timer); unsubscribe()
      window.removeEventListener("pagehide", invalidate); document.removeEventListener("visibilitychange", visibility) }
  }, [authorized, requestId, refresh, clear])
  async function perform(operation: string, input: unknown) {
    if (!authorized || writing.current !== null || document.visibilityState !== "visible") return
    const generation = ++epoch.current; writing.current = generation; setBusy(true); clear()
    try {
      const result = await centropyPost<Record<string, unknown>>(`elicitation-protocols/${operation}`, input)
      if (!active(generation)) return
      if (operation === "review" && (input as { decision?: string }).decision === "PROPOSE_USE") {
        if (result.schema !== "finnor.r3.review-stage.v2" || result.requestId !== requestId ||
          result.status !== "S4_REVIEWED_OWNER_CONTINUATION_REQUIRED") throw Error("Current owner review is unavailable.")
        const allocation = await centropyPost<Record<string, unknown>>("elicitation-protocols/reserve", { requestId })
        if (!active(generation)) return
        if (allocation.status !== "FEASIBLE" || !allocation.reservation) throw Error("Current contingent resources could not be reserved.")
        const prepared = await centropyPost<Record<string, unknown>>("elicitation-protocols/schedules", { requestId })
        if (!active(generation)) return
        if (prepared.schema !== "finnor.r3.schedule-stage.v1" || prepared.requestId !== requestId)
          throw Error("Current proposed schedules are unavailable.")
      }
      if (operation === "context") {
        const parsed = ElicitationContextViewSchema.parse(result)
        if (parsed.workId !== workId) throw Error("Owner returned another Work.")
        setContext({ scope, value: parsed }); setNotice(parsed.declarations.length ? "Choose a current supplied preference declaration and existing grant." : "No current finite preference declaration. No private preferences were inferred.")
      } else if (operation === "submit") {
        if (result.workId !== workId || typeof result.requestId !== "string" || !uuid.test(result.requestId)) throw Error("Accepted Work binding differs.")
        const params = new URLSearchParams(search.toString()); params.set("elicitationRequest", result.requestId)
        router.replace(`${pathname}?${params}`, { scroll: false }); setNotice("Durable rule search queued. Partial output is provisional.")
      } else if (requestId) { await refresh(requestId, generation) }
    } catch (error) { if (active(generation)) { clear(); setNotice(error instanceof Error ? error.message : "Owner operation unavailable. Private values cleared.") } }
    finally { if (writing.current === generation) { writing.current = null; setBusy(false) } }
  }
  function submit() {
    const declared = currentContext?.declarations.find(d => d.problem_ref.versionId === declarationId)
    const grant = currentContext?.budgetGrants.find(g => g.ref.id === grantId)
    const incumbent = currentContext?.incumbentPolicies.find(p => p.mandateRef.contentDigest === declared?.mandateRef.contentDigest &&
      (!targetId || selectedTarget?.policyRef.contentDigest === p.ref.contentDigest))
    if (!declared || !grant || !incumbent || !currentContext) return
    const deadline = Math.min(Date.now() + 300000, Date.parse(grant.validUntil))
    void perform("submit", { envelope_inputs: { mode: "ordinary_disposable" }, problem_ref: declared.problem_ref,
      existing_work_revision: { workId, revision: currentContext.workRevision, root: currentContext.root }, domain_profile_ref: declared.domain_profile_ref,
      budget_grant_ref: grant.ref, cancellation_ref: `work:${workId}:r3-user-cancel`, incumbentPolicyRef: incumbent.ref,
      ...(selectedTarget ? { programTarget: selectedTarget } : {}),
      idempotencyKey: crypto.randomUUID(), limits: { deadlineAt: new Date(deadline).toISOString(), maxAttempts: 8, childSeconds: 25 } })
  }
  const party = protocol?.problem.parties.find(p => p.id === partyId)
  const ownParty = party?.reportingPrincipalId === principalId
  const closed = current?.reportState?.closed
  return <section aria-label="Proposed elicitation rule" className="ct-capital-program" aria-busy={busy}>
    <h4>Proposed elicitation rule</h4>
    <p>A complete report-to-outcome/payment mechanism under supplied preferences. Not private truth, consent, a signed agreement or a settled payment.</p>
    <label>Programme candidate<select aria-label="Programme candidate" value={targetId} disabled={busy} onChange={e => {
      epoch.current++; setContext(null); setDeclarationId(""); setGrantId(""); setTargetId(e.target.value)
    }}>
      <option value="">Standalone supplied rule</option>{programTargets.map(target => <option key={`${target.queryId}:${target.candidateDigest}`} value={`${target.queryId}:${target.candidateDigest}`}>{target.candidateDigest.slice(0, 12)} · current checked candidate</option>)}
    </select></label>
    <button type="button" disabled={!authorized || busy || Boolean(targetId && !selectedTarget)} onClick={() => void perform("context", {
      workId, root: protocol?.problem.binding.root ?? root, ...(selectedTarget ? { programTarget: selectedTarget } : {}),
    })}>Load supplied preference context</button>
    {currentContext ? <div>
      <label>Preference declaration<select aria-label="Preference declaration" value={declarationId} onChange={e => setDeclarationId(e.target.value)}>
        <option value="">Choose a current declaration</option>{currentContext.declarations.map(d => <option key={d.problem_ref.versionId} value={d.problem_ref.versionId}>{d.problem_ref.versionId}, four parties, unqualified preferences</option>)}
      </select></label>
      <label>Existing compute grant<select aria-label="Existing compute grant" value={grantId} onChange={e => setGrantId(e.target.value)}>
        <option value="">Choose an existing grant</option>{currentContext.budgetGrants.map(g => <option key={g.ref.id} value={g.ref.id}>{g.ref.id}</option>)}
      </select></label>
      <button type="button" disabled={busy || !declarationId || !grantId || Boolean(targetId && !selectedTarget)} onClick={submit}>Synthesize complete proposed rule</button>
      <label>Durable rule review<select aria-label="Durable rule review" value={requestId ?? ""} onChange={e => {
        epoch.current++; clear(); const params = new URLSearchParams(search.toString()); params.set("elicitationRequest", e.target.value)
        router.replace(`${pathname}?${params}`, { scroll: false })
      }}><option value="">Choose a prior request</option>{currentContext.requests.map(r => <option key={r.requestId} value={r.requestId}>{r.requestId}: {r.status}</option>)}</select></label>
    </div> : null}
    <p role="status">{notice}</p>
    {current ? <p>Request {current.requestId}. {current.status}. Original deadline {current.deadlineAt}. {current.provisional ? "Provisional, no checked rule." : "Development-verified mathematical claims only."}</p> : null}
    {current && ["QUEUED", "RUNNING"].includes(current.status) ? <button type="button" disabled={busy} onClick={() => void perform("cancel", { requestId })}>Cancel search, retain costs and responsibilities</button> : null}
    {protocol ? <div>
      {protocol.problem.binding.programTarget ? <p>Report extension of programme {protocol.problem.binding.programTarget.programRef.id}, candidate {protocol.problem.binding.programTarget.candidateDigest}. Original programme certificates retain their meaning.</p> : null}
      <dl><dt>Exact owner modeled value</dt><dd>{exact(protocol.check.objective)}</dd><dt>Accepted box upper / unresolved gap</dt><dd>{exact(protocol.check.upper)} / {exact(protocol.check.optimizationGap)}, optimum UNKNOWN</dd>
        <dt>Complete coverage</dt><dd>81 profiles, 648 deviations, 324 participation checks</dd>
        <dt>Minimum incentive / participation margin</dt><dd>{exact(protocol.check.minimumIncentiveMargin)} / {exact(protocol.check.minimumParticipationMargin)}. Weak ties do not predict consent.</dd>
        <dt>Maximum deviation gain</dt><dd>{exact(protocol.check.maximumDeviationGain)}</dd>
        <dt>Reports / acceptance</dt><dd>{current.reportState ? closed ? "Reports closed" : "Reports open" : "Report state UNKNOWN"}; {current.reportState
          ? current.reportState.noAgreement ? "No agreement" : `${current.reportState.acceptedParties.length}/4 separately observed disposable declarations`
          : "Separately observed acceptance UNKNOWN"}. Protected agreement UNKNOWN.</dd></dl>
      <ul>{protocol.envelope.gaps.map(g => <li key={g.reason}>{g.reason}: {g.status}</li>)}</ul>
      <button type="button" disabled={busy} onClick={() => void perform("review", { requestId, decision: "PROPOSE_USE", reason: "Review this checked proposed mechanism under the existing owner mandate" })}>Review proposed use and reserve contingent resources</button>
      {(["INQUIRE", "WAIT", "STOP"] as const).map(decision => <button type="button" key={decision} disabled={busy} onClick={() => void perform("review", { requestId, decision, reason: "Use the original owner fallback within remaining resources" })}>{decision.toLowerCase()} via existing owner fallback</button>)}
      <label>Reporting party<select aria-label="Reporting party" value={partyId} onChange={e => { setPartyId(e.target.value); setTypeId("") }}>
        <option value="">Choose your authorized party</option>{protocol.problem.parties.map(p => <option key={p.id} value={p.id}>{p.id}</option>)}
      </select></label>
      <label>Declared report<select aria-label="Declared report" value={typeId} onChange={e => setTypeId(e.target.value)}>
        <option value="">Choose a declared report</option>{party?.types.map(t => <option key={t.id} value={t.id}>{t.id}</option>)}
      </select></label>
      <button type="button" disabled={busy || !ownParty || !typeId || closed} onClick={() => void perform("report", { requestId, partyId, typeId,
        replacesEventId: current.reportState?.reportEventIds[partyId] ?? null, idempotencyKey: crypto.randomUUID() })}>Record or correct my report, not consent</button>
      <button type="button" disabled={busy || closed} onClick={() => void perform("close", { requestId })}>Close reports, missing replies mean no agreement</button>
      <details><summary>Separately sourced party events</summary>
        <p>Supply an existing permissioned S1 observed-event source. Owner review cannot manufacture another party’s acceptance.</p>
        <label>Observation source<input value={observationSource} onChange={e => setObservationSource(e.target.value)} /></label>
        <label>Observation version<input value={observationVersion} onChange={e => setObservationVersion(e.target.value)} /></label>
        <label>Observation digest<input value={observationDigest} onChange={e => setObservationDigest(e.target.value)} /></label>
        {(["DECLINE", "NO_RESPONSE", "OBSERVED_ACCEPTANCE", "OUT_OF_DOMAIN"] as const).map(kind => <button type="button" key={kind} disabled={busy || !partyId ||
          !uuid.test(observationSource) || !uuid.test(observationVersion) || !/^[a-f0-9]{64}$/.test(observationDigest)}
          onClick={() => void perform("event", { requestId, partyId, kind, observation: { sourceId: observationSource, versionId: observationVersion, contentDigest: observationDigest },
            idempotencyKey: crypto.randomUUID() })}>{kind.toLowerCase().replaceAll("_", " ")}</button>)}
      </details>
      <button type="button" disabled={busy || !current.reportState?.acceptanceComplete || !current.allocation} onClick={() => void perform("use", { requestId, idempotencyKey: `r3-use:${requestId}` })}>Prepare exact owner rule-use intent, no execution</button>
      <button type="button" onClick={() => setWitnesses(v => !v)}>{witnesses ? "Hide" : "Inspect"} complete table, source and schedule witnesses</button>
      {witnesses ? <div><table><caption>All report-conditioned outcomes and exact payments</caption><thead><tr><th>Reports</th><th>Outcome</th><th>Cash schedule</th></tr></thead>
        <tbody>{protocol.rule.table.map(r => <tr key={JSON.stringify(r.reports)}><td>{r.reports.join(", ")}</td><td>{r.outcomeId}</td><td>{r.schedule.map(s => <p key={`${s.partyId}:${s.dateId}`}>{s.partyId}: {exact(s.amount)} {s.currency} at {s.dueAt}. Positive pays the party.</p>)}</td></tr>)}</tbody></table>
        <details><summary>Exact funding and all resources</summary><pre tabIndex={0}>{JSON.stringify({ dates: protocol.problem.dates, limits: protocol.problem.constraints, resources: protocol.problem.resources, allocation: current.allocation }, null, 2)}</pre></details>
        <details><summary>Original model assumptions and checker</summary><pre tabIndex={0}>{JSON.stringify({ assumptions: protocol.problem.assumptions, original: protocol.problem, checker: protocol.check }, null, 2)}</pre></details>
        <details><summary>Complete proposed obligations and missing operations</summary><pre tabIndex={0}>{JSON.stringify(current.schedules, null, 2)}</pre></details>
      </div> : null}
    </div> : null}
    {current ? <details><summary>Retained costs and meter gaps</summary><pre tabIndex={0}>{JSON.stringify(current.costs, null, 2)}</pre></details> : null}
    <p>Next authorized step: review current supplied sources and modeled alternatives. Solicitation, signing, payment, collection and independent S3/S8 admission need their actual owner contracts.</p>
  </section>
}
