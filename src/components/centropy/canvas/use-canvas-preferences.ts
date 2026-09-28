"use client"

import { useEffect, useRef, useState } from "react"
import { z } from "zod"
import { centropyGet, centropyPut } from "@/components/centropy/lib/api"
import { moveCanvasBlock, reconcileCanvasOrder } from "./canvas-layout"

const PreferenceSchema = z.object({
  schemaVersion: z.literal(1),
  threadId: z.string().uuid(),
  uiRevision: z.number().int().positive(),
  layout: z.object({ mode: z.literal("document"), blockIds: z.array(z.string()) }).strict(),
  selectedBlockId: z.string().nullable(),
  updatedAt: z.string(),
}).strict()
const ResponseSchema = z.object({ state: PreferenceSchema.nullable() }).passthrough()
type Preference = z.infer<typeof PreferenceSchema>
type Status = "loading" | "ready" | "saving" | "unavailable" | "uncertain"

export function useCanvasPreferences(threadId: string | null, canonicalOrder: string[]) {
  const [remote, setRemote] = useState<Preference | null>(null)
  const [desiredOrder, setDesiredOrder] = useState<string[] | null>(null)
  const [desiredFocus, setDesiredFocus] = useState<string | null | undefined>(undefined)
  const [status, setStatus] = useState<Status>("loading")
  const [message, setMessage] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const activeThread = useRef(threadId)
  activeThread.current = threadId

  useEffect(() => {
    let active = true
    setRemote(null); setDesiredOrder(null); setDesiredFocus(undefined); setStatus("loading"); setMessage(null)
    if (!threadId) return () => { active = false }
    void centropyGet<unknown>(`threads/${threadId}/canvas`).then((value) => {
      if (!active) return
      const parsed = ResponseSchema.parse(value)
      if (parsed.state && parsed.state.threadId !== threadId) throw new Error("Canvas preference belongs to another Investigation.")
      setRemote(parsed.state)
      setStatus("ready")
    }).catch(() => {
      if (!active) return
      setStatus("unavailable")
      setMessage("Saved Canvas order is unavailable on the connected API. Canonical order is shown.")
    })
    return () => { active = false }
  }, [threadId, reloadKey])

  const order = reconcileCanvasOrder(desiredOrder ?? remote?.layout.blockIds ?? null, canonicalOrder)
  const savedOrder = reconcileCanvasOrder(remote?.layout.blockIds ?? null, canonicalOrder)
  const focusCandidate = desiredFocus === undefined ? remote?.selectedBlockId ?? null : desiredFocus
  const focusedId = focusCandidate && order.includes(focusCandidate) ? focusCandidate : null
  const savedFocus = remote?.selectedBlockId && order.includes(remote.selectedBlockId) ? remote.selectedBlockId : null
  const dirty = order.join("\u0000") !== savedOrder.join("\u0000") || focusedId !== savedFocus

  function move(id: string, direction: -1 | 1) {
    if (status !== "ready") return
    setDesiredOrder(moveCanvasBlock(order, id, direction))
    setMessage(null)
  }

  function focus(id: string) {
    if (status !== "ready" || !order.includes(id)) return
    setDesiredFocus(focusedId === id ? null : id)
    setMessage(null)
  }

  async function save() {
    if (status !== "ready" || !threadId || !dirty) return
    const expectedThread = threadId
    const intendedOrder = order
    const intendedFocus = focusedId
    setStatus("saving")
    setMessage(null)
    try {
      const value = ResponseSchema.parse(await centropyPut<unknown>(`threads/${threadId}/canvas`, {
        // A successful GET with no saved presentation has the initial revision 0.
        baseRevision: remote ? remote.uiRevision : 0,
        layout: { mode: "document", blockIds: intendedOrder },
        selectedBlockId: intendedFocus,
      }))
      if (!value.state || value.state.threadId !== expectedThread) throw new Error("Canvas preference readback has a different identity.")
      if (activeThread.current !== expectedThread) return
      setRemote(value.state)
      setDesiredOrder(null)
      setDesiredFocus(undefined)
      setStatus("ready")
      setMessage(`Canvas order saved at presentation revision ${value.state.uiRevision}.`)
    } catch (cause) {
      if (activeThread.current !== expectedThread) return
      try {
        const value = ResponseSchema.parse(await centropyGet<unknown>(`threads/${expectedThread}/canvas`))
        if (activeThread.current !== expectedThread) return
        if (value.state && value.state.threadId !== expectedThread) throw new Error("Canvas preference belongs to another Investigation.")
        setRemote(value.state)
        setStatus("ready")
        const matches = value.state && intendedOrder.join("\u0000") === value.state.layout.blockIds.join("\u0000") && intendedFocus === value.state.selectedBlockId
        if (matches) {
          setDesiredOrder(null); setDesiredFocus(undefined)
          setMessage(`Canvas order saved at presentation revision ${value.state!.uiRevision}.`)
        } else {
          setMessage(`Save was not confirmed: ${cause instanceof Error ? cause.message : "request failed"}. Review the current order before saving again.`)
        }
      } catch {
        if (activeThread.current !== expectedThread) return
        setStatus("uncertain")
        setMessage("Canvas save status is uncertain. Reload its recorded preference before editing again.")
      }
    }
  }

  return { order, focusedId, status, message, dirty, move, focus, save, reload: () => setReloadKey((value) => value + 1) }
}
