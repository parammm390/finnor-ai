/** A separate physical ledger with disposable, non-production verification roots. */
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
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
  // Observe the real client; no proxy, request mutation, headers or bodies.
  const requests: Record<string, unknown>[] = [], begun = new WeakMap<object, number>();
  let dropped = 0;
  const subscriptions = ['create', 'headers', 'trailers', 'error'].map(stage => {
    const source = channel('undici:request:' + stage);
    const observe = (raw: unknown) => {
      const value = raw as { request?: { origin?: string; method?: string; path?: string }; response?: { statusCode?: number }; error?: { name?: string; code?: string; message?: string } };
      const request = value.request;
      if (!request || String(request.origin) !== origin) return;
      if (stage === 'create') begun.set(request, performance.now());
      if (requests.length >= 8192) { dropped++; return }
      requests.push({ stage, at: new Date().toISOString(), method: request.method,
        path: request.path?.split('?')[0], elapsedMs: performance.now() - (begun.get(request) ?? performance.now()),
        status: value.response?.statusCode ?? null,
        error: value.error ? { name: value.error.name, code: value.error.code ?? null,
          message: String(value.error.message ?? '').slice(0, 256) } : null });
    };
    source.subscribe(observe);
    return { source, observe };
  });
  return { child, scopes, publicEvidence: { sources, release, ledgerPolicyDigest: hash(policy), ownerPolicyDigest: hash(ownerPolicy),
    signerPublicKey: publicPem(signer), reviewerPublicKey: publicPem(reviewer), processId: child.pid,
    qualification: 'SEPARATE_PHYSICAL_PROCESS_DISPOSABLE_AUTHORITY_NOT_PRODUCTION_ADMISSION' },
    journal: async () => (await readFile(join(root, 'protected/commitments.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    diagnostics: async () => {
      const journalPath = join(root, 'protected/commitments.jsonl');
      const journal = await readFile(journalPath);
      return { schema: 'finnor.r3.ledger-receiver-diagnostics.v1', requestTimeoutMs: 2000, leaseMs: 5000,
        observer: 'NODE_UNDICI_DIAGNOSTICS_CHANNEL_NO_REQUEST_INTERCEPTION', requests, dropped,
        receiver: { processId: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, logs: logs.slice(-16384) },
        journal: { path: journalPath, bytes: journal.length, sha256: bytesHash(journal),
          records: journal.toString().trim().split('\n').filter(Boolean).length },
        qualification: 'DISPOSABLE_SIGNED_RECEIVER_DIAGNOSIS_NOT_PROTECTED_ADMISSION' };
    },
    close: async () => {
      for (const { source, observe } of subscriptions) source.unsubscribe(observe);
      if (child.exitCode === null && child.signalCode === null) await new Promise<void>(yes => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
        child.once('exit', () => { clearTimeout(timer); yes() }); child.kill('SIGTERM');
      });
      for (const [key, value] of Object.entries({ FINNOR_S6_OWNER_TRANSPORT_CONFIG: previous.config, FINNOR_S6_OWNER_TRANSPORT_ROOT: previous.root }))
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
    },
  };
}
