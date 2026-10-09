"use client"

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { centropyPost as jarvisPost, CentropyApiError as JarvisApiError } from "@/components/centropy/lib/api"
import { useCentropyAuth as useJarvisAuth } from "@/components/centropy/lib/centropy-auth"
import { onBusinessInvalidation } from "@/components/centropy/lib/business-invalidation"
import { DecisionWitnessViewSchema, type DecisionWitnessView } from "./decision-slice-view"
import {
  CapitalAcceptedViewSchema, CapitalBranchReviewViewSchema, CapitalContextViewSchema, CapitalModuleViewSchema, CapitalQueryViewSchema,
  CapitalWitnessViewSchema, type CapitalPolicyView, type CapitalQueryView, type CapitalWitnessView,
} from "./capital-program-view"
import { OriginalChallengePanel } from "./OriginalChallengePanel"
import { ExactControlReview } from "./ExactControlReview"
import "./capital-program.css"

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const label = (value: string) => value.replaceAll("_", " ").toLowerCase()
const pending = (value: CapitalQueryView | null) => Boolean(value && ["QUEUED", "RUNNING"].includes(value.status))
type Scoped<T> = { scope: string; value: T }
type DerivedInput = { key: string; nodeId: string; derivationId: string; output: string }

export function CapitalProgramPanel({ workId, root }: {
  workId: string; root: { entityType: string; entityId: string }
}) {
  const auth = useJarvisAuth(), router = useRouter(), pathname = usePathname(), search = useSearchParams()
  const sessionScope = useRef({ token: auth.session?.access_token, version: 0 })
  if (sessionScope.current.token !== auth.session?.access_token)
    sessionScope.current = { token: auth.session?.access_token, version: sessionScope.current.version + 1 }
  const scope = `${auth.session?.user.id ?? "signed-out"}:${sessionScope.current.version}:${workId}:${root.entityType}:${root.entityId}`
  const authorized = Boolean(auth.session && auth.role === "owner" && !auth.roleError && !auth.loading && !auth.roleLoading)
  const queryParameter = search.get("capitalQuery")
  const [policies, setPolicies] = useState<Scoped<CapitalPolicyView[]> | null>(null)
  const [policyId, setPolicyId] = useState(""), [actionId, setActionId] = useState(""), [exposureId, setExposureId] = useState("")
  const [unit, setUnit] = useState(""), [terms, setTerms] = useState(""), [starts, setStarts] = useState("0")
  const [waitStop, setWaitStop] = useState(true)
  const [staged, setStaged] = useState(true), [stageFraction, setStageFraction] = useState("0.5")
  const [observable, setObservable] = useState(false), [instrumentId, setInstrumentId] = useState(""), [tokens, setTokens] = useState<string[]>([])
  const [inquiry, setInquiry] = useState(false), [inquiryActionId, setInquiryActionId] = useState("")
  const [agreement, setAgreement] = useState("COUNTERPARTY_REQUIRED")
  const [purpose, setPurpose] = useState("COMMERCIAL"), [financial, setFinancial] = useState(false)
  const [investmentCaseId, setInvestmentCaseId] = useState(""), [modelVersionId, setModelVersionId] = useState("")
  const [financialKind, setFinancialKind] = useState("entry.enterprise_value"), [facilityId, setFacilityId] = useState("")
  const [currency, setCurrency] = useState("USD"), [instrument, setInstrument] = useState(""), [calendar, setCalendar] = useState("OWNER_RECORDED")
  const [derivedInputs, setDerivedInputs] = useState<DerivedInput[]>([])
  const [query, setQuery] = useState<Scoped<CapitalQueryView> | null>(null)
  const [witness, setWitness] = useState<Scoped<CapitalWitnessView> | null>(null)
  const [sourceWitness, setSourceWitness] = useState<Scoped<DecisionWitnessView> | null>(null)
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("Load current arrangements to begin.")
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0), writing = useRef<number | null>(null), scopeRef = useRef(scope), inspection = useRef<HTMLElement>(null)
  const opener = useRef<HTMLButtonElement | null>(null), sourceGeneration = useRef(0)
  scopeRef.current = scope
  const current = authorized && query?.scope === scope && query.value.queryId === queryParameter ? query.value : null
  const program = current?.program && Date.now() < Date.parse(current.program.envelope.validUntil) ? current.program : null
  const available = authorized && policies?.scope === scope ? policies.value : []
  const policy = available.find(item => item.ref.id === policyId)
  const actions = policy?.problem.actions.filter(item => item.kind === "INTERVENE") ?? []
  const selectedAction = actions.find(item => item.id === actionId)
  const observations = policy?.problem.observations.filter(item => item.afterActionIds.includes(actionId)) ?? []
  const observation = observations.find(item => item.id === instrumentId)
  const inquiries = policy?.problem.actions.filter(item => item.kind === "INQUIRE" && item.protocolRef) ?? []
  const proof = authorized && witness?.scope === scope && program ? witness.value : null
  const source = authorized && sourceWitness?.scope === scope && proof ? sourceWitness.value : null
  const clear = useCallback(() => { setQuery(null); setWitness(null); setSourceWitness(null) }, [])
  const active = (epoch: number) => generation.current === epoch && scopeRef.current === scope && document.visibilityState === "visible"

  const refresh = useCallback(async (id: string, epoch: number) => {
    try {
      const next = CapitalQueryViewSchema.parse(await jarvisPost("company-brain/capital-program-read", { queryId: id }))
      if (epoch !== generation.current || scopeRef.current !== scope || document.visibilityState !== "visible") return
      if (next.workId !== workId || next.program && next.program.envelope.work.id !== workId) throw Error("Work binding differs.")
      setQuery({ scope, value: next })
      if (!next.program) { setWitness(null); setSourceWitness(null) }
      setNotice(next.failure?.requirement ?? (next.program ? "Current modeled alternatives. No agreement or execution authority is granted." : label(next.status)))
      setError(null)
      return next
    } catch (cause) {
      if (epoch !== generation.current || scopeRef.current !== scope) return
      clear(); setPolicies(null)
      setError(cause instanceof JarvisApiError && [401, 403, 404].includes(cause.status)
        ? "Arrangements are unavailable in your current access scope. Values cleared."
        : "Current arrangements could not be verified. Values cleared. Reload or recompile.")
    }
  }, [scope, workId, clear])

  useEffect(() => {
    generation.current++; clear(); setPolicies(null); setPolicyId(""); setActionId(""); setExposureId("")
    setUnit(""); setTerms(""); setBusy(false); writing.current = null; setError(null)
    setObservable(false); setInstrumentId(""); setTokens([]); setInquiry(false); setInquiryActionId("")
    setFinancial(false); setInvestmentCaseId(""); setModelVersionId(""); setFacilityId(""); setInstrument(""); setDerivedInputs([])
    setStarts("0"); setWaitStop(true); setStaged(true); setStageFraction("0.5"); setAgreement("COUNTERPARTY_REQUIRED")
    setPurpose("COMMERCIAL"); setFinancialKind("entry.enterprise_value"); setCurrency("USD"); setCalendar("OWNER_RECORDED")
  }, [scope, authorized, clear])

  useEffect(() => {
    if (!authorized || !queryParameter || !uuid.test(queryParameter)) return
    let cancelled = false, reading = false, timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      clearTimeout(timer)
      if (cancelled) return
      if (document.visibilityState === "visible" && writing.current === null && !reading) {
        reading = true
        try {
          const next = await refresh(queryParameter, generation.current)
          delay = next?.program ? 10000 : next && ["QUEUED", "RUNNING"].includes(next.status) ? 1000 : 4000
        } finally { reading = false }
      }
      if (!cancelled) { clearTimeout(timer); timer = setTimeout(() => void tick(), delay) }
    }
    let delay = 1000
    const fence = () => { generation.current++ }
    const invalidate = () => { fence(); clear(); setPolicies(null) }
    const visible = () => { invalidate(); if (document.visibilityState === "visible") void tick() }
    const unsubscribe = onBusinessInvalidation(signal => {
      if (/company-brain\/(?:capital-program-|counterexample-|challenge-submit)/.test(signal.path ?? "")) return
      if (signal.tags.some(tag => ["work", "company-brain", "authority", "underwriting", "source"].includes(tag))) {
        invalidate(); void tick()
      }
    })
    void tick()
    window.addEventListener("pagehide", invalidate); document.addEventListener("visibilitychange", visible)
    return () => { cancelled = true; fence(); clearTimeout(timer); unsubscribe()
      window.removeEventListener("pagehide", invalidate); document.removeEventListener("visibilitychange", visible) }
  }, [authorized, queryParameter, refresh, clear])

  useEffect(() => {
    if (!current?.program) return
    const expiry = Date.parse(current.program.envelope.validUntil) - Date.now()
    const timer = setTimeout(() => {
      generation.current++; setWitness(null); setSourceWitness(null)
      setQuery(previous => previous?.scope === scope ? { scope, value: { ...previous.value, program: null, branchReviews: [] } } : previous)
      setNotice("The modeled arrangements expired. Values cleared. Recheck or recompile the current Work.")
    }, Math.max(0, expiry))
    return () => clearTimeout(timer)
  }, [current?.program, scope])

  function pin(id: string) {
    const params = new URLSearchParams(search.toString()); params.set("capitalQuery", id); params.delete("capitalChallenge")
    router.replace(`${pathname}?${params}`, { scroll: false })
  }
  const unavailableChallenge = useCallback(() => {
    generation.current++; clear(); setPolicies(null); setError("Current owner values could not be verified. Values cleared.")
  }, [clear])
  const repairedChallenge = useCallback((id: string) => {
    generation.current++; clear(); setNotice("Durable original economic repair queued. No grant or authority renewed.")
    const params = new URLSearchParams(search.toString()); params.set("capitalQuery", id); params.delete("capitalChallenge")
    router.replace(`${pathname}?${params}`, { scroll: false })
  }, [clear, search, router, pathname])
  async function perform(message: string, run: (epoch: number) => Promise<void>) {
    if (!authorized || writing.current !== null || document.visibilityState !== "visible") return
    const epoch = ++generation.current
    writing.current = epoch; setBusy(true); setError(null); setNotice(message); setWitness(null); setSourceWitness(null)
    try { await run(epoch) }
    catch (cause) {
      if (!active(epoch)) return
      clear(); setPolicies(null); setError(cause instanceof JarvisApiError && cause.status === 409
        ? `Owner refused: ${cause.message}. No capital was reserved or effect prepared.`
        : cause instanceof JarvisApiError && [401, 403, 404].includes(cause.status)
          ? "Arrangements are unavailable in your current access scope. Values cleared."
          : cause instanceof Error ? cause.message : "Arrangements unavailable. Values cleared.")
    } finally { if (writing.current === epoch) { writing.current = null; setBusy(false) } }
  }
  function loadPolicies() {
    void perform("Reading current permitted arrangements…", async epoch => {
      clear()
      const context = CapitalContextViewSchema.parse(await jarvisPost("company-brain/capital-program-context", { workId, root }))
      if (context.workId !== workId) throw Error("Owner returned a different Work.")
      if (!active(epoch)) return
      const eligible = context.policies.filter(item => item.resultState === "POLICY_AVAILABLE")
      setPolicies({ scope, value: eligible }); setNotice(eligible.length ? "Choose an arrangement and its permitted parameter domain." : "No current owner arrangement is available for this Work and company.")
    })
  }
  function submit(event: FormEvent) {
    event.preventDefault()
    if (!policy || !selectedAction) return
    void perform("Request accepted locally. Binding current Work and sources…", async epoch => {
      clear()
      const allowedTerms = terms.split(",").map(item => item.trim()), periodText = starts.split(",").map(item => item.trim())
      const periods = periodText.map(Number)
      if (!terms.trim() || allowedTerms.length > 16 || !unit.trim()) throw Error("Supply exact owner units and one to sixteen comma-separated decimal terms.")
      if (periodText.some(item => !/^\d+$/.test(item)) || periods.some(item => item < 0 || item >= policy.mandate.horizon.periods)) throw Error("Start periods must lie within the original owner horizon.")
      if (observable && (!observation || !tokens.length)) throw Error("Choose a registered observable milestone and its received release tokens.")
      if (inquiry && !inquiries.some(item => item.id === inquiryActionId)) throw Error("Choose an existing current owner inquiry and protocol.")
      if (financial && (!uuid.test(investmentCaseId) || !uuid.test(modelVersionId) || !instrument.trim() ||
        financialKind.startsWith("debt_input.") && !/^[A-Za-z0-9_-]+$/.test(facilityId))) throw Error("Link exact existing financial model and instrument identifiers.")
      if (financial && (derivedInputs.some(item => !item.nodeId.trim() || !uuid.test(item.derivationId) || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(item.output)) ||
        new Set(derivedInputs.map(item => item.nodeId.trim())).size !== derivedInputs.length)) throw Error("Each derived input needs a distinct exact native node, current P4 derivation and output.")
      const structures = ["IMMEDIATE", ...(staged ? ["STAGED"] : []), ...(observable ? ["OBSERVABLE_STAGE"] : []), ...(inquiry ? ["INQUIRY_OPTION"] : []), ...(waitStop ? ["WAIT_STOP"] : [])]
      const financialNode = financialKind.startsWith("debt_input.") ? `debt_input.${facilityId}.${financialKind.slice("debt_input.".length)}` : financialKind
      const horizon = policy.mandate.horizon
      const accepted = CapitalAcceptedViewSchema.parse(await jarvisPost("company-brain/capital-program-submit", {
        schema: "finnor.capital-program-request.v2", workId, idempotencyKey: crypto.randomUUID(),
        incumbentPolicyRef: policy.ref, purpose,
        permitted: { actionId, exposureId, unit: unit.trim(), terms: allowedTerms, startPeriods: periods,
          structures, stageFractions: staged || observable ? [stageFraction] : [], resourceRule: "SCALE_REGISTERED_ACTION_LINEAR", agreement,
          ...(observable ? { milestone: { instrumentId, tokens } } : {}), ...(inquiry ? { inquiryActionId } : {}) },
        ...(financial ? { financial: { investmentCaseId, modelVersionId, nodeId: financialNode,
          semantics: { entityType: root.entityType, entityId: root.entityId, periodStart: horizon.startAt,
            periodEnd: new Date(Date.parse(horizon.startAt) + horizon.periodMs * horizon.periods).toISOString(),
            unit: financialKind === "debt_input.fixed_rate" ? "rate" : "currency",
            currencyCode: financialKind === "debt_input.fixed_rate" ? null : currency, frequency: "instant", calendar,
            consolidation: "OWNER_SUBJECT_ONLY", instrument: instrument.trim(), scale: "1", sign: "AS_RECORDED" },
          ...(derivedInputs.length ? { evidenceDerivationInputs: Object.fromEntries(derivedInputs.map(item =>
            [item.nodeId.trim(), { derivationId: item.derivationId, output: item.output }])) } : {}) } } : {}),
        resource: { deadlineMs: 30000, maxAttempts: 8, maxGenerated: 64, maxExpansions: 50000,
          maxRefinementSteps: 4096, maxRefinementDepth: 6, maxModuleBytes: 65536, maxResultBytes: 8388608 },
      }))
      if (!active(epoch)) return
      if (accepted.workId !== workId) throw Error("Accepted request belongs to a different Work.")
      pin(accepted.queryId); setNotice("Durable search queued. All alternatives remain proposals.")
    })
  }
  function control(operation: "cancel" | "resume" | "recompile") {
    if (!current) return
    const id = current.queryId
    void perform(operation === "cancel" ? "Cancelling new search work…" : "Rechecking the original Work and grant…", async epoch => {
      clear()
      const response = await jarvisPost(`company-brain/capital-program-${operation}`, {
        queryId: id, ...(operation === "recompile" ? { idempotencyKey: crypto.randomUUID() } : {}),
      })
      if (!active(epoch)) return
      if (operation === "recompile") pin(CapitalAcceptedViewSchema.parse(response).queryId)
      else await refresh(id, epoch)
    })
  }
  function inspect(candidateDigest: string, button: HTMLButtonElement) {
    if (!current || !program) return
    opener.current = button
    const id = current.queryId
    void perform("Reading exact current arrangement witnesses…", async epoch => {
      const response = CapitalWitnessViewSchema.parse(await jarvisPost("company-brain/capital-program-witness", { queryId: id, candidateDigest }))
      if (response.candidate.semanticDigest !== candidateDigest) throw Error("Witness does not match this arrangement.")
      if (!active(epoch)) return
      setWitness({ scope, value: response }); requestAnimationFrame(() => inspection.current?.focus())
    })
  }
  function inspectSource(variableId: string) {
    if (!program?.evidenceSlice) return
    const ref = program.evidenceSlice
    const epoch = generation.current, sourceEpoch = ++sourceGeneration.current
    setSourceWitness(null)
    void jarvisPost("company-brain/decision-slice-witness", { sliceRef: ref, variableId }).then(value => {
      const parsed = DecisionWitnessViewSchema.parse(value)
      if (parsed.sliceRef.contentDigest !== ref.contentDigest || parsed.variable.id !== variableId) throw Error("Source witness binding differs.")
      if (active(epoch) && sourceEpoch === sourceGeneration.current) setSourceWitness({ scope, value: parsed })
    }).catch(() => { if (active(epoch) && sourceEpoch === sourceGeneration.current) { clear(); setPolicies(null); setError("Source witness is no longer current. Values cleared.") } })
  }
  function download(moduleDigest: string) {
    if (!current) return
    const id = current.queryId
    void perform("Revalidating executable bytes before download…", async epoch => {
      const response = CapitalModuleViewSchema.parse(await jarvisPost("company-brain/capital-program-module", { queryId: id, moduleDigest }))
      const bytes = new TextEncoder().encode(response.bytes)
      const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("")
      if (sha !== response.sha256 || response.ref.contentDigest !== moduleDigest) throw Error("Downloaded bytes failed their content check.")
      if (!active(epoch)) return
      const url = URL.createObjectURL(new Blob([bytes], { type: response.contentType }))
      const link = document.createElement("a"); link.href = url; link.download = `capital-module-${moduleDigest}.json`; link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000); setNotice("Exact checked executable module downloaded. It grants no execution authority.")
    })
  }
  function reviewBranch(candidateDigest: string) {
    if (!current || !program) return
    const id = current.queryId, programDigest = program.ref.contentDigest
    void perform("Reviewing the exact current native model branch…", async epoch => {
      const response = await jarvisPost("company-brain/capital-program-select", {
        queryId: id, candidateDigest, idempotencyKey: crypto.randomUUID(), intent: "MODEL_BRANCH_REVIEW",
      }) as { review?: unknown }
      const review = CapitalBranchReviewViewSchema.parse(response.review)
      if (review.queryId !== id || review.candidateDigest !== candidateDigest || review.programRef.contentDigest !== programDigest) throw Error("Owner branch review binding differs.")
      if (!active(epoch)) return
      await refresh(id, epoch)
      setNotice("Native S4 model branch reviewed. No decision coverage, capital reservation, agreement or effect authority is granted.")
    })
  }
  function updateDerivedInput(key: string, field: "nodeId" | "derivationId" | "output", value: string) {
    setDerivedInputs(previous => previous.map(item => item.key === key ? { ...item, [field]: value } : item))
  }
  const evidence = proof?.evidenceSlice && typeof proof.evidenceSlice === "object" && "materialVariables" in proof.evidenceSlice
    ? DecisionWitnessVariables(proof.evidenceSlice) : []

  return <section className="ct-capital-program" aria-label="Economic arrangements" aria-busy={busy}>
    <ExactControlReview scope={scope} authorized={authorized} workId={workId} root={root} />
    <p>Construct changed economic terms under the current owner model. Proposals do not reserve capital, change agreements or execute effects.</p>
    {!authorized ? <p>Sign in with current Work access to inspect arrangements.</p> : null}
    <button type="button" disabled={!authorized || busy} onClick={loadPolicies}>Load current arrangements</button>
    <form onSubmit={submit}>
      <label>Incumbent arrangement<select required value={policyId} onChange={event => { setPolicyId(event.target.value); setActionId(""); setExposureId(""); setInstrumentId(""); setTokens([]); setInquiryActionId("") }}><option value="">Choose a current arrangement</option>{available.map(item => <option key={item.ref.id} value={item.ref.id}>{item.ref.id.slice(-12)} · {item.mandate.horizon.periods} periods</option>)}</select></label>
      <label>Commitment<select required value={actionId} onChange={event => { setActionId(event.target.value); setExposureId(""); setInstrumentId(""); setTokens([]) }}><option value="">Choose a registered action</option>{actions.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label>
      <label>Economic parameter<select required value={exposureId} onChange={event => setExposureId(event.target.value)}><option value="">Choose an exposure</option>{Object.keys(selectedAction?.exposures ?? {}).map(id => <option key={id}>{id}</option>)}</select></label>
      <label>Exact owner unit<input required value={unit} maxLength={128} onChange={event => setUnit(event.target.value)} placeholder="Unit recorded by the response model" /></label>
      <label>Permitted new terms<input required value={terms} maxLength={800} onChange={event => setTerms(event.target.value)} placeholder="Comma-separated decimal values" /></label>
      <label>Permitted start periods<input required value={starts} maxLength={80} onChange={event => setStarts(event.target.value)} /></label>
      <label className="ct-capital-program__check"><input type="checkbox" checked={staged} onChange={event => setStaged(event.target.checked)} /> Include a two-period committed exposure</label>
      <label className="ct-capital-program__check"><input type="checkbox" checked={observable} onChange={event => setObservable(event.target.checked)} /> Include an observable second commitment</label>
      {staged || observable ? <label>First-period fraction<input required value={stageFraction} maxLength={48} onChange={event => setStageFraction(event.target.value)} /></label> : null}
      {observable ? <fieldset><legend>Received milestone required for release</legend>
        <label>Registered milestone<select required value={instrumentId} onChange={event => { setInstrumentId(event.target.value); setTokens([]) }}><option value="">Choose a current instrument</option>{observations.map(item => <option key={item.id}>{item.id}</option>)}</select></label>
        {observation ? <><p>{observation.variableId}, {observation.unit}. Available {observation.delayPeriods} period(s) after the first commitment. No future forecast may release it.</p>
          {observation.bins.map(bin => <label className="ct-capital-program__check" key={bin.category}><input type="checkbox" checked={tokens.includes(bin.category)} onChange={event => setTokens(previous => event.target.checked ? [...previous, bin.category] : previous.filter(item => item !== bin.category))} /> Release after received {bin.category}</label>)}</> : <p>No supported milestone selected. Missing instruments remain an owner blocker.</p>}
      </fieldset> : null}
      <label className="ct-capital-program__check"><input type="checkbox" checked={inquiry} onChange={event => setInquiry(event.target.checked)} /> Include an inquiry before commitment</label>
      {inquiry ? <label>Current inquiry<select required value={inquiryActionId} onChange={event => setInquiryActionId(event.target.value)}><option value="">Choose an owner inquiry</option>{inquiries.map(item => <option key={item.id} value={item.id}>{item.id}, delay {item.informationDelayPeriods} period(s), cost {item.cost} {item.costUnit}, {item.humanSeconds} human seconds</option>)}</select></label> : null}
      <label className="ct-capital-program__check"><input type="checkbox" checked={waitStop} onChange={event => setWaitStop(event.target.checked)} /> Include wait/stop alternatives</label>
      <label>Agreement requirement<select value={agreement} onChange={event => setAgreement(event.target.value)}><option value="COUNTERPARTY_REQUIRED">Counterparty acceptance required</option><option value="UNILATERAL_PROPOSAL">Unilateral proposal only</option></select></label>
      <label>Decision purpose<select value={purpose} onChange={event => setPurpose(event.target.value)}><option value="COMMERCIAL">Commercial</option><option value="ACQUISITION">Acquisition</option><option value="FINANCING">Financing</option></select></label>
      <label className="ct-capital-program__check"><input type="checkbox" checked={financial} onChange={event => setFinancial(event.target.checked)} /> Link native financial consequences</label>
      {financial ? <fieldset><legend>Exact existing native financial model</legend>
        <p>Opening inputs only, at period 0. Delayed facilities and financial tranches remain unsupported. The financial input must equal the incumbent registered exposure. Native returns do not replace owner utility.</p>
        <label>Investment case ID<input required maxLength={36} value={investmentCaseId} onChange={event => setInvestmentCaseId(event.target.value)} /></label>
        <label>Immutable model version ID<input required maxLength={36} value={modelVersionId} onChange={event => setModelVersionId(event.target.value)} /></label>
        <label>Native financial parameter<select value={financialKind} onChange={event => setFinancialKind(event.target.value)}><option value="entry.enterprise_value">Entry enterprise value</option><option value="entry.financing_fees">Entry financing fees</option><option value="debt_input.opening_principal">Facility opening principal</option><option value="debt_input.fixed_rate">Facility fixed annual rate</option></select></label>
        {financialKind.startsWith("debt_input.") ? <label>Exact facility ID<input required maxLength={64} value={facilityId} onChange={event => setFacilityId(event.target.value)} /></label> : null}
        {financialKind !== "debt_input.fixed_rate" ? <label>Recorded currency<input required maxLength={3} pattern="[A-Z]{3}" value={currency} onChange={event => setCurrency(event.target.value)} /></label> : null}
        <label>Recorded instrument<input required maxLength={128} value={instrument} onChange={event => setInstrument(event.target.value)} /></label>
        <label>Recorded calendar<select value={calendar} onChange={event => setCalendar(event.target.value)}><option value="OWNER_RECORDED">Owner recorded</option><option value="GREGORIAN">Gregorian</option></select></label>
        <p>Entity {root.entityType}: {root.entityId}. Exact original full horizon, scale 1, recorded sign and owner-subject consolidation. No currency or calendar conversion is inferred.</p>
        <details><summary>Link current P4 derived inputs</summary><p>Use only actual current TESTED derivations on this exact Work/input. Earlier Work outputs cannot be reused after acquisition.</p>
          {derivedInputs.map((item, index) => <fieldset key={item.key}><legend>Derived input {index + 1}</legend>
            <label>Native input node<input required maxLength={128} value={item.nodeId} onChange={event => updateDerivedInput(item.key, "nodeId", event.target.value)} /></label>
            <label>P4 derivation ID<input required maxLength={36} value={item.derivationId} onChange={event => updateDerivedInput(item.key, "derivationId", event.target.value)} /></label>
            <label>Derived output<input required maxLength={64} value={item.output} onChange={event => updateDerivedInput(item.key, "output", event.target.value)} /></label>
            <button type="button" onClick={() => setDerivedInputs(previous => previous.filter(value => value.key !== item.key))}>Remove derived input {index + 1}</button>
          </fieldset>)}
          <button type="button" disabled={derivedInputs.length >= 16} onClick={() => setDerivedInputs(previous => [...previous, { key: crypto.randomUUID(), nodeId: "", derivationId: "", output: "" }])}>Add derived input</button>
        </details>
      </fieldset> : null}
      <p>Periods use the original full horizon. Staging commits both exposures upfront; it is not a conditional payment. Terms must fit the supported owner domain.</p>
      <button type="submit" disabled={!authorized || !policy || !selectedAction || !exposureId || busy || pending(current)}>Construct alternatives</button>
    </form>
    <p role="status" aria-live="polite">{notice}</p>
    {error ? <p role="alert">{error}</p> : null}
    {current ? <div className="ct-capital-program__actions"><span>{label(current.status)} · {current.progress.attempted}/{current.progress.generated} attempted</span><button type="button" disabled={busy} onClick={() => { clear(); void refresh(current.queryId, ++generation.current) }}>Recheck current sources</button><button type="button" disabled={busy || !pending(current)} onClick={() => control("cancel")}>Cancel search</button><button type="button" disabled={busy} onClick={() => control("resume")}>Resume original grant</button><button type="button" disabled={busy} onClick={() => control("recompile")}>Recompile current Work</button></div> : null}
    {program ? <>
      <OriginalChallengePanel query={current!} onRepair={repairedChallenge} onUnavailable={unavailableChallenge} />
      <h4>Modeled arrangements, not agreed transactions</h4>
      <p>Worst retained joint-world value, with no scenario probabilities. Upper bound, identification and unsampled-model gaps remain unknown.</p>
      <p>{program.incumbentAndSearchGap.remainingDescriptors} unvisited arrangements. Measured search {Math.round(program.costs.wallMs)} ms; money unmetered. Failed and unknown attempts are retained.</p>
      <div className="ct-capital-program__candidates">{program.candidates.map(item => <article key={item.semanticDigest}>
        <h5>{label(item.structure)}{item.semanticDigest === program.incumbentAndSearchGap.selectedDigest ? " · modeled incumbent" : ""}</h5>
        <p>{item.terms.length ? item.terms.map(term => `${term.exposureId}: ${term.before} → ${term.after} ${term.unit}, period ${term.period}`).join("; ") : "Original owner policy or wait/stop course."}</p>
        <p>{label(item.disposition)}{item.valueBounds ? ` · modeled value [${item.valueBounds.join(", ")}] ${program.valueUnit}` : " · no qualified value"}</p>
        <p>Agreement: proposed, not received. {item.reason ? label(item.reason) : ""}</p>
        <ul>{item.blockers.map((item, index) => <li key={index}>{item.requirement}</li>)}</ul>
        {item.nativeFinance ? <details><summary>Native financial consequences, not agreed funding</summary><pre tabIndex={0}>{JSON.stringify(item.nativeFinance.result, null, 2)}</pre></details> : null}
        <div className="ct-capital-program__actions"><button type="button" disabled={busy} onClick={event => inspect(item.semanticDigest, event.currentTarget)}>Inspect arrangement</button>{item.moduleRef ? <button type="button" disabled={busy} onClick={() => download(item.moduleRef!.contentDigest)}>Download executable module</button> : null}
        <button type="button" disabled={busy || !item.policyRef || item.disposition !== "CHECKED_MODEL_RELATIVE"} onClick={() => reviewBranch(item.semanticDigest)}>Review current model branch</button>
        <button type="button" disabled={busy || !item.policyRef} onClick={() => {
          const id = current!.queryId
          void perform("Checking current owner selection requirements…", async () => { await jarvisPost("company-brain/capital-program-select", { queryId: id, candidateDigest: item.semanticDigest, idempotencyKey: crypto.randomUUID() }) })
        }}>Check owner selection</button></div>
      </article>)}</div>
      {current!.branchReviews.length ? <section aria-label="Native model branch reviews"><h4>Reviewed native model branches</h4><p>Reference-model choices only. No decision coverage, capital reservation, agreement or effect authority.</p><ul>{current!.branchReviews.map(item => <li key={item.ref.contentDigest}>Period {item.decision.period}: {item.choice.actionId}, reviewed {item.decision.knowledgeAt}.</li>)}</ul></section> : null}
      <details><summary>Unresolved decision premises and costs</summary><ul>{program.blockers.map((item, index) => <li key={index}>{item.owner}: {item.requirement}</li>)}</ul><p>{program.costs.refinementSteps} refinement steps, {program.costs.expansions} expansions; {program.costs.unknownAttemptIds.length} attempts with unknown physical cost.</p><ul>{program.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul></details>
      {program.envelope.recompilation ? <details><summary>Immutable revised Work dependencies</summary><ul>{program.envelope.recompilation.changedDependencies.map(item => <li key={item.key}>{item.key}: {item.previousDigest?.slice(0, 12) ?? "absent"} → {item.currentDigest?.slice(0, 12) ?? "absent"}</li>)}</ul></details> : null}
    </> : current?.status === "INVALIDATED" ? <p>Work, source, model, resources or access changed. Earlier values are historical. Recompile the current Work.</p> : null}
    {current?.attemptCosts.length ? <details><summary>Retained physical attempts</summary><ul>{current.attemptCosts.map(item => <li key={item.attemptId}>{label(item.state)}: {item.wallMs === null ? label(item.physicalCostStatus) : `${Math.round(item.wallMs)} ms supervisor interval`}. Money unmetered. Original deadline {item.deadlineAt}. Aggregate child usage remains unknown.</li>)}</ul></details> : null}
    {proof ? <section ref={inspection} tabIndex={-1} aria-label="Arrangement witnesses">
      <h4>Observable timeline and resource occupation</h4>
      {proof.policy ? <ol>{proof.policy.nodes.map(node => {
        const action = proof.policy!.problem.actions.find(item => item.id === node.actionId)
        return <li key={node.id}>Period {node.period}: {action?.kind.toLowerCase()} {action?.id}. Cost {action?.cost} {action?.costUnit}. Resources {JSON.stringify(action?.resources)}. Occupation {JSON.stringify(action?.occupancy)} for {action?.occupationPeriods} periods. Tail liability {action?.tailLiability}. Human attention {action?.humanSeconds} seconds. {node.observations.length} received observations.
          {action?.precondition ? <p>Requires prior commitments {action.precondition.afterActionIds.join(", ") || "none"}; received tokens {action.precondition.observations.map(item => `${item.instrumentId}: ${item.tokens.join(" or ")}`).join("; ") || "none"}. Never private or future state.</p> : null}
        </li>
      })}</ol> : <p>No owner-supported policy for this arrangement.</p>}
      <h5>Current decision witnesses</h5>
      <ul>{evidence.map(item => <li key={item.id}>{item.nativeId}<button type="button" aria-label={`Inspect source witness for ${item.nativeId}`} onClick={() => inspectSource(item.id)}>Inspect source witness</button></li>)}</ul>
      {source ? <div><h5>{source.variable.nativeId}</h5><pre tabIndex={0}>{JSON.stringify(source.native, null, 2)}</pre></div> : null}
      <details><summary>Exact owner checks and response assumptions</summary><pre tabIndex={0}>{JSON.stringify({ checks: proof.checks, model: proof.model }, null, 2)}</pre></details>
      <button type="button" onClick={() => { sourceGeneration.current++; setWitness(null); setSourceWitness(null); requestAnimationFrame(() => opener.current?.focus()) }}>Close arrangement witnesses</button>
    </section> : null}
  </section>
}

function DecisionWitnessVariables(value: object): Array<{ id: string; nativeId: string }> {
  const variables = "materialVariables" in value ? value.materialVariables : null
  return Array.isArray(variables) ? variables.filter((item): item is { id: string; nativeId: string } =>
    Boolean(item && typeof item === "object" && typeof item.id === "string" && typeof item.nativeId === "string")) : []
}
