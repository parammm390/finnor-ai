"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { z } from "zod"
import { centropyGet, centropyPost } from "../lib/api"
import { onBusinessInvalidation } from "../lib/business-invalidation"
import { usePrivateRequestScope } from "../lib/use-private-request-scope"

const terms = z.object({ revision: z.number().int().positive(), deliverable: z.string(),
  compensation: z.object({ value: z.string(), unit: z.string() }), subdelegation: z.boolean(), expiresAt: z.string() })
const assignment = z.object({ id: z.string(), taskId: z.string(), actorId: z.string(), delegatorActorId: z.string(),
  parentAssignmentId: z.string().nullable(), rootId: z.string(), originalDeadline: z.string(),
  terms, termsDigest: z.string(), state: z.object({ kind: z.string() }) })
const task = z.object({ id: z.string(), criterionId: z.string(), dependsOn: z.array(z.string()),
  returnTo: z.array(z.string()), assignmentMode: z.string(), dueAt: z.string() })
const review = z.object({ assignmentId: z.string(), criterionId: z.string(), termsDigest: z.string(),
  termsRevision: z.number().int().positive(), deliveryValue: z.unknown(), acceptance: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("EXACT_JSON"), expected: z.unknown() }),
    z.object({ kind: z.literal("AUTHENTICATED_HUMAN_JUDGMENT"), question: z.string() }),
  ]) })
const refinement = z.object({ kind: z.enum(["SUBDELEGATION", "RECIPROCAL_REQUEST"]),
  recipientActorId: z.string().uuid(), task: z.record(z.string(), z.unknown()),
  criterion: z.record(z.string(), z.unknown()), computation: z.record(z.string(), z.unknown()) }).strict()
const programme = z.object({ id: z.string().uuid(), workId: z.string().uuid(), revision: z.number().int().nonnegative(),
  status: z.string(), view: z.enum(["ACCOUNTABLE_ROOT", "RECIPIENT_SCOPED"]), originalDeadline: z.string().optional(),
  program: z.object({ assignments: z.array(assignment).max(8192),
    taskCreations: z.array(z.object({ task })).max(512).optional(), originalOutcome: z.object({
    tasks: z.array(task).max(512), deadline: z.string() }) }).nullable().optional(),
  assignments: z.array(z.object({ assignment, task })).max(8192).optional(),
  requestedWork: z.array(z.object({ taskCreationRef: z.object({ id: z.string() }), parentAssignmentId: z.string(),
    assignmentId: z.string(), taskId: z.string(), state: z.string(), deliverable: z.string(),
    result: z.object({ value: z.unknown(), evidenceRefs: z.array(z.object({ id: z.string() })),
      verificationResult: z.string() }).nullable() })).max(512).optional(),
  reviews: z.array(review).max(512).optional(),
  availableActions: z.record(z.string(), z.array(z.string())).optional(),
  currentCheck: z.object({ valid: z.boolean(), issues: z.array(z.object({ code: z.string(),
    assignmentId: z.string().nullable() })), affectedAssignmentIds: z.array(z.string()) }).nullable().optional(),
  recovery: z.object({ required: z.boolean(), quarantinedJobs: z.number() }).optional(),
  protectedReceipt: z.null(), executionAuthorityGranted: z.literal(false) })
const listing = z.object({ workId: z.string().uuid(), complete: z.literal(true),
  data: z.array(z.object({ id: z.string().uuid(), revision: z.number().int().nonnegative().optional() })).max(128),
  originalInput: z.object({ workInputId: z.string().uuid(), originalDeadline: z.string() }).nullable() })
type Read = z.infer<typeof programme>
type Listing = z.infer<typeof listing>
type Scoped<T> = { key: string; value: T }
type Mutation = { kind: "SUBMIT" } | { kind: "ACTION"; id: string } | { kind: "RECONCILE"; id: string }
const label = (value: string) => value.replaceAll("_", " ").toLowerCase()
const date = (value: string) => new Date(value).toLocaleString()

/** No resolved response is cached. Rendered terms and mutation inputs belong to
 * one exact authenticated scope and are withdrawn before every new read. */
export function WorkforceExecutionPanel({ workId, participant = false }: { workId: string; participant?: boolean }) {
  const { key, allowed, isCurrent, invalidate } = usePrivateRequestScope("workforce:" + workId,
    participant ? "WORKFORCE_PARTICIPANT" : "OWNER")
  const [metadata, setMetadata] = useState<Scoped<Listing> | null>(null)
  const [read, setRead] = useState<Scoped<Read> | null>(null)
  const [message, setMessage] = useState<Scoped<string> | null>(null)
  const [selected, setSelected] = useState<Scoped<string> | null>(null)
  const [input, setInput] = useState<Scoped<string> | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [reading, setReading] = useState<string | null>(null)
  const generation = useRef(0)
  const inFlight = useRef<{ key: string; serial: number } | null>(null)
  const head = useRef<{ key: string; id: string; revision: number } | null>(null)
  if (head.current?.key !== key) head.current = null
  const visible = allowed && read?.key === key ? read.value : null
  const sources = allowed && metadata?.key === key ? metadata.value : null
  const chosen = selected?.key === key ? selected.value : null
  const currentInput = input?.key === key ? input.value : ""
  const working = busy === key

  const refresh = useCallback(async () => {
    if (inFlight.current?.key === key && inFlight.current.serial === generation.current) return
    const scope = key, serial = ++generation.current
    const current = () => isCurrent(scope) && serial === generation.current
    setRead(null); setMetadata(null); setMessage(null)
    if (!allowed || !navigator.onLine || document.visibilityState === "hidden") return
    inFlight.current = { key: scope, serial }; setReading(scope)
    try {
      const next = listing.parse(await centropyGet("workforce/execution-programs", { workId }))
      if (!current()) return
      if (next.workId !== workId) throw Error("The programme list belongs to another Work")
      setMetadata({ key: scope, value: next })
      const entry = next.data.find(row => row.id === chosen) ?? next.data[0]
      if (!entry) return
      const result = programme.parse(await centropyGet("workforce/execution-programs/" + entry.id))
      if (!current()) return
      if (result.workId !== workId || result.id !== entry.id ||
          entry.revision !== undefined && result.revision < entry.revision ||
          head.current?.id === result.id && result.revision < head.current.revision)
        throw Error("The current original Work programme could not be verified")
      head.current = { key: scope, id: result.id, revision: result.revision }
      setRead({ key: scope, value: result })
    } catch (error) {
      if (!current()) return
      setRead(null); setMetadata(null)
      setMessage({ key: scope, value: error instanceof Error ? error.message : "Current authorized programme unavailable" })
    } finally {
      if (inFlight.current?.key === scope && inFlight.current.serial === serial) {
        inFlight.current = null; setReading(null)
      }
    }
  }, [allowed, chosen, isCurrent, key, workId])
  useEffect(() => {
    setInput(null); setBusy(null)
    void refresh()
    return () => { generation.current += 1 }
  }, [refresh])
  useEffect(() => {
    const withdraw = () => { generation.current += 1; setRead(null); setMetadata(null); setInput(null); invalidate() }
    const changedVisibility = () => withdraw()
    window.addEventListener("offline", withdraw)
    window.addEventListener("online", withdraw)
    document.addEventListener("visibilitychange", changedVisibility)
    const unsubscribe = onBusinessInvalidation(signal => {
      if (signal.tags.some(tag => ["work", "workforce", "agents", "authority", "source"].includes(tag))) withdraw()
    })
    return () => {
      window.removeEventListener("offline", withdraw); window.removeEventListener("online", withdraw)
      document.removeEventListener("visibilitychange", changedVisibility); unsubscribe()
    }
  }, [invalidate])
  useEffect(() => {
    if (!allowed || working || reading === key) return
    const timer = window.setTimeout(() => void refresh(), visible?.status === "CLOSED" ? 15000 : 3000)
    return () => window.clearTimeout(timer)
  }, [allowed, key, reading, refresh, visible, working])

  async function mutate(operation: Mutation, body: unknown) {
    if (working || !isCurrent(key)) return
    const scope = key
    generation.current += 1; setRead(null); setMetadata(null); setBusy(scope); setMessage(null)
    try {
      switch (operation.kind) {
        case "SUBMIT": await centropyPost("workforce/execution-programs", body); break
        case "ACTION": await centropyPost(`workforce/execution-programs/${operation.id}/actions`, body); break
        case "RECONCILE": await centropyPost(`workforce/execution-programs/${operation.id}/reconcile`, body); break
      }
      if (isCurrent(scope)) await refresh()
    } catch (error) {
      if (isCurrent(scope)) setMessage({ key: scope, value: error instanceof Error ? error.message :
        "The response is uncertain. Refresh the original programme before trying again." })
    } finally { if (isCurrent(scope)) setBusy(null) }
  }
  async function act(item: z.infer<typeof assignment>, action: string) {
    if (!visible) return
    let extra: Record<string, unknown> = {}
    if (["DELIVER", "VERIFY", "REVISE_TERMS", "REASSIGN", "SUBDELEGATE"].includes(action)) {
      try {
        const value: unknown = JSON.parse(currentInput)
        extra = action === "REVISE_TERMS" ? { revisedTerms: terms.parse(value) } : action === "REASSIGN"
          ? z.object({ replacementActorId: z.string().uuid(), replacementAssignmentId: z.string().min(1).max(256) }).strict().parse(value)
          : action === "SUBDELEGATE" ? { refinement: refinement.parse(value) } : { value }
      } catch {
        setMessage({ key, value: "Enter the actual response, revised terms, replacement identities, or bounded child request as JSON before submitting." }); return
      }
    }
    await mutate({ kind: "ACTION", id: visible.id }, {
      idempotencyKey: "workforce-ui:" + crypto.randomUUID(), expectedRevision: visible.revision,
      assignmentId: item.id, action, termsDigest: item.termsDigest, termsRevision: item.terms.revision,
      ...extra,
      ...(["BLOCK", "RETURN", "DISPUTE"].includes(action) ? { reason: "PARTICIPANT_REPORTED_OBSTACLE" } : {}),
    })
  }
  async function verify(item: z.infer<typeof review>) {
    if (!visible) return
    let value: unknown
    if (item.acceptance.kind === "AUTHENTICATED_HUMAN_JUDGMENT") {
      try { value = z.boolean().parse(JSON.parse(currentInput)) } catch {
        setMessage({ key, value: "Enter your actual judgment as JSON true or false. No judgment is inferred from silence." }); return
      }
    }
    await mutate({ kind: "ACTION", id: visible.id }, {
      idempotencyKey: "workforce-ui:" + crypto.randomUUID(), expectedRevision: visible.revision,
      assignmentId: item.assignmentId, action: "VERIFY", termsDigest: item.termsDigest, termsRevision: item.termsRevision,
      ...(value === undefined ? {} : { value }),
    })
  }
  if (!allowed || sources && !sources.originalInput && !sources.data.length) return null
  const rows = visible?.view === "RECIPIENT_SCOPED" ? visible.assignments ?? [] :
    visible?.program?.assignments.map(item => ({ assignment: item,
      task: [...visible.program!.originalOutcome.tasks, ...(visible.program!.taskCreations ?? []).map(value => value.task)]
        .find(value => value.id === item.taskId)! })) ?? []
  return <section className="ct-canvas-block" aria-label="Accountable workforce programme" data-workforce-work={workId}>
    <header><div><span className="ct-eyebrow">ACCOUNTABLE WORKFORCE</span><h3>Workforce execution programme</h3></div>
      <button type="button" disabled={working} onClick={() => void refresh()}>Refresh current contracts</button></header>
    <p>Assignments retain the original Work, authority, deadline and resource budget. An offer is not acceptance or completion.</p>
    {sources && !sources.data.length && sources.originalInput ? <button type="button" disabled={working}
      onClick={() => void mutate({ kind: "SUBMIT" }, { workId, workInputId: sources.originalInput!.workInputId,
        idempotencyKey: "workforce-ui:" + crypto.randomUUID() })}>Compile original workforce outcome</button> : null}
    {sources && sources.data.length > 1 ? <label>Original programme<select value={visible?.id ?? chosen ?? sources.data[0]?.id}
      disabled={working} onChange={event => { setRead(null); setInput(null); setSelected({ key, value: event.target.value }) }}>
      {sources.data.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label> : null}
    <p role="status">{message?.key === key ? message.value : visible
      ? `Revision ${visible.revision} · ${label(visible.status)} · ${visible.view === "RECIPIENT_SCOPED" ? "your contracts only" : "accountable root"}`
      : working ? "Submitting exact current terms…" : "Reading current authorized contracts…"}</p>
    {visible?.status === "FENCED" ? <p role="alert">Current authority or evidence no longer supports part of this graph.
      No stale readiness is an execution permit. Existing responsibility and possible use remain retained.</p> : null}
    {visible?.recovery?.required ? <button type="button" disabled={working}
      onClick={() => void mutate({ kind: "RECONCILE", id: visible.id }, {
        idempotencyKey: "workforce-ui:" + crypto.randomUUID(), expectedRevision: visible.revision })}>
      Reconcile retained attempt, without replay</button> : null}
    {visible ? <>
      <p>{rows.length} visible assignment records. Original deadline {date(visible.originalDeadline ??
        visible.program?.originalOutcome.deadline ?? "")}.</p>
      <table><caption>Responsibility, exact terms and independent completion</caption>
        <thead><tr><th scope="col">Task</th><th scope="col">Accountability</th><th scope="col">State and terms</th><th scope="col">Authenticated response</th></tr></thead>
        <tbody>{rows.map(({ assignment: item, task: original }) => <tr key={item.id}>
          <td>{item.taskId}<p>{item.terms.deliverable}</p>{original ? <small>Criterion {original.criterionId}
            {original.dependsOn.length ? ` · waits for ${original.dependsOn.join(", ")}` : ""}
            {original.returnTo.length ? ` · returns to ${original.returnTo.join(", ")}` : ""}</small> : null}</td>
          <td>Recipient {item.actorId}<p>Delegator {item.delegatorActorId}</p>
            <small>{item.parentAssignmentId ? `Parent ${item.parentAssignmentId}` : "Original accountable root"}</small></td>
          <td>{label(item.state.kind)}<details><summary>Inspect exact offered terms</summary>
            <p>Terms revision {item.terms.revision}. Compensation {item.terms.compensation.value} {item.terms.compensation.unit}.
              Subdelegation {item.terms.subdelegation ? "within original limits only" : "not permitted"}.</p>
            <p>Expires {date(item.terms.expiresAt)}. Terms digest {item.termsDigest}.</p></details></td>
          <td>{(visible.availableActions?.[item.id] ?? []).filter(action => action !== "VERIFY").map(action => <button type="button" key={action}
            disabled={working || Boolean(visible.currentCheck?.affectedAssignmentIds.includes(item.id)) &&
              !["CANCEL", "RETURN", "DISPUTE", "CONFIRM_CANCEL", "RELEASE_LABOR"].includes(action)}
            onClick={() => void act(item, action)}>{action === "RELEASE_LABOR" ? "I release my accepted labor only" : label(action)}</button>)}</td>
        </tr>)}</tbody></table>
      {visible.reviews?.length ? <section aria-label="Your independent workforce reviews">
        <h4>Your independent reviews</h4>
        {visible.reviews.map(item => <article key={item.assignmentId}><h5>Criterion {item.criterionId}</h5>
          <p>{item.acceptance.kind === "AUTHENTICATED_HUMAN_JUDGMENT" ? item.acceptance.question :
            "Compare the actual delivery against the immutable original literal criterion."}</p>
          <pre>{JSON.stringify(item.deliveryValue, null, 2)}</pre>
          <button type="button" disabled={working} onClick={() => void verify(item)}>Verify actual delivery</button></article>)}
      </section> : null}
      {visible.requestedWork?.length ? <section aria-label="Work you requested and returned evidence">
        <h4>Your requested work</h4>
        {visible.requestedWork.map(item => <article key={item.assignmentId}>
          <h5>{item.taskId}: {label(item.state)}</h5><p>{item.deliverable}</p>
          <small>Requested under {item.parentAssignmentId}. Creation {item.taskCreationRef.id}.</small>
          {item.result ? <><p>Criterion result: {label(item.result.verificationResult)}.
            Returned data is not authority to complete the original Work.</p>
            <pre>{JSON.stringify(item.result.value, null, 2)}</pre></> : <p>No currently supported delivery is available.</p>}
        </article>)}
      </section> : null}
      {visible.reviews?.some(item => item.acceptance.kind === "AUTHENTICATED_HUMAN_JUDGMENT") ||
        rows.some(({ assignment: item }) => (visible.availableActions?.[item.id] ?? []).some(action =>
        ["DELIVER", "REVISE_TERMS", "REASSIGN", "SUBDELEGATE"].includes(action))) ? <label>Actual response or contract change (JSON)
        <textarea aria-label="Actual workforce delivery or judgment" value={currentInput} maxLength={65536}
          onChange={event => setInput({ key, value: event.target.value })} /></label> : null}
      {rows.some(({ assignment: item }) => visible.availableActions?.[item.id]?.includes("SUBDELEGATE")) ? <p>
        Child requests specify kind (SUBDELEGATION or RECIPROCAL_REQUEST), recipientActorId, task, criterion and computation.
        The server binds the actual parent, original Work, deadline and existing budget. A new offer still needs acceptance.
        Paid or unmetered requests remain blocked until their canonical settlement mapping is available.</p> : null}
      {visible.currentCheck?.issues.length ? <details><summary>Current independent check gaps</summary>
        <ul>{visible.currentCheck.issues.map((issue, index) => <li key={index}>{issue.code}
          {issue.assignmentId ? ` · ${issue.assignmentId}` : ""}</li>)}</ul></details> : null}
    </> : null}
    <p>Ordinary native records only. Genuine human participation, protected qualification, method admission, field activation
      and economic improvement are not established by this view.</p>
  </section>
}
