"use client"

import { useMemo, useState, type FormEvent } from "react"
import { ArrowUpRight, CheckCircle2, Send, ShieldCheck } from "lucide-react"
import { jarvisPost } from "../lib/api"
import { usePeOperatingContext } from "./PeOperatingContextProvider"
import type { CompanyBrainObjectRef } from "./contracts"
import type { OperationalSurface } from "../surfaces/surface-routes"

interface PlannedAction {
  id: string
  actionType: string
  status?: string
  payload?: Record<string, unknown>
}

interface ActionResponse {
  planned?: PlannedAction[]
  answer?: { spokenSummary?: string; displaySummary?: string }
  workId?: string
  instructionId?: string
  threadId?: string
  objective?: { objectiveLoopId?: string; state?: string }
  projectionWarnings?: Array<{ stage: string; code: string }>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function canonicalEntity(ref: CompanyBrainObjectRef | null): { entityType: string; entityId: string } | null {
  return ref?.namespace === "private_equity" ? { entityType: ref.type, entityId: ref.id } : null
}

export function PeCommandComposer({ surface = "home" }: { surface?: OperationalSurface }) {
  const operating = usePeOperatingContext()
  const [instruction, setInstruction] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ActionResponse | null>(null)
  const root = operating.context.root
  const selected = canonicalEntity(operating.context.selectedObject)
  const selectedEntities = useMemo(() => {
    if (!root) return []
    const values = [{ entityType: root.entityType, entityId: root.entityId }, ...(selected ? [selected] : [])]
    return [...new Map(values.map((value) => [`${value.entityType}:${value.entityId}`, value])).values()]
  }, [root, selected])

  async function submit(event: FormEvent) {
    event.preventDefault()
    const text = instruction.trim()
    if (!text || !root || busy) return
    setBusy(true); setError(null); setResult(null)
    try {
      const instructionId = crypto.randomUUID()
      const response = await jarvisPost<ActionResponse>("actions", {
        instruction: text,
        channel: "text",
        instructionId,
        ...(operating.context.workId && UUID.test(operating.context.workId) ? { workId: operating.context.workId } : {}),
        activeContext: {
          version: 1,
          capturedAt: new Date().toISOString(),
          source: "text",
          ...(operating.context.workId && UUID.test(operating.context.workId) ? { activeWork: { workId: operating.context.workId } } : {}),
          ...(selected ? { focusedEntity: selected } : { focusedEntity: { entityType: root.entityType, entityId: root.entityId } }),
          selectedEntities,
          excludedEntities: [],
          surface: { id: surface, route: surface === "home" ? "/jarvis" : `/jarvis/${surface}`, spatialState: "detail" },
          filters: [],
        },
      })
      setResult(response)
      if (response.workId && UUID.test(response.workId)) operating.setWork(response.workId)
      setInstruction("")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The instruction could not be submitted.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="pe-command" aria-labelledby="pe-command-title">
      <div className="pe-command__heading"><span className="pe-command__signal"><ShieldCheck size={15} /></span><div><span className="pe-kicker">AUTHORITY-BOUND COMMAND</span><h2 id="pe-command-title">Move from question to governed Work.</h2></div></div>
      <form onSubmit={submit}>
        <label htmlFor={`pe-command-${surface}`}>Instruction</label>
        <textarea id={`pe-command-${surface}`} value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder={root ? "Ask about this context or describe the outcome you need." : "Select a canonical PE context before issuing an instruction."} disabled={!root || busy} rows={3} maxLength={10_000} />
        <footer><span>{root ? `${root.entityType} · ${root.entityId.slice(0, 8)}…${operating.context.workId ? ` · continuing Work ${operating.context.workId.slice(0, 8)}…` : ""}` : "No source-backed context selected"}</span><button type="submit" disabled={!root || !instruction.trim() || busy}>{busy ? "Planning…" : "Send to JARVIS"}<Send size={14} /></button></footer>
      </form>
      {error ? <div className="pe-command__error" role="alert">{error}</div> : null}
      {result ? <div className="pe-command__result" role="status"><CheckCircle2 size={16} /><div><strong>{result.answer?.displaySummary ?? result.answer?.spokenSummary ?? (result.planned?.length ? `${result.planned.length} action candidate${result.planned.length === 1 ? "" : "s"} recorded in Work.` : "Instruction recorded without a represented completion.")}</strong><p>{result.workId ? `Work ${result.workId}` : "No Work identifier returned."}{result.projectionWarnings?.length ? ` · ${result.projectionWarnings.length} projection warning${result.projectionWarnings.length === 1 ? "" : "s"}` : ""}</p>{result.workId && UUID.test(result.workId) ? <button type="button" onClick={() => operating.inspect({ kind: "work", workId: result.workId! })}>Inspect Work <ArrowUpRight size={13} /></button> : null}</div></div> : null}
    </section>
  )
}
