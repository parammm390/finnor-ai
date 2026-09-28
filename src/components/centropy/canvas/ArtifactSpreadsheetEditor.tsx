"use client"

import { useId, useRef, useState } from "react"
import { z } from "zod"
import { centropyGet, centropyPost } from "@/components/centropy/lib/api"
import { RecordedFields } from "../controls/StructuredFields"

const DraftSchema = z.object({ draftKey: z.string().min(1), versionId: z.string().uuid() })
const PatchSchema = z.union([z.object({ version: z.object({ id: z.string().uuid() }) }), z.object({ versionId: z.string().uuid() })])
const CellReadSchema = z.object({ nodes: z.array(z.object({ id: z.string(), kind: z.string(), data: z.record(z.unknown()) })) })
export type EditableCell = { id: string; hash: string; sheetId: string; address: string; value: unknown; formula: string | null }
type ValueType = "text" | "number" | "formula" | "boolean" | "blank"
type Operation = { type: "set_value"; sheetId: string; address: string; value: string | boolean | null; expectedHash: string } | { type: "set_number"; sheetId: string; address: string; value: string; expectedHash: string } | { type: "set_formula"; sheetId: string; address: string; formula: string; expectedHash: string }
type Review = { baseVersionId: string; anchor: string; before: unknown; operation: Operation }

export function ArtifactSpreadsheetEditor({ documentId, versionId, cells, onVersionCreated }: { documentId: string; versionId: string; cells: EditableCell[]; onVersionCreated: (id: string) => void }) {
  const id = useId()
  const [anchor, setAnchor] = useState(cells[0]?.id ?? "")
  const selected = cells.find((cell) => cell.id === anchor)
  const [type, setType] = useState<ValueType>("text")
  const [value, setValue] = useState("")
  const [review, setReview] = useState<Review | null>(null)
  const [draft, setDraft] = useState<z.infer<typeof DraftSchema> | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lock = useRef(false)

  function prepare() {
    if (!selected || busy) return
    const common = { sheetId: selected.sheetId, address: selected.address, expectedHash: selected.hash }
    if (type === "number" && (value.trim().length > 256 || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.trim()))) { setError("Enter a decimal number such as 123.45, without exponent notation or leading zeroes."); return }
    if (type === "formula" && !value.replace(/^=/, "").trim()) { setError("Enter a formula to store. Its result requires Excel calculation."); return }
    if (type === "boolean" && !["true", "false"].includes(value)) { setError("Choose true or false."); return }
    const operation: Operation = type === "formula" ? { ...common, type: "set_formula", formula: value.replace(/^=/, "").trim() } : type === "number" ? { ...common, type: "set_number", value: value.trim() } : { ...common, type: "set_value", value: type === "blank" ? null : type === "boolean" ? value === "true" : value }
    setReview({ baseVersionId: versionId, anchor: selected.id, before: selected.formula === null ? selected.value : { formula: selected.formula }, operation }); setError(null)
  }

  async function apply() {
    if (!review || lock.current || review.baseVersionId !== versionId || review.anchor !== selected?.id || review.operation.expectedHash !== selected.hash) return
    lock.current = true; setBusy(true); setError(null)
    let exactDraft = draft, nextVersionId = saved
    try {
      if (!nextVersionId) {
        if (!exactDraft) {
          exactDraft = DraftSchema.parse(await centropyPost<unknown>(`documents/${documentId}/artifact/drafts`, { baseVersionId: review.baseVersionId }))
          if (exactDraft.versionId !== review.baseVersionId) throw new Error("The draft returned a different base version.")
          setDraft(exactDraft)
        }
        const result = PatchSchema.parse(await centropyPost<unknown>(`documents/${documentId}/artifact/patches`, { baseVersionId: review.baseVersionId, draftKey: exactDraft.draftKey, operations: [review.operation] }))
        nextVersionId = "version" in result ? result.version.id : result.versionId
        if (nextVersionId === review.baseVersionId) throw new Error("The patch returned the unchanged base version.")
        setSaved(nextVersionId)
      }
      const ir = CellReadSchema.parse(await centropyGet<unknown>(`documents/${documentId}/artifact/ir/${nextVersionId}`, { sheetId: selected.sheetId, range: `${selected.address}:${selected.address}`, limit: "10" }))
      const cell = ir.nodes.find((node) => node.kind === "cell" && node.id === review.anchor)
      if (!cell) throw new Error("The saved version did not contain the reviewed cell.")
      if (review.operation.type === "set_formula") {
        if (cell.data.formula !== review.operation.formula || cell.data.cached !== null || !["uncalculated", "cached_stale"].includes(String(cell.data.calculation))) throw new Error("The stored formula or calculation state differs from the exact reviewed change.")
      } else {
        // Artifact OS exposes numeric OOXML cells as JSON numbers. The exact
        // decimal string remains the typed patch input and persisted file value.
        const expected = review.operation.type === "set_number" && Number.isFinite(Number(review.operation.value)) ? Number(review.operation.value) : review.operation.value
        if (cell.data.formula != null || cell.data.value !== expected) throw new Error("The stored cell value differs from the exact reviewed change.")
      }
      onVersionCreated(nextVersionId)
    } catch (cause) { setError(`${cause instanceof Error ? cause.message : "Workbook edit unavailable"} ${nextVersionId ? "Retry reads the same saved version." : exactDraft ? "Retry submits the same exact patch." : "Inspect the version list if the draft response was lost."}`) }
    finally { lock.current = false; setBusy(false) }
  }

  return <section className="ct-artifact__section ct-artifact__editor" aria-label="Versioned spreadsheet editor">
    <h3>Edit a recorded cell</h3><p>Review the exact cell and base version. Saving creates a new immutable workbook version. Formulas are stored without calculating a local result.</p>
    {cells.length ? <>
      <label htmlFor={`${id}-cell`}>Recorded cell<select id={`${id}-cell`} value={anchor} disabled={busy || !!review} onChange={(event) => { setAnchor(event.target.value); setValue(""); setError(null) }}>{cells.map((cell) => <option key={cell.id} value={cell.id}>{cell.address}</option>)}</select></label>
      {!review ? <><label htmlFor={`${id}-type`}>Value type<select id={`${id}-type`} value={type} disabled={busy} onChange={(event) => { setType(event.target.value as ValueType); setValue(""); setError(null) }}><option value="text">Text</option><option value="number">Exact number</option><option value="formula">Stored formula</option><option value="boolean">Boolean</option><option value="blank">Blank</option></select></label>{type === "boolean" ? <label htmlFor={`${id}-value`}>New cell value<select id={`${id}-value`} value={value} onChange={(event) => setValue(event.target.value)}><option value="">Choose a value</option><option value="true">true</option><option value="false">false</option></select></label> : type !== "blank" ? <label htmlFor={`${id}-value`}>New cell value<input id={`${id}-value`} value={value} maxLength={100_000} onChange={(event) => setValue(event.target.value)} /></label> : null}<button type="button" disabled={busy} onClick={prepare}>Review exact cell change</button></> : <div className="ct-artifact__edit-review"><RecordedFields value={review} /><div className="ct-artifact__editor-actions"><button type="button" disabled={busy || !!draft || !!saved} onClick={() => { setReview(null); setError(null) }}>Back to edit</button><button type="button" disabled={busy} onClick={() => void apply()}>{busy ? "Saving and reading exact version…" : saved ? "Retry saved version readback" : draft ? "Retry exact workbook patch" : "Create workbook version"}</button></div></div>}
      {error ? <p role="alert">{error}</p> : null}
    </> : <p>No recorded editable cells are loaded. Read a range containing the target cell first.</p>}
  </section>
}
