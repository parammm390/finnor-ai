import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { ElicitationProblem, ElicitationRule, ElicitationCheck } from '../../../shared-types/src/elicitation-protocol';

export const r3Hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
export function r3Canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(r3Canonical).join(',') + ']';
  return '{' + Object.entries(value as Record<string, unknown>).filter(([,v]) => v !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => JSON.stringify(k) + ':' + r3Canonical(v)).join(',') + '}';
}
export const r3Digest = (value: unknown): string => r3Hash(r3Canonical(value));
const directory = fileURLToPath(new URL('.', import.meta.url));
const RuntimeSchema = z.object({
  schema: z.literal('finnor.r3.native-runtime.v1'), python: z.string().startsWith('/'),
  pythonVersion: z.string(), scipVersion: z.literal('10.0.0'), pyscipoptVersion: z.literal('6.0.0'),
  numpyVersion: z.literal('2.2.6'), platform: z.string(), architecture: z.string(),
  files: z.array(z.object({ path: z.string().startsWith('/'), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(4).max(4096),
  licenseInventory: z.array(z.object({ component: z.string(), license: z.string(), source: z.string(), evidenceDigest: z.string() }).strict()).min(3),
  exactMode: z.literal('NOT_AVAILABLE_FLOAT64_PROPOSALS_ONLY'),
}).strict();
export type R3RuntimeIdentity = { digest: string; checkerDigest: string; producerDigest: string;
  runtime: z.infer<typeof RuntimeSchema>; sourceDigests: Array<{ path: string; sha256: string }> };
async function inspect(): Promise<R3RuntimeIdentity> {
  const path = process.env.FINNOR_R3_RUNTIME_MANIFEST;
  if (!path || !path.startsWith('/')) throw Error('R3_PINNED_RUNTIME_MANIFEST_REQUIRED');
  const raw = await readFile(path); if (raw.length > 1024 * 1024) throw Error('R3_RUNTIME_MANIFEST_BOUND');
  const runtime = RuntimeSchema.parse(JSON.parse(raw.toString('utf8')));
  if (process.getuid?.() === 0) throw Error('R3_NON_ROOT_RUNTIME_REQUIRED');
  if (await realpath(runtime.python) === '/usr/bin/python3') throw Error('R3_PINNED_INTERPRETER_REQUIRED');
  const executable = await stat(runtime.python); if (!(executable.mode & 0o111)) throw Error('R3_EXECUTABLE_ACCESS_REQUIRED');
  for (const file of runtime.files) {
    if (r3Hash(await readFile(file.path)) !== file.sha256) throw Error('R3_NATIVE_RUNTIME_BYTES_CHANGED');
  }
  const required = await realpath(runtime.python);
  if (!runtime.files.some(file => file.path === required)) throw Error('R3_INTERPRETER_DIGEST_REQUIRED');
  const sourceDigests = await Promise.all(['producer.py', 'repair.py', 'checker.py', 'launcher.ts', 'contracts.ts', 'exact.ts'].map(async name => {
    const path = directory + name; return { path, sha256: r3Hash(await readFile(path)) };
  }));
  return { digest: r3Digest({ runtime, sourceDigests, node: process.version, arch: process.arch, platform: process.platform }),
    checkerDigest: sourceDigests.find(f => f.path.endsWith('/checker.py'))!.sha256,
    producerDigest: sourceDigests.find(f => f.path.endsWith('/producer.py'))!.sha256, runtime, sourceDigests };
}
let loaded: Promise<R3RuntimeIdentity> | undefined;
export async function r3RuntimeIdentity(): Promise<R3RuntimeIdentity> {
  loaded ??= inspect();
  const [previous, current] = await Promise.all([loaded, inspect()]);
  if (previous.digest !== current.digest) throw Error('R3_LOADED_NATIVE_SOURCE_OR_RUNTIME_CHANGED');
  return previous;
}
export interface R3ChildReceipt {
  kind: 'PRODUCER' | 'CHECKER'; startedAt: string; finishedAt: string; elapsedMs: number;
  commandDigest: string; runtimeDigest: string; inputDigest: string; outputDigest: string | null;
  exitCode: number | null; termination: string; stderrDigest: string; stderrBytes: number;
  costs: { usd: null; basis: 'UNMETERED'; externalCalls: 0 };
  nativeUsage: { cpuUserSeconds:number;cpuSystemSeconds:number;maxRssBytes:number } | null;
}
export async function runR3Child<T>(kind: R3ChildReceipt['kind'], input: unknown, absoluteDeadline: number,
  seconds: number, signal?: AbortSignal): Promise<{ output: T; receipt: R3ChildReceipt }> {
  const identity = await r3RuntimeIdentity(), bytes = r3Canonical(input), start = performance.now(), startedAt = new Date().toISOString();
  if (Buffer.byteLength(bytes) > (kind === 'PRODUCER' ? 2 : 8) * 1024 * 1024) throw Error('R3_CHILD_INPUT_BYTE_BOUND');
  const remaining = Math.min(25000, seconds * 1000, absoluteDeadline - Date.now());
  if (remaining <= 0 || signal?.aborted) throw Error('R3_ORIGINAL_CHILD_DEADLINE_OR_CANCELLATION');
  const script = directory + (kind === 'PRODUCER' ? 'producer.py' : 'checker.py');
  const args = kind === 'PRODUCER'
    ? ['-I', '-c', "import runpy,sys;sys.path.insert(0,sys.argv[1]);runpy.run_path(sys.argv[1]+'/producer.py',run_name='__main__')", directory.replace(/\/$/, '')]
    : ['-I', script];
  return new Promise((resolve, reject) => {
    const child = spawn(identity.runtime.python, args, { detached: true, cwd: directory,
      env: { NODE_ENV: process.env.NODE_ENV ?? 'test', PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1', PYTHONDONTWRITEBYTECODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [], stderr: Buffer[] = []; let outputBytes = 0, errorBytes = 0, reason = 'EXITED', finished = false;
    const stop = (predicate: string) => { reason = predicate; if (child.pid) try { process.kill(-child.pid, 'SIGKILL') } catch { /* already terminated */ } };
    const timer = setTimeout(() => stop('ORIGINAL_DEADLINE_EXHAUSTED'), remaining);
    const abort = () => stop('CANCELLED_PHYSICAL_CHILD'); signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => { outputBytes += chunk.length; if (outputBytes > 8 * 1024 * 1024) stop('OUTPUT_BYTE_BOUND'); else stdout.push(chunk) });
    child.stderr.on('data', (chunk: Buffer) => { errorBytes += chunk.length; if (errorBytes > 65536) stop('STDERR_BYTE_BOUND'); else stderr.push(chunk) });
    child.on('error', error => { if (!finished) { finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(error) } });
    child.on('close', async code => {
      if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      const outputBytes = Buffer.concat(stdout), errors = Buffer.concat(stderr);
      const receipt: R3ChildReceipt = { kind, startedAt, finishedAt: new Date().toISOString(), elapsedMs: performance.now() - start,
        commandDigest: r3Digest([identity.runtime.python, ...args]), runtimeDigest: identity.digest, inputDigest: r3Hash(bytes),
        outputDigest: code === 0 && reason === 'EXITED' ? r3Hash(outputBytes) : null, exitCode: code, termination: reason,
        stderrDigest: r3Hash(errors), stderrBytes: errorBytes, nativeUsage:null, costs: { usd: null, basis: 'UNMETERED', externalCalls: 0 } };
      try {
        if (code !== 0 || reason !== 'EXITED') throw Object.assign(Error('R3_NATIVE_CHILD_INCOMPLETE'), { receipt });
        await r3RuntimeIdentity();
        const output = JSON.parse(outputBytes.toString('utf8')) as T;
        const usage=(output as {usage?:{cpuUserSeconds:number;cpuSystemSeconds:number;maxRssBytes:number}}).usage;
        if(!usage||![usage.cpuUserSeconds,usage.cpuSystemSeconds,usage.maxRssBytes].every(v=>Number.isFinite(v)&&v>=0))
          throw Error('R3_NATIVE_RESOURCE_USAGE_REQUIRED');
        receipt.nativeUsage={cpuUserSeconds:usage.cpuUserSeconds,cpuSystemSeconds:usage.cpuSystemSeconds,maxRssBytes:usage.maxRssBytes};
        if(usage.maxRssBytes>1024*1024*1024)throw Error('R3_NATIVE_OBSERVED_MEMORY_BOUND');
        resolve({ output, receipt });
      } catch (error) { reject(Object.assign(error instanceof Error ? error : Error('R3_CHILD_INVALID_OUTPUT'), { receipt })) }
    });
    child.stdin.on('error', () => undefined); child.stdin.end(bytes);
  });
}
export const proposeR3Rule = (problem: ElicitationProblem, deadline: number, seconds: number, signal?: AbortSignal) =>
  runR3Child<{ status: string; rule: ElicitationRule | null; trace?: Record<string, unknown>; usage?: Record<string, unknown> }>('PRODUCER', { problem, seconds }, deadline, seconds, signal);
export async function checkR3Rule(problem: ElicitationProblem, rule: ElicitationRule, deadline: number, seconds: number, signal?: AbortSignal) {
  const checked = await runR3Child<ElicitationCheck>('CHECKER', { problem, rule }, deadline, seconds, signal);
  if (!checked.output.accepted || checked.output.checker.sourceDigest !== problem.binding.checkerDigest ||
    checked.output.inputDigest !== r3Digest(problem) || checked.output.ruleDigest !== r3Digest(rule)) {
    throw Object.assign(Error('R3_INDEPENDENT_ORIGINAL_RULE_REJECTED'), { receipt: checked.receipt, check: checked.output });
  }
  return checked;
}
