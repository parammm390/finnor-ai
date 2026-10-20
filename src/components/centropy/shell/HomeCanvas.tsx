"use client"

import { lazy, Suspense, useEffect, useRef, useState } from "react"
import { ArrowRight } from "lucide-react"
import { z } from "zod"
import { centropyGet, centropyPost } from "@/components/centropy/lib/api"
import { usePrivateRequestScope } from "@/components/centropy/lib/use-private-request-scope"
import { ConversationThreadSummarySchema, type ConversationThreadSummary } from "../thread/thread-contract"

const WorkflowRecoveryDesk = lazy(() => import("../controls/WorkflowRecoveryDesk").then((module) => ({ default: module.WorkflowRecoveryDesk })))
const ArtifactCreationDesk = lazy(() => import("../controls/ArtifactCreationDesk").then((module) => ({ default: module.ArtifactCreationDesk })))
const SupportingReadDesk = lazy(() => import("../controls/SupportingReadDesk").then((module) => ({ default: module.SupportingReadDesk })))

const WorkSummarySchema = z.object({
  id: z.string().uuid(),
  status: z.string(),
  initialInstruction: z.string(),
  updatedAt: z.string().datetime(),
})
const AttentionSummarySchema = z.object({
  id: z.string(),
  workId: z.string().uuid(),
  kind: z.string(),
  reason: z.string(),
  nextHumanBoundary: z.object({ description: z.string() }),
})
type WorkSummary = z.infer<typeof WorkSummarySchema>
type AttentionSummary = z.infer<typeof AttentionSummarySchema>
type ReadState<T> = { data: T[]; error: string | null; status: "loading" | "ready" | "error" }

function dateLabel(value: string): string {
  return new Date(value).toLocaleDateString([], { month: "short", day: "numeric" })
}

export function HomeCanvas({ recent, recentError, onOpenInvestigation }: {
  recent: ConversationThreadSummary[]
  recentError: string | null
  onOpenInvestigation: (id: string) => void
}) {
  const [workflowOpen, setWorkflowOpen] = useState(false)
  const [artifactOpen, setArtifactOpen] = useState(false)
  const [supportingOpen, setSupportingOpen] = useState(false)
  const [works, setWorks] = useState<ReadState<WorkSummary>>({ data: [], error: null, status: "loading" })
  const [attention, setAttention] = useState<ReadState<AttentionSummary>>({ data: [], error: null, status: "loading" })
  const [attentionCoverage, setAttentionCoverage] = useState<string | null>(null)
  const [visibleWorks, setVisibleWorks] = useState(5)
  const [visibleAttention, setVisibleAttention] = useState(5)
  const [openingWorkId, setOpeningWorkId] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const opening = useRef(false)
  const scope = usePrivateRequestScope("centropy-home")

  useEffect(() => {
    let active = true
    void centropyGet<unknown>("works", { active: "true" }).then((result) => {
      if (!active) return
      const parsed = z.object({ works: z.array(WorkSummarySchema) }).parse(result)
      setWorks({ data: parsed.works, error: null, status: "ready" })
    }).catch((cause) => {
      if (active) setWorks({ data: [], error: cause instanceof Error ? cause.message : "Active Work unavailable", status: "error" })
    })
    void centropyGet<unknown>("read-models/attention", { limit: "100" }).then((result) => {
      if (!active) return
      const parsed = z.object({ data: z.object({ items: z.array(AttentionSummarySchema), sourceStatus: z.object({ status: z.string() }) }) }).parse(result)
      setAttention({ data: parsed.data.items, error: null, status: "ready" })
      setAttentionCoverage(parsed.data.sourceStatus.status)
    }).catch((cause) => {
      if (active) setAttention({ data: [], error: cause instanceof Error ? cause.message : "Attention unavailable", status: "error" })
    })
    return () => { active = false }
  }, [])

  async function openWork(workId: string) {
    if (opening.current || !scope.allowed) return
    const key = scope.key
    opening.current = true; setOpeningWorkId(workId); setOpenError(null)
    try {
      const response = await centropyPost<unknown>("threads", { workId })
      const { thread } = z.object({ thread: ConversationThreadSummarySchema }).parse(response)
      if (scope.isCurrent(key)) onOpenInvestigation(thread.id)
    } catch (cause) {
      if (scope.isCurrent(key)) setOpenError(cause instanceof Error ? cause.message : "This Work could not be opened")
    } finally {
      opening.current = false
      if (scope.isCurrent(key)) setOpeningWorkId(null)
    }
  }

  return <div className="ct-home">
    <header className="ct-home__intro"><span className="ct-eyebrow">YOUR WORKSPACE</span><h2>Pick up where work stands.</h2><p>The Thread is ready for a new question or objective. These records are live reads from your accessible workspace.</p></header>

    <section className="ct-home__section" aria-labelledby="ct-home-recent"><h3 id="ct-home-recent">Recent Investigations</h3>{recentError ? <p role="alert">{recentError}</p> : null}{recent.length ? <ol>{recent.slice(0, 5).map((item) => <li key={item.id}><button type="button" onClick={() => onOpenInvestigation(item.id)}><span><strong>{item.title || "Untitled Investigation"}</strong><small>{item.summary || (item.activeWorkId ? "Linked Work" : "Conversation thread")}</small></span><time dateTime={item.lastActivityAt}>{dateLabel(item.lastActivityAt)}</time><ArrowRight size={15} aria-hidden /></button></li>)}</ol> : <p>{recentError ? "Investigations could not be loaded." : "No Investigations yet. Your first objective begins in the Thread."}</p>}</section>

    {openError ? <p role="alert">{openError}</p> : null}
    {openingWorkId ? <p role="status">Opening the Work’s Investigation…</p> : null}
    <section className="ct-home__section" aria-labelledby="ct-home-work">
      <h3 id="ct-home-work">Work in motion</h3>
      {works.status === "loading" ? <p role="status">Loading active Work…</p> : null}
      {works.error ? <p role="alert">{works.error}</p> : null}
      {works.status === "ready" ? works.data.length ? <>
        <ol>{works.data.slice(0, visibleWorks).map(work => <li key={work.id}>
          <button type="button" disabled={Boolean(openingWorkId)} onClick={() => void openWork(work.id)}>
            <span><strong>{work.initialInstruction}</strong><small>{work.status.replaceAll("_", " ")} · Open Investigation</small></span>
            <time dateTime={work.updatedAt}>{dateLabel(work.updatedAt)}</time><ArrowRight size={15} aria-hidden />
          </button>
        </li>)}</ol>
        {works.data.length > visibleWorks ? <button type="button" className="ct-home__more" onClick={() => setVisibleWorks(count => count + 20)}>Show more Work ({works.data.length - visibleWorks} remaining)</button> : null}
      </> : <p>No active Work is recorded.</p> : null}
    </section>

    <section className="ct-home__section" aria-labelledby="ct-home-attention">
      <h3 id="ct-home-attention">Needs your attention</h3>
      {attention.status === "loading" ? <p role="status">Loading human attention…</p> : null}
      {attention.error ? <p role="alert">{attention.error}</p> : null}
      {attention.status === "ready" ? <>
        {attentionCoverage !== "complete" ? <p className="ct-home__coverage">Attention source coverage is {attentionCoverage ?? "unknown"}.</p> : null}
        {attention.data.length ? <>
          <ol>{attention.data.slice(0, visibleAttention).map(item => <li key={item.id}>
            <button type="button" disabled={Boolean(openingWorkId)} onClick={() => void openWork(item.workId)}>
              <span><strong>{item.reason}</strong><small>{item.nextHumanBoundary.description}</small></span><ArrowRight size={15} aria-hidden />
            </button>
          </li>)}</ol>
          {attention.data.length > visibleAttention ? <button type="button" className="ct-home__more" onClick={() => setVisibleAttention(count => count + 20)}>Show more attention items ({attention.data.length - visibleAttention} remaining)</button> : null}
        </> : <p>{attentionCoverage === "complete" ? "No human attention items are recorded." : "No items returned from the available attention sources."}</p>}
      </> : null}
    </section>
    <section className="ct-home__section"><details onToggle={(event) => setWorkflowOpen(event.currentTarget.open)}><summary>Inspect workflow recovery</summary>{workflowOpen ? <Suspense fallback={<p>Opening workflow recovery…</p>}><WorkflowRecoveryDesk /></Suspense> : null}</details></section>
    <section className="ct-home__section"><details onToggle={(event) => setArtifactOpen(event.currentTarget.open)}><summary>Create an artifact draft</summary>{artifactOpen ? <Suspense fallback={<p>Opening artifact creation…</p>}><ArtifactCreationDesk /></Suspense> : null}</details></section>
    <section className="ct-home__section"><details onToggle={(event) => setSupportingOpen(event.currentTarget.open)}><summary>Inspect supporting canonical records</summary>{supportingOpen ? <Suspense fallback={<p>Opening supporting records…</p>}><SupportingReadDesk /></Suspense> : null}</details></section>
  </div>
}
