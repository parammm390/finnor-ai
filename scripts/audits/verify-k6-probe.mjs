import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const arg = name => { const at = process.argv.indexOf(name); assert(at >= 0 && process.argv[at + 1], name + ' required'); return process.argv[at + 1] }
const executable = resolve(arg('--k6')), output = resolve(arg('--out'))
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
await mkdir(output, { recursive: true })
const tenant = randomUUID(), employee = randomUUID(), deal = randomUUID(), stream = randomUUID()
let mode = 'valid', writes = 0, confirmations = 0
const works = new Map(), actions = new Map(), observations = []
const server = createServer(async (incoming, outgoing) => {
  const send = (status, body) => outgoing.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  try {
    assert.equal(incoming.headers.authorization, 'Bearer DISPOSABLE_LOAD_TOKEN')
    const url = new URL(incoming.url, 'http://127.0.0.1')
    const chunks = []; for await (const chunk of incoming) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
    if (url.pathname === '/api/release') return send(200, { environment: mode === 'production' ? 'production' : 'staging' })
    if (url.pathname === '/api/me') return send(200, { userId: employee, employeeId: employee, tenantId: tenant, role: 'owner' })
    if (url.pathname === '/api/company-brain/roots') return send(200, { results: [{ rootRefs: [{ entityType: 'pe_deal', entityId: deal }] }] })
    if (url.pathname === '/api/read-models/attention') return send(200, { data: { items: [], sourceStatus: { status: 'complete' } } })
    if (url.pathname === '/api/actions' && incoming.method === 'POST') {
      assert.equal(body.reviewBeforeExecution, true)
      writes += 1
      const id = randomUUID(), aggregate = { work: { id, tenantId: tenant }, actions: [], businessEffects: [] }
      works.set(id, aggregate)
      if (body.instruction.includes('FINNOR_K6_APPROVAL')) {
        assert.equal(body.activeContext.focusedEntity.entityId, deal)
        const action = { id: randomUUID(), actionType: 'record_finding', status: 'pending', workId: id }
        const effect = { domainActionId: action.id, semanticHash: createHash('sha256').update(action.id).digest('hex') }
        aggregate.actions.push(action); aggregate.businessEffects.push(effect); actions.set(action.id, { action, effect })
        return send(200, { workId: id, prepared: [{ actionId: action.id, actionType: action.actionType, status: action.status, semanticHash: effect.semanticHash }] })
      }
      aggregate.query = true
      return send(200, { workId: id, prepared: [] })
    }
    if (url.pathname.startsWith('/api/works/')) {
      const aggregate = works.get(url.pathname.split('/').at(-1))
      if (!aggregate || mode === 'missing-readback' && aggregate.query) return send(404, { error: 'Work not found' })
      return send(200, { work: aggregate })
    }
    if (/^\/api\/actions\/[^/]+\/confirm$/.test(url.pathname)) {
      const owned = actions.get(url.pathname.split('/')[3])
      if (!owned || body.expectedEffectHash !== owned.effect.semanticHash || mode === 'approval-conflict') return send(409, { error: 'Reviewed effect mismatch' })
      confirmations += 1; owned.action.status = 'approved'
      return send(200, { result: { status: 'success', output: { status: 'approved' } } })
    }
    return send(404, { error: 'Unexpected fixture route' })
  } catch (error) { return send(500, { fixtureError: error.message }) }
})
try {
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const base = 'http://127.0.0.1:' + server.address().port
  for (const selected of ['valid', 'missing-readback', 'approval-conflict', 'production']) {
    mode = selected; works.clear(); actions.clear(); writes = 0; confirmations = 0
    const caseOutput = resolve(output, selected); await mkdir(caseOutput, { recursive: true })
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, BASE_URL: base, TENANT_ID: tenant, AUTH_BEARER_TOKEN: 'DISPOSABLE_LOAD_TOKEN',
      K6_FIXTURE_DEAL_ID: deal, K6_FIXTURE_WORKSTREAM_ID: stream, K6_RUN_ID: randomUUID(), K6_DISPOSABLE_LOOPBACK: '1', NODE_ENV: 'test',
      INBOX_RATE: '1', READ_VUS: '1', APPROVAL_RATE: '60', LOAD_DURATION: '2s', K6_EVIDENCE_FILE: resolve(caseOutput, 'load-evidence.json'), K6_NO_USAGE_REPORT: 'true' }
    const child = spawn(executable, ['run', '--no-color', '--summary-export', resolve(caseOutput, 'summary.json'), 'scripts/k6-load-test.js'], { cwd: resolve(root, 'finnor-os'), env, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''; child.stdout.on('data', chunk => { log += chunk }); child.stderr.on('data', chunk => { log += chunk })
    const exitCode = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done) })
    await writeFile(resolve(caseOutput, 'run.log'), log)
    if (selected === 'valid') {
      assert.equal(exitCode, 0, log)
      const proof = JSON.parse(await readFile(resolve(caseOutput, 'load-evidence.json'), 'utf8'))
      assert.equal(proof.status, 'PASS'); assert(writes > 0 && confirmations > 0)
    } else assert.notEqual(exitCode, 0, 'A negative control passed: ' + selected)
    if (selected === 'production') assert.equal(writes, 0)
    observations.push({ selected, exitCode, writes, confirmations })
  }
} finally {
  server.closeAllConnections(); await new Promise(done => server.close(done))
  await writeFile(resolve(output, 'k6-probe-e2e.json'), JSON.stringify({ observations, qualification: 'Actual k6 runtime and HTTP requests against a controlled DTO/protocol adapter matching current route contracts. This proves harness behavior and failure thresholds, not staging performance or business execution.', rerun: 'node scripts/audits/verify-k6-probe.mjs --k6 <k6 executable> --out <external directory>' }, null, 2))
}
assert.equal(observations.length, 4)
console.log(JSON.stringify({ output, observations }))
