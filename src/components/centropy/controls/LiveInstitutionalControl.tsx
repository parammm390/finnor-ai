"use client"

import { useEffect, useRef, useState, type FormEvent } from "react"
import { CentropyApiError, centropyControl } from "../lib/api"
import { getCurrentSessionKey, useCentropyAuth } from "../lib/centropy-auth"
import type { CompanyBrainObjectRef, PeWorldRootRef } from "../pe/contracts"
import styles from "./LiveInstitutionalControl.module.css"

type Json = Record<string, unknown>
type Cut = { cut: string; basis: string }
type Grant = { allocationRef: Json; policyRef: Json; programmeRef: string | null }
type Field = { nodeId: string; label: string; value: string | Record<string, string>; unit: string; currency: string | null; quantityContext: unknown }
type Proposal = { proposalId: string; proposalDigest: string; ownerVector: Cut; expiresAt: string; status: string;
  nativeRequest: Json | null; permittedReview: Json | null; authorityRequest: Json; approvals: Array<{ decisionRef: string }>; operation: Json | null }
type Branch = { branchId: string; parentId: string | null; isAuthor: boolean; visibility: string; status: string; intent: Json;
  author: { actorKind: string } | null; ownerVector: Cut; currentOwnerVector: Cut;
  evaluation: { evaluationId: string; status: string; consequence: Json | null; incurredCosts: unknown[] } | null; proposals: Proposal[] }
type Snapshot = { sessionId: string; workId: string; root: PeWorldRootRef; focus: { type: string; id: string };
  cursor: string; cursorExpiresAt: string; projectionDigest: string; ownerVector: Cut;
  principal: { principalId: string; actorKind: string; authorityRoles: unknown[] };
  confirmed: { focus: { exactProjectionJson: string }; capacity: Json[] };
  scenarios: Branch[]; history: Array<{ branchId: string | null; kind: string; recordedAt: string }>;
  controls: { propose: boolean; fields: { underwriting: { investmentCaseId: string; modelVersionId: string;
    baseRunId: string; worldAt: string; fields: Field[] } | null; consequenceGrants: Grant[]; unsupported: string | null } } }
type Props = { root: PeWorldRootRef; focus: CompanyBrainObjectRef; workId?: string | null; label?: string; onChanged?: () => void }
const readable = (value: string) => value.replaceAll("_", " ").toLowerCase()
const json = (value: unknown) => JSON.stringify(value, null, 2)
const decimal = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/

/** A scope change remounts before any cached private state can render. The
 * browser never optimistically changes confirmed quantities or retries writes. */
export function LiveInstitutionalControl(props: Props) {
  const auth = useCentropyAuth()
  const identity = `${auth.session?.user.id ?? ""}:${auth.session?.access_token ?? ""}`
  const binding = `${auth.session?.user.id ?? ""}|${props.workId ?? ""}|${props.root.entityType}:${props.root.entityId}|${props.focus.type}:${props.focus.id}`
  const [originalWork, setOriginalWork] = useState<{ binding: string; id: string | null }>({ binding, id: props.workId ?? null })
  if (!auth.session) return null
  return <ControlSession key={`${identity}|${binding}`} {...props} workId={originalWork.binding === binding ? originalWork.id : props.workId}
    onOpened={id => setOriginalWork({ binding, id })} />
}

function ControlSession({ root, focus, workId, label, onChanged, onOpened }: Props & { onOpened: (workId: string) => void }) {
  const scope = getCurrentSessionKey()
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const current = useRef<Snapshot | null>(null)
  const live = useRef(true), epoch = useRef(0), readSequence = useRef(0)
  const beginKey = useRef<string | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState("No financial change has been accepted.")
  const [online, setOnline] = useState(true)
  const [branchId, setBranchId] = useState<string | null>(null)
  const [fieldId, setFieldId] = useState(""), [value, setValue] = useState("")
  const [reason, setReason] = useState(""), [grantIndex, setGrantIndex] = useState("")
  const [advanced, setAdvanced] = useState(false), [intentText, setIntentText] = useState("")
  const [rebase, setRebase] = useState(false), [reviewed, setReviewed] = useState<string | null>(null)
  const alert = useRef<HTMLParagraphElement>(null)
  const valid = () => live.current && scope === getCurrentSessionKey()
  function replace(next: Snapshot | null) { current.current = next; if (valid()) setSnapshot(next) }
  function retract(message: string) {
    epoch.current++; readSequence.current++
    replace(null); setBranchId(null); setReviewed(null); setValue(""); setIntentText(""); setReason(""); setError(message)
  }
  function report(cause: unknown) {
    if (!valid()) return
    const message = cause instanceof Error ? cause.message : "The original owner is unavailable."
    if (cause instanceof CentropyApiError && [401, 403, 404].includes(cause.status)) retract(message)
    else setError(message)
  }
  function retire() { live.current = false; epoch.current++ }
  async function refresh() {
    const original = current.current
    if (!original || !valid() || !navigator.onLine) return
    const generation = epoch.current, sequence = ++readSequence.current
    try {
      const result = await centropyControl<Snapshot>("snapshot", { sessionId: original.sessionId })
      if (valid() && generation === epoch.current && sequence === readSequence.current) replace(result)
    } catch (cause) { if (generation === epoch.current && sequence === readSequence.current) report(cause) }
  }
  useEffect(() => {
    live.current = true
    setOnline(navigator.onLine)
    const offline = () => { setOnline(false); retract("Offline. Private controls were cleared. No pending effect was cancelled or replayed.") }
    const connected = () => { setOnline(true); setNotice("Connected. Reopen an authorized snapshot; financial commands are never replayed.") }
    window.addEventListener("offline", offline); window.addEventListener("online", connected)
    return () => { retire(); window.removeEventListener("offline", offline); window.removeEventListener("online", connected) }
    // Exact identity is owned by the keyed parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (!snapshot || !online) return
    let active = true, timer: number | undefined
    const expire = window.setTimeout(() => {
      if (active && current.current && Date.parse(current.current.cursorExpiresAt) <= Date.now())
        retract("The authorized cut expired. Resynchronize before reviewing or submitting an exact action.")
    }, Math.max(0, Date.parse(snapshot.cursorExpiresAt) - Date.now()))
    async function poll() {
      const previous = current.current
      if (!active || !previous || !valid() || !navigator.onLine) return
      const generation = epoch.current, sequence = ++readSequence.current
      try {
        const event = await centropyControl<{ kind: string; snapshot: Snapshot }>("events",
          { sessionId: previous.sessionId, cursor: previous.cursor, projectionDigest: previous.projectionDigest })
        if (active && valid() && generation === epoch.current && sequence === readSequence.current) {
          replace(event.snapshot)
          if (event.kind === "RESYNC") { setReviewed(null); setNotice("A coherent authorized snapshot replaced an event gap. No financial command was replayed.") }
        }
      } catch (cause) { if (active && generation === epoch.current && sequence === readSequence.current) report(cause) }
      if (active) timer = window.setTimeout(poll, 250)
    }
    timer = window.setTimeout(poll, 250)
    return () => { active = false; window.clearTimeout(expire); if (timer) window.clearTimeout(timer) }
    // A new cut renews this finite read-only loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot?.cursor, online])
  useEffect(() => { if (error) alert.current?.focus() }, [error])
  const selected = snapshot?.scenarios.find(branch => branch.branchId === branchId) ?? null
  const fields = snapshot?.controls.fields.underwriting?.fields ?? []
  const field = fields.find(item => item.nodeId === fieldId)
  const writable = online && !!snapshot?.controls.propose && !busy
  const ownCurrent = selected?.isAuthor && selected.status === "HYPOTHETICAL_SCENARIO"

  async function open() {
    if (busy || !online) return
    setBusy(true); setError(null)
    const generation = epoch.current
    beginKey.current ??= crypto.randomUUID()
    try {
      const result = await centropyControl<Snapshot>(workId ? "open" : "begin", {
        root, focus: { type: focus.type, id: focus.id },
        ...(workId ? { workId } : { idempotencyKey: beginKey.current }),
      })
      if (valid() && generation === epoch.current) { replace(result); onOpened(result.workId); setNotice("Authorized native owner cut loaded. Opening controls changes no financial state.") }
    } catch (cause) { report(cause) }
    finally { if (valid()) setBusy(false) }
  }
  async function command(operation: string, input: Json) {
    if (busy || !online || !snapshot) return
    setBusy(true); setError(null)
    const generation = epoch.current
    try {
      const result = await centropyControl<Json>(operation, input)
      if (!valid() || generation !== epoch.current) return
      if (typeof result.branchId === "string") setBranchId(result.branchId)
      setReviewed(null)
      setNotice(typeof result.status === "string" ? `${readable(result.status)}. Confirmed state comes only from the original owners.` : "Original command recorded. No settlement or owner profit is inferred.")
      await refresh()
      if (operation === "dispatch") onChanged?.()
    } catch (cause) {
      report(cause)
      if (cause instanceof CentropyApiError && (cause.status === 0 || cause.status >= 500)) {
        setNotice("Original command outcome is unknown. Read its native identity; do not submit a replacement financial command.")
        await refresh()
      }
    } finally { if (valid()) setBusy(false) }
  }
  async function proposeEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!writable || !snapshot) return
    try {
      let intent: Json
      if (advanced) {
        if (intentText.length > 2 * 1024 * 1024) throw Error("The exact intent exceeds its finite limit.")
        const parsed: unknown = JSON.parse(intentText)
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw Error("Supply one exact typed native intent.")
        intent = parsed as Json
      } else {
        const model = snapshot.controls.fields.underwriting
        if (!model || !field || !reason.trim()) throw Error("Choose a permitted native field and state why the assumption changes.")
        const edited: unknown = typeof field.value === "object" ? JSON.parse(value) : value
        const amounts = typeof edited === "object" && edited ? Object.values(edited) : [edited]
        if (!amounts.length || amounts.some(amount => typeof amount !== "string" || !decimal.test(amount))) throw Error("Use exact decimal strings. Period grids use a JSON object of decimal strings.")
        intent = { kind: "UNDERWRITING_ASSUMPTIONS", investmentCaseId: model.investmentCaseId, modelVersionId: model.modelVersionId,
          baseRunId: model.baseRunId, worldAt: model.worldAt, name: `Hypothetical ${field.label} change`,
          overrides: [{ nodeId: field.nodeId, value: edited, unit: field.unit, currency: field.currency,
            quantityContext: field.quantityContext, reason: reason.trim() }] }
      }
      const granted = snapshot.controls.fields.consequenceGrants[Number(grantIndex)]
      const consequenceGrant = grantIndex && granted ? { allocationRef: granted.allocationRef, policyRef: granted.policyRef, programmeRef: granted.programmeRef } : null
      await command(rebase ? "rebase" : "branch", { sessionId: snapshot.sessionId, intent, consequenceGrant,
        expectedOwnerVector: rebase && selected ? selected.currentOwnerVector : snapshot.ownerVector, idempotencyKey: crypto.randomUUID(),
        ...(rebase && selected ? { branchId: selected.branchId, reason: reason.trim() } : { visibility: "PRIVATE" }) })
      setRebase(false)
    } catch (cause) { report(cause) }
  }
  const stale = !!selected && selected.status !== "HYPOTHETICAL_SCENARIO"
  return <section className={styles.control} aria-label="Live institutional control">
    <header><span>DIRECT INSTITUTIONAL CONTROL</span><h3>{label ?? "Selected canonical object"}</h3>
      <p>Confirmed records, hypothetical consequences and original operation outcomes stay separate. Chat is optional.</p></header>
    {error ? <p className={styles.error} role="alert" ref={alert} tabIndex={-1}>{error}</p> : null}
    <p role="status" aria-live="polite">{busy ? "Submitting to the original owner. Do not replay the command." : notice}</p>
    {!snapshot ? <button type="button" disabled={busy || !online} onClick={() => void open()}>{busy ? "Opening…" : workId ? "Open direct controls for this Work" : "Start object-bound control Work"}</button> : <>
      <div className={styles.identity}><strong>{snapshot.principal.actorKind}</strong><span>Work {snapshot.workId.slice(0, 8)}</span>
        <button type="button" disabled={busy || !online} onClick={() => void refresh()}>Resynchronize (read only)</button></div>
      <div className={styles.states}>
        <section aria-label="Confirmed institutional state"><h4>1. Confirmed owner records</h4><pre>{snapshot.confirmed.focus.exactProjectionJson}</pre>
          <details><summary>Current permitted capacity, including retained holds</summary><pre>{json(snapshot.confirmed.capacity)}</pre></details>
          <p>Owner readback is not independent external settlement evidence.</p></section>
        <section aria-label="Hypothetical scenario"><h4>2. Hypothetical scenario</h4>
          <form onSubmit={proposeEdit}>
            <fieldset disabled={!writable}><legend>Propose a typed change, never a confirmed value</legend>
              {fields.length ? <label>Native model field<select value={fieldId} onChange={event => {
                const next = fields.find(item => item.nodeId === event.target.value); setFieldId(event.target.value);
                setValue(next ? typeof next.value === "object" ? json(next.value) : next.value : "")
              }}><option value="">Choose a field</option>{fields.map(item => <option key={item.nodeId} value={item.nodeId}>{item.label} ({item.currency ?? item.unit})</option>)}</select></label>
                : <p>No permitted native financial model is bound to this focus. Select its investment case, or use an installed typed owner intent. Missing values are not defaulted.</p>}
              <label><input type="checkbox" checked={advanced} onChange={event => setAdvanced(event.target.checked)} /> Use an exact installed native intent</label>
              {advanced ? <label>Typed native intent (JSON)<textarea rows={7} value={intentText} onChange={event => setIntentText(event.target.value)} required /></label>
                : field ? <label>Proposed {field.currency ?? field.unit}{typeof field.value === "object" ? " period grid, exact JSON strings" : ", exact decimal"}
                  {typeof field.value === "object" ? <textarea value={value} onChange={event => setValue(event.target.value)} rows={4} required />
                    : <input inputMode="decimal" value={value} onChange={event => setValue(event.target.value)} required />}</label> : null}
              <label>Reason for the proposed change<textarea value={reason} onChange={event => setReason(event.target.value)} maxLength={1000} required /></label>
              <label>Original compute grant<select value={grantIndex} onChange={event => setGrantIndex(event.target.value)}><option value="">No grant, computation will remain blocked</option>
                {snapshot.controls.fields.consequenceGrants.map((grant, index) => <option key={`${grant.allocationRef.id}:${grant.policyRef.id}`} value={String(index)}>{String(grant.policyRef.id).slice(0, 28)} (native attempts, not dollars)</option>)}</select></label>
              <button type="submit" disabled={!advanced && !field}>{rebase ? "Record explicit rebase as a new branch" : "Record private scenario"}</button>
            </fieldset>
          </form>
          <label>Preserved scenario branch<select value={branchId ?? ""} onChange={event => { setBranchId(event.target.value || null); setReviewed(null); setRebase(false) }}>
            <option value="">Choose a branch</option>{snapshot.scenarios.map(branch => <option key={branch.branchId} value={branch.branchId}>{branch.branchId.slice(0, 8)} · {branch.visibility} · {readable(branch.status)}</option>)}</select></label>
          {selected ? <><p><strong>{readable(selected.status)}</strong> · {selected.author?.actorKind ?? "Permissioned participant"}</p>
            <details><summary>Exact hypothetical change</summary><pre>{json(selected.intent)}</pre></details>
            {selected.evaluation ? <><p>Consequence: {readable(selected.evaluation.status)}</p><pre>{json(selected.evaluation.consequence)}</pre>
              <details><summary>Retained original costs, dollar meter may be unavailable</summary><pre>{json(selected.evaluation.incurredCosts)}</pre></details></> : null}
            {selected.isAuthor ? <div className={styles.actions}>
              <button type="button" disabled={!writable || !ownCurrent} onClick={() => void command("evaluate", { sessionId: snapshot.sessionId, branchId: selected.branchId, idempotencyKey: crypto.randomUUID() })}>Evaluate with original grant</button>
              <button type="button" disabled={!writable || !ownCurrent} onClick={() => void command("share", { sessionId: snapshot.sessionId, branchId: selected.branchId,
                expectedOwnerVector: selected.ownerVector, visibility: selected.visibility === "PRIVATE" ? "SHARED" : "PRIVATE", idempotencyKey: crypto.randomUUID() })}>{selected.visibility === "PRIVATE" ? "Share permitted scenario" : "Retract shared scenario"}</button>
              <button type="button" disabled={!writable} onClick={() => { setRebase(true); setAdvanced(true); setIntentText(json(selected.intent)); setNotice("Edit the preserved intent and state the rebase reason. A rebase creates a new branch, never an automatic merge.") }}>Rebase explicitly</button>
              <button type="button" disabled={!writable || !reason.trim()} onClick={() => void command("withdraw", { sessionId: snapshot.sessionId, branchId: selected.branchId, reason: reason.trim(), idempotencyKey: crypto.randomUUID() })}>Withdraw future scenario use</button>
              <button type="button" disabled={!writable || !ownCurrent || !selected.evaluation || !["COMPLETE", "PARTIAL"].includes(selected.evaluation.status)}
                onClick={() => void command("propose", { sessionId: snapshot.sessionId, branchId: selected.branchId, expectedOwnerVector: selected.ownerVector, idempotencyKey: crypto.randomUUID() })}>Prepare exact action proposal</button>
            </div> : null}
            {stale ? <p className={styles.error}>Material conflict. Old approvals cannot authorize changed terms. Preserve this branch, explicitly rebase and reevaluate.</p> : null}</> : null}
        </section>
        <section aria-label="Approved operation and observed outcome"><h4>3. Exact operation and observed outcome</h4>
          <p>A scenario reserves nothing. S1, S5 and S6 recheck current authority, terms and joint capacity. Native approval floors still apply.</p>
          {selected?.proposals.map(proposal => <article key={proposal.proposalId}>
            <h5>Proposal {proposal.proposalId.slice(0, 8)}</h5><p>{readable(proposal.status)} · expires <time dateTime={proposal.expiresAt}>{new Date(proposal.expiresAt).toLocaleString()}</time></p>
            <details><summary>Exact permitted action terms and authority requirements</summary><pre>{json({ permittedReview: proposal.permittedReview,
              authorityRequest: proposal.authorityRequest, expiry: proposal.expiresAt, approvals: proposal.approvals })}</pre></details>
            {proposal.operation ? <pre>{json(proposal.operation)}</pre> : <p>Not dispatched. No settlement, funded-money or profit claim.</p>}
            <label><input type="checkbox" checked={reviewed === proposal.proposalId} onChange={event => setReviewed(event.target.checked ? proposal.proposalId : null)} /> I reviewed this unchanged exact request and its current dependencies.</label>
            <div className={styles.actions}>
              <button type="button" disabled={busy || !online || reviewed !== proposal.proposalId || stale || !proposal.permittedReview || snapshot.principal.actorKind !== "HUMAN"}
                onClick={() => void command("approve", { sessionId: snapshot.sessionId, proposalId: proposal.proposalId, proposalDigest: proposal.proposalDigest,
                  expectedOwnerVector: proposal.ownerVector, expiresAt: proposal.expiresAt, idempotencyKey: crypto.randomUUID() })}>Record required exact review</button>
              <button type="button" disabled={!writable || !selected?.isAuthor || reviewed !== proposal.proposalId || stale || proposal.status !== "EXACT_PROPOSAL_RECHECK_AT_DISPATCH" || !!proposal.operation}
                onClick={() => void command("dispatch", { sessionId: snapshot.sessionId, proposalId: proposal.proposalId, proposalDigest: proposal.proposalDigest,
                  expectedOwnerVector: proposal.ownerVector, idempotencyKey: crypto.randomUUID() })}>Submit once to S5/S6</button>
              <button type="button" disabled={busy || !online} onClick={() => void refresh()}>Read original outcome, no retry</button>
            </div>
          </article>)}
          {!selected?.proposals.length ? <p>No exact operation proposal in this branch.</p> : null}
          <p>UNKNOWN retains the original identity, capacity, costs and responsibility. Withdrawal or sign-out never reverses an effect.</p>
        </section>
      </div>
      <details><summary>Conflict, recovery and lifecycle history</summary><ol>{snapshot.history.map((item, index) => <li key={`${item.recordedAt}:${index}`}>{readable(item.kind)} · <time dateTime={item.recordedAt}>{new Date(item.recordedAt).toLocaleString()}</time></li>)}</ol></details>
    </>}
  </section>
}
