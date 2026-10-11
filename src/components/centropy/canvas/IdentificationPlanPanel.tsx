"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { centropyPost, CentropyApiError } from "@/components/centropy/lib/api"
import { useCentropyAuth } from "@/components/centropy/lib/centropy-auth"
import { onBusinessInvalidation } from "@/components/centropy/lib/business-invalidation"
import { IdentificationWorkViewSchema, IdentificationConsumerViewSchema, exactIdentificationQuantity as exact, type IdentificationWorkView } from "./identification-plan-view"

type Root = { entityType: string; entityId: string }
const label = (value: string) => value.replaceAll("_", " ").toLowerCase()

export function IdentificationPlanPanel({ root, workId }: { root: Root; workId: string | null }) {
  const auth = useCentropyAuth()
  const sessionScope = useRef({ token: auth.session?.access_token, version: 0 })
  if (sessionScope.current.token !== auth.session?.access_token)
    sessionScope.current = { token: auth.session?.access_token, version: sessionScope.current.version + 1 }
  const scope = `${auth.session?.user.id ?? "signed-out"}:${sessionScope.current.version}:${workId}:${root.entityType}:${root.entityId}`
  const authorized = Boolean(workId && auth.session && auth.role === "owner" && !auth.loading && !auth.roleLoading && !auth.roleError)
  const [view, setView] = useState<{ scope: string; data: IdentificationWorkView } | null>(null)
  const [notice, setNotice] = useState("Reading current owner-registered identification profile.")
  const [busy, setBusy] = useState(false), [history, setHistory] = useState<{ scope: string; value: unknown } | null>(null)
  const generation = useRef(0), scopeRef = useRef(scope), writing = useRef<number | null>(null)
  scopeRef.current = scope
  const clear = useCallback(() => { setView(null); setHistory(null) }, [])
  const current = authorized && view?.scope === scope ? view.data : null
  const profile = current?.profile ?? null, run = current?.run ?? null
  const plan = run?.status === "COMPLETE" && run.currentUseGranted && !run.provisional ? run.plan : null
  const active = (epoch: number) => generation.current === epoch && scopeRef.current === scope && document.visibilityState === "visible"
  const refresh = useCallback(async (epoch: number) => {
    if (!workId) return
    try {
      const next = IdentificationWorkViewSchema.parse(await centropyPost("identification-plans/work", { root: { entityType: root.entityType, entityId: root.entityId }, workId }))
      if (generation.current !== epoch || scopeRef.current !== scope || document.visibilityState !== "visible") return
      if (next.profile && Date.parse(next.profile.validUntil) <= Date.now()) throw Error("Original identification owner grant expired.")
      if (next.workId !== workId || next.root.entityType !== root.entityType || next.root.entityId !== root.entityId ||
        next.run && next.profile && next.run.workRevision !== next.profile.workRevision) throw Error("Identification Work binding differs.")
      setView({ scope, data: next })
      setNotice(next.reason ? label(next.reason) : next.run ? `${label(next.run.status)} search. No collection or effect authority.` : "Current profile. Run a bounded search under its original grant.")
      return next
    } catch (error) {
      if (generation.current !== epoch || scopeRef.current !== scope) return
      clear()
      setNotice(error instanceof CentropyApiError && [401, 403, 404].includes(error.status)
        ? "Identification is unavailable in your current access scope. Private output cleared."
        : "Current identification could not be revalidated. Private output cleared.")
    }
  }, [scope, workId, root.entityType, root.entityId, clear])

  useEffect(() => {
    generation.current++; clear(); setBusy(false); writing.current = null
  }, [scope, authorized, clear])
  useEffect(() => {
    if (!authorized) return
    let cancelled = false, reading = false, timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      clearTimeout(timer)
      if (cancelled) return
      let delay = 10000
      if (!reading && writing.current === null && document.visibilityState === "visible") {
        reading = true
        try {
          const next = await refresh(generation.current)
          if (next?.run && ["QUEUED", "RUNNING"].includes(next.run.status)) delay = 1000
        } finally { reading = false }
      }
      if (!cancelled) timer = setTimeout(() => void tick(), delay)
    }
    const invalidate = () => { generation.current++; clear() }
    const visible = () => { invalidate(); if (document.visibilityState === "visible") void tick() }
    const unsubscribe = onBusinessInvalidation(signal => {
      if (signal.path?.startsWith("identification-plans/")) return
      if (signal.tags.some(tag => ["work", "source", "authority", "company-brain"].includes(tag))) {
        invalidate(); void tick()
      }
    })
    void tick()
    window.addEventListener("pagehide", invalidate); document.addEventListener("visibilitychange", visible)
    return () => {
      cancelled = true; invalidate(); clearTimeout(timer); unsubscribe()
      window.removeEventListener("pagehide", invalidate); document.removeEventListener("visibilitychange", visible)
    }
  }, [authorized, refresh, clear])
  useEffect(() => {
    if (!profile) return
    const timer = setTimeout(() => {
      generation.current++; clear(); setNotice("The original owner grant expired. Private output cleared. No grant renewed.")
    }, Math.max(0, Date.parse(profile.validUntil) - Date.now()))
    return () => clearTimeout(timer)
  }, [profile, clear])

  async function perform(operation: (epoch: number) => Promise<void>) {
    if (!authorized || writing.current !== null || document.visibilityState !== "visible") return
    const epoch = ++generation.current
    writing.current = epoch; setBusy(true); setHistory(null)
    try { await operation(epoch) }
    catch {
      if (!active(epoch)) return
      clear(); setNotice("Owner or currentness condition refused this request. Private output cleared. No effect or collection authorized.")
    } finally { if (writing.current === epoch) { writing.current = null; setBusy(false) } }
  }
  function submit() {
    if (!profile) return
    void perform(async epoch => {
      clear(); setNotice("Submitting the registered query under its original grant. Output remains provisional.")
      await centropyPost("identification-plans/submit", {
        schema: "finnor.r4.run-request.v1", envelope_inputs: { profileId: profile.id },
        problem_ref: profile.ref, domain_profile_ref: profile.ref, existing_work_revision: profile.workRevision,
        budget_grant_ref: profile.budgetGrantRef, cancellation_ref: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(),
      })
      if (active(epoch)) await refresh(epoch)
    })
  }
  function consume(disposition: "PROPOSE" | "DECLINE" | "WAIT") {
    if (!run || !plan) return
    void perform(async epoch => {
      const result = IdentificationConsumerViewSchema.parse(await centropyPost("identification-plans/consume", { runId: run.id, disposition }))
      if (!active(epoch)) return
      await refresh(epoch)
      if (active(epoch)) setNotice(`${label(result.decision.review.status)}. Original utility unchanged. ${label(result.decision.acquisitionFallbackAbsence)}. No collection, reservation or effect authorized.`)
    })
  }
  const shownPairs = plan?.pairs.filter(pair => !plan.selected || pair.mask === plan.selected.mask) ?? []
  return <section className="ct-identification-plan" aria-label="Identification acquisition review" data-identification-scope={scope}>
    <h3>Identification acquisition review</h3>
    <p>Model-relative symbolic planning, not a measured effect, field identification or financial verification.</p>
    <p role="status" aria-live="polite">{!workId ? "Select an existing Work before reviewing identification." : !authorized ? "Sign in with current owner access. Private output is hidden." : notice}</p>
    {authorized ? <div className="ct-evidence__actions">
      <button type="button" disabled={busy} onClick={() => void perform(async epoch => { clear(); await refresh(epoch) })}>Recheck identification sources</button>
      <button type="button" disabled={busy || !profile || Boolean(run && ["QUEUED", "RUNNING"].includes(run.status))} onClick={submit}>Run registered identification search</button>
      {run ? <button type="button" disabled={busy || !["QUEUED", "RUNNING"].includes(run.status)} onClick={() => void perform(async epoch => {
        clear(); await centropyPost("identification-plans/cancel", { runId: run.id })
        if (active(epoch)) { await refresh(epoch); setNotice("Cancellation requested. Only physically terminated compute is released. Costs and unknown obligations remain.") }
      })}>Cancel identification search</button> : null}
    </div> : null}
    {profile ? <div data-identification-query>
      <h4>Registered causal query</h4>
      <p>{profile.query.outcomes.join(", ")} under do({profile.query.treatments.join(", ")}){profile.query.conditions.length ? ` given ${profile.query.conditions.join(", ")}` : ""}</p>
      <dl><dt>Population</dt><dd>{profile.query.scope.population}</dd><dt>Intervention</dt><dd>{profile.query.scope.intervention}</dd>
        <dt>Timing</dt><dd>{profile.query.scope.time.start} to {profile.query.scope.time.end}</dd><dt>Units</dt><dd>{Object.entries(profile.query.scope.units).map(([name, unit]) => `${name}: ${unit}`).join("; ")}</dd>
        <dt>Original owner expiry</dt><dd>{profile.validUntil}</dd></dl>
      <p>Graph family: {profile.graphIds.join(", ")}. {label(profile.qualification)}. Graph truth is not established.</p>
    </div> : null}
    {run && !plan ? <p>No accepted current plan is available. {label(run.status)}. Unresolved: {run.gaps.map(label).join("; ")}. Pending output is provisional.</p> : null}
    {plan && profile ? <div data-identification-accepted>
      <h4>{plan.identification === "CONDITIONAL" ? "Conditional acquisition plan" : label(plan.identification) + " identification plan"}</h4>
      <p>Basis: {label(plan.basis)}. Search completion does not establish observations, population positivity or effect size.</p>
      {plan.selected ? <dl>
        <dt>Selected evidence</dt><dd data-identification-selected>{plan.selected.bundleIds.join(", ") || "Already available baseline, empty acquisition"}</dd>
        <dt>Registered acquisition cost</dt><dd data-identification-cost>{exact(plan.selected.totalCost)} {profile.costBasis.currency}</dd>
        <dt>Collection completion</dt><dd data-identification-delay>{exact(plan.selected.completion)} second(s)</dd>
        <dt>Price basis</dt><dd>{profile.costBasis.unit}; valued {profile.costBasis.valuationAt}; owner share {exact(profile.costBasis.ownerShare)}; {profile.costBasis.discount}</dd>
      </dl> : <p>No family-sufficient plan was selected. Retained graph failures and unresolved conditions remain below.</p>}
      <h4>Per-graph functionals and required conditions</h4>
      {shownPairs.map(pair => <article key={`${pair.mask}:${pair.graphId}`} data-identification-graph={pair.graphId}>
        <strong>{pair.graphId}, mask {pair.mask}</strong>
        <p>{label(pair.structural)}; data {label(pair.data)}; {pair.sufficient ? "sufficient under supplied premises" : "not sufficient"}</p>
        {pair.functional ? <pre>{pair.functional}</pre> : null}
        <p>{pair.reasons.map(label).join("; ")}</p>
        <ul>{pair.conditions.map(condition => <li key={`${condition.lawId}:${condition.premise}`}>{condition.lawId}: {condition.premise}, {label(condition.status)}{condition.prospective ? ", required future collection condition, not observed evidence" : ""}. {condition.reason} Basis: {condition.basis}.</li>)}</ul>
      </article>)}
      <p>Common functional: {label(plan.commonFunctional.status)}. {plan.commonFunctional.basis}. Per-graph identification alone is not a common effect.</p>
      <h4>Complete declared menu and alternatives</h4>
      <p data-identification-coverage>{plan.minimality.masks} masks / {plan.minimality.pairs} graph pairs. Minimality {label(plan.minimality.status)} only over the supplied menu. Unresolved masks: {plan.minimality.unresolvedMasks.join(", ") || "none"}.</p>
      <details><summary>Inspect all masks, alternatives and rejection reasons</summary>
        <ul>{plan.masks.map(mask => <li key={mask.mask}>Mask {mask.mask}: {mask.bundleIds.join(", ") || "empty baseline"}; cost {mask.totalCost ? exact(mask.totalCost) + " " + profile.costBasis.currency : "unknown"}; completion {exact(mask.completion)} second(s); {label(mask.status)}; {mask.sufficientForFamily ? "family sufficient under supplied premises" : "not family sufficient"}. {mask.reasons.map(label).join("; ")}</li>)}</ul>
      </details>
      <details><summary>Inspect schedule, resources and declared assumptions</summary><pre>{JSON.stringify({ schedule: plan.selected?.schedule, resources: plan.selected?.resourceUse }, null, 2)}</pre><ul>{plan.assumptions.map(value => <li key={value}>{value}</li>)}</ul></details>
      <p>Next step: S4 may review planning value under its original utility. S2 collection, S5 commitments and S6 effects need their own current authority. No admitted observational collection fallback is asserted.</p>
      <div className="ct-evidence__actions"><button type="button" disabled={busy} onClick={() => consume("PROPOSE")}>Ask S4 to review collection proposal</button>
        <button type="button" disabled={busy} onClick={() => consume("DECLINE")}>Decline collection proposal</button>
        <button type="button" disabled={busy} onClick={() => consume("WAIT")}>Ask S4 to wait or stop</button></div>
    </div> : null}
    {run ? <details><summary>Inspect retained costs, gaps and history</summary>
      <p>Actual compute dollars and actual collection cost are unknown, not zero. Complete aggregate/container and dollar qualification remains unavailable.</p>
      <ul>{run.costs.attempts.map(attempt => <li key={attempt.id}>{attempt.kind}: {label(attempt.status)}, charged attempts {attempt.chargedNativeAttempts}, elapsed {attempt.elapsedMs ?? "unknown"} ms, termination {attempt.terminationObserved ? "observed" : "unconfirmed"}; {label(attempt.responsibility)}.</li>)}</ul>
      <ul>{run.gaps.map(value => <li key={value}>{label(value)}</li>)}</ul>
      <button type="button" disabled={busy} onClick={() => void perform(async epoch => {
        const value = await centropyPost("identification-plans/history", { runId: run.id })
        if (active(epoch)) setHistory({ scope, value })
      })}>Read immutable identification history</button>
      {history?.scope === scope ? <pre>{JSON.stringify(history.value, null, 2)}</pre> : null}
    </details> : null}
  </section>
}
