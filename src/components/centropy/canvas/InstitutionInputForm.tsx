"use client"

import { useEffect, useState } from "react"
import { centropyPost } from "../lib/api"
import { usePrivateRequestScope } from "../lib/use-private-request-scope"

type Rule = { id: string; triggerKind: string; operation: string; principalId: string;
  deadlineAt: string; materiality: string; [field: string]: unknown }
type Inputs = { workId: string; principalId: string;
  profile: { sourceClasses: Array<{ id: string; protocols: string[] }>; ordinaryOperations: string[] };
  mandate: { institution_id: string; rules: Rule[]; expires_at: string } | null;
  documents: Array<{ document_id: string; version_id: string; title: string; size_bytes: number }>;
  principals: Array<{ id: string; display_name: string | null }> }
const readable = (value: string) => value.replaceAll("_", " ")
const utc = (value: string) => new Date(value).toISOString()

/** Scope-keyed by its parent: pending input reads and mutations cannot restore
 * another Work's form or call its saved callback after switching away. */
export function InstitutionInputForm({ workId, onSaved }: { workId: string; onSaved: () => Promise<void> }) {
  const { key, isCurrent, allowed } = usePrivateRequestScope(workId)
  const [inputs, setInputs] = useState<Inputs | null>(null)
  const [institution, setInstitution] = useState("")
  const [expiry, setExpiry] = useState("")
  const [rules, setRules] = useState<Rule[]>([])
  const [document, setDocument] = useState("")
  const [sourceClass, setSourceClass] = useState("")
  const [protocol, setProtocol] = useState("")
  const [purpose, setPurpose] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    setInputs(null); setRules([]); setMessage(null)
    if (allowed) void centropyPost<Inputs>("company-brain/institution-inputs", { workId }).then(value => {
      if (!active || !isCurrent(key) || value.workId !== workId) return
      setInputs(value); setInstitution(value.mandate?.institution_id ?? "")
      setExpiry((value.mandate?.expires_at ?? new Date(Date.now() + 3600000).toISOString()).slice(0, 16))
      setRules((value.mandate?.rules ?? []).map(({ postconditionRef: _postcondition, observerRef: _observer, ...rule }) => rule as Rule))
    }).catch(error => { if (active && isCurrent(key)) setMessage(error instanceof Error ? error.message : "Inputs are unavailable") })
    return () => { active = false }
  }, [allowed, isCurrent, key, workId])
  async function save(command: "mandate" | "source" | "consent" | "revoke-consent") {
    if (!inputs || busy || !isCurrent(key)) return
    setBusy(true); setMessage(null)
    try {
      if (command === "mandate") await centropyPost("company-brain/institution-mandate", {
        workId, institutionId: institution, rules, expiresAt: utc(expiry + ":00.000Z"),
      })
      else if (command === "consent" || command === "revoke-consent") await centropyPost("company-brain/institution-consent", {
        institutionId: institution, sourceClass, purpose,
        ...(command === "consent" ? { expiresAt: utc(expiry + ":00.000Z") } : {}), revoke: command === "revoke-consent",
      })
      else {
        const selected = inputs.documents.find(item => item.document_id === document)
        if (!selected) throw Error("Choose an existing owned original document")
        await centropyPost("company-brain/institution-register-source", { workId,
          documentId: selected.document_id, documentVersionId: selected.version_id,
          sourceClass, protocol, purpose, expiresAt: utc(expiry + ":00.000Z"),
        })
      }
      if (!isCurrent(key)) return
      setMessage(command === "mandate" ? "Standing responsibility saved. Its unsupported conditions remain explicit gaps."
        : command === "consent" ? "Your consent is saved for this source class, purpose and expiry."
        : command === "revoke-consent" ? "Your consent is revoked. Dependent private sources must be revalidated."
        : "Original source attached with owner-derived coverage and byte identity.")
      await onSaved()
    } catch (error) { if (isCurrent(key)) setMessage(error instanceof Error ? error.message : "Input configuration is uncertain; refresh current owners") }
    finally { if (isCurrent(key)) setBusy(false) }
  }
  const update = (index: number, field: string, value: string) => setRules(current => current.map((rule, i) => i === index ? { ...rule, [field]: value } : rule))
  if (!allowed) return null
  return <div aria-label="Responsibility input configuration">
    <p>Supply the standing responsibility and select originals already owned in Core. Existing read rights and sensitive subject consent are checked by their owners.</p>
    {inputs ? <>
      <form onSubmit={event => { event.preventDefault(); void save("mandate") }}>
        <label>Institution identifier<input required maxLength={160} value={institution} onChange={event => setInstitution(event.target.value)} disabled={busy} /></label>
        <label>Input access expiry (UTC)<input type="datetime-local" required value={expiry} onChange={event => setExpiry(event.target.value)} disabled={busy} /></label>
        {rules.map((rule, index) => <fieldset key={rule.id} disabled={busy}>
          <legend>Standing rule {index + 1}</legend>
          <label>Trigger condition<input required maxLength={160} value={rule.triggerKind} onChange={event => update(index, "triggerKind", event.target.value)} /></label>
          <label>Permitted operation<select value={rule.operation} onChange={event => update(index, "operation", event.target.value)}>
            {inputs.profile.ordinaryOperations.map(value => <option key={value} value={value}>{readable(value)}</option>)}
            {!inputs.profile.ordinaryOperations.includes(rule.operation) ? <option value={rule.operation}>{readable(rule.operation)} (interpretation required)</option> : null}
          </select></label>
          <label>Responsible principal<select value={rule.principalId} onChange={event => update(index, "principalId", event.target.value)}>
            {inputs.principals.map(principal => <option key={principal.id} value={principal.id}>{principal.display_name ?? principal.id}</option>)}
          </select></label>
          <label>Original deadline (UTC)<input type="datetime-local" required value={rule.deadlineAt.slice(0, 16)}
            onChange={event => update(index, "deadlineAt", event.target.value ? utc(event.target.value + ":00.000Z") : "")} /></label>
          <label>Materiality and priority<input required maxLength={2000} value={rule.materiality} onChange={event => update(index, "materiality", event.target.value)} /></label>
          <button type="button" onClick={() => setRules(current => current.filter((_, i) => i !== index))}>Remove rule</button>
        </fieldset>)}
        <button type="button" disabled={busy || !expiry || rules.length >= 128} onClick={() => setRules(current => [...current, {
          id: crypto.randomUUID(), triggerKind: "", operation: inputs.profile.ordinaryOperations[0],
          principalId: inputs.principalId, deadlineAt: utc(expiry + ":00.000Z"), materiality: "",
        }])}>Add standing rule</button>
        <button type="submit" disabled={busy || !rules.length}>Save standing responsibility</button>
      </form>
      <form onSubmit={event => { event.preventDefault(); void save("source") }}>
        <label>Owned original<select required value={document} onChange={event => setDocument(event.target.value)} disabled={busy}>
          <option value="">Choose a Core document</option>{inputs.documents.map(item => <option key={item.document_id} value={item.document_id}>{item.title} · {item.size_bytes} bytes</option>)}
        </select></label>
        <label>Source class<select required value={sourceClass} disabled={busy} onChange={event => { setSourceClass(event.target.value); setProtocol("") }}>
          <option value="">Choose a source class</option>{inputs.profile.sourceClasses.map(item => <option key={item.id} value={item.id}>{readable(item.id)}</option>)}
        </select></label>
        <label>Original format<select required value={protocol} onChange={event => setProtocol(event.target.value)} disabled={busy}>
          <option value="">Choose the original format</option>{inputs.profile.sourceClasses.find(item => item.id === sourceClass)?.protocols.filter(value => value !== "installed_source_adapter")
            .map(value => <option key={value} value={value}>{readable(value)}</option>)}
        </select></label>
        <label>Authorized purpose<input required maxLength={2000} value={purpose} onChange={event => setPurpose(event.target.value)} disabled={busy} /></label>
        {["personnel_benefits", "expense_administration"].includes(sourceClass) ? <div>
          <p>Sensitive records also require the identity owner’s current binding for every subject. You may grant or revoke your own consent for the selected purpose.</p>
          <button type="button" disabled={busy || !institution || !purpose || !expiry} onClick={() => void save("consent")}>Grant my consent</button>
          <button type="button" disabled={busy || !institution || !purpose} onClick={() => void save("revoke-consent")}>Revoke my consent</button>
        </div> : null}
        <button type="submit" disabled={busy}>Attach authorized original</button>
      </form>
    </> : <p>Reading current input owners…</p>}
    {message ? <p role="status">{message}</p> : null}
  </div>
}
