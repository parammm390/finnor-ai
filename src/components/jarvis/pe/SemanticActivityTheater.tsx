"use client"

import { useMemo, useRef } from "react"
import { Activity, ArrowLeft, ArrowRight, CheckCircle2, CircleAlert, LoaderCircle } from "lucide-react"
import { usePeOperatingContext } from "./PeOperatingContextProvider"
import { humanize, isInspectionTarget, type SemanticActivityBucket, type SemanticActivityItem, type SemanticActivityProjection } from "./contracts"

const BUCKETS: Array<{ key: SemanticActivityBucket; label: string; icon: typeof Activity }> = [
  { key: "needs_attention", label: "Needs attention", icon: CircleAlert },
  { key: "in_motion", label: "In motion", icon: LoaderCircle },
  { key: "verified_outcomes", label: "Verified outcomes", icon: CheckCircle2 },
]

function ActivityItem({ item }: { item: SemanticActivityItem }) {
  const operating = usePeOperatingContext()
  if (!isInspectionTarget(item.inspectionTarget)) return null
  return (
    <button type="button" className="pe-activity-item" onClick={() => operating.inspect(item.inspectionTarget, item.subjectRef)}>
      <span className="pe-activity-item__time">{new Date(item.occurredAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
      <strong>{item.change.label}</strong>
      <p>{humanize(item.subjectRef.type)} · {item.subjectRef.id.slice(0, 8)}…</p>
      <div><span>{item.actor}{item.actorRef ? ` · ${item.actorRef.id.slice(0, 12)}` : ""}</span><span>{item.causalRefs.length ? `${item.causalRefs.length} persisted cause${item.causalRefs.length === 1 ? "" : "s"}` : "no persisted cause"}</span></div>
      <small>{item.sourceRefs.map((source) => `${source.table}:${source.id.slice(0, 8)}…`).join(" · ")}</small>
    </button>
  )
}

export function SemanticActivityTheater({ projection }: { projection: SemanticActivityProjection }) {
  const itemIndex = useMemo(() => new Map(projection.items.map((item) => [item.id, item])), [projection.items])
  const carousel = useRef<HTMLDivElement>(null)
  const outcomes = projection.items.filter((item) => item.bucket === "verified_outcomes")
  const move = (direction: -1 | 1) => carousel.current?.scrollBy({ left: direction * Math.max(280, carousel.current.clientWidth * 0.72), behavior: "smooth" })
  return (
    <section className="pe-activity" id="semantic-activity" aria-labelledby="semantic-activity-title">
      <header className="pe-section-heading"><div><span className="pe-kicker">SEMANTIC ACTIVITY</span><h2 id="semantic-activity-title">Causal change, grouped by operating consequence.</h2></div><p>{projection.bounds.returned} of {projection.bounds.total} source-backed events · as of {new Date(projection.asOf).toLocaleString()}{projection.bounds.truncated ? " · bounded" : ""}</p></header>
      <div className="pe-activity__buckets">{BUCKETS.map(({ key, label, icon: Icon }) => {
        const group = projection.groups.find((candidate) => candidate.bucket === key)
        const count = projection.items.filter((item) => item.bucket === key).length
        return <section key={key} className="pe-activity-bucket" data-bucket={key}><header><Icon size={14} /><strong>{label}</strong><span>{count}</span></header>{!group || count === 0 ? <p className="pe-activity-bucket__empty">Known empty for this root.</p> : group.roots.map((root) => <div key={`${root.root.entityType}:${root.root.entityId}`} className="pe-activity-root"><small>{humanize(root.root.entityType)} · {root.root.entityId.slice(0, 8)}…</small>{root.threads.map((thread) => <div className="pe-activity-thread" key={thread.id}><span>{thread.id.replaceAll("_", " ")}</span>{thread.itemIds.map((id) => itemIndex.get(id)).filter((item): item is SemanticActivityItem => Boolean(item)).map((item) => <ActivityItem key={item.id} item={item} />)}</div>)}</div>)}</section>
      })}</div>
      <section className="pe-evidence-carousel" aria-label="Verified decision and evidence outcomes">
        <header><div><span className="pe-kicker">DECISION + EVIDENCE SIGNAL</span><h3>Verified outcomes, without inferred praise.</h3></div><div><button type="button" onClick={() => move(-1)} aria-label="Previous verified outcomes"><ArrowLeft size={14} /></button><button type="button" onClick={() => move(1)} aria-label="Next verified outcomes"><ArrowRight size={14} /></button></div></header>
        <div ref={carousel} className="pe-evidence-carousel__track">{outcomes.length ? outcomes.map((item) => <ActivityItem key={item.id} item={item} />) : <p>Known empty: no receipt, proof, or final Decision is represented in this projection.</p>}</div>
      </section>
    </section>
  )
}
