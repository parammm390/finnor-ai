import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
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
const supervisor = fileURLToPath(new URL('process_supervisor.py', engineBase));
const repository = new URL('../../../../../../', import.meta.url);
const sourceFingerprints = new Map<string, string>();
const closedEnvironment = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'production', PATH: process.env.PATH, LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1', TSX_DISABLE_CACHE: '1',
});
export interface ProcessReceipt {
  executable: 'NODE22_PRODUCER' | 'PYTHON3_ORIGINAL_CHECKER'; pid: number | null;
  wallMs: number; inputBytes: number; outputBytes: number; exitCode: number | null; signal: string | null;
  cpuMicros: number | null; peakRSSBytes: number | null; costStatus: 'PROCESS_LOCAL_PARTIAL' | 'UNKNOWN';
  usd: null; inheritedCredentialEnvironment: false; networkSandbox: false;
  supervisorPid?: number | null; supervisorCpuMicros?: number | null; supervisorPeakRSSBytes?: number | null;
  stderrBytes?: number; blockInputs?: number | null; blockOutputs?: number | null;
  lifetimeScope?: 'WAIT4_COMPLETE_EXITED_CHILD_AND_SEPARATE_SUPERVISOR' | 'INTERRUPTED_COST_UNKNOWN';
  supervisorMeasurementScope?: 'SELF_THROUGH_PRE_FINISH_REPORT_EXIT_TAIL_UNKNOWN';
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
    const child = spawn('python3', [supervisor, String(Math.ceil(limitMs)), executable, ...args], {
      env: closedEnvironment(), cwd: fileURLToPath(engineBase), stdio: ['pipe', 'pipe', 'pipe', 'pipe'], detached: true,
    });
    let outputBytes = 0, failure: string | null = null, exited = false;
    let actualPid: number | null = null, meterText = '', meterBytes = 0;
    let physical: { pid: number; cpuMicros: number; peakRSSBytes: number; supervisorCpuMicros: number;
      supervisorPeakRSSBytes: number; blockInputs: number; blockOutputs: number; exitCode: number } | null = null;
    const output: Buffer[] = [];
    const stop = (code: string): void => {
      failure ??= code;
      if (!exited && child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    };
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
    const meter = child.stdio[3];
    requireZ1(meter && 'on' in meter, 'OWNED_LIFETIME_METER_REQUIRED');
    meter.on('data', (chunk: Buffer) => {
      meterBytes += chunk.length;
      if (meterBytes > 65536) { stop('CHILD_LIFETIME_METER_BOUND'); return; }
      meterText += chunk.toString('utf8');
      for (;;) {
        const end = meterText.indexOf('\n'); if (end < 0) break;
        const line = meterText.slice(0, end); meterText = meterText.slice(end + 1);
        try {
          const value = JSON.parse(line);
          if (value.kind === 'START') {
            requireZ1(actualPid === null && Number.isSafeInteger(value.pid) && value.pid > 1 &&
              value.supervisorPid === child.pid, 'ACTUAL_CHILD_IDENTITY_REQUIRED');
            actualPid = value.pid;
            Promise.resolve(onStart?.(value.pid)).then(() => {
              if (!failure && !exited) child.stdin.end(bytes);
            }).catch(() => stop('CHILD_START_RECEIPT_NOT_DURABLE'));
          } else {
            requireZ1(value.kind === 'FINISH' && physical === null && value.pid === actualPid &&
              value.supervisorPid === child.pid && value.scope === 'WAIT4_COMPLETE_EXITED_CHILD_AND_SEPARATE_SUPERVISOR',
            'OWNED_COMPLETE_LIFETIME_METER_REQUIRED');
            for (const key of ['cpuMicros', 'peakRSSBytes', 'supervisorCpuMicros', 'supervisorPeakRSSBytes', 'blockInputs', 'blockOutputs'])
              requireZ1(Number.isSafeInteger(value[key]) && value[key] >= 0, 'CHILD_METER_INVALID');
            requireZ1(Number.isSafeInteger(value.exitCode) &&
              value.supervisorMeasurementScope === 'SELF_THROUGH_PRE_FINISH_REPORT_EXIT_TAIL_UNKNOWN',
            'CHILD_EXIT_AND_SUPERVISOR_SCOPE_REQUIRED');
            physical = value;
            if (value.peakRSSBytes > 2684354560) stop('CHILD_OBSERVED_MEMORY_BOUND');
          }
        } catch { stop('OWNED_CHILD_METER_OR_IDENTITY_INVALID'); }
      }
    });
    child.on('close', (code, exitSignal) => {
      exited = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      const receipt: ProcessReceipt = {
        executable: kind, pid: actualPid, supervisorPid: child.pid ?? null, wallMs: Math.ceil(performance.now() - started),
        inputBytes: bytes.length, outputBytes, exitCode: code, signal: exitSignal,
        cpuMicros: physical?.cpuMicros ?? null, peakRSSBytes: physical?.peakRSSBytes ?? null,
        supervisorCpuMicros: physical?.supervisorCpuMicros ?? null, supervisorPeakRSSBytes: physical?.supervisorPeakRSSBytes ?? null,
        stderrBytes, blockInputs: physical?.blockInputs ?? null, blockOutputs: physical?.blockOutputs ?? null,
        lifetimeScope: physical ? 'WAIT4_COMPLETE_EXITED_CHILD_AND_SEPARATE_SUPERVISOR' : 'INTERRUPTED_COST_UNKNOWN',
        ...(physical ? { supervisorMeasurementScope: 'SELF_THROUGH_PRE_FINISH_REPORT_EXIT_TAIL_UNKNOWN' as const } : {}),
        costStatus: physical ? 'PROCESS_LOCAL_PARTIAL' : 'UNKNOWN', usd: null,
        inheritedCredentialEnvironment: false, networkSandbox: false,
      };
      if (failure || code !== 0 || !physical || physical.exitCode !== 0)
        reject(new Z1ProcessFailure(failure ?? 'OWNED_CHILD_EXIT_INCOMPLETE', receipt));
      else resolve({ output: Buffer.concat(output).toString('utf8'), receipt });
    });
  });
}
export async function runtimeIdentity(): Promise<{ digest: string; files: Array<{ path: string; sha256: string }>; node: string }> {
  const assets = [
    ...['contracts.ts', 'relational.ts', 'engine.ts', 'producer-child.ts', 'original_checker.py', 'process_supervisor.py',
      'portfolio-population.ts', 'portfolio-capacity.ts', 'portfolio-stream.ts'].map(name => new URL(name, engineBase)),
    ...['processes.ts', 'owner.ts', 'native-contracts.ts', 'resources.ts', 'native-store.ts', 'admission.ts',
      'owners.ts', 'native.ts', 'api.ts', 'work-panel.tsx', 'recovery.ts', 'deliveries.ts', 'portfolio-store.ts'].map(name => new URL(name, import.meta.url)),
    new URL('../../../../orchestration/src/project-z/z1-shared-work/worker.ts', import.meta.url),
    new URL('../../../../../package-lock.json', import.meta.url),
    ...['allocation-store.ts', 'owner-context.ts', 'enterprise-beliefs.ts', 'economic-store.ts',
      'world-repository.ts'].map(name => new URL(`../../${name}`, import.meta.url)),
    ...['index.ts', 'compute-governor.ts', 'execution-deadline.ts', 'compute-contract.ts', 'schema.ts']
      .map(name => new URL(`../../../../db/${name}`, import.meta.url)),
    new URL('../../../../../apps/worker/src/queue.ts', import.meta.url),
    new URL('../../../../authority/src/index.ts', import.meta.url),
    new URL('../../../../memory/src/evidence.ts', import.meta.url),
    new URL('../../../../epistemic-runtime/src/source-precedence.ts', import.meta.url),
    ...['allocation-contracts.ts', 'allocation-resource-check.ts'].map(name =>
      new URL(`../../../../epistemic-runtime/src/${name}`, import.meta.url)),
    new URL('../../../../../scripts/project-z/z1/shared-schema.sql', import.meta.url),
    new URL('../../../../../scripts/project-z/z1/portfolio-stream.sql', import.meta.url),
    ...['postz_z1_shared_work.sql', 'postz_z1_shared_work_portfolio_v2.sql'].map(name =>
      new URL(`../../../../db/migrations/${name}`, import.meta.url)),
  ];
  const files = await Promise.all(assets.map(async url => ({
    path: fileURLToPath(url).split('/finnor-os/')[1]!,
    sha256: createHash('sha256').update(await readFile(url)).digest('hex'),
  })));
  requireZ1(/^v22\./.test(process.version), 'NODE_22_RUNTIME_REQUIRED');
  return { digest: digest(files), files, node: process.version };
}
/** Emitted by the reconstructible engineering pack, not an environment-supplied
 * commit label or a dependency on hidden Git objects on an installed target. */
export async function installedSourceIdentity(): Promise<{
  sourceCommit: string; sourceTree: string; reconstructionReference: string;
}> {
  const raw = await readFile(new URL('installed-source.json', import.meta.url), 'utf8');
  requireZ1(Buffer.byteLength(raw) <= 1048576, 'Z1_INSTALLED_SOURCE_MANIFEST_BOUND');
  const value = JSON.parse(raw);
  requireZ1(value.schema === 'finnor.z1.installed-source.v1' &&
    /^[a-f0-9]{40}$/.test(value.sourceCommit) && /^[a-f0-9]{40}$/.test(value.sourceTree) &&
    typeof value.reconstructionReference === 'string' && value.reconstructionReference.length <= 256 &&
    /^[a-f0-9]{64}$/.test(value.sourceFilesManifestSha256) && /^[a-f0-9]{64}$/.test(value.integrationPatchSha256) &&
    value.reconstructionReference === `z1-native:${value.sourceCommit}:${value.integrationPatchSha256}:${value.sourceFilesManifestSha256}` &&
    value.nativeRuntimeDigest === (await runtimeIdentity()).digest, 'Z1_INSTALLED_NATIVE_SOURCE_MANIFEST_REQUIRED', 'STALE');
  const manifestBytes = await readFile(new URL('installed-source-files.json', import.meta.url));
  requireZ1(manifestBytes.length <= 8388608 &&
    createHash('sha256').update(manifestBytes).digest('hex') === value.sourceFilesManifestSha256,
  'Z1_INSTALLED_WHOLE_OWNER_SOURCE_MANIFEST_REQUIRED', 'STALE');
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
    schema: string; files: Array<{ path: string; bytes: number; sha256: string }>;
  };
  requireZ1(manifest.schema === 'finnor.z1.native-source-files.v1' && Array.isArray(manifest.files) &&
    manifest.files.length >= 30 && manifest.files.length <= 20000 &&
    new Set(manifest.files.map(file => file.path)).size === manifest.files.length,
  'Z1_INSTALLED_COMPLETE_OWNER_FILE_SET_REQUIRED', 'STALE');
  // New workers check every source byte. Repeated currentness probes stat the
  // same frozen cut and rehash changed files. This is not a privileged filesystem
  // attestation or a proof about dependencies absent from the declared package.
  for (let start = 0; start < manifest.files.length; start += 32) {
    await Promise.all(manifest.files.slice(start, start + 32).map(async file => {
      requireZ1(typeof file.path === 'string' && !file.path.split('/').some(part => part === '.' || part === '..') &&
        !file.path.includes('\\') &&
        !/[%?#\u0000-\u001f]/.test(file.path) &&
        /^(?:src\/|scripts\/|finnor-os\/(?:packages|apps|scripts)\/|(?:finnor-os\/)?(?:package(?:-lock)?\.json|tsconfig(?:\.base)?\.json|next\.config\.mjs)$)/.test(file.path) &&
        !/(?:^|\/)(?:node_modules|\.git|\.next[^/]*)\//.test(file.path) &&
        !/\/installed-source(?:-files)?\.json$/.test(file.path) && Number.isSafeInteger(file.bytes) &&
        file.bytes >= 0 && /^[a-f0-9]{64}$/.test(file.sha256),
      'Z1_INSTALLED_OWNER_SOURCE_PATH_REQUIRED', 'STALE');
      const url = new URL(file.path, repository), metadata = await stat(url, { bigint: true });
      requireZ1(metadata.isFile() && metadata.size === BigInt(file.bytes), 'Z1_INSTALLED_OWNER_SOURCE_BYTES_CHANGED', 'STALE');
      const fingerprint = [value.sourceFilesManifestSha256, metadata.dev, metadata.ino, metadata.size,
        metadata.mtimeNs, metadata.ctimeNs].join(':');
      if (sourceFingerprints.get(file.path) === fingerprint) return;
      requireZ1(createHash('sha256').update(await readFile(url)).digest('hex') === file.sha256,
        'Z1_INSTALLED_OWNER_SOURCE_BYTES_CHANGED', 'STALE');
      sourceFingerprints.set(file.path, fingerprint);
    }));
  }
  return { sourceCommit: value.sourceCommit, sourceTree: value.sourceTree, reconstructionReference: value.reconstructionReference };
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
    return { production: parsed.production, receipt: result.receipt };
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
