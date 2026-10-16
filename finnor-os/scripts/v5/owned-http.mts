import { createServer, type Server } from 'node:http';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import type pg from 'pg';
/** Disposable cryptographic issuer and an HTTP host for the actual API modules.
 * This is development transport evidence, not hosted Supabase qualification. */
export async function ownedHttp(repo: string, admin: pg.Client) {
  const secret = randomBytes(32), sessions = new Map<string, string>();
  const traffic: Array<Record<string, unknown>> = [];
  let authOrigin = '';
  const issue = async (id: string, expiresIn = 3600) => {
    const user = (await admin.query('SELECT id,email FROM finnor_os.users WHERE id=$1', [id])).rows[0];
    if (!user) throw Error('INDEPENDENT_CANONICAL_TEST_IDENTITY_REQUIRED');
    let sessionId = sessions.get(id);
    if (!sessionId) sessions.set(id, sessionId = randomUUID());
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const input = encode({ alg: 'HS256', typ: 'JWT' }) + '.' + encode({ sub: id, email: user.email,
      session_id: sessionId, iat: now, exp: now + expiresIn, aud: 'authenticated', role: 'authenticated', iss: authOrigin + '/auth/v1' });
    return input + '.' + createHmac('sha256', secret).update(input).digest('base64url');
  };
  async function verify(token: string) {
    const [h, p, s] = token.split('.');
    if (!h || !p || !s) throw Error('INVALID_SIGNATURE');
    const expected = createHmac('sha256', secret).update(h + '.' + p).digest(), actual = Buffer.from(s, 'base64url');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw Error('INVALID_SIGNATURE');
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (claims.exp <= Date.now() / 1000 || claims.iss !== authOrigin + '/auth/v1') throw Error('EXPIRED_OR_FOREIGN');
    const user = (await admin.query('SELECT id,email FROM finnor_os.users WHERE id=$1', [claims.sub])).rows[0];
    if (!user || user.email !== claims.email) throw Error('FOREIGN_IDENTITY');
    return { id: user.id, email: user.email, aud: 'authenticated', role: 'authenticated',
      app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, created_at: new Date().toISOString() };
  }
  async function listen(server: Server) {
    await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
    const address = server.address(); if (!address || typeof address === 'string') throw Error('OWNED_LOOPBACK_REQUIRED');
    return 'http://127.0.0.1:' + address.port;
  }
  const auth = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'authorization,apikey,content-type,x-client-info,x-supabase-api-version');
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    try {
      if (req.method === 'OPTIONS') { res.end(); return; }
      if (req.url === '/auth/v1/user') {
        res.end(JSON.stringify(await verify(String(req.headers.authorization ?? '').replace(/^Bearer /, '')))); return;
      }
      if (req.url?.includes('logout')) { res.end('{}'); return; }
      if (req.url?.startsWith('/auth/v1/token')) {
        let text = ''; for await (const bytes of req) { text += bytes; if (text.length > 16384) throw Error('INPUT_LIMIT'); }
        const input = JSON.parse(text);
        const user = (await admin.query('SELECT id FROM finnor_os.users WHERE email=$1', [input.email])).rows[0];
        if (!user || input.password !== 'v5-disposable-browser') throw Error('INVALID_LOCAL_CREDENTIAL');
        const token = await issue(user.id);
        res.end(JSON.stringify({ access_token: token, token_type: 'bearer', expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'v5-local-refresh',
          user: await verify(token) })); return;
      }
      res.writeHead(404); res.end('{}');
    } catch { res.writeHead(401); res.end('{"msg":"Invalid JWT"}'); }
  });
  authOrigin = await listen(auth);
  Object.assign(process.env, { AUTH_DEV_BYPASS: '0', SUPABASE_URL: authOrigin, SUPABASE_SERVICE_ROLE_KEY: 'v5-disposable-auth',
    RATE_LIMIT_PER_MINUTE: '100000', RATE_LIMIT_IP_PER_MINUTE: '100000' });
  const root = join(repo, 'finnor-os/apps/api/app/api');
  const routes: Array<{ file: string; parts: string[] }> = [];
  async function scan(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) await scan(file);
      else if (entry.name === 'route.ts') routes.push({ file, parts: relative(root, directory).split('/') });
    }
  }
  await scan(root); routes.sort((a, b) => a.parts.filter(p => p.startsWith('[')).length - b.parts.filter(p => p.startsWith('[')).length);
  const api = createServer(async (req, res) => {
    const started = performance.now();
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1'), parts = url.pathname.replace(/^\/api\//, '').split('/');
      let match: { file: string; params: Record<string, unknown> } | undefined;
      for (const route of routes) {
        const params: Record<string, unknown> = {}; let i = 0, valid = true;
        for (const part of route.parts) {
          if (part.startsWith('[...')) { params[part.slice(4, -1)] = parts.slice(i); i = parts.length; break; }
          if (i >= parts.length) { valid = false; break; }
          if (part.startsWith('[')) params[part.slice(1, -1)] = parts[i];
          else if (part !== parts[i]) { valid = false; break; }
          i++;
        }
        if (valid && i === parts.length) { match = { file: route.file, params }; break; }
      }
      if (!match) { res.writeHead(404); res.end('{}'); return; }
      let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 2097152) throw Error('INPUT_LIMIT'); }
      const module = await import(pathToFileURL(match.file).href), handler = module[req.method ?? 'GET'];
      if (!handler) { res.writeHead(405); res.end('{}'); return; }
      const headers = new Headers(); for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
      const response: Response = await handler(new Request(url, { method: req.method, headers,
        ...(!['GET', 'HEAD'].includes(req.method ?? 'GET') ? { body } : {}) }), { params: Promise.resolve(match.params) });
      const resultHeaders: Record<string, string> = {}; response.headers.forEach((value, key) => { resultHeaders[key] = value; });
      res.writeHead(response.status, resultHeaders); res.end(Buffer.from(await response.arrayBuffer()));
      traffic.push({ path: url.pathname, method: req.method, status: response.status, elapsedMs: performance.now() - started, verifiedBearer: !!req.headers.authorization });
    } catch (error) {
      traffic.push({ path: req.url, status: 500, predicate: (error as Error).message });
      res.writeHead(500); res.end('{"error":"Owned route host failed"}');
    }
  });
  const origin = await listen(api);
  const call = async (principal: string, path: string, body?: unknown, options: { method?: string; invalid?: boolean; anonymous?: boolean; spoof?: string } = {}) => {
    const token = await issue(principal);
    const response = await fetch(origin + '/api/' + path, { method: options.method ?? 'POST',
      headers: { 'content-type': 'application/json', ...(options.anonymous ? {} : { authorization: 'Bearer ' + (options.invalid ? token.slice(0, -4) + 'bad!' : token) }),
        'x-user-id': options.spoof ?? principal, 'x-user-role': 'owner' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(65000) });
    return { status: response.status, body: await response.json() as any };
  };
  return { call, origin, authOrigin, issue, sessions, traffic, close: async () => {
    for (const server of [api, auth]) {
      server.closeAllConnections();
      await new Promise<void>(yes => server.close(() => yes()));
    }
  } };
}
