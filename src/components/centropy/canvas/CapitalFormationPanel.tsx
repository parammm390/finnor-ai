"use client"

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { centropyPost, CentropyApiError } from "@/components/centropy/lib/api"
import { useCentropyAuth } from "@/components/centropy/lib/centropy-auth"
import { onBusinessInvalidation } from "@/components/centropy/lib/business-invalidation"
import { capitalFormationView, capitalDisplayDeadline, exactCapitalAmount } from "./capital-formation-view"
import type { CapitalFormationView } from "../../../../finnor-os/packages/shared-types/src/capital-formation"

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const label = (s: string) => s.replaceAll("_", " ").toLowerCase()
export function CapitalFormationPanel({ workId, root }: { workId: string; root: { entityType: string; entityId: string } }) {
  const auth = useCentropyAuth(), router = useRouter(), pathname = usePathname(), search = useSearchParams()
  const session = useRef({ token: auth.session?.access_token, epoch: 0 })
  if (session.current.token !== auth.session?.access_token) session.current = { token: auth.session?.access_token, epoch: session.current.epoch + 1 }
  const scope = `${auth.session?.user.id ?? "signed-out"}:${session.current.epoch}:${workId}:${root.entityType}:${root.entityId}`
  const scopeRef = useRef(scope), generation = useRef(0), writing = useRef<number | null>(null)
  scopeRef.current = scope
  const authorized = Boolean(auth.session && auth.role === "owner" && !auth.loading && !auth.roleLoading && !auth.roleError)
  const [stored, setStored] = useState<{ scope: string; value: CapitalFormationView } | null>(null)
  const [programmeDraft, setProgrammeDraft] = useState<{ scope: string; value: string } | null>(null)
  const [signedDraft, setSignedDraft] = useState<{ scope: string; value: string } | null>(null)
  const programmeId = authorized && programmeDraft?.scope === scope ? programmeDraft.value : ""
  const signedRequest = authorized && signedDraft?.scope === scope ? signedDraft.value : ""
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("Load an existing original programme or submit its exact approved signed mandate.")
  const [error, setError] = useState<string | null>(null)
  const parameter = search.get("capitalFormation")
  const current = authorized && stored?.scope === scope && stored.value.programmeId === parameter ? stored.value : null
  const pkg = current?.current ? current.package : null
  const clear = useCallback(() => setStored(null), [])
  const active = useCallback((epoch: number) => generation.current === epoch && scopeRef.current === scope && document.visibilityState === "visible", [scope])
  const refresh = useCallback(async (id: string, epoch: number) => {
    try {
      const next = capitalFormationView.parse(await centropyPost("company-brain/capital-formation-read", { programmeId: id }))
      if (!active(epoch)) return
      if (next.workId !== workId || next.programmeId !== id || next.root.entityType !== root.entityType || next.root.entityId !== root.entityId
        || next.package && next.package.programmeId !== id) throw Error("Current Work, company or programme binding differs.")
      if (next.current && next.package && !(capitalDisplayDeadline(next) > Date.now())) {
        clear(); setError(null); setNotice("The current financing window expired. Values cleared."); return
      }
      setStored(previous => previous?.scope === scope && JSON.stringify(previous.value) === JSON.stringify(next)
        ? previous : { scope, value: next }); setError(null)
      setNotice(next.current ? label(next.status) : "Current sources or authority changed. Earlier values are historical.")
    } catch {
      if (!active(epoch)) return
      clear(); setError("Current financing could not be verified in your access scope. Values cleared.")
    }
  }, [active, clear, scope, workId, root.entityType, root.entityId])
  useEffect(() => {
    generation.current++; clear(); setSignedDraft(null); setProgrammeDraft(null); setBusy(false); writing.current = null; setError(null)
  }, [scope, authorized, clear])
  useEffect(() => {
    if (!authorized || !parameter || !uuid.test(parameter)) return
    let cancelled = false, reading = false, timer: ReturnType<typeof setTimeout> | undefined
    const invalidate = () => { generation.current++; clear() }
    const tick = async () => {
      clearTimeout(timer)
      if (cancelled) return
      if (!reading && writing.current === null && document.visibilityState === "visible" && navigator.onLine) {
        reading = true
        try { await refresh(parameter, generation.current) } finally { reading = false }
      }
      if (!cancelled) timer = setTimeout(() => void tick(), 2000)
    }
    const reset = () => { invalidate(); if (document.visibilityState === "visible" && navigator.onLine) void tick() }
    const unsubscribe = onBusinessInvalidation(signal => {
      if (/company-brain\/capital-formation-(?:read|list|profiles)$/.test(signal.path ?? "")) return
      if (writing.current !== null && (signal.path ?? "").includes("company-brain/capital-formation-")) return
      if (signal.tags.some(tag => ["work", "company-brain", "authority", "underwriting", "source"].includes(tag))) reset()
    })
    void tick()
    window.addEventListener("pagehide", invalidate); window.addEventListener("offline", invalidate); window.addEventListener("online", reset)
    document.addEventListener("visibilitychange", reset)
    return () => { cancelled = true; invalidate(); clearTimeout(timer); unsubscribe()
      window.removeEventListener("pagehide", invalidate); window.removeEventListener("offline", invalidate); window.removeEventListener("online", reset)
      document.removeEventListener("visibilitychange", reset) }
  }, [authorized, parameter, refresh, clear])
  useEffect(() => {
    if (!pkg || !current) return
    const deadline = capitalDisplayDeadline(current)
    let timer: ReturnType<typeof setTimeout> | undefined
    const recheck = () => {
      const remaining = deadline - Date.now()
      if (!(remaining > 0)) { generation.current++; clear(); setNotice("The current financing window expired. Values cleared."); return }
      timer = setTimeout(recheck, Math.min(remaining, 2147483647))
    }
    recheck()
    return () => clearTimeout(timer)
  }, [pkg, current, clear])
  function pin(id: string) {
    const params = new URLSearchParams(search.toString()); params.set("capitalFormation", id)
    router.replace(`${pathname}?${params}`, { scroll: false })
  }
  async function perform(run: (epoch: number) => Promise<void>) {
    if (!authorized || writing.current !== null || document.visibilityState !== "visible") return
    const epoch = ++generation.current
    writing.current = epoch; setBusy(true); setError(null); clear()
    try { await run(epoch) }
    catch (cause) {
      if (!active(epoch)) return
      clear(); setError(cause instanceof CentropyApiError && [401, 403, 404].includes(cause.status)
        ? "Financing is unavailable in your current access scope. Values cleared."
        : cause instanceof Error ? cause.message : "Current financing could not be verified. Values cleared.")
    } finally { if (writing.current === epoch) { writing.current = null; setBusy(false) } }
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    void perform(async epoch => {
      if (new TextEncoder().encode(signedRequest).length > 65536) throw Error("Signed request exceeds the original ingress limit.")
      const body = JSON.parse(signedRequest)
      if (body.mandate?.workId !== workId || body.mandate?.root?.entityType !== root.entityType || body.mandate?.root?.entityId !== root.entityId) throw Error("The approved signed mandate must bind this exact Work and company.")
      const accepted = await centropyPost("company-brain/capital-formation-submit", body) as { programmeId?: string; executionAuthorityGranted?: unknown }
      if (!active(epoch)) return
      if (!accepted.programmeId || !uuid.test(accepted.programmeId) || accepted.executionAuthorityGranted !== false) throw Error("Exact original acceptance could not be verified.")
      setSignedDraft(null); pin(accepted.programmeId); setNotice("Original bounded programme queued. No execution authority or admission granted.")
    })
  }
  function control(kind: "advance" | "cancel") {
    if (!current) return
    const original = current
    void perform(async epoch => {
      await centropyPost(`company-brain/capital-formation-${kind}`, { programmeId: original.programmeId, expectedRevision: original.revision,
        ...(kind === "cancel" ? { reason: "Principal requested stop; original liabilities retained" } : { triggerRef: "Current Work Canvas recheck; original grant and deadline unchanged" }) })
      if (!active(epoch)) return
      await refresh(original.programmeId, epoch)
    })
  }
  const amount = (value: string) => pkg ? exactCapitalAmount(value, pkg.minorUnits, pkg.currency) : ""
  return <section aria-label="Autonomous capital formation" aria-busy={busy}>
    <h4>Autonomous capital formation</h4>
    <p>Professional-classified commitments are not bank receipts. Financing principal is not profit. Live admission is not established and activation is disabled.</p>
    {!authorized ? <p>Current owner and Work access are required.</p> : null}
    <form onSubmit={event => { event.preventDefault(); if (uuid.test(programmeId)) pin(programmeId) }}>
      <label>Original financing programme ID<input value={programmeId} maxLength={36} onChange={event => setProgrammeDraft({ scope, value: event.target.value })} /></label>
      <button disabled={!authorized || busy || !uuid.test(programmeId)}>Load original financing programme</button>
    </form>
    <details><summary>Submit exact approved signed mandate</summary><form onSubmit={submit}>
      <label>Approved signed financing request<textarea value={signedRequest} maxLength={65536} rows={5} spellCheck={false} autoComplete="off" onChange={event => setSignedDraft({ scope, value: event.target.value })} /></label>
      <p>Existing S4 approval, original S5 grant, independently enrolled activity authority and exact disclosure rights are required. This form creates none of them.</p>
      <button disabled={!authorized || busy || !signedRequest.trim()}>Start original bounded financing programme</button>
    </form></details>
    <p role="status" aria-live="polite">{notice}</p>{error ? <p role="alert">{error}</p> : null}
    {current ? <>
      <p>{label(current.status)}. {current.authenticatedEventCount} distinct authenticated source events.</p>
      <button disabled={busy} onClick={() => void perform(epoch => refresh(current.programmeId, epoch))}>Recheck current financing</button>
      <button disabled={busy || ["STOPPED", "FAILED", "COMPLETE"].includes(current.status)} onClick={() => control("advance")}>Continue original financing grant</button>
      <button disabled={busy || current.status === "STOPPED"} onClick={() => control("cancel")}>Stop new financing activity</button>
      <p>Contacts {current.budget.contactsSpent}/{current.budget.contactLimit}. Steps {current.budget.stepsSpent}/{current.budget.stepLimit}.
        Human time {current.budget.humanSecondsSpent}/{current.budget.humanSecondsLimit} seconds.
        Original deadline {current.budget.originalDeadlineAt}. {current.budget.costUnknown ? "Unresolved physical cost and operation retained." : "Ceiling charges retained; full economic cost is not qualified."}</p>
      {pkg ? <div aria-label="Current reconciled financing package">
        <dl><dt>Funding requirement</dt><dd>{amount(pkg.requirementMinor)}</dd>
          <dt>Verified conditional commitments</dt><dd>{amount(pkg.conditionalCommittedMinor)}</dd>
          <dt>Indicative equity, not committed</dt><dd>{amount(pkg.indicativeEquityMinor)}</dd>
          <dt>Eligible effective undrawn capacity, not cash</dt><dd>{amount(pkg.eligibleUndrawnMinor)}</dd>
          <dt>Dispatched or unknown funding</dt><dd>{amount(pkg.dispatchedUnknownMinor)}</dd>
          <dt>Independently observed funding received</dt><dd>{amount(pkg.fundingReceivedMinor)}</dd>
          <dt>Present eligible funding gap</dt><dd>{amount(pkg.presentEligibleGapMinor)}</dd>
          <dt>Readiness</dt><dd>{label(pkg.readiness)}</dd></dl>
        <ul>{pkg.commitments.map(c => <li key={c.commitmentId}>{c.commitmentId}: {label(c.state)}.
          {c.unsatisfiedConditions.length ? ` Unsatisfied conditions: ${c.unsatisfiedConditions.join(", ")}.` : ""}
          {c.unresolvedClaims.length ? ` Unresolved: ${c.unresolvedClaims.join(", ")}.` : ""}</li>)}</ul>
      </div> : <p>No current checked financing package is available.</p>}
      <ul>{current.blockers.map((s, i) => <li key={i}>{s}</li>)}</ul>
      <details><summary>Retained original activity and responsibility</summary><ul>{current.history.map((h, i) => <li key={i}>{label(h.kind)} at {h.at}</li>)}</ul>
        <p>Stopping new activity does not erase obligations, possible deliveries, costs or historical evidence.</p></details>
    </> : null}
  </section>
}
