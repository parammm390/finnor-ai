/** Mounted UI E2E. Only the freshly created local runner/assigned desktop tab. */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const readyPath = process.argv[2];
assert(readyPath?.startsWith(join(root, 'scope-pm/phase-03-p3-branch-fabric/scope-evidence/')));
const ready = JSON.parse(await readFile(readyPath, 'utf8'));
assert.equal(ready.qualification, 'REAL_MOUNTED_NEXT_SUPABASE_CLIENT_PROXY_SIGNED_FIXTURE_JWT_NO_AUTH_BYPASS_NO_PRODUCTION_CREDENTIALS');
for (const origin of [ready.frontendOrigin, ready.authOrigin]) {
  const u = new URL(origin);
  assert.equal(u.protocol, 'http:'); assert.equal(u.hostname, '127.0.0.1');
}
assert(process.env.FACTORY_DESKTOP_CDP_PORT && process.env.AGENT_BROWSER_CDP && process.env.AGENT_BROWSER_SESSION,
  'Assigned desktop browser required, no headless substitute');
const cli = join(root, '.runtime/browser-tool/node_modules/.bin/agent-browser');
const output = join(ready.output, 'browser');
await mkdir(output, { recursive: true });
const assertions = [], commands = [], inputObservations = [];
const began = performance.now(), beforeUsage = process.resourceUsage();
let nativePointer = null, nativeKeyboard = null, functionalFallback = false;
const env = { ...process.env, PATH: join(root, '.runtime/browser-tool/node_modules/node/bin') + ':' + process.env.PATH,
  AGENT_BROWSER_DEFAULT_TIMEOUT: '15000' };
// Darwin Unix-domain socket paths have a 103-byte bound. Preserve Factory's
// assigned session and shorten only this phase-owned namespace.
const namespace = process.env.FINNOR_P3_BROWSER_NAMESPACE ?? 'p3-' + ready.workId.slice(0, 8);
assert(/^[a-z0-9-]{1,16}$/.test(namespace), 'Short phase-owned browser namespace required');
const sanitize = value => String(value).replaceAll(process.env.AGENT_BROWSER_CDP, '<assigned-desktop-endpoint>')
  .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<redacted-jwt>');
function ab(args, input) {
  const began = performance.now();
  try {
    const pin = args[0] === 'tab' && args[1] === 'new' ? '--no-pin-tab' : '--pin-tab';
    const raw = execFileSync(cli, ['--namespace', namespace, '--cdp', process.env.AGENT_BROWSER_CDP, pin, '--json', ...args], {
      cwd: root, env, input, encoding: 'utf8', timeout: 45000, maxBuffer: 2 * 1024 * 1024,
    });
    const result = JSON.parse(raw);
    commands.push({ operation: args[0], elapsedMs: performance.now() - began, success: result.success !== false });
    if (result.success === false) throw Error(result.error ?? 'BROWSER_COMMAND_REFUSED');
    return result.data?.result ?? result.data;
  } catch (e) {
    commands.push({ operation: args[0], elapsedMs: performance.now() - began, success: false });
    let reason = e instanceof Error ? e.message : 'BROWSER_COMMAND_FAILED';
    try { reason = JSON.parse(String(e.stdout)).error ?? reason; } catch {}
    throw Error(sanitize(reason).slice(0, 1000));
  }
}
const evaluate = js => ab(['eval', '--stdin'], js);
const wait = js => ab(['wait', '--fn', js]);
async function record(id, observed, passed = true) {
  assertions.push({ id, passed, observed, at: new Date().toISOString() });
  await writeFile(join(output, `${id}.json`), JSON.stringify(assertions.at(-1), null, 2) + '\n');
  assert(passed, id);
  console.log(JSON.stringify({ browserCase: id, passed }));
}
async function snapshot(label) {
  const data = ab(['snapshot', '-i']);
  await writeFile(join(output, label + '-snapshot.json'), JSON.stringify(data, null, 2) + '\n');
  return typeof data === 'string' ? data : data.snapshot;
}
async function button(name, { rowId } = {}) {
  const before = await snapshot('before-' + commands.length);
  const line = before?.split('\n').find(l => /\bbutton\b/.test(l) && l.includes(JSON.stringify(name)));
  const ref = line?.match(/ref=(e\d+)/)?.[1] ?? line?.match(/@(e\d+)/)?.[1];
  if (nativePointer !== false && !rowId && ref) {
    try { ab(['click', '@' + ref]); return; } catch (e) {
      nativePointer = false;
      inputObservations.push({ mode: 'NATIVE_POINTER', status: 'BLOCKED', reason: e.message });
    }
  }
  functionalFallback = true;
  evaluate(`(() => {
    const scope = ${rowId ? `Array.from(document.querySelectorAll('section li')).find(n=>n.textContent.includes(${JSON.stringify(rowId)}))` : 'document.querySelector("section")'};
    const b = Array.from(scope?.querySelectorAll('button') ?? []).find(n=>n.textContent.trim()===${JSON.stringify(name)});
    if (!b || b.disabled) throw Error('ENABLED_UI_BUTTON_REQUIRED');
    b.click(); return {mode:'DOM_ACTIVATION_NOT_NATIVE_INPUT',label:${JSON.stringify(name)}};
  })()`);
}
function select(label, value) {
  // Selection executes the actual React handler; independently qualify it.
  functionalFallback = true;
  evaluate(`(() => {
    const n=document.querySelector('select[aria-label=${JSON.stringify(label)}]');
    if(!n)throw Error('UI_SELECT_REQUIRED');
    n.value=${JSON.stringify(String(value))}; n.dispatchEvent(new Event('change',{bubbles:true}));
    return {label:${JSON.stringify(label)},value:n.value,mode:'DOM_CHANGE_NOT_NATIVE_INPUT'};
  })()`);
}
const results = () => evaluate(`Array.from(document.querySelectorAll('[data-testid="branch-result"]')).map(n=>JSON.parse(n.textContent))`);
const countResults = n => wait(`document.querySelectorAll('[data-testid="branch-result"]').length===${n}`);
async function signIn(identity = 'owner') {
  const observed = evaluate(`(async()=>{
    if(location.origin!==${JSON.stringify(ready.frontendOrigin)})throw Error('OWNED_ORIGIN_REQUIRED');
    const r=await fetch(${JSON.stringify(ready.authOrigin + '/__p3/session?identity=' + identity)});
    if(!r.ok)throw Error('FIXTURE_SESSION_UNAVAILABLE');
    const session=await r.json(),key='sb-127-auth-token';
    localStorage.setItem(key,JSON.stringify(session));
    const ch=new BroadcastChannel(key);ch.postMessage({event:'SIGNED_IN',session});ch.close();
    return {installed:true,identity:${JSON.stringify(identity)},authority:'DISPOSABLE_SIGNED_RS256_NO_AUTH_BYPASS'};
  })()`);
  return observed;
}
const control = operation => evaluate(`(async()=>{
  const r=await fetch(${JSON.stringify(ready.authOrigin + '/__p3/control')},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operation:${JSON.stringify(operation)}})});
  if(!r.ok)throw Error('FIXTURE_CONTROL_REFUSED');return await r.json();
})()`);
const inspection = () => evaluate(`JSON.parse(document.querySelector('pre[aria-label="Branch inspection"]').textContent)`);
const rowIds = () => evaluate(`Array.from(document.querySelectorAll('section li')).map(n=>n.querySelector('label')?.textContent.match(/[a-f0-9-]{36}/)?.[0]).filter(Boolean)`);

try {
  const preparationDeadline = Date.now() + 60000;
  for (;;) {
    try {
      const response = await fetch(ready.url, { signal: AbortSignal.timeout(5000) });
      if (response.ok) break;
    } catch {}
    assert(Date.now() < preparationDeadline, 'Owned frontend did not start');
    await new Promise(r => setTimeout(r, 250));
  }
  const frontendPreparationObservedMs = performance.now() - began;
  await record('00-frontend-preparation', { frontendPreparationObservedMs, accountingScope: 'INCLUDED_DRIVER_INTERVAL_NOT_BRANCH_EXECUTION' });
  // Factory supplies this embedded pane directly. Its bridge blocks target
  // creation; use the supported navigation command, preserving the assigned
  // session and pin. Never close/reload the app or enumerate other user tabs.
  ab(['open', ready.url]);
  wait('document.querySelector("#branch-heading")!==null');
  wait(`document.querySelector('select[aria-label="Branch kind"]')!==null`);
  const signedOut = evaluate(`({disabled:Array.from(document.querySelectorAll('button')).find(n=>n.textContent==='Prepare and submit').disabled,results:document.querySelectorAll('[data-testid="branch-result"]').length})`);
  assert(signedOut.disabled && signedOut.results === 0);
  await record('01-signed-out', signedOut);
  await signIn();
  wait(`!Array.from(document.querySelectorAll('button')).find(n=>n.textContent==='Prepare and submit').disabled`);
  await record('02-signed-session', { installed: true, headerAuthBypass: false, authority: 'DISPOSABLE_RS256_JWKS' });

  await button('Prepare and submit');
  // Verify an outcome, not just a command's reported success.
  try {
    wait('document.querySelectorAll("section li").length>=1');
    if (nativePointer !== false) { nativePointer = true; inputObservations.push({ mode: 'NATIVE_POINTER', status: 'OBSERVED_EFFECT' }); }
  } catch (e) {
    nativePointer = false;
    inputObservations.push({ mode: 'NATIVE_POINTER', status: 'NO_OBSERVED_EFFECT', reason: e.message });
    await button('Prepare and submit');
  }
  countResults(1);
  assert.deepEqual(results()[0].selected, ['A', 'C']); assert.equal(results()[0].registeredPayoff, 34);
  await record('03-native-34', results()[0]);

  select('Leverage', 30); await button('Prepare and submit'); countResults(2);
  assert(results().some(r=>r.registeredPayoff===32&&JSON.stringify(r.selected)==='["B","C"]'));
  await record('04-native-32', { results: results().map(r=>({ selected:r.selected, payoff:r.registeredPayoff })) });
  select('Reserved equity', 25); await button('Prepare and submit'); countResults(3);
  assert(results().some(r=>r.registeredPayoff===20&&JSON.stringify(r.selected)==='["A"]'));
  await record('05-native-20', { results: results().map(r=>({ selected:r.selected, payoff:r.registeredPayoff })) });

  const pureIds = rowIds();
  await button('Inspect checks and attempts', { rowId: pureIds[0] });
  wait(`document.querySelector('pre[aria-label="Branch inspection"]')!==null`);
  const detail = inspection();
  assert(detail.artifacts.some(r=>r.category==='ATTEMPT') && detail.artifacts.some(r=>r.category==='COST'));
  await record('06-check-attempt-inspection', { branchId: detail.branchId, categories: detail.artifacts.map(r=>r.category), reconciliation: detail.reconciliation });
  functionalFallback = true;
  evaluate(`Array.from(document.querySelectorAll('section li input[type=checkbox]')).forEach((n,i)=>{if(i<3&&!n.checked)n.click()});true`);
  await button('Compare matched branches');
  wait(`document.querySelector('pre[aria-label="Branch inspection"]')?.textContent.includes('finnor.branch-comparison.v1')`);
  assert.equal(inspection().winner, null); assert.equal(inspection().evidenceClass, 'COMPUTATION');
  await record('07-matched-comparison', { winner: null, evidenceClass: inspection().evidenceClass });

  select('Branch kind', 'application_fixture'); await button('Prepare and submit'); countResults(4);
  const ids = rowIds(), appId = ids.find(id=>!pureIds.includes(id));
  await button('Checkpoint', { rowId: appId });
  wait(`document.querySelector('pre[aria-label="Branch inspection"]')?.textContent.includes('checkpointId')`);
  const checkpoint = inspection(); assert(checkpoint.checkpointId);
  await button('Resume in fresh branch', { rowId: appId }); countResults(5);
  const resumed = results().filter(r=>r.schema==='finnor.financing-fixture-result.v1');
  await record('08-private-checkpoint-resume', { appId, checkpointId: checkpoint.checkpointId, resultCount: results().length, freshBranchCreated: rowIds().length===5, fixtureResults: resumed });
  await button('Inspect continuation requirements', { rowId: appId });
  wait(`document.querySelector('pre[aria-label="Branch inspection"]')?.textContent.includes('FRESH_S4_S5_S6_AUTHORITY_REQUIRED')`);
  assert.equal(inspection().executionAuthorityGranted, false);
  await record('09-continuation-no-authority', inspection());

  await control('pause'); select('Branch kind', 'pure');
  const beforeCancel = rowIds(); await button('Prepare and submit');
  wait(`document.querySelectorAll('section li').length===6`);
  const cancelId = rowIds().find(id=>!beforeCancel.includes(id));
  await button('Request cancellation', { rowId: cancelId });
  wait(`document.querySelector('[role=status]')?.textContent.includes('CANCEL_REQUESTED')`);
  assert(evaluate(`document.querySelector('[role=status]').textContent.includes('stopped: false')`));
  await control('unpause');
  wait(`Array.from(document.querySelectorAll('section li')).find(n=>n.textContent.includes(${JSON.stringify(cancelId)}))?.textContent.includes('CANCELLED')`);
  await record('10-cancel-requested-then-stopped', { branchId: cancelId, queuedCancellationObserved: true, resultCount: results().length });

  ab(['open', ready.url]); countResults(5);
  await record('11-authenticated-reopen', { resultCount: results().length, persistedSessionViaActualSupabaseClient: true });
  const ownedSnapshot = await snapshot('mounted');
  try { ab(['screenshot', join(output, 'mounted.png')]); } catch (e) {
    inputObservations.push({ mode: 'SCREENSHOT', status: 'BLOCKED', reason: e.message });
  }
  // Native keyboard is tested separately, not inferred from DOM activation.
  const reloadLine = ownedSnapshot?.split('\n').find(l=>/\bbutton\b/.test(l)&&l.includes('"Reload"'));
  const reloadRef = reloadLine?.match(/ref=(e\d+)/)?.[1] ?? reloadLine?.match(/@(e\d+)/)?.[1];
  if (reloadRef) {
    try {
      ab(['focus', '@' + reloadRef]); ab(['press', 'Enter']);
      inputObservations.push({ mode: 'NATIVE_KEYBOARD', status: 'COMMAND_REPORTED_SUCCESS_EFFECT_NOT_INDEPENDENTLY_OBSERVED' });
    }
    catch (e) { nativeKeyboard = false; inputObservations.push({ mode: 'NATIVE_KEYBOARD', status: 'BLOCKED', reason: e.message }); }
  }

  await signIn('other'); countResults(0);
  wait(`document.querySelector('pre[aria-label="Branch inspection"]')===null`);
  await record('12-foreign-session-clears', { resultCount: 0, detailAbsent: true, ownerWorkUnavailableToForeignPrincipal: true });
  await signIn('owner'); countResults(5);
  await control('suspend'); countResults(0);
  await record('13-suspended-refusal', { resultCount: 0, authority: 'REAL_REQUIRE_CONTEXT_SUSPENDED_FIXTURE_USER' });
  await control('reactivate'); countResults(0);
  await button('Reload');
  wait(`Array.from(document.querySelectorAll('section li')).filter(n=>n.textContent.includes('INVALIDATED')).length===5`);
  await record('13b-reactivation-no-resurrection', { resultCount: 0, invalidatedOldHeads: 5, freshRequestRequired: true });
  await button('Prepare and submit'); countResults(1);
  assert.equal(results()[0].registeredPayoff, 34);
  await signIn('expired'); countResults(0);
  await record('14-expired-session-refusal', { resultCount: 0, signatureAuthenticButExpired: true });
  await signIn('owner'); countResults(1);
  await control('revise'); countResults(0);
  await record('15-material-Work-invalidates', { resultCount: 0, materialOwnerWorkInputChanged: true });
} catch (e) {
  assertions.push({ id: 'BROWSER_E2E_FAILURE', passed: false, observed: { message: e.message, stack: e.stack }, at: new Date().toISOString() });
  try { await snapshot('failure'); } catch {}
} finally {
  const proof = {
    schema: 'finnor.p3.browser-proof.v1', status: assertions.length >= 10 && assertions.every(a=>a.passed) ? 'PASS_LOCAL' : 'FAIL',
    assertions, commands, inputObservations, nativePointer, nativeKeyboard, functionalFallback,
    qualification: 'MOUNTED_UI_FUNCTIONS_WITH_EXPLICIT_INPUT_METHOD_QUALIFICATION_NOT_LINUX_CONFINEMENT',
    nativeInputGate: nativePointer && nativeKeyboard && !functionalFallback ? 'OBSERVED' : 'UNPASSED',
    desktopTabOwnership: 'FACTORY_ASSIGNED_EMBEDDED_PANE_NO_TARGET_CREATION',
    driverDigest: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
    driverUsage: { elapsedMs: performance.now() - began, parentUsageBefore: beforeUsage, parentUsageAfter: process.resourceUsage(), scope: 'DRIVER_ONLY_INCLUSIVE_NOT_BROWSER_OR_CONTAINER_AGGREGATE', moneyUSD: null, reconciliation: 'UNRECONCILED' },
    rerun: 'Run run-e2e.mts --browser, then node finnor-os/scripts/p3/browser-e2e.mjs <browser-ready.json>',
  };
  await writeFile(join(ready.output, 'browser-proof.json'), JSON.stringify(proof, null, 2) + '\n');
  // Only the disposable fixture is finished; never close the desktop browser.
  try {
    await fetch(ready.authOrigin + '/__p3/control', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'finish' }), signal: AbortSignal.timeout(2000) });
  } catch {}
  process.exitCode = proof.status === 'PASS_LOCAL' ? 0 : 1;
}
