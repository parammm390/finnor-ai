"use client"

import { useEffect, useState } from "react"
import { ArrowRight, CircleAlert, ShieldCheck } from "lucide-react"
import { z } from "zod"
import { centropyGet } from "@/components/centropy/lib/api"
import type { PeWorldRootRef } from "@/components/centropy/pe/contracts"
import type { WorkAggregateView } from "@/components/centropy/product/contracts"
import { buildGeneralDealMissionInput, type DealMissionCheck } from "./outcome-pack-model"

const PackId = z.enum([
  "deal_to_verified_closing_readiness",
  "deal_request_resolution",
  "critical_deal_dependency_resolution",
  "general_operator_objective",
])
const Mode = z.enum(["shadow", "approval", "autopilot"])
const Pack = z.object({
  definition: z.object({
    id: PackId,
    title: z.string(),
    objectiveClass: z.string(),
    evidenceRequirements: z.array(z.string()),
    approvalBoundaries: z.array(z.string()),
    terminalBlockedConditions: z.array(z.string()),
    verificationRules: z.array(z.string()),
  }),
  setting: z.object({ enabled: z.boolean(), defaultMode: Mode, revision: z.number().int() }),
  readiness: z.object({
    state: z.string(), eligible: z.boolean(), evaluatedAt: z.string(),
    gates: z.array(z.object({ code: z.string(), passed: z.boolean() })),
    metrics: z.object({ totalRuns: z.number(), verifiedRuns: z.number(), verificationCoverage: z.number() }),
  }),
})
type OutcomePack = z.infer<typeof Pack>
type PackIdValue = z.infer<typeof PackId>
type PackMode = z.infer<typeof Mode>

function words(value: string) { return value.replaceAll("_", " ").toLowerCase() }
function verificationState(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const state = (value as Record<string, unknown>).state
  return typeof state === "string" ? state : null
}

export function OutcomePacks({ root, run, onStart }: {
  root: PeWorldRootRef | null
  run: WorkAggregateView["outcomePack"]
  onStart: (packId: PackIdValue, mode: PackMode, title: string, input: Record<string, unknown>) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [catalog, setCatalog] = useState<OutcomePack[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<PackIdValue | null>(null)
  const [mode, setMode] = useState<PackMode>("approval")
  const [busy, setBusy] = useState(false)
  const [reload, setReload] = useState(0)
  const [generalObjective, setGeneralObjective] = useState("")
  const [generalCheck, setGeneralCheck] = useState<DealMissionCheck>("closing_readiness")
  const dealId = root?.entityType === "pe_deal" ? root.entityId : null

  useEffect(() => {
    if (!open) return
    let active = true
    setCatalog(null)
    setError(null)
    void centropyGet<unknown>("outcome-packs").then((result) => {
      if (!active) return
      setCatalog(z.object({ packs: Pack.array() }).parse(result).packs)
      setError(null)
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : "Outcome Pack catalog unavailable")
    })
    return () => { active = false }
  }, [open, reload])

  useEffect(() => {
    setSelected(null)
    setGeneralObjective("")
  }, [dealId])

  async function start(pack: OutcomePack) {
    if (!dealId || busy) return
    setBusy(true)
    setError(null)
    try {
      const general = pack.definition.id === "general_operator_objective"
      const input = general
        ? buildGeneralDealMissionInput({ dealId, mode, objective: generalObjective, check: generalCheck })
        : { dealId, mode }
      await onStart(pack.definition.id, mode, general ? generalObjective.trim() : pack.definition.title, input)
      setSelected(null)
      setOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The mission was not accepted")
    } finally { setBusy(false) }
  }

  if (!dealId && !run) return null
  return <section className="ct-missions" aria-label="Outcome Pack missions">
    {run ? <div className="ct-missions__current">
      <span className="ct-eyebrow">BOUND MISSION · {words(run.mode)}</span>
      <strong>{run.objective}</strong>
      <dl>
        <div><dt>Pack</dt><dd>{words(run.packId)}</dd></div>
        <div><dt>Run</dt><dd>{words(run.status)}</dd></div>
        <div><dt>Completion proof</dt><dd>{verificationState(run.finalVerification) ? words(verificationState(run.finalVerification)!) : "not recorded"}</dd></div>
        {run.latestAutonomyDecision ? <div><dt>Last authority decision</dt><dd>{words(run.latestAutonomyDecision.outcome)}</dd></div> : null}
      </dl>
      {run.blockedReason ? <p className="ct-missions__caveat">Blocked: {run.blockedReason}</p> : null}
      {run.latestAutonomyDecision?.reasonCodes.length ? <p className="ct-missions__caveat">Authority reasons: {run.latestAutonomyDecision.reasonCodes.map(words).join(", ")}</p> : null}
      <small>Progress and verification are read from this Work and its persisted Outcome Pack run.</small>
    </div> : null}
    {dealId ? <button type="button" className="ct-missions__toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}><ShieldCheck size={15} aria-hidden /> {open ? "Close bounded missions" : "Explore bounded missions"} <ArrowRight size={14} aria-hidden /></button> : null}
    {open ? <div className="ct-missions__catalog">
      <p>Deal missions bind one exact Deal to durable Work, an explicit success condition, and recorded evidence. Starting one changes the active Work in this Investigation.</p>
      {!catalog && !error ? <p role="status">Reading mission readiness…</p> : null}
      {error ? <p className="ct-missions__error" role="alert">{error} <button type="button" onClick={() => { setError(null); setReload((value) => value + 1) }}>Retry</button></p> : null}
      {catalog?.map((pack) => <article key={pack.definition.id}>
        <button type="button" className="ct-missions__pack" aria-expanded={selected === pack.definition.id} onClick={() => { setSelected(selected === pack.definition.id ? null : pack.definition.id); setMode(["APPROVAL_CERTIFIED", "AUTOPILOT_ELIGIBLE"].includes(pack.readiness.state) ? "approval" : "shadow") }}><span><strong>{pack.definition.title}</strong><small>{pack.readiness.state.replaceAll("_", " ")} · {pack.setting.enabled ? "enabled" : "disabled"}</small></span><ArrowRight size={15} aria-hidden /></button>
        {selected === pack.definition.id ? <div className="ct-missions__review">
          <p>Evidence: {pack.definition.evidenceRequirements.join(" · ")}</p>
          <p>Human boundaries: {pack.definition.approvalBoundaries.join(" · ")}</p>
          <p>Verification: {pack.definition.verificationRules.join(" · ")}</p>
          <p>Recorded runs: {pack.readiness.metrics.verifiedRuns} verified of {pack.readiness.metrics.totalRuns} terminal; coverage {Math.round(pack.readiness.metrics.verificationCoverage * 100)}%.</p>
          {pack.readiness.gates.some((gate) => !gate.passed) ? <p className="ct-missions__caveat"><CircleAlert size={13} aria-hidden /> Autopilot gates unmet: {pack.readiness.gates.filter((gate) => !gate.passed).map((gate) => words(gate.code)).join(", ")}.</p> : null}
          {pack.definition.id === "general_operator_objective" ? <>
            <p>This builder binds the general mission to the selected Deal. State the exact objective and choose the canonical condition that must pass.</p>
            <label>Objective <textarea value={generalObjective} maxLength={10_000} onChange={(event) => setGeneralObjective(event.target.value)} placeholder="State the bounded outcome for this Deal" /></label>
            <label>Completion check <select value={generalCheck} onChange={(event) => setGeneralCheck(event.target.value as DealMissionCheck)}><option value="closing_readiness">Closing readiness is eligible</option><option value="open_requests">No open Deal requests</option><option value="critical_dependencies">No unresolved critical dependencies</option></select></label>
          </> : null}
          <>
            <label>Execution mode <select value={mode} onChange={(event) => setMode(Mode.parse(event.target.value))}><option value="shadow">Shadow: hypothetical effects</option><option value="approval" disabled={!(["APPROVAL_CERTIFIED", "AUTOPILOT_ELIGIBLE"].includes(pack.readiness.state))}>Approval: human gates</option><option value="autopilot" disabled={!pack.readiness.eligible}>Autopilot: eligible grant required</option></select></label>
            <button type="button" className="ct-missions__start" disabled={busy || !pack.setting.enabled || !dealId || (pack.definition.id === "general_operator_objective" && !generalObjective.trim()) || (mode === "autopilot" && !pack.readiness.eligible)} onClick={() => void start(pack)}>{busy ? "Starting…" : `Start for Deal ${dealId?.slice(0, 8)}`} <ArrowRight size={14} aria-hidden /></button>
          </>
          <small>Current readiness is a catalog evaluation. The runtime still checks policy and authority for each effect.</small>
        </div> : null}
      </article>)}
    </div> : null}
  </section>
}
