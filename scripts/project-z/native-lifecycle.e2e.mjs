import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {createHash} from 'node:crypto'
import {readFileSync, writeFileSync} from 'node:fs'
import {waitForNativeStage} from './native-lifecycle.mjs'

const children = []
const rows = []
const source = readFileSync(new URL('./native-lifecycle.mjs', import.meta.url))
function start(label) {
  const proc = spawn(process.execPath, ['-e', "process.stdout.write('READY\\n');process.stdin.once('data',x=>process.exit(Number(x.toString().trim())))"],
    {detached: true, stdio: ['pipe', 'pipe', 'pipe']})
  const row = {label, code: null, signal: null}
  const ready = new Promise((yes, no) => {
    proc.once('error', no)
    proc.stdout.once('data', () => yes())
  })
  const ended = new Promise(yes => proc.once('close', (code, signal) => {
    Object.assign(row, {code, signal}); yes(row)
  }))
  const child = {proc, row, ready, ended}
  children.push(child)
  return child
}
async function finite(pending) {
  let timer
  try { return await Promise.race([pending, new Promise((_, no) => {
    timer = setTimeout(() => no(Error('PROCESS_E2E_BOUND_EXCEEDED')), 4000)
  })]) } finally { clearTimeout(timer) }
}
async function pair() {
  const app = start('app'), scenario = start('scenario')
  await finite(Promise.all([app.ready, scenario.ready]))
  return {app, scenario}
}
try {
  {
    const {app, scenario} = await pair()
    const pending = finite(waitForNativeStage(scenario.ended, [app]))
    app.proc.stdin.end('7')
    const error = await pending.then(() => assert.fail('Service failure was ignored'), e => e)
    assert.equal(error.message, 'NATIVE_REQUIRED_SERVICE_EXITED')
    assert.equal(error.nativeFailure.code, 7)
    assert.equal(error.nativeFailure.dependency, 'app')
    assert.equal(scenario.proc.exitCode, null)
    rows.push({case: 'service-nonzero-with-live-scenario', status: 'PASS'})
  }
  {
    const {app, scenario} = await pair()
    app.proc.stdin.end('0'); await finite(app.ended)
    const error = await finite(waitForNativeStage(scenario.ended, [app])).then(() => assert.fail('Unexpected zero exit was ignored'), e => e)
    assert.equal(error.message, 'NATIVE_REQUIRED_SERVICE_EXITED')
    assert.equal(error.nativeFailure.code, 0)
    rows.push({case: 'service-already-exited-zero', status: 'PASS'})
  }
  {
    const {app, scenario} = await pair()
    const pending = finite(waitForNativeStage(scenario.ended, [app]))
    app.proc.kill('SIGTERM')
    const error = await pending.then(() => assert.fail('Service signal was ignored'), e => e)
    assert.equal(error.nativeFailure.signal, 'SIGTERM')
    rows.push({case: 'service-signal', status: 'PASS'})
  }
  for (const code of [0, 9]) {
    const {app, scenario} = await pair()
    const pending = finite(waitForNativeStage(scenario.ended, [app]))
    scenario.proc.stdin.end(String(code))
    const result = await pending
    assert.equal(result.code, code)
    app.proc.stdin.end('0'); await finite(app.ended)
    assert.equal(result.code, code, 'Cleanup must not replace the original result')
    rows.push({case: 'scenario-exit-'+code+'-retained-through-cleanup', status: 'PASS'})
  }
  {
    const auth = start('auth'); await finite(auth.ready)
    const pending = finite(waitForNativeStage(new Promise(() => {}), [auth]))
    auth.proc.stdin.end('4')
    const error = await pending.then(() => assert.fail('Bootstrap dependency failure was ignored'), e => e)
    assert.equal(error.nativeFailure.dependency, 'auth')
    assert.equal(error.nativeFailure.code, 4)
    rows.push({case: 'bootstrap-dependency-exit', status: 'PASS'})
  }
  const receipt = {schema:'finnor.native-lifecycle-process-e2e.v1', status:'PASS', rows,
    inputs:{helperSha256:createHash('sha256').update(source).digest('hex')},
    qualification:'REAL_CHILD_PROCESS_LIFECYCLE_ONLY_ALL_ORIGINAL_NATIVE_CASES_STILL_REQUIRED'}
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(receipt,null,2)+'\n', {flag:'wx',mode:0o600})
  console.log(JSON.stringify(receipt))
} finally {
  for (const child of children) if (child.proc.exitCode === null && child.proc.signalCode === null) {
    try { process.kill(-child.proc.pid, 'SIGKILL') } catch {}
  }
  await Promise.all(children.map(child => child.ended))
}
