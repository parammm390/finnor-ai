import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';

const Root = z.object({ entityType: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/), entityId: z.string().uuid() }).strict();
const Identity = z.object({ userId: z.string().uuid(), tenantId: z.string().uuid() });
const Roots = z.object({ results: z.array(z.object({ rootRefs: z.array(Root) })).max(50) });
const outputAt = process.argv.indexOf('--out');
const output = resolve(outputAt >= 0 ? process.argv[outputAt + 1] ?? '' : process.env.TENANT_ISOLATION_EVIDENCE_DIR ?? 'tenant-isolation-evidence');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing tenant probe configuration: ${name}`);
  return value;
};

async function main(): Promise<void> {
  await mkdir(output, { recursive: true });
  const environments: { name: string; status: 'PASS' | 'FAIL'; observed?: unknown; error?: string }[] = [];
  for (const name of ['staging', 'production'] as const) {
    try {
      const base = new URL(required(name.toUpperCase() + '_API_URL'));
      const loopback = process.env.FINNOR_TENANT_PROBE_ALLOW_LOOPBACK === '1' && process.env.NODE_ENV === 'test' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
      if ((base.protocol !== 'https:' && !loopback) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('Probe requires an HTTPS API origin, or an explicit disposable loopback origin');
      const marker = Root.parse(JSON.parse(required(name.toUpperCase() + '_TENANT_A_MARKER_ROOT_REF')));
      const tokenA = required('TENANT_A_PROBE_JWT'), tokenB = required('TENANT_B_PROBE_JWT');
      if (tokenA === tokenB) throw new Error('Tenant probe identities must be different');
      const request = async (path: string, token: string, body?: unknown) => {
        const response = await fetch(new URL(path, base), { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET ? { 'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        if (!response.ok) { await response.body?.cancel(); throw new Error(`${path} returned HTTP ${response.status}`); }
        const text = await response.text();
        if (Buffer.byteLength(text) > 65_536) throw new Error('Tenant probe response exceeded its byte budget');
        return JSON.parse(text) as unknown;
      };
      const [identityA, identityB] = await Promise.all([request('/api/me', tokenA).then(value => Identity.parse(value)), request('/api/me', tokenB).then(value => Identity.parse(value))]);
      if (identityA.tenantId === identityB.tenantId) throw new Error('Probe JWTs resolved to the same tenant');
      const body = { query: marker.entityId, limit: 1 };
      const [a, b] = await Promise.all([request('/api/company-brain/roots', tokenA, body).then(value => Roots.parse(value)), request('/api/company-brain/roots', tokenB, body).then(value => Roots.parse(value))]);
      const containsMarker = (rows: z.infer<typeof Roots>) => rows.results.some(row => row.rootRefs.some(ref => ref.entityType === marker.entityType && ref.entityId === marker.entityId));
      if (!containsMarker(a)) throw new Error('Tenant A positive-control marker is not visible to tenant A');
      if (containsMarker(b)) throw new Error('Tenant A marker is visible to tenant B');
      environments.push({ name, status: 'PASS', observed: { distinctAuthenticatedTenants: true, tenantAHash: hash(identityA.tenantId), tenantBHash: hash(identityB.tenantId), markerHash: hash(JSON.stringify(marker)), markerVisibleToA: true, markerVisibleToB: false } });
    } catch (error) { environments.push({ name, status: 'FAIL', error: error instanceof Error ? error.message : 'Unknown probe failure' }); }
  }
  const status = environments.length === 2 && environments.every(environment => environment.status === 'PASS') ? 'PASS' : 'FAIL';
  await writeFile(resolve(output, 'tenant-isolation.json'), JSON.stringify({ schema: 'finnor.tenant-isolation-probe.v1', generatedAt: new Date().toISOString(), status, environments,
    qualification: 'Read-only authenticated identity and exact known-marker visibility checks for both configured environments. A finite marker challenge, not an exhaustive RLS certification.',
    rerun: 'Set the documented environment URLs, two JWTs, and an independently provisioned tenant-A PE marker root per environment, then run node --import=tsx scripts/probe-tenant-isolation.ts --out <directory>.' }, null, 2));
  console.log(JSON.stringify({ status, environments }));
  if (status !== 'PASS') process.exitCode = 1;
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Tenant probe failed'); process.exitCode = 1; });
