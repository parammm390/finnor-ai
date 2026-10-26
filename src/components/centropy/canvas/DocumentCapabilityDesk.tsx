"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { z } from "zod"
import { centropyGet, centropyPost } from "@/components/centropy/lib/api"
import { PlannerCandidateReview } from "./PlannerCandidateReview"

const Summary = z.object({ id: z.string().uuid(), kind: z.string(), status: z.string(), deadlineAt: z.string().datetime({ offset: true }) }).passthrough()
const History = z.object({ runs: z.array(Summary), nextCursor: z.string().uuid().nullable() })
const Run = Summary.extend({ sources: z.array(z.object({ documentId: z.string().uuid(), versionId: z.string().uuid() }).passthrough()), result: z.record(z.string(), z.unknown()).nullable(), resultDigest: z.string().nullable().optional(), failureCode: z.string().nullable() })
type RunSummary = z.infer<typeof Summary>
type RunValue = z.infer<typeof Run>
const ongoing = (status: string) => ["QUEUED", "RUNNING", "WAITING_PROVIDER"].includes(status)
const message = (cause: unknown) => cause instanceof Error ? cause.message : "The capability request could not be read."

/** Uses the selected immutable version; no document bytes or provider credentials
 * are loaded into this component. Results always come from the authorized owner. */
export function DocumentCapabilityDesk({ documentId, versionId }: { documentId: string; versionId: string }) {
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [selected, setSelected] = useState<RunValue | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [question, setQuestion] = useState("")
  const [query, setQuery] = useState("SELECT * FROM source LIMIT 100")
  const [format, setFormat] = useState<"csv" | "json" | "parquet">("csv")
  const [treatment, setTreatment] = useState("")
  const [outcome, setOutcome] = useState("")
  const [causes, setCauses] = useState("")
  const [assumption, setAssumption] = useState("")
  const [evidenceRef, setEvidenceRef] = useState("")
  const active = useRef(true)
  const intent = useRef<{ signature: string; key: string } | null>(null)
  const source = { documentId, versionId }
  const assertSource = useCallback((run: RunValue) => {
    if (!run.sources.some(item => item.documentId === documentId && item.versionId === versionId)) throw new Error("The result belongs to a different document version.")
    return run
  }, [documentId, versionId])
  const refresh = useCallback(async () => {
    try {
      const value = History.parse(await centropyGet<unknown>("capabilities/runs", { documentId, versionId, limit: "10" }))
      if (active.current) setRuns(value.runs)
    } catch (cause) { if (active.current) { setRuns([]); setSelected(null) }; throw cause }
  }, [documentId, versionId])
  useEffect(() => {
    active.current = true
    void refresh().catch(cause => { if (active.current) setError(message(cause)) })
    return () => { active.current = false }
  }, [refresh])
  useEffect(() => {
    if (!selected || !ongoing(selected.status) || Date.now() >= Date.parse(selected.deadlineAt)) return
    const id = selected.id
    let cancelled = false
    const timer = setTimeout(() => {
      void centropyGet<unknown>(`capabilities/runs/${id}`).then(value => {
        const next = assertSource(Run.parse(z.object({ run: Run }).parse(value).run))
        if (!cancelled) { setSelected(next); void refresh().catch(() => undefined) }
      }).catch(cause => { if (!cancelled) { setSelected(null); setError(message(cause)) } })
    }, 2000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [selected, assertSource, refresh])
  async function inspect(id: string) {
    setError(null)
    try {
      const value = z.object({ run: Run }).parse(await centropyGet<unknown>(`capabilities/runs/${id}`))
      if (value.run.id !== id) throw new Error("The document read returned a different run.")
      const next = assertSource(value.run)
      if (active.current) setSelected(next)
    } catch (cause) { if (active.current) { setSelected(null); setError(message(cause)) } }
  }
  async function start(payload: Record<string, unknown>) {
    setBusy(true); setError(null)
    const signature = JSON.stringify({ documentId, versionId, payload })
    if (intent.current?.signature !== signature) intent.current = { signature, key: crypto.randomUUID() }
    try {
      const value = z.object({ run: Run }).parse(await centropyPost<unknown>("capabilities/runs", { ...payload, idempotencyKey: intent.current.key, timeoutMs: 300_000 }))
      if (value.run.kind !== payload.kind) throw new Error("The document submission returned a different operation.")
      const next = assertSource(value.run)
      intent.current = null
      if (active.current) { setSelected(next); await refresh().catch(cause => { if (active.current) setError(`Run accepted. History refresh failed: ${message(cause)}`) }) }
    } catch (cause) { if (active.current) setError(`${message(cause)} Retry the same request to reuse its submission key.`) }
    finally { if (active.current) setBusy(false) }
  }
  const index = runs.find(run => run.kind === "pageindex_index" && run.status === "SUCCEEDED")
  const resultText = selected?.result ? JSON.stringify(selected.result, null, 2) : ""
  return <details><summary>Document intelligence · extraction and analysis</summary><section className="ct-artifact__section ct-document-capabilities" aria-label="Document intelligence">
    <div className="ct-artifact__section-head"><h3>Document intelligence</h3><button type="button" disabled={busy} onClick={() => void refresh().catch(cause => setError(message(cause)))}>Refresh runs</button></div>
    <p>Run extraction or analysis against this exact version. Queued work and uncertain provider outcomes stay visible in the run record.</p>
    <div className="ct-artifact__nav">
      <button type="button" disabled={busy} onClick={() => void start({ kind: "docling_extract", source, forceOcr: true })}>Extract PDF text and tables · Docling</button>
      <button type="button" disabled={busy} onClick={() => void start({ kind: "pageindex_index", source })}>Build PDF page index · PageIndex</button>
    </div>
    <form onSubmit={event => { event.preventDefault(); if (index) void start({ kind: "pageindex_retrieve", indexRunIds: [index.id], question }) }}>
      <label>Question about this version<input value={question} onChange={event => setQuestion(event.target.value)} required maxLength={10_000} /></label>
      <button type="submit" disabled={busy || !index || !question.trim()}>Ask indexed document</button>
      {!index ? <p>Build the page index before asking a question.</p> : null}
    </form>
    <details><summary>Analyze a tabular snapshot · DuckDB / PyWhy</summary>
      <label>Snapshot format<select value={format} onChange={event => setFormat(z.enum(["csv", "json", "parquet"]).parse(event.target.value))}><option value="csv">CSV</option><option value="json">JSON</option><option value="parquet">Parquet</option></select></label>
      <form onSubmit={event => { event.preventDefault(); void start({ kind: "duckdb_query", datasets: [{ ...source, name: "source", format }], query, maxRows: 1000 }) }}>
        <label>Read-only SQL · table name source<textarea value={query} onChange={event => setQuery(event.target.value)} required maxLength={50_000} /></label>
        <button type="submit" disabled={busy}>Run snapshot query</button>
      </form>
      <form onSubmit={event => { event.preventDefault(); void start({ kind: "pywhy_assess", dataset: { ...source, name: "source", format }, treatment, outcome, commonCauses: causes.split(",").map(value => value.trim()).filter(Boolean), effectModifiers: [], estimator: "double_ml", assumptions: [{ statement: assumption, evidenceRef }], seed: 13 }) }}>
        <label>Treatment column<input value={treatment} onChange={event => setTreatment(event.target.value)} required maxLength={128} /></label>
        <label>Outcome column<input value={outcome} onChange={event => setOutcome(event.target.value)} required maxLength={128} /></label>
        <label>Common-cause columns · comma separated<input value={causes} onChange={event => setCauses(event.target.value)} required /></label>
        <label>Identification assumption<textarea value={assumption} onChange={event => setAssumption(event.target.value)} required maxLength={2000} /></label>
        <label>Evidence reference for that assumption<input value={evidenceRef} onChange={event => setEvidenceRef(event.target.value)} required maxLength={1024} /></label>
        <button type="submit" disabled={busy}>Assess conditional effect · PyWhy</button>
      </form>
    </details>
    <details><summary>Evaluate a versioned optimization dataset</summary>
      <p>The selected JSON version must use the planner replay or allocation evolution dataset contract. Generated candidates retain their evaluation and require separate reviewed activation.</p>
      <div className="ct-artifact__nav"><button type="button" disabled={busy} onClick={() => void start({ kind: "gepa_optimize", dataset: source, maxMetricCalls: 16, seed: 13 })}>Optimize planner candidate · GEPA</button><button type="button" disabled={busy} onClick={() => void start({ kind: "shinka_evolve", problemSet: source, generations: 2, seed: 13 })}>Evolve allocation candidate · Shinka</button></div>
    </details>
    {busy ? <p role="status">Submitting this request…</p> : null}
    {error ? <p role="alert" className="ct-artifact__error-text">{error}</p> : null}
    {selected?.kind === "gepa_optimize" && selected.status === "SUCCEEDED" && selected.result && selected.resultDigest ? <PlannerCandidateReview key={selected.id} runId={selected.id} resultDigest={selected.resultDigest} result={selected.result} /> : null}
    {runs.length ? <ol>{runs.map(run => <li key={run.id}><button type="button" onClick={() => void inspect(run.id)}>{run.kind.replaceAll("_", " ")} · {run.status.replaceAll("_", " ")} · {run.id.slice(0, 8)}</button></li>)}</ol> : <p>No accessible runs are recorded for this version.</p>}
    {selected ? <div aria-live="polite"><p><strong>{selected.status.replaceAll("_", " ")}</strong> · run {selected.id}{selected.failureCode ? ` · ${selected.failureCode.replaceAll("_", " ")}` : ""}</p>{ongoing(selected.status) && Date.now() >= Date.parse(selected.deadlineAt) ? <p>The execution deadline has passed. Refresh this run to inspect its recorded outcome.</p> : null}{selected.result ? <><p>Derived output for this document version. Its qualifications and source locations are retained below.</p><pre style={{ maxHeight: "32rem", overflow: "auto", whiteSpace: "pre-wrap" }}>{resultText.slice(0, 50_000)}</pre>{resultText.length > 50_000 ? <p>Showing the first 50,000 characters. The full result remains in the run record.</p> : null}</> : null}</div> : null}
  </section></details>
}
