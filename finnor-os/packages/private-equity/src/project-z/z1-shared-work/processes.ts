import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  boundedJSON, digest, requireZ1, Z1Fault, type Checkpoint, type Production, type SharedWorkProgram, type SharedWorkRequest,
} from '../../../../epistemic-runtime/src/project-z/z1-shared-work/contracts.js';
import { verifyProgramDigest } from '../../../../epistemic-runtime/src/project-z/z1-shared-work/engine.js';

const engineBase = new URL('../../../../epistemic-runtime/src/project-z/z1-shared-work/', import.meta.url);
const loader = fileURLToPath(new URL('../../../../../node_modules/tsx/dist/loader.mjs', import.meta.url));
const producer = fileURLToPath(new URL('producer-child.ts', engineBase));
const checker = fileURLToPath(new URL('original_checker.py', engineBase));
const closedEnvironment = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH, LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1', TSX_DISABLE_CACHE: '1',
});
export interface ProcessReceipt {
  executable: 'NODE22_PRODUCER' | 'PYTHON3_ORIGINAL_CHECKER'; pid: number | null;
  wallMs: number; inputBytes: number; outputBytes: number; exitCode: number | null; signal: string | null;
  cpuMicros: number | null; peakRSSBytes: number | null; costStatus: 'PROCESS_LOCAL_PARTIAL' | 'UNKNOWN';
  usd: null; inheritedCredentialEnvironment: false; networkSandbox: false;
}
interface ProcessResult { output: string; receipt: ProcessReceipt }
export class Z1ProcessFailure extends Z1Fault {
  readonly receipt: ProcessReceipt;
  constructor(code: string, receipt: ProcessReceipt) { super('INCOMPLETE', code); this.receipt = receipt; }
}
async function run(
  executable: string, args: string[], input: unknown, limitMs: number, kind: ProcessReceipt['executable'],
  signal?: AbortSignal, onStart?: (pid: number) => Promise<void>,
): Promise<ProcessResult> {
  requireZ1(Number.isFinite(limitMs) && limitMs > 0 && limitMs <= 30000, 'REMAINING_PARENT_WALL_BOUND', 'INCOMPLETE');
  boundedJSON(input, 134217728);
  const bytes = Buffer.from(JSON.stringify(input)), started = performance.now();
  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(executable, args, {
      env: closedEnvironment(), cwd: fileURLToPath(engineBase), stdio: ['pipe', 'pipe', 'pipe'],
    });
    let outputBytes = 0, failure: string | null = null, exited = false;
    const output: Buffer[] = [];
    const stop = (code: string): void => { failure ??= code; if (!exited) child.kill('SIGKILL'); };
    const abort = (): void => stop('ORIGINAL_CLAIM_OR_COMPUTE_PERMIT_LOST');
    const timer = setTimeout(() => stop('REMAINING_PARENT_WALL_EXHAUSTED'), Math.ceil(limitMs));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 134217728) stop('CHILD_OUTPUT_BYTE_BOUND');
      else output.push(chunk);
    });
    // Child diagnostics are not copied into native records. They could contain
    // loader paths or future dependency diagnostics, not safe business evidence.
    let stderrBytes = 0;
    child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 65536) stop('CHILD_DIAGNOSTIC_BOUND'); });
    child.on('error', () => { failure ??= 'OWNED_CHILD_SPAWN_FAILED'; });
    child.stdin.on('error', () => { failure ??= 'OWNED_CHILD_INPUT_CLOSED'; });
    child.on('close', (code, exitSignal) => {
      exited = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      const receipt: ProcessReceipt = {
        executable: kind, pid: child.pid ?? null, wallMs: Math.ceil(performance.now() - started),
        inputBytes: bytes.length, outputBytes, exitCode: code, signal: exitSignal,
        cpuMicros: null, peakRSSBytes: null, costStatus: 'UNKNOWN', usd: null,
        inheritedCredentialEnvironment: false, networkSandbox: false,
      };
      if (failure || code !== 0) reject(new Z1ProcessFailure(failure ?? 'OWNED_CHILD_EXIT_INCOMPLETE', receipt));
      else resolve({ output: Buffer.concat(output).toString('utf8'), receipt });
    });
    // Persist the real PID before the child receives any original private input.
    Promise.resolve(child.pid && onStart ? onStart(child.pid) : undefined).then(() => {
      if (!failure && !exited) child.stdin.end(bytes);
    }).catch(() => stop('CHILD_START_RECEIPT_NOT_DURABLE'));
  });
}
export async function runtimeIdentity(): Promise<{ digest: string; files: Array<{ path: string; sha256: string }>; node: string }> {
  const assets = [
    ...['contracts.ts', 'relational.ts', 'engine.ts', 'producer-child.ts', 'original_checker.py'].map(name => new URL(name, engineBase)),
    new URL('processes.ts', import.meta.url), new URL('owner.ts', import.meta.url),
    new URL('../../../../orchestration/src/project-z/z1-shared-work/worker.ts', import.meta.url),
    new URL('../../../../../package-lock.json', import.meta.url),
  ];
  const files = await Promise.all(assets.map(async url => ({
    path: fileURLToPath(url).split('/finnor-os/')[1]!,
    sha256: createHash('sha256').update(await readFile(url)).digest('hex'),
  })));
  requireZ1(/^v22\./.test(process.version), 'NODE_22_RUNTIME_REQUIRED');
  return { digest: digest(files), files, node: process.version };
}
export async function runProducer(
  request: SharedWorkRequest, previous: Checkpoint | undefined, remainingWallMs: number,
  signal?: AbortSignal, onStart?: (pid: number) => Promise<void>,
): Promise<{ production: Production; receipt: ProcessReceipt }> {
  const result = await run(process.execPath, ['--max-old-space-size=1536', '--import', loader, producer],
    { request, ...(previous ? { previous } : {}) }, remainingWallMs, 'NODE22_PRODUCER', signal, onStart);
  try {
    const parsed = JSON.parse(result.output) as { production: Production; physical: {
      userCpuMicros: number; systemCpuMicros: number; peakRSSBytes: number;
    } };
    requireZ1(parsed.production && (!parsed.production.program || verifyProgramDigest(parsed.production.program)), 'CHILD_ARTIFACT_DIGEST', 'COUNTEREXAMPLE');
    for (const value of Object.values(parsed.physical)) requireZ1(typeof value !== 'number' || Number.isFinite(value), 'CHILD_METER_INVALID');
    return { production: parsed.production, receipt: { ...result.receipt,
      cpuMicros: parsed.physical.userCpuMicros + parsed.physical.systemCpuMicros,
      peakRSSBytes: parsed.physical.peakRSSBytes, costStatus: 'PROCESS_LOCAL_PARTIAL' } };
  } catch { throw new Z1ProcessFailure('PRODUCER_RESULT_OR_METERS_INVALID', result.receipt); }
}
export interface OriginalCheckReceipt {
  disposition: 'CHECKED_CANDIDATE' | 'COUNTEREXAMPLE' | 'INCOMPLETE';
  checker: string; checkerSha256: string; requestDigest: string; candidateDigest: string;
  originalWorksChecked: number; originalNodesChecked: number; originalResultDigests: Record<string, string>;
  executionAuthorityGranted: false; protectedAdmission: false; process: ProcessReceipt;
}
export async function checkOriginal(
  request: SharedWorkRequest, candidate: SharedWorkProgram, remainingWallMs: number,
  signal?: AbortSignal, onStart?: (pid: number) => Promise<void>,
): Promise<OriginalCheckReceipt> {
  const result = await run('python3', [checker], { request, candidate }, remainingWallMs, 'PYTHON3_ORIGINAL_CHECKER', signal, onStart);
  try {
    const parsed = JSON.parse(result.output) as {
      disposition: OriginalCheckReceipt['disposition']; checker?: string; requestDigest?: string; candidateDigest?: string;
      originalWorksChecked?: number; originalNodesChecked?: number; originalResultDigests?: Record<string, string>;
    };
    requireZ1(['CHECKED_CANDIDATE', 'COUNTEREXAMPLE', 'INCOMPLETE'].includes(parsed.disposition), 'CHECKER_RESULT_INVALID', 'COUNTEREXAMPLE');
    if (parsed.disposition === 'CHECKED_CANDIDATE') requireZ1(
      parsed.checker === request.identity.checkerIdentity && parsed.requestDigest === digest(request) &&
      parsed.candidateDigest === candidate.envelope.immutableArtifactDigest && parsed.originalWorksChecked === request.works.length,
    'INDEPENDENT_ORIGINAL_CHECK_BINDING', 'COUNTEREXAMPLE');
    return {
      disposition: parsed.disposition, checker: parsed.checker ?? 'z1-original-fraction-v1',
      checkerSha256: createHash('sha256').update(await readFile(checker)).digest('hex'),
      requestDigest: parsed.requestDigest ?? digest(request), candidateDigest: parsed.candidateDigest ?? candidate.envelope.immutableArtifactDigest,
      originalWorksChecked: parsed.originalWorksChecked ?? 0, originalNodesChecked: parsed.originalNodesChecked ?? 0,
      originalResultDigests: parsed.originalResultDigests ?? {}, executionAuthorityGranted: false, protectedAdmission: false,
      process: result.receipt,
    };
  } catch (error) {
    if (error instanceof Z1Fault) throw error;
    throw new Z1ProcessFailure('CHECKER_RESULT_INVALID', result.receipt);
  }
}
