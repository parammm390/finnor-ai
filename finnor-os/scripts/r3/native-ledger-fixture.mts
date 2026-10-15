/** A separate physical ledger with disposable, non-production verification roots. */
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { canonical } from '../../packages/governed-execution/src/protocol';
import type { OwnerTransportScope } from '../../packages/governed-execution/src/owner-transport';

const hash = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
const bytesHash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const publicPem = (key: ReturnType<typeof generateKeyPairSync>) => key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
export async function nativeLedgerFixture(repo: string, scopes: OwnerTransportScope[], rightsRefs: string[]) {
  const root = await realpath(await mkdtemp(join(repo, '.r3-scratch/native-ledger-')));
  const signer = generateKeyPairSync('ed25519'), reviewer = generateKeyPairSync('ed25519');
  const previous = { config: process.env.FINNOR_S6_OWNER_TRANSPORT_CONFIG, root: process.env.FINNOR_S6_OWNER_TRANSPORT_ROOT };
  const after = new Date(Date.now() - 1000).toISOString(), until = new Date(Date.now() + 3600000).toISOString();
  const credentials = await Promise.all(scopes.map(async (scope, i) => {
    const token = randomUUID() + randomUUID(), origin = generateKeyPairSync('ed25519');
    const tokenPath = join(root, i + '.token'), originPath = join(root, i + '.pem');
    await writeFile(tokenPath, token, { mode: 0o600 });
    await writeFile(originPath, origin.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    return { scope, tokenHash: bytesHash(token), originPublicKey: publicPem(origin), tokenPath, originPath };
  }));
  const fsExt = dirname(createRequire(import.meta.url).resolve('fs-ext/package.json'));
  const paths = ['ledger.ts', 'ledger-server.mts', 'protocol.ts', 'request-verifier.ts', 'adapter-contract.ts']
    .map(p => join(repo, 'finnor-os/packages/governed-execution/src', p));
  paths.push(join(fsExt, 'fs-ext.js'), join(fsExt, 'build/Release/fs_ext.node'), join(fsExt, 'package.json'));
  const sources = await Promise.all(paths.map(async path => ({ path, sha256: bytesHash(await readFile(path)) })));
  const policy = { schema: 'finnor.s6.ledger-policy.v1', domain: 'DISPOSABLE_TEST_AUTHORITY',
    signerPublicKey: publicPem(signer), maxEntries: 4096, owners: credentials.map(c => ({
      tenantId: c.scope.tenantId, principalId: c.scope.principalId, owner: c.scope.semanticOwner, tokenHash: c.tokenHash, rightsRefs,
      append: true, read: true, sealedAppend: false, sealedRead: false,
    })) };
  const release = { schema: 'finnor.s6.ledger-release.v2', releaseId: 'r3-native-owner-disposable',
    sourceDigests: sources, runtime: { node: process.version, nodeAbi: process.versions.modules, platform: process.platform, arch: process.arch },
    policyDigest: hash(policy), validUntil: until };
  const signerPath = join(root, 'ledger.pem'), configPath = join(root, 'ledger.json');
  await writeFile(signerPath, signer.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  await writeFile(configPath, JSON.stringify({ policy,
    release: { ...release, signature: sign(null, Buffer.from(canonical(release)), reviewer.privateKey).toString('base64') },
    signerPath, protectedDirectory: join(root, 'protected'), contentDirectory: join(root, 'ordinary'), port: 0,
  }), { mode: 0o600 });
  let logs = '';
  const child = spawn(process.execPath, ['--import=tsx', join(repo, 'finnor-os/packages/governed-execution/src/ledger-server.mts')], {
    cwd: join(repo, 'finnor-os'), env: { PATH: process.env.PATH, HOME: root,
      FINNOR_S6_LEDGER_CONFIG: configPath, FINNOR_S6_LEDGER_RELEASE_ROOT: publicPem(reviewer) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const origin = await new Promise<string>((yes, no) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); no(Error('R3_NATIVE_LEDGER_BOOT_TIMEOUT:' + logs)) }, 15000);
    child.stdout!.on('data', b => {
      logs += b;
      for (const line of logs.split('\n')) {
        let value: any; try { value = JSON.parse(line) } catch { continue }
        if (value.status === 'READY') { clearTimeout(timer); yes('http://127.0.0.1:' + value.port) }
      }
    });
    child.stderr!.on('data', b => { logs += b });
    child.once('error', no); child.once('exit', () => { clearTimeout(timer); no(Error('R3_NATIVE_LEDGER_BOOT_EXIT:' + logs)) });
  });
  const ownerPolicy = { schema: 'finnor.s6.owner-transport-policy.v1', domain: 'DISPOSABLE_TEST_AUTHORITY',
    validAfter: after, validUntil: until, routes: credentials.map(c => ({ ...c.scope, rightsRefs,
      originKeys: [{ id: 'disposable-origin', publicKey: c.originPublicKey, validAfter: after, validUntil: until, revoked: false }],
      originSigner: { keyId: 'disposable-origin', path: c.originPath }, tokenPath: c.tokenPath, tokenSha256: c.tokenHash,
      ledger: { endpoint: origin, acceptedReceipts: [{ signerPublicKey: publicPem(signer),
        releaseId: release.releaseId, verifierDigest: hash(sources), policyDigest: hash(policy) }] },
      requestTimeoutMs: 2000, leaseMs: 5000,
    })) };
  const ownerPath = join(root, 'owner.json');
  await writeFile(ownerPath, JSON.stringify({ policy: ownerPolicy,
    signature: sign(null, Buffer.from(canonical(ownerPolicy)), reviewer.privateKey).toString('base64') }), { mode: 0o600 });
  process.env.FINNOR_S6_OWNER_TRANSPORT_CONFIG = ownerPath;
  process.env.FINNOR_S6_OWNER_TRANSPORT_ROOT = publicPem(reviewer);
  return { child, scopes, publicEvidence: { sources, release, ledgerPolicyDigest: hash(policy), ownerPolicyDigest: hash(ownerPolicy),
    signerPublicKey: publicPem(signer), reviewerPublicKey: publicPem(reviewer), processId: child.pid,
    qualification: 'SEPARATE_PHYSICAL_PROCESS_DISPOSABLE_AUTHORITY_NOT_PRODUCTION_ADMISSION' },
    journal: async () => (await readFile(join(root, 'protected/commitments.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) await new Promise<void>(yes => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
        child.once('exit', () => { clearTimeout(timer); yes() }); child.kill('SIGTERM');
      });
      for (const [key, value] of Object.entries({ FINNOR_S6_OWNER_TRANSPORT_CONFIG: previous.config, FINNOR_S6_OWNER_TRANSPORT_ROOT: previous.root }))
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    },
  };
}
