"use client"

import { useRef, useState } from "react"
import { centropyDelete, centropyPost, centropyPut } from "@/components/centropy/lib/api"
import { RecordedFields, StructuredFields, schemaDefaults, type FieldSchema } from "./StructuredFields"

export type HumanForm = { id: string; capabilityId: string; group: string; title: string; method: "POST" | "PUT" | "DELETE"; routePattern: string; pathFields: string[]; readOnly: boolean; humanOnly: boolean; operation: string | null; owner: string; schema: FieldSchema }
type Review = { body: Record<string, unknown>; path: string; pathValues: Record<string, string> }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function CanonicalRecordForm({ form, initialValues = {}, pathValues = {}, writable = true, verify, onRecorded }: { form: HumanForm; initialValues?: Record<string, unknown>; pathValues?: Record<string, string>; writable?: boolean; verify?: (response: unknown, body: Record<string, unknown>) => Promise<unknown>; onRecorded: () => void }) {
  const [body, setBody] = useState<Record<string, unknown>>(() => ({ ...(schemaDefaults(form.schema, initialValues) as Record<string, unknown> ?? {}), ...initialValues, ...(form.operation ? { operation: form.operation } : {}) }))
  const [paths, setPaths] = useState(pathValues)
  const [review, setReview] = useState<Review | null>(null)
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [observed, setObserved] = useState<unknown>(null)
  const [verification, setVerification] = useState<"accepted" | "verified" | null>(null)
  const lock = useRef(false)
  const element = useRef<HTMLFormElement>(null)
  const idempotencyKey = useRef(crypto.randomUUID())
  const omit = ["operation", ...(form.schema.properties?.idempotencyKey ? ["idempotencyKey"] : [])]
  function edit(next: Record<string, unknown>) { setBody(next); setReview(null); setAck(false); idempotencyKey.current = crypto.randomUUID(); setObserved(null); setVerification(null) }
  function prepare() {
    if (!element.current?.reportValidity() || !writable || busy) return
    if (form.pathFields.some((key) => !paths[key] || (key !== "ref" && key !== "key" && !UUID.test(paths[key])))) { setError("Select an exact recorded reference before proceeding."); return }
    const path = form.routePattern.replaceAll(/:([A-Za-z]+)/g, (_, key: string) => encodeURIComponent(paths[key]))
    const next = { ...body, ...(form.schema.properties?.idempotencyKey ? { idempotencyKey: idempotencyKey.current } : {}) }
    setReview({ body: next, path, pathValues: { ...paths } }); setAck(false); setError(null)
  }
  async function record() {
    if (!review || (!form.readOnly && !ack) || !writable || lock.current) return
    lock.current = true; setBusy(true); setError(null); setObserved(null); setVerification(null)
    try {
      const result = form.method === "DELETE" ? await centropyDelete(review.path) : form.method === "PUT" ? await centropyPut(review.path, review.body) : await centropyPost(review.path, review.body)
      setObserved(result); setVerification("accepted")
      if (verify) { const readback = await verify(result, review.body); setObserved(readback); setVerification("verified") }
      setReview(null); setAck(false); onRecorded()
    } catch (cause) { setError(`${cause instanceof Error ? cause.message : "The operation could not be confirmed."} Refresh its record before retrying.`); onRecorded() }
    finally { setBusy(false); lock.current = false }
  }
  return <section className="ct-record-form" aria-label={form.title}>
    <h4>{form.title}</h4>
    {form.humanOnly ? <p>This control records your authenticated human decision. An agent cannot attest for you.</p> : null}
    <form ref={element} onSubmit={(e) => { e.preventDefault(); prepare() }}>
      {form.pathFields.map((key) => <label className="ct-record-field__scalar" key={key}>{key === "id" ? "Exact record reference" : `${key.replace(/([a-z])([A-Z])/g, "$1 $2")} reference`}<input required value={paths[key] ?? ""} readOnly={Boolean(pathValues[key])} onChange={(e) => { setPaths({ ...paths, [key]: e.target.value.trim() }); setReview(null); setAck(false) }} /></label>)}
      <StructuredFields schema={form.schema} value={body} set={edit} omit={omit} />
      {!review ? <button className="ct-record-primary" type="submit" disabled={!writable || busy}>{form.readOnly ? "Review query" : "Review record change"}</button> : null}
    </form>
    {review ? <div className="ct-record-review"><strong>{form.readOnly ? "Exact query" : "Exact change for your review"}</strong>{Object.keys(review.pathValues).length ? <RecordedFields value={review.pathValues} /> : null}<RecordedFields value={Object.fromEntries(Object.entries(review.body).filter(([key]) => key !== "idempotencyKey"))} />{!form.readOnly ? <label className="ct-record-field__include"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I reviewed this exact record change.</label> : null}<div><button type="button" disabled={busy} onClick={() => { setReview(null); setAck(false) }}>Cancel</button><button className="ct-record-primary" type="button" disabled={busy || !writable || (!form.readOnly && !ack)} onClick={() => void record()}>{busy ? "Recording…" : form.readOnly ? "Read canonical result" : "Record reviewed change"}</button></div></div> : null}
    {!writable ? <p role="status">The owning source is stale or unavailable. Refresh before recording a change.</p> : null}
    {error ? <p role="alert" className="ct-record-error">{error}</p> : null}
    {verification ? <div className="ct-record-result" role="status"><strong>{verification === "verified" ? "Canonical readback verified" : form.readOnly ? "Canonical query returned" : "Owning API accepted the change"}</strong><RecordedFields value={observed} /></div> : null}
  </section>
}
