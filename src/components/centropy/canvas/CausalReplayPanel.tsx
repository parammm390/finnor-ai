"use client"

import { useEffect, useMemo, useState } from "react"
import { ArrowLeft, ArrowRight, GitBranch, RefreshCw } from "lucide-react"
import { centropyGet } from "@/components/centropy/lib/api"
import { CausalReplaySchema, causalPathRows, type CausalReplay } from "./causal-replay-contract"

type Tab = "path" | "moments" | "gaps"
const narrations = ["trigger", "context", "plan", "governance", "execution", "verification", "outcome"] as const
const label = (value: string) => value.replaceAll("_", " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase()

export function CausalReplayPanel({ workId, onClose, returnLabel = "Canvas" }: { workId: string; onClose: () => void; returnLabel?: string }) {
  const [replay, setReplay] = useState<CausalReplay | null>(null)
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [tab, setTab] = useState<Tab>("path")
  const [visibleEdges, setVisibleEdges] = useState(24)

  useEffect(() => {
    let active = true
    setReplay(null); setStatus("loading"); setError(null); setTab("path"); setVisibleEdges(24)
    void centropyGet<unknown>(`works/${workId}/replay`).then((result) => {
      if (!active) return
      const parsed = CausalReplaySchema.parse((result as { replay?: unknown })?.replay)
      if (parsed.work.id !== workId) throw new Error("Replay response did not match the selected Work")
      setReplay(parsed); setStatus("ready")
    }).catch((cause) => {
      if (active) { setStatus("error"); setError(cause instanceof Error ? cause.message : "Causal replay unavailable") }
    })
    return () => { active = false }
  }, [revision, workId])

  const paths = useMemo(() => replay ? causalPathRows(replay) : [], [replay])
  return <div className="ct-replay">
    <header className="ct-replay__header"><button type="button" onClick={onClose}><ArrowLeft size={16} /> {returnLabel}</button><div><span className="ct-eyebrow">CAUSAL REPLAY / READ ONLY</span><h2>Why did this happen?</h2></div><button type="button" onClick={() => setRevision((value) => value + 1)} aria-label="Refresh causal replay" disabled={status === "loading"}><RefreshCw size={16} /></button></header>
    {status === "loading" ? <p role="status">Reading the durable causal projection…</p> : null}
    {error ? <div className="ct-canvas__invalid" role="alert"><h3>Replay unavailable</h3><p>{error}</p><button type="button" onClick={() => setRevision((value) => value + 1)}>Retry</button></div> : null}
    {replay ? <>
      <p className="ct-replay__objective">{replay.work.objective}</p>
      <div className="ct-replay__meta"><span>{replay.work.status.replaceAll("_", " ")}</span><span>{replay.completeness.status === "complete" ? "complete" : "incomplete"} coverage</span><span>{replay.completeness.provenEdges} proven · {replay.completeness.missingEdges} missing links</span><time dateTime={replay.asOf}>As of {new Date(replay.asOf).toLocaleString()}</time></div>
      <p className="ct-replay__scope">Plan and execution here describe recorded Work actions. The Thread shows instruction phases separately.</p>
      <div className="ct-replay__narrative">{narrations.map((section) => replay.explanation[section] ? <div key={section}><span>{label(section)}</span><p>{replay.explanation[section]}</p></div> : null)}</div>
      <nav className="ct-replay__tabs" aria-label="Replay views"><button type="button" aria-current={tab === "path" ? "page" : undefined} onClick={() => setTab("path")}>Causal path</button><button type="button" aria-current={tab === "moments" ? "page" : undefined} onClick={() => setTab("moments")}>Recorded moments</button><button type="button" aria-current={tab === "gaps" ? "page" : undefined} onClick={() => setTab("gaps")}>Missing links</button></nav>
      {tab === "path" ? <section className="ct-replay__path"><h3><GitBranch size={18} /> Backend declared relationships</h3><p>Only recorded edges establish causality here. A nearby timestamp does not create a link.</p>{paths.length ? <>{paths.slice(0, visibleEdges).map((path) => <div className="ct-replay__edge" data-certainty={path.certainty} key={path.id}><div><span>{path.fromStage ? label(path.fromStage) : "source"}</span><strong>{path.from}</strong></div><div className="ct-replay__edge-link"><span>{label(path.relation)}</span><ArrowRight size={16} /><small>{path.certainty}{path.evidenceCount ? ` · ${path.evidenceCount} evidence refs` : ""}</small></div><div><span>{path.toStage ? label(path.toStage) : "target"}</span><strong>{path.to}</strong></div>{path.explanation ? <p>{path.explanation}</p> : null}</div>)}{paths.length > visibleEdges ? <button className="ct-replay__more" type="button" onClick={() => setVisibleEdges((value) => value + 24)}>Show next {Math.min(24, paths.length - visibleEdges)} of {paths.length} links</button> : null}</> : <p>No causal edges are represented in this projection.</p>}</section> : null}
      {tab === "moments" ? <section className="ct-replay__moments"><h3>Recorded moments</h3><p>These events are ordered in time. Open Causal path for relationships between them.</p>{replay.moments.map((moment, index) => <div key={`${moment.at}:${index}`}><time dateTime={moment.at}>{new Date(moment.at).toLocaleString()}</time><strong>{moment.headline}</strong><span>{label(moment.stage)} · {moment.nodeIds.length} linked node{moment.nodeIds.length === 1 ? "" : "s"}</span></div>)}{!replay.moments.length ? <p>No recorded moments were returned.</p> : null}</section> : null}
      {tab === "gaps" ? <section className="ct-replay__gaps"><h3>Representation gaps</h3>{[...new Set([...replay.explanation.gaps, ...replay.completeness.missing])].map((gap, index) => <p key={`${gap}:${index}`}>{gap}</p>)}{!replay.explanation.gaps.length && !replay.completeness.missing.length ? <p>No gap is reported within the backend projection’s bounds.</p> : null}{Object.values(replay.truncated).some(Boolean) ? <p>Projection bounds truncated part of the history.</p> : null}</section> : null}
    </> : null}
  </div>
}
