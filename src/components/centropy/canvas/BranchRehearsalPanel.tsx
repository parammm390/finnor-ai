'use client'

import { useEffect, useRef, useState } from 'react'
import { getCurrentAccessToken, useCentropyAuth as useJarvisAuth } from '@/components/centropy/lib/centropy-auth'
import { centropyPost } from '@/components/centropy/lib/api'
type CheckpointControl = 'checkpoint-revoke' | 'checkpoint-purge'
type BranchAction = 'inspect' | 'checkpoint' | 'resume' | 'cancel' | 'continue' | CheckpointControl
type BranchOperation = BranchAction | 'list' | 'prepare' | 'submit' | 'compare'
type Branch = { branchId: string; status: string; currentness?: string; kind?: string; profile?: string; result?: { evidenceClass: string; result: Record<string, unknown>; check: { passed: boolean }; cost: { reconciliation: string } } | null; checkpointId?: string | null; checkpoint?: { checkpointId: string; status: 'RECORDED' | 'REVOKED' | 'EXPIRED' | 'ERASED' | 'UNAVAILABLE'; expiresAt: string | null } | null }
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
  const [recoveryRequired, setRecoveryRequired] = useState(false)
  const [confirmation, setConfirmation] = useState<{ operation: CheckpointControl; branchId: string; checkpointId: string | null } | null>(null)
  const mutation = useRef<number | null>(null)
  const generation = useRef(0)
  const activeWork = useRef(workId)
  const activeRoot = useRef(rootId)
  const identity = useRef<string | null>(null)
  const scopeCurrent = Boolean(session) && identity.current === getCurrentAccessToken() && activeWork.current === workId && activeRoot.current === rootId
  const currentBranches = scopeCurrent ? branches : []
  const request = <T = Record<string, unknown>,>(operation: BranchOperation, body: unknown) => centropyPost<T>(`branches/${operation}`, body)
  async function reload(manual = false) {
    const version = generation.current, work = workId, token = getCurrentAccessToken()
    if (identity.current !== token) { identity.current = token; setBranches([]); setSelected([]); setDetail(null); generation.current++; return }
    try {
      const result = await request<{ branches: Branch[] }>('list', { workId: work, limit: 20 })
      if (version === generation.current && activeWork.current === work) {
        setBranches(result.branches)
        setSelected(ids => ids.filter(id => result.branches.some(branch => branch.branchId === id)))
        if (manual) setRecoveryRequired(false)
        if (result.branches.some((b: Branch) => b.status === 'INVALIDATED')) { setDetail(null); setNotice('Work or owner inputs changed. Previous numbers are no longer eligible.') }
      }
    } catch (e) { if (version === generation.current) { setBranches([]); setSelected([]); setDetail(null); setNotice(e instanceof Error ? e.message : 'BRANCH_UNAVAILABLE') } }
  }
  useEffect(() => {
    activeWork.current = workId; activeRoot.current = rootId; generation.current++; mutation.current = null; setBranches([]); setSelected([]); setDetail(null); setPending(false); setConfirmation(null); setRecoveryRequired(false)
    identity.current = getCurrentAccessToken()
    setNotice(session ? 'Signed in. Registered development branches remain non-isolated and unadmitted.' : 'Sign in to rehearse registered native programmes.')
    if (loading || !session) return
    void reload()
    const timer = setInterval(() => { if (mutation.current === null) void reload() }, 750)
    return () => { clearInterval(timer); generation.current++ }
    // Work is an authoritative boundary, not a numerical cache key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workId, rootId, session?.user.id, session?.access_token, loading])
  async function submit() {
    if (mutation.current !== null || recoveryRequired || !scopeCurrent) return
    const version = ++generation.current, token = getCurrentAccessToken()
    mutation.current = version
    setPending(true); setDetail(null); setNotice('Preparing immutable inputs…')
    try {
      const source = kind === 'application_fixture'
        ? { kind: 'financing_fixture', steps: [{ operation: 'autosave', target: 'C_01', feeCents: 2000, memo: null, effectId: crypto.randomUUID() }, { operation: 'navigate', target: 'C_01', effectId: crypto.randomUUID() }, { operation: 'submit', target: 'C_01', effectId: crypto.randomUUID() }] }
        : { kind: 'public_fixture', fixture: 'allocation-abc-v1', parameters: { equity: 95, leverageTenths: leverage, reserve } }
      const prepared = await request('prepare', { workId, root: { entityType: 'external_organization', entityId: rootId }, kind, profile: 'TRUSTED_NATIVE_H0', source })
      if (version !== generation.current || activeWork.current !== workId || token !== getCurrentAccessToken()) return
      const acknowledged = await request('submit', { schema: 'finnor.branch-request.v1', workId, inputId: prepared.inputId, programme: prepared.programme, mode: 'COLD_BUILD', idempotencyKey: crypto.randomUUID() })
      if (version === generation.current) { setNotice(`Acknowledged ${acknowledged.status}. Non-isolated development, no protected eligibility.`); await reload() }
    } catch (e) { if (version === generation.current) { setBranches([]); setDetail(null); setRecoveryRequired(true); setNotice(`${e instanceof Error ? e.message : 'BRANCH_UNAVAILABLE'}. Reload current branches before another request; preparation or submission may already be recorded.`) } }
    finally { if (mutation.current === version) mutation.current = null; if (version === generation.current) setPending(false) }
  }
  async function action(operation: BranchAction, branch: Branch) {
    if (mutation.current !== null || recoveryRequired || !scopeCurrent) return
    const version = ++generation.current
    mutation.current = version; setPending(true); setDetail(null); setConfirmation(null)
    try {
      const body = operation === 'resume' ? { branchId: branch.branchId, checkpointId: branch.checkpointId, idempotencyKey: crypto.randomUUID() }
        : operation === 'checkpoint-revoke' ? { branchId: branch.branchId, checkpointId: branch.checkpointId } : { branchId: branch.branchId }
      const result = await request(operation, body)
      if (operation === 'checkpoint-revoke' && (result.status !== 'REVOKED' || result.checkpointId !== branch.checkpointId || result.immutableHistoryRetained !== true)) throw Error('Checkpoint revocation was not confirmed')
      if (operation === 'checkpoint-purge' && (!Number.isInteger(result.purgedPayloads) || Number(result.purgedPayloads) < 0 || Number(result.purgedPayloads) > 128 || result.immutableHistoryRetained !== true || result.canonicalS6HistoryTouched !== false)) throw Error('Checkpoint erasure was not confirmed')
      if (version === generation.current) { setDetail(result); setNotice(operation === 'cancel' ? `${result.status}, stopped: ${String(result.observedStopped)}`
        : operation === 'checkpoint-revoke' ? 'Checkpoint revoked. Its encrypted copy and immutable history remain recorded.'
          : operation === 'checkpoint-purge' ? `${result.purgedPayloads} eligible checkpoint payloads erased for this Work. Current checkpoints, retention holds and immutable history remain protected.`
            : `${operation} returned qualified evidence.`); await reload() }
    } catch (e) { if (version === generation.current) { setBranches([]); setDetail(null); setRecoveryRequired(true); setNotice(`${e instanceof Error ? e.message : 'BRANCH_UNAVAILABLE'}. Reload canonical state before another control; its outcome may already be recorded.`) } }
    finally { if (mutation.current === version) mutation.current = null; if (version === generation.current) setPending(false) }
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
      <button disabled={pending || recoveryRequired || loading || !scopeCurrent || !workId || !rootId} onClick={() => void submit()} className="rounded border px-3 py-2">Prepare and submit</button>
      <button disabled={pending} onClick={() => void reload(true)} className="rounded border px-3 py-2">Reload</button>
    </div>
    <p role="status" aria-live="polite">{scopeCurrent ? notice : 'Checking the current signed-in Work scope…'}</p>
    <ul className="space-y-4">{currentBranches.map(branch => <li key={branch.branchId} className="rounded border border-white/15 p-4">
      <label><input type="checkbox" disabled={!selected.includes(branch.branchId) && selected.length >= 8} checked={selected.includes(branch.branchId)} onChange={e => setSelected(ids => e.target.checked ? [...ids, branch.branchId] : ids.filter(id => id !== branch.branchId))} /> Compare {branch.branchId}</label>
      <p>{branch.status} · {branch.currentness ?? 'currentness unresolved'} · {branch.kind} · {branch.profile}</p>
      {branch.checkpoint ? <p>Saved checkpoint {branch.checkpoint.checkpointId}: {branch.checkpoint.status.toLowerCase()}{branch.checkpoint.expiresAt ? ` · expires ${branch.checkpoint.expiresAt}` : ''}. Restore requires current owner checks and the original episode.</p> : null}
      {branch.result && branch.status === 'COMPLETE' && <div>
        <p>{branch.result.evidenceClass} · independent checks {branch.result.check.passed ? 'passed in registered domain' : 'unresolved'} · costs {branch.result.cost.reconciliation}</p>
        <pre className="overflow-auto whitespace-pre-wrap" data-testid="branch-result">{JSON.stringify(branch.result.result, null, 2)}</pre>
      </div>}
      <fieldset disabled={pending || recoveryRequired || !scopeCurrent} aria-label="Branch controls" className="flex flex-wrap gap-2">
        <button onClick={() => void action('inspect', branch)} className="rounded border px-3 py-1">Inspect checks and attempts</button>
        <button disabled={branch.status !== 'COMPLETE'} onClick={() => void action('checkpoint', branch)} className="rounded border px-3 py-1">Checkpoint</button>
        <button disabled={!branch.checkpointId || branch.checkpoint?.status !== 'RECORDED'} onClick={() => void action('resume', branch)} className="rounded border px-3 py-1">Resume in fresh branch</button>
        <button disabled={!branch.checkpointId || !['RECORDED', 'EXPIRED'].includes(branch.checkpoint?.status ?? '')} onClick={() => setConfirmation({ operation: 'checkpoint-revoke', branchId: branch.branchId, checkpointId: branch.checkpointId ?? null })} className="rounded border px-3 py-1">Revoke saved checkpoint</button>
        <button disabled={['COMPLETE', 'CANCELLED', 'FAILED', 'INVALIDATED', 'QUARANTINED'].includes(branch.status)} onClick={() => void action('cancel', branch)} className="rounded border px-3 py-1">Request cancellation</button>
        <button onClick={() => void action('continue', branch)} className="rounded border px-3 py-1">Inspect continuation requirements</button>
      </fieldset>
    </li>)}</ul>
    <button disabled={pending || !scopeCurrent || selected.length < 2} onClick={() => { const version = generation.current; setDetail(null); void request('compare', { branchIds: selected }).then(result => { if (version === generation.current) setDetail(result) }).catch(() => { if (version === generation.current) { setDetail(null); setNotice('Comparison unavailable or mismatched domain.') } }) }} className="rounded border px-3 py-2">Compare matched branches (up to 8)</button>
    <button disabled={pending || recoveryRequired || !scopeCurrent || !currentBranches.length} onClick={() => setConfirmation({ operation: 'checkpoint-purge', branchId: currentBranches[0].branchId, checkpointId: null })} className="rounded border px-3 py-2">Erase eligible checkpoints for this Work</button>
    {scopeCurrent && confirmation ? <div role="group" aria-label="Confirm checkpoint change" className="space-y-3 rounded border p-3">
      <p>{confirmation.operation === 'checkpoint-revoke' ? `Revoke checkpoint ${confirmation.checkpointId}? It cannot be restored after revocation. Its encrypted copy and immutable history are retained.`
        : 'Permanently erase up to 128 expired or revoked encrypted checkpoint payloads across this Work. Active retention holds and current checkpoints are protected. Results, attempts, costs and canonical S6 history are retained.'}</p>
      <button disabled={pending} onClick={() => setConfirmation(null)}>Keep unchanged</button>
      <button disabled={pending || recoveryRequired} onClick={() => {
        const branch = branches.find(item => item.branchId === confirmation.branchId)
        if (branch && (confirmation.operation === 'checkpoint-purge' || branch.checkpointId === confirmation.checkpointId)) void action(confirmation.operation, branch)
        else { setConfirmation(null); setNotice('Checkpoint selection changed. Reload current branches before deciding.') }
      }}>{confirmation.operation === 'checkpoint-revoke' ? 'Confirm checkpoint revocation' : 'Confirm Work checkpoint erasure'}</button>
    </div> : null}
    {scopeCurrent && detail !== null && <pre aria-label="Branch inspection" className="max-h-96 overflow-auto whitespace-pre-wrap">{JSON.stringify(detail, null, 2)}</pre>}
    <p>S3 model-relative simulation and reviewed S6 live-read require authentic configured owner references through the API. Pending dependencies are not complete results.</p>
  </section>
}
