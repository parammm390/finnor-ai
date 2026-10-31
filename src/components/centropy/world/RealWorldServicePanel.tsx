"use client"

import { useEffect, useRef, useState } from "react"
import { z } from "zod"
import { centropyPost } from "../lib/api"
import { useCentropyAuth } from "../lib/centropy-auth"
import { usePrivateRequestScope } from "../lib/use-private-request-scope"
import { onBusinessInvalidation } from "../lib/business-invalidation"

const id = z.string().uuid()
const instance = z.object({
  instanceId: z.string(), providerId: z.string(), state: z.string(), accepted: z.boolean(), ready: z.boolean(),
  delivered: z.boolean(), inspected: z.boolean(), operationallyComplete: z.boolean(), financiallyReconciled: z.boolean(),
  missingCriteria: z.array(z.string()), contradictions: z.array(z.string()), originalFailures: z.array(z.string()),
}).passthrough()
const projection = z.object({
  originalBusinessAssignments: z.literal(1), instances: z.array(instance).max(2048),
  operationallyComplete: z.boolean(), financiallyReconciled: z.boolean(), fieldValidated: z.literal(false),
  originalFailures: z.array(z.string()), unknownCostCategories: z.array(z.string()),
  unreconciledInvoiceSources: z.array(z.object({
    sourceId: id, versionId: id, contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).max(50000),
}).passthrough()
const viewSchema = z.object({
  scope: z.object({ tenantId: id, principalId: id, workId: id }),
  requests: z.array(z.object({
    requestId: id, status: z.string(), originalDeadlineAt: z.string(),
    artifactDigest: z.string().nullable().optional(), projection: projection.nullable(), gaps: z.array(z.string()),
  }).passthrough()).max(32), complete: z.boolean(), qualification: z.literal("CONTROLLED_DEVELOPMENT_ONLY"),
  admissionGranted: z.literal(false), fieldValidated: z.literal(false),
})
const inboxSchema = z.object({
  scope: z.object({ tenantId: id, principalId: id }), complete: z.boolean(),
  protocols: z.array(z.object({
    id, requestId: id, role: z.string(), purpose: z.string(),
    status: z.enum(["INVITED", "CONSENTED", "REVOKED", "EXPIRED"]), disclosure: z.object({
      scope: z.object({ tenantId: id, principalId: id, companyId: id, workId: id, businessAssignmentId: z.string() }),
    }).passthrough().nullable(),
    permittedKinds: z.array(z.string()), criteria: z.array(z.string()),
    consentAt: z.string().nullable(), revokedAt: z.string().nullable(), expiresAt: z.string().datetime({ offset: true }),
  }).passthrough().transform(protocol => {
    const status = protocol.status === "REVOKED" ? "REVOKED" : Date.parse(protocol.expiresAt) <= Date.now()
      ? "EXPIRED" : protocol.status
    return status === "REVOKED" || status === "EXPIRED"
      ? { ...protocol, status, disclosure: null, permittedKinds: [], criteria: [] } : protocol
  })).max(256),
})
const label = (s: string) => s.replaceAll("_", " ").toLowerCase()
type Stored = { scope: string; view: z.infer<typeof viewSchema> | null; inbox: z.infer<typeof inboxSchema> }
const formOperations = ["intake", "source", "prepare-native", "submit", "invite", "report"] as const
type FormOperation = typeof formOperations[number]
const serviceWrites = {
  intake: (body: unknown) => centropyPost("real-world-services/intake", body),
  source: (body: unknown) => centropyPost("real-world-services/source", body),
  "prepare-native": (body: unknown) => centropyPost("real-world-services/prepare-native", body),
  submit: (body: unknown) => centropyPost("real-world-services/submit", body),
  invite: (body: unknown) => centropyPost("real-world-services/invite", body),
  report: (body: unknown) => centropyPost("real-world-services/report", body),
  consent: (body: unknown) => centropyPost("real-world-services/consent", body),
  advance: (body: unknown) => centropyPost("real-world-services/advance", body),
}

export function RealWorldServicePanel({ workId }: { workId?: string }) {
  const auth = useCentropyAuth()
  const { key: scopeKey, allowed: scopeAllowed, isCurrent, invalidate: invalidateScope } =
    usePrivateRequestScope("real-world-service:" + (workId ?? "my-invitations"))
  const [stored, setStored] = useState<Stored | null>(null), [notice, setNotice] = useState("")
  const [revision, setRevision] = useState(0), [operation, setOperation] = useState<FormOperation>("source")
  const [draft, setDraft] = useState({ scope: scopeKey, value: "" }), [busy, setBusy] = useState(false)
  const writing = useRef(false)
  const mutationRevision = useRef(0)
  const current = scopeAllowed && isCurrent(scopeKey) && stored?.scope === scopeKey ? stored : null
  const currentDraft = scopeAllowed && isCurrent(scopeKey) && draft.scope === scopeKey ? draft.value : ""
  useEffect(() => {
    setDraft({ scope: scopeKey, value: "" }); setStored(null); setNotice(""); writing.current = false; setBusy(false)
  }, [scopeKey])
  useEffect(() => {
    const active = current?.inbox.protocols.filter(p => p.status === "INVITED" || p.status === "CONSENTED") ?? []
    if (!active.length) return
    const remaining = Math.min(...active.map(p => Date.parse(p.expiresAt))) - Date.now()
    const timer = setTimeout(() => {
      if (isCurrent(scopeKey)) { setStored(null); setDraft({ scope: scopeKey, value: "" }); invalidateScope() }
    },
      Math.max(0, Math.min(remaining, 2147483647)))
    return () => clearTimeout(timer)
  }, [current?.inbox.protocols, scopeKey, isCurrent, invalidateScope])
  useEffect(() => {
    let active = true, reading = false
    const key = scopeKey
    const valid = () => active && isCurrent(key)
      && navigator.onLine && document.visibilityState === "visible"
    const refresh = async () => {
      if (!scopeAllowed || !valid() || reading || writing.current) return
      reading = true
      const revisionAtRead = mutationRevision.current
      const readCurrent = () => valid() && !writing.current && revisionAtRead === mutationRevision.current
      try {
        const [work, participant] = await Promise.allSettled([
          workId ? centropyPost("real-world-services/read", { workId }) : Promise.resolve(null),
          centropyPost("real-world-services/inbox", {}),
        ])
        if (!readCurrent()) return
        if (participant.status !== "fulfilled") throw Error("Participant context unavailable")
        const inbox = inboxSchema.parse(participant.value)
        const view = work.status === "fulfilled" && work.value ? viewSchema.parse(work.value) : null
        if (inbox.scope.principalId !== auth.session?.user.id
          || view && (view.scope.workId !== workId || view.scope.principalId !== inbox.scope.principalId
            || view.scope.tenantId !== inbox.scope.tenantId)
          || inbox.protocols.some(p => p.disclosure && p.disclosure.scope.tenantId !== inbox.scope.tenantId))
          throw Error("Private scope changed")
        const scopedInbox = { ...inbox, protocols: inbox.protocols.filter(p => !workId || p.disclosure?.scope.workId === workId) }
        setStored({ scope: key, view, inbox: scopedInbox })
        setNotice(workId && !view ? "Owner Work evidence is unavailable. Only your own purpose-bound invitations are shown." : "")
      } catch { if (readCurrent()) { setStored(null); setNotice("Current authorized service evidence is unavailable. Private output cleared.") } }
      finally { reading = false }
    }
    // Rotate the private generation even for offline → online or hide → show.
    // An earlier response must not resurrect output after either transition.
    const invalidate = () => { setStored(null); setDraft({ scope: key, value: "" }); invalidateScope() }
    const unsubscribe = onBusinessInvalidation(signal => {
      if (!writing.current && signal.tags.some(tag => ["work", "source", "authority", "company-brain"].includes(tag))) invalidate()
    })
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    window.addEventListener("offline", invalidate); window.addEventListener("online", invalidate)
    window.addEventListener("pagehide", invalidate); document.addEventListener("visibilitychange", invalidate)
    return () => {
      active = false; clearInterval(timer); unsubscribe()
      window.removeEventListener("offline", invalidate); window.removeEventListener("online", invalidate)
      window.removeEventListener("pagehide", invalidate); document.removeEventListener("visibilitychange", invalidate)
    }
  }, [scopeKey, scopeAllowed, isCurrent, invalidateScope, workId, auth.session?.user.id, revision])
  const write = async (op: keyof typeof serviceWrites, body: unknown) => {
    if (writing.current || !scopeAllowed || !isCurrent(scopeKey) || !navigator.onLine
      || document.visibilityState !== "visible") return
    const key = scopeKey; writing.current = true; mutationRevision.current++; setBusy(true); setStored(null)
    try {
      await serviceWrites[op](body)
      if (isCurrent(key)) {
        setNotice("Recorded. Re-reading the original Work and remaining responsibility."); setDraft({ scope: key, value: "" }); setRevision(n => n + 1)
      }
    } catch { if (isCurrent(key)) setNotice("No completion is assumed. Re-read original state before retrying an uncertain write.") }
    finally { if (isCurrent(key)) { writing.current = false; setBusy(false) } }
  }
  return <section aria-label="Real-world service fulfilment" data-testid="w3-service-panel"
    data-w3-context={workId ?? "my-invitations"}>
    <h4>Real-world service fulfilment</h4>
    <p>Controlled development only. Commitment, observed delivery, inspection, acceptance and payment are separate. No field qualification or admission.</p>
    {notice ? <p role="status">{notice}</p> : null}
    {current?.view?.requests.map(request => <article key={request.requestId}>
      <strong>{label(request.status)}</strong>
      <p>One original business assignment. Deadline {request.originalDeadlineAt}.</p>
      {request.projection ? <>
        <p>Operationally complete: {String(request.projection.operationallyComplete)}. Financially reconciled: {String(request.projection.financiallyReconciled)}.</p>
        <table><thead><tr><th>Original service</th><th>State</th><th>Missing evidence</th><th>Retained failures</th></tr></thead>
          <tbody>{request.projection.instances.map(item => <tr key={item.instanceId}><td>{item.instanceId}</td>
            <td>{label(item.state)}</td><td>{[...item.missingCriteria, ...item.contradictions].join(", ") || "None in this controlled read"}</td>
            <td>{item.originalFailures.join(", ") || "None recorded"}</td></tr>)}</tbody></table>
        <p>Unknown cost coordinates: {request.projection.unknownCostCategories.join(", ") || "None declared"}.</p>
        <p>Unreconciled original invoices: {request.projection.unreconciledInvoiceSources.length}.</p>
      </> : <p>Checked programme or current evidence is unavailable. No completion is inferred.</p>}
      {request.gaps.length ? <p>{request.gaps.join(", ")}</p> : null}
      <button type="button" disabled={busy || !request.artifactDigest} onClick={() =>
        void write("advance", { requestId: request.requestId, expectedArtifactDigest: request.artifactDigest })}>Revalidate native continuation</button>
    </article>)}
    {current?.inbox.protocols.map(protocol => <details key={protocol.id}
      data-w3-protocol-id={protocol.id} data-w3-protocol-state={protocol.status}><summary>{label(protocol.role)} invitation</summary>
      <p>{protocol.purpose}. {label(protocol.status)}. Expires {protocol.expiresAt}. Permitted reports: {protocol.permittedKinds.join(", ")}.</p>
      {protocol.disclosure ? <>
        <p>Exact company: {protocol.disclosure.scope.companyId}. Work: {protocol.disclosure.scope.workId}.</p>
        <pre>{JSON.stringify(protocol.disclosure, null, 2)}</pre>
      </> : <p>Operational disclosure is unavailable. Historical protocol receipt only.</p>}
      <button type="button" disabled={busy || protocol.status !== "INVITED"}
        onClick={() => void write("consent", { protocolId: protocol.id, revoke: false })}>Consent as this participant</button>
      <button type="button" disabled={busy || protocol.status !== "CONSENTED"}
        onClick={() => void write("consent", { protocolId: protocol.id, revoke: true })}>Revoke my consent</button>
      <p>Protocol reference: {protocol.id}. Reports establish authorship, not sensory or professional truth.</p>
    </details>)}
    <details><summary>Submit an explicit service original or participant report</summary>
      <p>Reads never start procurement. Supply exact original references and terms. Do not include prohibited or unnecessary personal data.</p>
      <label>Operation <select value={operation} onChange={e => setOperation(z.enum(formOperations).parse(e.target.value))} disabled={busy}>
        {formOperations.map(op => <option key={op} value={op}>{op}</option>)}</select></label>
      <label>Purpose-bound request JSON <textarea aria-label="Service request JSON" value={currentDraft}
        onChange={e => setDraft({ scope: scopeKey, value: e.target.value })}
        maxLength={262144} disabled={busy || !scopeAllowed} /></label>
      <button type="button" disabled={busy || !scopeAllowed || !currentDraft.trim()} onClick={() => {
        try { void write(operation, JSON.parse(currentDraft)) } catch { setNotice("Enter valid purpose-bound JSON. Nothing was submitted.") }
      }}>Submit explicit request</button>
    </details>
  </section>
}
