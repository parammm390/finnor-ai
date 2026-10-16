/** Registered primary-page native-input observer. No handler calls or HTTP mocks. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const readyPath = process.argv[process.argv.indexOf('--ready') + 1];
assert(readyPath && isAbsolute(readyPath), 'ABSOLUTE_MOUNTED_READY_REQUIRED');
const setup = JSON.parse(await readFile(readyPath, 'utf8')), out = dirname(readyPath);
const origin = new URL(setup.origin);
assert.equal(origin.protocol, 'http:'); assert.equal(origin.hostname, '127.0.0.1');
assert.equal(new URL(setup.url).origin, origin.origin);
assert(process.env.FACTORY_DESKTOP_CDP_PORT && process.env.AGENT_BROWSER_CDP && process.env.AGENT_BROWSER_SESSION,
  'ASSIGNED_EMBEDDED_PANE_AND_SESSION_REQUIRED');
const repo = resolve(import.meta.dirname, '../../..'), started = performance.now();
const commands: Array<{ id: string; args: string[]; elapsedMs: number }> = [];
const control = 'section[aria-label="Live institutional control"]';
const binary = process.env.PATH ? 'agent-browser' : '/Users/paramdave/.factory/bin/agent-browser';
let offline = false, step = 'START';
const save = (name: string, value: unknown) => writeFile(join(out, name), JSON.stringify(value, null, 2) + '\n',
  { flag: 'wx', mode: 0o600 });
function cli(id: string, ...args: string[]) {
  step = id;
  const remaining = 300000 - (performance.now() - started);
  assert(remaining > 0, 'REGISTERED_BROWSER_SUPERVISOR_DEADLINE');
  const before = performance.now();
  let result: string;
  try {
    result = execFileSync(binary, ['--cdp', process.env.AGENT_BROWSER_CDP!, ...args], {
      cwd: repo, env: process.env, encoding: 'utf8', timeout: Math.min(35000, remaining), maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch { throw Error('BROWSER_STEP_FAILED:' + id); }
  // Do not retain the protected CDP endpoint, credentials, or arbitrary console output.
  commands.push({ id, args: args.map((arg, index) => args[0] === 'eval' || args[0] === 'fill' && index > 1 ? '<observed-script-or-fixture>' : arg),
    elapsedMs: performance.now() - before });
  return result.trim();
}
function evaluate<T>(id: string, source: string): T {
  return JSON.parse(cli(id, 'eval', '-b', Buffer.from(source).toString('base64'))) as T;
}
function wait(id: string, predicate: string) { cli(id, 'wait', '--fn', predicate); }
function click(id: string, name: string) {
  const selector = evaluate<string>(id + '-exact-rendered-target', `(() => {
    const buttons=Array.from(document.querySelectorAll('button')).filter(b=>b.innerText.trim()===${JSON.stringify(name)}
      &&b.getClientRects().length&&getComputedStyle(b).visibility==='visible');
    if(buttons.length!==1)throw Error('EXACT_RENDERED_BUTTON_COUNT:'+buttons.length);
    const parts=[];let e=buttons[0];
    while(e&&e!==document.documentElement){const tag=e.tagName.toLowerCase(),
      siblings=Array.from(e.parentElement.children).filter(x=>x.tagName===e.tagName);
      parts.unshift(tag+':nth-of-type('+(siblings.indexOf(e)+1)+')');e=e.parentElement;}
    return 'html>'+parts.join('>');
  })()`);
  cli(id + '-scroll-target', 'scrollintoview', selector);
  wait(id + '-native-hit-target', `(() => {const b=document.querySelector(${JSON.stringify(selector)}),r=b?.getBoundingClientRect();
    if(!r||!b.matches(':enabled'))return false;const x=r.left+r.width/2,y=r.top+r.height/2;
    return x>=0&&x<innerWidth&&y>=0&&y<innerHeight&&document.elementFromPoint(x,y)?.closest('button')===b;})()`);
  cli(id, 'click', selector);
}
function login(email: string, name: string) {
  cli(name + '-login', 'open', setup.origin + '/centropy/login');
  cli(name + '-login-document', 'wait', '--load', 'domcontentloaded');
  wait(name + '-hydrated-form', `location.origin===${JSON.stringify(setup.origin)}&&!!document.querySelector('form button[type="submit"]')&&!document.querySelector('form button[type="submit"]').disabled`);
  evaluate(name + '-login-observer', `(() => {
    const p=window.__v5Login={events:[],requests:[]};
    for(const type of ['click','keydown','submit'])document.addEventListener(type,e=>{
      const entry={type,trusted:e.isTrusted,key:e.key??null,target:e.target?.tagName,prevented:e.defaultPrevented};
      p.events.push(entry);setTimeout(()=>entry.prevented=e.defaultPrevented,0);
    },true);
    const original=window.fetch.bind(window);window.fetch=async(...args)=>{
      const response=await original(...args),url=new URL(String(args[0]?.url??args[0]),location.href);
      p.requests.push({path:url.pathname,status:response.status});return response;
    };return {observational:true};
  })()`);
  cli(name + '-email-ready', 'wait', 'input[type="email"]');
  cli(name + '-native-field-focus', 'click', 'input[type="email"]');
  wait(name + '-document-focused', 'document.hasFocus()');
  cli(name + '-email', 'fill', 'input[type="email"]', email);
  cli(name + '-fixture-password', 'fill', 'input[type="password"]', 'v5-disposable-browser');
  cli(name + '-sign-in-focus', 'focus', 'form button[type="submit"]');
  wait(name + '-sign-in-focused', `document.activeElement===document.querySelector('form button[type="submit"]')&&document.activeElement.matches(':enabled')`);
  cli(name + '-sign-in-enter', 'press', 'Enter');
  cli(name + '-authenticated', 'wait', '--url', '**/centropy');
}
function openControl(name: string) {
  cli(name + '-exact-world', 'open', setup.url);
  cli(name + '-control-ready', 'wait', '--text', 'Open direct controls for this Work');
  click(name + '-open-control', 'Open direct controls for this Work');
  cli(name + '-snapshot-ready', 'wait', '--text', 'Preserved scenario branch');
}
try {
  if (process.platform === 'darwin') {
    const before = performance.now();
    assert(execFileSync('/bin/ps', ['-Ao', 'comm'], { encoding: 'utf8', timeout: 5000 })
      .split('\n').some(path => path.trim() === '/Applications/Factory.app/Contents/MacOS/Factory'),
    'EXISTING_FACTORY_APPLICATION_REQUIRED_NO_RELAUNCH');
    execFileSync('/usr/bin/osascript', ['-e', 'tell application "/Applications/Factory.app" to activate'],
      { timeout: 5000, stdio: 'ignore' });
    commands.push({ id: 'existing-desktop-activation', args: ['activate-existing-Factory-only'], elapsedMs: performance.now() - before });
  }
  const partner = setup.users.find((user: { id: string }) => user.id === setup.actors.partner);
  const finance = setup.users.find((user: { id: string }) => user.id === setup.actors.finance);
  assert(partner && finance);
  login(partner.email, 'partner');
  cli('exact-world', 'open', setup.url);
  cli('control-ready', 'wait', '--text', 'Open direct controls for this Work');
  evaluate('install-observer', `(() => {
    if(location.origin!==${JSON.stringify(setup.origin)})throw Error('EXACT_OWNED_ORIGIN_REQUIRED');
    const p=window.__v5Proof={events:[],responses:[]};
    for(const type of ['click','keydown'])document.addEventListener(type,e=>{
      if(p.events.length<500)p.events.push({type,trusted:e.isTrusted,key:e.key??null,target:e.target?.tagName,
        text:type==='click'?(e.target?.innerText??'').slice(0,160):null,at:performance.now()});
    },true);
    const original=window.fetch.bind(window);
    window.fetch=async(...args)=>{
      const response=await original(...args);
      if(String(args[0]?.url??args[0]).includes('live-controls')){
        const input=typeof args[1]?.body==='string'?JSON.parse(args[1].body):{};
        const body=await response.clone().json();
        p.responses.push({operation:input.operation,status:response.status,branchId:body.branchId??null,at:performance.now()});
      }
      return response;
    };
    return {requestsUnmodified:true};
  })()`);
  click('open-partner-control', 'Open direct controls for this Work');
  cli('intent-form-ready', 'wait', '--text', 'Use an exact installed native intent');
  cli('installed-intent', 'find', 'role', 'checkbox', 'check', '--name', 'Use an exact installed native intent');
  cli('exact-intent', 'find', 'label', 'Typed native intent (JSON)', 'fill', JSON.stringify(setup.input.intentA));
  cli('reason', 'find', 'label', 'Reason for the proposed change', 'fill', 'Exact independently registered pointer and keyboard equivalence');
  // A native select has its own supported command, not a field-value assignment.
  cli('select-original-grant', 'select', control + ' form label:last-of-type select', '0');
  click('native-pointer', 'Record private scenario');
  wait('pointer-response', `window.__v5Proof.responses.filter(r=>r.operation==='branch'&&r.status===200).length===1`);
  wait('submit-reenabled', `!!document.querySelector(${JSON.stringify(control + ' button[type="submit"]')})&&document.querySelector(${JSON.stringify(control + ' button[type="submit"]')}).matches(':enabled')`);
  cli('native-submit-focus', 'focus', control + ' button[type="submit"]');
  wait('native-submit-focused', `document.activeElement===document.querySelector(${JSON.stringify(control + ' button[type="submit"]')})`);
  cli('native-enter', 'press', 'Enter');
  wait('keyboard-response', `window.__v5Proof.responses.filter(r=>r.operation==='branch'&&r.status===200).length===2`);
  const inputProof = evaluate<{ pointer: { branchId: string; trusted: boolean }; keyboard: { branchId: string; trusted: boolean } }>('native-proof', `(() => {
    const p=window.__v5Proof,r=p.responses.filter(x=>x.operation==='branch'&&x.status===200);
    return {pointer:{branchId:r[0].branchId,trusted:p.events.some(e=>e.type==='click'&&e.trusted&&e.text?.includes('Record private scenario'))},
      keyboard:{branchId:r[1].branchId,trusted:p.events.some(e=>e.type==='keydown'&&e.trusted&&e.key==='Enter'&&e.target==='BUTTON')}};
  })()`);
  assert(inputProof.pointer.trusted && inputProof.keyboard.trusted);
  assert.notEqual(inputProof.pointer.branchId, inputProof.keyboard.branchId);
  cli('offline-on', 'set', 'offline', 'on'); offline = true;
  wait('offline-retracted', `!navigator.onLine&&!document.querySelector(${JSON.stringify(control + ' form')})`);
  const offlineProof = evaluate('offline-observed', `({privateControlsCleared:!document.querySelector(${JSON.stringify(control + ' form')}),navigatorOnline:navigator.onLine,branchCount:window.__v5Proof.responses.filter(r=>r.operation==='branch').length})`);
  cli('offline-off', 'set', 'offline', 'off'); offline = false;
  cli('reconnect-read-only', 'wait', '--text', 'Connected. Reopen an authorized snapshot');
  const reconnect = evaluate<{ branchCount: number; privateControlsStillCleared: boolean }>('reconnect-observed',
    `({privateControlsStillCleared:!document.querySelector(${JSON.stringify(control + ' form')}),branchCount:window.__v5Proof.responses.filter(r=>r.operation==='branch').length})`);
  assert.equal(reconnect.branchCount, 2); assert(reconnect.privateControlsStillCleared);
  click('reopen-before-signout', 'Open direct controls for this Work');
  cli('private-signout-precondition', 'wait', '--text', 'Preserved scenario branch');
  await save('browser-partner-proof.json', evaluate('partner-receipt', `({events:window.__v5Proof.events,responses:window.__v5Proof.responses})`));
  cli('original-account-menu', 'click', 'summary[aria-label="Account menu"]');
  click('original-sign-out', 'Sign out');
  wait('signout-retracted', `!document.querySelector(${JSON.stringify(control)})`);
  const signOut = evaluate<{ privateControlsCleared: boolean }>('signout-observed', `({privateControlsCleared:!document.querySelector(${JSON.stringify(control)}),url:location.href})`);
  assert(signOut.privateControlsCleared);
  login(finance.email, 'finance');
  openControl('finance');
  const otherActor = evaluate<{ privateBranchesVisible: boolean }>('finance-observed', `(() => {
    const region=document.querySelector(${JSON.stringify(control)}),text=region.innerText;
    return {privateBranchesVisible:${JSON.stringify([inputProof.pointer.branchId, inputProof.keyboard.branchId])}.some(id=>text.includes(id)||text.includes(id.slice(0,8))),
      permittedControlPresent:!!region,branchOptions:Array.from(region.querySelectorAll('select')).at(-1)?.innerText};
  })()`);
  assert.equal(otherActor.privateBranchesVisible, false);
  const proof = { ...inputProof, offline: offlineProof, reconnect, signOut, otherActor,
    sourceSha256: createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'),
    commands, elapsedMs: performance.now() - started, primaryPage: setup.url, handlerCallsOrHttpMocks: false,
    qualification: 'BOUNDED_NATIVE_PRIMARY_PAGE_SUBSTORY_NOT_FULL_A_I_OR_FIELD_GAIN' };
  await save('browser-proof.json', proof);
  await save('browser-supervisor-result.json', { status: 'PASS', elapsedMs: proof.elapsedMs, commands });
  console.log(JSON.stringify({ status: 'PASS', evidenceDirectory: out, elapsedMs: proof.elapsedMs }));
} catch (error) {
  const failedStep = step;
  let diagnosis: unknown = null;
  try {
    const url = cli('failure-location', 'get', 'url');
    diagnosis = url.startsWith(setup.origin + '/') ? evaluate('failure-form-diagnosis', `({url:location.href,
      email:document.querySelector('input[type="email"]')?.value,submitDisabled:document.querySelector('form button[type="submit"]')?.disabled,
      formValid:document.querySelector('form')?.checkValidity(),
      inputValidity:Array.from(document.querySelectorAll('form input')).map(e=>({type:e.type,valid:e.validity.valid,missing:e.validity.valueMissing,patternMismatch:e.validity.patternMismatch})),
      controlSubmitEnabled:document.querySelector(${JSON.stringify(control + ' button[type="submit"]')})?.matches(':enabled'),
      focus:document.activeElement?.tagName,controlResponses:window.__v5Proof?.responses,controlEvents:window.__v5Proof?.events.slice(-20),
      documentFocused:document.hasFocus(),visibility:document.visibilityState,loginObservation:window.__v5Login,
      buttonGeometry:Array.from(document.querySelectorAll(${JSON.stringify(control + ' button')})).map(b=>{const r=b.getBoundingClientRect();
        return {text:b.innerText,enabled:b.matches(':enabled'),x:r.x,y:r.y,width:r.width,height:r.height,viewport:[innerWidth,innerHeight],
          centerHit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===b};}),
      alerts:Array.from(document.querySelectorAll('[role="alert"],form .text-red-300')).map(e=>e.innerText)})`) : { ownedOrigin: false };
  } catch { diagnosis = { available: false }; }
  await save('browser-supervisor-result.json', { status: 'FAIL', step: failedStep,
    predicate: error instanceof Error ? error.message : 'BROWSER_OBSERVATION_FAILED', diagnosis, commands, elapsedMs: performance.now() - started });
  process.exitCode = 1;
} finally {
  if (offline) {
    try { execFileSync(binary, ['--cdp', process.env.AGENT_BROWSER_CDP!, 'set', 'offline', 'off'],
      { cwd: repo, env: process.env, timeout: 5000, stdio: 'ignore' }); }
    catch { await save('browser-network-restore-failure.json', { restored: false, explicitRestoreRequired: true }); }
  }
  await save('browser-finished.json', { finished: true });
  // The embedded pane belongs to Factory. Never close or reload the desktop app.
}
