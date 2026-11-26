"use client"

import Link from "next/link"
import { ArrowLeft, ArrowRight, ArrowUpRight, ChevronDown, Copy, FileText, History, Inbox, ListChecks, LockKeyhole, LogOut, RefreshCw } from "lucide-react"
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react"
import { z } from "zod"
import { centropyGet } from "../lib/api"
import { useCentropyAuth } from "../lib/centropy-auth"
import { usePrivateRequestScope } from "../lib/use-private-request-scope"
import "./employee-desk.css"

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
const utcDate = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" })
const utcTime = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "short" })

type WorkItem = z.infer<typeof desk>["works"][number]
type Evidence = z.infer<typeof evidence>

function label(value: string) {
  const text = value.replaceAll("_", " ")
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function DeskFrame({ title, role, actions, children, back = false }: {
  title: string; role: string | null; actions?: ReactNode; children: ReactNode; back?: boolean;
}) {
  return <main className="ct-app ct-employee-desk">
    <header className="ed-bar">
      <div className="ed-bar-inner">
        <div className="ed-brand"><span className="ed-brand-mark" aria-hidden="true" />CENTROPY<span className="ed-bar-divider" /> <span>Employee workspace</span></div>
        <span className="ed-pilot"><span aria-hidden="true" />Pilot · synthetic data</span>
      </div>
    </header>
    <div className="ed-content">
      {back && <Link className="ed-back" href="/centropy/desk"><ArrowLeft size={16} aria-hidden="true" /> Back to desk</Link>}
      <div className="ed-intro">
        <div><p className="ct-eyebrow">{back ? "READ-ONLY RECORD" : "PERSONAL WORKSPACE"}</p><h1>{title}</h1>
          <p className="ed-muted">{role ? `${label(role)} · ` : ""}{back ? "Your exact Work record" : "Work assigned to or owned by you"}</p></div>
        {actions && <div className="ed-actions">{actions}</div>}
      </div>
      {children}
    </div>
  </main>
}

function Skeleton({ message }: { message: string }) {
  return <div className="ed-card ed-skeleton" role="status">
    <span className="ct-visually-hidden">{message}</span>
    <i aria-hidden="true" /><i aria-hidden="true" /><i aria-hidden="true" />
  </div>
}

function Status({ status }: { status: string }) {
  return <span className="ed-status" data-status={status}><i aria-hidden="true" />{label(status)}</span>
}

function Updated({ value }: { value: string }) {
  const delta = new Date(value).getTime() - Date.now()
  const minutes = Math.trunc(delta / 60_000)
  const days = Math.trunc(minutes / 1440)
  const hours = Math.trunc(minutes / 60)
  const text = days ? relative.format(days, "day") : hours ? relative.format(hours, "hour")
    : minutes ? relative.format(minutes, "minute") : "just now"
  return <time className="ed-muted" dateTime={value} title={value}>Updated {text}</time>
}

function CopyField({ name, value }: { name: string; value: string }) {
  const [feedback, setFeedback] = useState("")
  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      setFeedback("Copied")
    } catch {
      setFeedback("Couldn’t copy")
    }
  }
  return <div className="ed-copy"><span>{name}</span><code title={value}>{value}</code>
    <button type="button" className="ed-copy-action" onClick={() => void copy()} aria-label={`Copy ${name}`}><Copy size={14} aria-hidden="true" /></button>
    <span role="status" className={feedback ? "ed-copy-feedback" : "ct-visually-hidden"}>{feedback && `${feedback}: ${name}`}</span>
  </div>
}

function Provenance({ items }: { items: Evidence[] }) {
  return <details className="ed-disclosure">
    <summary><FileText size={15} aria-hidden="true" /> Provenance <ChevronDown className="ed-chevron" size={15} aria-hidden="true" /></summary>
    <div className="ed-provenance">{items.map(item => <div className="ed-provenance-source" key={item.sourceId}>
      <CopyField name="Source ID" value={item.sourceId} />
      <CopyField name="Cited version ID" value={item.cited.id} />
      <CopyField name="Cited hash" value={item.cited.contentHash} />
      {item.changed && <><CopyField name="Latest version ID" value={item.current.id} /><CopyField name="Latest hash" value={item.current.contentHash} /></>}
    </div>)}</div>
  </details>
}

function Activity({ events }: { events: WorkItem["events"] }) {
  const lines = (rows: WorkItem["events"]) => rows.map(event => <li key={event.sequence}>
    <span>{label(event.type)}</span><time dateTime={event.createdAt} title={event.createdAt}>{utcTime.format(new Date(event.createdAt))} UTC</time>
  </li>)
  return <section className="ed-activity" aria-label="Recent activity">
    <h3><History size={16} aria-hidden="true" /> Recent activity</h3>
    {events.length ? <><ol>{lines(events.slice(0, 3))}</ol>
      {events.length > 3 && <details className="ed-disclosure">
        <summary>{events.length - 3} earlier {events.length === 4 ? "event" : "events"}<ChevronDown className="ed-chevron" size={15} aria-hidden="true" /></summary>
        <ol start={4}>{lines(events.slice(3))}</ol>
      </details>}</> : <p className="ed-muted">No Work events recorded yet.</p>}
  </section>
}

function WorkCard({ work }: { work: WorkItem }) {
  return <article className="ed-card">
    <header className="ed-card-head"><div><span className="ed-caption">WORK ITEM</span><h2>{work.instruction}</h2></div>
      <div className="ed-card-meta"><Status status={work.status} /><Updated value={work.updatedAt} /></div>
    </header>
    <div className="ed-detail-grid">
      <section className="ed-detail" aria-label="What changed">
        <span className="ed-detail-icon ed-change-icon"><ArrowUpRight size={17} aria-hidden="true" /></span>
        <div><h3>What changed</h3>
          {work.evidence.length ? <ul>{work.evidence.map(item => <li key={item.sourceId}>
            <strong>Exhibit · {item.changed ? <>v{item.cited.versionNumber} <span className="ed-version-arrow">→</span> v{item.current.versionNumber}</> : <>v{item.cited.versionNumber}</>}</strong>
            <p>Cited <time dateTime={item.cited.asOf} title={item.cited.asOf}>{utcDate.format(new Date(item.cited.asOf))}</time>
              {item.changed ? <> <span aria-hidden="true">·</span> Latest <time dateTime={item.current.asOf} title={item.current.asOf}>{utcDate.format(new Date(item.current.asOf))}</time></> : " · No newer version recorded"}</p>
          </li>)}</ul> : <p>No exhibit versions recorded on this Work.</p>}
        </div>
      </section>
      <section className="ed-detail" aria-label="Next step">
        <span className="ed-detail-icon ed-review-icon"><ListChecks size={17} aria-hidden="true" /></span>
        <div><h3>Next step</h3>
          {work.approvals.length ? <ul>{work.approvals.map(approval => <li key={approval.actionId}>
            <strong>{approval.summary || label(approval.actionType)}</strong>
            <p>Step {approval.sequence} · Reviewer needs <code>{approval.approverCapability}</code></p>
          </li>)}</ul> : <p>No decision awaiting review.</p>}
        </div>
      </section>
    </div>
    <div className="ed-card-actions"><Link className="ed-primary" href={work.href}>Open Work <ArrowRight size={16} aria-hidden="true" /></Link>
      {work.evidence.length > 0 && <Provenance items={work.evidence} />}
    </div>
    <Activity events={work.events} />
  </article>
}

function DeskItems({ works }: { works: WorkItem[] }) {
  const changed = works.filter(work => work.evidence.some(item => item.changed)).length
  const pending = works.reduce((count, work) => count + work.approvals.length, 0)
  return <>
    <section className="ed-summary" aria-label="Needs you"><span className="ed-summary-mark" aria-hidden="true" />
      <h2>Needs you</h2><p>{changed} {changed === 1 ? "item" : "items"} changed <span aria-hidden="true">·</span> {pending} {pending === 1 ? "decision" : "decisions"} awaiting review</p>
    </section>
    <section className="ed-items" aria-label="Your Work">
      {works.length ? works.map(work => <WorkCard key={work.id} work={work} />) :
        <div className="ed-card ed-empty"><span className="ed-detail-icon"><Inbox size={21} aria-hidden="true" /></span>
          <h2>No Work on your desk yet</h2><p>Work will show up here when it’s assigned to you or you become its owner.</p>
        </div>}
    </section>
    <p className="ed-boundary"><LockKeyhole size={14} aria-hidden="true" /> Exhibit content opens under your existing authority.</p>
  </>
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
  const loading = !mounted || auth.loading || auth.roleLoading
  return <DeskFrame title="Your desk" role={mounted ? auth.role : null} actions={mounted && (auth.session ? <>
    <button type="button" disabled={!allowed} onClick={scope.invalidate}><RefreshCw size={16} aria-hidden="true" /> Refresh</button>
    <button type="button" onClick={() => void auth.signOut()}><LogOut size={16} aria-hidden="true" /> Sign out</button>
  </> : !auth.loading && <Link href="/centropy/login">Sign in</Link>)}>
    {loading || (allowed && !current) ? <Skeleton message="Loading your employee desk…" /> :
      !allowed ? <p className="ed-card ed-message" role="status">{auth.roleError ?? auth.authError ??
        (!scope.available ? "Your desk is unavailable while offline or in the background." : auth.session ? "Your desk is unavailable." : "Sign in to see your desk.")}</p> :
      current?.data ? <DeskItems key={key} works={current.data.works} /> :
      <p className="ed-card ed-message" role="alert">Your desk is unavailable. Try refreshing.</p>}
  </DeskFrame>
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
  const loading = !mounted || auth.loading || auth.roleLoading
  return <DeskFrame title="Work record" role={mounted ? auth.role : null} back>
    {loading ? <Skeleton message="Loading your Work record…" />
      : !workId ? <p className="ed-card ed-message" role="alert">Work not found or unavailable.</p>
      : !allowed ? <p className="ed-card ed-message" role="status">{auth.roleError ?? auth.authError ??
        (auth.session ? "Your Work record is unavailable." : <Link href="/centropy/login">Sign in to view Work</Link>)}</p>
      : !current ? <Skeleton message="Loading your Work record…" />
      : !current.work ? <p className="ed-card ed-message" role="alert">Work not found or unavailable.</p>
      : <article className="ed-card">
        <header className="ed-card-head"><div><span className="ed-caption">INSTRUCTION</span><h2>{current.work.instruction}</h2></div><Status status={current.work.status} /></header>
        <div className="ed-work-updated"><History size={17} aria-hidden="true" /><div><h3>Last updated</h3>
          <time dateTime={current.work.updatedAt} title={current.work.updatedAt}>{utcTime.format(new Date(current.work.updatedAt))} UTC</time></div></div>
      </article>}
  </DeskFrame>
}
