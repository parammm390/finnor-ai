"use client"

import Link from "next/link"
import { useEffect, useState, useSyncExternalStore } from "react"
import { z } from "zod"
import { centropyGet } from "../lib/api"
import { useCentropyAuth } from "../lib/centropy-auth"
import { usePrivateRequestScope } from "../lib/use-private-request-scope"
import "../centropy-theme.css"

const version = z.object({
  id: z.string().uuid(), versionNumber: z.number().int(), contentHash: z.string(), asOf: z.string().datetime(),
})
const evidence = z.object({ sourceId: z.string().uuid(), changed: z.boolean(), cited: version, current: version })
const workRecord = z.object({
  id: z.string().uuid(), instruction: z.string(), status: z.string(), updatedAt: z.string().datetime(),
})
const desk = z.object({ works: z.array(workRecord.extend({
  href: z.string().regex(/^\/centropy\/desk\/work\?workId=[0-9a-f-]{36}$/i),
  evidence: z.array(evidence),
  events: z.array(z.object({ sequence: z.number(), type: z.string(), status: z.string(), createdAt: z.string().datetime() })),
  approvals: z.array(z.object({
    actionId: z.string().uuid(), actionType: z.string(), summary: z.string().nullable(),
    sequence: z.number(), approverCapability: z.string(),
  })),
})) })

const subscribeToMount = () => () => {}
const clientMounted = () => true
const serverMounted = () => false

function EvidenceVersion({ label, value }: { label: string; value: z.infer<typeof version> }) {
  return <p>{label}: version {value.versionNumber} · as of <time dateTime={value.asOf}>{value.asOf}</time><br />
    Version ID: <code>{value.id}</code><br />
    Hash: <code style={{ overflowWrap: "anywhere" }}>{value.contentHash}</code></p>
}

function Citation({ item, href }: { item: z.infer<typeof evidence>; href: string }) {
  return <li>
    <h4>Source <code>{item.sourceId}</code> · {item.changed ? `changed v${item.cited.versionNumber}→v${item.current.versionNumber}` : "No newer version recorded on Work"}</h4>
    <EvidenceVersion label="Cited" value={item.cited} />
    {item.changed && <EvidenceVersion label="Latest recorded on Work" value={item.current} />}
    <Link href={href}>Open Work</Link>
  </li>
}

export function EmployeeDesk() {
  const mounted = useSyncExternalStore(subscribeToMount, clientMounted, serverMounted)
  const auth = useCentropyAuth()
  const scope = usePrivateRequestScope("employee-desk", "WORKFORCE_PARTICIPANT")
  const { allowed, key, isCurrent } = scope
  const [read, setRead] = useState<{ key: string; data: z.infer<typeof desk> | null } | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    if (allowed) void centropyGet("me/desk", undefined, controller.signal).then(value => {
      const data = desk.parse(value)
      if (!controller.signal.aborted && isCurrent(key)) setRead({ key, data })
    }).catch(() => {
      if (!controller.signal.aborted && isCurrent(key)) setRead({ key, data: null })
    })
    return () => controller.abort()
  }, [allowed, key, isCurrent])
  const current = scope.allowed && read?.key === scope.key ? read : null
  return <main className="ct-auth-state ct-employee-desk">
    <h1>What changed on work I’m responsible for?</h1>
    <p>A private, read-only view of up to 20 recently updated Work items assigned to you or owned by you.</p>
    <p>Exhibit content opens under your existing authority.</p>
    {mounted && (auth.session ? <button type="button" onClick={() => void auth.signOut()}>Sign out</button> : <Link href="/centropy/login">Sign in</Link>)}
    {!mounted ? <p role="status">Loading your employee desk…</p> :
      !scope.allowed ? <p role="status">{auth.roleError ?? auth.authError ??
      (scope.available ? "Sign in to see your desk." : "Your desk is unavailable while offline or in the background.")}</p> : <>
      <p><button type="button" onClick={scope.invalidate}>Refresh desk</button></p>
      {!current ? <p role="status">Reading your desk…</p> :
        !current.data ? <p role="alert">Your desk is unavailable. Try refreshing.</p> :
        !current.data.works.length ? <p>No Work is currently assigned to or owned by you.</p> :
        current.data.works.map(work => <article key={scope.key + work.id}>
          <h2><Link href={work.href}>{work.instruction}</Link></h2>
          <p>{work.status.replaceAll("_", " ")} · Work updated <time dateTime={work.updatedAt}>{work.updatedAt}</time></p>
          <h3>Evidence</h3>
          {work.evidence.length ? <ul>{work.evidence.map(item => <Citation key={item.sourceId} item={item} href={work.href} />)}</ul>
            : <p>No evidence versions recorded in this Work’s recent evidence events.</p>}
          <h3>Decisions awaiting review</h3>
          {work.approvals.length ? <ul>{work.approvals.map(approval => <li key={approval.actionId}>
            {approval.summary || approval.actionType} — step {approval.sequence} needs a reviewer with <code>{approval.approverCapability}</code>.
          </li>)}</ul> : <p>No pending authority step found.</p>}
          <h3>Recent activity</h3>
          {work.events.length ? <ul>{work.events.map(event => <li key={event.sequence}>
            {event.type.replaceAll("_", " ")} · <time dateTime={event.createdAt}>{event.createdAt}</time>
          </li>)}</ul> : <p>No recent Work events.</p>}
        </article>)}
    </>}
  </main>
}

export function EmployeeDeskWork({ workId }: { workId: string | null }) {
  const mounted = useSyncExternalStore(subscribeToMount, clientMounted, serverMounted)
  const auth = useCentropyAuth()
  const { allowed, key, isCurrent } = usePrivateRequestScope("employee-desk-work:" + workId, "WORKFORCE_PARTICIPANT")
  const [read, setRead] = useState<{ key: string; work: z.infer<typeof workRecord> | null } | null>(null)
  useEffect(() => {
    if (!allowed || !workId) return
    const controller = new AbortController()
    void centropyGet(`works/${workId}`, { view: "desk" }, controller.signal).then(value => {
      const { work } = z.object({ work: workRecord }).parse(value)
      if (work.id !== workId) throw new Error("Work ID did not match")
      if (!controller.signal.aborted && isCurrent(key)) setRead({ key, work })
    }).catch(() => {
      if (!controller.signal.aborted && isCurrent(key)) setRead({ key, work: null })
    })
    return () => controller.abort()
  }, [allowed, key, isCurrent, workId])
  const current = allowed && read?.key === key ? read : null
  return <main className="ct-auth-state ct-employee-desk">
    <p><Link href="/centropy/desk">Back to employee desk</Link></p>
    <h1>Work record</h1>
    {!mounted ? <p role="status">Loading your Work record…</p>
      : !workId ? <p role="alert">Work not found or unavailable.</p>
      : !allowed ? <p role="status">{auth.roleError ?? auth.authError ??
        (auth.session ? "Your Work record is unavailable." : <Link href="/centropy/login">Sign in to view Work</Link>)}</p>
      : !current ? <p role="status">Reading the exact Work record…</p>
      : !current.work ? <p role="alert">Work not found or unavailable.</p>
      : <article>
        <h2>{current.work.instruction}</h2>
        <p>Status: {current.work.status.replaceAll("_", " ")}</p>
        <p>Last updated <time dateTime={current.work.updatedAt}>{current.work.updatedAt}</time></p>
      </article>}
  </main>
}
