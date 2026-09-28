"use client"

import { useId, useRef, useState } from "react"
import { centropyGet } from "@/components/centropy/lib/api"
import { SUPPORTING_READS } from "@/lib/centropy/supporting-reads"
import { RecordedFields } from "./StructuredFields"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export function SupportingReadDesk() {
  const id = useId()
  const [choice, setChoice] = useState(SUPPORTING_READS[0].routePattern)
  const [values, setValues] = useState<Record<string, string>>({})
  const [result, setResult] = useState<{ route: string; readAt: string; value: unknown } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lock = useRef(false)
  const selected = SUPPORTING_READS.find((entry) => entry.routePattern === choice)!
  const fields = [...[...selected.routePattern.matchAll(/:([a-zA-Z]+)/g)].map((match) => ({ key: match[1], label: match[1] === "id" ? "Exact record reference" : match[1] === "versionId" ? "Exact document version" : "Provider connection reference", uuid: match[1] !== "ref" })), ...(selected.query ?? [])]
  async function read() {
    if (lock.current) return
    if (fields.some((field) => !values[field.key]?.trim() || field.uuid && !UUID.test(values[field.key].trim()))) { setError("Enter the exact recorded references for this read."); return }
    const route = selected.routePattern.replaceAll(/:([a-zA-Z]+)/g, (_, key: string) => encodeURIComponent(values[key].trim()))
    const query = Object.fromEntries((selected.query ?? []).map((field) => [field.key, values[field.key].trim()]))
    lock.current = true; setBusy(true); setError(null); setResult(null)
    try { const value = await centropyGet<unknown>(route, query); setResult({ route, readAt: new Date().toISOString(), value }) }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Canonical read unavailable") }
    finally { lock.current = false; setBusy(false) }
  }
  return <section className="ct-record-controls" aria-label="Supporting canonical records">
    <p>Inspect an exact supporting record from its owning service. These reads use your current access; missing or restricted records remain unavailable. Long results show explicit display limits.</p>
    <label htmlFor={`${id}-read`}>Supporting record<select id={`${id}-read`} value={choice} disabled={busy} onChange={(event) => { setChoice(event.target.value); setValues({}); setResult(null); setError(null) }}>{SUPPORTING_READS.map((entry) => <option key={entry.routePattern} value={entry.routePattern}>{entry.title}</option>)}</select></label>
    <form onSubmit={(event) => { event.preventDefault(); void read() }}>{fields.map((field) => <label className="ct-record-field__scalar" key={field.key} htmlFor={`${id}-${field.key}`}>{field.label}<input id={`${id}-${field.key}`} required maxLength={2048} pattern={field.uuid ? "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}" : undefined} value={values[field.key] ?? ""} disabled={busy} onChange={(event) => { setValues({ ...values, [field.key]: event.target.value }); setResult(null) }} /></label>)}<button className="ct-record-primary" type="submit" disabled={busy}>{busy ? "Reading recorded source…" : "Read supporting record"}</button></form>
    {error ? <p role="alert">{error}</p> : null}
    {result ? <div role="status"><strong>Owning service returned this record</strong><p>Read {new Date(result.readAt).toLocaleString()}</p><RecordedFields value={result.value} /></div> : null}
  </section>
}
