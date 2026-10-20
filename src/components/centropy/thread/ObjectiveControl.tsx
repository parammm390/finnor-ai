"use client"

import { useState } from "react"
import { Pause, Play, RotateCcw } from "lucide-react"
import { centropyPost } from "@/components/centropy/lib/api"
import type { WorkAggregateView } from "../product/contracts"

export function ObjectiveControl({ workId, source, redirecting, onRedirectToggle, onChanged }: {
  workId: string
  source: { data: WorkAggregateView | null; status: "idle" | "loading" | "ready" | "error"; error: string | null }
  redirecting: boolean
  onRedirectToggle: () => void
  onChanged: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function control(command: "interrupt" | "continue") {
    if (busy) return
    setBusy(true); setError(null)
    try {
      const response = await centropyPost<{ objective: NonNullable<WorkAggregateView["objectiveLoop"]> }>(`works/${workId}/objective`, { command })
      if (!response.objective || response.objective.workId !== workId) throw new Error("Objective control returned a different Work")
      onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Objective control failed") }
    finally { setBusy(false) }
  }

  if (source.status === "loading" || source.status === "idle") return <p className="ct-objective__loading" role="status">Reading Objective control state…</p>
  if (source.status === "error") return <p className="ct-objective__error" role="alert">Objective controls unavailable: {source.error}</p>
  const work = source.data
  if (!work || work.work.id !== workId) return <p className="ct-objective__error" role="alert">Objective controls unavailable: Work response did not match this Investigation.</p>
  const objective = work.objectiveLoop
  if (!objective) return null
  if (objective.workId !== workId) return <p className="ct-objective__error" role="alert">Objective controls unavailable: Objective response did not match this Work.</p>
  const workStatus = work.work.status
  const terminal = objective.state === "completed" || objective.state === "cancelled"
  const blocked = objective.state === "blocked" || objective.state === "failed"
  const workTerminal = workStatus === "completed" || workStatus === "failed" || workStatus === "cancelled"
  const needsWorkRecovery = workStatus === "failed" || workStatus === "recovery"
  return <section className="ct-objective" aria-label="Durable Objective controls">
    <div className="ct-objective__top"><span>OBJECTIVE · REVISION {objective.revision}</span><strong>{objective.state.replaceAll("_", " ")}</strong></div>
    <p>{objective.objective}</p>
    {objective.reason ? <small>{objective.reason}</small> : null}
    {workTerminal && !terminal && !blocked ? <p className="ct-objective__mismatch" role="status">Work is {workStatus}, while this Objective still reports {objective.state}. These are separate persisted states; inspect Work and recovery before proceeding.</p> : null}
    {needsWorkRecovery ? <p className="ct-objective__mismatch" role="status">Recover this Work through its recorded retry control before continuing the Objective.</p> : null}
    {!terminal && !needsWorkRecovery ? <div className="ct-objective__actions">
      {blocked ? <button type="button" onClick={() => void control("continue")} disabled={busy}><Play size={14} /> Continue</button> : <button type="button" onClick={() => void control("interrupt")} disabled={busy}><Pause size={14} /> Interrupt</button>}
      <button type="button" onClick={onRedirectToggle} aria-pressed={redirecting} disabled={busy}><RotateCcw size={14} /> Redirect</button>
    </div> : null}
    {error ? <p className="ct-objective__error" role="alert">{error}</p> : null}
  </section>
}
