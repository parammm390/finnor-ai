/** Disposable S6 governed-dispatch fixtures for the Z5 native session: a loopback TLS provider with a conditional
 * JSON record contract, the native-owner authority endpoint the protected broker calls, and the S6 owner-route
 * sequence (compile, schedule-free direct execute with a lost response, later independent reconcile and S5 settle).
 * Adapted from scripts/s6/governed-dispatch-proof.mts. Everything here is a disposable test authority: nothing
 * grants protected admission, production activation or a real provider effect. */
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer as httpServer, type Server } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonical } from '../../../packages/governed-execution/src/protocol';

const bytesHash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const hash = (v: unknown) => bytesHash(canonical(v));
const publicPem = (k: any) => k.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privatePem = (k: any) => k.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const listen = (server: Server) => new Promise<number>(done => server.listen(0, '127.0.0.1', () => done((server.address() as any).port)));
const shut = (server: Server) => new Promise<void>(done => { (server as any).closeAllConnections?.(); server.close(() => done()); });

export type OwnerCall = (path: string, body: unknown) => Promise<{ status: number; body: any }>;
export const DISPATCH_MAPPING = { field: 'priceAdjustmentFraction', recordPrefix: 'price', dose: 0.15, operation: 'PRICE_CHANGE', unit: 'fraction' } as const;

export async function startDispatchFixtures(directory: string, ownerCall: () => OwnerCall) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = async (name: string, value: string) => { const path = join(directory, name); await writeFile(path, value, { mode: 0o600 }); return path; };
  const businessKey = generateKeyPairSync('ed25519'), methodKey = generateKeyPairSync('ed25519');
  const providerToken = randomUUID() + randomUUID(), authorityToken = randomUUID() + randomUUID();
  const certificate = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'tls.key'),
    '-out', join(directory, 'tls.crt'), '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { encoding: 'utf8' });
  if (certificate.status !== 0) throw Error('Z5_DISPATCH_TLS_FIXTURE_FAILED:' + String(certificate.stderr).slice(0, 200));
  await chmod(join(directory, 'tls.key'), 0o600); await chmod(join(directory, 'tls.crt'), 0o600);
  const ca = await readFile(join(directory, 'tls.crt'), 'utf8'), account = randomUUID();
  const records = new Map<string, any>(), requests: any[] = [], authorityCalls: any[] = [];
  const behaviour = { lostResponse: true, readFault: 'NONE' as 'NONE' | 'WRONG_RECORD' | 'NULL' };
  const provider = httpsServer({ key: await readFile(join(directory, 'tls.key')), cert: ca }, async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push({ method: req.method, url: req.url, authorizationMatched: req.headers.authorization === 'Bearer ' + providerToken,
      ifMatch: req.headers['if-match'], body: raw ? JSON.parse(raw) : null, readFault: behaviour.readFault, at: new Date().toISOString() });
    const key = [...records.keys()].find(k => req.url === `/accounts/${account}/records/${encodeURIComponent(k)}`);
    let record = key ? records.get(key) : null;
    if (req.headers.authorization !== 'Bearer ' + providerToken || !record) { res.writeHead(403); res.end('{}'); return; }
    if (req.method === 'PATCH') {
      if (req.headers['if-match'] !== record.version) { res.writeHead(412); res.end('{}'); return; }
      const input = JSON.parse(raw);
      if (JSON.stringify(Object.keys(input).sort()) !== '["changes","operationId"]' || JSON.stringify(input.changes) !== JSON.stringify({ [DISPATCH_MAPPING.field]: DISPATCH_MAPPING.dose })) {
        res.writeHead(400); res.end('{}'); return;
      }
      record = { ...record, version: '"v2"', fields: { ...record.fields, ...input.changes }, lastOperationId: input.operationId };
      records.set(key!, record);
      // The response is lost after the provider applied the change: the caller can only learn the outcome by an independent read.
      if (behaviour.lostResponse) { req.socket.destroy(); return; }
    }
    let value: any = record;
    if (req.method === 'GET' && behaviour.readFault === 'WRONG_RECORD') value = { ...record, recordKey: 'unrelated-record' };
    if (req.method === 'GET' && behaviour.readFault === 'NULL') value = { ...record, fields: { [DISPATCH_MAPPING.field]: null } };
    res.writeHead(200, { 'content-type': 'application/json', etag: record.version, 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  });
  const providerPort = await listen(provider as unknown as Server);
  const authority = httpServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw), operation = req.url?.split('/').at(-1), call: any = { input, operation, at: new Date().toISOString() };
    authorityCalls.push(call);
    if (req.headers.authorization !== 'Bearer ' + authorityToken) { res.writeHead(401); res.end('{}'); return; }
    if (!['check-dispatch', 'check-budget'].includes(operation ?? '')) { res.writeHead(404); res.end('{}'); return; }
    // The native owner answers through its real authenticated HTTP route; the signature is the API process's own.
    const answer = await ownerCall()('/api/obligations/' + operation, input);
    call.assessment = answer.body;
    res.writeHead(answer.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(answer.body));
  });
  const authorityPort = await listen(authority);
  const providerOrigin = `https://127.0.0.1:${providerPort}`;
  const providerTokenPath = await file('provider.token', providerToken), authorityTokenPath = await file('authority.token', authorityToken);
  return {
    account, records, requests, authorityCalls, behaviour, businessKey, methodKey, providerOrigin,
    allow(keys: string[]) { for (const key of keys) records.set(key, { applicationAccountId: account, recordKey: key, version: '"v1"', fields: { [DISPATCH_MAPPING.field]: 0 }, lastOperationId: null }); },
    ledgerOptions: {
      ownerPublicKeyPem: '', businessPublicKeyPem: publicPem(businessKey), methodPublicKeyPem: publicPem(methodKey),
      authority: { endpoint: `http://127.0.0.1:${authorityPort}`, tokenPath: authorityTokenPath, tokenSha256: bytesHash(authorityToken) },
      provider: { origin: providerOrigin, applicationAccountId: account, tokenPath: providerTokenPath, tokenSha256: bytesHash(providerToken),
        caPath: join(directory, 'tls.crt'), caSha256: bytesHash(ca) },
    },
    async close() { await shut(provider as unknown as Server); await shut(authority); },
  };
}

/** Compile, admit and execute one prepared S6 obligation through the owner routes. The provider applies the change and
 * loses the response, so S6 records UNKNOWN_OUTCOME and the S5 reservation stays liable; nothing is reconciled here. */
export async function dispatchToUnknown(fixtures: Awaited<ReturnType<typeof startDispatchFixtures>>, obligation: any, rootEntityId: string,
  call: OwnerCall, releaseValidUntil: string, sourceDigests: { path: string; sha256: string }[]) {
  const mapping = DISPATCH_MAPPING, ref = obligation.ref, channels = obligation.intervention.channels;
  for (const channel of channels) {
    if (channel.doses[0] !== mapping.dose || channel.operation !== mapping.operation || channel.unit !== mapping.unit) throw Error('Z5_DISPATCH_OBLIGATION_CHANNEL_OUTSIDE_DISPOSABLE_CONTRACT');
  }
  const recordKeys: string[] = channels.map((channel: any, index: number) => index === 0 ? mapping.recordPrefix + '/' + rootEntityId : channel.exposureId + '/' + rootEntityId);
  fixtures.allow(recordKeys);
  const origin = fixtures.providerOrigin, account = fixtures.account;
  const bindings = channels.map((channel: any, index: number) => ({ exposureId: channel.exposureId,
    methodRef: { owner: 'S8', id: 'method:' + '1'.repeat(64), version: 'json-field-replace-v1', contentDigest: '1'.repeat(64) },
    providerOrigin: origin, applicationAccountId: account, recordKey: recordKeys[index], field: mapping.field, expectedVersion: '"v1"' }));
  const proposed = await call('/api/obligations/compile-request', { obligationRef: ref, bindings });
  if (proposed.status !== 200) throw Error('Z5_DISPATCH_COMPILE_PROPOSAL_' + proposed.status + ':' + JSON.stringify(proposed.body).slice(0, 300));
  const admissions = channels.map((channel: any, index: number) => {
    const body = { schema: 'finnor.s8.method-admission.v1', domain: 'DISPOSABLE_TEST_AUTHORITY', tenantId: obligation.tenantId, principalId: obligation.principalId,
      rightsRef: obligation.rightsRef, obligationRef: ref, effectRef: obligation.effectRef, compiler: proposed.body.ir.compiler,
      verifierSourceDigests: sourceDigests, validAfter: new Date(Date.now() - 1000).toISOString(), validUntil: releaseValidUntil,
      semantic: { exposureId: channel.exposureId, target: channel.target, operation: channel.operation, unit: channel.unit, intendedExposure: channel.intendedExposure, permittedRefinements: [], doseRange: [-1, 1] },
      request: { kind: 'CONDITIONAL_JSON_FIELDS_REPLACE', providerOrigin: origin, applicationAccountId: account, recordKey: recordKeys[index], field: mapping.field, expectedVersion: '"v1"' },
      qualification: 'DISPOSABLE_MAPPING_ONLY' };
    const methodRef = { owner: 'S8', id: 'method:' + hash(body), version: 'json-field-replace-v1', contentDigest: hash(body) };
    bindings[index].methodRef = methodRef;
    return { ref: methodRef, body, signature: sign(null, Buffer.from(canonical(body)), fixtures.methodKey.privateKey).toString('base64') };
  });
  const compiled = await call('/api/obligations/compile-request', { obligationRef: ref, bindings });
  if (compiled.status !== 200) throw Error('Z5_DISPATCH_COMPILE_' + compiled.status + ':' + JSON.stringify(compiled.body).slice(0, 300));
  const request = { ref: compiled.body.ref, ir: compiled.body.ir, admissions };
  const grantBody = { schema: 'finnor.business-owner.effect-authorization.v1', domain: 'DISPOSABLE_TEST_AUTHORITY', tenantId: obligation.tenantId,
    principalId: obligation.principalId, rightsRef: obligation.rightsRef, obligationRef: ref, requestRef: request.ref, effectRef: obligation.effectRef,
    mandateRef: obligation.mandateRef, allocationRef: obligation.allocationRef, consumptionRef: obligation.consumptionRef,
    resourceEnvelope: obligation.resourceEnvelope, validAfter: new Date(Date.now() - 1000).toISOString(), validUntil: releaseValidUntil };
  const input = { request, authorization: { body: grantBody, signature: sign(null, Buffer.from(canonical(grantBody)), fixtures.businessKey.privateKey).toString('base64') } };
  fixtures.behaviour.lostResponse = true; fixtures.behaviour.readFault = 'NONE';
  const accepted = await call('/api/obligations/execute-request', input);
  if (accepted.status !== 200 || accepted.body.status !== 'UNRESOLVED') throw Error('Z5_DISPATCH_EXECUTE_NOT_UNRESOLVED_' + accepted.status + ':' + JSON.stringify(accepted.body).slice(0, 300));
  if (fixtures.requests.filter(r => r.method === 'PATCH').length !== 1) throw Error('Z5_DISPATCH_PROVIDER_PATCH_COUNT');
  return { input, accepted, recordKeys };
}

/** The delayed independent callback: a read-only provider reconciliation (no second PATCH), then the S5 owner's own settlement. */
export async function reconcileAndSettle(fixtures: Awaited<ReturnType<typeof startDispatchFixtures>>, dispatched: { input: any }, obligation: any, call: OwnerCall) {
  fixtures.behaviour.lostResponse = false; fixtures.behaviour.readFault = 'NONE';
  const patchesBefore = fixtures.requests.filter(r => r.method === 'PATCH').length;
  const recovered = await call('/api/obligations/reconcile-request', dispatched.input);
  if (recovered.status !== 200 || recovered.body.status !== 'VERIFIED') throw Error('Z5_DISPATCH_RECONCILE_NOT_VERIFIED_' + recovered.status + ':' + JSON.stringify(recovered.body).slice(0, 300));
  if (fixtures.requests.filter(r => r.method === 'PATCH').length !== patchesBefore) throw Error('Z5_DISPATCH_RECONCILE_REPLAYED_THE_MUTATION');
  const settled = await call('/api/allocations/settle', { allocationRef: obligation.allocationRef, consumptionRef: obligation.consumptionRef,
    settlementEventId: recovered.body.receipt.identity });
  if (settled.status !== 200 || settled.body.consumption?.status !== 'RECONCILED' || settled.body.releaseGranted !== false)
    throw Error('Z5_DISPATCH_SETTLE_' + settled.status + ':' + JSON.stringify(settled.body).slice(0, 300));
  return { recovered, settled };
}

export { publicPem, privatePem, bytesHash, hash };
