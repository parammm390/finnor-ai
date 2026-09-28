"use client"

import { useMemo, useRef, useState, type FormEvent } from "react"
import { ArrowRight, GitBranch } from "lucide-react"
import { centropyGet, centropyPost } from "@/components/centropy/lib/api"
import type { UnderwritingLineage, UnderwritingRun, UnderwritingRunDiff, UnderwritingValue, UnderwritingWorkspace } from "@/components/centropy/product/contracts"
import { editableCanvasScenarioInputs, formatUnderwritingDisplayValue, formatUnderwritingValue, matchingBaseRun, parseCanvasScenarioValue, underwritingPeriodLabel } from "@/components/centropy/product/scenario-branch-model"
import { useProductRequest } from "@/components/centropy/product/useProductRequest"
import { UnderwritingSensitivityLab } from "./UnderwritingSensitivityLab"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const label = (value: string) => value.replace(/^output[._]/i, "").replace(/[._]/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase()
const dated = (value: string) => new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })

type ScenarioChange = { nodeId: string; value: UnderwritingValue; baseValue: UnderwritingValue | null; unit: string }
type ReviewedChange = { signature: string; baseId: string; changes: ScenarioChange[]; name: string; reason: string }

export function UnderwritingScenarioLab({ workspace, writable, onRefresh }: { workspace: UnderwritingWorkspace; writable: boolean; onRefresh: () => void }) {
  const [baseId, setBaseId] = useState("")
  const [branchId, setBranchId] = useState("")
  const [nodeId, setNodeId] = useState("")
  const [raw, setRaw] = useState("")
  const [name, setName] = useState("")
  const [reason, setReason] = useState("")
  const [staged, setStaged] = useState<ScenarioChange[]>([])
  const [reviewed, setReviewed] = useState<ReviewedChange | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [writing, setWriting] = useState<"idle" | "recording" | "running">("idle")
  const [pendingScenarioId, setPendingScenarioId] = useState<string | null>(null)
  const [outputId, setOutputId] = useState<string | null>(null)
  const writeLock = useRef(false)

  const baseRuns = useMemo(() => workspace.runs.filter((run) => !run.scenarioId && !run.sensitivityCell).sort((left, right) => Date.parse(right.computedAt) - Date.parse(left.computedAt)), [workspace.runs])
  const base = baseRuns.find((run) => run.id === baseId) ?? baseRuns[0] ?? null
  const editable = useMemo(() => editableCanvasScenarioInputs(base), [base])
  const activeInput = editable.find((input) => input.nodeId === nodeId) ?? editable[0] ?? null
  const branchRuns = workspace.runs.filter((run) => run.scenarioId && base && matchingBaseRun(workspace.runs, run, base.id) && workspace.scenarios.some((scenario) => scenario.id === run.scenarioId && scenario.modelVersionId === run.modelVersionId))
    .sort((left, right) => Date.parse(right.computedAt) - Date.parse(left.computedAt))
  const branch = branchId ? branchRuns.find((run) => run.id === branchId) ?? null : branchRuns[0] ?? null
  const scenario = workspace.scenarios.find((item) => item.id === branch?.scenarioId) ?? null
  const unrunScenarios = workspace.scenarios.filter((item) => item.modelVersionId === base?.modelVersionId && !workspace.runs.some((run) => run.scenarioId === item.id))
  const draftSignature = JSON.stringify([base?.id, name.trim(), reason.trim(), staged, activeInput?.nodeId, raw])
  const proposedSeries = activeInput?.shape === "series" && activeInput.value && typeof activeInput.value === "object"
    ? (raw ? JSON.parse(raw) : activeInput.value) as Record<string, string | boolean> : null
  const currentReview = reviewed?.signature === draftSignature ? reviewed : null
  const modelVersion = workspace.modelVersions.find((item) => item.id === base?.modelVersionId)
  const model = workspace.models.find((item) => item.id === modelVersion?.modelId)

  const pairKey = base && branch ? `${base.id}:${branch.id}` : ""
  const diffResource = useProductRequest({
    enabled: Boolean(base && branch), key: pairKey,
    load: async () => {
      const result = await centropyGet<UnderwritingRunDiff>("underwriting/runs/diff", { left: base!.id, right: branch!.id })
      if (result.leftRunId !== base!.id || result.rightRunId !== branch!.id || !result.changedInputs || !result.changedOutputs) throw new Error("The comparison did not match these persisted runs.")
      return result
    },
  })
  const diff = diffResource.data?.leftRunId === base?.id && diffResource.data.rightRunId === branch?.id ? diffResource.data : null
  const lineageResource = useProductRequest({
    enabled: Boolean(branch && outputId && diff?.changedOutputs[outputId]), key: branch && outputId ? `${branch.id}:${outputId}` : "",
    load: async () => {
      const data = await centropyGet<UnderwritingLineage>(`underwriting/runs/${branch!.id}/explain`, { nodeId: outputId! })
      if (data.nodeId !== outputId) throw new Error("The lineage response did not match the selected output.")
      return { runId: branch!.id, data }
    },
  })
  const lineage = lineageResource.data && branch && outputId && lineageResource.data.runId === branch.id && lineageResource.data.data.nodeId === outputId ? lineageResource.data.data : null

  function proposedChange(input: NonNullable<typeof activeInput>, valueText: string): ScenarioChange {
    const value = parseCanvasScenarioValue(input, valueText)
    if (JSON.stringify(value) === JSON.stringify(input.value)) throw new Error(`The proposed value for ${label(input.nodeId)} matches the base input.`)
    return { nodeId: input.nodeId, value, baseValue: input.value, unit: input.unit }
  }

  function stageChange() {
    setError(null)
    setReviewed(null)
    if (!activeInput) return
    try {
      const change = proposedChange(activeInput, raw)
      setStaged((current) => [...current.filter((item) => item.nodeId !== change.nodeId), change])
      setRaw("")
      setPendingScenarioId(null)
    } catch (cause) { setError(cause instanceof Error ? cause.message : "This input cannot be staged.") }
  }

  function review(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setReviewed(null)
    if (!base || !activeInput) return
    try {
      const changes = [...staged]
      if (raw.trim()) {
        const change = proposedChange(activeInput, raw)
        const prior = changes.findIndex((item) => item.nodeId === change.nodeId)
        if (prior >= 0) changes[prior] = change
        else changes.push(change)
      }
      if (!changes.length) throw new Error("Add at least one changed input before reviewing this branch.")
      if (changes.length > 100) throw new Error("A branch cannot change more than 100 model inputs.")
      const scenarioName = name.trim()
      const scenarioReason = reason.trim()
      if (!scenarioName || scenarioName.length > 240) throw new Error("Name this scenario in 1–240 characters.")
      if (!scenarioReason || scenarioReason.length > 1_000) throw new Error("Record the reason in 1–1,000 characters.")
      setReviewed({ signature: draftSignature, baseId: base.id, changes, name: scenarioName, reason: scenarioReason })
    } catch (cause) { setError(cause instanceof Error ? cause.message : "This input cannot be reviewed.") }
  }

  async function runPersistedScenario(scenarioId: string, selectedBase: UnderwritingRun) {
    setWriting("running")
    const result = await centropyPost<{ id: string }>("underwriting/runs", {
      investmentCaseId: workspace.investmentCase.id, modelVersionId: selectedBase.modelVersionId,
      worldAt: selectedBase.worldAt, scenarioId, baseRunId: selectedBase.id,
      idempotencyKey: `centropy-scenario:${scenarioId}:${selectedBase.id}`,
    })
    if (!UUID.test(result.id)) throw new Error("The underwriting engine did not return a persisted run ID.")
    setBranchId(result.id)
    setPendingScenarioId(null)
    setNotice("The scenario run was persisted. Loading the engine comparison.")
    onRefresh()
  }

  async function recordAndRun() {
    if (!currentReview || !base || !writable || writeLock.current) return
    writeLock.current = true
    setError(null)
    setNotice(null)
    try {
      setWriting("recording")
      const created = await centropyPost<{ id: string }>("underwriting/scenarios", {
        investmentCaseId: workspace.investmentCase.id, modelVersionId: base.modelVersionId,
        scenario: { schemaVersion: "underwriting-scenario.v1", name: currentReview.name, overrides: currentReview.changes.map((change) => ({ nodeId: change.nodeId, value: change.value, reason: currentReview.reason })) },
      })
      if (!UUID.test(created.id)) throw new Error("The underwriting engine did not return a persisted scenario ID.")
      setPendingScenarioId(created.id)
      onRefresh()
      await runPersistedScenario(created.id, base)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The scenario could not be completed.")
      onRefresh()
    } finally { writeLock.current = false; setWriting("idle") }
  }

  async function retryRun(scenarioId: string) {
    if (!base || !writable || writeLock.current) return
    writeLock.current = true
    setError(null)
    try { await runPersistedScenario(scenarioId, base) }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The scenario run failed."); onRefresh() }
    finally { writeLock.current = false; setWriting("idle") }
  }

  return <section className="ct-scenario-lab" aria-label="Underwriting scenario laboratory">
    <header><span className="ct-eyebrow"><GitBranch size={15} /> SCENARIO LABORATORY</span><h4>Change an assumption. Read the real model.</h4><p>Each branch keeps the base run intact. Outputs and lineage come from persisted underwriting runs.</p></header>
    {!base ? <p>No persisted base run is available for a scenario branch.</p> : <>
      <div className="ct-scenario-lab__base"><label>Base run<select value={base.id} onChange={(event) => { setBaseId(event.target.value); setBranchId(""); setOutputId(null); setReviewed(null); setPendingScenarioId(null); setStaged([]); setRaw("") }}>{baseRuns.map((run) => <option key={run.id} value={run.id}>{dated(run.computedAt)} · {run.id.slice(0, 8)} · {run.validity}</option>)}</select></label><div><strong>{model?.name ?? "Underwriting model"}</strong><span>{modelVersion?.versionKey ?? "Version unavailable"} · world at {dated(base.worldAt)}</span></div></div>
      {!writable ? <p className="ct-scenario-lab__error">The underwriting source is not current. Refresh Canvas before recording or running a scenario.</p> : null}
      <div className="ct-scenario-lab__grid"><form onSubmit={review}><span className="ct-scenario-lab__step">01 / Set a branch</span>
        {editable.length ? <><label>Input<select value={activeInput?.nodeId ?? ""} onChange={(event) => { setNodeId(event.target.value); setRaw(""); setReviewed(null); setPendingScenarioId(null) }}>{editable.map((input) => <option key={input.nodeId} value={input.nodeId}>{label(input.nodeId)}</option>)}</select></label>
          <div className="ct-scenario-lab__baseline"><span>Recorded base value</span><strong>{formatUnderwritingValue(activeInput?.value)} <small>{activeInput?.unit}</small></strong><span>{activeInput?.truthClass} · {activeInput?.status}</span></div>
          {proposedSeries ? <fieldset className="ct-scenario-periods"><legend>Proposed period values · {activeInput?.unit}</legend>{Object.entries(proposedSeries).map(([period, amount]) => <label key={period}>Proposed value · {underwritingPeriodLabel(period)}{activeInput?.valueType === "boolean" ? <select value={String(amount)} onChange={(event) => { setRaw(JSON.stringify({ ...proposedSeries, [period]: event.target.value === "true" })); setReviewed(null); setPendingScenarioId(null) }}><option value="true">True</option><option value="false">False</option></select> : <input type={activeInput?.valueType === "date" ? "date" : "text"} inputMode={activeInput?.valueType === "decimal" ? "decimal" : undefined} value={String(amount)} onChange={(event) => { setRaw(JSON.stringify({ ...proposedSeries, [period]: event.target.value })); setReviewed(null); setPendingScenarioId(null) }} />}</label>)}</fieldset> : <label>Proposed value · {activeInput?.valueType}{activeInput?.valueType === "boolean" ? <select value={raw} onChange={(event) => { setRaw(event.target.value); setReviewed(null); setPendingScenarioId(null) }}><option value="">Choose value</option><option value="true">True</option><option value="false">False</option></select> : <input type={activeInput?.valueType === "date" ? "date" : "text"} inputMode={activeInput?.valueType === "decimal" ? "decimal" : undefined} value={raw} onChange={(event) => { setRaw(event.target.value); setReviewed(null); setPendingScenarioId(null) }} placeholder={activeInput?.valueType === "decimal" ? "Exact decimal, e.g. 0.09" : "New value"} />}</label>}
          {proposedSeries ? <p className="ct-scenario-lab__series-note">Each recorded period remains explicit. Rates use decimal values: 0.07 means 7%.</p> : null}
          <button type="button" className="ct-scenario-lab__button" onClick={stageChange} disabled={!raw.trim()}>Add input to branch</button>
          {staged.length ? <div className="ct-scenario-lab__staged"><strong>Branch inputs · {staged.length}</strong>{staged.map((change) => <div key={change.nodeId}><span>{label(change.nodeId)}: {formatUnderwritingValue(change.baseValue)} <ArrowRight size={12} /> {formatUnderwritingValue(change.value)}</span><button type="button" onClick={() => { setStaged((current) => current.filter((item) => item.nodeId !== change.nodeId)); setReviewed(null); setPendingScenarioId(null) }} aria-label={`Remove ${label(change.nodeId)}`}>Remove</button></div>)}</div> : null}
          <label>Scenario name<input value={name} maxLength={240} onChange={(event) => { setName(event.target.value); setReviewed(null); setPendingScenarioId(null) }} placeholder="Revenue downside" /></label>
          <label>Reason<textarea value={reason} maxLength={1000} rows={2} onChange={(event) => { setReason(event.target.value); setReviewed(null); setPendingScenarioId(null) }} placeholder="Question this change tests" /></label>
          <button type="submit" className="ct-scenario-lab__button">Review exact changes <ArrowRight size={15} /></button>
          {currentReview ? <div className="ct-scenario-lab__review"><span>REVIEWED · NO MODEL RESULT YET</span><strong>{currentReview.changes.length} changed model input{currentReview.changes.length === 1 ? "" : "s"}</strong>{currentReview.changes.map((change) => <p key={change.nodeId}>{label(change.nodeId)}: {formatUnderwritingValue(change.baseValue)} <ArrowRight size={14} /> {formatUnderwritingValue(change.value)} <small>{change.unit}</small></p>)}<small>{currentReview.reason}</small><button type="button" disabled={!writable || writing !== "idle"} onClick={() => void (pendingScenarioId ? retryRun(pendingScenarioId) : recordAndRun())}>{writing === "recording" ? "Recording scenario…" : writing === "running" ? "Running model…" : pendingScenarioId ? "Retry recorded scenario run" : "Record scenario and run model"}</button></div> : null}</> : <p>This base run has no resolved model inputs supported by this editor.</p>}
        {pendingScenarioId ? <p className="ct-scenario-lab__notice">Scenario {pendingScenarioId.slice(0, 8)} is recorded. A failed or interrupted run can be retried below after refresh.</p> : null}
        {error ? <p role="alert" className="ct-scenario-lab__error">{error}</p> : null}{notice ? <p role="status" className="ct-scenario-lab__notice">{notice}</p> : null}
      </form><div className="ct-scenario-lab__comparison"><span className="ct-scenario-lab__step">02 / Read consequences</span>
        {unrunScenarios.length ? <div className="ct-scenario-lab__unrun"><strong>Recorded scenarios awaiting a run</strong>{unrunScenarios.map((item) => <div key={item.id}><span>{item.name}</span><button type="button" disabled={!writable || writing !== "idle"} onClick={() => void retryRun(item.id)}>Run</button></div>)}</div> : null}
        {branchRuns.length ? <label>Persisted branch<select value={branch?.id ?? ""} onChange={(event) => { setBranchId(event.target.value); setOutputId(null) }}>{branchId && !branch ? <option value="" disabled>New run awaiting refresh</option> : null}{branchRuns.map((run) => <option key={run.id} value={run.id}>{workspace.scenarios.find((item) => item.id === run.scenarioId)?.name ?? "Scenario"} · {dated(run.computedAt)}</option>)}</select></label> : null}
        {branchId && !branch ? <p>New persisted run {branchId.slice(0, 8)} has not appeared in this source snapshot. Refresh Canvas to check it.</p> : null}
        {branch ? <><div className="ct-scenario-lab__pair"><span>BASE<br /><strong>{base.id.slice(0, 8)}</strong></span><ArrowRight size={17} /><span>BRANCH<br /><strong>{scenario?.name ?? branch.id.slice(0, 8)}</strong></span></div>
          {diffResource.status === "loading" && !diff ? <p>Reading the persisted run comparison…</p> : null}
          {diffResource.error ? <p role="alert" className="ct-scenario-lab__error">{diffResource.error} <button type="button" onClick={diffResource.reload}>Retry</button></p> : null}
          {diff ? <><div className="ct-scenario-lab__counts"><span><strong>{Object.keys(diff.changedOutputs).length}</strong> outputs changed</span><span><strong>{Object.keys(diff.changedInputs).length}</strong> inputs changed</span><span><strong>{diff.changedChecks.length}</strong> checks changed</span></div>
            {diff.modelVersionChanged || diff.modelSemanticHashChanged || diff.engineVersionChanged || diff.artifactBindingChanged || Object.keys(diff.changedInputs).some((id) => !scenario?.definition.overrides.some((override) => override.nodeId === id)) ? <p className="ct-scenario-lab__caveat">Other model, engine, binding, or input changes are present. This comparison does not isolate the proposed input’s effect.</p> : null}
            {Object.entries(diff.changedOutputs).length ? <div className="ct-scenario-lab__outputs">{Object.entries(diff.changedOutputs).map(([id, change]) => <button key={id} type="button" aria-pressed={outputId === id} onClick={() => setOutputId(id)}><strong>{label(id)}</strong><span title={`Exact source values: ${formatUnderwritingValue(change.left)} → ${formatUnderwritingValue(change.right)}`}>{formatUnderwritingDisplayValue(change.left, base.result.outputs[id]?.unit)} <ArrowRight size={13} /> {formatUnderwritingDisplayValue(change.right, branch.result.outputs[id]?.unit)}</span><small>{diff.causalAttribution === "DEPENDENCY_GRAPH" ? (diff.causalChangedInputsByOutput[id] ?? []).length ? `Dependency path: ${(diff.causalChangedInputsByOutput[id] ?? []).map(label).join(", ")}` : "No changed input on the recorded dependency path" : "Dependency attribution unavailable"}</small></button>)}</div> : <p>No output value changed between these two persisted runs.</p>}
            {outputId && diff.changedOutputs[outputId] ? <div className="ct-scenario-lab__lineage"><strong>Why did {label(outputId)} change?</strong>{lineageResource.status === "loading" && !lineage ? <p>Reading exact output lineage…</p> : null}{lineageResource.error ? <p role="alert">{lineageResource.error}</p> : null}{lineage ? <><p>{lineage.calculation}</p><small>{lineage.directDependencies.length ? `Direct dependencies: ${lineage.directDependencies.map(label).join(", ")}` : "No direct dependencies"} · {lineage.sourceProvenance.length} source references</small></> : null}</div> : null}
            {Object.keys(diff.changedInputs).length ? <details><summary>Changed input snapshots · {Object.keys(diff.changedInputs).length}</summary>{Object.entries(diff.changedInputs).map(([id, change]) => <div className="ct-scenario-lab__input-change" key={id}><strong>{label(id)}</strong><span>{formatUnderwritingValue(change.left?.value)} <ArrowRight size={12} /> {formatUnderwritingValue(change.right?.value)}</span></div>)}</details> : null}
          </> : null}</> : branchId ? null : <p>No persisted branch run exists for this base run yet.</p>}
      </div></div>
      <UnderwritingSensitivityLab key={base.id} workspace={workspace} base={base} writable={writable} onRefresh={onRefresh} />
    </>}
  </section>
}
