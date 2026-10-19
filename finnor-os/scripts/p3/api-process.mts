/** Disposable application process; the parent owns the separate worker login. */
import { strict as assert } from 'node:assert';
import { closePool, getPool } from '@finnor/db';
import { assertDisposableDatabaseTarget } from '../../packages/db/production-target-guard';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.FINNOR_P3_DISPOSABLE_API, '1');
assert(process.send, 'P3_PRIVATE_IPC_REQUIRED');
assertDisposableDatabaseTarget(process.env.DATABASE_URL, 'P3 application process');
const role = (await getPool().query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
assert.equal(role.current_user, 'finnor_app');
assert.equal(role.rolsuper, false); assert.equal(role.rolbypassrls, false);
const settings = ['FINNOR_S3_PYTHON', 'FINNOR_S3_MODEL_STORE', 'FINNOR_S4_POLICY_STORE', 'FINNOR_M1_STORE',
  'FINNOR_S6_OWNER_TRANSPORT_CONFIG', 'FINNOR_S6_OWNER_TRANSPORT_ROOT'] as const;
// Resolve the current product routes, including the mounted Investigation reads.
// The caller cannot supply a module path or substitute an owner response.
const apiRoot = join(import.meta.dirname, '../../apps/api/app/api');
const routes: Array<{ file: string; parts: string[]; dynamic: number }> = [];
async function scan(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) await scan(file);
    else if (entry.name === 'route.ts') {
      const parts = relative(apiRoot, directory).split('/');
      routes.push({ file, parts, dynamic: parts.filter(part => part.startsWith('[')).length });
    }
  }
}
await scan(apiRoot); routes.sort((a, b) => a.dynamic - b.dynamic);
let inflight = 0, closing = false;
async function close() { if (closing && !inflight) { await closePool(); process.exit(0); } }
process.on('message', async (message: any) => {
  if (message?.kind === 'STOP') { closing = true; await close(); return; }
  const id = message?.id;
  inflight++;
  try {
    assert(!closing && Number.isSafeInteger(id));
    assert.equal(message.kind, 'REQUEST');
    assert(typeof message.body === 'string' && message.body.length <= 12 * 1024 * 1024);
    assert.deepEqual(Object.keys(message.settings).sort(), [...settings].sort());
    for (const key of settings) {
      const value = message.settings[key]; assert(value === null || typeof value === 'string');
      if (value === null) delete process.env[key]; else process.env[key] = value;
    }
    const url = new URL(message.url); assert.equal(url.hostname, '127.0.0.1');
    const parts = url.pathname.replace(/^\/api\//, '').split('/').map(decodeURIComponent);
    let matched: { file: string; params: Record<string, string | string[]> } | undefined;
    for (const route of routes) {
      const params: Record<string, string | string[]> = {}; let i = 0, valid = true;
      for (const part of route.parts) {
        if (part.startsWith('[...')) { params[part.slice(4, -1)] = parts.slice(i); i = parts.length; break; }
        if (i >= parts.length) { valid = false; break; }
        if (part.startsWith('[')) params[part.slice(1, -1)] = parts[i]!;
        else if (part !== parts[i]) { valid = false; break; }
        i++;
      }
      if (valid && i === parts.length) { matched = { file: route.file, params }; break; }
    }
    assert(matched, 'CURRENT_PRODUCT_ROUTE_REQUIRED');
    const handler = (await import(pathToFileURL(matched.file).href))[message.method];
    assert(typeof handler === 'function', 'CURRENT_PRODUCT_METHOD_REQUIRED');
    const request = new Request(url, { method: message.method, headers: message.headers,
      ...(!['GET', 'HEAD'].includes(message.method) ? { body: Buffer.from(message.body, 'base64') } : {}) });
    const response: Response = await handler(request, { params: Promise.resolve(matched.params) });
    const bytes = Buffer.from(await response.arrayBuffer()); assert(bytes.length <= 8 * 1024 * 1024);
    const headers: Record<string, string> = {}; response.headers.forEach((value, key) => { headers[key] = value; });
    process.send!({ id, kind: 'RESPONSE', status: response.status, headers, body: bytes.toString('base64') });
  } catch (error) { process.send!({ id, kind: 'ERROR', error: String(error), stack: (error as Error).stack }); }
  finally { inflight--; await close(); }
});
process.on('disconnect', () => { closing = true; void close(); });
process.send!({ kind: 'READY', pid: process.pid, role });
