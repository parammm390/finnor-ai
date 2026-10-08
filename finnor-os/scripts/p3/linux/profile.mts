import { readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { release } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { bytesHash, canonical, hash } from '../../../packages/private-equity/src/branch-fabric/contracts';
import { fileManifest, RUNSC_VERSION, type LinuxProfile } from '../../../packages/private-equity/src/branch-fabric/linux';
if (process.platform !== 'linux') throw Error('LINUX_PROFILE_CREATION_UNPASSED_NON_LINUX_HOST');
const [bundle, runtime, expected, cgroup, work, keyPath, output, publicOutput] = process.argv.slice(2);
if (process.argv.length !== 10 || !/^[a-f0-9]{64}$/.test(expected ?? '')) throw Error('EXACT_PROFILE_ARGUMENTS_REQUIRED');
for (const path of [bundle, runtime, cgroup, work, keyPath, output, publicOutput]) if (!path?.startsWith('/') || resolve(path) !== path) throw Error('ABSOLUTE_PROFILE_PATH_REQUIRED');
const build = JSON.parse(await readFile(join(bundle!, 'build-manifest.json'), 'utf8'));
if (build.rootfsStatus !== 'BUILT_NOT_EXECUTED_OR_ADMITTED' || build.runtime.node !== process.version || build.runtime.architecture !== process.arch) throw Error('LINUX_BUILD_HOST_MISMATCH');
const binary = await readFile(runtime!); if (bytesHash(binary) !== expected) throw Error('RUNSC_BINARY_HASH_MISMATCH');
const version = execFileSync(runtime!, ['--version'], { encoding: 'utf8', timeout: 3000 });
if (!version.includes('20260928.0')) throw Error('RUNSC_VERSION_MISMATCH');
const keyStat = await lstat(keyPath!); if (!keyStat.isFile() || keyStat.isSymbolicLink() || (keyStat.mode & 0o077)) throw Error('PRIVATE_SIGNING_KEY_REQUIRED');
const key = createPrivateKey(await readFile(keyPath!)); if (key.asymmetricKeyType !== 'ed25519') throw Error('ED25519_ORIGIN_REQUIRED');
const body: LinuxProfile = { schema: 'finnor.p3.linux-profile.v1', version: RUNSC_VERSION,
  runtimePath: await realpath(runtime!), runtimeSha256: expected!, rootfs: await realpath(build.rootfs),
  architecture: process.arch as LinuxProfile['architecture'], kernelRelease: release(),
  cgroupRoot: await realpath(cgroup!), workRoot: await realpath(work!), rootfsFiles: await fileManifest(build.rootfs),
  cpuFeatures: [], qualification: 'DEVELOPMENT_ORIGIN_NOT_S8_ADMISSION' };
await writeFile(output!, JSON.stringify({ body, signature: sign(null, Buffer.from(canonical(body)), key).toString('base64') }, null, 2) + '\n', { mode: 0o400, flag: 'wx' });
await writeFile(publicOutput!, createPublicKey(key).export({ type: 'spki', format: 'pem' }), { mode: 0o444, flag: 'wx' });
console.log(JSON.stringify({ output, publicOutput, profileDigest: hash(body), rootfsDigest: hash(body.rootfsFiles), qualification: body.qualification }));
