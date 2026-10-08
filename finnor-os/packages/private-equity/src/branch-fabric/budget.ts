import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseExecutionDeadlineError, withDatabaseExecutionDeadline } from '@finnor/db';
import { BranchFault, fault, LIMITS } from './contracts';

interface Episode { deadline: number; controller: AbortController; finalizers: Array<() => Promise<unknown>>; cleanup: boolean }
const episodes = new AsyncLocalStorage<Episode>();
const deadlineAbort = Symbol('branch-deadline');
const cleanupCodes = new Set(['EACCES','EPERM','ENOTEMPTY','ENOENT','ENOTDIR','EIO','EBUSY','EMFILE','ENFILE',
  'ENOSPC','ETIMEDOUT','ECHILD','ESRCH','EPIPE','ECONNRESET','ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
  '57014','55P03','40001','40P01','57P01','BRANCH_CLEANUP_REQUIRED','BRANCH_FENCE_LOST',
  'NATIVE_RESOURCE_ROOT_REQUIRED','NATIVE_RESOURCE_ROOT_UNSAFE','RESOURCE_OWNERSHIP_UNCONFIRMED',
  'RESOURCE_PATH_IDENTITY_UNCONFIRMED','RESOURCE_PROCESS_IDENTITY_UNCONFIRMED','RESOURCE_RECONCILIATION_BOUND']);
/** Diagnostics retain only known causes, never arbitrary error text or host commands. */
export function branchCleanupCause(error: unknown): string {
  if (error instanceof DatabaseExecutionDeadlineError) return 'DATABASE_EXECUTION_DEADLINE_EXHAUSTED';
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && cleanupCodes.has(code) ? code : 'UNKNOWN_CLEANUP_ERROR';
}
export function branchRemainingMs() {
  const episode = episodes.getStore();
  if (episode?.cleanup) fault('POST_DEADLINE_BUSINESS_OPERATION_REFUSED', 408);
  const left = (episode?.deadline ?? performance.now() + LIMITS.wallMs) - performance.now();
  if (left <= 0 || episode?.controller.signal.reason === deadlineAbort) fault('BRANCH_DEADLINE_EXHAUSTED', 408);
  if (episode?.controller.signal.aborted) fault('BRANCH_CANCELLED', 409);
  return Math.max(1, Math.floor(left));
}
export const branchSignal = () => episodes.getStore()?.controller.signal;
/** Cleanup has a separate bounded drain. It cannot acquire or execute work. */
export async function afterBranchEpisode(invoke: () => Promise<unknown>): Promise<void> {
  const episode = episodes.getStore();
  if (episode && !episode.cleanup) { episode.finalizers.push(invoke); return; }
  await withDatabaseExecutionDeadline(performance.now() + 5000, invoke);
}
export async function inBranchEpisode<T>(milliseconds: number, invoke: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const parent = episodes.getStore();
  if (parent) {
    branchRemainingMs();
    const deadline = Math.min(parent.deadline, performance.now() + milliseconds);
    const timer = setTimeout(() => parent.controller.abort(deadlineAbort), Math.max(1, Math.ceil(deadline - performance.now())));
    try {
      return await episodes.run({ ...parent, deadline }, () => withDatabaseExecutionDeadline(deadline, async () => {
        const value = await invoke(); branchRemainingMs(); return value;
      }));
    } finally { clearTimeout(timer); }
  }
  const deadline = performance.now() + Math.min(milliseconds, LIMITS.wallMs), controller = new AbortController();
  const episode: Episode = { deadline, controller, finalizers: [], cleanup: false };
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(deadlineAbort), Math.max(1, Math.ceil(deadline - performance.now())));
  let value: T | undefined, failure: unknown, failed = false;
  try {
    value = await episodes.run(episode, () => withDatabaseExecutionDeadline(deadline, async () => {
      const result = await invoke(); branchRemainingMs(); return result;
    }));
  } catch (error) {
    failed = true; failure = error instanceof DatabaseExecutionDeadlineError ? new BranchFault('BRANCH_DEADLINE_EXHAUSTED', 408) : error;
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    // One total drain, not five seconds per finalizer. An unfinished intent
    // remains durable and conservatively charged if this drain is unavailable.
    const cleanupDeadline = performance.now() + 5000;
    for (const finalizer of episode.finalizers) {
      try {
        await episodes.run({ ...episode, cleanup: true }, () => withDatabaseExecutionDeadline(cleanupDeadline, finalizer));
      } catch (error) {
        if (!failed) { failed = true; failure = new BranchFault('BRANCH_CLEANUP_REQUIRED', 503); }
        console.error(JSON.stringify({ event: 'P3_CLEANUP_REQUIRED', cause: branchCleanupCause(error),
          durableReconciliationRequired: true }));
      }
    }
  }
  if (failed) throw failure;
  return value as T;
}
export function branchTransportDeadline(request: Request) {
  const value = request.headers.get('x-branch-deadline-ms');
  if (value === null) return LIMITS.wallMs;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > LIMITS.wallMs)
    fault('BRANCH_DEADLINE_INVALID', 400);
  return Number(value);
}
export async function readBranchBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length')) > LIMITS.bytes) {
    void request.body?.cancel().catch(() => undefined); fault('REQUEST_BYTE_BOUND', 413);
  }
  if (!request.body) fault('JSON_INVALID', 400);
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  const signal = branchSignal(); signal?.addEventListener('abort', cancel, { once: true });
  const deadline = episodes.getStore()?.deadline ?? performance.now() + LIMITS.wallMs;
  try {
    if (signal?.aborted) { cancel(); branchRemainingMs(); }
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([reader.read(), new Promise<never>((_, reject) => {
        branchRemainingMs();
        timer = setTimeout(() => { reject(new BranchFault('BRANCH_DEADLINE_EXHAUSTED', 408)); cancel(); },
          Math.max(1, Math.ceil(deadline - performance.now())));
      })]).finally(() => { if (timer) clearTimeout(timer); });
      branchRemainingMs();
      if (next.done) break;
      if (next.value.length > LIMITS.bytes - size) { cancel(); fault('REQUEST_BYTE_BOUND', 413); }
      size += next.value.length; chunks.push(next.value);
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { return fault('JSON_INVALID', 400); }
  } finally { cancel(); signal?.removeEventListener('abort', cancel); reader.releaseLock(); }
}
