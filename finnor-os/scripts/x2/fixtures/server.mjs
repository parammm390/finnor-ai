import { createServer } from 'node:http';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  ApplicationError, authenticate, completeDue, dispatch, login, logout,
  readApplication, requestReadback,
} from './application.mjs';
import {
  completionPage, documentation, listing, loginPage, openApi, page,
  parseForm, pathOperation, recordPage, resultPage, escape,
} from './views.mjs';
import { args, privateJson, requirePrivateDir, snapshot } from './store.mjs';

const options = args();
const directory = options['private-dir'];
const port = options.port === undefined ? 0 : Number(options.port);
if (!Number.isInteger(port) || port < 0 || port > 65535 || port === 19073) {
  throw new Error('Require an ephemeral or available loopback port; peer 19073 is excluded');
}
await requirePrivateDir(directory);
await snapshot(directory);

const identity = request => {
  const bearer = /^Bearer ([A-Za-z0-9_-]+)$/i.exec(request.headers.authorization ?? '')?.[1];
  const cookie = /(?:^|;\s*)portal_session=([A-Za-z0-9_-]+)/.exec(request.headers.cookie ?? '')?.[1];
  return { bearer, grantId: request.headers['x-portal-grant'], session: cookie };
};

function send(response, status, body, type = 'application/json', extra = {}) {
  response.writeHead(status, {
    'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    ...extra,
  });
  response.end(type === 'application/json' ? `${JSON.stringify(body)}\n` : body);
}

async function body(request) {
  let total = 0;
  const chunks = [];
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 32768) throw new ApplicationError(413, 'BODY_LIMIT_EXCEEDED');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function formBody(request) {
  if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers['content-type'] ?? '')) {
    throw new ApplicationError(415, 'FORM_CONTENT_TYPE_REQUIRED');
  }
  return new URLSearchParams(await body(request));
}

async function jsonBody(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) {
    throw new ApplicationError(415, 'JSON_CONTENT_TYPE_REQUIRED');
  }
  try { return JSON.parse(await body(request)); } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError(400, 'JSON_REQUIRED');
  }
}

function fromForm(form, operation) {
  try { return parseForm(form, operation); } catch {
    throw new ApplicationError(400, 'FORM_FIELDS_INVALID');
  }
}

async function answerDispatch(request, response, result, recordId, html) {
  // The transaction has fsynced before this real socket boundary is reached.
  if (result.fault === 'drop-next-submit') { request.socket.destroy(); return; }
  if (result.ackDelayMs) await sleep(result.ackDelayMs);
  if (!response.destroyed) {
    send(response, result.status, html ? resultPage(result, recordId) : result.data,
      html ? 'text/html' : 'application/json');
  }
}

const server = createServer(async (request, response) => {
  let html = false;
  try {
    const origin = `http://127.0.0.1:${request.socket.localPort}`;
    const remote = request.socket.remoteAddress;
    if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(remote) ||
        request.headers.host !== `127.0.0.1:${request.socket.localPort}`) {
      throw new ApplicationError(421, 'LOOPBACK_HOST_REQUIRED');
    }
    if (request.headers.origin && request.headers.origin !== origin) {
      throw new ApplicationError(403, 'ORIGIN_DENIED');
    }
    const url = new URL(request.url, origin);
    if (url.origin !== origin) throw new ApplicationError(421, 'ORIGIN_DENIED');
    const path = url.pathname;
    html = !path.startsWith('/api/') && !['/healthz', '/openapi.json'].includes(path);
    const auth = identity(request);
    const current = await snapshot(directory);
    const config = current.state.config;
    if (request.method === 'GET' && path === '/healthz') {
      send(response, 200, { status: 'ready', service: 'permissions-portal', schemaRevision: config.schemaRevision });
      return;
    }
    if (request.method === 'GET' && path === '/login') {
      send(response, 200, loginPage(), 'text/html'); return;
    }
    if (request.method === 'POST' && path === '/login') {
      const form = await formBody(request);
      const handle = await login(directory, form.get('bearer'), form.get('grantId'));
      send(response, 303, '', 'text/html', {
        Location: '/portal',
        'Set-Cookie': `portal_session=${handle}; Path=/; HttpOnly; SameSite=Strict; Max-Age=1800`,
      });
      return;
    }
    if (request.method === 'POST' && path === '/logout') {
      const form = await formBody(request);
      const view = await readApplication(directory, auth);
      if (!view.csrf || form.get('csrf') !== view.csrf) throw new ApplicationError(403, 'CSRF_DENIED');
      await logout(directory, auth);
      send(response, 303, '', 'text/html', {
        Location: '/login', 'Set-Cookie': 'portal_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
      });
      return;
    }
    if (request.method === 'GET' && (path === '/' || path === '/portal')) {
      if (!auth.bearer && !auth.session) { send(response, 303, '', 'text/html', { Location: '/login' }); return; }
      const view = await readApplication(directory, auth);
      send(response, 200, listing(view), 'text/html'); return;
    }
    if (request.method === 'GET' && ['/docs', '/openapi.json'].includes(path)) {
      if (config.surface === 'ui') throw new ApplicationError(404, 'ROUTE_NOT_FOUND');
      await readApplication(directory, auth);
      send(response, 200, path === '/docs' ? documentation(config) : openApi(config),
        path === '/docs' ? 'text/html' : 'application/json');
      return;
    }
    const apiRecord = path.match(/^\/api\/accounts\/([^/]+)\/records(?:\/([^/]+))?(?:\/(draft|validate|submit|approve))?$/);
    if (path === '/api/context' || apiRecord || /^\/api\/requests\/[^/]+$/.test(path)) {
      if (config.surface === 'ui') throw new ApplicationError(404, 'ROUTE_NOT_FOUND');
      html = false;
      if (request.method === 'GET' && !apiRecord?.[3]) {
        if (config.readbackDelayMs) await sleep(config.readbackDelayMs);
        // Authentication and visibility are rechecked after any delayed read.
        if (path.startsWith('/api/requests/')) {
          const readback = await requestReadback(directory, auth, path.slice('/api/requests/'.length));
          send(response, 200, readback); return;
        }
        const view = await readApplication(directory, auth, apiRecord?.[1], apiRecord?.[2]);
        if (view.config.surface === 'ui') throw new ApplicationError(404, 'ROUTE_NOT_FOUND');
        send(response, 200, path === '/api/context' ? view.context
          : apiRecord?.[2] ? view.records[0] : { records: view.records });
        return;
      }
      if (request.method === 'POST' && apiRecord?.[2] && apiRecord[3]) {
        if (config.surface === 'hybrid' && ['submit', 'approve'].includes(apiRecord[3])) {
          throw new ApplicationError(404, 'ROUTE_NOT_FOUND');
        }
        const payload = await jsonBody(request);
        const result = await dispatch(directory, auth, apiRecord[1], apiRecord[2], apiRecord[3], payload);
        await answerDispatch(request, response, result, apiRecord[2], false); return;
      }
      throw new ApplicationError(405, 'METHOD_NOT_ALLOWED');
    }
    const portalRecord = path.match(/^\/portal\/records\/([^/]+)$/);
    if (request.method === 'GET' && portalRecord) {
      if (config.readbackDelayMs) await sleep(config.readbackDelayMs);
      const view = await readApplication(directory, auth, undefined, portalRecord[1]);
      send(response, 200, recordPage(view), 'text/html'); return;
    }
    const portalRequest = path.match(/^\/portal\/requests\/([^/]+)$/);
    if (request.method === 'GET' && portalRequest) {
      if (config.readbackDelayMs) await sleep(config.readbackDelayMs);
      const readback = await requestReadback(directory, auth, portalRequest[1]);
      send(response, 200, completionPage(readback), 'text/html'); return;
    }
    const preview = path.match(/^\/portal\/records\/([^/]+)\/preview$/);
    if (request.method === 'GET' && preview) {
      const view = await readApplication(directory, auth, undefined, preview[1]);
      if (!view.config.methodTrap) {
        send(response, 200, page('Reporting preview', `<main><pre>${escape(JSON.stringify(view.records[0].draft?.reporting ?? view.records[0].reporting, null, 2))}</pre></main>`), 'text/html');
        return;
      }
      const payload = fromForm(url.searchParams, 'preview');
      const result = await dispatch(directory, auth, view.context.binding.accountId, preview[1],
        'preview', payload, true, url.searchParams.get('csrf'));
      await answerDispatch(request, response, result, preview[1], true); return;
    }
    const action = pathOperation(path, config.renderingRevision);
    if (request.method === 'POST' && action) {
      if (config.surface === 'hybrid' && ['draft', 'validate'].includes(action.operation)) {
        throw new ApplicationError(404, 'ROUTE_NOT_FOUND');
      }
      const form = await formBody(request);
      const payload = fromForm(form, action.operation);
      // Actual target scope is derived from current authenticated state, never the form.
      const currentAuth = authenticate((await snapshot(directory)).state, auth, 'record.read', undefined, action.recordId);
      const result = await dispatch(directory, auth, currentAuth.grant.accountId, action.recordId,
        action.operation, payload, true, form.get('csrf'));
      await answerDispatch(request, response, result, action.recordId, true); return;
    }
    throw new ApplicationError(404, 'ROUTE_NOT_FOUND');
  } catch (error) {
    const known = error instanceof ApplicationError;
    const result = {
      status: known ? error.status : 500,
      data: { error: known ? error.code : 'FIXTURE_INTERNAL_ERROR', details: known ? error.details : null },
    };
    if (!known) console.error(JSON.stringify({ event: 'fixture-error', kind: error.name }));
    if (!response.headersSent && !response.destroyed) {
      send(response, result.status, html ? resultPage(result, '') : result.data,
        html ? 'text/html' : 'application/json');
    }
  }
});

let polling = false;
const timer = setInterval(async () => {
  if (polling) return;
  polling = true;
  try { await completeDue(directory); } catch (error) {
    console.error(JSON.stringify({ event: 'provider-poll-error', kind: error.name }));
  } finally { polling = false; }
}, 40);

server.requestTimeout = 15000;
server.headersTimeout = 15000;
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', resolve);
});
const ready = { event: 'ready', origin: `http://127.0.0.1:${server.address().port}`, pid: process.pid };
await privateJson(join(directory, 'readiness.json'), ready);
console.log(JSON.stringify(ready));

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  const closed = new Promise(resolve => server.close(resolve));
  setTimeout(() => { server.closeAllConnections(); }, 2000).unref();
  await closed;
  while (polling) await sleep(10);
  console.log(JSON.stringify({ event: 'stopped', pid: process.pid }));
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
