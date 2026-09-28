"use client"

import { useEffect, useRef, useState } from "react"
import { centropyGet } from "@/components/centropy/lib/api"
import { HumanControlDesk } from "./HumanControlDesk"
import { RecordedFields } from "./StructuredFields"

export function SettingsDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [preferences, setPreferences] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const current = dialog.current
    current?.showModal()
    return () => { current?.close(); previous?.focus() }
  }, [])
  useEffect(() => {
    let active = true
    void centropyGet<{ prefs: Record<string, unknown> }>("user-prefs").then((result) => { if (active) { setPreferences(result.prefs); setError(null) } }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Preferences are unavailable") })
    return () => { active = false }
  }, [revision])
  return <dialog ref={dialog} className="ct-settings" aria-labelledby="ct-settings-title" onCancel={(e) => { e.preventDefault(); onClose() }}>
    <header><div><span className="ct-eyebrow">YOUR WORKSPACE</span><h2 id="ct-settings-title">Settings</h2></div><button type="button" aria-label="Close Settings" onClick={onClose}>×</button></header>
    <p>Review exact changes before recording them. Connections, committee membership, and autonomy limits are enforced by their owning services.</p>
    {error ? <p role="alert">{error}</p> : null}
    <HumanControlDesk groups={["preferences", "operating-profile", "workforce", "committee-configuration", "autonomy", "microsoft", "connections"]} verificationRoutes={["user-prefs", "outcome-packs/control"]} verify={async (form, _result, body) => {
      if (form.routePattern === "outcome-packs/control") {
        const catalog = await centropyGet<{ packs: Array<{ definition: { id: string }; setting: { enabled: boolean; reason?: string } }> }>("outcome-packs")
        const pack = catalog.packs.find((entry) => entry.definition.id === body.packId)
        if (!pack || pack.setting.enabled !== body.enabled || pack.setting.reason !== body.reason) throw new Error("The mission setting did not match the exact reviewed change.")
        return pack
      }
      const read = await centropyGet<{ prefs: Record<string, unknown> }>("user-prefs")
      if (form.method === "PUT" && Object.entries(body).some(([key, value]) => JSON.stringify(read.prefs[key]) !== JSON.stringify(value))) throw new Error("The saved preferences differ from the reviewed change.")
      return read
    }} onRecorded={() => { setRevision((value) => value + 1); onChanged() }} />
    {preferences ? <details className="ct-settings-current"><summary>Inspect my recorded preferences</summary><RecordedFields value={preferences} /></details> : null}
  </dialog>
}
