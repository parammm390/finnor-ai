"use client"

import { useEffect, useRef, useState } from "react"
import { z } from "zod"
import { centropyPost as jarvisPost, CentropyApiError as JarvisApiError } from "@/components/centropy/lib/api"
import { useCentropyAuth as useJarvisAuth } from "@/components/centropy/lib/centropy-auth"
import type { DecisionSliceRef } from "./decision-slice-view"
import "./counterexample.css"

const Ref = z.object({ owner: z.string(), id: z.string(), version: z.string(), contentDigest: z.string() })
const Report = z.object({
  schema: z.literal("finnor.m4.owner-artifact-diagnostic.v1"), ref: Ref, executionAuthorityGranted: z.literal(false),
  identity: z.object({ workId: z.string(), principalId: z.string(), contextDigest: z.string(), workInputId: z.string() }),
  result: z.enum(["FAILURE_WITNESS", "NO_WITNESS_WITHIN_BUDGET", "BLOCKED"]),
  target: z.object({ sliceRef: Ref, ownerRefs: z.array(Ref) }),
  claims: z.array(z.object({ ref: Ref, kind: z.string(), evaluation: z.record(z.unknown()), regionIds: z.array(z.string()), qualification: z.string() })),
  witnesses: z.array(z.object({
    ref: Ref, class: z.string(), claimRef: Ref, contextDigest: z.string(),
    validation: z.object({ status: z.literal("VALID"), material: z.literal(true), qualification: z.string(),
      native: z.object({ checker: z.string(), observed: z.unknown(), trace: z.unknown() }),
      independent: z.object({ checker: z.string(), observed: z.unknown(), trace: z.unknown() }),
      predicate: z.object({ expected: z.unknown(), relation: z.string(), location: z.string(), unit: z.string().nullable() }) }),
    original: z.record(z.unknown()), minimized: z.record(z.unknown()),
    minimization: z.object({ status: z.string(), trace: z.array(z.unknown()), globallySmallest: z.literal(false) }),
  })),
  unresolved: z.array(z.object({ ref: Ref, reason: z.string(), detail: z.string(), requiredOwner: z.string() })),
  searchedDomain: z.object({ definition: z.unknown(), globalAbsenceClaimsPermitted: z.literal(false) }),
  coverage: z.object({ checkedCells: z.number(), invalidCells: z.number(), unresolvedCells: z.number(), untestedCells: z.number(), totalDeclaredCells: z.number() }),
  ledger: z.object({ trials: z.number(), attempts: z.number(), wallMs: z.number(), usd: z.null(), unknownAttemptCosts: z.boolean() }),
  repairDependencies: z.object({ affectedUses: z.array(z.string()), request: z.string(), authorityGranted: z.literal(false) }),
  parentResultRef: Ref.nullable(), repairReplay: z.array(z.unknown()),
})
const View = z.object({
  searchId: z.string().uuid(), status: z.string(), report: Report.nullable(), executionAuthorityGranted: z.literal(false),
  identity: z.object({ principalId: z.string(), workId: z.string(), workInputId: z.string(), sliceRef: Ref,
    candidateIdentity: z.string(), contextDigest: z.string() }),
  applicability: z.object({ status: z.string(), reason: z.string() }), deadlineAt: z.string(), retainedUntil: z.string(),
  trials: z.number(), ledger: z.array(z.unknown()).optional(),
  deliveryHistory: z.array(z.unknown()).optional(),
  partialEvidence: z.object({
    schema: z.literal("finnor.m4.retained-partial-evidence.v1"), ref: Ref,
    candidateIdentity: z.string(), contextDigest: z.string(), result: z.enum(["FAILURE_WITNESS", "BLOCKED"]),
    acceptedChecks: z.array(z.object({ eventId: z.string(), retainedAt: z.string(),
      proposal: z.record(z.unknown()), validation: z.record(z.unknown()) })),
    incomplete: z.literal(true), published: z.literal(false), currentUsePermitted: z.literal(false),
    effectReexecution: z.literal(false), unresolved: z.array(z.unknown()),
  }).nullable().optional(),
})
type Loaded = { scope: string; value: z.infer<typeof View> }
const show = (value: unknown) => value === undefined ? "unavailable" : JSON.stringify(value, null, 2)
const limits = { deadlineMs: 30000, maxTargets: 64, maxCells: 128, maxTrials: 512, maxReductions: 64, maxWitnesses: 32, maxBytes: 4194304 }

/** Owner artifacts only. Presentation parsing cannot issue an M3 candidate or verification certificate. */
export function CounterexamplePanel({ workId, sliceRef, candidateId, writable }: {
  workId: string; sliceRef: DecisionSliceRef; candidateId: string | null; writable: boolean
}) {
  const auth = useJarvisAuth()
  const scope = `${auth.session?.user.id ?? "anonymous"}:${workId}:${sliceRef.contentDigest}:${candidateId}`
  const storageKey = `finnor-m4-search:${scope}`
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [evaluation, setEvaluation] = useState("")
  const [domain, setDomain] = useState('{"parameters":[],"maxCombination":2}')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<string[]>([])
  const epoch = useRef(0), writing = useRef(false)
  const authorized = Boolean(auth.session && auth.role === "owner" && !auth.roleError)
  const current = authorized && loaded?.scope === scope ? loaded.value : null
  function invalidateRequests() { epoch.current++ }
  function discardPrivateView() {
    // Invalidate every outstanding response, not only the one denied read.
    epoch.current++; writing.current = false
    setLoaded(null); setHistory([]); setEvaluation(""); setDomain('{"parameters":[],"maxCombination":2}')
    setBusy(false); sessionStorage.removeItem(storageKey)
    setError("Challenge unavailable. No cached source, witness, draft or trial content is shown.")
  }
  async function read(id: string, ledger = false) {
    const generation = epoch.current
    try {
      const parsed = View.parse(await jarvisPost(`company-brain/counterexample-${ledger ? "ledger" : "view"}`, { searchId: id }))
      if (parsed.searchId !== id || parsed.identity.workId !== workId ||
        parsed.identity.principalId !== auth.session?.user.id || parsed.identity.sliceRef.contentDigest !== sliceRef.contentDigest ||
        parsed.partialEvidence && (parsed.partialEvidence.candidateIdentity !== parsed.identity.candidateIdentity ||
          parsed.partialEvidence.contextDigest !== parsed.identity.contextDigest) ||
        parsed.report && (parsed.report.identity.workId !== workId ||
          parsed.report.identity.principalId !== auth.session?.user.id ||
          parsed.report.identity.workInputId !== parsed.identity.workInputId ||
          parsed.report.identity.contextDigest !== parsed.identity.contextDigest ||
          parsed.report.target.sliceRef.contentDigest !== sliceRef.contentDigest))
        throw new Error("The challenge does not match this authenticated Work and owner slice.")
      return parsed
    } catch (cause) {
      if (epoch.current === generation) discardPrivateView()
      throw cause
    }
  }
  useEffect(() => {
    const generation = ++epoch.current
    setLoaded(null); setError(null); setBusy(false); setHistory([]); writing.current = false
    if (!authorized) { setEvaluation(""); return invalidateRequests }
    setEvaluation(show([{ kind: "MECHANICAL_BOUND", candidateId, nodeId: "score", relation: "LTE", value: "1", unit: "ratio", claimKind: "UNIVERSAL_DETERMINISTIC" }]))
    setDomain('{"parameters":[],"maxCombination":2}')
    const id = sessionStorage.getItem(storageKey)
    if (id) void read(id).then(value => { if (epoch.current === generation) setLoaded({ scope, value }) })
      .catch(() => { if (epoch.current === generation) { sessionStorage.removeItem(storageKey); setError("Challenge unavailable. No cached source or witness is shown.") } })
    return invalidateRequests
    // Only opaque IDs persist. Every scope transition reacquires authenticated owner evidence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, auth.session?.access_token, authorized])
  useEffect(() => {
    if (!current || !["QUEUED", "RUNNING"].includes(current.status)) return
    const generation = epoch.current, id = current.searchId
    const timer = setTimeout(() => {
      void read(id).then(value => { if (epoch.current === generation) setLoaded({ scope, value }) })
        .catch(() => { if (epoch.current === generation) { setLoaded(null); setError("Current evidence unavailable. Retry the authenticated read.") } })
    }, 1000)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, scope])
  async function act(action: () => Promise<void>) {
    if (writing.current) return
    const generation = epoch.current
    writing.current = true; setBusy(true); setError(null)
    try { await action() }
    catch (cause) {
      if (epoch.current === generation) {
        if (cause instanceof JarvisApiError && [401, 403, 404].includes(cause.status)) discardPrivateView()
        else setError(cause instanceof Error ? cause.message : "Bounded challenge refused.")
      }
    }
    finally { if (epoch.current === generation) { writing.current = false; setBusy(false) } }
  }
  function request() {
    if (evaluation.length + domain.length > 64000) throw new Error("The diagnostic form exceeds 64 KiB.")
    return { schema: "finnor.m4.diagnostic-request.v1", workId, sliceRef, idempotencyKey: crypto.randomUUID(),
      evaluations: JSON.parse(evaluation), domain: JSON.parse(domain), limits }
  }
  async function submit(repair = false) {
    const generation = epoch.current, previous = current?.searchId
    await act(async () => {
      const body = request()
      const response = z.object({ searchId: z.string().uuid() }).parse(await jarvisPost(
        `company-brain/counterexample-${repair ? "repair-request" : "diagnostic-submit"}`,
        repair ? { searchId: previous, replacement: body } : body))
      const value = await read(response.searchId)
      if (epoch.current !== generation) return
      if (previous) setHistory(ids => [...new Set([...ids, previous])])
      setLoaded({ scope, value }); sessionStorage.setItem(storageKey, response.searchId)
    })
  }
  const report = current?.report
  return <section className="ct-counterexample" aria-label="Bounded counterexample search" aria-busy={busy}>
    <header><h4>Bounded counterexample search</h4><p>Current owner-artifact diagnostic. Challenge a current M3 programme from Economic arrangements; this diagnostic is not an original ChallengeResult.</p></header>
    <p>Supplied deterministic predicates and finite model bounds only. This is not agreement, probability, field causality, funding, or execution authority.</p>
    <details><summary>Configure exact diagnostic predicates and permitted compounds</summary>
      <label>Evaluations (strict JSON)<textarea rows={7} maxLength={48000} value={evaluation} onChange={e => setEvaluation(e.target.value)} /></label>
      <label>Parameter domain (strict JSON)<textarea rows={4} maxLength={16000} value={domain} onChange={e => setDomain(e.target.value)} /></label>
      <p>Every axis names an exact candidate input and decimal values. Source, policy and effect checks use their original owner domain. No arbitrary code or live effects run.</p>
    </details>
    <div className="ct-counterexample__actions">
      <button type="button" disabled={busy || !writable || !authorized} onClick={() => void submit()}>Submit bounded diagnostic</button>
      {current ? <button type="button" disabled={busy} onClick={() => {
        const generation = epoch.current
        void act(async () => { const value = await read(current.searchId, true); if (epoch.current === generation) setLoaded({ scope, value }) })
      }}>Reload currentness and trial ledger</button> : null}
      {current && ["QUEUED", "RUNNING"].includes(current.status) ? <button type="button" disabled={busy || !writable} onClick={() => {
        const generation = epoch.current
        void act(async () => { await jarvisPost("company-brain/counterexample-cancel", { searchId: current.searchId }); const value = await read(current.searchId); if (epoch.current === generation) setLoaded({ scope, value }) })
      }}>Cancel search, retain evidence</button> : null}
      {current?.status === "COMPLETED" ? <button type="button" disabled={busy || !writable || current.applicability.status !== "CURRENT" || Date.now() >= Date.parse(current.deadlineAt)}
        onClick={() => void submit(true)}>Request linked diagnostic repair</button> : null}
    </div>
    {error ? <p role="alert">{error}</p> : null}
    <p role="status" aria-live="polite">{current ? `${current.status} · ${current.applicability.status}` : busy ? "Resolving exact current owner inputs…" : "No search has been issued."}</p>
    {current ? <p>Search {current.searchId} · deadline {current.deadlineAt} · encrypted evidence retention {current.retainedUntil}. One parent episode includes queue waiting, retries, reduction and repair.</p> : null}
    {report ? <>
      <h5>{report.result}</h5>
      <p>{report.result === "NO_WITNESS_WITHIN_BUDGET" ? "No observed witness in this checked region, not a safety certificate." : report.result === "BLOCKED" ? "Required checking or coverage is unavailable, not clean." : "An independently checked material failure is retained."}</p>
      <p>Owner slice {report.target.sliceRef.id} · version {report.target.sliceRef.version} · Work input {report.identity.workInputId}</p>
      <ul>{report.claims.map(c => <li key={c.ref.id}><strong>{c.kind}</strong><pre>{show(c.evaluation)}</pre><small>{c.qualification}</small><p>Affected regions: {c.regionIds.join(", ") || "No supported region binding"}</p></li>)}</ul>
      <p>Checked {report.coverage.checkedCells}/{report.coverage.totalDeclaredCells} cells · predicate-holding hypotheses {report.coverage.invalidCells} · unresolved {report.coverage.unresolvedCells} · untested {report.coverage.untestedCells}</p>
      <details><summary>Exact searched domain</summary><pre>{show(report.searchedDomain.definition)}</pre></details>
      {report.witnesses.map(w => <article key={w.ref.id} data-witness-id={w.ref.id}>
        <h5>{w.class}</h5><p>Claim {w.claimRef.id} · {w.validation.status} · {w.validation.qualification}</p>
        <p>Exact predicate: {w.validation.predicate.location} {w.validation.predicate.relation} {show(w.validation.predicate.expected)} {w.validation.predicate.unit}</p>
        <dl><dt>Native observation</dt><dd><pre>{show(w.validation.native.observed)}</pre></dd><dt>Independent observation</dt><dd><pre>{show(w.validation.independent.observed)}</pre></dd></dl>
        <p>{w.validation.independent.checker} · reduction {w.minimization.status}, not globally smallest.</p>
        <details><summary>Original input, reduced witness and independent trace</summary><pre>{show({ original: w.original, minimized: w.minimized, reduction: w.minimization, native: w.validation.native, independent: w.validation.independent })}</pre></details>
        <button type="button" disabled={busy || current?.applicability.status !== "CURRENT"} onClick={() => void act(async () => {
          await jarvisPost("company-brain/counterexample-witness-replay", { searchId: current!.searchId, witnessRef: w.ref })
        })}>Recheck witness (effects are read-only)</button>
      </article>)}
      <h5>Unresolved coverage</h5><ul>{report.unresolved.map(g => <li key={g.ref.id}><strong>{g.reason}</strong> · {g.requiredOwner}<p>{g.detail}</p></li>)}</ul>
      <details><summary>Affected owner repair or S4 fallback request</summary><pre>{show(report.repairDependencies)}</pre><p>M4 does not modify owner policy, reserve capital or dispatch a correction.</p></details>
      <p>{report.ledger.trials} parent debits · {report.ledger.attempts} attempts · {Math.round(report.ledger.wallMs)} ms including queue wait. Dollars unmetered; aggregate physical enforcement unqualified.</p>
      {report.ledger.unknownAttemptCosts ? <p>Earlier failed attempt costs are unresolved, not free.</p> : null}
      {report.parentResultRef ? <details><summary>Earlier failure retained, explicit repair scope changes</summary><p>{report.parentResultRef.id}</p><pre>{show(report.repairReplay)}</pre></details> : null}
    </> : null}
    {current?.partialEvidence ? <section aria-label="Retained partial challenge evidence">
      <h5>Retained partial {current.partialEvidence.result}</h5>
      <p>No final report was published. Committed original checks remain visible, but coverage, reduction and costs are incomplete. Current dependent use is refused.</p>
      <p>Candidate identity {current.partialEvidence.candidateIdentity} · context {current.partialEvidence.contextDigest}</p>
      <details><summary>Committed original inputs and independent checks</summary><pre>{show(current.partialEvidence.acceptedChecks)}</pre></details>
      <details><summary>Incomplete coverage and publication limits</summary><pre>{show(current.partialEvidence.unresolved)}</pre></details>
      <p>Read-only reconstruction. No effect is re-executed and no business responsibility is released.</p>
    </section> : null}
    {current?.ledger ? <details><summary>Complete persisted trial events</summary><pre>{show(current.ledger)}</pre></details> : null}
    {current?.deliveryHistory ? <details><summary>Physical queue deliveries and unmetered overhead</summary><pre>{show(current.deliveryHistory)}</pre></details> : null}
    {history.length ? <details><summary>Earlier searches</summary>{history.map(id => <button type="button" key={id} disabled={busy} onClick={() => {
      const generation = epoch.current
      void act(async () => { const value = await read(id); if (epoch.current === generation) setLoaded({ scope, value }) })
    }}>{id}</button>)}</details> : null}
  </section>
}
