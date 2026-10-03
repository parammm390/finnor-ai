import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import type { AllocationCertificate, AllocationDualProposal, CanonicalAllocationProblem } from '@finnor/shared-types';
import { AllocationContractError } from './allocation-contracts';

type Pending = { id: number; operation: 'VERIFY' | 'CERTIFY'; timer: ReturnType<typeof setTimeout>; resolve: (result: unknown) => void; reject: (error: Error) => void };
type Slot = { worker: Worker; retiring: boolean; pending?: Pending };
const slots = new Set<Slot>();
const errorCodes = new Set<AllocationContractError['code']>(['INVALID_REQUEST', 'PERMITTED_CONTEXT_UNAVAILABLE', 'STALE_INPUT', 'LIMIT_EXCEEDED', 'IDEMPOTENCY_CONFLICT', 'BLOCKED_AUTHORITY', 'INVALID_CANDIDATE']);
let sequence = 0;
const unavailable = (reason: string) => new AllocationContractError('LIMIT_EXCEEDED', `Independent certificate verification unavailable:${reason}; accountability retained`);

function retire(slot: Slot, error: Error): void {
  slot.retiring = true;
  const pending = slot.pending;
  slot.pending = undefined;
  if (pending) { clearTimeout(pending.timer); pending.reject(error); }
  // Keep the slot charged until the worker actually exits. Rejection of a
  // request does not establish that its CPU or memory has been released.
  void slot.worker.terminate().catch(() => undefined);
}

function createSlot(): Slot {
  const source = import.meta.url.endsWith('.ts');
  const worker = new Worker(new URL('./allocation-verifier-worker.mjs', import.meta.url), {
    execArgv: [],
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'TMPDIR', 'NODE_ENV'].includes(key))),
    resourceLimits: { maxOldGenerationSizeMb: 256 },
    workerData: {
      checkerModule: new URL(source ? './allocation-checker.ts' : './allocation-checker.js', import.meta.url).href,
      tsxRuntime: source ? createRequire(import.meta.url).resolve('tsx/esm/api') : null,
    },
  });
  const slot: Slot = { worker, retiring: false };
  slots.add(slot);
  worker.on('message', (message: unknown) => {
    const pending = slot.pending;
    if (!pending || slot.retiring) return;
    if (!message || typeof message !== 'object') return retire(slot, unavailable('MALFORMED_WORKER_RESPONSE'));
    const reply = message as { id?: number; ok?: boolean; serialized?: string; error?: { name?: string; code?: AllocationContractError['code']; message?: string } };
    if (reply.id !== pending.id || typeof reply.ok !== 'boolean') return retire(slot, unavailable('UNBOUND_WORKER_RESPONSE'));
    if (!reply.ok && !(reply.error?.name === 'AllocationContractError' && reply.error.code && errorCodes.has(reply.error.code) && typeof reply.error.message === 'string')) return retire(slot, unavailable('WORKER_CHECK_FAILED'));
    let result: unknown;
    if (reply.ok && pending.operation === 'CERTIFY') {
      if (typeof reply.serialized !== 'string' || Buffer.byteLength(reply.serialized) > 8 * 1024 * 1024) return retire(slot, unavailable('UNBOUNDED_WORKER_RESULT'));
      try { result = JSON.parse(reply.serialized); } catch { return retire(slot, unavailable('MALFORMED_CERTIFICATION_RESULT')); }
    }
    clearTimeout(pending.timer);
    slot.pending = undefined;
    worker.unref();
    if (reply.ok) pending.resolve(result);
    else pending.reject(new AllocationContractError(reply.error!.code!, reply.error!.message!.slice(0, 4096)));
  });
  worker.on('error', () => retire(slot, unavailable('WORKER_ERROR')));
  worker.on('exit', () => {
    slot.retiring = true;
    slots.delete(slot);
    const pending = slot.pending;
    slot.pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.reject(unavailable('WORKER_EXIT')); }
  });
  worker.unref();
  return slot;
}

/** Only pure original-constraint proof checking runs here. Current resource,
 * rights, identity and S6 enforcement remain in their authenticated owners.
 * Two local CPU workers, bounded IPC and no queue preserve owner I/O liveness. */
async function runCheck(operation: 'VERIFY' | 'CERTIFY', request: unknown, deadlineMs: number): Promise<unknown> {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0 || deadlineMs > 30000) throw new AllocationContractError('INVALID_REQUEST', 'Independent verification deadline must be within 30 seconds');
  const started = performance.now(), deadlineAtEpoch = Date.now() + deadlineMs;
  const serialized = JSON.stringify(request);
  if (Buffer.byteLength(serialized) > 8 * 1024 * 1024) throw new AllocationContractError('LIMIT_EXCEEDED', 'Independent verification input exceeds 8 MiB');
  let slot = [...slots].find(candidate => !candidate.retiring && !candidate.pending);
  if (!slot && slots.size >= 2) throw unavailable('WORKER_CONCURRENCY_BUDGET');
  if (!slot) { try { slot = createSlot(); } catch { throw unavailable('WORKER_START_FAILED'); } }
  const remaining = deadlineMs - (performance.now() - started);
  if (remaining <= 0) throw unavailable('INPUT_CONSUMED_DEADLINE');
  const chosen = slot;
  return new Promise<unknown>((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => retire(chosen, unavailable('WORKER_WALL_DEADLINE')), remaining);
    chosen.pending = { id, operation, timer, resolve, reject };
    chosen.worker.ref();
    try { chosen.worker.postMessage({ id, operation, serialized, deadlineAtEpoch }); }
    catch { retire(chosen, unavailable('WORKER_IPC_FAILED')); }
  });
}

export async function verifyAllocationCertificateAsync(problem: CanonicalAllocationProblem, certificate: AllocationCertificate, deadlineMs = 30000): Promise<void> {
  await runCheck('VERIFY', { problem, certificate }, deadlineMs);
}

export async function certifyAllocationOptimizationAsync(problem: CanonicalAllocationProblem, selectedPolicyIds: string[], input: { deadlineAt: number; searchTermination: string; solverUpperBoundEstimate: number | null; dualProposal?: AllocationDualProposal | null }): Promise<Pick<AllocationCertificate, 'check' | 'optimization'>> {
  const { deadlineAt, ...options } = input, remaining = deadlineAt - performance.now();
  if (remaining <= 0) throw unavailable('OWNER_DECISION_DEADLINE');
  const result = await runCheck('CERTIFY', { problem, selectedPolicyIds, options }, Math.min(30000, remaining));
  return result as Pick<AllocationCertificate, 'check' | 'optimization'>;
}
