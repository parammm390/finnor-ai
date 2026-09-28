"use client"

import { Activity, ChevronDown, Square } from "lucide-react"
import { instructionEventDisplay } from "@/components/centropy/product/instruction-event-model"
import type { InstructionTraceSnapshot } from "../runtime/instruction-events"

export function ExecutionObject({ trace, stopping, onStop, canonicalWorkStatus, restoringHistory = false }: {
  trace: InstructionTraceSnapshot
  stopping: boolean
  onStop: () => void
  canonicalWorkStatus?: string | null
  restoringHistory?: boolean
}) {
  const latest = trace.events.at(-1)
  const display = latest ? instructionEventDisplay(latest) : null
  const canonicalTerminal = canonicalWorkStatus === "completed" || canonicalWorkStatus === "failed" || canonicalWorkStatus === "cancelled"
  const awaitingHistory = (canonicalTerminal || restoringHistory) && !trace.terminal && trace.events.length === 0
  return <section className="ct-execution" aria-label="Persisted instruction execution">
    <div className="ct-execution__summary">
      <span className="ct-execution__pulse" data-terminal={trace.terminal || canonicalTerminal || undefined}><Activity size={15} aria-hidden /></span>
      <div>
        <strong>{canonicalTerminal && !trace.terminal ? `Work ${canonicalWorkStatus}` : awaitingHistory ? "Checking persisted instruction history" : display?.title ?? "Waiting for the first persisted event"}</strong>
        <span>{awaitingHistory ? "Reading the saved events for this instruction." : canonicalTerminal && !trace.terminal ? `Canonical Work is terminal; ${trace.events.length} instruction event${trace.events.length === 1 ? "" : "s"} are recorded.` : display?.detail ?? (trace.events.length ? `Event ${trace.sequence}` : "The instruction trace is connecting")}</span>
      </div>
      {!trace.terminal && !canonicalTerminal && !awaitingHistory ? <button type="button" onClick={onStop} disabled={stopping} aria-label="Stop this instruction"><Square size={13} aria-hidden /> {stopping ? "Stopping" : "Stop"}</button> : null}
    </div>
    {trace.error ? <p className="ct-execution__error">Trace connection: {trace.error}. {trace.transport === "poll" ? "Reading persisted events by polling." : "Reconnecting."}</p> : null}
    {trace.events.length ? <details className="ct-execution__details">
      <summary><ChevronDown size={14} aria-hidden /> Inspect {trace.events.length} recorded event{trace.events.length === 1 ? "" : "s"}</summary>
      <ol>{trace.events.map((event) => {
        const row = instructionEventDisplay(event)
        return <li key={event.seq} data-tone={row.tone}><span>{String(event.seq).padStart(2, "0")}</span><div><strong>{row.title}</strong>{row.detail ? <p>{row.detail}</p> : null}</div><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></li>
      })}</ol>
    </details> : null}
  </section>
}
