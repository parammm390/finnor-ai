import { strict as assert } from 'node:assert';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const output = resolve(process.env.FINNOR_CAPABILITY_EVIDENCE_DIR ?? '../docs/release/generated/nango-cold-webhook');
await mkdir(output, { recursive: true });
const sourcePaths = ['apps/api/app/api/webhooks/nango/route.ts', 'packages/security/src/secrets.ts', 'packages/orchestration/src/capabilities/nango-webhook.ts', 'packages/tools/src/nango.ts'];
const cut = () => Promise.all(sourcePaths.map(async path => ({ path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') })));
const before = await cut(), signingKey = randomUUID(), apiKey = randomUUID();
const cases: Array<{ id: string; status: 'PASS' | 'FAIL'; observed?: unknown; failure?: string }> = [];
let fetches = 0;
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
  assert.equal(request.headers['x-amz-target'], 'secretsmanager.GetSecretValue');
  const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.deepEqual(input, { SecretId: 'finnor-disposable-signing-key' }); fetches++;
  await new Promise(done => setTimeout(done, 50));
  response.writeHead(200, { 'content-type': 'application/x-amz-json-1.1' });
  response.end(JSON.stringify({ SecretString: JSON.stringify({ NANGO_WEBHOOK_SIGNING_KEY: signingKey }) }));
});
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const address = server.address(); assert(address && typeof address === 'object');
Object.assign(process.env, { NODE_ENV: 'production', SECRETS_PROVIDER: 'aws-secrets-manager',
  FINNOR_SECRET_IDS: JSON.stringify({ NANGO_WEBHOOK_SIGNING_KEY: 'finnor-disposable-signing-key' }),
  AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'disposable-fixture-access-id', AWS_SECRET_ACCESS_KEY: 'disposable-fixture-signing-secret',
  AWS_ENDPOINT_URL_SECRETS_MANAGER: `http://127.0.0.1:${address.port}`, AWS_EC2_METADATA_DISABLED: 'true', NANGO_API_KEY: apiKey });
for (const key of ['NANGO_WEBHOOK_SIGNING_KEY', 'AUTH_DEV_BYPASS', 'ALLOW_PLAINTEXT_ENV_SECRETS', 'AWS_SESSION_TOKEN']) delete process.env[key];
const { POST } = await import('../../apps/api/app/api/webhooks/nango/route');
const raw = JSON.stringify({ type: 'finnor-disposable-cold-bootstrap-probe', success: true });
const signature = createHmac('sha256', signingKey).update(raw).digest('hex');
function request(body: string, hmac: string) { return new Request('http://localhost/api/webhooks/nango', { method: 'POST', headers: { 'content-type': 'application/json', 'x-nango-hmac-sha256': hmac }, body }); }
async function check(id: string, operation: () => Promise<unknown>) {
  try { cases.push({ id, status: 'PASS', observed: await operation() }); }
  catch (error) { cases.push({ id, status: 'FAIL', failure: error instanceof Error ? error.name + ':' + error.message : 'UnknownError' }); }
}
try {
  await check('oversized-body-refused-before-managed-fetch', async () => {
    const response = await POST(request('x'.repeat(1_048_577), signature)); assert.equal(response.status, 413); assert.equal(fetches, 0);
    return { status: response.status, managedFetches: fetches };
  });
  await check('concurrent-cold-managed-key-callbacks', async () => {
    assert.equal(process.env.NANGO_WEBHOOK_SIGNING_KEY, undefined);
    const responses = await Promise.all([POST(request(raw, signature)), POST(request(raw, signature))]);
    assert.deepEqual(responses.map(response => response.status), [202, 202]); assert.equal(fetches, 1);
    for (const response of responses) assert.deepEqual(await response.json(), { accepted: true, ignored: true });
    return { statuses: responses.map(response => response.status), managedFetches: fetches, rawBodySha256: createHash('sha256').update(raw).digest('hex') };
  });
  await check('invalid-hmac-and-api-key-signature-remain-denied', async () => {
    const invalid = await POST(request(raw, '0'.repeat(64))), apiSigned = await POST(request(raw, createHmac('sha256', apiKey).update(raw).digest('hex')));
    assert.deepEqual([invalid.status, apiSigned.status], [403, 403]); assert.equal(fetches, 1);
    return { statuses: [invalid.status, apiSigned.status], distinctSigningKeyRequired: true };
  });
} finally { await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); }
const after = await cut(), sourcesUnchanged = JSON.stringify(before) === JSON.stringify(after);
const status = sourcesUnchanged && cases.every(item => item.status === 'PASS') ? 'PASS' : 'FAIL';
await writeFile(join(output, 'results.json'), JSON.stringify({ schema: 'finnor.nango-cold-webhook-e2e.v1', status, before, after, sourcesUnchanged, cases,
  qualification: 'ACTUAL_NEXT_HANDLER_MANAGED_BOOTSTRAP_AWS_SDK_HTTP_FIXTURE_LOCAL_ONLY_NO_LIVE_AWS_ACCESS',
  rerun: 'FINNOR_CAPABILITY_EVIDENCE_DIR=<fresh-private-dir> node --import=tsx scripts/release/run-nango-cold-webhook-e2e.mts' }, null, 2));
console.log(JSON.stringify({ status, cases: cases.map(({ id, status }) => ({ id, status })) })); process.exitCode = status === 'PASS' ? 0 : 1;
