"use client"

import { useEffect, useRef, useState } from "react"
import { z } from "zod"
import { centropyGet, centropyPost } from "@/components/centropy/lib/api"

const Preference = z.object({ activation: z.object({ revision: z.number().int().nonnegative(), operation: z.enum(["activate", "disable"]), runId: z.string().uuid().nullable(), reviewedResultDigest: z.string().nullable() }) })
const Qualification = z.object({ holdout: z.object({ baseline: z.number().finite(), candidate: z.number().finite(), tasks: z.number().int(), disposition: z.string() }), candidate: z.object({ instruction: z.string() }) }).passthrough()

export function PlannerCandidateReview({ runId, resultDigest, result }: { runId: string; resultDigest: string; result: Record<string, unknown> }) {
  const [preference, setPreference] = useState<z.infer<typeof Preference>["activation"] | null>(null)
  const [note, setNote] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const current = useRef(true), intent = useRef<{ signature: string; key: string } | null>(null)
  const qualification = Qualification.safeParse(result)
  useEffect(() => {
    let active = true; current.current = true
    void centropyGet<unknown>("capabilities/planner/activation").then(value => { const parsed = Preference.parse(value); if (active) setPreference(parsed.activation) })
      .catch(cause => { if (active) { setPreference(null); setError(cause instanceof Error ? cause.message : "Planner preference could not be read.") } })
    return () => { active = false; current.current = false }
  }, [refresh])
  async function change(operation: "activate" | "disable") {
    if (!preference) return
    setBusy(true); setError(null)
    const payload = { operation, expectedRevision: preference.revision, reviewNote: note, ...(operation === "activate" ? { runId, reviewedResultDigest: resultDigest } : {}) }
    const signature = JSON.stringify(payload)
    if (intent.current?.signature !== signature) intent.current = { signature, key: crypto.randomUUID() }
    try {
      const parsed = Preference.parse(await centropyPost<unknown>("capabilities/planner/activation", { ...payload, idempotencyKey: intent.current.key }))
      if (parsed.activation.revision !== preference.revision + 1 || parsed.activation.operation !== operation || operation === "activate" && parsed.activation.runId !== runId) throw new Error("The activation receipt does not match this reviewed candidate.")
      intent.current = null
      if (current.current) { setPreference(parsed.activation); setNote("") }
    } catch (cause) { if (current.current) setError(cause instanceof Error ? cause.message : "Planner preference could not be changed.") }
    finally { if (current.current) setBusy(false) }
  }
  if (!qualification.success) return null
  const holdout = qualification.data.holdout, improved = holdout.candidate > holdout.baseline && holdout.tasks >= 2 && holdout.disposition === "IMPROVED_ON_THIS_HELDOUT_CUT"
  return <details><summary>Review planner candidate for background use</summary>
    <p>Heldout replay score: {holdout.baseline} → {holdout.candidate} across {holdout.tasks} tasks. This qualification applies to this dataset and model route.</p>
    <blockquote>{qualification.data.candidate.instruction}</blockquote><p>Result digest · {resultDigest}</p>
    <p>Activation applies this heuristic to your background planning proposals. FINNOR&apos;s compiler, source permissions and business-action authority still apply.</p>
    {preference ? <p>Current preference revision {preference.revision} · {preference.operation === "activate" ? `candidate ${preference.runId}` : "incumbent planner"}</p> : null}
    <label>Review note<textarea value={note} onChange={event => setNote(event.target.value)} minLength={16} maxLength={4000} /></label>
    <button type="button" disabled={busy || !preference || !improved || note.trim().length < 16} onClick={() => void change("activate")}>Activate this reviewed candidate</button>
    <button type="button" disabled={busy || !preference || preference.operation !== "activate" || note.trim().length < 16} onClick={() => void change("disable")}>Restore incumbent planner</button>
    <button type="button" disabled={busy} onClick={() => { setError(null); setRefresh(value => value + 1) }}>Refresh planner preference</button>
    {busy ? <p role="status">Recording reviewed planner preference…</p> : null}{error ? <p role="alert">{error}</p> : null}
  </details>
}
