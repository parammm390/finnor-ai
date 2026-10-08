import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  await actor.preparedReferenceSink?.({schema:'finnor.s3.prepared-reference.v1',id:`s3-input:${epistemicHash(payload)}`,version:'s3-backend-input-v1',contentDigest:epistemicHash(payload),content:payload});
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
        const child = spawn(process.env.FINNOR_S3_PYTHON!, ['-I', script], { shell: false, stdio: ['pipe', 'pipe', 'pipe'],
          env: { NODE_ENV: process.env.NODE_ENV ?? 'production', PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1', OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1', LC_ALL: 'C' } });
        const chunks: Buffer[] = []; let size = 0, failure: string | null = null, stderr = '';
        const timer = setTimeout(() => { failure = 'BACKEND_TIMEOUT'; child.kill('SIGKILL'); }, timeoutMs);
        child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > outputLimit) { failure = 'BACKEND_OUTPUT_LIMIT_EXCEEDED'; child.kill('SIGKILL'); } else chunks.push(chunk); });
        child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 2048) stderr += chunk.toString('utf8').slice(0, 2048-stderr.length); });
        child.on('error', () => { failure = 'BACKEND_EXECUTABLE_UNAVAILABLE'; });
        child.stdin.on('error', () => { /* Close/error records the failed attempt. */ });
        child.on('close', code => { clearTimeout(timer); resolve({ data: Buffer.concat(chunks).toString('utf8'), error: failure ?? (code === 0 ? null : `BACKEND_FAILED:${stderr.replace(/[\r\n]/g, ' ').slice(0, 256)}`) }); });
        child.stdin.end(input);
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
    } finally { active--; }
  }
  if (reason) result = null;
  const elapsedCpu = process.cpuUsage(cpu);
  Object.assign(compute.usage, { elapsedMs: performance.now()-start, parentCpuUserMicros: elapsedCpu.user, parentCpuSystemMicros: elapsedCpu.system, parentRssAfterBytes: process.memoryUsage().rss });
  compute.attempts = [{ startedAt, finishedAt: new Date().toISOString(), status: reason === 'BACKEND_BUSY' ? 'REJECTED_BUSY' : reason ? 'FAILED' : 'COMPLETED', reason }];
  compute.id = `model-compute:${epistemicHash(compute)}`;
  return { result, compute, reason };
}
