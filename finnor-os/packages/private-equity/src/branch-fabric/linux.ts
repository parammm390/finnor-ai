import { constants } from 'node:fs';
import { open, readdir, lstat, readFile, writeFile, mkdir, mkdtemp, rm, rmdir, realpath } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, verify, createPublicKey } from 'node:crypto';
import { release } from 'node:os';
import { z } from 'zod';
import { bytesHash, canonical, decode, fault, hash, Hex, LIMITS, type InputArtifact } from './contracts';
import type { ProcessReceipt } from './runtime';
const exec = promisify(execFile);
const launcherEnv: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', NODE_ENV: 'production' };
export const RUNSC_VERSION = 'release-20260928.0';
const ProfileSchema = z.object({
  schema: z.literal('finnor.p3.linux-profile.v1'), version: z.literal(RUNSC_VERSION),
  runtimePath: z.string().min(1), runtimeSha256: Hex, rootfs: z.string().min(1),
  architecture: z.enum(['x64', 'arm64']), kernelRelease: z.string().min(1),
  cgroupRoot: z.string().min(1), workRoot: z.string().min(1),
  rootfsFiles: z.array(z.object({ path: z.string().regex(/^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/), sha256: Hex, mode: z.number().int() }).strict()).min(1).max(1024),
  cpuFeatures: z.array(z.string().regex(/^[A-Za-z0-9_]+$/)).max(256),
  qualification: z.literal('DEVELOPMENT_ORIGIN_NOT_S8_ADMISSION'),
}).strict();
export type LinuxProfile = z.infer<typeof ProfileSchema>;
export class LinuxCellFailure extends Error {
  constructor(readonly receipt: ProcessReceipt) { super(receipt.reason ?? 'LINUX_CELL_FAILED'); }
}
async function safeBytes(path: string, bound = 128 * 1024 * 1024) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const st = await fd.stat(); if (!st.isFile() || st.nlink !== 1 || st.size > bound) fault('RUNTIME_FILE_UNSAFE'); return await fd.readFile(); } finally { await fd.close(); }
}
export async function fileManifest(root: string): Promise<Array<{ path: string; sha256: string; mode: number }>> {
  const files: Array<{ path: string; sha256: string; mode: number }> = [];
  const visit = async (dir: string) => {
    for (const entry of await readdir(dir)) {
      if (!/^[A-Za-z0-9_.-]+$/.test(entry) || ['..', '.'].includes(entry)) fault('RUNTIME_PATH_UNSAFE');
      const path = join(dir, entry), st = await lstat(path);
      if (st.isSymbolicLink() || st.nlink > 1 && st.isFile()) fault('RUNTIME_LINK_REFUSED');
      if (st.isDirectory()) await visit(path);
      else if (st.isFile()) files.push({ path: relative(root, path), sha256: bytesHash(await safeBytes(path)), mode: st.mode & 0o777 });
      else fault('RUNTIME_SPECIAL_FILE_REFUSED');
      if (files.length > 1024) fault('RUNTIME_FILE_BOUND');
    }
  };
  if ((await lstat(root)).isSymbolicLink()) fault('RUNTIME_ROOT_UNSAFE');
  await visit(root); return files.sort((a, b) => a.path.localeCompare(b.path));
}
export async function verifiedLinuxProfile(): Promise<LinuxProfile> {
  if (process.platform !== 'linux') fault('LINUX_ISOLATION_UNPASSED', 424);
  const path = process.env.FINNOR_P3_LINUX_PROFILE, key = process.env.FINNOR_P3_LINUX_ORIGIN_KEY;
  if (!path || !key) fault('LINUX_PROFILE_NOT_CONFIGURED', 424);
  const envelope = JSON.parse((await safeBytes(path, 512 * 1024)).toString());
  if (Object.keys(envelope).sort().join() !== 'body,signature') fault('LINUX_PROFILE_FIELDS_INVALID');
  const p = decode(ProfileSchema, envelope.body);
  const pk = createPublicKey(key);
  if (pk.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(canonical(p)), pk, Buffer.from(envelope.signature, 'base64'))) fault('LINUX_PROFILE_SIGNATURE_INVALID');
  if (p.architecture !== process.arch || p.kernelRelease !== release()) fault('LINUX_HOST_INCOMPATIBLE');
  for (const path of [p.runtimePath, p.rootfs, p.cgroupRoot, p.workRoot]) if (!path.startsWith('/') || resolve(path) !== path) fault('LINUX_PROFILE_PATH_INVALID');
  for (const path of [p.runtimePath, p.rootfs, p.cgroupRoot, p.workRoot]) if (await realpath(path) !== path) fault('LINUX_PROFILE_LINK_REFUSED');
  const privateRoot = await lstat(p.workRoot);
  if (!privateRoot.isDirectory() || (privateRoot.mode & 0o077) !== 0 || privateRoot.uid !== process.getuid?.()) fault('LINUX_WORK_ROOT_NOT_PRIVATE');
  if (bytesHash(await safeBytes(p.runtimePath)) !== p.runtimeSha256) fault('RUNSC_BINARY_CHANGED');
  const version = await exec(p.runtimePath, ['--version'], { timeout: 1000, env: launcherEnv });
  if (!version.stdout.includes('20260928.0')) fault('RUNSC_VERSION_MISMATCH');
  if (hash(await fileManifest(p.rootfs)) !== hash(p.rootfsFiles)) fault('DIRTY_OR_MUTATED_RUNTIME_IMAGE');
  const controllers = await readFile(join(p.cgroupRoot, 'cgroup.controllers'), 'utf8');
  if (!['cpu', 'memory', 'pids'].every(c => controllers.split(/\s+/).includes(c))) fault('CGROUP_V2_CONTROLLERS_UNAVAILABLE');
  const enabled = await readFile(join(p.cgroupRoot, 'cgroup.subtree_control'), 'utf8');
  if (!['cpu', 'memory', 'pids'].every(c => enabled.split(/\s+/).includes(c))) fault('CGROUP_V2_DELEGATION_NOT_ENABLED');
  if (!p.cgroupRoot.startsWith('/sys/fs/cgroup/')) fault('CGROUP_V2_MOUNT_PATH_UNSUPPORTED');
  return p;
}
export async function linuxCapability() {
  try { const p = await verifiedLinuxProfile(); return { status: 'CONFIGURED_UNVERIFIED_DOMAIN', version: p.version, binaryDigest: p.runtimeSha256, imageDigest: hash(p.rootfsFiles), qualification: p.qualification, protectedEligible: false }; }
  catch (e) { return { status: 'LINUX_ISOLATION_UNPASSED', reason: e instanceof Error ? e.message : 'LINUX_UNAVAILABLE', platform: process.platform, protectedEligible: false }; }
}
export function ociSpec(p: LinuxProfile, cgroupPath: string) {
  return {
    ociVersion: '1.0.2', hostname: 'p3-private-cell',
    root: { path: p.rootfs, readonly: true },
    process: { terminal: false, user: { uid: 65534, gid: 65534 }, args: ['/bin/node', '/app/native-worker.mjs'], env: ['NODE_ENV=production', 'PATH=/bin', 'HOME=/nonexistent', 'TMPDIR=/tmp', 'FINNOR_P3_STATE=/state'], cwd: '/', noNewPrivileges: true, capabilities: { bounding: [], effective: [], inheritable: [], permitted: [], ambient: [] }, rlimits: [{ type: 'RLIMIT_NOFILE', hard: 64, soft: 64 }, { type: 'RLIMIT_NPROC', hard: 32, soft: 32 }] },
    mounts: [
      { destination: '/proc', type: 'proc', source: 'proc', options: ['nosuid', 'noexec', 'nodev'] },
      { destination: '/dev', type: 'tmpfs', source: 'tmpfs', options: ['nosuid', 'strictatime', 'mode=755', 'size=1m'] },
      { destination: '/tmp', type: 'tmpfs', source: 'tmpfs', options: ['nosuid', 'nodev', 'noexec', 'size=8m', 'nr_inodes=128', 'mode=1777'] },
      { destination: '/state', type: 'tmpfs', source: 'tmpfs', options: ['nosuid', 'nodev', 'noexec', 'size=32m', 'nr_inodes=128', 'uid=65534', 'gid=65534', 'mode=700'] },
    ],
    linux: {
      namespaces: ['pid', 'network', 'ipc', 'uts', 'mount'].map(type => ({ type })), cgroupsPath: '/' + relative('/sys/fs/cgroup', cgroupPath),
      resources: { memory: { limit: 512 * 1024 * 1024, swap: 512 * 1024 * 1024 }, cpu: { quota: 100000, period: 100000 }, pids: { limit: 32 } },
      maskedPaths: ['/proc/kcore', '/proc/keys', '/proc/timer_list', '/proc/sched_debug', '/sys/firmware'],
      readonlyPaths: ['/proc/sys', '/proc/sysrq-trigger'],
    },
    annotations: p.cpuFeatures.length ? { 'dev.gvisor.internal.cpufeatures': p.cpuFeatures.join(',') } : {},
  };
}
/** No caller-selected mounts, executables, image, URL or OCI flags. */
export async function runLinuxCell(input: InputArtifact, signal: AbortSignal): Promise<{ value: any; receipt: ProcessReceipt }> {
  return invokeLinux(input.programme.id === 'p4-finite' ? '/app/p4-worker.mjs' : '/app/native-worker.mjs', { input, invocationDigest: hash(input) }, hash(input), signal, []);
}
/** Fixed verification-only entries, never reachable through the branch request registry. */
export async function runLinuxProbe(value: { probe: string; tag: string; tripwirePort: number; hostSentinel: string }, signal: AbortSignal) {
  if (process.env.FINNOR_P3_LINUX_CERTIFIER !== '1' || process.env.NODE_ENV === 'production') fault('LINUX_CERTIFIER_ONLY', 403);
  if (!['egress', 'host', 'storage', 'inodes', 'output', 'memory', 'descendants', 'wall'].includes(value.probe)) fault('UNREGISTERED_LINUX_PROBE');
  return invokeLinux('/app/probe.mjs', value, hash(value), signal, []);
}
export async function runLinuxFixtureProbe(input: InputArtifact, signal: AbortSignal, port: number) {
  if (process.env.FINNOR_P3_LINUX_CERTIFIER !== '1' || input.kind !== 'application_fixture' || !Number.isInteger(port) || port < 1 || port > 65535) fault('LINUX_CERTIFIER_ONLY', 403);
  return invokeLinux('/app/native-worker.mjs', { input, invocationDigest: hash(input) }, hash(input), signal, ['FINNOR_P3_TRIPWIRE=http://127.0.0.1:' + port]);
}
async function invokeLinux(entry: '/app/native-worker.mjs' | '/app/p4-worker.mjs' | '/app/probe.mjs', value: unknown, invocationDigest: string, signal: AbortSignal, extraEnv: string[]): Promise<{ value: any; receipt: ProcessReceipt }> {
  const p = await verifiedLinuxProfile(), id = 'p3-' + randomUUID(), bundle = await mkdtemp(join(p.workRoot, 'cell-')), runtimeRoot = join(bundle, 'runsc');
  await mkdir(runtimeRoot, { mode: 0o700 });
  const group = join(p.cgroupRoot, id);
  await mkdir(group, { mode: 0o700 });
  // Provisioner delegates this cgroup subtree; launcher never grants itself privilege.
  await writeFile(join(group, 'memory.max'), String(512 * 1024 * 1024));
  await writeFile(join(group, 'memory.swap.max'), '0');
  await writeFile(join(group, 'pids.max'), '32');
  await writeFile(join(group, 'cpu.max'), '100000 100000');
  const spec = ociSpec(p, group); spec.process.args[1] = entry; spec.process.env.push(...extraEnv);
  await writeFile(join(bundle, 'config.json'), JSON.stringify(spec));
  const flags = [`--root=${runtimeRoot}`, '--network=none', '--platform=systrap', '--file-access=exclusive'];
  const encoded = canonical(value), startedAt = new Date().toISOString(), started = performance.now(), before = process.resourceUsage();
  if (Buffer.byteLength(encoded) > LIMITS.bytes) fault('LINUX_INPUT_BOUND', 413);
  let output = '', reason: string | null = null, pid: number | null = null;
  let stopped = false;
  try {
    await new Promise<void>((yes, no) => {
      const child = spawn(p.runtimePath, [...flags, 'run', '--bundle=' + bundle, id], { env: launcherEnv, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      pid = child.pid ?? null;
      const kill = () => { reason ??= 'CANCELLED_OR_DEADLINE'; void exec(p.runtimePath, [...flags, 'kill', '--all=true', id, 'KILL'], { timeout: 2000, env: launcherEnv }).catch(() => undefined); };
      const timer = setTimeout(kill, LIMITS.wallMs), hardTimer = setTimeout(() => { if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch {} } }, LIMITS.wallMs + 3000);
      signal.addEventListener('abort', kill, { once: true }); if (signal.aborted) kill();
      child.stdout!.on('data', b => { if (reason === 'LINUX_OUTPUT_BOUND') return; output += b.toString(); if (Buffer.byteLength(output) > LIMITS.bytes) { reason = 'LINUX_OUTPUT_BOUND'; kill(); } });
      child.stderr!.on('data', () => undefined); child.stdin!.on('error', () => kill());
      child.once('error', no);
      child.once('close', (code, term) => { clearTimeout(timer); clearTimeout(hardTimer); signal.removeEventListener('abort', kill); code === 0 && !term && !reason ? yes() : no(Error(reason ?? 'LINUX_PROCESS_FAILED')); });
      child.stdin!.end(encoded);
    });
  } catch (e) {
    reason ??= e instanceof Error ? e.message : 'LINUX_INVOCATION_FAILED';
  } finally {
    await exec(p.runtimePath, [...flags, 'delete', '--force', id], { timeout: 3000, env: launcherEnv }).catch(() => undefined);
    try {
      await writeFile(join(group, 'cgroup.kill'), '1');
      const end = Date.now() + 3000;
      do {
        stopped = !(await readFile(join(group, 'cgroup.procs'), 'utf8')).trim();
        if (stopped) break;
        await new Promise(ok => setTimeout(ok, 25));
      } while (Date.now() < end);
    } catch { stopped = false; }
  }
  const receipt = await linuxReceipt();
  if (!stopped) receipt.reason ??= 'LINUX_TEARDOWN_UNCONFIRMED';
  if (stopped) {
    await rm(bundle, { recursive: true, force: true }).catch(() => { receipt.reason ??= 'LINUX_BUNDLE_CLEANUP_REQUIRED'; });
    // cgroup pseudo-files are not ordinary files to recursively unlink.
    await rmdir(group).catch(() => { receipt.reason ??= 'LINUX_CGROUP_CLEANUP_REQUIRED'; });
  }
  if (receipt.reason) throw new LinuxCellFailure(receipt);
  try { return { value: JSON.parse(output), receipt }; }
  catch { receipt.reason = 'LINUX_OUTPUT_SCHEMA_INVALID'; throw new LinuxCellFailure(receipt); }
  async function linuxReceipt(): Promise<ProcessReceipt> {
    let cpuMs: number | null = null, memoryBytes: number | null = null;
    try {
      const cpu = await readFile(join(group, 'cpu.stat'), 'utf8'), memory = await readFile(join(group, 'memory.peak'), 'utf8');
      const use = cpu.match(/usage_usec (\d+)/)?.[1];
      if (!use || !/^\d+\s*$/.test(memory)) throw Error('METER_INVALID');
      cpuMs = Number(use) / 1000; memoryBytes = Number(memory);
    } catch { reason ??= 'LINUX_METER_UNAVAILABLE'; }
    const after = process.resourceUsage();
    return { schema: 'finnor.branch-runtime-receipt.v1', backend: `GVISOR_RUNSC:${RUNSC_VERSION}:${p.runtimeSha256}`, profile: 'LINUX_GVISOR_DEVELOPMENT', invocationDigest, startedAt, finishedAt: new Date().toISOString(), pid, processGroup: pid, observedStopped: stopped, elapsedMs: performance.now() - started, inputBytes: Buffer.byteLength(encoded), outputBytes: Buffer.byteLength(output), sampledTreePeakRssBytes: memoryBytes, sampledTreeCpuMs: cpuMs, meterStatus: cpuMs === null ? 'METER_UNAVAILABLE' : 'CGROUP_V2_RUNTIME_TREE_PEAK_NOT_PARENT_INCLUSIVE', isolated: true, protectedEligible: false, parentCpuMicros: after.userCPUTime - before.userCPUTime + after.systemCPUTime - before.systemCPUTime, parentPeakRssBytes: after.maxRSS * 1024, reason };
  }
}
/** Raw runsc checkpoint protocol; caller must quiesce app and capture complete disk
 * state first. Memory alone is explicitly not a consistent application snapshot. */
export async function checkpointRunsc(p: LinuxProfile, runtimeRoot: string, containerId: string, imagePath: string, consistentDisk: { manifestDigest: string; quiesced: true }) {
  if (hash(await verifiedLinuxProfile()) !== hash(p)) fault('RUNSC_PROFILE_CHANGED');
  if (!/^p3-[a-f0-9-]{36}$/.test(containerId) || !consistentDisk.quiesced || !Hex.safeParse(consistentDisk.manifestDigest).success) fault('RUNSC_CHECKPOINT_BINDING_INVALID');
  if (!resolve(imagePath).startsWith(p.workRoot + '/') || !resolve(runtimeRoot).startsWith(p.workRoot + '/')) fault('RUNSC_CHECKPOINT_PATH_REFUSED');
  await exec(p.runtimePath, [`--root=${runtimeRoot}`, '--network=none', '--platform=systrap', 'checkpoint', '--compression=none', '--image-path=' + imagePath, containerId], { timeout: 30000, env: launcherEnv });
  return { schema: 'finnor.p3.runsc-checkpoint.v1', runtimeSha256: p.runtimeSha256, architecture: p.architecture, kernelRelease: p.kernelRelease, cpuFeatures: p.cpuFeatures, diskManifestDigest: consistentDisk.manifestDigest, imageManifest: await fileManifest(imagePath), credentialsIncluded: false, restoredIdentityMustBeFresh: true, qualification: p.qualification };
}
export async function restoreRunsc(p: LinuxProfile, runtimeRoot: string, newContainerId: string, imagePath: string, checkpoint: Awaited<ReturnType<typeof checkpointRunsc>>, restoredDiskManifestDigest: string) {
  if (hash(await verifiedLinuxProfile()) !== hash(p)) fault('RUNSC_PROFILE_CHANGED');
  if (!/^p3-[a-f0-9-]{36}$/.test(newContainerId) || !resolve(runtimeRoot).startsWith(p.workRoot + '/') || !resolve(imagePath).startsWith(p.workRoot + '/') || checkpoint.runtimeSha256 !== p.runtimeSha256 || checkpoint.architecture !== p.architecture || checkpoint.kernelRelease !== p.kernelRelease || hash(checkpoint.cpuFeatures) !== hash(p.cpuFeatures) || checkpoint.diskManifestDigest !== restoredDiskManifestDigest || hash(checkpoint.imageManifest) !== hash(await fileManifest(imagePath))) fault('RUNSC_RESTORE_INCOMPATIBLE');
  const flags = [`--root=${runtimeRoot}`, '--network=none', '--platform=systrap'];
  await exec(p.runtimePath, [...flags, 'create', '--bundle=' + resolve(runtimeRoot, '..'), newContainerId], { timeout: 3000, env: launcherEnv });
  await exec(p.runtimePath, [...flags, 'restore', '--detach', '--image-path=' + imagePath, newContainerId], { timeout: 30000, env: launcherEnv });
  return { containerId: newContainerId, status: 'RESTORED_REQUIRES_APPLICATION_REKEY_AND_INDEPENDENT_STATE_CHECK', protectedEligible: false };
}
