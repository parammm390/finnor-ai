"use client"

import { useEffect, useState } from "react"
import { Pause, Play, RotateCcw } from "lucide-react"
import { centropyGet, centropyPost, CentropyApiError } from "@/components/centropy/lib/api"

interface Objective { id: string; workId: string; state: string; objective: string; reason: string | null; revision: number; nextStep: string | null }

export function ObjectiveControl({ workId, workStatus, refreshToken, redirecting, onRedirectToggle, onChanged }: {
  workId: string
  workStatus?: string | null
  refreshToken: number
  redirecting: boolean
  onRedirectToggle: () => void
  onChanged: () => void
}) {
  const [objective, setObjective] = useState<Objective | null>(null)
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    setObjective(null); setStatus("loading"); setError(null)
    void centropyGet<{ objective: Objective }>(`works/${workId}/objective`).then((result) => {
      if (!active) return
      if (!result.objective || result.objective.workId !== workId) throw new Error("Objective response did not match this Work")
      setObjective(result.objective); setStatus("ready")
    }).catch((cause) => {
      if (!active) return
      setStatus("unavailable")
      if (!(cause instanceof CentropyApiError && cause.status === 404)) setError(cause instanceof Error ? cause.message : "Objective state unavailable")
    })
    return () => { active = false }
  }, [refreshToken, workId])

  async function control(command: "interrupt" | "continue") {
    if (busy) return
    setBusy(true); setError(null)
    try {
      const response = await centropyPost<{ objective: Objective }>(`works/${workId}/objective`, { command })
      if (!response.objective || response.objective.workId !== workId) throw new Error("Objective control returned a different Work")
      setObjective(response.objective)
      onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Objective control failed") }
    finally { setBusy(false) }
  }

  if (status === "loading") return <p className="ct-objective__loading" role="status">Reading Objective control state…</p>
  if (!objective) return error ? <p className="ct-objective__error" role="alert">Objective controls unavailable: {error}</p> : null
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
