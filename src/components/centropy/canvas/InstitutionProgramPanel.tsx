"use client"

import { useCallback, useEffect, useState } from "react"
import { centropyPost } from "../lib/api"
import { usePrivateRequestScope } from "../lib/use-private-request-scope"
import { InstitutionInputForm } from "./InstitutionInputForm"

type Binding = { status: "known"; ref: string; revision: string; owner: string; digest: string }
  | { status: "unknown"; reason: string; requiredOwnerOrInput: string; affectedRefs: string[] }
type Claim = { statement: string; witnessRefs: string[]; reason?: string; requiredOwnerOrInput?: string;alternatives?:string[] }
type Artifact = { envelope: { artifact_id: string; observed_claims: Claim[]; inferred_claims: Claim[];
  unresolved_claims: Claim[]; knowledge_cut: string; content_digest: string };
  mandate_ref: Binding; canonical_entity_and_relation_refs: Binding[];
  unresolved_interpretations: Claim[]; temporal_and_unit_constraints: Array<{ disposition: string;
    quantity?: { decimal: string; currency: string; unit: string; period: string; accountingBasis: string } }>;
  obligation_derivation_rules: Array<{ stableIdentity: string; permissibleOperationClass: string;
    originalDeadline: string; materiality: string; triggeringEvidence: Binding[]; normativeRule: Binding }> }
type Read = { requestId: string; workId: string; workRevision: string; revision: number; status: string;
  reason?: string | null; canResume?: boolean; artifact: Artifact | null;
  programme: null | { status: string; program: null | { nodes: Array<{ stableIdentity: string;
    operation: string; deadlineAt: string; action: unknown | null }>;
    observedPostconditions: Array<{ stableIdentity: string; canonicalRef: string; observerDigest: string }>;
    interventions?: Array<{ stableIdentity: string; predicate: string; possibleEffect: boolean }> } };
  costs: { acquisitionCalls: number; compilerAttempts: number; originalDeadline: string;
    coordinationCalls?: number;
    physicalCompute?: { registeredDeliveryPhases: number; attributedElapsedMs: number;
      phases: Record<string, { deliveries: number; attributedElapsedMs: number }>;
      gaps: string[]; meterGapEvents: unknown[]; recordRefs: unknown[] };
    monetaryCostStatus: string; monetaryCost: number | null; humanSeconds: number | null } }
type Sources = { workId: string; workInputId: string | null;
  grants: Array<{ id: string; source_id: string; source_class: string; revision: string }>;
  request: { id: string; status: string; revision: number } | null }
const date = (value: string) => new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
const operation = (value: string) => ({ create_deal_request: "Create evidence Request",
  open_workstream: "Open Workstream", record_finding: "Record Finding" } as Record<string, string>)[value] ?? value.replaceAll("_", " ")
const intervention = (reason: string) => ({
  X1_FUTURE_CONTINUATION_CANCELLED: "Future continuation is stopped. Existing effects and incurred resources remain recorded.",
  X1_RULE_MEANING_UNSUPPORTED: "A condition in the standing responsibility needs an explicit interpretation before its dependent commitment can proceed.",
  X1_COMPLETION_CONTRACT_NOT_REGISTERED: "Choose an established completion contract. Request creation cannot establish evidence fulfillment, approval or settlement.",
  X1_CURRENT_MANDATE_UNAVAILABLE: "A current standing responsibility is missing for this Work.",
  X1_EXACT_REQUEST_RECIPIENT_TEXT_AND_ACCEPTANCE_RULE_REQUIRED: "Specify the evidence recipient, request text and deliverable acceptance rule in the source or standing responsibility.",
  X1_EXACT_ACTIVE_WORKSTREAM_REFERENCE_REQUIRED: "Identify one active Workstream by its stable source identifier or kind.",
  X1_WORKSTREAM_KIND_AND_NAME_REQUIRED_FROM_SOURCE_OR_MANDATE: "Specify the Workstream kind and name in the source or standing responsibility.",
  X1_FINDING_STATEMENT_SEVERITY_AND_COMPLETION_RULE_REQUIRED: "Specify the Finding statement, severity and completion rule.",
  X1_ORIGINAL_EFFECT_INTENT_CONFLICT_REQUIRES_DECISION: "An earlier effect exists with a different intent. Inspect it and decide how to correct it before another commitment.",
} as Record<string, string>)[reason] ?? reason.replace(/^X1_/, "").replaceAll("_", " ").toLowerCase()

export function InstitutionProgramPanel({ workId }: { workId: string }) {
  const { key: scopeKey, isCurrent, allowed } = usePrivateRequestScope(workId)
  const [sources, setSources] = useState<{ key: string; value: Sources } | null>(null)
  const [reading, setReading] = useState<{ key: string; value: Read } | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [configure, setConfigure] = useState(false)
  const visibleSources = allowed && sources?.key === scopeKey ? sources.value : null
  const visible = allowed && reading?.key === scopeKey ? reading.value : null
  const refresh = useCallback(async () => {
    const key = scopeKey
    if (!allowed) return
    try {
      const next = await centropyPost<Sources>("company-brain/institution-sources", { workId })
      if (!isCurrent(key)) return
      if (next.workId !== workId) throw Error("Responsibility sources returned another Work")
      setSources({ key, value: next })
      if (next.request) {
        const result = await centropyPost<Read>("company-brain/institution-read", { requestId: next.request.id })
        if (!isCurrent(key)) return
        if (result.workId !== workId) throw Error("Responsibility returned another Work")
        setReading({ key, value: result })
      } else setReading(null)
      setMessage(null)
    } catch (error) {
      if (!isCurrent(key)) return
      setSources(null); setReading(null)
      setMessage(error instanceof Error ? error.message : "Responsibility is unavailable in this scope")
    }
  }, [allowed, isCurrent, scopeKey, workId])
  useEffect(() => {
    setSources(null); setReading(null); setMessage(null); setBusy(false); setConfigure(false)
    void refresh()
  }, [refresh])
  useEffect(() => {
    if (!visibleSources?.request || visible?.status === "CANCELLED") return
    const active = ["QUEUED", "RUNNING", "WAITING"].includes(visible?.status ?? "")
    const timer = window.setTimeout(() => void refresh(), active ? 3000 : 15000)
    return () => window.clearTimeout(timer)
  }, [refresh, visible, visibleSources])

  async function compile() {
    const key = scopeKey, metadata = visibleSources
    if (!metadata?.workInputId || !metadata.grants.length || metadata.grants.length > 16 || busy) return
    setBusy(true); setMessage("Reconstructing authorized sources against the standing responsibility…")
    try {
      await centropyPost(`company-brain/${metadata.request ? "institution-revise" : "institution-submit"}`, {
        workId, workInputId: metadata.workInputId, grantIds: metadata.grants.map(g => g.id),
        idempotencyKey: `institution:${crypto.randomUUID()}`,
        ...(metadata.request ? { parentRequestId: metadata.request.id } : {}),
      })
      if (isCurrent(key)) await refresh()
    } catch (error) {
      if (isCurrent(key)) { setReading(null); setMessage(error instanceof Error ? error.message : "Responsibility submission is uncertain; refresh to reconcile it") }
    } finally { if (isCurrent(key)) setBusy(false) }
  }
  async function control(command: "cancel" | "resume") {
    const key = scopeKey, requestId = visible?.requestId
    if (!requestId || busy) return
    setBusy(true)
    try {
      await centropyPost(`company-brain/institution-${command}`, { requestId })
      if (isCurrent(key)) await refresh()
    } catch (error) {
      if (isCurrent(key)) { setReading(null); setMessage(error instanceof Error ? error.message : "Continuation is uncertain; refresh its owner state") }
    } finally { if (isCurrent(key)) setBusy(false) }
  }
  if (!allowed) return null
  const artifact = visible?.artifact, program = visible?.programme?.program
  const observed = new Map(program?.observedPostconditions.map(p => [p.stableIdentity, p]) ?? [])
  return <section className="ct-canvas-block ct-institution" aria-label="Institution responsibility">
    <header><div><span className="ct-eyebrow">STANDING RESPONSIBILITY</span><h3>Institution programme</h3></div>
      <button type="button" onClick={() => void refresh()} disabled={busy}>Refresh current owners</button></header>
    <p>Compile this Work’s authorized sources into checked responsibilities and continue the permitted operations.</p>
    <button type="button" onClick={() => setConfigure(value => !value)} disabled={busy}>{configure ? "Close input configuration" : "Configure responsibility inputs"}</button>
    {configure ? <InstitutionInputForm key={scopeKey} workId={workId} onSaved={async () => { if (isCurrent(scopeKey)) await refresh() }} /> : null}
    <div className="ct-evidence__actions"><button type="button" disabled={busy || !visibleSources?.workInputId
      || !visibleSources.grants.length || visibleSources.grants.length > 16
      || ["QUEUED", "RUNNING", "CANCELLED"].includes(visible?.status ?? "")}
      onClick={() => void compile()}>{visibleSources?.request ? "Recompile under the original budget" : "Compile standing responsibility"}</button>
      {visible?.canResume ? <button type="button" disabled={busy} onClick={() => void control("resume")}>Resume retained continuation</button> : null}
      {visible && visible.status !== "CANCELLED"
        ? <button type="button" disabled={busy} onClick={() => void control("cancel")}>Cancel future continuation</button> : null}</div>
    <p role="status" aria-live="polite">{message ?? (visible ? `Revision ${visible.revision} · ${visible.status.toLowerCase()}`
      : visibleSources?.grants.length ? `${visibleSources.grants.length} current source bindings` : "Attach authorized sources and a standing responsibility to this Work.")}</p>
    {visible?.status === "INVALIDATED" ? <p role="alert">The previous assumptions are invalid. Current readiness has been withdrawn; prior effects and costs remain retained.</p> : null}
    {visible?.reason ? <p>{intervention(visible.reason)}</p> : null}
    {artifact ? <>
      <dl className="ct-evidence__values"><div><dt>Observed originals</dt><dd>{artifact.envelope.observed_claims.length}</dd></div>
        <div><dt>Inferred mappings</dt><dd>{artifact.envelope.inferred_claims.length}</dd></div>
        <div><dt>Unresolved interpretations</dt><dd>{artifact.unresolved_interpretations.length}</dd></div></dl>
      <div className="ct-institution__table"><table><caption>Responsibilities and independent completion</caption>
        <thead><tr><th scope="col">Responsibility</th><th scope="col">Deadline</th><th scope="col">State</th></tr></thead>
        <tbody>{artifact.obligation_derivation_rules.map(duty => <tr key={duty.stableIdentity}>
          <td>{operation(duty.permissibleOperationClass)} · {duty.materiality}</td><td>{date(duty.originalDeadline)}</td>
          <td>{observed.has(duty.stableIdentity) ? "Independently observed creation"
            : program?.nodes.find(n => n.stableIdentity === duty.stableIdentity)?.action ? "Prepared intent; awaiting observation" : "Exact decision required"}</td></tr>)}</tbody></table></div>
      {artifact.temporal_and_unit_constraints.length ? <details><summary>Amounts, periods and contradictions</summary>
        {artifact.temporal_and_unit_constraints.map((item, index) => <p key={index}>{item.quantity
          ? `${item.quantity.decimal} ${item.quantity.currency} · ${item.quantity.unit} · ${item.quantity.period} · ${item.quantity.accountingBasis}` : "Temporal constraint"} · {item.disposition}</p>)}</details> : null}
      {artifact.unresolved_interpretations.length ? <div><h4>Required interpretation or authority</h4><ul>{artifact.unresolved_interpretations.map((gap, i) =>
        <li key={i}>{intervention(gap.reason ?? gap.statement)} <span>{gap.requiredOwnerOrInput}</span>
          {gap.alternatives?.length ? <p>{gap.alternatives.map(choice => choice.replace(/([a-z])([A-Z])/g, "$1 $2")).join("; ")}</p> : null}</li>)}</ul></div> : null}
      {program?.interventions?.map(item => <p key={item.stableIdentity} role="alert">{intervention(item.predicate)} {item.possibleEffect ? "A possible prior effect remains retained." : ""}</p>)}
      <details><summary>Evidence witnesses and current revision</summary><p>Knowledge cut {date(artifact.envelope.knowledge_cut)}</p>
        <pre>{JSON.stringify({ mandate: artifact.mandate_ref, canonical: artifact.canonical_entity_and_relation_refs,
          observed: artifact.envelope.observed_claims, inferred: artifact.envelope.inferred_claims,
          responsibilities: artifact.obligation_derivation_rules, completion: program?.observedPostconditions ?? [],
          revisionDigest: artifact.envelope.content_digest }, null, 2)}</pre></details>
    </> : null}
    {visible ? <p>Original deadline {date(visible.costs.originalDeadline)}. {visible.costs.compilerAttempts} compiler attempts and {visible.costs.acquisitionCalls} acquisition units retained. Monetary cost and human supervision remain unknown. Cancellation retains possible effects and resource exposure.</p> : null}
    {visible?.costs.physicalCompute ? <details><summary>Recorded compute and cost gaps</summary>
      <p>{visible.costs.physicalCompute.registeredDeliveryPhases} saved compute measurements account for {(visible.costs.physicalCompute.attributedElapsedMs / 1000).toFixed(1)} seconds of attributed work. These measurements cover recorded attempts; full cost and aggregate memory remain unknown.</p>
      {visible.costs.physicalCompute.gaps.length || visible.costs.physicalCompute.meterGapEvents.length
        ? <p role="alert">Some compute attribution is missing or incomplete. Inspect the retained cost witnesses before comparing total cost.</p> : null}
      <pre>{JSON.stringify(visible.costs.physicalCompute, null, 2)}</pre>
    </details> : null}
  </section>
}
