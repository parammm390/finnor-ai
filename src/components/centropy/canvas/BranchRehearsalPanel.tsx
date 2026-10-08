'use client'

import { useEffect, useRef, useState } from 'react'
import { getCurrentAccessToken, useCentropyAuth as useJarvisAuth } from '@/components/centropy/lib/centropy-auth'
type Branch = { branchId: string; status: string; currentness?: string; kind?: string; profile?: string; result?: { evidenceClass: string; result: Record<string, unknown>; check: { passed: boolean }; cost: { reconciliation: string } } | null; checkpointId?: string | null }
export function BranchRehearsalPanel({ workId, rootId }: { workId: string; rootId: string }) {
  const { session, loading } = useJarvisAuth()
  const [branches, setBranches] = useState<Branch[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [kind, setKind] = useState('pure')
  const [leverage, setLeverage] = useState(35)
  const [reserve, setReserve] = useState(0)
  const [notice, setNotice] = useState('Sign in to rehearse registered native programmes.')
  const [detail, setDetail] = useState<unknown>(null)
  const [pending, setPending] = useState(false)
  const generation = useRef(0)
  const activeWork = useRef(workId)
  const identity = useRef<string | null>(null)
  const request = async (operation: string, body: unknown) => {
    const token = getCurrentAccessToken()
    if (!token) throw Error('SIGN_IN_REQUIRED')
    const response = await fetch(`/api/branches/${operation}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' })
    const result = await response.json()
    if (!response.ok) throw Error(result.code ?? 'BRANCH_UNAVAILABLE')
    return result
  }
  async function reload() {
    const version = generation.current, work = workId, token = getCurrentAccessToken()
    if (identity.current !== token) { identity.current = token; setBranches([]); setSelected([]); setDetail(null); generation.current++; return }
    try {
      const result = await request('list', { workId: work, limit: 20 })
      if (version === generation.current && activeWork.current === work) {
        setBranches(result.branches)
        if (result.branches.some((b: Branch) => b.status === 'INVALIDATED')) { setDetail(null); setNotice('Work or owner inputs changed. Previous numbers are no longer eligible.') }
      }
    } catch (e) { if (version === generation.current) { setBranches([]); setSelected([]); setDetail(null); setNotice(e instanceof Error ? e.message : 'BRANCH_UNAVAILABLE') } }
  }
  useEffect(() => {
    activeWork.current = workId; generation.current++; setBranches([]); setSelected([]); setDetail(null); setPending(false)
    identity.current = getCurrentAccessToken()
    setNotice(session ? 'Signed in. Registered development branches remain non-isolated and unadmitted.' : 'Sign in to rehearse registered native programmes.')
    if (loading || !session) return
    void reload()
    const timer = setInterval(() => void reload(), 750)
    return () => { clearInterval(timer); generation.current++ }
    // Work is an authoritative boundary, not a numerical cache key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workId, rootId, session?.user.id, session?.access_token, loading])
  async function submit() {
    const version = generation.current
    setPending(true); setDetail(null); setNotice('Preparing immutable inputs…')
    try {
      const source = kind === 'application_fixture'
        ? { kind: 'financing_fixture', steps: [{ operation: 'autosave', target: 'C_01', feeCents: 2000, memo: null, effectId: crypto.randomUUID() }, { operation: 'navigate', target: 'C_01', effectId: crypto.randomUUID() }, { operation: 'submit', target: 'C_01', effectId: crypto.randomUUID() }] }
        : { kind: 'public_fixture', fixture: 'allocation-abc-v1', parameters: { equity: 95, leverageTenths: leverage, reserve } }
      const prepared = await request('prepare', { workId, root: { entityType: 'external_organization', entityId: rootId }, kind, profile: 'TRUSTED_NATIVE_H0', source })
      const acknowledged = await request('submit', { schema: 'finnor.branch-request.v1', workId, inputId: prepared.inputId, programme: prepared.programme, mode: 'COLD_BUILD', idempotencyKey: crypto.randomUUID() })
      if (version === generation.current) { setNotice(`Acknowledged ${acknowledged.status}. Non-isolated development, no protected eligibility.`); await reload() }
    } catch (e) { if (version === generation.current) { setBranches([]); setDetail(null); setNotice(e instanceof Error ? e.message : 'BRANCH_UNAVAILABLE') } }
    finally { if (version === generation.current) setPending(false) }
  }
  async function action(operation: string, branch: Branch) {
    const version = generation.current
    setDetail(null)
    try {
      const body = operation === 'resume' ? { branchId: branch.branchId, checkpointId: branch.checkpointId, idempotencyKey: crypto.randomUUID() } : { branchId: branch.branchId }
      const result = await request(operation, body)
      if (version === generation.current) { setDetail(result); setNotice(operation === 'cancel' ? `${result.status}, stopped: ${String(result.observedStopped)}` : `${operation} returned qualified evidence.`); await reload() }
    } catch (e) { if (version === generation.current) { setBranches([]); setDetail(null); setNotice(e instanceof Error ? e.message : 'BRANCH_UNAVAILABLE') } }
  }
  return <section aria-labelledby="branch-heading" className="mx-auto max-w-5xl space-y-5 rounded-xl border border-white/15 p-6 text-sm">
    <h1 id="branch-heading" className="text-xl font-medium">Branch rehearsal</h1>
    <p>Registered native computation and private fixtures. No synthesis, lender acceptance, funding, settlement or S8 admission.</p>
    <p className="font-mono text-xs">Work {workId}</p>
    <div className="flex flex-wrap gap-3">
      <label>Kind <select aria-label="Branch kind" value={kind} onChange={e => setKind(e.target.value)} className="bg-neutral-900 p-2">
        <option value="pure">Pure computation</option><option value="application_fixture">Application fixture</option>
      </select></label>
      <label>Leverage <select aria-label="Leverage" value={leverage} onChange={e => setLeverage(Number(e.target.value))} className="bg-neutral-900 p-2"><option value={35}>3.5</option><option value={30}>3.0</option></select></label>
      <label>Reserved equity <select aria-label="Reserved equity" value={reserve} onChange={e => setReserve(Number(e.target.value))} className="bg-neutral-900 p-2"><option value={0}>0</option><option value={25}>25</option></select></label>
      <button disabled={pending || loading || !session || !workId || !rootId} onClick={() => void submit()} className="rounded border px-3 py-2">Prepare and submit</button>
      <button onClick={() => void reload()} className="rounded border px-3 py-2">Reload</button>
    </div>
    <p role="status" aria-live="polite">{notice}</p>
    <ul className="space-y-4">{branches.map(branch => <li key={branch.branchId} className="rounded border border-white/15 p-4">
      <label><input type="checkbox" checked={selected.includes(branch.branchId)} onChange={e => setSelected(ids => e.target.checked ? [...ids, branch.branchId] : ids.filter(id => id !== branch.branchId))} /> Compare {branch.branchId}</label>
      <p>{branch.status} · {branch.currentness ?? 'currentness unresolved'} · {branch.kind} · {branch.profile}</p>
      {branch.result && branch.status === 'COMPLETE' && <div>
        <p>{branch.result.evidenceClass} · independent checks {branch.result.check.passed ? 'passed in registered domain' : 'unresolved'} · costs {branch.result.cost.reconciliation}</p>
        <pre className="overflow-auto whitespace-pre-wrap" data-testid="branch-result">{JSON.stringify(branch.result.result, null, 2)}</pre>
      </div>}
      <div className="flex flex-wrap gap-2">
        <button onClick={() => void action('inspect', branch)} className="rounded border px-3 py-1">Inspect checks and attempts</button>
        <button disabled={branch.status !== 'COMPLETE'} onClick={() => void action('checkpoint', branch)} className="rounded border px-3 py-1">Checkpoint</button>
        <button disabled={!branch.checkpointId} onClick={() => void action('resume', branch)} className="rounded border px-3 py-1">Resume in fresh branch</button>
        <button disabled={['COMPLETE', 'CANCELLED', 'FAILED', 'INVALIDATED', 'QUARANTINED'].includes(branch.status)} onClick={() => void action('cancel', branch)} className="rounded border px-3 py-1">Request cancellation</button>
        <button onClick={() => void action('continue', branch)} className="rounded border px-3 py-1">Inspect continuation requirements</button>
      </div>
    </li>)}</ul>
    <button disabled={selected.length < 2} onClick={() => { const version = generation.current; setDetail(null); void request('compare', { branchIds: selected }).then(result => { if (version === generation.current) setDetail(result) }).catch(() => { if (version === generation.current) { setDetail(null); setNotice('Comparison unavailable or mismatched domain.') } }) }} className="rounded border px-3 py-2">Compare matched branches</button>
    {detail !== null && <pre aria-label="Branch inspection" className="max-h-96 overflow-auto whitespace-pre-wrap">{JSON.stringify(detail, null, 2)}</pre>}
    <p>S3 model-relative simulation and reviewed S6 live-read require authentic configured owner references through the API. Pending dependencies are not complete results.</p>
  </section>
}
