/** Ordinary output-only isolation. This profile cannot grant protected authority. */
import { createHash } from 'node:crypto';
import { open, readFile, realpath, stat, writeFile, mkdtemp, rm, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, join } from 'node:path';
import { nodeFilter } from './linux-node-policy.js';
import { z } from 'zod';

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

/** procfs describes the host kernel ABI; an executable uname can be translated
 * by binfmt_misc/QEMU and report its own ABI instead. Unknown hosts fail shut. */
export function linuxKernelArchitecture(cpuinfo: string): 'x64' | 'arm64' {
  const x64 = /^vendor_id\s*:/m.test(cpuinfo) && /^flags\s*:/m.test(cpuinfo);
  const arm64 = /^CPU architecture\s*:\s*8\s*$/m.test(cpuinfo) && /^Features\s*:/m.test(cpuinfo);
  if (x64 === arm64) throw Error('ISOLATION_NATIVE_KERNEL_ABI_UNKNOWN');
  return x64 ? 'x64' : 'arm64';
}

async function runtimeForKernel(supervisorNode: string) {
  const cpu = await open('/proc/cpuinfo', 'r');
  let architecture: 'x64' | 'arm64';
  try {
    const buffer = Buffer.alloc(65536), { bytesRead } = await cpu.read(buffer, 0, buffer.length, 0);
    architecture = linuxKernelArchitecture(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally { await cpu.close() }
  if (architecture === process.arch)
    return { node: supervisorNode, bwrap: '/usr/bin/bwrap', architecture, supplementalManifestDigest: null };
  if (architecture !== 'arm64' || process.arch !== 'x64') throw Error('ISOLATION_NATIVE_KERNEL_ABI_MISMATCH');
  const root = '/opt/finnor-s6-linux-native', manifestPath = root + '/manifest.json';
  let raw: Buffer;
  try { raw = await readFile(manifestPath) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw Error('ISOLATION_NATIVE_CALLEE_REQUIRED', { cause: error });
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
  return { node: value.node, bwrap: value.bwrap, architecture: value.architecture as string,
    supplementalManifestDigest: sha256(raw) };
}

export async function prepareLinuxNodeIsolation(scratch: string, node: string, options: { readOnlyScratch?: boolean } = {}) {
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) throw Error('ISOLATION_LINUX_ABI_UNSUPPORTED');
  if (process.getuid?.() === 0) throw Error('ISOLATION_NONROOT_REQUIRED');
  const runtime = await runtimeForKernel(node), base = '/opt/finnor-s6-jail-'+runtime.architecture;
  const manifestPath=base+'/manifest.json',raw=await readFile(manifestPath),metadata=await stat(manifestPath);
  if(await realpath(manifestPath)!==manifestPath||metadata.uid!==0||(metadata.mode&0o6022))throw Error('ISOLATION_JAIL_MANIFEST_CUSTODY');
  const manifest=JSON.parse(raw.toString()) as {schema:string;architecture:string;files:Array<{path:string;sha256:string}>};
  if(manifest.schema!=='finnor.s6.fixed-jail.v1'||manifest.architecture!==runtime.architecture||!Array.isArray(manifest.files)||manifest.files.length>128)throw Error('ISOLATION_JAIL_MANIFEST_INVALID');
  const known=new Set<string>();
  for(const pin of manifest.files){
    if(typeof pin.path!=='string'||!(pin.path==='launcher'||pin.path.startsWith('root/'))||pin.path.split('/').some(x=>x==='..'||x==='.')||!/^[a-f0-9]{64}$/.test(pin.sha256)||known.has(pin.path))throw Error('ISOLATION_JAIL_PIN_INVALID');
    const path=base+'/'+pin.path,actual=await realpath(path),st=await stat(actual);
    if(actual!==path||!st.isFile()||st.uid!==0||(st.mode&0o6022)||sha256(await readFile(actual))!==pin.sha256)throw Error('ISOLATION_JAIL_PIN_CHANGED');
    known.add(pin.path);
  }
  if(!known.has('launcher')||!known.has('root/node'))throw Error('ISOLATION_JAIL_RUNTIME_MISSING');
  for(const path of [base,base+'/root']){const st=await stat(path);if(await realpath(path)!==path||!st.isDirectory()||st.uid!==0||(st.mode&0o022))throw Error('ISOLATION_JAIL_ROOT_CUSTODY');}
  node=base+'/root/node';const binary=base+'/launcher';
  const filter = nodeFilter(runtime.architecture), filterPath = join(scratch, 'enforced.bpf');
  await writeFile(filterPath, filter, { mode: 0o400,flag:'wx' });
  const isolatedScratch=await mkdtemp(base+'/root/jobs/job-');
  let fd:Awaited<ReturnType<typeof open>>|undefined,bootstrapFd:Awaited<ReturnType<typeof open>>|undefined;
  const bootstrapPath=join(scratch,'linux-bootstrap.json');
  const cleanup=async()=>{const failures=[];for(const operation of [()=>fd?.close(),()=>bootstrapFd?.close(),()=>rm(isolatedScratch,{recursive:true,force:true})]){try{await operation();}catch(error){failures.push(error);}}if(failures.length)throw new AggregateError(failures,'ISOLATION_CLEANUP_FAILED');};
  try{
  await chmod(isolatedScratch,0o700);
  await writeFile(join(isolatedScratch,'worker.mjs'),await readFile(join(scratch,'worker.mjs')),{mode:0o400,flag:'wx'});
  fd=await open(filterPath,'r');bootstrapFd=await open(bootstrapPath,'wx',0o600);
  const args = [basename(isolatedScratch),options.readOnlyScratch?'ro':'rw',String(process.pid)];
  const profile = { schema: 'finnor.s6.ordinary-linux-fixed-jail.v1', abi: 'linux-' + runtime.architecture,
    binary, binarySha256: sha256(await readFile(binary)), manifestDigest:sha256(raw),args,
    filterSha256: sha256(filter), filterEncoding: runtime.architecture === 'arm64' ? 'LINUX_AARCH64_CBPF_V1' : 'LINUX_X86_64_CBPF_V1',
    supplementalManifestDigest: runtime.supplementalManifestDigest, supervisorArchitecture: process.arch,
    scratchAccess: options.readOnlyScratch ? 'READ_ONLY' : 'READ_WRITE',
    inheritedDescriptors: 'STDIN_STDOUT_STDERR_ONLY_FILTER_AND_BOOTSTRAP_FDS_CONSUMED_BEFORE_NODE',
    authority: 'NONE_OUTPUT_UNTRUSTED', protectedExecution: 'UNADMITTED' };
  return { command: binary, node, args, fd, bootstrapFd,bootstrapPath,isolatedScratch,cleanup,profile, profileText: JSON.stringify(profile) };
  }catch(error){await cleanup();throw error;}
}

const processId=z.number().int().positive().max(0x7fffffff);
const linuxBootstrapSchema=z.object({
 schema:z.literal('finnor.s6.linux-bootstrap.v2'),pid:processId,parentPid:processId,
 guardianPid:processId,guestPid:processId,guestParentPid:processId,processGroupId:processId,
 lifetimeGuard:z.literal('TRUSTED_NONEXECUTING_PROCESS_GROUP_GUARD'),
 uid:z.number().int().positive(),capabilities:z.literal(0),noNewPrivileges:z.literal(1),
 fixedJail:z.literal(true),landlockAbi:z.number().int().min(2),filterSha256:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export async function readLinuxBootstrap(path:string,expected:{guardianPid:number|undefined;parentPid:number|null|undefined;filterSha256:string}){
 const {guardianPid:pid,parentPid,filterSha256}=expected;
 const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const st=await fd.stat();if(!st.isFile()||st.size>4096||st.uid!==process.getuid?.()||st.nlink!==1)throw Error('ISOLATION_BOOTSTRAP_RECEIPT_CUSTODY');
  const value=linuxBootstrapSchema.parse(JSON.parse(await fd.readFile('utf8')));
  if(value.pid!==pid||value.guardianPid!==pid||value.guestPid===pid||value.guestParentPid!==pid||value.processGroupId!==pid||value.parentPid!==parentPid||value.uid!==process.getuid?.()||value.filterSha256!==filterSha256||!/^[a-f0-9]{64}$/.test(filterSha256))throw Error('ISOLATION_BOOTSTRAP_RECEIPT_INVALID');
  return value;
 }finally{await fd.close();}
}
