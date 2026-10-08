import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, decode, CandidateSchema, fault, hash, LIMITS, type InputArtifact } from './contracts';
import { runLinuxCell, linuxCapability } from './linux';
const exec = promisify(execFile);
export interface ProcessReceipt {
  schema: 'finnor.branch-runtime-receipt.v1'; backend: string; profile: string;
  invocationDigest: string; startedAt: string; finishedAt: string;
  pid: number | null; processGroup: number | null; observedStopped: boolean;
  elapsedMs: number; inputBytes: number; outputBytes: number;
  sampledTreePeakRssBytes: number | null; sampledTreeCpuMs: number | null;
  meterStatus: string; isolated: boolean; protectedEligible: false;
  parentCpuMicros: number; parentPeakRssBytes: number; reason: string | null;
}
export class InvocationFailure extends Error {
  constructor(readonly receipt: ProcessReceipt, readonly causeCode: string) { super(causeCode); }
}
/** Trusted fixed source only. New process group; no inherited secrets/cookies/DB. */
export async function fixedProcess(entry: 'native-worker.mts' | 'checker-worker.mts' | 'p4-worker.mts' | 'interface-worker.mts', input: unknown, signal: AbortSignal, wallMs: number = LIMITS.wallMs, stateRoot?: string, onStarted?: (pid: number) => Promise<void>) {
  const encoded = canonical(input), started = performance.now(), before = process.resourceUsage(), began = new Date().toISOString();
  if (Buffer.byteLength(encoded) > 3 * LIMITS.bytes) fault('INVOCATION_INPUT_BOUND', 413);
  const directory = stateRoot ?? await mkdtemp(join(tmpdir(), 'finnor-p3-runtime-'));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return new Promise<{ value: any; receipt: ProcessReceipt }>((ok, no) => {
    const child = spawn(process.execPath, ['--max-old-space-size=' + LIMITS.heapMiB, '--import=tsx', fileURLToPath(new URL('../../../../scripts/p3/' + entry, import.meta.url))], {
      detached: true, cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
      env: { NODE_ENV: 'test', PATH: '/usr/bin:/bin', TMPDIR: directory, FINNOR_P3_STATE: directory, FINNOR_P3_PARENT_CHANNEL: '3' },
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '', error: string | null = null, sampled = false, peak = 0, cpuMs = 0, poll: Promise<void> | null = null;
    const stop = (reason: string) => { if (error) return; error = reason; if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } } };
    const aborted = () => stop('CANCELLED_OR_FENCE_LOST');
    let startedObservation: Promise<void> = Promise.resolve();
    child.once('spawn', () => { if (child.pid && onStarted) startedObservation = onStarted(child.pid).catch(() => stop('LAUNCH_OBSERVATION_FAILED')); });
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    const timer = setTimeout(() => stop('WALL_DEADLINE'), wallMs);
    const sample = async () => {
      if (!child.pid) return;
      try {
        const { stdout: output } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,rss=,time='], { timeout: 500, maxBuffer: 1024 * 1024 });
        const rows = output.trim().split('\n').map(line => line.trim().split(/\s+/));
        const tree = rows.filter(r => Number(r[2]) === child.pid);
        const rss = tree.reduce((s, r) => s + Number(r[3]) * 1024, 0);
        const cpu = tree.reduce((s, r) => { const t = r[4]?.split(':').map(Number) ?? []; return s + (t.length === 2 ? t[0]! * 60 + t[1]! : t.length === 3 ? t[0]! * 3600 + t[1]! * 60 + t[2]! : 0) * 1000; }, 0);
        sampled = true; peak = Math.max(peak, rss); cpuMs = Math.max(cpuMs, cpu);
      } catch { /* Missing samples are explicit, not measured zero. */ }
    };
    const meter = setInterval(() => { poll ??= sample().finally(() => { poll = null; }); }, 50);
    child.stdout!.on('data', b => { if (error) return; stdout += b.toString(); if (Buffer.byteLength(stdout) > LIMITS.bytes) stop('OUTPUT_BOUND'); });
    child.stderr!.on('data', () => undefined); // Diagnostics never become authoritative or expose private input.
    child.once('error', () => stop('SPAWN_FAILED'));
    child.stdin!.on('error', () => stop('INPUT_CHANNEL_FAILED'));
    child.once('close', async (code, term) => {
      clearTimeout(timer); clearInterval(meter); signal.removeEventListener('abort', aborted);
      await startedObservation;
      if (poll) await poll;
      let stopped = true;
      if (child.pid) { try { process.kill(-child.pid, 0); stopped = false; process.kill(-child.pid, 'SIGKILL'); } catch { /* Group absent. */ } }
      if (!stopped) error ??= 'DESCENDANT_TEARDOWN_UNCONFIRMED';
      if (code !== 0 || term) error ??= 'PROCESS_INTERRUPTED';
      const after = process.resourceUsage();
      const receipt: ProcessReceipt = { schema: 'finnor.branch-runtime-receipt.v1', backend: 'REGISTERED_NODE_PROCESS', profile: 'TRUSTED_NATIVE_H0', invocationDigest: hash(input), startedAt: began, finishedAt: new Date().toISOString(), pid: child.pid ?? null, processGroup: child.pid ?? null, observedStopped: stopped, elapsedMs: performance.now() - started, inputBytes: Buffer.byteLength(encoded), outputBytes: Buffer.byteLength(stdout), sampledTreePeakRssBytes: sampled ? peak : null, sampledTreeCpuMs: sampled ? cpuMs : null, meterStatus: sampled ? 'SAMPLED_CHILD_TREE_NOT_OS_QUOTA_OR_CONTAINER_PEAK' : 'METER_UNAVAILABLE', isolated: false, protectedEligible: false, parentCpuMicros: after.userCPUTime - before.userCPUTime + after.systemCPUTime - before.systemCPUTime, parentPeakRssBytes: after.maxRSS * 1024, reason: error };
      // Only this newly created, controller-owned staging root is removed.
      // Retained logical private state lives in immutable SQL checkpoint artefacts.
      if (!stateRoot) await rm(directory, { recursive: true, force: true }).catch(() => { receipt.reason ??= 'CLEANUP_REQUIRED'; });
      if (error) { no(new InvocationFailure(receipt, error)); return; }
      try { ok({ value: JSON.parse(stdout), receipt }); } catch { no(new InvocationFailure(receipt, 'OUTPUT_SCHEMA_INVALID')); }
    });
    child.stdin!.end(encoded);
  });
}
export async function executeCell(input: InputArtifact, signal: AbortSignal, onStarted?: (pid: number) => Promise<void>) {
  const invocationDigest = hash(input);
  const execution = input.profile === 'LINUX_GVISOR_DEVELOPMENT' ? await runLinuxCell(input, signal) : await fixedProcess(input.programme.id === 'p4-finite' ? 'p4-worker.mts' : 'native-worker.mts', { input, invocationDigest }, signal, LIMITS.wallMs, undefined, onStarted);
  return { candidate: decode(CandidateSchema, execution.value), receipt: execution.receipt, invocationDigest };
}
export const capability = async () => ({ native: { supported: process.platform === 'darwin' || process.platform === 'linux', isolated: false, protectedEligible: false }, linux: await linuxCapability() });
