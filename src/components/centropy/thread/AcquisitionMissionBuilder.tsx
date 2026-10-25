"use client"

import { useEffect, useRef, useState, type FormEvent } from "react"
import { usePathname } from "next/navigation"
import { CentropyApiError, centropyPost } from "@/components/centropy/lib/api"
import { usePrivateRequestScope } from "@/components/centropy/lib/use-private-request-scope"
import type { AcquisitionIntakeContext, AcquisitionIntakeDraft } from "../../../../finnor-os/packages/shared-types/src/acquisition-intake"
import { ACQUISITION_OBJECTIVE, buildAcquisitionMissionInput, type AcquisitionMissionBudgets, type AcquisitionReviewedRequest, type MissionStart } from "./outcome-pack-model"

type Model = NonNullable<AcquisitionIntakeContext["model"]>
type AssertionDraft = AcquisitionIntakeDraft["assertions"][number]
type FinancingCase = AcquisitionIntakeDraft["acquisition"]["financingCases"][number]
type Constraint = AcquisitionIntakeDraft["acquisition"]["constraints"][number]
type Review = { request: AcquisitionReviewedRequest; reviewDigest: string; deadlineAt: string; authorityGranted: false }
type Props = { dealId: string; mode: "shadow" | "approval" | "autopilot"; onStart: MissionStart; disabled?: boolean }
const decimalPattern = "-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?"
function lines(value: string) { return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean) }
function localTime(instant: string) { const date = new Date(instant); return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16) }
function message(error: unknown) { return error instanceof Error ? error.message : "This acquisition request could not be checked" }
function toggle(values: string[], value: string) { return values.includes(value) ? values.filter(item => item !== value) : [...values, value] }
function emptyAssertion(nodeId: string): AssertionDraft { return { nodeId, assertionId: "", question: "", rationale: "", materialityThreshold: "", knownGaps: [], observationPredicates: [] } }

export function AcquisitionMissionBuilder(props: Props) {
  const pathname = usePathname()
  const scope = usePrivateRequestScope(`acquisition-intake:${pathname}:${props.dealId}`)
  if (!scope.allowed) return <p role="status">An active owner must review the acquisition mandate and permitted source access.</p>
  return <AcquisitionContext key={scope.key} {...props} scopeKey={scope.key} isCurrent={scope.isCurrent} />
}

function AcquisitionContext({ scopeKey, isCurrent, ...props }: Props & { scopeKey: string; isCurrent: (key: string) => boolean }) {
  const [context, setContext] = useState<AcquisitionIntakeContext | null>(null)
  const [selectedModel, setSelectedModel] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [locked, setLocked] = useState(false)
  useEffect(() => {
    let active = true
    setContext(null); setError(null)
    void centropyPost<AcquisitionIntakeContext>("company-brain/acquisition-intake-context", { dealId: props.dealId, ...(selectedModel ? { modelVersionId: selectedModel } : {}) }).then(result => {
      if (!active || !isCurrent(scopeKey)) return
      if (result.dealId !== props.dealId || selectedModel && result.model?.id !== selectedModel) throw new Error("The selected Deal or model changed")
      setContext(result)
    }).catch(cause => { if (active && isCurrent(scopeKey)) setError(message(cause)) })
    return () => { active = false }
  }, [props.dealId, selectedModel, reload, scopeKey, isCurrent])
  return <section aria-label="Acquisition mission builder">
    <h3>Evaluate an acquisition</h3>
    <p>Review exact evidence questions, financial assumptions, a finite bid range and financing choices. The same Work carries the analysis into IC preparation, approved execution and economic outcome tracking.</p>
    {error ? <p role="alert">{error} <button type="button" onClick={() => setReload(value => value + 1)}>Reload acquisition choices</button></p> : null}
    {!context && !error ? <p role="status">Reading current models and permitted owner records…</p> : null}
    {context ? <>
      <label>Underwriting model and version<select value={selectedModel} disabled={props.disabled || locked} onChange={event => setSelectedModel(event.target.value)} required><option value="">Choose an exact model version</option>{context.models.map(model => <option key={model.id} value={model.id}>{model.caseTitle} · {model.name} · {model.version}</option>)}</select></label>
      {!context.models.length ? <p role="status">Setup required. This Deal needs a canonical underwriting ModelVersion before an acquisition mission can start.</p> : null}
      {context.model ? <AcquisitionForm key={context.model.id} {...props} context={context} model={context.model} scopeKey={scopeKey} isCurrent={isCurrent} onBusyChange={setLocked} /> : null}
    </> : null}
  </section>
}

function AcquisitionForm({ dealId, mode, onStart, disabled, context, model, scopeKey, isCurrent, onBusyChange }: Props & { context: AcquisitionIntakeContext; model: Model; scopeKey: string; isCurrent: (key: string) => boolean; onBusyChange: (busy: boolean) => void }) {
  const [mandateId, setMandateId] = useState("")
  const [grantId, setGrantId] = useState("")
  const [sourceIds, setSourceIds] = useState<string[]>([])
  const [consentIds, setConsentIds] = useState<string[]>([])
  const [assertions, setAssertions] = useState(() => model.primaryInputs.map(node => emptyAssertion(node.id)))
  const [parameters, setParameters] = useState<Record<string, Record<string, string>>>({})
  const [bidNodeId, setBidNodeId] = useState("")
  const [bids, setBids] = useState("")
  const [financingCases, setFinancingCases] = useState<FinancingCase[]>([])
  const [constraints, setConstraints] = useState<Constraint[]>([])
  const [maxCandidates, setMaxCandidates] = useState(256)
  const [candidateDeadline, setCandidateDeadline] = useState(120)
  const [maxSteps, setMaxSteps] = useState(96)
  const [maxActions, setMaxActions] = useState(25)
  const [maxQueries, setMaxQueries] = useState(40)
  const [deadline, setDeadline] = useState("")
  const [review, setReview] = useState<Review | null>(null)
  const [attempted, setAttempted] = useState(false)
  const [reviewMode, setReviewMode] = useState(mode)
  const [reviewBudgets, setReviewBudgets] = useState<AcquisitionMissionBudgets | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const pending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; onBusyChange(false) } }, [onBusyChange])
  const current = () => mounted.current && isCurrent(scopeKey)
  useEffect(() => { onBusyChange(busy || attempted && !submitted) }, [busy, attempted, submitted, onBusyChange])
  const mandate = context.mandates.find(item => item.ref.id === mandateId)
  const grants = context.grants.filter(item => item.mandateId === mandateId)
  const sources = context.sources.filter(item => mandate?.sourceProfileIds.includes(item.ref.id))
  const consents = context.consents.filter(item => item.sourceProfileIds.some(id => sourceIds.includes(id)))
  const scalarParameters = model.parameters.filter(node => node.shape === "scalar" && node.valueType === "decimal")
  const bidNodes = scalarParameters.filter(node => node.unit === "money" && node.currency)
  const bidNode = bidNodes.find(node => node.id === bidNodeId)
  const candidateCount = lines(bids).length * financingCases.length
  const setupMissing = !model.primaryInputs.length || !context.mandates.some(item => item.assertionIds.length === model.primaryInputs.length) || !context.grants.length || !context.sources.length || !context.consents.length || !bidNodes.length || !model.outputs.length
  function updateAssertion(index: number, patch: Partial<AssertionDraft>) { setAssertions(rows => rows.map((row, i) => i === index ? { ...row, ...patch } : row)) }
  function updateFinancing(index: number, patch: Partial<FinancingCase>) { setFinancingCases(rows => rows.map((row, i) => i === index ? { ...row, ...patch } : row)) }
  function updateConstraint(index: number, patch: Partial<Constraint>) { setConstraints(rows => rows.map((row, i) => i === index ? { ...row, ...patch } : row)) }
  function parameterValue(value: string, valueType: string): string | boolean { if (valueType === "boolean") { if (!["true", "false"].includes(value)) throw new Error("Choose every required true or false assumption"); return value === "true" } if (valueType === "decimal" && !new RegExp(`^${decimalPattern}$`).test(value)) throw new Error("Enter exact decimal values for the financial assumptions"); return value }
  async function prepare(event: FormEvent) {
    event.preventDefault()
    if (pending.current || !current() || !mandate || !bidNode?.currency) return
    pending.current = true; onBusyChange(true); setBusy(true); setError(null)
    try {
      const deadlineAt = new Date(deadline).toISOString()
      if (Date.parse(deadlineAt) <= Date.now() || Date.parse(deadlineAt) > Date.parse(mandate.deadline)) throw new Error("Choose a future deadline within the original primary mandate")
      if (!sourceIds.length || !consentIds.length || assertions.some(assertion => !assertion.observationPredicates.length)) throw new Error("Select permitted sources, consent and the observation requirements for each evidence question")
      const explicitInputs: AcquisitionIntakeDraft["explicitInputs"] = {}
      for (const node of model.parameters) {
        const entered = parameters[node.id] ?? {}
        if (node.shape === "scalar") {
          if (!entered.scalar) { if (node.required) throw new Error(`Enter the ${node.label} assumption`); continue }
          explicitInputs[node.id] = { value: parameterValue(entered.scalar, node.valueType), truthClass: "MODEL_PARAMETER" }
        } else {
          const present = model.periods.filter(period => entered[period] !== undefined && entered[period] !== "")
          if (!present.length && !node.required) continue
          if (present.length !== model.periods.length) throw new Error(`Enter ${node.label} for every model period`)
          explicitInputs[node.id] = { value: Object.fromEntries(present.map(period => [period, parameterValue(entered[period], node.valueType)])), truthClass: "MODEL_PARAMETER" }
        }
      }
      const values = lines(bids)
      if (!values.length || values.length > 64 || new Set(values).size !== values.length || values.some(value => !new RegExp(`^${decimalPattern}$`).test(value))) throw new Error("Enter up to 64 distinct exact bid amounts, one per line")
      if (!candidateCount || candidateCount > maxCandidates) throw new Error("The bid and financing matrix exceeds the selected candidate limit")
      if (constraints.some(item => !item.outputNodeId) || !constraints.length) throw new Error("Add at least one model output constraint")
      const draft: AcquisitionIntakeDraft = { dealId, modelVersionId: model.id, mandateId, grantId, sourceProfileIds: sourceIds, consentIds, assertions: assertions.map(row => ({ ...row, knownGaps: row.knownGaps.map(gap => gap.trim()).filter(Boolean) })), explicitInputs,
        acquisition: { bidDomain: { nodeId: bidNode.id, currency: bidNode.currency, values }, financingCases, constraints, limits: { maxCandidates, deadlineMs: candidateDeadline * 1000 } } }
      const result = await centropyPost<Review>("company-brain/acquisition-intake-review", draft)
      if (!current()) return
      if (result.request.dealId !== dealId || result.request.underwriting.modelVersionId !== model.id || result.authorityGranted !== false || Date.parse(deadlineAt) > Date.parse(result.deadlineAt)) throw new Error("The current acquisition scope or original deadline changed. Reload the owner records.")
      setReview(result); setReviewMode(mode); setReviewBudgets({ maxSteps, maxActions, maxQueries, maxPlannerFailures: 3, maxConsecutiveNoProgress: 5, deadlineAt })
    } catch (cause) { if (current()) setError(message(cause)) }
    finally { pending.current = false; if (current()) { setBusy(false) } }
  }
  async function start() {
    if (pending.current || !review || !reviewBudgets || !current()) return
    pending.current = true; onBusyChange(true); setBusy(true); setError(null)
    try {
      setAttempted(true)
      const input = buildAcquisitionMissionInput({ dealId, mode: reviewMode, request: review.request })
      const result = await onStart("general_operator_objective", reviewMode, ACQUISITION_OBJECTIVE, input, reviewBudgets)
      if (!current()) return
      if (!result.workId) throw new Error("The Work acceptance was not confirmed")
      setSubmitted(true)
    } catch (cause) { if (current()) { setError(message(cause)); if (cause instanceof CentropyApiError && [400, 422].includes(cause.status) && !(cause.details && typeof cause.details === "object" && "workId" in cause.details)) setAttempted(false) } }
    finally { pending.current = false; if (current()) { setBusy(false) } }
  }
  return <div>
    <p>{model.name} · {model.version}. All amounts below are declared assumptions until independently established. Material primary values start unknown.</p>
    {setupMissing ? <p role="status">Setup required. A compatible assertion mandate, original budget grant, source access, consent, primary-scoped model inputs, bid input and outputs must exist. Missing records cannot be supplied by this form.</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    <form onSubmit={event => void prepare(event)}>
      <fieldset disabled={busy || !!review || submitted || disabled}>
        <legend>Primary evidence and original authority</legend>
        <label>Primary mandate<select required value={mandateId} onChange={event => { setMandateId(event.target.value); setGrantId(""); setSourceIds([]); setConsentIds([]); setDeadline(""); setAssertions(model.primaryInputs.map(node => emptyAssertion(node.id))) }}><option value="">Choose the existing mandate</option>{context.mandates.map(item => <option key={item.ref.id} value={item.ref.id} disabled={item.assertionIds.length !== model.primaryInputs.length}>{item.objective} · {item.environment === "LIVE" ? "Protected sources" : "Disposable development sources"}</option>)}</select></label>
        {mandate ? <p>Original deadline {new Date(mandate.deadline).toLocaleString()}. Source access remains subject to current authority and admission.</p> : null}
        <label>Original primary budget grant<select required value={grantId} onChange={event => setGrantId(event.target.value)}><option value="">Choose a grant for this mandate</option>{grants.map(item => <option key={item.ref.id} value={item.ref.id}>{item.maximumMicroUsd} microUSD · {item.maximumRequests} requests · expires {new Date(item.expiresAt).toLocaleString()}</option>)}</select></label>
        <fieldset><legend>Permitted primary sources</legend>{sources.map(source => <label key={source.ref.id}><input type="checkbox" checked={sourceIds.includes(source.ref.id)} onChange={() => { setSourceIds(toggle(sourceIds, source.ref.id)); setConsentIds([]); setAssertions(rows => rows.map(row => ({ ...row, observationPredicates: [] }))) }} />{source.issuer} · {source.system} · {source.sourceClass.replaceAll("_", " ").toLowerCase()} · {source.fields.join(", ")}</label>)}{mandate && !sources.length ? <p>No current source profiles match this mandate. Owner setup is required.</p> : null}</fieldset>
        <fieldset><legend>Current source consent</legend>{consents.map(consent => <label key={consent.ref.id}><input type="checkbox" checked={consentIds.includes(consent.ref.id)} onChange={() => setConsentIds(toggle(consentIds, consent.ref.id))} />{consent.participants.join(", ")} · {new Date(consent.periodStart).toLocaleDateString()} to {new Date(consent.periodEnd).toLocaleDateString()} · expires {new Date(consent.expiresAt).toLocaleString()}</label>)}{sourceIds.length && !consents.length ? <p>Consent for these selected sources is unavailable. Owner setup is required.</p> : null}</fieldset>
        {model.primaryInputs.map((node, index) => {
          const row = assertions[index]
          const predicates = [...new Set(sources.filter(source => sourceIds.includes(source.ref.id) && source.fields.includes(node.scope.field) && node.scope.acceptableSourceClasses.some(accepted => accepted === source.sourceClass)).flatMap(source => source.observationPredicates))]
          return <fieldset key={node.id}><legend>{node.label}</legend>
            <ScopeDetails scope={node.scope} />
            <label>Registered assertion<select required value={row.assertionId} onChange={event => updateAssertion(index, { assertionId: event.target.value })}><option value="">Choose the mandate assertion</option>{mandate?.assertionIds.map(id => <option key={id} value={id} disabled={assertions.some((other, otherIndex) => otherIndex !== index && other.assertionId === id)}>{id}</option>)}</select></label>
            <label>Exact evidence question<textarea required maxLength={2000} value={row.question} onChange={event => updateAssertion(index, { question: event.target.value })} /></label>
            <label>Why this matters to the acquisition<textarea required maxLength={2000} value={row.rationale} onChange={event => updateAssertion(index, { rationale: event.target.value })} /></label>
            <label>Materiality threshold ({node.scope.semantics.currency} {node.scope.semantics.units})<input required inputMode="decimal" pattern="(?:0|[1-9][0-9]*)(?:\.[0-9]+)?" maxLength={60} value={row.materialityThreshold} onChange={event => updateAssertion(index, { materialityThreshold: event.target.value })} /></label>
            <label>Known evidence gaps, one per line<textarea value={row.knownGaps.join("\n")} onChange={event => updateAssertion(index, { knownGaps: event.target.value.split(/\r?\n/) })} /></label>
            <fieldset><legend>Required source observations</legend>{predicates.map(predicate => <label key={predicate}><input type="checkbox" checked={row.observationPredicates.includes(predicate)} onChange={() => updateAssertion(index, { observationPredicates: toggle(row.observationPredicates, predicate) })} />{predicate.replaceAll("_", " ").toLowerCase()}</label>)}{!predicates.length ? <p>Select a permitted source covering this exact financial field.</p> : null}</fieldset>
          </fieldset>
        })}
      </fieldset>
      <fieldset disabled={busy || !!review || submitted || disabled}><legend>Declared financial assumptions</legend>
        {model.parameters.map(node => <fieldset key={node.id}><legend>{node.label} · {node.currency ?? ""} {node.unit} · model parameter</legend>{(node.shape === "series" ? model.periods : ["scalar"]).map(period => <ParameterControl key={period} label={node.shape === "series" ? `${node.label}, ${period}` : node.label} node={node} value={parameters[node.id]?.[period] ?? ""} onChange={value => setParameters(current => ({ ...current, [node.id]: { ...current[node.id], [period]: value } }))} />)}</fieldset>)}
      </fieldset>
      <fieldset disabled={busy || !!review || submitted || disabled}><legend>Finite bid and financing comparison</legend>
        <label>Bid amount model input<select required value={bidNodeId} onChange={event => setBidNodeId(event.target.value)}><option value="">Choose the bid input</option>{bidNodes.map(node => <option key={node.id} value={node.id}>{node.label} · {node.currency}</option>)}</select></label>
        <label>Discrete bids in {bidNode?.currency ?? "the model currency"}, one exact amount per line<textarea required value={bids} onChange={event => setBids(event.target.value)} rows={4} /></label>
        {financingCases.map((item, index) => <fieldset key={index}><legend>Financing case {index + 1}</legend>
          <label>Case identifier<input required pattern={"[a-z][a-z0-9_\\-]{0,63}"} maxLength={64} value={item.key} onChange={event => updateFinancing(index, { key: event.target.value })} /></label>
          <label>Case name<input required maxLength={200} value={item.name} onChange={event => updateFinancing(index, { name: event.target.value })} /></label>
          {item.overrides.map((override, overrideIndex) => <fieldset key={overrideIndex}><legend>Financing assumption {overrideIndex + 1}</legend>
            <label>Model input<select required value={override.nodeId} onChange={event => updateFinancing(index, { overrides: item.overrides.map((row, i) => i === overrideIndex ? { ...row, nodeId: event.target.value } : row) })}><option value="">Choose an input</option>{scalarParameters.filter(node => node.id !== bidNodeId).map(node => <option key={node.id} value={node.id}>{node.label} · {node.currency ?? ""} {node.unit}</option>)}</select></label>
            <label>Exact value<input required inputMode="decimal" pattern={decimalPattern} maxLength={96} value={override.value} onChange={event => updateFinancing(index, { overrides: item.overrides.map((row, i) => i === overrideIndex ? { ...row, value: event.target.value } : row) })} /></label>
            <label>Reason<input required maxLength={1000} value={override.reason} onChange={event => updateFinancing(index, { overrides: item.overrides.map((row, i) => i === overrideIndex ? { ...row, reason: event.target.value } : row) })} /></label>
            <button type="button" onClick={() => updateFinancing(index, { overrides: item.overrides.filter((_, i) => i !== overrideIndex) })}>Remove financing assumption {overrideIndex + 1}</button>
          </fieldset>)}
          <button type="button" disabled={item.overrides.length >= 32} onClick={() => updateFinancing(index, { overrides: [...item.overrides, { nodeId: "", value: "", reason: "" }] })}>Add financing assumption</button>
          <button type="button" onClick={() => setFinancingCases(rows => rows.filter((_, i) => i !== index))}>Remove financing case {index + 1}</button>
        </fieldset>)}
        <button type="button" disabled={financingCases.length >= 16} onClick={() => setFinancingCases(rows => [...rows, { key: "", name: "", overrides: [] }])}>Add financing case</button>
        <p>A case with no overrides retains the declared base assumptions. Include every financing alternative you intend to compare.</p>
        {constraints.map((constraint, index) => <fieldset key={index}><legend>Acquisition constraint {index + 1}</legend>
          <label>Model output<select required value={constraint.outputNodeId} onChange={event => { const output = model.outputs.find(node => node.id === event.target.value); if (output) updateConstraint(index, { outputNodeId: output.id, unit: output.unit, currency: output.currency }) }}><option value="">Choose an output</option>{model.outputs.map(node => <option key={node.id} value={node.id}>{node.label} · {node.currency ?? ""} {node.unit}</option>)}</select></label>
          <label>Requirement<select value={constraint.operator} onChange={event => updateConstraint(index, { operator: event.target.value === "gte" ? "gte" : "lte" })}><option value="gte">At least</option><option value="lte">At most</option></select></label>
          <label>Exact threshold ({constraint.currency ?? ""} {constraint.unit})<input required inputMode="decimal" pattern={decimalPattern} maxLength={96} value={constraint.threshold} onChange={event => updateConstraint(index, { threshold: event.target.value })} /></label>
          <button type="button" onClick={() => setConstraints(rows => rows.filter((_, i) => i !== index))}>Remove constraint {index + 1}</button>
        </fieldset>)}
        <button type="button" disabled={constraints.length >= 16} onClick={() => setConstraints(rows => [...rows, { outputNodeId: "", operator: "gte", threshold: "", unit: "money" }])}>Add output constraint</button>
        <p>{candidateCount} declared candidates. Maximum bid means the highest feasible bid in this exact finite domain.</p>
        <label>Maximum candidates<input type="number" min={1} max={256} required value={maxCandidates} onChange={event => setMaxCandidates(Number(event.target.value))} /></label>
        <label>Financial search deadline in seconds<input type="number" min={1} max={300} required value={candidateDeadline} onChange={event => setCandidateDeadline(Number(event.target.value))} /></label>
      </fieldset>
      <fieldset disabled={busy || !!review || submitted || disabled}><legend>Original mission allowance</legend>
        <label>Maximum steps<input type="number" min={1} max={96} required value={maxSteps} onChange={event => setMaxSteps(Number(event.target.value))} /></label>
        <label>Maximum actions<input type="number" min={0} max={25} required value={maxActions} onChange={event => setMaxActions(Number(event.target.value))} /></label>
        <label>Maximum queries<input type="number" min={1} max={40} required value={maxQueries} onChange={event => setMaxQueries(Number(event.target.value))} /></label>
        <label>Mission deadline within the original mandate<input type="datetime-local" required value={deadline} max={mandate ? localTime(mandate.deadline) : undefined} onChange={event => setDeadline(event.target.value)} /></label>
        <p>The original allowance permits at most 3 planner failures and 5 consecutive steps without progress. Retrying preserves the original limits and deadline.</p>
      </fieldset>
      {!review ? <button type="submit" disabled={busy || submitted || disabled || setupMissing}>{busy ? "Checking current owner records…" : "Review exact acquisition mission"}</button> : null}
    </form>
    {review && reviewBudgets ? <section aria-label="Reviewed acquisition mission"><h4>Review the complete acquisition mission</h4><p>{ACQUISITION_OBJECTIVE}</p>
      <p>Deal {dealId}. Model {model.name}, version {model.version}. Primary acquisition is {review.request.primary.mode === "protected" ? "protected" : "disposable development"}. Execution mode {reviewMode}.</p>
      {review.request.primary.assertions.map(assertion => <article key={assertion.assertionId}><h5>{assertion.exactPredicate}</h5><p>{assertion.materiality.rationale}</p><p>Original value remains unknown. Materiality threshold {assertion.materiality.threshold.numerator}/{assertion.materiality.threshold.denominator} {assertion.semantics.currency} {assertion.semantics.units}.</p><p>Known gaps {assertion.knownGaps.join(", ") || "none declared"}. Required observations {assertion.observationPredicates.join(", ")}.</p><ScopeDetails scope={assertion} /></article>)}
      <dl>{Object.entries(review.request.underwriting.explicitInputs ?? {}).flatMap(([id, input]) => typeof input.value === "object" && input.value !== null ? Object.entries(input.value).map(([period, value]) => <div key={`${id}:${period}`}><dt>{model.parameters.find(node => node.id === id)?.label ?? id} · {period}</dt><dd>{String(value)} · declared model parameter</dd></div>) : [<div key={id}><dt>{model.parameters.find(node => node.id === id)?.label ?? id}</dt><dd>{String(input.value)} · declared model parameter</dd></div>])}</dl>
      <p>Bid amounts {review.request.acquisition.bidDomain.values.join(", ")} {review.request.acquisition.bidDomain.currency}.</p>
      {review.request.acquisition.financingCases.map(item => <article key={item.key}><h5>{item.name}</h5>{item.overrides.length ? item.overrides.map(override => <p key={override.nodeId}>{model.parameters.find(node => node.id === override.nodeId)?.label ?? override.nodeId} = {override.value}. {override.reason}</p>) : <p>Retain the declared base assumptions.</p>}</article>)}
      <ul>{review.request.acquisition.constraints.map((constraint, index) => <li key={index}>{model.outputs.find(node => node.id === constraint.outputNodeId)?.label ?? constraint.outputNodeId} {constraint.operator === "gte" ? "at least" : "at most"} {constraint.threshold} {constraint.currency ?? ""} {constraint.unit}</li>)}</ul>
      <p>Financial search limit {review.request.acquisition.limits.maxCandidates} candidates and {review.request.acquisition.limits.deadlineMs / 1000} seconds. Mission limit {reviewBudgets.maxSteps} steps, {reviewBudgets.maxActions} actions and {reviewBudgets.maxQueries} queries until {new Date(reviewBudgets.deadlineAt).toLocaleString()}.</p>
      <p>Completion requires acquisition-qualified IC preparation and verified closing. Realized economic outcome remains a separate manual verification gate requiring prospective measurement, authenticated settlement and costs. This review grants no authority and establishes no findings or realized profit.</p>
      {attempted && !submitted ? <p>Acceptance may be incomplete. Retry preserves this exact request. Inspect the linked Work before changing the mission.</p> : null}
      <details><summary>Inspect exact review and owner references</summary><p>Review digest {review.reviewDigest}. Model meaning {model.semanticHash}.</p>{[review.request.primary.mandateRef, review.request.primary.authorityProfileRef, review.request.primary.budgetGrantRef, ...review.request.primary.sourceProfileRefs, ...review.request.primary.consentRefs, ...review.request.primary.referenceSemanticsRefs].map(ref => <p key={`${ref.owner}:${ref.id}`}>{ref.owner} · {ref.id} · revision {ref.revision} · {ref.contentDigest}</p>)}</details>
      {submitted ? <p role="status">Accepted on the linked Work. Progress and completion remain subject to its recorded evidence and approvals.</p> : <><button type="button" disabled={busy || disabled || attempted} onClick={() => { setReview(null); setReviewBudgets(null); setError(null) }}>Edit before starting</button><button type="button" disabled={busy || disabled} onClick={() => void start()}>{busy ? "Starting the reviewed mission…" : attempted ? "Retry this same reviewed mission" : "Start this reviewed acquisition mission"}</button></>}
    </section> : null}
  </div>
}

function ParameterControl({ label, node, value, onChange }: { label: string; node: Model["parameters"][number]; value: string; onChange: (value: string) => void }) {
  return <label>{label}{node.valueType === "boolean" ? <select required={node.required} value={value} onChange={event => onChange(event.target.value)}><option value="">Choose a declared assumption</option><option value="true">True</option><option value="false">False</option></select> : <input required={node.required} type={node.valueType === "date" ? "date" : "text"} inputMode={node.valueType === "decimal" ? "decimal" : undefined} pattern={node.valueType === "decimal" ? decimalPattern : undefined} maxLength={4096} value={value} onChange={event => onChange(event.target.value)} />}</label>
}

function ScopeDetails({ scope }: { scope: Model["primaryInputs"][number]["scope"] }) {
  const meaning = scope.semantics, coverage = scope.requiredCoverage
  return <details><summary>Exact entity, period, population and financial meaning</summary>
    <p>Entity {meaning.legalEntityId}. Perimeter {meaning.perimeter.join(", ")}. Accounts or participants {meaning.accountOrParticipantIds.join(", ")}.</p>
    <p>{meaning.periodStart} to {meaning.periodEnd}. Cutoff {meaning.cutoff}. {meaning.currency} {meaning.units}, scale {meaning.scale.numerator}/{meaning.scale.denominator}, sign {meaning.signConvention}.</p>
    <p>{scope.predicateKind} · field {scope.field}. Exact economic records {scope.economicRecordIds.join(", ") || "population acquisition"}.</p>
    <p>Population {coverage.populationId}, revision {coverage.populationRevision}. Members {coverage.members.join(", ")}. Required records {coverage.requiredRecordKinds.join(", ")}. {coverage.completePopulation ? "Complete population required." : "Partial population declared."} Minimum coverage {coverage.minimumCoverage.numerator}/{coverage.minimumCoverage.denominator}, error tolerance {coverage.errorTolerance.numerator}/{coverage.errorTolerance.denominator}.</p>
    <p>Gross/net {meaning.grossNetTreatment}. Recognition {meaning.recognitionRule}. Calendar {meaning.calendarRef}. Consolidation {meaning.consolidationRef}. Time basis {meaning.timeBasis}. Accepted source classes {scope.acceptableSourceClasses.join(", ")}.</p>
    <p>Meaning owner {meaning.basisRef.owner}, {meaning.basisRef.id}, revision {meaning.basisRef.revision}, digest {meaning.basisRef.contentDigest}.</p>
    {coverage.measurementDesignRef ? <p>Measurement design {coverage.measurementDesignRef.id} requires supported execution and qualification.</p> : null}
  </details>
}
