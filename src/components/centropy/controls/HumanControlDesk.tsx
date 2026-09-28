"use client"

import { useId, useState } from "react"
import catalogue from "@/lib/centropy/human-forms.generated.json"
import { CanonicalRecordForm, type HumanForm } from "./CanonicalRecordForm"

const forms = catalogue.forms as unknown as HumanForm[]
export const GROUP_NAMES: Record<string, string> = { "institutional-records": "Institutional records", "committee-records": "Committee record", "committee-configuration": "Committee membership", microsoft: "Microsoft 365", connections: "Provider connections", workforce: "Specialist profiles", "operating-profile": "Operating profile", preferences: "My preferences", "workflow-controls": "Workflow controls", "work-controls": "Work responsibility", "memory-corrections": "Recorded answer corrections", "reconciliation-controls": "Effect reconciliation", "computer-controls": "Computer execution", "closing-waivers": "Closing condition waiver", "closing-verification": "Closing item verification", autonomy: "Autonomy grants", "model-records": "Model records" }

export function HumanControlDesk({ groups, routePatterns, context = {}, fixedFields = [], paths = {}, writable = true, eligibility, verify, verificationRoutes, onRecorded }: { groups: string[]; routePatterns?: string[]; context?: Record<string, unknown>; fixedFields?: string[]; paths?: Record<string, string>; writable?: boolean; eligibility?: (form: HumanForm) => string[]; verify?: (form: HumanForm, response: unknown, body: Record<string, unknown>) => Promise<unknown>; verificationRoutes?: string[]; onRecorded: () => void }) {
  const id = useId()
  const [group, setGroup] = useState(groups[0])
  const [choice, setChoice] = useState("")
  const available = forms.filter((form) => groups.includes(form.group) && form.group === group && (!routePatterns || routePatterns.includes(form.routePattern))).sort((a, b) => Number(a.method === "DELETE") - Number(b.method === "DELETE"))
  const selected = available.find((form) => form.id === choice) ?? available[0]
  const blockers = selected ? eligibility?.(selected) ?? [] : []
  const initial = selected ? Object.fromEntries(Object.entries(context).filter(([key]) => selected.schema.properties?.[key])) : {}
  const fixed = Object.fromEntries(Object.entries(initial).filter(([key]) => fixedFields.includes(key)))
  const selectedPaths = selected ? Object.fromEntries(Object.entries(paths).filter(([key]) => selected.pathFields.includes(key))) : {}
  return <div className="ct-human-controls">
    {groups.length > 1 ? <label htmlFor={`${id}-group`}>Record area<select id={`${id}-group`} value={group} onChange={(e) => { setGroup(e.target.value); setChoice("") }}>{groups.map((key) => <option key={key} value={key}>{GROUP_NAMES[key] ?? key}</option>)}</select></label> : null}
    {available.length ? <label htmlFor={`${id}-operation`}>Record operation<select id={`${id}-operation`} value={selected?.id ?? ""} onChange={(e) => setChoice(e.target.value)}>{available.map((form) => <option key={form.id} value={form.id}>{form.title}</option>)}</select></label> : <p>No typed control is available for this record area.</p>}
    {blockers.length ? <div role="status"><strong>This operation is currently blocked.</strong><ul>{blockers.map((blocker) => <li key={blocker}>{blocker.replaceAll("_", " ")}</li>)}</ul></div> : null}
    {selected ? <CanonicalRecordForm key={`${selected.id}:${JSON.stringify(initial)}:${JSON.stringify(selectedPaths)}`} form={selected} initialValues={initial} fixedValues={fixed} pathValues={selectedPaths} writable={writable && !blockers.length} verify={verify && (!verificationRoutes || verificationRoutes.includes(selected.routePattern)) ? (response, body) => verify(selected, response, body) : undefined} onRecorded={onRecorded} /> : null}
  </div>
}
