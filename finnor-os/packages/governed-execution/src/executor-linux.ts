/** Ordinary output-only isolation. This profile cannot grant protected authority. */
import { createHash } from 'node:crypto';
import { open, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const requiredVersion = 'bubblewrap 0.8.0';

async function runtimeForKernel(supervisorNode: string) {
  const root = '/opt/finnor-s6-linux-native', manifestPath = root + '/manifest.json';
  let raw: Buffer;
  try { raw = await readFile(manifestPath) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { node: supervisorNode, bwrap: '/usr/bin/bwrap', architecture: process.arch, supplementalManifestDigest: null };
  }
  const manifestMetadata = await stat(manifestPath);
  if (await realpath(manifestPath) !== manifestPath || manifestMetadata.uid !== 0 || (manifestMetadata.mode & 0o6022))
    throw Error('ISOLATION_CALLEE_MANIFEST_CUSTODY_INVALID');
  const value = JSON.parse(raw.toString());
  if (value.schema !== 'finnor.s6.ordinary-native-callee.v1' || value.kernelMachine !== 'aarch64'
    || value.architecture !== 'arm64' || value.node !== root + '/node' || value.bwrap !== root + '/bwrap'
    || value.uname !== root + '/uname' || !Array.isArray(value.files) || value.files.length > 1024)
    throw Error('ISOLATION_CALLEE_MANIFEST_INVALID');
  const known = new Set<string>();
  for (const pin of value.files) {
    if (typeof pin.path !== 'string' || !(pin.path.startsWith(root + '/')
      || pin.path.startsWith('/usr/lib/aarch64-linux-gnu/') || pin.path === '/usr/lib/ld-linux-aarch64.so.1')
      || !/^[a-f0-9]{64}$/.test(pin.sha256) || known.has(pin.path)) throw Error('ISOLATION_CALLEE_FILE_SET_INVALID');
    const actual = await realpath(pin.path), metadata = await stat(actual);
    if (actual !== pin.path || !metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o6022)
      || sha256(await readFile(actual)) !== pin.sha256) throw Error('ISOLATION_CALLEE_FILE_CHANGED');
    known.add(pin.path);
  }
  if (![value.node, value.bwrap, value.uname, '/usr/lib/ld-linux-aarch64.so.1'].every(path => known.has(path)))
    throw Error('ISOLATION_CALLEE_FILE_SET_INCOMPLETE');
  let machine: string;
  try { machine = execFileSync(value.uname, ['-m'], { encoding: 'utf8', timeout: 2000,
    maxBuffer: 4096, env: { LANG: 'C', NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
  catch (error) {
    if (process.arch === 'x64' && (error as NodeJS.ErrnoException).code === 'ENOEXEC')
      return { node: supervisorNode, bwrap: '/usr/bin/bwrap', architecture: 'x64', supplementalManifestDigest: sha256(raw) };
    throw Error('ISOLATION_NATIVE_KERNEL_PROBE_FAILED', { cause: error });
  }
  if (machine !== value.kernelMachine) throw Error('ISOLATION_NATIVE_KERNEL_ABI_MISMATCH');
  return { node: value.node, bwrap: value.bwrap, architecture: value.architecture as string,
    supplementalManifestDigest: sha256(raw) };
}

/** Linux native ABI cBPF, including an ABI check and x32 refusal. No caller policy.
 * Threads must share VM/signal handlers/thread group and use only pthread flags.
 * clone3 returns ENOSYS so libc may use the separately checked clone syscall. */
function nodeFilter(architecture: string): Buffer {
  const arm = architecture === 'arm64';
  const instructions: Array<[number, number, number, number]> = [
    [0x20, 0, 0, 4], [0x15, 1, 0, arm ? 0xc00000b7 : 0xc000003e], [0x06, 0, 0, 0x80000000],
    [0x20, 0, 0, 0], [0x45, 0, 1, 0x40000000], [0x06, 0, 0, 0x80000000],
    [0x15, 0, 1, 435], [0x06, 0, 0, 0x00050026],
  ];
  const denied = arm ? [198, 199, 117, 33, 41, 40, 39, 224, 225, 142, 273, 105,
    106, 104, 217, 218, 219, 97, 265, 268, 270, 271, 280, 282, 425, 438]
    : [41, 53, 57, 58, 101, 133, 155, 165, 166, 167, 168, 169,
      175, 176, 246, 248, 249, 250, 259, 272, 304, 308, 310, 311, 313, 321, 323, 425, 438];
  for (const syscall of denied)
    instructions.push([0x15, 0, 1, syscall], [0x06, 0, 0, 0x00050001]);
  const threadFlags = 0x01000000 | 0x00200000 | 0x00100000 | 0x00080000 | 0x00040000
    | 0x00010000 | 0x00000800 | 0x00000400 | 0x00000200 | 0x00000100;
  instructions.push(
    [0x15, 0, 11, arm ? 220 : 56],
    [0x20, 0, 0, 20], [0x15, 1, 0, 0], [0x06, 0, 0, 0x00050001],
    [0x20, 0, 0, 16], [0x54, 0, 0, 0x00010900], [0x15, 1, 0, 0x00010900], [0x06, 0, 0, 0x00050001],
    [0x20, 0, 0, 16], [0x45, 0, 1, (~threadFlags) >>> 0], [0x06, 0, 0, 0x00050001], [0x06, 0, 0, 0x7fff0000],
    [0x06, 0, 0, 0x7fff0000],
  );
  const bytes = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, yes, no, value], i) => {
    bytes.writeUInt16LE(code, i * 8); bytes[i * 8 + 2] = yes; bytes[i * 8 + 3] = no;
    bytes.writeUInt32LE(value, i * 8 + 4);
  });
  return bytes;
}

export async function prepareLinuxNodeIsolation(scratch: string, node: string) {
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) throw Error('ISOLATION_LINUX_ABI_UNSUPPORTED');
  if (process.getuid?.() === 0) throw Error('ISOLATION_NONROOT_REQUIRED');
  const runtime = await runtimeForKernel(node), bwrap = runtime.bwrap;
  node = runtime.node;
  const binary = await realpath(bwrap), metadata = await stat(binary);
  if (binary !== bwrap || metadata.uid !== 0 || (metadata.mode & 0o6022) !== 0)
    throw Error('ISOLATION_BINARY_CUSTODY_INVALID');
  const version = execFileSync(bwrap, ['--version'], { encoding: 'utf8', timeout: 2000,
    maxBuffer: 4096, env: { LANG: 'C', TZ: 'UTC', NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (version !== requiredVersion) throw Error('ISOLATION_BINARY_VERSION_UNSUPPORTED');
  const filter = nodeFilter(runtime.architecture), filterPath = join(scratch, 'enforced.bpf');
  await writeFile(filterPath, filter, { mode: 0o400 });
  const args = ['--unshare-all', '--unshare-user', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
    '--clearenv', '--setenv', 'HOME', '/scratch', '--setenv', 'TMPDIR', '/scratch',
    '--setenv', 'LANG', 'C', '--setenv', 'TZ', 'UTC', '--setenv', 'NODE_ENV', 'production',
    '--ro-bind', node, '/node', '--ro-bind', '/usr/lib', '/usr/lib', '--symlink', 'usr/lib', '/lib',
    ...(runtime.architecture === 'x64' ? ['--ro-bind', '/usr/lib64', '/usr/lib64', '--symlink', 'usr/lib64', '/lib64'] : []),
    '--dir', '/proc', '--dev', '/dev', '--bind', scratch, '/scratch', '--remount-ro', '/',
    '--chdir', '/scratch', '--seccomp', '3', '/node', '--max-old-space-size=128', '/scratch/worker.mjs'];
  const profile = { schema: 'finnor.s6.ordinary-linux-node-profile.v1', abi: 'linux-' + runtime.architecture,
    binary, binarySha256: sha256(await readFile(binary)), version, args,
    filterSha256: sha256(filter), filterEncoding: runtime.architecture === 'arm64' ? 'LINUX_AARCH64_CBPF_V1' : 'LINUX_X86_64_CBPF_V1',
    supplementalManifestDigest: runtime.supplementalManifestDigest, supervisorArchitecture: process.arch,
    inheritedDescriptors: 'STDIN_STDOUT_STDERR_ONLY_SECCOMP_FD_CONSUMED_BY_BWRAP',
    authority: 'NONE_OUTPUT_UNTRUSTED', protectedExecution: 'UNADMITTED' };
  const fd = await open(filterPath, 'r');
  return { command: bwrap, node, args, fd, profile, profileText: JSON.stringify(profile) };
}
