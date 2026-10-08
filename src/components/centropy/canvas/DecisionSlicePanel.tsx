"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { centropyPost as jarvisPost, CentropyApiError as JarvisApiError } from "@/components/centropy/lib/api"
import { useCentropyAuth as useJarvisAuth } from "@/components/centropy/lib/centropy-auth"
import {
  DecisionSliceRefSchema, DecisionSliceViewSchema, DecisionContextViewSchema, DecisionWitnessViewSchema, P4InputBindingViewSchema,
  type DecisionSliceView, type DecisionSliceRef, type DecisionContextView, type DecisionWitnessView,
} from "./decision-slice-view"
import "./decision-slice.css"

type RecordView = { scope: string; slice: DecisionSliceView; context: DecisionContextView }
type P4Inputs = Record<string, { derivationId: string; output: string }>
type ScopedP4Inputs = { scope: string; inputs: P4Inputs }
const sameRef = (left: DecisionSliceRef, right: DecisionSliceRef) => left.id === right.id && left.contentDigest === right.contentDigest && left.version === right.version

export function DecisionSlicePanel({ workId, investmentCaseId, modelVersionId, scenarioIds = [], writable, onRefresh }: {
  workId: string | null; investmentCaseId: string; modelVersionId: string | null;
  scenarioIds?: string[]; writable: boolean; onRefresh: () => void;
}) {
  const auth = useJarvisAuth()
  const bindingScope = `${auth.session?.user.id ?? "anonymous"}:${workId}:${investmentCaseId}:${modelVersionId}:${scenarioIds.join(",")}`
  const bindingKey = `finnor-m1-p4-refs:${bindingScope}`
  const [p4State, setP4State] = useState<ScopedP4Inputs>({ scope: "", inputs: {} })
  const p4Inputs: P4Inputs = p4State.scope === bindingScope ? p4State.inputs : {}
  const refsReady = p4State.scope === bindingScope
  const [p4Node, setP4Node] = useState("")
  const [p4Derivation, setP4Derivation] = useState("")
  const [p4Output, setP4Output] = useState("")
  const p4Binding = P4InputBindingViewSchema.safeParse({ nodeId: p4Node, derivationId: p4Derivation, output: p4Output })
  const scope = `${bindingScope}:${JSON.stringify(Object.entries(p4Inputs).sort(([a], [b]) => a.localeCompare(b)))}`
  const storageKey = `finnor-m1-view:${scope}`
  const [view, setView] = useState<RecordView | null>(null)
  const [witness, setWitness] = useState<DecisionWitnessView | null>(null)
  const [notes, setNotes] = useState("")
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState("")
  const [error, setError] = useState<string | null>(null)
  const epoch = useRef(0)
  const writing = useRef(false)
  const current = view?.scope === scope ? view : null
  const witnessLabels = useMemo(() => {
    const seen = new Set<string>()
    return new Map((current?.slice.materialVariables ?? []).map(variable => {
      const duplicate = seen.has(variable.nativeId)
      seen.add(variable.nativeId)
      return [variable.id, `Inspect witness for ${variable.nativeId}${duplicate ? ` · ${variable.id}` : ""}`]
    }))
  }, [current?.slice.materialVariables])

  useEffect(() => {
    let inputs: P4Inputs = {}
    try {
      const text = sessionStorage.getItem(bindingKey) ?? "[]"
      if (text.length > 32768) throw new Error("Saved references exceed their metadata bound")
      const saved = JSON.parse(text)
      if (!Array.isArray(saved) || saved.length > 16) throw new Error("Invalid saved reference metadata")
      for (const value of saved) {
        const { nodeId, derivationId, output } = P4InputBindingViewSchema.parse(value)
        inputs = { ...inputs, [nodeId]: { derivationId, output } }
      }
    } catch { sessionStorage.removeItem(bindingKey) }
    setP4State({ scope: bindingScope, inputs }); setP4Node(""); setP4Derivation(""); setP4Output("")
  }, [bindingScope, bindingKey])

  function updateP4Inputs(inputs: P4Inputs) {
    // Persist references only, never numerical values, proof, credentials or gaps.
    sessionStorage.setItem(bindingKey, JSON.stringify(Object.entries(inputs).map(([nodeId, binding]) => ({ nodeId, ...binding }))))
    setP4State({ scope: bindingScope, inputs })
  }

  async function load(ref: DecisionSliceRef): Promise<RecordView> {
    const response = await jarvisPost<{ slice: unknown }>("company-brain/decision-slice-view", { sliceRef: ref })
    const slice = DecisionSliceViewSchema.parse(response.slice)
    if (!sameRef(slice.ref, ref) || slice.envelope.work.id !== workId ||
      !slice.materialVariables.some(variable => variable.ownerRef.id === modelVersionId)) throw new Error("Decision context does not match the selected Work and model.")
    const responseContext = await jarvisPost<{ context: unknown }>("company-brain/decision-slice-context", { sliceRef: ref })
    const context = DecisionContextViewSchema.parse(responseContext.context)
    return { scope, slice, context }
  }

  useEffect(() => {
    const observer = epoch, generation = ++observer.current
    let active = true
    setView(null); setWitness(null); setError(null); setNotice(""); setNotes(""); setBusy(false); writing.current = false
    // Only an opaque ref is retained. Reload always asks the authenticated owner
    // to validate and reconstruct, including after revocation or a cold restart.
    const saved = sessionStorage.getItem(storageKey)
    if (refsReady && saved && workId && modelVersionId) {
      setBusy(true)
      void (async () => {
        try {
          const ref = DecisionSliceRefSchema.parse(JSON.parse(saved))
          const restored = await load(ref)
          if (!active || epoch.current !== generation) return
          setView(restored); setNotes(restored.context.notes.join("\n")); setNotice("Current qualified context reconstructed.")
        } catch (cause) {
          if (!active || epoch.current !== generation) return
          sessionStorage.removeItem(storageKey)
          setError(cause instanceof JarvisApiError && cause.status === 409 ? "Decision context is stale. Compile from current sources." : "Decision context unavailable. No cached evidence is shown.")
        } finally { if (active && epoch.current === generation) setBusy(false) }
      })()
    }
    return () => { active = false; observer.current++ }
    // Scope includes every mutable binding used by load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, refsReady])

  async function perform(action: () => Promise<void>) {
    if (writing.current || busy) return
    const generation = epoch.current
    writing.current = true; setBusy(true); setNotice(""); setError(null)
    try { await action() }
    catch (cause) {
      if (epoch.current !== generation) return
      setView(null); setWitness(null); sessionStorage.removeItem(storageKey)
      setError(cause instanceof JarvisApiError && cause.status === 409 ? "Decision context is stale or another revision won. Reload or compile from current sources." : "Decision context unavailable. No cached evidence is shown.")
    } finally {
      if (epoch.current === generation) { writing.current = false; setBusy(false) }
    }
  }

  function compile() {
    if (!workId || !modelVersionId || !writable || !refsReady) return
    const generation = epoch.current
    void perform(async () => {
      setWitness(null); setView(null)
      const response = await jarvisPost<{ slice: unknown }>("company-brain/decision-slice-compile", {
        schema: "finnor.decision-slice-request.v1", workId, purpose: "ACQUISITION",
        source: { kind: "UNDERWRITING", investmentCaseId, modelVersionId, ...(scenarioIds.length ? { scenarioIds } : {}),
          ...(Object.keys(p4Inputs).length ? { evidenceDerivationInputs: p4Inputs } : {}) },
        resource: { deadlineMs: 30000, maxNodes: 2048, maxBytes: 8388608, maxDemands: 128 },
      })
      const slice = DecisionSliceViewSchema.parse(response.slice)
      const loaded = await load(slice.ref)
      if (epoch.current !== generation) return
      setView(loaded); setNotes(loaded.context.notes.join("\n")); sessionStorage.setItem(storageKey, JSON.stringify(slice.ref))
      setNotice("Qualified native context compiled. This is not execution authority.")
    })
  }

  function inspect(variableId: string) {
    if (!current) return
    const generation = epoch.current
    void perform(async () => {
      setWitness(null)
      const result = DecisionWitnessViewSchema.parse(await jarvisPost("company-brain/decision-slice-witness", { sliceRef: current.slice.ref, variableId }))
      if (!sameRef(result.sliceRef, current.slice.ref) || result.variable.id !== variableId) throw new Error("Witness does not match this decision variable.")
      if (epoch.current === generation) setWitness(result)
    })
  }

  function consume(use: "DECISION" | "NUMERICAL_ONLY") {
    if (!current) return
    const generation = epoch.current
    void perform(async () => {
      const result = await jarvisPost<{ status: string; executionAuthorityGranted: false }>("company-brain/decision-slice-consume", { sliceRef: current.slice.ref, use })
      if (result.executionAuthorityGranted !== false) throw new Error("Unsupported decision authority response.")
      if (epoch.current !== generation) return
      setNotice(result.status === "INSUFFICIENT_DECISION_COVERAGE" ? "Decision refused: material coverage is unresolved."
        : result.status === "NATIVE_NUMERICAL_ONLY" ? "Native numerical run recorded. Checks and material gaps still apply."
          : `Qualified consumer outcome: ${result.status.replaceAll("_", " ").toLowerCase()}.`)
      if (use === "NUMERICAL_ONLY") onRefresh()
    })
  }

  function saveNotes() {
    if (!current) return
    const generation = epoch.current
    void perform(async () => {
      const response = await jarvisPost<{ context: unknown }>("company-brain/decision-slice-patch", {
        sliceRef: current.slice.ref, expectedContextRef: current.context.ref,
        patch: { notes: notes.split("\n").filter(line => line.trim()).slice(0, 32) },
      })
      const context = DecisionContextViewSchema.parse(response.context)
      if (context.qualifiedDigest !== current.context.qualifiedDigest) throw new Error("Qualified evidence cannot change with presentation notes.")
      if (epoch.current !== generation) return
      setView({ ...current, context }); setNotice("Presentation saved. Verified premises and gaps are unchanged.")
    })
  }

  return <section className="ct-decision-slice" aria-label="Decision context" aria-busy={busy}>
    <header><h4>Decision context</h4><p>Work-bound native dependencies, exact witnesses and unresolved coverage. Owner identity is not scientific truth.</p></header>
    {!workId ? <p>Link current Work before compiling a decision context.</p> : null}
    <details>
      <summary>Bind installed P4 financial evidence</summary>
      <p>IDs only. The authenticated owner must resolve a current, complete, checked scalar for this Work revision and the model&apos;s exact declared financial semantics. This cannot establish operative legal completeness or authority.</p>
      <label>Input node ID<input value={p4Node} maxLength={240} onChange={event => setP4Node(event.target.value)} /></label>
      <label>P4 derivation ID<input value={p4Derivation} maxLength={36} onChange={event => setP4Derivation(event.target.value)} /></label>
      <label>P4 output name<input value={p4Output} maxLength={64} onChange={event => setP4Output(event.target.value)} /></label>
      <button type="button" disabled={busy || !refsReady || !writable || !p4Binding.success || Object.keys(p4Inputs).length >= 16} onClick={() => {
        if (!p4Binding.success) return
        const { nodeId, derivationId, output } = p4Binding.data
        updateP4Inputs({ ...p4Inputs, [nodeId]: { derivationId, output } })
      }}>Add typed P4 reference</button>
      <ul>{Object.entries(p4Inputs).map(([nodeId, binding]) => <li key={nodeId}>{nodeId} · {binding.derivationId} · {binding.output} <button type="button" disabled={busy || !refsReady} onClick={() => updateP4Inputs(Object.fromEntries(Object.entries(p4Inputs).filter(([id]) => id !== nodeId)))}>Remove {nodeId} binding</button></li>)}</ul>
    </details>
    <div className="ct-decision-slice__actions">
      <button type="button" onClick={compile} disabled={busy || !refsReady || !writable || !workId || !modelVersionId}>Compile decision context</button>
      {current ? <button type="button" disabled={busy} onClick={() => {
        const generation = epoch.current
        void perform(async () => { const loaded = await load(current.slice.ref); if (epoch.current === generation) { setView(loaded); setNotes(loaded.context.notes.join("\n")); setWitness(null); setNotice("Current qualified context reconstructed.") } })
      }}>Reload and reconstruct</button> : null}
    </div>
    <p role="status" aria-live="polite">{busy ? "Checking current owner context…" : notice}</p>
    {error ? <p role="alert">{error}</p> : null}
    {current ? <>
      <p className="ct-decision-slice__warning"><strong>{current.slice.unresolvedCoverage.length ? "Incomplete decision coverage" : "Qualified declared-domain evidence"}</strong>. No effect, funding or protected admission is granted. Costs remain unmetered.</p>
      <p>Exact declared dependency preservation checked. Numerical projection loss is unknown, not zero. A global minimum is not certified.</p>
      <details><summary>Inspect projection domain and omitted groups</summary><p>{current.slice.projectionLossReason}</p><p>{current.slice.projectionSupport.witness.uncertaintyDomain}</p><p>Omitted groups: {current.slice.projectionSupport.witness.omittedIds.length}</p><ul>{current.slice.projectionSupport.witness.omittedIds.map(id => <li key={id}>{id}, disconnected from all declared run-validity roots</li>)}</ul><ul>{current.slice.projectionSupport.witness.limitations.map(value => <li key={value}>{value}</li>)}</ul></details>
      <ul className="ct-decision-slice__variables">{current.slice.materialVariables.map(variable => <li key={variable.id}><div><strong>{variable.nativeId}</strong><small>{variable.status} · {variable.unit ?? "owner contract"}{variable.currency ? ` · ${variable.currency}` : ""}</small><small>{variable.qualification}</small><small>Relevance: {current.slice.candidateDependencies.roots.filter(root => root.id === variable.id).map(root => root.criterion).join(", ") || "Declared backward dependency"}</small></div><button type="button" disabled={busy} onClick={() => inspect(variable.id)} aria-label={witnessLabels.get(variable.id)}>Inspect witness</button></li>)}</ul>
      {witness ? <details open><summary>Exact native witness · {witness.variable.nativeId}</summary><p>{witness.variable.ownerRef.owner} · {witness.variable.ownerRef.id}</p><pre tabIndex={0}>{JSON.stringify(witness.native, null, 2)}</pre></details> : null}
      {witness?.p4Derivation ? <details open><summary>Authentic P4 financial witness</summary><p>{witness.p4Derivation.qualification}</p><p>{witness.p4Derivation.id}</p><pre tabIndex={0}>{JSON.stringify(witness.p4Derivation, null, 2)}</pre></details> : null}
      <h5>Unresolved material premises</h5><ul>{current.slice.unresolvedCoverage.map(gap => <li key={gap.id}><strong>{gap.code}</strong> · {gap.status}<p>{gap.requirement}</p></li>)}</ul>
      {current.slice.evidenceDemands.some(demand => demand.requiredProducer === "P4") ? <><h5>Evidence producer coverage</h5><p>Only current owner-resolved financial demands can be P4 resolved. Other demands remain pending or qualified. Native inputs are not relabeled as P4 derivations.</p><ul>{current.slice.evidenceDemands.filter(demand => demand.requiredProducer === "P4").map(demand => <li key={demand.ref.id}>{demand.status} · {demand.reason}</li>)}</ul></> : null}
      <details><summary>Model assumptions and solver qualifications</summary><ul>{current.slice.limitations.map(value => <li key={value}>{value}</li>)}{current.slice.candidateDependencies.solverGroups.map(group => <li key={group.id}>{group.id} · {group.status}</li>)}</ul></details>
      <label>Notes (presentation only)<textarea value={notes} maxLength={64000} rows={3} onChange={event => setNotes(event.target.value)} /></label>
      <button type="button" disabled={busy || notes.split("\n").some(line => line.length > 2000) || notes.split("\n").length > 32} onClick={saveNotes}>Save presentation notes</button>
      <details><summary>Retained agenda · revision {current.context.revision}</summary><ul>{current.context.agenda.map((value, index) => <li key={index}>{value}</li>)}</ul></details>
      <div className="ct-decision-slice__actions"><button type="button" disabled={busy} onClick={() => consume("DECISION")}>Check decision readiness</button><button type="button" disabled={busy || !writable} onClick={() => consume("NUMERICAL_ONLY")}>Run native numerical consumer</button></div>
      <small>Knowledge cut {current.slice.envelope.knowledgeAt} · valid until {current.slice.envelope.validUntil}</small>
    </> : null}
  </section>
}
