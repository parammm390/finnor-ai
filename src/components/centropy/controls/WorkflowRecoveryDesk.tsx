"use client"

import { useEffect, useState } from "react"
import { z } from "zod"
import { centropyGet } from "../lib/api"
import { HumanControlDesk } from "./HumanControlDesk"

const Run = z.object({ id: z.string().uuid(), workId: z.string().uuid().nullable().optional(), workflowType: z.string(), status: z.string(), version: z.number().int(), updatedAt: z.string(), steps: z.array(z.object({ id: z.string().uuid(), stepType: z.string(), status: z.string(), attempts: z.number(), terminalReason: z.string().nullable() })) })
const Runs = z.object({ runs: Run.array() })
const transitions: Record<string, string[]> = { pause: ["running"], resume: ["paused"], retry: ["failed"], cancel: ["running", "paused"], escalate: ["running", "failed"] }
const words = (value: string) => value.replaceAll("_", " ")

/** Reads the existing durable workflow runtime. Every control carries the exact
 * version and still passes the owning runtime's Authority and transition guards. */
export function WorkflowRecoveryDesk() {
  const [runs, setRuns] = useState<z.infer<typeof Run>[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let active = true
    setError(null)
    void centropyGet<unknown>("workflows/runs").then((value) => { if (active) setRuns(Runs.parse(value).runs) }).catch((cause) => { if (active) { setRuns(null); setError(cause instanceof Error ? cause.message : "Workflow records unavailable") } })
    return () => { active = false }
  }, [revision])
  const run = runs?.find((item) => item.id === selected)
  return <section className="ct-workflow-recovery" aria-label="Durable workflow recovery">
    <h3>Workflow recovery</h3><p>Inspect the owning run and its recorded steps before requesting a control. Retry is permitted only when the runtime proves a known failure before an effect. Uncertain effects require reconciliation.</p>
    <button type="button" onClick={() => setRevision((value) => value + 1)}>Refresh workflow records</button>
    {error ? <p role="alert">{error}</p> : null}
    {!runs && !error ? <p role="status">Reading workflow records…</p> : null}
    {runs?.length ? <><p>Showing active runs and up to 20 recent terminal or paused runs.</p><label>Exact workflow run<select value={selected ?? ""} onChange={(event) => setSelected(event.target.value || null)}><option value="">Select a recorded run</option>{runs.map((item) => <option key={item.id} value={item.id}>{words(item.workflowType)} · {words(item.status)} · {item.id}</option>)}</select></label></> : runs ? <p>No workflow runs were returned.</p> : null}
    {run ? <div key={`${run.id}:${run.version}`}><h4>{words(run.workflowType)}</h4><p>Recorded state: {words(run.status)} · version {run.version}</p><ol>{run.steps.map((step) => <li key={step.id}><strong>{words(step.stepType)}</strong><p>{words(step.status)} · {step.attempts} attempt{step.attempts === 1 ? "" : "s"}</p>{step.terminalReason ? <p>{step.terminalReason}</p> : null}<small>Step reference: {step.id}</small></li>)}</ol>
      <HumanControlDesk groups={["workflow-controls"]} routePatterns={Object.keys(transitions).map((verb) => `workflows/runs/:id/${verb}`)} paths={{ id: run.id }} context={{ expectedVersion: run.version }} eligibility={(form) => transitions[form.routePattern.split("/").at(-1)!]?.includes(run.status) ? [] : ["This control is unavailable in the recorded run state."]} verify={async (_form, result) => {
        const changed = z.object({ run: Run.omit({ steps: true }) }).parse(result).run
        if (changed.id !== run.id || changed.version !== run.version + 1) throw new Error("The control response does not match this exact run/version")
        const actual = Runs.parse(await centropyGet<unknown>("workflows/runs")).runs.find((item) => item.id === run.id)
        if (!actual || actual.status !== changed.status || actual.version !== changed.version) throw new Error("The exact controlled run was not confirmed by canonical readback; refresh its record")
        return { run: actual }
      }} onRecorded={() => setRevision((value) => value + 1)} />
    </div> : null}
  </section>
}
