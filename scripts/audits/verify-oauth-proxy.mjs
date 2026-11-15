import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { createNativeOwnerDatabase } from '../../finnor-os/scripts/s7/native-owner-database.mjs'

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../..'))
const index = process.argv.indexOf('--out')
assert(index >= 0 && process.argv[index + 1], '--out requires an external evidence directory')
const output = resolve(process.argv[index + 1])
assert(relative(root, output).startsWith('..') || isAbsolute(relative(root, output)), 'Evidence must be outside the repository')
mkdirSync(output, { recursive: true })
const require = createRequire(join(root, 'package.json'))
const backendRequire = createRequire(join(root, 'finnor-os/apps/api/package.json'))
const ts = require('typescript'), { NextRequest } = require('next/server'), { chromium } = require('@playwright/test')
const sourceFiles = new Map(), loaded = new Map(), results = [], requests = [], managedWrites = [], networkErrors = []
const hash = value => createHash('sha256').update(value).digest('hex')
function pin(path) { sourceFiles.set(path, hash(readFileSync(join(root, path)))) }
pin('scripts/audits/verify-oauth-proxy.mjs')
function load(path) {
  if (loaded.has(path)) return loaded.get(path).exports
  pin(path)
  if (path.endsWith('.json')) return JSON.parse(readFileSync(join(root, path), 'utf8'))
  const moduleValue = { exports: {} }
  loaded.set(path, moduleValue)
  const imported = name => {
    if (name.startsWith('@/') || name.startsWith('.')) {
      const base = name.startsWith('@/') ? 'src/' + name.slice(2) : join(dirname(path), name)
      const target = [base, base + '.ts', base + '.json'].find(value => existsSync(join(root, value)))
      assert(target, 'Local import must resolve: ' + name)
      return load(target)
    }
    return require(name)
  }
  const compiled = ts.transpileModule(readFileSync(join(root, path), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  vm.runInThisContext('(function(exports,require,module){' + compiled + '\n})', { filename: path })(moduleValue.exports, imported, moduleValue)
  return moduleValue.exports
}
const originalFetch = globalThis.fetch
const db = await createNativeOwnerDatabase()
let upstream, app, browser
const closeServer = async server => { if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)) } }
const save = () => writeFileSync(join(output, 'oauth-proxy.json'), JSON.stringify({ schema: 'finnor.oauth-proxy-e2e.v1', generatedAt: new Date().toISOString(), sources: [...sourceFiles].map(([path, sha256]) => ({ path, sha256 })), results, requests, managedWriteCount: managedWrites.length, networkErrors, qualification: 'Real Chromium, actual proxy, NextRequest, Google start/callback owner, ordinary PostgreSQL role and one-time nonce consumption. Local bearer-to-dev-header authentication adapter; Google and managed secret store are explicit test adapters. No live JWT/provider/cloud effects.', rerun: 'From finnor-os: node --import=tsx ../scripts/audits/verify-oauth-proxy.mjs --out <external directory>' }, null, 2))
const check = async (id, run) => {
  try { results.push({ id, status: 'PASS', observed: await run() }) }
  catch (error) { results.push({ id, status: 'FAIL', observed: error instanceof Error ? error.message : String(error) }) }
  save()
}
try {
  // The Next 15 owner routes are CommonJS; use the same public module instance
  // for provider adapters rather than creating a second ESM singleton.
  const security = backendRequire('@finnor/security')
  const googleStart = await import('../../finnor-os/apps/api/app/api/connections/google/start/route.ts')
  const googleCallback = await import('../../finnor-os/apps/api/app/api/connections/google/callback/route.ts')
  const microsoftCallback = await import('../../finnor-os/apps/api/app/api/connections/microsoft-graph/callback/route.ts')
  for (const path of ['finnor-os/packages/security/src/connections.ts', 'finnor-os/packages/security/src/secrets.ts', 'finnor-os/apps/api/app/api/connections/google/start/route.ts', 'finnor-os/apps/api/app/api/connections/google/callback/route.ts', 'finnor-os/apps/api/app/api/connections/microsoft-graph/callback/route.ts']) pin(path)
  const actors = [{ tenant: randomUUID(), user: randomUUID(), token: 'DISPOSABLE_OAUTH_A', ref: 'oauth-a' }, { tenant: randomUUID(), user: randomUUID(), token: 'DISPOSABLE_OAUTH_B', ref: 'oauth-b' }]
  await db.admin.query("SET app.test_vertical_mode='explicit'")
  for (const actor of actors) {
    actor.profile = randomUUID()
    const account = randomUUID()
    await db.admin.query("INSERT INTO finnor_os.tenants(id,name) VALUES($1,'OAuth disposable fixture')", [actor.tenant])
    await db.admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')", [actor.user, actor.tenant, actor.user + '@fixture.invalid'])
    await db.db.configureTenantVertical({ tenantId: actor.tenant, verticalKey: 'private_equity', expectedVersion: 0, createdBy: actor.user, sourceSystem: 'oauth:fixture' })
    await db.admin.query("INSERT INTO finnor_os.application_accounts(id,tenant_id,account_key,application,provider,display_name,provider_account_ref,status,capabilities) VALUES($1,$2,$3,'gmail','gmail','OAuth fixture','oauth@fixture.invalid','active','[\"send\"]')", [account, actor.tenant, actor.ref])
    await db.admin.query("INSERT INTO finnor_os.auth_profiles(id,tenant_id,auth_profile_ref,principal_type,principal_id,application_account_id,purpose,status,capabilities,auth_method,connection_status,required_scopes,connection_required) VALUES($1,$2,$3,'employee',$4,$5,'send','active','[\"send\"]','oauth2','disconnected',$6,true)", [actor.profile, actor.tenant, actor.ref, actor.user, account, [security.GOOGLE_GMAIL_SEND_SCOPE]])
  }
  Object.assign(process.env, { GOOGLE_OAUTH_CLIENT_ID: 'DISPOSABLE_CLIENT', GOOGLE_OAUTH_CLIENT_SECRET: 'DISPOSABLE_SECRET', JARVIS_TEST_MODE: '0' })
  security.setGoogleConnectionFetchForTesting(async url => String(url).includes('/token')
    ? Response.json({ access_token: 'DISPOSABLE_ACCESS', refresh_token: 'DISPOSABLE_REFRESH', expires_in: 3600, scope: `openid email ${security.GOOGLE_GMAIL_SEND_SCOPE}` })
    : Response.json({ sub: 'fixture-subject', email: 'oauth@fixture.invalid', email_verified: true }))
  security.setAwsSecretWriterForTesting(async (reference, value) => { assert(value.accessToken && value.refreshToken); managedWrites.push({ reference }); return 'fixture-version' })
  const proxy = load('src/app/api/centropy/[...path]/route.ts')
  upstream = createServer(async (incoming, outgoing) => {
    try {
      const chunks = []; for await (const chunk of incoming) chunks.push(chunk)
      const headers = new Headers(incoming.headers)
      const actor = actors.find(actor => headers.get('authorization') === 'Bearer ' + actor.token)
      requests.push({ path: incoming.url.split('?')[0], method: incoming.method, bearerPresent: headers.has('authorization'), cookieNames: (headers.get('cookie') ?? '').split(';').map(part => part.trim().split('=')[0]).filter(Boolean) })
      if (actor) { headers.set('x-tenant-id', actor.tenant); headers.set('x-user-id', actor.user); headers.set('x-user-role', 'owner') }
      const url = new URL(incoming.url, upstreamOrigin)
      if (url.searchParams.get('state') === 'transport-forbidden-redirect') {
        outgoing.writeHead(303, { location: 'https://forbidden.invalid/settings/connections' }).end(); return
      }
      const request = new Request(url, { method: incoming.method, headers, ...(incoming.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) })
      const handler = url.pathname.endsWith('/google/start') ? googleStart.POST : url.pathname.endsWith('/google/callback') ? googleCallback.GET : microsoftCallback.GET
      const response = await handler(request)
      const responseHeaders = Object.fromEntries(response.headers)
      responseHeaders['set-cookie'] = [...response.headers.getSetCookie(), 'unrelated_backend_session=DO_NOT_FORWARD; Path=/; HttpOnly']
      outgoing.writeHead(response.status, responseHeaders).end(Buffer.from(await response.arrayBuffer()))
    } catch (error) { outgoing.writeHead(500).end(JSON.stringify({ driverError: String(error) })) }
  })
  await new Promise(done => upstream.listen(0, '127.0.0.1', done))
  const upstreamOrigin = 'http://127.0.0.1:' + upstream.address().port
  process.env.NEXT_PUBLIC_OS_API_URL = upstreamOrigin
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.origin !== upstreamOrigin) { networkErrors.push({ origin: url.origin, path: url.pathname }); throw Error('Only the owned upstream may be contacted') }
    return originalFetch(input, init)
  }
  app = createServer(async (incoming, outgoing) => {
    try {
      if (incoming.url === '/' || incoming.url.startsWith('/settings/connections')) { outgoing.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>OAuth fixture landing</title><main>Connection fixture</main>'); return }
      const chunks = []; for await (const chunk of incoming) chunks.push(chunk)
      const request = new NextRequest(new URL(incoming.url, appOrigin), { method: incoming.method, headers: incoming.headers, ...(incoming.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) })
      const segments = request.nextUrl.pathname.slice('/api/centropy/'.length).split('/')
      const response = await proxy[incoming.method](request, { params: Promise.resolve({ path: segments }) })
      const headers = Object.fromEntries(response.headers)
      if (response.headers.getSetCookie().length) headers['set-cookie'] = response.headers.getSetCookie()
      outgoing.writeHead(response.status, headers).end(Buffer.from(await response.arrayBuffer()))
    } catch (error) { outgoing.writeHead(500).end(JSON.stringify({ driverError: String(error) })) }
  })
  await new Promise(done => app.listen(0, '127.0.0.1', done))
  const appOrigin = 'http://127.0.0.1:' + app.address().port
  process.env.CONSOLE_ORIGIN = appOrigin
  process.env.GOOGLE_OAUTH_REDIRECT_URI = appOrigin + '/api/centropy/connections/google/callback'
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext(), foreign = await browser.newContext()
  await context.route('**/*', route => new URL(route.request().url()).origin === appOrigin ? route.continue() : route.abort())
  await foreign.route('**/*', route => new URL(route.request().url()).origin === appOrigin ? route.continue() : route.abort())
  const page = await context.newPage(), otherPage = await foreign.newPage()
  await page.goto(appOrigin); await otherPage.goto(appOrigin)
  const start = async (target = page, actor = actors[0], useDefault = false) => {
    const response = await target.evaluate(async ({ actor, redirectUri }) => {
      const response = await fetch('/api/centropy/connections/google/start', { method: 'POST', headers: { authorization: 'Bearer ' + actor.token, 'content-type': 'application/json' }, body: JSON.stringify({ authProfileRef: actor.ref, ...(redirectUri ? { redirectUri } : {}) }) })
      return { status: response.status, body: await response.json() }
    }, { actor, redirectUri: useDefault ? null : process.env.GOOGLE_OAUTH_REDIRECT_URI })
    assert.equal(response.status, 200, JSON.stringify(response))
    const authorization = new URL(response.body.authorizationUrl)
    assert.equal(authorization.searchParams.get('redirect_uri'), process.env.GOOGLE_OAUTH_REDIRECT_URI)
    const state = authorization.searchParams.get('state')
    assert(state)
    return { state, callback: process.env.GOOGLE_OAUTH_REDIRECT_URI + '?state=' + state + '&code=DISPOSABLE_CODE' }
  }
  await check('browser-start-cookie-and-default-callback', async () => {
    await start(page, actors[0], true)
    const cookies = await context.cookies()
    const cookie = cookies.find(cookie => cookie.name === 'finnor_google_oauth')
    assert(cookie && cookie.httpOnly && cookie.sameSite === 'Lax' && cookie.path === '/api/centropy/connections/google/callback')
    assert(!cookies.some(cookie => cookie.name === 'unrelated_backend_session'))
    return { cookiePresent: true, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite, path: cookie.path }
  })
  await check('browser-completion-and-owner-replay-denial', async () => {
    const started = await start(), cookie = (await context.cookies()).find(cookie => cookie.name === 'finnor_google_oauth')
    assert(cookie)
    await context.addCookies([{ name: 'unrelated_browser_session', value: 'DO_NOT_FORWARD', url: appOrigin }])
    await page.goto(started.callback)
    assert.equal(new URL(page.url()).searchParams.get('google'), 'connected', new URL(page.url()).searchParams.get('code'))
    assert(!(await context.cookies()).some(cookie => cookie.name === 'finnor_google_oauth'))
    const row = (await db.admin.query('SELECT connection_status,credential_version FROM finnor_os.auth_profiles WHERE id=$1', [actors[0].profile])).rows[0]
    assert.equal(row.connection_status, 'active')
    const writeCount = managedWrites.length
    assert.equal(writeCount, 1)
    await context.addCookies([cookie])
    await page.goto(started.callback)
    assert.equal(new URL(page.url()).searchParams.get('code'), 'invalid_state')
    assert.equal(managedWrites.length, writeCount)
    const callbackRequests = requests.filter(row => row.path.endsWith('/google/callback'))
    assert(callbackRequests.length >= 2 && callbackRequests.every(row => !row.bearerPresent && row.cookieNames.every(name => name === 'finnor_google_oauth')))
    return { ownerStatus: row.connection_status, replay: 'invalid_state', managedWrites: writeCount, browserCallbackBearer: false }
  })
  await check('missing-cookie-denied', async () => {
    const started = await start()
    await context.clearCookies({ name: 'finnor_google_oauth' })
    await page.goto(started.callback)
    assert.equal(new URL(page.url()).searchParams.get('code'), 'missing_cookie')
    return { code: 'missing_cookie' }
  })
  await check('foreign-browser-state-denied', async () => {
    const a = await start(), b = await start(otherPage, actors[1])
    await otherPage.goto(a.callback)
    assert.equal(new URL(otherPage.url()).searchParams.get('code'), 'invalid_state')
    await page.goto(b.callback)
    assert.equal(new URL(page.url()).searchParams.get('code'), 'invalid_state')
    return { foreignBrowserStates: 'denied' }
  })
  await check('tampered-state-denied', async () => {
    const started = await start()
    await page.goto(started.callback.replace(started.state, 'tampered-state'))
    assert.equal(new URL(page.url()).searchParams.get('code'), 'invalid_state')
    return { code: 'invalid_state' }
  })
  await check('foreign-profile-start-denied', async () => {
    const result = await otherPage.evaluate(async actor => {
      const response = await fetch('/api/centropy/connections/google/start', { method: 'POST', headers: { authorization: 'Bearer ' + actor.token, 'content-type': 'application/json' }, body: JSON.stringify({ authProfileRef: 'oauth-a' }) })
      return { status: response.status }
    }, actors[1])
    assert.equal(result.status, 404)
    return result
  })
  await check('untrusted-upstream-redirect-denied', async () => {
    const response = await originalFetch(appOrigin + '/api/centropy/connections/google/callback?state=transport-forbidden-redirect', { redirect: 'manual' })
    assert.equal(response.status, 502)
    assert.equal(response.headers.get('location'), null)
    return { status: response.status }
  })
  await check('microsoft-anonymous-callback-reaches-owner', async () => {
    await page.goto(appOrigin + '/api/centropy/connections/microsoft-graph/callback')
    assert.equal(new URL(page.url()).searchParams.get('code'), 'invalid_callback')
    assert(requests.some(row => row.path.endsWith('/microsoft-graph/callback') && !row.bearerPresent && row.cookieNames.length === 0))
    return { ownerCode: 'invalid_callback', bearerRequired: false }
  })
  assert.equal(networkErrors.length, 0)
  await page.screenshot({ path: join(output, 'oauth-final.png') })
} finally {
  globalThis.fetch = originalFetch
  await browser?.close()
  await closeServer(app); await closeServer(upstream)
  await backendRequire('@finnor/db').closePool()
  await db.stop()
  save()
}
console.log(JSON.stringify({ output, results, managedWrites: managedWrites.length }))
assert(results.length === 8 && results.every(row => row.status === 'PASS'), 'OAuth end-to-end cases failed; inspect oauth-proxy.json')
