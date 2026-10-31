import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createNativeOwnerDatabase } from '../s7/native-owner-database.mjs';

const index = process.argv.indexOf('--out');
assert(index >= 0 && process.argv[index + 1], '--out required');
const output = resolve(process.argv[index + 1]!); await mkdir(output, { recursive: true });
const db = await createNativeOwnerDatabase();
const require = createRequire(resolve('apps/api/package.json'));
const { POST } = require('./app/api/company-brain/[operation]/route.ts');
const { GET } = require('./app/api/me/route.ts');
const a = { tenant: randomUUID(), actor: randomUUID(), marker: randomUUID() }, b = { tenant: randomUUID(), actor: randomUUID(), marker: randomUUID() };
let mode = 'valid';
const observations: unknown[] = [];
const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const query = incoming.url?.endsWith('/company-brain/roots');
    const actor = incoming.headers.authorization === 'Bearer FIXTURE_TENANT_B' && !(mode === 'leak' && query) ? b : a;
    const headers = new Headers({ 'x-tenant-id': actor.tenant, 'x-user-id': actor.actor, 'x-user-role': 'owner', 'content-type': 'application/json' });
    const request = new Request('http://127.0.0.1' + incoming.url, { method: incoming.method, headers, ...(incoming.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) });
    const response = query ? await POST(request, { params: Promise.resolve({ operation: 'roots' }) }) : await GET(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers)).end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { outgoing.writeHead(500).end(JSON.stringify({ driverError: String(error) })); }
});
try {
  await db.admin.query("SET app.test_vertical_mode='explicit'");
  for (const actor of [a, b]) {
    await db.admin.query("INSERT INTO finnor_os.tenants(id,name) VALUES($1,'Tenant probe fixture')", [actor.tenant]);
    await db.admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')", [actor.actor, actor.tenant, actor.actor + '@fixture.invalid']);
    await db.db.configureTenantVertical({ tenantId: actor.tenant, verticalKey: 'private_equity', expectedVersion: 0, createdBy: actor.actor, sourceSystem: 'tenant-probe:fixture' });
    await db.admin.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,'tenant-marker','Tenant probe marker','other')", [actor.marker, actor.tenant]);
  }
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  for (const selected of ['valid', 'leak', 'missing-marker']) {
    mode = selected;
    const caseOutput = resolve(output, selected);
    const marker = { entityType: 'external_organization', entityId: selected === 'missing-marker' ? randomUUID() : a.marker };
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'test', FINNOR_TENANT_PROBE_ALLOW_LOOPBACK: '1', STAGING_API_URL: base, PRODUCTION_API_URL: base,
      TENANT_A_PROBE_JWT: 'FIXTURE_TENANT_A', TENANT_B_PROBE_JWT: 'FIXTURE_TENANT_B', STAGING_TENANT_A_MARKER_ROOT_REF: JSON.stringify(marker), PRODUCTION_TENANT_A_MARKER_ROOT_REF: JSON.stringify(marker) };
    const child = spawn(process.execPath, ['--import=tsx', 'scripts/probe-tenant-isolation.ts', '--out', caseOutput], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
    const exitCode = await new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('close', done); });
    await writeFile(resolve(output, selected + '.log'), log);
    assert.equal(exitCode, selected === 'valid' ? 0 : 1, log);
    const result = JSON.parse(await readFile(resolve(caseOutput, 'tenant-isolation.json'), 'utf8'));
    assert.equal(result.status, selected === 'valid' ? 'PASS' : 'FAIL');
    observations.push({ selected, exitCode, status: result.status, environments: result.environments });
  }
} finally {
  server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
  await require('@finnor/db').closePool(); await db.stop();
  await writeFile(resolve(output, 'tenant-probe-e2e.json'), JSON.stringify({ observations, qualification: 'Real native Private Equity root and identity routes, actual PostgreSQL ordinary application role, actual CLI HTTP requests. Synthetic bearer-to-dev-header adapter; no live JWT or production data.', rerun: 'From finnor-os: node --import=tsx scripts/audits/verify-tenant-probe.mts --out <external directory>' }, null, 2));
}
assert.equal(observations.length, 3);
console.log(JSON.stringify({ output, observations }));
