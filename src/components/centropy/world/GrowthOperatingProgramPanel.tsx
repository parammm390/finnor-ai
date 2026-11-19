"use client"

import { useEffect, useRef, useState } from "react"
import { centropyPost } from "../lib/api"
import { useCentropyAuth } from "../lib/centropy-auth"
import { usePrivateRequestScope } from "../lib/use-private-request-scope"
import { onBusinessInvalidation } from "../lib/business-invalidation"
import { GrowthOwnerControls, GrowthPreparedOutcomes } from "./GrowthOwnerControls"
import { GrowthParticipantControls } from "./GrowthParticipantControls"
import { HumanControlDesk } from "../controls/HumanControlDesk"
import { growthAmount, growthInboxSchema, growthLabel, growthProgressSchema, growthSameScope, growthViewSchema,
  type GrowthMutation, type GrowthProgress, type GrowthView } from "./growth-program-contracts"
import type { z } from "zod"

type Stored = { key: string; view: GrowthView | null; inbox: z.infer<typeof growthInboxSchema> | null }
export function GrowthBusinessInvitations({ contextKey, companyId, workId }: {
  contextKey: string; companyId?: string; workId?: string
}) {
  const scope = usePrivateRequestScope(JSON.stringify(["growth-invitations", contextKey, companyId, workId]), "WORKFORCE_PARTICIPANT")
  const [open, setOpen] = useState<string | null>(null)
  if (!scope.allowed) return null
  return <details key={scope.key} onToggle={event => setOpen(event.currentTarget.open ? scope.key : null)}>
    <summary>My purpose-bound business invitations</summary>
    {open === scope.key ? <GrowthOperatingProgramPanel contextKey={scope.key} companyId={companyId} workId={workId} /> : null}
  </details>
}

export function GrowthOperatingProgramPanel({ workId, contextKey, companyId, ownerWork = false }: {
  workId?: string; contextKey?: string; companyId?: string; ownerWork?: boolean
}) {
  const auth = useCentropyAuth()
  const scope = usePrivateRequestScope(JSON.stringify(["growth", workId ?? "my-invitations", contextKey, companyId, ownerWork]),
    ownerWork ? undefined : "WORKFORCE_PARTICIPANT")
  const [stored, setStored] = useState<Stored | null>(null), [notice, setNotice] = useState("")
  const [selected, setSelected] = useState(""), [revision, setRevision] = useState(0), [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ key: string; value: GrowthProgress } | null>(null)
  const writing = useRef<string | null>(null), mutationRevision = useRef(0)
  const onlineVisible = () => typeof navigator !== "undefined" && navigator.onLine
    && document.visibilityState === "visible"
  const current = scope.allowed && scope.isCurrent(scope.key) && onlineVisible() && stored?.key === scope.key ? stored : null
  const protocol = current?.inbox?.protocols.find(p => p.id === selected)
  const currentProgress = protocol?.status === "CONSENTED" && protocol.disclosure
    && Date.parse(protocol.expiresAt) > Date.now() && progress?.key === scope.key
    && progress.value.protocolId === protocol.id ? progress.value : null
  useEffect(() => {
    setStored(null); setProgress(null); setSelected(""); setNotice(""); setBusy(false); writing.current = null
  }, [scope.key])
  useEffect(() => {
    let active = true, reading = false
    const key = scope.key
    const valid = () => active && scope.isCurrent(key) && onlineVisible()
    const clear = () => {
      mutationRevision.current++; setStored(null); setProgress(null); setSelected(""); setNotice(""); scope.invalidate()
    }
    const refresh = async () => {
      if (!scope.allowed || !valid() || reading || writing.current === key) return
      reading = true
      const readRevision = mutationRevision.current
      const readCurrent = () => valid() && writing.current !== key && readRevision === mutationRevision.current
      try {
        const [owner, participant] = await Promise.allSettled([
          ownerWork && workId && auth.role === "owner" ? centropyPost("demand-to-business/read", { workId }) : Promise.resolve(null),
          ownerWork ? Promise.resolve(null) : centropyPost("demand-to-business/inbox", {}),
        ])
        if (!readCurrent()) return
        if (ownerWork && (owner.status !== "fulfilled" || !owner.value)) throw Error("Current owner Work unavailable")
        if (!ownerWork && participant.status !== "fulfilled") throw Error("Current participant context unavailable")
        const inbox = !ownerWork && participant.status === "fulfilled" ? growthInboxSchema.parse(participant.value) : null
        const view = owner.status === "fulfilled" && owner.value ? growthViewSchema.parse(owner.value) : null
        if (inbox && (inbox.scope.principalId !== auth.session?.user.id
          || inbox.protocols.some(p => p.disclosure && p.disclosure.scope.tenantId !== inbox.scope.tenantId))
          || view && (view.scope.workId !== workId || view.scope.principalId !== auth.session?.user.id
            || view.requests.some(r =>
              r.product.scope.workId !== workId || r.product.scope.principalId !== view.scope.principalId
              || r.product.scope.tenantId !== view.scope.tenantId)
            || view.preparedOutcomes.some(o => o.scope.workId !== workId
              || o.scope.principalId !== view.scope.principalId || o.scope.tenantId !== view.scope.tenantId)))
          throw Error("Private original scope changed")
        setStored({ key, view, inbox: inbox ? { ...inbox, protocols: inbox.protocols.filter(p =>
          !workId || p.disclosure?.scope.workId === workId) } : null })
      } catch {
        if (readCurrent()) { setStored(null); setProgress(null); setNotice("Current authorized business evidence is unavailable. Private output cleared.") }
      } finally { reading = false }
    }
    const unsubscribe = onBusinessInvalidation(signal => {
      if (writing.current !== key && signal.tags.some(tag =>
        ["work", "source", "authority", "company-brain"].includes(tag))) clear()
    })
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    window.addEventListener("offline", clear); window.addEventListener("online", clear)
    window.addEventListener("pagehide", clear); document.addEventListener("visibilitychange", clear)
    return () => {
      active = false; clearInterval(timer); unsubscribe()
      window.removeEventListener("offline", clear); window.removeEventListener("online", clear)
      window.removeEventListener("pagehide", clear); document.removeEventListener("visibilitychange", clear)
    }
  }, [scope.key, scope.allowed, scope.isCurrent, scope.invalidate, workId, ownerWork, auth.role, auth.session?.user.id, revision])
  useEffect(() => {
    const key = scope.key, now = Date.now()
    const deadlines = [
      ...(current?.inbox?.protocols.filter(p => p.status === "INVITED" || p.status === "CONSENTED")
        .map(p => Date.parse(p.expiresAt)) ?? []),
      ...(current?.view?.requests.flatMap(r => [Date.parse(r.originalDeadlineAt), Date.parse(r.product.currentUntil)]) ?? []),
    ].filter(at => at > now)
    if (!deadlines.length) return
    const timer = setTimeout(() => {
      if (scope.isCurrent(key)) {
        mutationRevision.current++; setStored(null); setProgress(null); setSelected(""); scope.invalidate()
      }
    }, Math.min(Math.min(...deadlines) - now, 2147483647))
    return () => clearTimeout(timer)
  }, [current, scope.key, scope.isCurrent, scope.invalidate])
  useEffect(() => {
    setProgress(null)
    if (!scope.allowed || !protocol?.requestId || !protocol.disclosure || protocol.status !== "CONSENTED") return
    let active = true
    const key = scope.key, p = protocol, readRevision = mutationRevision.current
    const valid = () => active && scope.isCurrent(key) && onlineVisible() && writing.current !== key
      && readRevision === mutationRevision.current && Date.parse(p.expiresAt) > Date.now()
    void centropyPost("demand-to-business/protocol-progress", { protocolId: p.id }).then(value => {
      if (!valid()) return
      const result = growthProgressSchema.parse(value)
      if (result.participantId !== auth.session?.user.id || result.protocolId !== p.id
        || !growthSameScope(result.scope, p.disclosure!.scope) || Date.parse(result.expiresAt) <= Date.now())
        throw Error("Exact private protocol changed")
      setProgress({ key, value: result })
    }).catch(() => {
      if (valid()) { setProgress(null); setNotice("Current purpose-bound evidence is unavailable. No report or completion is assumed.") }
    })
    return () => { active = false }
  }, [protocol, scope.key, scope.allowed, scope.isCurrent, auth.session?.user.id, revision])
  const mutate: GrowthMutation = async run => {
    const key = scope.key
    if (!scope.allowed || !scope.isCurrent(key) || !onlineVisible() || writing.current === key) return
    writing.current = key; mutationRevision.current++; setBusy(true); setStored(null); setProgress(null)
    const valid = () => scope.isCurrent(key) && onlineVisible() && writing.current === key
    try {
      await run(valid)
      if (valid()) setNotice("Recorded. Re-reading original evidence and remaining responsibilities. No field or profit qualification.")
    } catch {
      if (valid()) setNotice("No completion is assumed. Re-read the original record before retrying an uncertain write.")
    } finally {
      if (scope.isCurrent(key)) { writing.current = null; setBusy(false); setRevision(n => n + 1) }
    }
  }
  const evidenceProtocolFor = (kind: "INVOICE" | "ACCOUNTING") => {
    if (!protocol?.disclosure) return null
    return current?.inbox?.protocols.find(p => p.role === "ACCOUNTANT" && p.status === "CONSENTED"
      && p.purpose === protocol.purpose && p.disclosure && growthSameScope(p.disclosure.scope, protocol.disclosure!.scope)
      && p.permittedKinds.includes("EVIDENCE") && p.disclosure.evidenceKinds.includes(kind)
      && Date.parse(p.expiresAt) > Date.now())?.id ?? null
  }
  return <section className="ct-world-work__section" aria-label="Business test and operating programme"
    data-testid="w4-growth-panel" data-w4-context={workId ?? "my-invitations"}>
    <h4>Business test and operating programme</h4>
    <p>Controlled development only. Interest, commitments, delivery, collection and revenue are separate.
      No genuine market validation, execution authority, admission or realized profit is granted here.</p>
    {notice ? <p role="status">{notice}</p> : null}
    {!scope.allowed ? <p>Sign in with your own authorized identity to read your purpose-bound records.</p> : null}
    {current?.view ? <>
      <GrowthPreparedOutcomes view={current.view} busy={busy} mutate={mutate} />
      {current.view.requests.map(request => <GrowthOwnerControls key={scope.key + ":" + request.requestId}
        request={request} busy={busy || !current.view!.complete} mutate={mutate} />)}
      <details><summary>Prepare an already authorized native handoff</summary>
        <p>Use original S4 preparation, S5 allocation and consumption receipts, plus this Work&apos;s separate growth mandate.
          This does not create a new grant or issue business authority.</p>
        <HumanControlDesk key={scope.key} groups={["growth-native-preparation"]} context={{ workId }} fixedFields={["workId"]}
          writable={!busy && current.view.complete} onRecorded={() => scope.invalidate()} />
      </details>
    </> : null}
    {!workId && companyId && auth.role === "owner" && current ? <details><summary>Open a genuinely new bounded business Work</summary>
      <p>For continuation of existing Work, open that exact Work instead. A new Work does not establish demand or authorize contact.</p>
      <HumanControlDesk key={scope.key} groups={["growth-intake"]} context={{ companyId }} fixedFields={["companyId"]}
        writable={!busy} onRecorded={() => scope.invalidate()} />
    </details> : null}
    {current?.inbox?.protocols.length ? <label>Your own purpose-bound invitation<select value={selected}
      disabled={busy} onChange={event => { setSelected(event.target.value); setProgress(null) }}>
      <option value="">Choose an invitation</option>{current.inbox.protocols.map(p =>
        <option key={p.id} value={p.id}>{p.requestId ? "Operating programme" : "Original evidence"}:
          {" "}{growthLabel(p.role)}, {growthLabel(p.status)}, {p.purpose}</option>)}
    </select></label> : current?.inbox ? <p>No current purpose-bound business invitations are recorded for your identity
      {workId ? " on this original Work" : ""}.</p> : null}
    {protocol ? <article data-w4-protocol-id={protocol.id} data-w4-protocol-state={protocol.status}>
      <h5>{growthLabel(protocol.role)} protocol: {growthLabel(protocol.status)}</h5>
      <p>Purpose: {protocol.purpose}. Expires {new Date(protocol.expiresAt).toLocaleString()}.
        Permitted reports: {protocol.permittedKinds.map(growthLabel).join(", ") || "None currently permitted"}.</p>
      {protocol.disclosure?.offer ? <section aria-label="Exact original commercial terms">
        <p>{protocol.disclosure.offer.disclosure}</p>
        <p>Price per unit: {growthAmount(protocol.disclosure.offer.unitPrice)}.
          Maximum units: {protocol.disclosure.offer.maximumUnits}. Delivery lead: {protocol.disclosure.offer.deliveryLeadHours} hours.</p>
        <p>Claims: {protocol.disclosure.offer.claims.join("; ")}. Exclusions: {protocol.disclosure.offer.exclusions.join("; ")}.</p>
        <p>Support: {protocol.disclosure.offer.supportHours} hours. Warranty: {protocol.disclosure.offer.warranty}.
          Refund terms: {protocol.disclosure.offer.refunds}.</p>
        <small>Exact terms digest: {protocol.disclosure.offer.termsDigest}</small>
      </section> : protocol.disclosure ? <p>This purpose-bound evidence protocol does not grant generic Work access.</p>
        : <p>Operational disclosure cleared. Historical protocol receipt only.</p>}
      <button type="button" disabled={busy || protocol.status !== "INVITED"} onClick={() =>
        void mutate(() => centropyPost("demand-to-business/consent", { protocolId: protocol.id, revoke: false }))}>
        Consent as this participant</button>
      <button type="button" disabled={busy || protocol.status !== "CONSENTED"} onClick={() =>
        void mutate(() => centropyPost("demand-to-business/consent", { protocolId: protocol.id, revoke: true }))}>
        Revoke future consent, retain original obligations</button>
      {currentProgress ? <>
        <p>Original authored reports: {currentProgress.events.length}. These are not independent proof of actual effects.</p>
        <GrowthParticipantControls key={scope.key + ":" + protocol.id} protocol={protocol} progress={currentProgress}
          busy={busy || current?.inbox?.complete !== true} mutate={mutate} evidenceProtocolFor={evidenceProtocolFor} />
      </> : protocol.status === "CONSENTED" ? protocol.requestId
        ? <p>Reading the exact current purpose-bound original evidence…</p>
        : <p>This is original evidence participation, not an accepted commercial offer. Only your registered evidence kinds
          may be recorded through the authenticated original-source interface; this receipt does not expose company Work.</p> : null}
    </article> : null}
  </section>
}
