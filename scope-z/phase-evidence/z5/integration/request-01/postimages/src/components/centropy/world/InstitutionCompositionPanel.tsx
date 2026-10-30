"use client"

import { useEffect, useState } from "react"
import { centropyPost, CentropyApiError } from "@/components/centropy/lib/api"
import { usePrivateRequestScope } from "../lib/use-private-request-scope"
import type { PeWorldRootRef } from "../pe/contracts"

type Ref = { owner: string; id: string; version: string; contentDigest: string }
type Link = {
  requestId: string; workId: string; root: PeWorldRootRef; status: string; current: boolean; mayUse: boolean
  artifactDigest: string | null; profileRef: Ref; admission: { ref: Ref; nativeS8Reference: Ref } | null
  sourceDigest: string; liveDigest: string; originalDeadline: string; originalReservation: Ref; obligations: Ref[]
  gates: Record<string, string>; attempts: { id: string; claim_fence: number; charge_ref: Ref | null }[]
  events: { kind: string }[]; eventsComplete: boolean
  artifact: null | {
    ref: Ref
    envelopeProjection: { sourceCommit: string; sourceTree: string; gaps: string[]; supportedDomain: string
      producerBuildIdentity: { installedBuildId: string | null }; costAndResourceReceiptReferences: Ref[] }
    certificate: {
      disposition: string; reasons: string[]; correspondence: string; discharge: { initial: number; componentTransitions: number; environmentTransitions: number; noncircular: boolean }
      original: { states: number; transitions: number; initial: number }
      context: null | { conditionality: string; maximality: string; stateCount: number; edgeCount: number }
      replacement: null | { status: string; component: string | null; revision: string | null; reasons: string[]; preorder: string; bridge: unknown }
      originalCounterexample: null | { kind: string; initial: string; steps: { label: string; from: string; to: string }[]; final: string }
      costs: { operations: number; wallMs: number; peakRssBytes: number; money: null; human: null; gaps: string[] }
    }
  }
}
type Projection = { workId: string; root: PeWorldRootRef; requests: Link[]; complete: boolean }
const parse = (text: string): Record<string, unknown> => {
  if (text.length > 65536) throw Error("Reference input exceeds 64 KiB")
  const body: unknown = JSON.parse(text)
  if (!body || typeof body !== "object" || Array.isArray(body)) throw Error("Supply a JSON object containing existing native references")
  return body as Record<string, unknown>
}
export function InstitutionCompositionPanel({ workId, root }: { workId: string; root: PeWorldRootRef }) {
  const scope = usePrivateRequestScope(JSON.stringify(["institution-composition", workId, root.entityType, root.entityId]))
  const [stored, setStored] = useState<{ scope: string; value: Projection } | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0), [requestText, setRequestText] = useState(""), [profileText, setProfileText] = useState("")
  const value = scope.allowed && stored?.scope === scope.key ? stored.value : null
  useEffect(() => {
    let active = true
    const key = scope.key
    setStored(null); setError(null); setBusy(false)
    if (!scope.allowed) return
    void centropyPost<Projection>("company-brain/institution-link-projection", { workId, root }).then(result => {
      if (result.workId !== workId || result.root.entityType !== root.entityType || result.root.entityId !== root.entityId)
        throw Error("The institution composition did not match this original Work and root")
      if (active && scope.isCurrent(key)) setStored({ scope: key, value: result })
    }).catch(cause => {
      if (active && scope.isCurrent(key)) setError(cause instanceof CentropyApiError
        && (cause.details as { code?: string } | undefined)?.code === "Z5_ORDINARY_DEVELOPMENT_PROFILE_REQUIRED"
        ? "Ordinary-development composition is not enabled. No installed or protected qualification is claimed."
        : "The current permitted institution composition is unavailable. No stored result may be used.")
    })
    return () => { active = false }
  }, [workId, root, revision, scope.allowed, scope.key, scope.isCurrent])
  useEffect(() => { setRequestText(""); setProfileText("") }, [scope.key])
  async function act(operation: string, input: Record<string, unknown>) {
    const key = scope.key
    if (!scope.allowed || !scope.isCurrent(key) || busy) return
    setBusy(true); setError(null); setStored(null)
    try {
      await centropyPost("company-brain/" + operation, { ...input, workId, root })
      if (scope.isCurrent(key)) setRevision(n => n + 1)
    } catch {
      if (scope.isCurrent(key)) setError("The original owner refused or could not finish this action. Reload before retrying. Old obligations and committed costs remain.")
    } finally { if (scope.isCurrent(key)) setBusy(false) }
  }
  async function submit() {
    try {
      const body = parse(requestText)
      if (!body.idempotencyKey) body.idempotencyKey = crypto.randomUUID()
      setRequestText(JSON.stringify(body, null, 2))
      await act("institution-link-submit", body)
    } catch { setError("Supply strict existing owner references, original reservation, responsibility and deadline. No new Work or allowance is created.") }
  }
  return <section role="region" aria-label="Institution composition" data-work-id={workId} className="ct-world-work__section">
    <h4>Institution composition</h4>
    <p>Fixed, separately admitted finite components only. A checked compatible context is conditional, not maximally permissive, inevitable, protected or a financial action.</p>
    <p>Old S6 obligations, UNKNOWN, original S5 reservation and remaining deadline survive replacement, cancellation and recovery.</p>
    <button type="button" disabled={!scope.allowed || busy} onClick={() => setRevision(n => n + 1)}>Reload composition</button>
    {busy ? <p role="status">Waiting for the original owner. A timeout does not undo a debit.</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {value?.requests.length === 0 ? <p>No composition request is recorded for this exact Work.</p> : null}
    {value?.complete === false ? <p>This bounded projection is incomplete. Missing rows are not success.</p> : null}
    {value?.requests.map(row => <article key={row.requestId} data-request-id={row.requestId}>
      <h5>{row.status}, {row.current ? "current original owner cut" : "stale or unavailable, do not reuse"}</h5>
      <dl><dt>Original request</dt><dd>{row.requestId}</dd><dt>Artifact digest</dt><dd>{row.artifactDigest ?? "Not produced"}</dd>
        <dt>Source digest</dt><dd>{row.sourceDigest}</dd><dt>Live state digest</dt><dd>{row.liveDigest}</dd>
        <dt>Original deadline</dt><dd><time dateTime={row.originalDeadline}>{row.originalDeadline}</time></dd>
        <dt>Original reservation</dt><dd>{row.originalReservation.id}</dd><dt>Carried obligations</dt><dd>{row.obligations.length}, no release inferred</dd></dl>
      {row.artifact ? <>
        <p>{row.artifact.certificate.disposition}. {row.artifact.certificate.reasons.join(", ")}</p>
        <p>Original product: {row.artifact.certificate.original.states} states, {row.artifact.certificate.original.transitions} transitions.
          Discharge: {row.artifact.certificate.discharge.initial} initial tuples, {row.artifact.certificate.discharge.componentTransitions} component transitions.
          Noncircular: {String(row.artifact.certificate.discharge.noncircular)}.</p>
        <p>{row.artifact.certificate.context?.conditionality ?? "No compatible context"}
          {row.artifact.certificate.context ? ` Context: ${row.artifact.certificate.context.stateCount} states, ${row.artifact.certificate.context.edgeCount} edges. ${row.artifact.certificate.context.maximality}.` : ""}</p>
        <p>Replacement: {row.artifact.certificate.replacement?.status ?? "Not certified"}.
          {row.artifact.certificate.replacement?.reasons.join(", ")} Old component is retained or stopped if no actual-live bridge exists.</p>
        {row.artifact.certificate.originalCounterexample ? <details><summary>Original coupled counterexample</summary>
          <p>{row.artifact.certificate.originalCounterexample.kind}</p>
          <ol>{row.artifact.certificate.originalCounterexample.steps.map((step, i) => <li key={i}>{step.label}: {step.from} to {step.to}</li>)}</ol>
        </details> : null}
        <p>Commit {row.artifact.envelopeProjection.sourceCommit}; tree {row.artifact.envelopeProjection.sourceTree};
          installed build {row.artifact.envelopeProjection.producerBuildIdentity.installedBuildId ?? "not established"}.</p>
        <p>Observed producer cost: {row.artifact.certificate.costs.operations} operations, {Math.round(row.artifact.certificate.costs.wallMs)} ms.
          Money, human, extraction, integration and installed costs remain unmetered. Failed and interrupted work is not free.</p>
        <p>{row.artifact.envelopeProjection.gaps.join("; ")} Full proof remains immutable; this is a bounded display.</p>
      </> : null}
      <p>S8: {row.admission ? `Original ordinary S8 reference ${row.admission.nativeS8Reference.id}` : "No current native S8 admission"}. No protected admission or production activation.</p>
      <p>Physical attempts: {row.attempts.length}; original S4 planning consumptions:
        {row.events.filter(e => e.kind === "S4_ORIGINAL_COMPOSITION_PLAN_CONSUMED" || e.kind === "S4_ORIGINAL_HANDOFF_CONTRACT_CONSUMED").length}.
        A stored selection alone is not original S4 consumption.</p>
      {!row.eventsComplete ? <p>The displayed event history is incomplete.</p> : null}
      <ul>{Object.entries(row.gates).map(([gate, state]) => <li key={gate}>{gate}: {state}</li>)}</ul>
      <button type="button" disabled={busy || !row.mayUse || Boolean(row.admission)} onClick={() => void act("institution-link-admit", { requestId: row.requestId })}>Request original S8 check</button>
      <button type="button" disabled={busy || !row.mayUse || !row.admission} onClick={() => void act("institution-link-use", { requestId: row.requestId, artifactDigest: row.artifactDigest, idempotencyKey: "mounted-plan:" + row.requestId })}>Select declared contract for S4 planning</button>
      <button type="button" disabled={busy || row.status === "CANCELLED"} onClick={() => void act("institution-link-cancel", { requestId: row.requestId })}>Cancel future linking, retain liabilities</button>
      <button type="button" disabled={busy || row.status === "REVOKED"} onClick={() => void act("institution-contract-revoke", { profileRef: row.profileRef, reason: "OWNER_REQUESTED_REVOKE" })}>Revoke this fixed contract</button>
    </article>)}
    {scope.allowed ? <details><summary>Link existing native component contracts</summary>
      <p>Use only references from the original Work. This form cannot create a mandate, assignment, reservation, component admission or signer. Every physical retry uses the original remaining allowance.</p>
      <label>Existing S8 profile source reference (JSON)<textarea maxLength={65536} value={profileText} onChange={e => setProfileText(e.target.value)} /></label>
      <button type="button" disabled={busy} onClick={() => { try { void act("institution-contract-register", { sourceRef: parse(profileText) }) } catch { setError("Supply an existing authenticated S8 profile reference.") } }}>Register existing S8 profile</button>
      <label>Original owner link request (JSON)<textarea maxLength={65536} value={requestText} onChange={e => setRequestText(e.target.value)} /></label>
      <button type="button" disabled={busy} onClick={() => void submit()}>Submit fixed-component link</button>
    </details> : null}
  </section>
}
