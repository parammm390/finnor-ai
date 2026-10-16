/** Actual signed bearer/user lookup against a disposable local auth provider.
 * No auth bypass, production identity, live counterparty or token artifacts. */
import { createServer, type Server } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Session } from 'node:inspector';
import { appendFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type pg from 'pg';
type Handler = (request: Request, context: { params: Promise<any> }) => Promise<Response>;
export async function r3HttpFixture(admin: pg.Client) {
  const secret = randomBytes(32), users = new Map<string, { id: string; email: string }>();
  const observed: Array<Record<string, unknown>> = [], handlers: Record<string, Handler> = {};
  let authOrigin = '';
  function token(id: string) {
    const user = users.get(id); if (!user) throw Error('R3_REAL_AUTH_USER_REQUIRED');
    const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url'), now = Math.floor(Date.now() / 1000);
    const body = part({ alg: 'HS256', typ: 'JWT' }) + '.' + part({ sub: id, email: user.email, role: 'authenticated', aud: 'authenticated',
      iat: now, exp: now + 3600, iss: authOrigin + '/auth/v1' });
    return body + '.' + createHmac('sha256', secret).update(body).digest('base64url');
  }
  function verify(value: string) {
    const [h, p, s] = value.replace(/^Bearer /, '').split('.'); if (!h || !p || !s) throw Error('INVALID');
    const got = Buffer.from(s, 'base64url'), expected = createHmac('sha256', secret).update(h + '.' + p).digest();
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw Error('INVALID');
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString()), user = users.get(claims.sub);
    if (!user || claims.exp <= Date.now() / 1000) throw Error('INVALID'); return user;
  }
  const auth = createServer(async (req, res) => {
    observed.push({ boundary: 'DISPOSABLE_AUTH_HTTP', method: req.method, path: req.url,
      origin: req.headers.origin ?? null, requestedHeaders: req.headers['access-control-request-headers'] ?? null });
    res.setHeader('content-type', 'application/json'); res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'authorization,apikey,content-type,x-client-info,x-supabase-api-version');
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
    try {
      if (req.url === '/auth/v1/user') {
        const user = verify(String(req.headers.authorization ?? ''));
        observed.push({ boundary: 'SIGNED_BEARER_REAL_AUTH_USER_LOOKUP', principalId: user.id });
        res.end(JSON.stringify({ ...user, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} })); return;
      }
      if (req.url?.startsWith('/auth/v1/token') && req.method === 'POST') {
        let body = ''; for await (const b of req) { body += b; if (body.length > 16384) throw Error('BOUND') }
        const input = JSON.parse(body), user = [...users.values()].find(u => u.email === input.email);
        if (!user || input.password !== 'r3-disposable-local-only') throw Error('INVALID');
        res.end(JSON.stringify({ access_token: token(user.id), refresh_token: 'r3-disposable-local-only', expires_in: 3600, token_type: 'bearer',
          user: { ...user, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} } })); return;
      }
      if (req.url?.startsWith('/auth/v1/logout')) { res.end('{}'); return }
      res.writeHead(404); res.end('{}');
    } catch { observed.push({ boundary: 'AUTH_SIGNATURE_OR_IDENTITY_REFUSED' }); res.writeHead(401); res.end('{"msg":"Invalid disposable identity"}') }
  });
  const listen = async (server: Server) => {
    await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes) });
    const a = server.address(); if (!a || typeof a === 'string') throw Error('R3_OWNED_PORT_REQUIRED');
    return 'http://127.0.0.1:' + a.port;
  };
  authOrigin = await listen(auth);
  process.env.AUTH_DEV_BYPASS = '0'; process.env.SUPABASE_URL = authOrigin;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'r3-disposable-local-auth-not-a-production-secret';
  let installedOrigin = '', installedServer: ChildProcess | undefined;
  const installed = process.env.FINNOR_R3_INSTALLED_API === '1';
  const apiEnvironment = { ...process.env, NODE_ENV: 'test' };
  const transportEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('FINNOR_S6_')));
  let transportDigest = JSON.stringify(transportEnvironment());
  async function stopInstalledServer() {
    if (!installedServer || installedServer.exitCode !== null || installedServer.signalCode !== null) return;
    const child = installedServer;
    await new Promise<void>(yes => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('exit', () => { clearTimeout(timer); yes() }); child.kill('SIGTERM');
    });
  }
  async function startInstalledServer() {
    const reservation = createServer();
    const reserved = await listen(reservation);
    const port = new URL(reserved).port;
    await new Promise<void>(yes => reservation.close(() => yes()));
    const repo = resolve(import.meta.dirname, '../../..');
    const log = join(process.env.FINNOR_R3_EVIDENCE_DIR!, 'installed-next-api.log');
    installedServer = spawn(process.execPath,
      ['--import=tsx', join(repo, 'finnor-os/node_modules/next/dist/bin/next'), 'start', join(repo, 'finnor-os/apps/api'),
        '--hostname', '127.0.0.1', '--port', port],
      { cwd: join(repo, 'finnor-os'), env: { ...apiEnvironment, ...transportEnvironment() }, stdio: ['ignore', 'pipe', 'pipe'] });
    installedServer.stdout!.on('data', bytes => void appendFile(log, bytes));
    installedServer.stderr!.on('data', bytes => void appendFile(log, bytes));
    const observedProcess = installedServer;
    observedProcess.once('exit', (exitCode, signalCode) => observed.push({
      boundary: 'ACTUAL_INSTALLED_NEXT_PROCESS_EXIT', pid: observedProcess.pid, exitCode, signalCode,
      at: new Date().toISOString(),
    }));
    installedOrigin = reserved;
    const preparationBoundMs = 120000;
    const begun = performance.now(), until = Date.now() + preparationBoundMs;
    let readinessPhase = 'RELEASE_GET';
    try {
      for (;;) {
        if (installedServer.exitCode !== null || installedServer.signalCode !== null)
          throw Error('R3_INSTALLED_NEXT_SERVER_EXITED_BEFORE_READINESS');
        const response = await fetch(installedOrigin + '/api/release', { signal: AbortSignal.timeout(2000) }).catch(() => null);
        if (response?.ok) break;
        if (Date.now() >= until) throw Error('R3_INSTALLED_NEXT_HTTP_READINESS_BOUND');
        await new Promise<void>(yes => setTimeout(yes, 100));
      }
      readinessPhase = 'UNSIGNED_OWNER_ROUTE_LOAD';
      const ownerReady = await fetch(installedOrigin + '/api/elicitation-protocols/read', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        signal: AbortSignal.timeout(Math.max(1, until - Date.now())),
      });
      await ownerReady.arrayBuffer();
      if (ownerReady.status !== 401) throw Error('R3_INSTALLED_UNSIGNED_OWNER_READINESS_MUST_REFUSE');
      observed.push({ boundary: 'INSTALLED_NEXT_HTTP_READINESS', origin: installedOrigin,
        preparationElapsedMs: performance.now() - begun, preparationBoundMs, signedOwnerResponseBoundMs: 30000,
        admittedRequestOrGrant: false, actualUnsignedR3Status: ownerReady.status,
        pid: installedServer.pid, source: 'BUILT_API_IMAGE', authenticationBypass: false });
    } catch (error) {
      await writeFile(join(process.env.FINNOR_R3_EVIDENCE_DIR!, 'installed-http-readiness-failure.json'),
        JSON.stringify({ phase: readinessPhase, preparationElapsedMs: performance.now() - begun, preparationBoundMs,
          signedOwnerResponseBoundMs: 30000, pid: installedServer.pid, exitCode: installedServer.exitCode,
          signalCode: installedServer.signalCode, message: error instanceof Error ? error.message : String(error),
          admittedRequestOrGrant: false }, null, 2));
      installedServer.kill('SIGTERM');
      auth.closeAllConnections(); await new Promise<void>(yes => auth.close(() => yes()));
      throw error;
    }
  }
  if (installed) await startInstalledServer();
  async function synchronizeTransportEnvironment() {
    const next = JSON.stringify(transportEnvironment());
    if (!installed || next === transportDigest) return;
    await stopInstalledServer(); await startInstalledServer(); transportDigest = next;
    observed.push({ boundary: 'FIXTURE_INSTALLED_SERVER_TRANSPORT_CONFIGURATION_RESTART',
      databaseRoleUnchanged: true, authenticationProviderUnchanged: true });
  }
  handlers['elicitation-protocols'] = (await import('../../apps/api/app/api/elicitation-protocols/[operation]/route')).POST;
  handlers.interventions = (await import('../../apps/api/app/api/interventions/[operation]/route')).POST;
  handlers.policies = (await import('../../apps/api/app/api/policies/[operation]/route')).POST;
  handlers.allocations = (await import('../../apps/api/app/api/allocations/[operation]/route')).POST;
  handlers.obligations = (await import('../../apps/api/app/api/obligations/[operation]/route')).POST;
  handlers['company-brain'] = (await import('../../apps/api/app/api/company-brain/[operation]/route')).POST;
  const threads = await import('../../apps/api/app/api/threads/route');
  const thread = await import('../../apps/api/app/api/threads/[id]/route');
  const canvas = await import('../../apps/api/app/api/threads/[id]/canvas/route');
  const work = await import('../../apps/api/app/api/works/[id]/route');
  const preferences = await import('../../apps/api/app/api/user-prefs/route');
  const me = await import('../../apps/api/app/api/me/route');
  let delayedRead: { requestId: string; arrived: () => void; wait: Promise<void> } | null = null;
  const api = createServer(async (req, res) => {
    const started = performance.now();
    const profile = req.url === '/api/elicitation-protocols/submit' ? new Session() : null;
    const profiler = (method: string) => new Promise<any>((yes, no) => profile!.post(method, (e, r) => e ? no(e) : yes(r)));
    if (profile) { profile.connect(); await profiler('Profiler.enable'); await profiler('Profiler.start') }
    const waits = setInterval(() => {
      void admin.query(`SELECT pid,state,wait_event_type,wait_event,left(query,1000) query,pg_blocking_pids(pid) blockers
        FROM pg_stat_activity WHERE datname=current_database() AND state<>'idle' AND pid<>pg_backend_pid()`)
        .then(r => observed.push({ boundary: 'LIVE_HTTP_SQL_OBSERVATION', path: req.url,
          elapsedMs: performance.now() - started, statements: r.rows }))
        .catch(() => undefined);
    }, 5000);
    try {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname.split('/').filter(Boolean);
      const family = path[1]!, operation = path[2]!;
      const methods: Record<string, Handler | undefined> =
        family === 'threads' ? operation ? path[3] === 'canvas' ? { GET: canvas.GET, PUT: canvas.PUT } : { GET: thread.GET }
          : { GET: threads.GET, POST: threads.POST }
        : family === 'works' ? { GET: work.GET }
        : family === 'user-prefs' ? { GET: preferences.GET, PUT: preferences.PUT, DELETE: preferences.DELETE }
        : family === 'me' ? { GET: me.GET } : { POST: handlers[family] };
      const handler = methods[req.method ?? ''];
      if (!handler) { res.writeHead(404); res.end('{}'); return }
      const bytes: Buffer[] = []; let n = 0;
      for await (const b of req) { n += b.length; if (n > 2 * 1024 * 1024) { res.writeHead(413); res.end('{}'); return } bytes.push(b) }
      const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const init = { method: req.method, headers,
        ...(!['GET', 'HEAD'].includes(req.method ?? '') ? { body: Buffer.concat(bytes) } : {}) };
      const result = installedOrigin
        ? await (async () => { await synchronizeTransportEnvironment();
          return fetch(installedOrigin + req.url, { ...init, signal: AbortSignal.timeout(30000) }); })()
        : await handler(new Request('http://127.0.0.1' + req.url, init),
          { params: Promise.resolve({ operation, id: operation }) });
      if (family === 'elicitation-protocols' && operation === 'read' && delayedRead &&
        JSON.parse(Buffer.concat(bytes).toString()).requestId === delayedRead.requestId) {
        const gate = delayedRead; delayedRead = null;
        observed.push({ boundary: 'FIXTURE_DELAY_ACTUAL_OWNER_READ_REPLY', requestId: gate.requestId });
        gate.arrived(); await gate.wait;
      }
      const decoded = Buffer.from(await result.arrayBuffer());
      // fetch decodes the upstream representation. Its encoding and byte-count
      // headers cannot describe this distinct outgoing HTTP response.
      result.headers.forEach((v, k) => {
        if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(k.toLowerCase())) res.setHeader(k, v);
      });
      res.writeHead(result.status); res.end(decoded);
      observed.push({ boundary: 'FIXTURE_DECODED_RESPONSE_REPRESENTATION', family, operation,
        upstreamContentEncoding: result.headers.get('content-encoding'), decodedBytes: decoded.length,
        statusUnchanged: result.status, bodyReplaced: false });
      observed.push({ boundary: installedOrigin ? 'INSTALLED_NEXT_HTTP_ROUTE' : 'REAL_HTTP_ROUTE',
        family, operation, status: result.status, elapsedMs: performance.now() - started });
    } catch (e) {
      const causes: Array<{ message: string; code: unknown }> = [];
      for (let cause: any = e; cause && causes.length < 8; cause = cause.cause)
        causes.push({ message: String(cause.message ?? cause), code: cause.code ?? null });
      observed.push({ boundary: 'HTTP_FIXTURE_FAILURE', causes,
        message: e instanceof Error ? e.message : String(e), installedOrigin,
        installedNext: installedServer ? { pid: installedServer.pid, exitCode: installedServer.exitCode,
          signalCode: installedServer.signalCode } : null });
      res.writeHead(500); res.end('{}');
    }
    finally {
      clearInterval(waits);
      if (profile) {
        try {
          const result = await profiler('Profiler.stop');
          const path = join(process.env.FINNOR_R3_EVIDENCE_DIR!, 'submit-' + Date.now() + '.cpuprofile');
          await writeFile(path, JSON.stringify(result.profile));
          observed.push({ boundary: 'ACTUAL_SUBMIT_CPU_PROFILE', file: path, elapsedMs: performance.now() - started });
        } finally { profile.disconnect() }
      }
    }
  });
  const origin = await listen(api);
  return {
    origin, authOrigin, observed,
    delayRead: (requestId: string) => {
      let arrived!: () => void, release!: () => void;
      const arrival = new Promise<void>(yes => { arrived = yes }), wait = new Promise<void>(yes => { release = yes });
      delayedRead = { requestId, arrived, wait }; return { arrival, release };
    },
    register: async (id: string) => {
      const user = (await admin.query('SELECT id,email FROM finnor_os.users WHERE id=$1', [id])).rows[0];
      if (!user) throw Error('R3_DATABASE_AUTH_USER_REQUIRED'); users.set(id, user);
    },
    call: async (principalId: string | null, family: string, operation: string, body: unknown, invalid = false) => {
      // Fixture lifecycle preparation precedes the actual HTTP request. Keep
      // its cost explicit; all accepted Work/grant/episode deadlines stay fixed.
      await synchronizeTransportEnvironment();
      const started = performance.now(), headers: Record<string, string> = { 'content-type': 'application/json' };
      if (principalId) headers.authorization = 'Bearer ' + (invalid ? token(principalId) + 'x' : token(principalId));
      const response = await fetch(origin + '/api/' + family + '/' + operation, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      return { status: response.status, body: await response.json() as any, elapsedMs: performance.now() - started };
    },
    close: async () => {
      await stopInstalledServer();
      for (const s of [api, auth]) { s.closeAllConnections(); await new Promise<void>(yes => s.close(() => yes())) }
    },
  };
}
