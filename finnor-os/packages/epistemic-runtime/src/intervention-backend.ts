import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { S3ModelComputeInvocation } from '@finnor/shared-types';
import { epistemicHash } from './source-precedence';
export type S3PreparedReferenceSink=(reference:{schema:'finnor.s3.prepared-reference.v1';id:string;version:string;contentDigest:string;content:Record<string,unknown>})=>Promise<void>;

const script = fileURLToPath(new URL('./intervention-numerics.py', import.meta.url));
const sources = [fileURLToPath(import.meta.url), script, fileURLToPath(new URL('./interventions.ts', import.meta.url)),
  fileURLToPath(new URL('./intervention-requirements.txt', import.meta.url))];
// Capture at module loading. A later source edit cannot acquire the old loaded
// implementation's identity by reading current bytes only after computation.
const loadedSources = Promise.all(sources.map(async path => ({ path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') })));
// Index imports also load this module for S1/S2. Missing packaged S3 sources
// must be a typed S3 failure, never an unhandled rejection in unrelated work.
void loadedSources.catch(() => undefined);
let active = 0;
const outputLimit = 8 * 1024 * 1024;
let diagnosticSequence = 0;
function privateProcessDiagnostic(input: string, sourceDigests: Array<{ path: string; sha256: string }>, timeoutMs: number, start: number) {
  const topic = channel('finnor.s3.private-process-diagnostic.v1');
  if (process.env.NODE_ENV !== 'test' || process.env.FINNOR_W4_PROFILE !== 'ordinary_disposable'
    || process.env.FINNOR_S3_PROCESS_DIAGNOSTICS !== '1' || !topic.hasSubscribers) return null;
  const rawInput = Buffer.from(input, 'utf8'), inputSha256 = createHash('sha256').update(rawInput).digest('hex');
  const id = createHash('sha256').update(`${process.pid}:${++diagnosticSequence}:${start}:${inputSha256}`).digest('hex');
  const events: Array<Record<string, unknown>> = [], childTraceChunks: Array<{ receivedAtParentElapsedMs: number; data: string }> = [];
  const stderrChunks: Buffer[] = [];
  let stderrCaptured = 0, stderrBytes = 0, childTraceBytes = 0, childTraceOverflow = false;
  let rawStdout: Buffer = Buffer.alloc(0), child: Record<string, unknown> | null = null, finished = false;
  const header = { id, publisherPid: process.pid, startedAt: new Date().toISOString(),
    parentMonotonicOriginMs: start, timeoutMs, inputSha256, inputBytes: rawInput.length,
    inputRef: `s3-input:${epistemicHash(JSON.parse(input))}`, sourceDigests,
    executable: process.env.FINNOR_S3_PYTHON ?? null, cwd: process.cwd(), nodeExecutable: process.execPath,
    timerStartSemantics: 'AFTER_SPAWN_RETURN_BEFORE_IO_HANDLERS', diagnosticStorageIsNotAuthority: true };
  const mark = (phase: string, detail: Record<string, unknown> = {}) => {
    if (events.length < 64) events.push({ phase, parentElapsedMs: performance.now()-start, ...detail });
  };
  const publish = (stage: string, extra: Record<string, unknown>, bytes: Record<string, Buffer>) => {
    let persisted = false;
    try { topic.publish({ schema: 'finnor.s3.private-process-diagnostic.v1', stage, id, publisherPid: process.pid,
      header: { ...header, ...extra }, ...bytes, confirmPersisted: () => { persisted = true; } }); }
    catch { /* Observation never changes a product result. */ }
    return persisted;
  };
  const inputPersisted = publish('INPUT', {}, { rawInput });
  mark('INPUT_CAPTURE_RETURNED', { persisted: inputPersisted });
  return {
    mark,
    setChild: (value: Record<string, unknown>) => { child = { ...child, ...value }; },
    observeStderr: (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrCaptured < 2048) { const part = chunk.subarray(0, 2048-stderrCaptured); stderrChunks.push(part); stderrCaptured += part.length; }
    },
    observeTrace: (chunk: Buffer) => {
      childTraceBytes += chunk.length;
      if (childTraceBytes > 16384) { childTraceOverflow = true; return; }
      childTraceChunks.push({ receivedAtParentElapsedMs: performance.now()-start, data: chunk.toString('utf8') });
    },
    stdout: (bytes: Buffer) => { rawStdout = bytes; },
    finish: (detail: Record<string, unknown>) => {
      if (finished) return; finished = true; mark('FINISHED');
      publish('OUTCOME', { ...detail, events, child, childTraceChunks, childTraceBytes, childTraceOverflow,
        stderrTotalBytes: stderrBytes, stderrTruncated: stderrBytes > stderrCaptured, inputPersisted },
      { rawStdout, rawStderr: Buffer.concat(stderrChunks) });
    },
  };
}
export async function interventionBackendIdentity(): Promise<Array<{ path: string; sha256: string }>> { return loadedSources; }
export async function interventionBackendCurrent(expected: S3ModelComputeInvocation['backend']['sourceDigests']): Promise<boolean> {
  try { const current = await loadedSources; return epistemicHash(current) === epistemicHash(expected)
    && (await Promise.all(expected.map(async s => createHash('sha256').update(await readFile(s.path)).digest('hex') === s.sha256))).every(Boolean); }
  catch { return false; }
}

/** Trusted application configuration chooses the executable, never request data.
 * This ordinary numerical process grants no credential, capability or egress. */
export async function invokeInterventionBackend(payload: Record<string, unknown>, actor: {
  tenantId: string; principalId: string; rightsRefs: string[]; seed: number; timeoutMs?: number;preparedReferenceSink?:S3PreparedReferenceSink;
}): Promise<{ result: any | null; compute: S3ModelComputeInvocation; reason: string | null }> {
  const startedAt = new Date().toISOString(), start = performance.now(), cpu = process.cpuUsage(), rss = process.memoryUsage().rss;
  const timeoutMs = actor.timeoutMs === undefined ? 20000 : Math.max(1, Math.min(20000, Math.floor(actor.timeoutMs)));
  let sourceDigests: Awaited<typeof loadedSources> = []; try { sourceDigests = await loadedSources; } catch { /* Explicit unattested failure below. */ }
  const input = JSON.stringify(payload);
  let diagnostic: ReturnType<typeof privateProcessDiagnostic> = null;
  try { diagnostic = privateProcessDiagnostic(input, sourceDigests, timeoutMs, start); }
  catch { /* Best-effort observation cannot turn a product result into an error. */ }
  diagnostic?.mark('PREPARED_REFERENCE_BEGIN');
  try { await actor.preparedReferenceSink?.({schema:'finnor.s3.prepared-reference.v1',id:`s3-input:${epistemicHash(payload)}`,version:'s3-backend-input-v1',contentDigest:epistemicHash(payload),content:payload}); }
  catch (error) { diagnostic?.finish({ reason: 'PREPARED_REFERENCE_THROWN', earlyErrorClass: error instanceof Error ? error.name : 'NON_ERROR', computeInputRef: null }); throw error; }
  diagnostic?.mark('PREPARED_REFERENCE_READY');
  const compute: S3ModelComputeInvocation = { schema: 'finnor.model-compute-invocation.v1', id: '', semanticOwner: 'S3', tenantId: actor.tenantId, principalId: actor.principalId, rightsRefs: actor.rightsRefs,
    inputRef: `s3-input:${epistemicHash(payload)}`, outputRefs: [], requestedRoute: 'LOCAL_TEMPORAL_NUMERICAL', actualRoute: 'UNAVAILABLE', fallbacks: [],
    backend: { name: 'statsmodels-arch-scipy', versions: {}, sourceDigests, identityBasis: sourceDigests.length === sources.length ? 'LOADED_SOURCE_AND_INSTALLED_VERSIONS' : 'SOURCE_IDENTITY_UNAVAILABLE', reproducibilityAttestation: null },
    model: { method: 's3-temporal-linear-v1', capabilityAdmission: 'BLOCKED_EXTERNAL' },
    harness: { nodeVersion: process.version, pythonVersion: null, platform: process.platform, architecture: process.arch,
      configuration: { timeoutMs, outputLimitBytes: outputLimit, maxConcurrentProcesses: 2, pythonConfigured: Boolean(process.env.FINNOR_S3_PYTHON), operation: payload.operation }, deterministicReplayClaimed: false },
    attempts: [], randomness: { used: true, seed: actor.seed },
    usage: { elapsedMs: 0, parentCpuUserMicros: 0, parentCpuSystemMicros: 0, parentRssBeforeBytes: rss, parentRssAfterBytes: rss,
      childMaxRssBytes: null, childCpuUserSeconds: null, childCpuSystemSeconds: null, accountingScope: 'PARENT_INCLUSIVE_INTERVAL_CHILD_PROCESS_MAX_NOT_CONTAINER_PEAK' },
    cost: { money: null, pricebookRef: null, status: 'LOCAL_COST_UNMETERED', externalCalls: 0 }, admission: { status: 'BLOCKED_EXTERNAL', receipt: null } };
  let reason: string | null = null, result: any | null = null;
  if (!process.env.FINNOR_S3_PYTHON) reason = 'BACKEND_EXECUTABLE_NOT_CONFIGURED';
  else if (sourceDigests.length !== sources.length || !await interventionBackendCurrent(sourceDigests)) reason = 'BACKEND_SOURCE_IDENTITY_UNAVAILABLE_OR_CHANGED';
  else if (Buffer.byteLength(input) > outputLimit) reason = 'BACKEND_INPUT_LIMIT_EXCEEDED';
  else if (active >= 2) reason = 'BACKEND_BUSY';
  else {
    active++;
    try {
      const attempt = await new Promise<{ data: string; error: string | null }>(resolve => {
        // -B keeps the isolated interpreter from writing new bytecode caches
        // beside declared sources; the closed scientific namespace refuses any
        // unlisted file before this spawn (X1_INSTALLATION_UNLISTED_SCIENTIFIC_INPUT).
        const spawnArguments = diagnostic ? ['-I', '-B', '-X', 'finnor_s3_diagnostics=1', script] : ['-I', '-B', script];
        diagnostic?.mark('SPAWN_REQUESTED', { executable: process.env.FINNOR_S3_PYTHON!, cwd: process.cwd(), spawnArguments });
        const child = spawn(process.env.FINNOR_S3_PYTHON!, spawnArguments, { shell: false, stdio: diagnostic ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
          env: { NODE_ENV: process.env.NODE_ENV ?? 'production', PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1', OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1', LC_ALL: 'C' } });
        const chunks: Buffer[] = []; let size = 0, failure: string | null = null, stderr = '';
        const timer = setTimeout(() => { failure = 'BACKEND_TIMEOUT'; child.kill('SIGKILL'); diagnostic?.mark('TIMEOUT_FIRED'); }, timeoutMs);
        diagnostic?.mark('SPAWN_RETURNED_TIMER_INSTALLED', { pid: child.pid ?? null });
        diagnostic?.setChild({ pid: child.pid ?? null });
        const phasePipe = child.stdio[3];
        if (phasePipe && 'readable' in phasePipe) {
          phasePipe.on('data', (chunk: Buffer) => { diagnostic?.observeTrace(chunk); });
          phasePipe.on('error', () => { diagnostic?.mark('DIAGNOSTIC_PIPE_ERROR'); });
          phasePipe.on('end', () => { diagnostic?.mark('DIAGNOSTIC_PIPE_EOF'); });
        }
        child.on('spawn', () => { diagnostic?.mark('CHILD_SPAWNED'); });
        let firstOutput = true, firstError = true;
        child.stdout!.on('data', (chunk: Buffer) => { if (firstOutput) { diagnostic?.mark('STDOUT_FIRST'); firstOutput = false; } size += chunk.length; if (size > outputLimit) { failure = 'BACKEND_OUTPUT_LIMIT_EXCEEDED'; child.kill('SIGKILL'); } else chunks.push(chunk); });
        child.stderr!.on('data', (chunk: Buffer) => { if (firstError) { diagnostic?.mark('STDERR_FIRST'); firstError = false; } diagnostic?.observeStderr(chunk); if (stderr.length < 2048) stderr += chunk.toString('utf8').slice(0, 2048-stderr.length); });
        child.on('error', (error: NodeJS.ErrnoException) => { failure = 'BACKEND_EXECUTABLE_UNAVAILABLE'; diagnostic?.mark('CHILD_ERROR', { code: error.code ?? null }); phasePipe?.destroy(); });
        child.on('exit', (code, signal) => { diagnostic?.mark('CHILD_EXIT', { code, signal }); diagnostic?.setChild({ exitCode: code, signal }); phasePipe?.destroy(); });
        child.stdin!.on('error', (error: NodeJS.ErrnoException) => { diagnostic?.mark('STDIN_ERROR', { code: error.code ?? null }); /* Close/error records the failed attempt. */ });
        child.stdin!.on('finish', () => { diagnostic?.mark('STDIN_FINISH'); });
        child.on('close', (code, signal) => { clearTimeout(timer); const data = Buffer.concat(chunks); diagnostic?.stdout(data); diagnostic?.mark('CHILD_CLOSE', { code, signal, stdoutBytes: size }); diagnostic?.setChild({ exitCode: code, signal, stdoutBytes: size, stdoutTruncated: size > outputLimit }); resolve({ data: data.toString('utf8'), error: failure ?? (code === 0 ? null : `BACKEND_FAILED:${stderr.replace(/[\r\n]/g, ' ').slice(0, 256)}`) }); });
        child.stdin!.end(input);
      });
      reason = attempt.error;
      if (!reason) {
        try { result = JSON.parse(attempt.data); } catch { reason = 'BACKEND_INVALID_JSON'; }
        if (result && (!result.backend || result.backend.sourceDigest !== sourceDigests.find(s => s.path === script)?.sha256)) reason = 'BACKEND_SOURCE_ATTESTATION_MISMATCH';
        if (result && result.usage?.childMaxRssBytes > 512 * 1024 * 1024) reason = 'BACKEND_OBSERVED_MEMORY_LIMIT_EXCEEDED';
        if (!reason && result) {
          compute.actualRoute = 'LOCAL_TEMPORAL_NUMERICAL'; compute.backend.versions = result.backend.versions;
          compute.harness.pythonVersion = result.backend.python; Object.assign(compute.usage, result.usage);
          compute.outputRefs = [`s3-numerical-output:${epistemicHash(result)}`];
        }
      }
    } catch (error) {
      diagnostic?.finish({ reason: 'ADAPTER_THROWN', earlyErrorClass: error instanceof Error ? error.name : 'NON_ERROR', computeInputRef: compute.inputRef }); throw error;
    } finally { active--; }
  }
  if (reason) result = null;
  const elapsedCpu = process.cpuUsage(cpu);
  Object.assign(compute.usage, { elapsedMs: performance.now()-start, parentCpuUserMicros: elapsedCpu.user, parentCpuSystemMicros: elapsedCpu.system, parentRssAfterBytes: process.memoryUsage().rss });
  compute.attempts = [{ startedAt, finishedAt: new Date().toISOString(), status: reason === 'BACKEND_BUSY' ? 'REJECTED_BUSY' : reason ? 'FAILED' : 'COMPLETED', reason }];
  compute.id = `model-compute:${epistemicHash(compute)}`;
  diagnostic?.finish({ reason, computeId: compute.id, computeInputRef: compute.inputRef,
    actualRoute: compute.actualRoute, versions: compute.backend.versions });
  return { result, compute, reason };
}
