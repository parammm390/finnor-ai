"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { centropyPost as jarvisPost } from "@/components/centropy/lib/api"
import { useCentropyAuth as useJarvisAuth } from "@/components/centropy/lib/centropy-auth"
import { onBusinessInvalidation } from "@/components/centropy/lib/business-invalidation"
import { CapitalAcceptedViewSchema, type CapitalQueryView } from "./capital-program-view"
import { OriginalChallengeAcceptedSchema, OriginalChallengeViewSchema, type OriginalChallengeView } from "./original-challenge-view"

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const limits = { deadlineMs: 30000, maxTargets: 64, maxCells: 128, maxTrials: 512, maxReductions: 64, maxWitnesses: 32, maxBytes: 4194304 }
const show = (value: unknown) => JSON.stringify(value, null, 2)

/** Original M3 publication only. All reads and writes re-enter the actual owner. */
export function OriginalChallengePanel({ query, onRepair, onUnavailable }: {
  query: CapitalQueryView; onRepair: (id: string) => void; onUnavailable: () => void
}) {
  const auth = useJarvisAuth(), search = useSearchParams(), router = useRouter(), pathname = usePathname()
  const program = query.program!
  const sessionScope = useRef({ token: auth.session?.access_token, version: 0 })
  if (sessionScope.current.token !== auth.session?.access_token)
    sessionScope.current = { token: auth.session?.access_token, version: sessionScope.current.version + 1 }
  const scope = `${auth.session?.user.id}:${sessionScope.current.version}:${query.workId}:${query.queryId}:${program.ref.contentDigest}`
  const liveScope = useRef(scope); liveScope.current = scope
  const epoch = useRef(0), writing = useRef(false)
  const searchId = search.get("capitalChallenge")
  const [loaded, setLoaded] = useState<{ scope: string; value: OriginalChallengeView } | null>(null)
  const [terms, setTerms] = useState(query.request.permitted.terms.join(","))
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const [spent, setSpent] = useState(false)
  const authorized = Boolean(auth.session && auth.role === "owner" && !auth.roleError && !auth.loading && !auth.roleLoading)
  const current = authorized && loaded?.scope === scope && loaded.value.searchId === searchId ? loaded.value : null
  const report = current?.report
  const challengeDeadline = current?.deadlineAt, retainedUntil = current?.retainedUntil
  const parentEvidence = query.request.challengeEvidence?.at(-1)
  const originalTerms = query.request.permitted.terms.join(",")

  const clear = useCallback(() => { epoch.current++; setLoaded(null); setTerms(""); setBusy(false); writing.current = false }, [])
  const read = useCallback(async (id: string, generation: number, history = false) => {
    const value = OriginalChallengeViewSchema.parse(await jarvisPost("company-brain/counterexample-read", {
      searchId: id, ...(history ? { readMode: "ISSUED_HISTORY" } : {}),
    }))
    if (generation !== epoch.current || liveScope.current !== scope || document.visibilityState !== "visible") return null
    if (value.searchId !== id || value.identity.workId !== query.workId ||
      value.identity.principalId !== auth.session?.user.id ||
      value.identity.workInputId !== program.envelope.work.inputId ||
      value.report && (value.report.candidate.contentDigest !== program.ref.contentDigest ||
        value.report.candidate.owner !== program.ref.owner || value.report.candidate.id !== program.ref.id ||
        value.report.candidate.version !== program.ref.version ||
        value.report.identity.contextDigest !== value.identity.contextDigest ||
        value.report.identity.principalId !== value.identity.principalId ||
        value.report.identity.workId !== value.identity.workId ||
        value.report.identity.workInputId !== value.identity.workInputId ||
        value.report.envelope.work.id !== query.workId ||
        value.report.envelope.work.inputId !== program.envelope.work.inputId ||
        value.report.envelope.id !== id || value.report.envelope.computeGrant.searchId !== id ||
        value.report.envelope.computeGrant.deadlineAt !== value.deadlineAt ||
        value.report.parentResultRef?.contentDigest !== parentEvidence?.resultRef.contentDigest))
      throw Error("Original challenge does not bind this exact current programme and authenticated Work.")
    return value
  }, [scope, query.workId, auth.session?.user.id, program.envelope.work.inputId, program.ref.contentDigest, program.ref.owner, program.ref.id, program.ref.version, parentEvidence?.resultRef.contentDigest])

  useEffect(() => {
    clear(); setTerms(originalTerms); setError(null); setSpent(false)
    return clear
  }, [scope, authorized, auth.session?.access_token, clear, originalTerms])

  useEffect(() => {
    if (!authorized || !searchId || !uuid.test(searchId)) return
    let cancelled = false, reading = false, timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      if (cancelled || reading || writing.current || document.visibilityState !== "visible") return
      reading = true; const generation = epoch.current
      let delay = 1000
      try {
        const value = await read(searchId, generation)
        if (value) {
          if (["STALE", "CANCELLED", "EXPIRED", "FAILED"].includes(value.status) || value.applicability.status !== "CURRENT") {
            clear(); setError("Current original challenge is unavailable. Values cleared.")
          } else { setLoaded({ scope, value }); if (value.status === "COMPLETED") delay = 5000 }
        }
      } catch {
        if (generation === epoch.current) { clear(); setError("Original challenge could not be verified. Values cleared."); onUnavailable() }
      } finally {
        reading = false
        if (!cancelled) timer = setTimeout(() => void refresh(), delay)
      }
    }
    const invalidate = () => { clear(); setError("Scope or current owner inputs changed. Challenge values cleared.") }
    const visible = () => { invalidate(); if (document.visibilityState === "visible") void refresh() }
    const unsubscribe = onBusinessInvalidation(signal => {
      if (/company-brain\/(?:capital-program-|counterexample-|challenge-submit)/.test(signal.path ?? "")) return
      if (signal.tags.some(tag => ["work", "company-brain", "authority", "source", "underwriting"].includes(tag))) { invalidate(); void refresh() }
    })
    void refresh()
    document.addEventListener("visibilitychange", visible); window.addEventListener("pagehide", invalidate)
    return () => {
      cancelled = true; clear(); clearTimeout(timer); unsubscribe()
      document.removeEventListener("visibilitychange", visible); window.removeEventListener("pagehide", invalidate)
    }
  }, [authorized, searchId, scope, read, clear, onUnavailable])

  useEffect(() => {
    const deadline = Math.min(Date.parse(query.deadlineAt ?? ""), challengeDeadline ? Date.parse(challengeDeadline) : Infinity)
    const retention = retainedUntil ? Date.parse(retainedUntil) : Infinity
    const timer = setTimeout(() => { setSpent(true) }, Math.max(0, deadline - Date.now()))
    const retentionTimer = Number.isFinite(retention) ? setTimeout(() => {
      clear(); setError("Original challenge retention expired. Values cleared.")
    }, Math.max(0, retention - Date.now())) : undefined
    return () => { clearTimeout(timer); clearTimeout(retentionTimer) }
  }, [query.deadlineAt, challengeDeadline, retainedUntil, clear])

  async function act(run: (generation: number) => Promise<void>) {
    if (!authorized || writing.current || document.visibilityState !== "visible") return
    const generation = ++epoch.current; writing.current = true; setBusy(true); setError(null)
    try { await run(generation) }
    catch (cause) {
      if (epoch.current === generation) {
        clear(); setError(cause instanceof Error ? cause.message : "Original challenge refused. Values cleared."); onUnavailable()
      }
    } finally { if (epoch.current === generation) { writing.current = false; setBusy(false) } }
  }
  function challenge() {
    void act(async generation => {
      const request = { schema: "finnor.m4.challenge-request.v1", workId: query.workId,
        candidate: program.ref, idempotencyKey: crypto.randomUUID(), limits }
      const accepted = OriginalChallengeAcceptedSchema.parse(await jarvisPost(
        parentEvidence ? "company-brain/counterexample-repair-request" : "company-brain/challenge-submit",
        parentEvidence ? { searchId: parentEvidence.searchId, replacement: request } : request))
      if (generation !== epoch.current || liveScope.current !== scope || document.visibilityState !== "visible") return
      setLoaded(null)
      const params = new URLSearchParams(search.toString()); params.set("capitalChallenge", accepted.searchId)
      router.replace(`${pathname}?${params}`, { scroll: false })
    })
  }
  function repair() {
    if (!current || !report || spent) return
    void act(async generation => {
      const issued = await read(current.searchId, generation, true)
      if (!issued?.report || issued.report.ref.contentDigest !== report.ref.contentDigest)
        throw Error("Exact issued original challenge is unavailable.")
      const newTerms = terms.split(",").map(value => value.trim())
      if (!newTerms.length || newTerms.length > 16 || newTerms.some(value => !/^-?(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value)) ||
        newTerms.join(",") === query.request.permitted.terms.join(","))
        throw Error("Supply one to sixteen genuinely changed exact decimal terms.")
      const idempotencyKey = crypto.randomUUID()
      const prior = query.request.challengeEvidence ?? []
      const evidence = [...prior.filter(value => value.searchId !== current.searchId),
        { searchId: current.searchId, resultRef: issued.report.ref }]
      if (evidence.length > 8) throw Error("Original repair ancestry exceeds eight issued challenge handles.")
      const replacement = { ...query.request, idempotencyKey,
        permitted: { ...query.request.permitted, terms: newTerms }, challengeEvidence: evidence }
      const accepted = CapitalAcceptedViewSchema.parse(await jarvisPost("company-brain/capital-program-recompile", {
        queryId: query.queryId, idempotencyKey, replacement,
      }))
      if (generation !== epoch.current || liveScope.current !== scope || document.visibilityState !== "visible") return
      if (accepted.workId !== query.workId) throw Error("Repaired programme belongs to another Work.")
      onRepair(accepted.queryId)
    })
  }

  return <section aria-label="Original programme challenge" aria-busy={busy}>
    <h4>Original programme challenge</h4>
    <p>Freeze the exact current M3 programme and its owner claims. Diagnostics cannot replace an original ChallengeResult.</p>
    <button type="button" disabled={busy || !authorized || Boolean(parentEvidence && spent) || Boolean(current && ["QUEUED", "RUNNING"].includes(current.status))} onClick={challenge}>
      {parentEvidence ? "Rechallenge repaired programme" : "Challenge current programme"}
    </button>
    <label>Changed repair terms<input value={terms} maxLength={800} onChange={event => setTerms(event.target.value)} /></label>
    <button type="button" disabled={busy || spent || !report || current?.status !== "COMPLETED" ||
      current.applicability.status !== "CURRENT"} onClick={repair}>Construct challenged economic repair</button>
    {current && ["QUEUED", "RUNNING"].includes(current.status) ? <button type="button" disabled={busy} onClick={() => void act(async () => {
      await jarvisPost("company-brain/counterexample-cancel", { searchId: current.searchId })
      clear(); setError("Original challenge cancelled. Current values cleared; committed evidence remains with its owner.")
    })}>Cancel original challenge</button> : null}
    {error ? <p role="alert">{error}</p> : null}
    <p role="status" aria-live="polite">{current ? `${current.status} · ${current.applicability.status}` : "No current original challenge."}</p>
    {spent ? <p>The original construction or repair clock is spent. No new construction grant is issued.</p> : null}
    {current ? <p>Original search {current.searchId}. Deadline {current.deadlineAt}. Evidence retention {current.retainedUntil}.</p> : null}
    {report ? <>
      <h5>{report.result}</h5>
      <p>{report.result === "NO_WITNESS_WITHIN_BUDGET" ? "No witness in the checked region, not SAFE, admission or unrestricted coverage."
        : report.result === "BLOCKED" ? "Required checking remains unresolved, not clean." : "Original independent material failure retained."}</p>
      <p>Original candidate {report.candidate.id}. Result {report.ref.id}.</p>
      <p>Checked {report.coverage.checkedCells}/{report.coverage.totalDeclaredCells}; unresolved {report.coverage.unresolvedCells}; untested {report.coverage.untestedCells}.</p>
      <details><summary>Frozen original owner claims</summary><pre tabIndex={0}>{show(report.claimRecords)}</pre></details>
      {report.witnessRecords.map(witness => <article key={witness.ref.id}>
        <h5>{witness.class}</h5><p>{witness.validation.qualification}</p>
        <details><summary>Original independent witness and reduction</summary><pre tabIndex={0}>{show(witness)}</pre></details>
      </article>)}
      <details><summary>Original coverage gaps and repair dependencies</summary><pre tabIndex={0}>{show({ gaps: report.coverageGaps, repair: report.repairClosure })}</pre></details>
      {report.parentResultRef ? <p>Immutable earlier original result {report.parentResultRef.id}.</p> : null}
      <p>{report.ledger.trials} parent debits, {report.ledger.attempts} attempts. Dollars unmetered; aggregate physical limits and independent gates remain unqualified.</p>
    </> : null}
    {current?.partialEvidence ? <details><summary>Retained incomplete original checks, not a publication</summary><pre tabIndex={0}>{show(current.partialEvidence)}</pre></details> : null}
  </section>
}
