/** Z5 disposable S6 ledger process with the owner-transport routes the Z5 chain needs
 * (S2/S5/S6/S7/S8 plus BUSINESS_OWNER publication). Adapted from scripts/s7/ledger-fixture.mts;
 * unlike that fixture the token set is returned and an S6 OWNER route is included, because the
 * Z5 owner reads S6 obligation execution handoffs through this same transport (the transport
 * grammar allows CONSUMER routes only for S7 and S8). */
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';

const encode = (v: any): string => v === null || typeof v !== 'object' ? JSON.stringify(v)
  : Array.isArray(v) ? '[' + v.map(encode).join(',') + ']'
  : '{' + Object.keys(v).sort((a, b) => a.localeCompare(b)).map(k => JSON.stringify(k) + ':' + encode(v[k])).join(',') + '}';
const hash = (v: unknown) => createHash('sha256').update(encode(v)).digest('hex');
const byteHash = (v: string) => createHash('sha256').update(v).digest('hex');

export async function createZ5Ledger(tenant: string, principal: string, valuatorPrincipal: string, options: {
  directory: string; rightsRef: string; transportPath: string; transportPrivateKeyPem: string;
}) {
  const root = options.directory;
  await mkdir(root, { recursive: true, mode: 0o700 });
  const substrate = resolve('packages/governed-execution/src');
  const fsExt = dirname(createRequire(join(substrate, 'ledger.js')).resolve('fs-ext/package.json'));
  const names = ['ledger.ts', 'ledger-server.mts', 'protocol.ts', 'request-verifier.ts', 'adapter-contract.ts'];
  const paths = names.map(n => join(substrate, n)).concat(['fs-ext.js', 'build/Release/fs_ext.node', 'package.json'].map(n => join(fsExt, n)));
  const snapshotPaths = [...paths, resolve('packages/governed-execution/src/owner-transport.ts'), resolve('scripts/project-z/native/z5-ledger.mts')];
  const snapshot = () => Promise.all(snapshotPaths.map(async path => ({ path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') })));
  const before = await snapshot(), sourceDigests = before.slice(0, paths.length);
  const signer = generateKeyPairSync('ed25519'), reviewer = generateKeyPairSync('ed25519');
  const pub = signer.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const reviewPub = reviewer.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const rights = options.rightsRef;
  const tokenOwners = ['S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'BUSINESS_OWNER', 'FINANCIAL_SOURCE', 'INDEPENDENT_VALUER', 'READER', 'S8_READER'] as const;
  const tokens: Record<string, string> = Object.fromEntries(tokenOwners.map(k => [k, randomUUID() + randomUUID()]));
  const owners = tokenOwners.map(owner => ({
    owner: owner === 'READER' ? 'S7' : owner === 'S8_READER' ? 'S8' : owner,
    tokenHash: byteHash(tokens[owner]!), append: !['READER', 'S8_READER'].includes(owner),
    tenantId: tenant, principalId: owner === 'INDEPENDENT_VALUER' ? valuatorPrincipal : principal,
    rightsRefs: [rights], read: true, sealedAppend: false, sealedRead: false,
  }));
  const policy = { schema: 'finnor.s6.ledger-policy.v1', domain: 'DISPOSABLE_TEST_AUTHORITY', owners, signerPublicKey: pub, maxEntries: 100000 };
  const releaseBody = { schema: 'finnor.s6.ledger-release.v2', releaseId: 'z5-disposable-candidate', sourceDigests,
    runtime: { node: process.version, nodeAbi: process.versions.modules, platform: process.platform, arch: process.arch },
    policyDigest: hash(policy), validUntil: new Date(Date.now() + 3600000).toISOString() };
  const release = { ...releaseBody, signature: sign(null, Buffer.from(encode(releaseBody)), reviewer.privateKey).toString('base64') };
  await writeFile(join(root, 'signer.pem'), signer.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  await mkdir(join(root, 'protected'), { mode: 0o700 });
  await mkdir(join(root, 'ordinary'), { mode: 0o700 });
  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({ policy, release, signerPath: join(root, 'signer.pem'),
    protectedDirectory: join(root, 'protected'), contentDirectory: join(root, 'ordinary'), port: 0 }), { mode: 0o600 });
  let child: ChildProcess | null = null, base = '', logs = '';
  async function start() {
    logs = '';
    child = spawn(process.execPath, ['--import=tsx', 'packages/governed-execution/src/ledger-server.mts'],
      { env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
        FINNOR_S6_LEDGER_CONFIG: configPath, FINNOR_S6_LEDGER_RELEASE_ROOT: reviewPub }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((ok, fail) => {
      const timer = setTimeout(() => fail(Error('Z5_LEDGER_BOOT_TIMEOUT:' + logs.slice(-600))), 30000);
      child!.stdout!.on('data', b => {
        logs += b;
        for (const line of logs.split('\n')) try {
          const state = JSON.parse(line);
          if (state.status === 'READY') { base = 'http://127.0.0.1:' + state.port; clearTimeout(timer); ok(); }
        } catch { /* partial line */ }
      });
      child!.stderr!.on('data', b => { logs += b; });
      child!.once('exit', code => { clearTimeout(timer); fail(Error('Z5_LEDGER_EXIT_' + code + ':' + logs.slice(-600))); });
    });
  }
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(ok => { child!.once('close', () => ok()); child!.kill('SIGKILL'); });
  }
  async function call(path: string, payload?: any, token = tokens.S7!) {
    const r = await fetch(base + path, { method: payload === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      ...(payload === undefined ? {} : { body: encode(payload) }), signal: AbortSignal.timeout(15000) });
    return { status: r.status, body: await r.json() as any };
  }
  await start();
  const verifierDigest = hash(sourceDigests);
  const origin = generateKeyPairSync('ed25519'), originPub = origin.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const originPath = join(root, 'origin.pem');
  await writeFile(originPath, origin.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const validAfter = new Date(Date.now() - 60000).toISOString(), validUntil = new Date(Date.now() + 3600000).toISOString();
  const routeDefinitions: Array<[string, string, string]> = [
    ['S2', 'OWNER', 'S2'], ['S5', 'OWNER', 'S5'], ['S6', 'OWNER', 'S6'],
    ['S7', 'OWNER', 'S7'], ['S7', 'CONSUMER', 'READER'], ['S8', 'OWNER', 'S8'], ['S8', 'CONSUMER', 'S8_READER'],
  ];
  const routes = [];
  for (const [semanticOwner, purpose, tokenKey] of routeDefinitions) {
    const tokenPath = join(root, tokenKey + '.token');
    await writeFile(tokenPath, tokens[tokenKey]!, { mode: 0o600 });
    routes.push({ semanticOwner, tenantId: tenant, principalId: principal, purpose, rightsRefs: [rights],
      originKeys: [{ id: 'z5-origin', publicKey: originPub, validAfter, validUntil, revoked: false }],
      ...(purpose === 'OWNER' ? { originSigner: { keyId: 'z5-origin', path: originPath } } : {}),
      tokenPath, tokenSha256: byteHash(tokens[tokenKey]!),
      ledger: { endpoint: base, acceptedReceipts: [{ signerPublicKey: pub, releaseId: releaseBody.releaseId, verifierDigest, policyDigest: hash(policy) }] },
      requestTimeoutMs: 10000, leaseMs: 20000 });
  }
  const transportPolicy = { schema: 'finnor.s6.owner-transport-policy.v1', domain: 'DISPOSABLE_TEST_AUTHORITY', validAfter, validUntil, routes };
  const transportKey = (await import('node:crypto')).createPrivateKey(options.transportPrivateKeyPem);
  await writeFile(options.transportPath, JSON.stringify({ policy: transportPolicy,
    signature: sign(null, Buffer.from(encode(transportPolicy)), transportKey).toString('base64') }), { mode: 0o600 });
  return { root, rights, tokens, before, policy, release, call, start, stop, endpoint: () => base, publicKey: pub,
    child: () => child,
    publish: async (reference: any) => {
      const a = await call('/references', { reference, rightsRefs: [rights] }, tokens[reference.owner]!);
      if (a.status !== 200) throw Error('Z5_LEDGER_PUBLISH_' + a.status + ':' + JSON.stringify(a.body).slice(0, 400));
      return a;
    } };
}
