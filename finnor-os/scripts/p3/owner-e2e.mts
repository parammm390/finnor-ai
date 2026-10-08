/** Actual S1/S3/S4/S5/S6 owners. All product requests use signed JWT auth. */
import { strict as assert } from 'node:assert';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { receiveWork, attachWorkEntity } from '@finnor/db';
import { createUpstreamFixtureSupport } from '../s5/owner-fixture.mjs';
import { POST as s3Post } from '../../apps/api/app/api/interventions/[operation]/route';
import { POST as s4Post } from '../../apps/api/app/api/policies/[operation]/route';
import { POST as s5Post } from '../../apps/api/app/api/allocations/[operation]/route';
import { POST as s6Post } from '../../apps/api/app/api/obligations/[operation]/route';
import { canonical, hash, bytesHash } from '../../packages/private-equity/src/branch-fabric/contracts';

export const ownerHandlers: Record<string, typeof s5Post> = {
  interventions: s3Post, policies: s4Post, allocations: s5Post, obligations: s6Post,
};
interface Support {
  root: string; output: string; admin: any; other: any; token: (email: string, principal: string) => string;
  apiOrigin: string; save: (path: string, value: unknown) => Promise<void>;
  challenge: (id: string, steps: string[], expected: string, fn: () => Promise<unknown>) => Promise<void>;
  api: (f: any, operation: string, body: unknown) => Promise<any>;
  prepared: (f: any, source: any, kind?: string) => Promise<any>;
  run: (f: any, prepared: any, hooks?: any, mode?: string) => Promise<any>;
  sqlState: (f: any, id: string) => Promise<any>;
}
const successful = (r: any) => { assert.equal(r.status, 200, JSON.stringify(r)); return r.body; };
const publicPem = (k: any) => k.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privatePem = (k: any) => k.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

export async function ownerChallenges(s: Support) {
  process.env.FINNOR_S3_PYTHON ??= join(s.root, '.runtime/s3-python/bin/python');
  process.env.FINNOR_S3_MODEL_STORE = join(s.output, 'ordinary-owner-s3-store');
  process.env.FINNOR_S4_POLICY_STORE = join(s.output, 'ordinary-owner-s4-store');
  const generated = spawnSync('/usr/bin/python3', [join(s.root, 'finnor-os/scripts/s3/reference.py')], {
    input: '{"operation":"equivalent"}', encoding: 'utf8', timeout: 5000,
  });
  assert.equal(generated.status, 0, generated.stderr);
  const day = 86400000, begin = new Date(Math.floor(Date.now() / day) * day - 128 * day).toISOString();
  const ownerCalls: any[] = [];
  async function ownerApi(f: any, operation: string, body: unknown, handler = s5Post) {
    const domain = Object.keys(ownerHandlers).find(k => ownerHandlers[k] === handler);
    assert(domain);
    const r = await fetch(s.apiOrigin + `/api/${domain}/${operation}`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + s.token(`${f.name}@s5.example.test`, f.principal) },
      body: JSON.stringify(body),
    });
    const result = { status: r.status, body: await r.json() };
    ownerCalls.push({ domain, operation, tenantId: f.tenant, principalId: f.principal, request: body, response: result });
    await s.save(`owners/calls/${String(ownerCalls.length).padStart(4, '0')}.json`, ownerCalls.at(-1));
    return result;
  }
  const support = createUpstreamFixtureSupport({
    admin: () => s.admin, generatedRows: JSON.parse(generated.stdout).rows, begin, day, fixtures: {},
    api: ownerApi, artifact: (name: string, body: unknown) => s.save('owners/' + name, body),
  });
  async function fundedFixture(label: string, policies: Array<{ id: string; cash: number; value: string }>) {
    const f = await support.fixture(label + '-' + randomUUID().slice(0, 8), 2, [{ id: 'cash', unit: 'USD', capacity: 100, totalLimit: 100 }]);
    for (const p of policies) await support.policy(f, p.id, { cash: p.cash });
    await support.resource(f, 'cash', 'USD', 'STOCK', ['100', '100', '100']);
    const allocation = successful(await ownerApi(f, 'clear', support.clearing(f, Object.fromEntries(policies.map(p => [p.id, [p.value]])))));
    assert.equal(allocation.status, 'FEASIBLE', JSON.stringify(allocation));
    const work = await receiveWork({ tenantId: f.tenant, userId: f.principal, instruction: 'Rehearse actual issued owner objects, without live authority', channel: 'text', idempotencyKey: randomUUID() });
    const branchOwner = { ctx: f.ctx.auth, rootId: f.root.entityId, workId: work.workId, email: `${f.name}@s5.example.test`, token: s.token(`${f.name}@s5.example.test`, f.principal) };
    return { f, allocation, branchOwner };
  }
  await s.challenge('L2-authentic-S5-certificate-currentness', [
    'Actual unchanged S1/S3/S4/S5 fixture owners through signed HTTP auth',
    'Actual Work intake bound through immutable branch inputs, no unsupported S1 graph completeness claim', 'Real queue/native finite allocation and separate certificate process',
    'Actual S5 resource revision and foreign read',
  ], 'Exact issued optimum with complete subset certificate; computation only, no funding; revised resource refuses historical current consumption', async () => {
    const { f, allocation, branchOwner } = await fundedFixture('p3-s5', [{ id: 'A', cash: 60, value: '34' }, { id: 'B', cash: 60, value: '32' }]);
    const cut = await s.prepared(branchOwner, { kind: 'allocation', allocationRef: allocation.certificate.ref });
    const one = await s.run(branchOwner, cut);
    assert.equal(one.branch.status, 'COMPLETE', JSON.stringify(one.branch));
    assert.equal(one.branch.result.evidenceClass, 'COMPUTATION');
    assert.equal(one.branch.result.check.complete, true);
    assert.equal(one.branch.result.result.objective, '34');
    assert.deepEqual(one.branch.result.result.selectedPolicyIds, [f.policies[0].ref.id]);
    assert.equal(one.branch.result.accepted, false); assert.equal(one.branch.result.funding, null);
    const before = await s.sqlState(branchOwner, one.s.branchId);
    assert.equal((await s.api(s.other, 'read', { branchId: one.s.branchId })).status, 404);
    const issued = successful(await ownerApi(f, 'read', { allocationRef: allocation.certificate.ref }));
    const { ref, revision: _revision, priorRef: _priorRef, ...resource } = issued.problem.resources[0];
    const revised = successful(await ownerApi(f, 'resource', { resource: { ...resource, knowledgeAt: new Date().toISOString() }, expectedRef: ref }));
    const refused = await s.api(branchOwner, 'read', { branchId: one.s.branchId }); assert(refused.status >= 400);
    const after = await s.sqlState(branchOwner, one.s.branchId);
    assert.equal(after.head.status, 'INVALIDATED'); assert.equal(after.head.result_id, before.head.result_id);
    assert.deepEqual(after.artifacts.filter((r: any) => r.category === 'RESULT'), before.artifacts.filter((r: any) => r.category === 'RESULT'));
    const linkControl = await fundedFixture('p3-s5-link', [{ id: 'A', cash: 60, value: '34' }]);
    const beforeLink = await s.prepared(linkControl.branchOwner, { kind: 'allocation', allocationRef: linkControl.allocation.certificate.ref });
    await attachWorkEntity(linkControl.f.tenant, linkControl.branchOwner.workId, { entityType: linkControl.f.root.entityType, entityId: linkControl.f.root.entityId, relationship: 'about', source: 'p3:currentness-link-probe' });
    const linkRefusal = await s.api(linkControl.branchOwner, 'prepare', { workId: linkControl.branchOwner.workId, root: linkControl.f.root, kind: 'pure', profile: 'TRUSTED_NATIVE_H0', source: { kind: 'allocation', allocationRef: linkControl.allocation.certificate.ref } });
    assert.equal(linkRefusal.status, 409); assert.equal(linkRefusal.body.code, 'S5_INPUT_NOT_CURRENT');
    return { allocation, cut, one, revised, refused, before, after, beforeLink, linkRefusal, linkGuard: 'CURRENT_S5_BELIEF_VECTOR_CHANGED_BY_WORK_LINK_NOT_A_SEPARATE_COVERAGE_PROOF', checkerPrimitive: 'DECLARED_SHARED_ORIGINAL_FEASIBILITY_PLUS_SEPARATE_COMPLETE_SUBSET_CERTIFICATE', protectedFunding: false };
  });
  await s.challenge('N-authentic-signed-S6-historical-read', [
    'Actual S3/S4/S5 handoff and S6 durable obligation', 'Separate real signed ExperienceLedger process with exact source/native/runtime pins',
    'Signed scoped owner transport and reviewed read-execution-handoff', 'Two real branches retain one historical capture',
    'Foreign/reflected target and changed transport pins refuse',
  ], 'Bounded signed history projection only, no provider dispatch; native replay does not reacquire broker observation', async () => {
    const { f, allocation, branchOwner } = await fundedFixture('p3-s6', [{ id: 'price', cash: 25, value: '100' }]);
    const handoff = successful(await ownerApi(f, 'handoff', {
      policyRef: f.policies[0].ref, allocationRef: allocation.certificate.ref,
      decision: support.decision(f, allocation.certificate.ref),
    }, s4Post));
    const obligation = successful(await ownerApi(f, 'prepare', {
      preparationRef: handoff.preparationRef, allocationRef: handoff.allocationRef, consumptionRef: handoff.consumptionRef,
    }, s6Post));
    assert.equal(obligation.executionAuthorityGranted, false); assert.equal(obligation.protectedReceipt, null);
    const ledger = await signedHistoryLedger(s, f, obligation);
    try {
      const cut = await s.prepared(branchOwner, { kind: 's6_read', obligationRef: obligation.ref }, 'live_read');
      const captured = await readFile(ledger.journalPath, 'utf8'), one = await s.run(branchOwner, cut);
      assert.equal(one.branch.status, 'COMPLETE', JSON.stringify(one.branch));
      const two = await s.run(branchOwner, cut, {}, 'CLEAN_WARM_IMAGE');
      assert.equal(two.branch.status, 'COMPLETE');
      assert.deepEqual(two.branch.result.result, one.branch.result.result);
      assert.equal(one.branch.result.evidenceClass, 'REVIEWED_OBSERVATION');
      const observation = one.branch.result.result;
      assert.equal(observation.projection, 'HISTORICAL_SIGNED_S6_HISTORY_NOT_NEW_PROVIDER_OBSERVATION');
      assert.equal(observation.replayDispatchesExternalRequest, false);
      assert.deepEqual(observation.attempts, []); assert.deepEqual(observation.settlements, []);
      assert.equal(await readFile(ledger.journalPath, 'utf8'), captured, 'P3 read or replay appended protected execution history');
      assert.equal((await s.api(s.other, 'read', { branchId: one.s.branchId })).status, 404);
      await ledger.changeRoute();
      const refused = await s.api(branchOwner, 'read', { branchId: one.s.branchId }); assert(refused.status >= 400);
      const after = await s.sqlState(branchOwner, one.s.branchId); assert.equal(after.head.status, 'INVALIDATED');
      return { allocation, handoff, obligation, cut, one, two, refused, sourcePins: ledger.publicPins,
        qualification: 'REAL_SIGNED_S6_HISTORY_NO_PROVIDER_DISPATCH_NO_PRODUCTION_LIVE_ADMISSION', externalProviderCalls: 0 };
    } finally { await ledger.stop(); }
  });
}

async function signedHistoryLedger(s: Support, f: any, obligation: any) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'finnor-p3-s6-history-')));
  const ledgerKey = generateKeyPairSync('ed25519'), methodKey = generateKeyPairSync('ed25519'), reviewer = generateKeyPairSync('ed25519'), originKey = generateKeyPairSync('ed25519');
  const credential = randomUUID() + randomUUID();
  const privateFile = async (name: string, bytes: string) => {
    const path = join(directory, name); await writeFile(path, bytes, { mode: 0o600 }); return path;
  };
  const fsExt = dirname(createRequire(import.meta.url).resolve('fs-ext/package.json'));
  const sourcePaths = ['ledger.ts', 'ledger-server.mts', 'protocol.ts', 'request-verifier.ts', 'adapter-contract.ts', 'dispatch-broker.ts', 'broker-io.ts']
    .map(name => join(s.root, 'finnor-os/packages/governed-execution/src', name));
  sourcePaths.push(join(fsExt, 'fs-ext.js'), join(fsExt, 'build/Release/fs_ext.node'), join(fsExt, 'package.json'));
  const sourceDigests = await Promise.all(sourcePaths.map(async path => ({ path, sha256: bytesHash(await readFile(path)) })));
  const policy = { schema: 'finnor.s6.ledger-policy.v1', domain: 'DISPOSABLE_TEST_AUTHORITY', signerPublicKey: publicPem(ledgerKey),
    methodAdmissionPublicKey: publicPem(methodKey), maxEntries: 10000, owners: [{
      owner: 'S6', tenantId: f.tenant, principalId: f.principal, rightsRefs: [obligation.rightsRef], tokenHash: bytesHash(credential),
      append: true, read: true, sealedAppend: false, sealedRead: false, protectedExecution: false, dispatch: false,
    }] };
  const release = { schema: 'finnor.s6.ledger-release.v3', releaseId: 'p3-read-only-disposable-history', sourceDigests,
    runtime: { node: process.version, nodeAbi: process.versions.modules, platform: process.platform, arch: process.arch },
    policyDigest: hash(policy), validUntil: new Date(Date.now() + 3600000).toISOString() };
  const configPath = await privateFile('ledger.json', JSON.stringify({
    policy, release: { ...release, signature: sign(null, Buffer.from(canonical(release)), reviewer.privateKey).toString('base64') },
    signerPath: await privateFile('ledger.pem', privatePem(ledgerKey)), protectedDirectory: join(directory, 'protected'), contentDirectory: join(directory, 'ordinary'), port: 0,
  }));
  const child: ChildProcess = spawn(process.execPath, ['--import=tsx', join(s.root, 'finnor-os/packages/governed-execution/src/ledger-server.mts')], {
    cwd: join(s.root, 'finnor-os'), env: { PATH: process.env.PATH, HOME: directory, FINNOR_S6_LEDGER_CONFIG: configPath, FINNOR_S6_LEDGER_RELEASE_ROOT: publicPem(reviewer) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  const old = { FINNOR_S6_OWNER_TRANSPORT_CONFIG: process.env.FINNOR_S6_OWNER_TRANSPORT_CONFIG, FINNOR_S6_OWNER_TRANSPORT_ROOT: process.env.FINNOR_S6_OWNER_TRANSPORT_ROOT };
  const stop = async () => {
    for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>(ok => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.once('exit', () => { clearTimeout(timer); ok(); }); child.kill('SIGTERM');
    });
    await s.save('owners/s6-process-after.json', { pid: child.pid, exitCode: child.exitCode, signal: child.signalCode, sourceDigests, runtime: release.runtime, stdout, stderr, observedStopped: child.exitCode !== null || child.signalCode !== null });
  };
  try {
  const base = await new Promise<string>((ok, no) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); no(Error('P3_S6_LEDGER_BOOT_DEADLINE')); }, 15000);
    child.stdout!.on('data', b => {
      stdout += b;
      if (stdout.length >= 65536) { child.kill('SIGTERM'); no(Error('P3_S6_LEDGER_BOOT_OUTPUT_BOUND')); return; }
      for (const line of stdout.split('\n')) try {
        const r = JSON.parse(line);
        if (r.status === 'READY' && Number.isInteger(r.port)) { clearTimeout(timer); ok(`http://127.0.0.1:${r.port}`); }
      } catch {}
    });
    child.stderr!.on('data', b => { stderr += b; if (stderr.length >= 65536) { child.kill('SIGTERM'); no(Error('P3_S6_LEDGER_BOOT_OUTPUT_BOUND')); } });
    child.once('error', no); child.once('exit', code => { clearTimeout(timer); no(Error('P3_S6_LEDGER_EARLY_EXIT:' + code + ':' + stderr)); });
  });
  const tokenPath = await privateFile('read.token', credential);
  const route = { semanticOwner: 'S6', tenantId: f.tenant, principalId: f.principal, purpose: 'OWNER', rightsRefs: [obligation.rightsRef],
    originKeys: [{ id: 'disposable-origin', publicKey: publicPem(originKey), validAfter: new Date(Date.now() - 1000).toISOString(), validUntil: release.validUntil, revoked: false }],
    tokenPath, tokenSha256: bytesHash(credential), ledger: { endpoint: base, acceptedReceipts: [{
      signerPublicKey: publicPem(ledgerKey), releaseId: release.releaseId, verifierDigest: hash(sourceDigests), policyDigest: hash(policy),
    }] }, requestTimeoutMs: 10000, leaseMs: 30000 };
  async function transport() {
    const body = { schema: 'finnor.s6.owner-transport-policy.v1', domain: 'DISPOSABLE_TEST_AUTHORITY',
      validAfter: new Date(Date.now() - 1000).toISOString(), validUntil: release.validUntil, routes: [route] };
    process.env.FINNOR_S6_OWNER_TRANSPORT_CONFIG = await privateFile('transport.json', JSON.stringify({ policy: body, signature: sign(null, Buffer.from(canonical(body)), reviewer.privateKey).toString('base64') }));
    process.env.FINNOR_S6_OWNER_TRANSPORT_ROOT = publicPem(reviewer);
  }
  const { ref, ...content } = obligation;
  const registered = await fetch(base + '/references', { method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'content-type': 'application/json', authorization: 'Bearer ' + credential },
    body: JSON.stringify({ reference: { ...ref, content }, rightsRefs: [obligation.rightsRef] }) });
  assert.equal(registered.status, 200, JSON.stringify(await registered.clone().json()));
  const commitment = await registered.json(); await transport();
  const publicPins = { policy, release, commitment, publicAuthorities: { ledger: publicPem(ledgerKey), reviewer: publicPem(reviewer), origin: publicPem(originKey) } };
  await s.save('owners/s6-public-release.json', publicPins);
  return {
    publicPins, journalPath: join(directory, 'protected/commitments.jsonl'),
    changeRoute: async () => { route.originKeys[0]!.revoked = true; await transport(); },
    stop,
  };
  } catch (e) { await stop(); throw e; }
}
