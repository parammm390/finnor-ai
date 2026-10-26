"use client"

import { useEffect, useRef, useState } from "react"
import { z } from "zod"
import { centropyGet, centropyPost } from "../lib/api"

const Summary = z.object({ id: z.string().uuid(), kind: z.string(), status: z.string() }).passthrough()
const Run = Summary.extend({ request: z.object({ kind: z.string() }).passthrough(), result: z.record(z.string(), z.unknown()).nullable(), failureCode: z.string().nullable() })
const kinds = ["parallel_task", "parallel_find", "parallel_monitor"] as const
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : "The research request could not be completed."

export function ResearchCapabilityDesk() {
  const [objective, setObjective] = useState("")
  const [condition, setCondition] = useState("")
  const [cadence, setCadence] = useState<"daily" | "weekly">("daily")
  const [eventGroups, setEventGroups] = useState<Record<string, string>>({})
  const [runs, setRuns] = useState<Array<z.infer<typeof Summary>>>([])
  const [selected, setSelected] = useState<z.infer<typeof Run> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const alive = useRef(true), intent = useRef<{ signature: string; key: string } | null>(null)
  async function refresh() {
    try {
      const pages = await Promise.all(kinds.map(kind => centropyGet<unknown>("capabilities/runs", { kind, limit: "10" })))
      const parsed = pages.flatMap(value => z.object({ runs: z.array(Summary) }).parse(value).runs)
      if (alive.current) setRuns(parsed)
    } catch (cause) { if (alive.current) { setRuns([]); setSelected(null); setError(errorText(cause)) } }
  }
  useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false } }, [])
  async function inspect(id: string) {
    setError(null)
    try {
      const value = z.object({ run: Run }).parse(await centropyGet<unknown>(`capabilities/runs/${id}`))
      if (value.run.id !== id) throw new Error("The research read returned a different run.")
      if (alive.current) setSelected(value.run)
    } catch (cause) { if (alive.current) { setSelected(null); setError(errorText(cause)) } }
  }
  async function submit(payload: Record<string, unknown>) {
    setBusy(true); setError(null)
    const signature = JSON.stringify(payload)
    if (intent.current?.signature !== signature) intent.current = { signature, key: crypto.randomUUID() }
    try {
      const value = z.object({ run: Run }).parse(await centropyPost<unknown>("capabilities/runs", { ...payload, idempotencyKey: intent.current.key, timeoutMs: 300_000 }))
      if (value.run.kind !== payload.kind || value.run.request.kind !== payload.kind) throw new Error("The research submission returned a different operation.")
      intent.current = null
      if (alive.current) { setSelected(value.run); await refresh() }
    } catch (cause) { if (alive.current) setError(`${errorText(cause)} Retry the same request to reuse its submission key.`) }
    finally { if (alive.current) setBusy(false) }
  }
  const output = selected?.result ? JSON.stringify(selected.result, null, 2) : ""
  return <details><summary>Research and monitoring tools</summary><section className="ct-source-diagnostics" aria-label="Research and monitoring">
    <header><div><span className="ct-eyebrow">RESEARCH / PARALLEL</span><h3>Research and monitoring</h3></div><button type="button" disabled={busy} onClick={() => void refresh()}>Refresh research runs</button></header>
    <label>Research objective<textarea value={objective} onChange={event => setObjective(event.target.value)} maxLength={10_000} /></label>
    <button type="button" disabled={busy || !objective.trim()} onClick={() => void submit({ kind: "parallel_task", input: objective, processor: "lite", outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } })}>Research with citations</button>
    <details><summary>Find organizations matching a criterion</summary><label>Required matching criterion<textarea value={condition} onChange={event => setCondition(event.target.value)} maxLength={2000} /></label><button type="button" disabled={busy || !objective.trim() || !condition.trim()} onClick={() => void submit({ kind: "parallel_find", objective, entityType: "companies", matchConditions: [{ name: "qualification", description: condition }], matchLimit: 10 })}>Find matching organizations</button></details>
    <details><summary>Monitor this research objective</summary><label>Cadence<select value={cadence} onChange={event => setCadence(z.enum(["daily", "weekly"]).parse(event.target.value))}><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label><p>Monitoring continues at the provider until stopped. Its execution record retains the monitor identity and controls.</p><button type="button" disabled={busy || !objective.trim()} onClick={() => void submit({ kind: "parallel_monitor", query: objective, cadence })}>Start monitoring</button></details>
    {busy ? <p role="status">Submitting research request…</p> : null}{error ? <p role="alert">{error}</p> : null}
    <ul>{runs.map(run => <li key={run.id}><button type="button" onClick={() => void inspect(run.id)}>{run.kind.replaceAll("_", " ")} · {run.status.replaceAll("_", " ")} · {run.id.slice(0, 8)}</button>{run.kind === "parallel_monitor" ? <><button type="button" disabled={busy} onClick={() => void submit({ kind: "parallel_monitor_control", monitorRunId: run.id, operation: "status" })}>Read monitor status</button><label>Event group (optional) for monitor {run.id.slice(0, 8)}<input aria-label={`Event group for monitor ${run.id.slice(0, 8)}`} value={eventGroups[run.id] ?? ""} maxLength={256} onChange={event => setEventGroups(previous => ({ ...previous, [run.id]: event.target.value }))} /></label><button type="button" disabled={busy || Boolean(eventGroups[run.id] && !/^[A-Za-z0-9_-]{1,256}$/.test(eventGroups[run.id]))} onClick={() => void submit({ kind: "parallel_monitor_control", monitorRunId: run.id, operation: "events", ...(eventGroups[run.id] ? { eventGroupId: eventGroups[run.id] } : {}) })}>Read monitor events</button><button type="button" disabled={busy} onClick={() => void submit({ kind: "parallel_monitor_control", monitorRunId: run.id, operation: "cancel" })}>Stop monitor</button></> : null}</li>)}{!runs.length ? <li>No accessible research runs are recorded.</li> : null}</ul>
    {selected ? <div aria-live="polite"><p><strong>{selected.status.replaceAll("_", " ")}</strong> · run {selected.id}{selected.failureCode ? ` · ${selected.failureCode.replaceAll("_", " ")}` : ""}</p><button type="button" onClick={() => void inspect(selected.id)}>Refresh selected run</button>{output ? <pre style={{ maxHeight: "28rem", overflow: "auto", whiteSpace: "pre-wrap" }}>{output.slice(0, 50_000)}</pre> : null}</div> : null}
  </section></details>
}
