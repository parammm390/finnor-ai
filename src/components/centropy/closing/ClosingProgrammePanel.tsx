"use client"

import { lazy, Suspense, useEffect, useState } from "react"
import { RefreshCw } from "lucide-react"
import { centropyPost } from "@/components/centropy/lib/api"
import { onBusinessInvalidation } from "@/components/centropy/lib/business-invalidation"
import type { ClosingMoney, ClosingProjection } from "../../../../finnor-os/packages/shared-types/src/closing"

const HumanControlDesk = lazy(() => import("../controls/HumanControlDesk").then(module => ({ default: module.HumanControlDesk })))
const words = (value: string) => value.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").toLowerCase()
const money = (value: ClosingMoney) => `${value.amount} ${value.currency} · exact ${value.unit} · ${value.timeBasis.toLowerCase()} · ${value.asOf}`
const currentAt = (q: ClosingProjection, now: number): ClosingProjection => ({
  ...q,
  checkCurrent: q.checkCurrent && Date.parse(q.check?.validUntil ?? "") > now,
  certificate: q.certificate ? { ...q.certificate,
    currentlyValid: q.certificate.currentlyValid && Date.parse(q.certificate.body.validityAndSupersession.validUntil) > now,
  } : q.certificate,
})
const conjunctionLabels: Record<string, string> = {
  executedDocuments: "Approved documents executed by exact role-bound signers",
  conditionsSatisfiedOrValidlyWaived: "Conditions satisfied or exactly waived",
  receivingSettlement: "Receiving settlement established",
  rightsTransfer: "Rights transferred",
  legalEffectiveness: "Legal effectiveness and filings established",
  noUnreconciledMaterialExposure: "No unreconciled material exposure",
  continuingDutiesHandedOff: "Continuing duties canonically owned",
}

export function ClosingProgrammePanel({ workId, transactionId, onChanged }: { workId?: string; transactionId?: string; onChanged?: () => void }) {
  const [programmes, setProgrammes] = useState<ClosingProjection[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const [controls, setControls] = useState(false)
  const [selected, setSelected] = useState("")
  const refresh = () => setRevision(value => value + 1)

  useEffect(() => onBusinessInvalidation(event => {
    if (event.tags.some(tag => ["closing", "work", "company-brain", "authority", "objective"].includes(tag))) {
      setProgrammes(null); setRevision(value => value + 1)
    }
  }), [])
  useEffect(() => {
    let active = true
    setProgrammes(null); setError(null); setLoading(true)
    void centropyPost<{ programmes: ClosingProjection[] }>("closing/projection", {
      ...(workId ? { workId } : {}), ...(transactionId ? { transactionId } : {}),
    }).then(result => {
      if (!Array.isArray(result.programmes) || result.programmes.some(q => q.schema !== "finnor.v3.closing-projection.v1"
        || workId && q.workId !== workId || transactionId && q.transactionId !== transactionId)) {
        throw new Error("Closing projection did not match the exact selected Work or Deal")
      }
      if (active) setProgrammes(result.programmes.map(q => currentAt(q, Date.now())))
    }).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : "Closing projection unavailable") })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [workId, transactionId, revision])
  useEffect(() => {
    const deadlines = (programmes ?? []).flatMap(q => [
      ...(q.checkCurrent && q.check ? [Date.parse(q.check.validUntil)] : []),
      ...(q.certificate?.currentlyValid ? [Date.parse(q.certificate.body.validityAndSupersession.validUntil)] : []),
    ]).filter(Number.isFinite)
    if (!deadlines.length) return
    const deadline = Math.min(...deadlines)
    let timer: ReturnType<typeof setTimeout> | undefined
    const recheck = () => {
      const remaining = deadline - Date.now()
      if (remaining > 0) { timer = setTimeout(recheck, Math.min(remaining, 2147483647)); return }
      setProgrammes(current => current?.map(q => currentAt(q, Date.now())) ?? null)
      setRevision(value => value + 1)
    }
    recheck()
    return () => clearTimeout(timer)
  }, [programmes])

  const q = programmes?.find(item => item.programmeId === selected) ?? programmes?.[0]
  return <section className="ct-world-work ct-closing" aria-label="Verified transaction closing">
    <div className="ct-world-work__top"><div><h4>Verified transaction closing</h4><p>Signature, acknowledgement and a completed checklist are not a verified close.</p></div><button type="button" aria-label="Refresh closing proof" disabled={loading} onClick={refresh}><RefreshCw size={15} /></button></div>
    {loading ? <p role="status">Reading canonical closing currentness…</p> : null}
    {error ? <p className="ct-world__error" role="alert">{error} <button type="button" onClick={refresh}>Retry</button></p> : null}
    {programmes?.length === 0 ? <p>No legally accepted ClosingSpec is registered for this exact record. Verified close is not established.</p> : null}
    {programmes && programmes.length > 1 ? <label>Closing history<select value={q?.programmeId} onChange={event => setSelected(event.target.value)}>{programmes.map(item => <option key={item.programmeId} value={item.programmeId}>{item.status} · {item.specDigest.slice(0, 12)}</option>)}</select></label> : null}
    {q ? <>
      <div className="ct-world-work__metrics"><div><span>Current disposition</span><strong data-closing-status={q.status}>{q.status}</strong></div><div><span>Evidence environment</span><strong>{q.environment}</strong></div><div><span>Independent check</span><strong>{q.checkCurrent ? "Current" : "Pending or stale"}</strong></div></div>
      <p>Approved terms · {q.approvedTermsRevision}</p><p className="ct-world-work__caveat">{q.environment !== "LIVE" ? "Excluded from live counts. " : ""}Protected admission · {q.qualification.protectedAdmission}. Economic gain is not established. Costs are unmetered, not zero. Financing principal is not profit.</p>
      {q.reason ? <p role="status">{words(q.reason)}</p> : null}
      <h4>Independent close conjunction</h4>
      <ul>{Object.entries(conjunctionLabels).map(([key, title]) => <li key={key}><strong>{q.checkCurrent ? q.check?.closeConjunction[key as keyof NonNullable<ClosingProjection["check"]>["closeConjunction"]] ? "Established" : "Not established" : "Not currently established"}</strong> · {title}</li>)}</ul>
      {q.pendingPredicates.length ? <details open><summary>Pending or rejected predicates</summary><ul>{q.pendingPredicates.map((reason, index) => <li key={`${reason}:${index}`}>{words(reason)}</li>)}</ul></details> : null}
      <h4>Retained financial and external exposure</h4>
      {q.unresolvedEffects.length ? <ul>{q.unresolvedEffects.map(effect => <li key={effect.operationId}><strong>{effect.status}</strong> · {effect.nodeKey}{effect.money ? <p>{money(effect.money)}</p> : null}<p>Original operation · {effect.operationId}. Reservation retained. Repeat effect is not permitted.</p></li>)}</ul> : <p>{q.checkCurrent ? "No unreconciled material effect in the current independent check." : "No unresolved effect returned. This does not establish current close sufficiency."}</p>}
      <h4>Continuing duties and liabilities</h4>
      {q.continuingDuties.length ? <ul>{q.continuingDuties.map(duty => <li key={duty.taskId}><strong>{duty.key}</strong> · {words(duty.taskStatus)}<p>Owner · {duty.ownerPrincipalId}. Due · {duty.dueAt}. Canonical task · {duty.taskId}.</p>{duty.liability ? <p>Retained liability · {money(duty.liability)}</p> : null}</li>)}</ul> : <p>No canonical duty handoff returned.</p>}
      <details><summary>Exact original terms, money and graph</summary><p>Spec digest · {q.specDigest}</p><p>Original Work · {q.workId}. Input · {q.workInputId}. Selected Plan · {q.planRevisionId ?? "Pending"}.</p>{q.spec.documents.map(document => <p key={document.key}>Approved document · {document.key} · version {document.documentVersionId} · digest {document.documentDigest}</p>)}{q.spec.funding.map(funding => <p key={funding.key}>Funding · {funding.key} · {funding.sourceClass} · {money(funding.money)}</p>)}{q.spec.fundsFlows.map(flow => <p key={flow.key}>Funds flow · {flow.key} · {money(flow.money)} · receiving entity {flow.receivingEntityId}</p>)}<ul>{q.graph.nodes.map(node => <li key={node.key}>{node.key} · {node.kind} · depends on {node.dependsOn.join(", ") || "no predecessor"}{node.irreversible ? " · irreversible boundary" : ""}</li>)}</ul></details>
      {q.certificate ? <details><summary>{q.certificate.currentlyValid ? "Current verified close certificate" : "Historical certificate, not presently sufficient"}</summary><p>Certificate · {q.certificate.id}. Historical bytes are immutable.</p><p>Independent check · {q.certificate.body.receiptAndCurrentness.checkId}</p><p>Checker digest · {q.certificate.body.receiptAndCurrentness.checkerDigest}</p><p>Valid until · {q.certificate.body.validityAndSupersession.validUntil}</p></details> : <p>No VerifiedClosedTransaction certificate has been issued.</p>}
      {q.nativeBudget ? <p>Original finite grant · {q.nativeBudget.stepCount}/{q.nativeBudget.maxSteps} steps, {q.nativeBudget.actionCount}/{q.nativeBudget.maxActions} actions, {q.nativeBudget.queryCount}/{q.nativeBudget.maxQueries} queries. Deadline · {q.nativeBudget.deadlineAt}.</p> : null}
    </> : null}
    <details className="ct-record-controls" onToggle={event => setControls(event.currentTarget.open)}><summary>Review accepted closing intake, signed evidence or retained controls</summary><p>Stopping does not erase an accepted draw, wire or liability. Continuing never resets the original grant. Only an independently signed observation can satisfy a professional predicate.</p>{controls ? <Suspense fallback={<p>Opening authenticated closing controls…</p>}><HumanControlDesk key={q?.programmeId ?? transactionId ?? workId} groups={["closing-programmes"]} context={{ programmeId: q?.programmeId }} fixedFields={["programmeId"]} writable={!loading && !error} onRecorded={() => { refresh(); onChanged?.() }} /></Suspense> : null}</details>
  </section>
}
