"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useCentropyAuth as useJarvisAuth } from "@/components/centropy/lib/centropy-auth"
import { centropyPost as jarvisPost, CentropyApiError as JarvisApiError } from "@/components/centropy/lib/api"
import type { paths } from "@/lib/jarvis/openapi-types"

type Projection = paths["/api/company-brain/deliberation-projection"]["post"]["responses"][200]["content"]["application/json"]
type Props = { root: { entityType: string; entityId: string }; workId: string | null; threadId: string }
const explanation = (value: string) => value.replaceAll("_", " ").toLowerCase()

/** Canonical current view; private responses never survive a scope/epoch change. */
export function DeliberationPanel({ root, workId, threadId }: Props) {
  const { session } = useJarvisAuth()
  const identity = [session?.user.id ?? "signed-out", session?.access_token ?? "", threadId, root.entityType, root.entityId, workId ?? "none"].join(":")
  const currentIdentity = useRef(identity)
  currentIdentity.current = identity
  const epoch = useRef(0), inFlight = useRef<{ identity: string; sequence: number } | null>(null), panel = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<{ identity: string; data: Projection } | null>(null)
  const [busy, setBusy] = useState(false), [selected, setSelected] = useState("")
  const [message, setMessage] = useState("Select Work with an original computation allocation.")
  const visible = state?.identity === identity ? state.data : null
  const latest = visible?.policies[0] ?? null, policy = latest?.policy ?? null
  const clear = useCallback(() => setState(null), [])

  const refresh = useCallback(async (sequence: number) => {
    if (!session || !workId) return
    const expected = identity
    if (inFlight.current?.identity === expected) return
    const active = { identity: expected, sequence }; inFlight.current = active
    try {
      const data = await jarvisPost<Projection>("company-brain/deliberation-projection", { root: { entityType: root.entityType, entityId: root.entityId }, workId })
      if (sequence !== epoch.current || currentIdentity.current !== expected) return
      if (data.workId !== workId || data.policies.some(p => p.policy.envelope.work.id !== workId)) {
        clear(); setMessage("Deliberation is unavailable for this Work."); return
      }
      setState({ identity: expected, data })
      setMessage(data.policies[0]?.reason ? explanation(data.policies[0].reason) : data.policies.length ? "Current deliberation verified." : data.eligiblePrograms.length ? "An allocated method is ready for deliberation." : "No allocated method is waiting for deliberation.")
    } catch (error) {
      if (sequence === epoch.current && currentIdentity.current === expected) {
        clear()
        setMessage(error instanceof JarvisApiError && [401, 403, 404].includes(error.status) ? "Deliberation unavailable in the current access scope." : "Current deliberation could not be verified.")
      }
    } finally { if (inFlight.current === active) inFlight.current = null }
  }, [identity, session, workId, root.entityId, root.entityType, clear])

  useEffect(() => {
    const observer = epoch, sequence = ++observer.current; clear(); setBusy(false); setSelected("")
    if (session && workId && document.visibilityState === "visible") void refresh(sequence)
    else setMessage("Select Work with an original computation allocation.")
    return () => { observer.current++ }
  }, [identity, session, workId, refresh, clear])
  useEffect(() => {
    if (!session || !workId) return
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(epoch.current) }, 3000)
    const revalidate = () => { const sequence = ++epoch.current; clear(); if (document.visibilityState === "visible") void refresh(sequence) }
    document.addEventListener("visibilitychange", revalidate); window.addEventListener("focus", revalidate)
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", revalidate); window.removeEventListener("focus", revalidate) }
  }, [session, workId, refresh, clear])

  async function transition(operation: "submit" | "cancel" | "resume" | "reconcile") {
    const candidate = visible?.eligiblePrograms.find(p => p.programId === selected) ?? visible?.eligiblePrograms[0]
    if (operation === "submit" ? !candidate : !latest) return
    const sequence = ++epoch.current, expected = identity
    clear(); setBusy(true)
    try {
      await jarvisPost("company-brain/deliberation-" + operation, operation === "submit" ? {
        schema: "finnor.deliberation-request.v1", programId: candidate!.programId,
        policyRequest: candidate!.policyRequest, computeGrant: candidate!.computeGrant,
        idempotencyKey: crypto.randomUUID(), mode: "ordinary_disposable", strategy: "ADAPTIVE",
        limits: { maxUnits: 8, maxParallel: 2 }, valueEvidenceRef: null, sourceInspectionRef: null,
      } : { searchId: latest!.searchId })
      if (sequence === epoch.current && currentIdentity.current === expected) await refresh(sequence)
    } catch (error) {
      if (sequence === epoch.current && currentIdentity.current === expected) {
        clear()
        const predicate = error instanceof JarvisApiError ? (error.details as { predicate?: string } | undefined)?.predicate : null
        setMessage(predicate ? explanation(predicate) : "The original allocation could not confirm this deliberation transition.")
      }
    } finally { if (sequence === epoch.current && currentIdentity.current === expected) setBusy(false) }
  }

  const view = policy?.projection, incumbent = latest && !["CANCELLED", "INVALIDATED"].includes(latest.status) ? view?.incumbent : null
  return <div ref={panel} className="ct-evidence ct-deliberation" data-deliberation-work={workId ?? "none"} data-deliberation-search={latest?.searchId ?? "none"} style={{ minWidth: 0, overflowWrap: "anywhere" }}>
    <p role="status" aria-live="polite">{message}</p>
    {visible?.eligiblePrograms.length ? <div className="ct-evidence__fields">
      <label>Allocated analytical method<select value={selected || visible.eligiblePrograms[0]?.programId} onChange={e => setSelected(e.target.value)}>{visible.eligiblePrograms.map((p, index) => <option key={p.programId} value={p.programId}>Allocated method {index + 1} · {p.status.toLowerCase()}</option>)}</select></label>
      <button type="button" disabled={busy || !session} onClick={() => void transition("submit")}>Run deliberation</button>
    </div> : null}
    {latest && policy && view ? <>
      <p>{latest.status.toLowerCase()} · {view.frontier.filter(f => f.accepted).length} currently checked result{view.frontier.filter(f => f.accepted).length === 1 ? "" : "s"}</p>
      {policy.nextWork.length ? <ol>{policy.nextWork.map(unit => <li key={unit.unitId}>{unit.meaning} · {unit.admission.logicalState.toLowerCase()}{unit.estimate.expectedGain !== null ? <span> · expected improvement {unit.estimate.expectedGain} {unit.estimate.lossUnit} ({explanation(unit.estimate.support)})</span> : <span> · expected improvement unknown</span>}{unit.prerequisites.length ? " · follows checked prerequisites" : ""}</li>)}</ol> : <p>No further computational work is admitted.</p>}
      {incumbent ? <dl className="ct-evidence__values">{Object.entries(incumbent.values).map(([key, v]) => <div key={key}><dt>{key}</dt><dd>{v.value} {v.semantics.currencyCode ?? v.semantics.unit}</dd></div>)}</dl> : <p>No current independently checked incumbent.</p>}
      <p>{view.stop.bound && !view.stop.heuristic ? `Finite accepted-output bound: remaining improvement ≤ ${view.stop.bound.upper} ${view.stop.bound.unit}, within supplied mechanics.` : "Stopping is heuristic. Remaining decision value is unknown."} Business choice remains with S4.</p>
      <p>{policy.utilityConversion ? `Decision-loss unit: ${policy.utilityConversion.unit}, using supplied finite accepted-output terms.` : "Owner decision-loss and delay conversion are unavailable."}</p>
      <p>{view.outstandingCosts.physicalAttempts} physical attempts · {view.outstandingCosts.controllerRuns} controller runs. USD cost is unknown.</p>
      <p>Attempt costs and preparation remain recorded. Field value and monetary billing are unresolved.</p>
      {view.outstandingCosts.attempts.length ? <><p>Outstanding work retains its allocation liability.</p><ul>{view.outstandingCosts.attempts.map(attempt => <li key={attempt.attemptId}>{explanation(attempt.status)} · {explanation(attempt.disposition)}</li>)}</ul></> : null}
      <div className="ct-evidence__actions">
        {!["STOPPED", "FAILED", "CANCELLED", "INVALIDATED"].includes(latest.status) ? <button type="button" disabled={busy} onClick={() => void transition("cancel")}>Cancel deliberation</button> : null}
        {latest.status === "WAITING" ? <button type="button" disabled={busy} onClick={() => void transition("resume")}>Resume with original allocation</button> : null}
        {view.outstandingCosts.attempts.length ? <button type="button" disabled={busy} onClick={() => void transition("reconcile")}>Reconcile outstanding work</button> : null}
        <button type="button" onClick={() => { panel.current?.querySelector("details")?.setAttribute("open", ""); panel.current?.querySelector<HTMLElement>("[data-deliberation-proof]")?.focus() }}>Inspect deliberation evidence</button>
      </div>
      <details><summary>Current policy, value support and retained liabilities</summary><section data-deliberation-proof tabIndex={-1}><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxWidth: "100%" }}>{JSON.stringify({ searchId: latest.searchId, programId: latest.programId, planRef: latest.planRef, ...policy }, null, 2)}</pre></section></details>
    </> : null}
  </div>
}
