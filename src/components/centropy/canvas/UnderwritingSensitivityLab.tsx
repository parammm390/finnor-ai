"use client"

import { useState, type FormEvent } from "react"
import { z } from "zod"
import { centropyGet, centropyPost } from "@/components/centropy/lib/api"
import type { UnderwritingRun, UnderwritingWorkspace } from "@/components/centropy/product/contracts"
import { formatUnderwritingDisplayValue, formatUnderwritingValue } from "@/components/centropy/product/scenario-branch-model"
import { parseSensitivityAxis } from "@/components/centropy/product/sensitivity-model"
import { useProductRequest } from "@/components/centropy/product/useProductRequest"

const UUID = z.string().uuid()
const ValueSchema = z.union([z.string(), z.boolean(), z.record(z.union([z.string(), z.boolean()]))])
const SensitivitySchema = z.object({
  id: UUID, baseRunId: UUID, name: z.string(), status: z.string(), cellCount: z.number().int().nonnegative(), complete: z.boolean(),
  definition: z.object({ rowAxis: z.object({ nodeId: z.string(), values: z.array(ValueSchema) }), columnAxis: z.object({ nodeId: z.string(), values: z.array(ValueSchema) }).optional(), outputNodeIds: z.array(z.string()) }),
  cells: z.array(z.object({ rowIndex: z.number().int(), columnIndex: z.number().int(), runId: UUID, runStatus: z.string(), runValidity: z.string(), result: z.object({ outputs: z.record(z.object({ value: ValueSchema })) }) })),
})
type ReviewedSweep = { baseRunId: string; name: string; rowNodeId: string; rowValues: Array<string | boolean | Record<string, string | boolean>>; columnNodeId: string; columnValues: Array<string | boolean | Record<string, string | boolean>>; outputNodeId: string; idempotencyKey: string }
const label = (value: string) => value.replace(/[._]/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase()

export function UnderwritingSensitivityLab({ workspace, base, writable, onRefresh }: { workspace: UnderwritingWorkspace; base: UnderwritingRun; writable: boolean; onRefresh: () => void }) {
  const decimals = Object.values(base.inputSnapshot.values).filter((input) => input.shape === "scalar" && input.valueType === "decimal").sort((a, b) => a.nodeId.localeCompare(b.nodeId))
  const outputs = Object.keys(base.result.outputs).sort()
  const [rowNodeId, setRowNodeId] = useState(decimals[0]?.nodeId ?? "")
  const [rowRaw, setRowRaw] = useState("")
  const [columnNodeId, setColumnNodeId] = useState("")
  const [columnRaw, setColumnRaw] = useState("")
  const [outputNodeId, setOutputNodeId] = useState(outputs[0] ?? "")
  const [name, setName] = useState("")
  const [reviewed, setReviewed] = useState<ReviewedSweep | null>(null)
  const [selectedId, setSelectedId] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const existing = workspace.sensitivities.filter((item) => item.baseRunId === base.id)
  const activeId = selectedId || existing[0]?.id || ""
  const resource = useProductRequest({
    enabled: Boolean(activeId), key: activeId,
    load: async () => {
      const result = SensitivitySchema.parse(await centropyGet<unknown>(`underwriting/sensitivities/${activeId}`))
      if (result.id !== activeId || result.baseRunId !== base.id) throw new Error("The sweep read did not match this base run.")
      return result
    },
  })
  const sensitivity = resource.data?.id === activeId ? resource.data : null
  const displayedOutput = sensitivity?.definition.outputNodeIds.includes(outputNodeId) ? outputNodeId : sensitivity?.definition.outputNodeIds[0] ?? outputNodeId

  function review(event: FormEvent) {
    event.preventDefault()
    setError(null)
    const row = decimals.find((input) => input.nodeId === rowNodeId)
    const column = decimals.find((input) => input.nodeId === columnNodeId)
    if (!row || !outputs.includes(outputNodeId)) return
    try {
      if (!name.trim() || name.trim().length > 240) throw new Error("Name this sweep in 1–240 characters.")
      if (columnNodeId && (!column || columnNodeId === rowNodeId)) throw new Error("Choose a different column input.")
      const rowValues = parseSensitivityAxis(row, rowRaw)
      const columnValues = column ? parseSensitivityAxis(column, columnRaw) : []
      setReviewed({ baseRunId: base.id, name: name.trim(), rowNodeId, rowValues, columnNodeId, columnValues, outputNodeId, idempotencyKey: `centropy-sensitivity:${crypto.randomUUID()}` })
    } catch (cause) { setReviewed(null); setError(cause instanceof Error ? cause.message : "The sweep cannot be reviewed.") }
  }

  async function run() {
    if (!reviewed || !writable || busy || reviewed.baseRunId !== base.id) return
    setBusy(true); setError(null)
    try {
      const result = z.object({ id: UUID }).parse(await centropyPost<unknown>("underwriting/sensitivities", {
        baseRunId: reviewed.baseRunId,
        idempotencyKey: reviewed.idempotencyKey,
        definition: {
          schemaVersion: "underwriting-sensitivity.v1", name: reviewed.name,
          rowAxis: { nodeId: reviewed.rowNodeId, values: reviewed.rowValues },
          ...(reviewed.columnNodeId ? { columnAxis: { nodeId: reviewed.columnNodeId, values: reviewed.columnValues } } : {}),
          outputNodeIds: [reviewed.outputNodeId],
        },
      }))
      setSelectedId(result.id)
      setReviewed(null)
      onRefresh()
    } catch (cause) { setError(`${cause instanceof Error ? cause.message : "Sensitivity run unavailable"} Retry keeps the same exact sweep and idempotency key.`) }
    finally { setBusy(false) }
  }

  return <section className="ct-sensitivity" aria-label="Underwriting sensitivity sweep">
    <span className="ct-scenario-lab__step">03 / Sensitivity</span>
    <h4>Trace a range of assumptions</h4>
    <p>Each cell is a persisted model run from base {base.id.slice(0, 8)}. This tool limits each axis to 20 values.</p>
    {decimals.length && outputs.length ? <form onSubmit={review}>
      <label>Sweep name<input value={name} maxLength={240} onChange={(event) => { setName(event.target.value); setReviewed(null) }} placeholder="Exit multiple range" /></label>
      <label>Row input<select value={rowNodeId} onChange={(event) => { setRowNodeId(event.target.value); setReviewed(null) }}>{decimals.map((input) => <option key={input.nodeId} value={input.nodeId}>{label(input.nodeId)}</option>)}</select></label>
      <label>Row values · comma separated<input value={rowRaw} onChange={(event) => { setRowRaw(event.target.value); setReviewed(null) }} placeholder="4, 4.5, 5" /></label>
      <label>Column input<select value={columnNodeId} onChange={(event) => { setColumnNodeId(event.target.value); setReviewed(null) }}><option value="">One dimensional sweep</option>{decimals.filter((input) => input.nodeId !== rowNodeId).map((input) => <option key={input.nodeId} value={input.nodeId}>{label(input.nodeId)}</option>)}</select></label>
      {columnNodeId ? <label>Column values · comma separated<input value={columnRaw} onChange={(event) => { setColumnRaw(event.target.value); setReviewed(null) }} placeholder="0.08, 0.10, 0.12" /></label> : null}
      <label>Output<select value={outputNodeId} onChange={(event) => { setOutputNodeId(event.target.value); setReviewed(null) }}>{outputs.map((id) => <option key={id} value={id}>{label(id)}</option>)}</select></label>
      <button type="submit" className="ct-scenario-lab__button">Review sweep</button>
    </form> : <p>No decimal inputs and outputs are available for a sensitivity sweep.</p>}
    {reviewed ? <div className="ct-scenario-lab__review"><span>EXACT SWEEP REVIEW · {reviewed.rowValues.length * (reviewed.columnValues.length || 1)} PERSISTED RUNS</span><strong>{reviewed.name}</strong><p>{label(reviewed.rowNodeId)}: {reviewed.rowValues.map(formatUnderwritingValue).join(", ")}</p>{reviewed.columnNodeId ? <p>{label(reviewed.columnNodeId)}: {reviewed.columnValues.map(formatUnderwritingValue).join(", ")}</p> : null}<p>Read {label(reviewed.outputNodeId)} from each completed cell.</p><button type="button" disabled={!writable || busy} onClick={() => void run()}>{busy ? "Running exact sweep…" : error ? "Retry exact sweep" : "Persist sensitivity sweep"}</button></div> : null}
    {error ? <p role="alert" className="ct-scenario-lab__error">{error}</p> : null}
    {existing.length || selectedId ? <div className="ct-sensitivity__results"><label>Persisted sweep<select value={activeId} onChange={(event) => setSelectedId(event.target.value)}>{selectedId && !existing.some((item) => item.id === selectedId) ? <option value={selectedId}>{selectedId.slice(0, 8)} · refreshing source</option> : null}{existing.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.status}</option>)}</select></label>
      {resource.status === "loading" && !sensitivity ? <p>Reading persisted cells…</p> : null}
      {resource.error ? <p role="alert" className="ct-scenario-lab__error">{resource.error} <button type="button" onClick={resource.reload}>Retry read</button></p> : null}
      {sensitivity ? <><p>{sensitivity.status} · {sensitivity.cells.length}/{sensitivity.cellCount} cells · {sensitivity.complete ? "complete read" : "partial read"}</p><label>Displayed output<select value={displayedOutput} onChange={(event) => setOutputNodeId(event.target.value)}>{sensitivity.definition.outputNodeIds.map((id) => <option key={id} value={id}>{label(id)}</option>)}</select></label><div className="ct-sensitivity__table-wrap"><table><thead><tr><th scope="col">{label(sensitivity.definition.rowAxis.nodeId)}</th>{(sensitivity.definition.columnAxis?.values ?? ["Output"]).map((value, index) => <th scope="col" key={index}>{formatUnderwritingValue(value)}</th>)}</tr></thead><tbody>{sensitivity.definition.rowAxis.values.map((rowValue, rowIndex) => <tr key={rowIndex}><th scope="row">{formatUnderwritingValue(rowValue)}</th>{(sensitivity.definition.columnAxis?.values ?? ["Output"]).map((_, columnIndex) => { const cell = sensitivity.cells.find((item) => item.rowIndex === rowIndex && item.columnIndex === columnIndex); const output = cell?.result.outputs[displayedOutput]; return <td key={columnIndex} title={output ? `Exact source value: ${formatUnderwritingValue(output.value)}` : undefined}>{output ? formatUnderwritingDisplayValue(output.value, base.result.outputs[displayedOutput]?.unit) : cell ? `${cell.runStatus} · ${cell.runValidity}` : "No recorded cell"}</td> })}</tr>)}</tbody></table></div></> : null}
    </div> : null}
  </section>
}
