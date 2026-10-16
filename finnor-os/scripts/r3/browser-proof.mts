/** Mounted existing Work, real SDK login/proxy/owners, no intercepted business responses. */
import { strict as assert } from 'node:assert';
import { spawn, execFile } from 'node:child_process';
import { writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export async function proveMountedWork(input: {
  repo: string; output: string; apiOrigin: string; authOrigin: string;
  ownerEmail: string; foreignEmail: string; threadId: string; alternateThreadId: string;
  requestId: string; rule: any; objective: string;
  delayRead: () => { arrival: Promise<void>; release: () => void };
  revise: () => Promise<unknown>;
}) {
  const port = await new Promise<number>((yes, no) => {
    const server = createServer(); server.once('error', no); server.listen(0, '127.0.0.1', () => {
      const address = server.address(); if (!address || typeof address === 'string') return no(Error('BROWSER_PORT'));
      server.close(() => yes(address.port));
    });
  });
  const origin = 'http://127.0.0.1:' + port, steps: any[] = [];
  let logs = '';
  const web = spawn(process.execPath, [join(input.repo, 'node_modules/next/dist/bin/next'),
    'dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: input.repo, env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development',
      NEXT_TELEMETRY_DISABLED: '1', FINNOR_OS_API_URL: input.apiOrigin,
      NEXT_PUBLIC_SUPABASE_URL: input.authOrigin, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'r3-disposable-publishable-key',
      AUTH_DEV_BYPASS: '0', CENTROPY_TEST_MODE: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logPath = join(input.output, 'web.log');
  const log = (b: Buffer) => { logs += b; void appendFile(logPath, b) };
  web.stdout!.on('data', log); web.stderr!.on('data', log);
  const flags = process.env.AGENT_BROWSER_CDP ? ['--cdp', process.env.AGENT_BROWSER_CDP] : [];
  const browserEnv = { ...process.env };
  if (!browserEnv.AGENT_BROWSER_SESSION) {
    const session = await execute('agent-browser', ['session', 'id', '--scope', 'worktree', '--prefix', 'r3-mounted'],
      { cwd: input.repo, env: browserEnv });
    browserEnv.AGENT_BROWSER_SESSION = session.stdout.trim();
  }
  async function browser(args: string[], sensitive = false) {
    const started = performance.now();
    let result;
    try {
      result = await execute('agent-browser', [...flags, '--json', ...args],
        { cwd: input.repo, env: browserEnv, timeout: 60000, maxBuffer: 1024 * 1024 });
    } catch (error: any) {
      steps.push({ command: sensitive ? ['fill', 'FIXTURE_PASSWORD_INPUT'] : args,
        elapsedMs: performance.now() - started, failed: true,
        output: sensitive ? 'FIXTURE_INPUT_FAILURE' : error.stdout, stderr: error.stderr });
      await writeFile(join(input.output, 'browser-steps.json'), JSON.stringify({ steps }, null, 2) + '\n');
      throw error;
    }
    steps.push({ command: sensitive ? ['fill', 'FIXTURE_PASSWORD_INPUT'] : args,
      elapsedMs: performance.now() - started, output: sensitive ? 'FIXTURE_INPUT_FILLED' : result.stdout, stderr: result.stderr });
    await writeFile(join(input.output, 'browser-steps.json'), JSON.stringify({ steps }, null, 2) + '\n');
    const parsed = JSON.parse(result.stdout); if (parsed.success === false) throw Error(result.stdout);
    return parsed.data?.result ?? parsed.data;
  }
  const page = (threadId = input.threadId) => origin + '/centropy/investigations/' + threadId + '?elicitationRequest=' + input.requestId;
  async function clickText(text: string) {
    await browser(['eval', `(() => {
      if (location.origin !== ${JSON.stringify(origin)}) throw Error('R3_DISPOSABLE_PAGE_REQUIRED');
      const buttons = Array.from(document.querySelectorAll('button')).filter(b=>b.innerText.trim()===${JSON.stringify(text)});
      if (buttons.length !== 1 || buttons[0].disabled) throw Error('R3_EXACT_ENABLED_BUTTON_REQUIRED');
      buttons[0].click(); return true;
    })()`]);
  }
  async function canvas() {
    await browser(['wait', '--fn', "Array.from(document.querySelectorAll('button')).some(b=>b.innerText.trim()==='Canvas')"]);
    await clickText('Canvas');
  }
  let screenshotUnavailable = Boolean(process.env.AGENT_BROWSER_CDP);
  async function capture(name: string) {
    const snapshot = await browser(['snapshot']);
    await writeFile(join(input.output, name + '.snapshot.json'), JSON.stringify(snapshot, null, 2) + '\n');
    if (!screenshotUnavailable) {
      try { await browser(['screenshot', '--full', join(input.output, name + '.png')]) }
      catch { screenshotUnavailable = true }
    }
  }
  async function login(email: string) {
    await browser(['open', origin + '/centropy/login']);
    await browser(['wait', '--text', 'Sign in to CENTROPY']);
    await browser(['wait', '--fn', "!document.querySelector('button[type=submit]').disabled"]);
    // An attached Electron pane can route native key events to its outer window.
    // Bind DOM input events to these exact fixture controls instead. The actual
    // LoginForm and Supabase SDK still perform sign-in; no token is injected.
    await browser(['eval', `(() => {
      if (location.origin !== ${JSON.stringify(origin)} || location.pathname !== '/centropy/login')
        throw Error('R3_EXACT_DISPOSABLE_LOGIN_PAGE_REQUIRED');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      for (const [id, value] of [['centropy-login-email', ${JSON.stringify(email)}],
        ['centropy-login-password', 'r3-disposable-local-only']]) {
        const field = document.getElementById(id); if (!field) throw Error('R3_LOGIN_CONTROL_REQUIRED');
        set.call(field, value); field.dispatchEvent(new Event('input', {bubbles:true}));
        field.dispatchEvent(new Event('change', {bubbles:true}));
      }
      return true;
    })()`], true);
    assert.equal(await browser(['eval', `document.querySelector('#centropy-login-email').value === ${JSON.stringify(email)} &&
      document.querySelector('#centropy-login-password').value.length > 0 &&
      !document.querySelector('button[type=submit]').disabled`]), true);
    await browser(['eval', `document.querySelector('form').requestSubmit()`]);
    await browser(['wait', '--fn', "location.pathname.startsWith('/centropy') && !location.pathname.includes('/login')"]);
  }
  async function signOut() {
    await browser(['eval', `document.querySelector('summary[aria-label="Account menu"]').click()`]);
    await clickText('Sign out');
    await browser(['wait', '--fn', "!document.querySelector('section[aria-label=\"Proposed elicitation rule\"] table')"]);
  }
  async function checkedTable() {
    await browser(['wait', '--text', 'Accepted box upper / unresolved gap']);
    await clickText('Inspect complete table, source and schedule witnesses');
    const actual = await browser(['eval', `JSON.stringify(Array.from(document.querySelectorAll('section[aria-label="Proposed elicitation rule"] table tbody tr')).map(r=>({reports:r.cells[0].innerText,outcome:r.cells[1].innerText,schedule:r.cells[2].innerText})))`]);
    const rows = typeof actual === 'string' ? JSON.parse(actual) : actual;
    assert.equal(rows.length, 81);
    for (let i = 0; i < rows.length; i++) {
      const expected = input.rule.table[i], row = rows[i];
      assert.equal(row.reports, expected.reports.join(', ')); assert.equal(row.outcome, expected.outcomeId);
      for (const s of expected.schedule) {
        const amount = s.amount.denominator === '1' ? s.amount.numerator : s.amount.numerator + '/' + s.amount.denominator;
        assert(row.schedule.includes(`${s.partyId}: ${amount} ${s.currency} at ${s.dueAt}`));
      }
    }
    return rows;
  }
  try {
    const until = Date.now() + 120000;
    for (;;) {
      if (web.exitCode !== null) throw Error('ACTUAL_WEB_BOOT_EXIT:' + logs);
      try { if ((await fetch(origin + '/centropy/login')).ok) break } catch { /* bounded cold compilation */ }
      assert(Date.now() < until, 'ACTUAL_WEB_BOOT_BOUND');
      await new Promise<void>(yes => setTimeout(yes, 250));
    }
    // Compile the existing authenticated shell as preparation, not inside a
    // product response or by extending its owner request/episode limits.
    const preparationStarted = performance.now();
    const prepared = await fetch(page(), { signal: AbortSignal.timeout(120000) });
    assert(prepared.ok, 'ACTUAL_WORK_ROUTE_PREPARATION');
    steps.push({ command: ['prepare', 'ACTUAL_WORK_ROUTE'], status: prepared.status,
      elapsedMs: performance.now() - preparationStarted });
    await login(input.ownerEmail); await browser(['open', page()]); await canvas();
    const originalRows = await checkedTable();
    await capture('mounted-rule');
    await browser(['open', page()]);
    await canvas();
    const reloadedRows = await checkedTable(); assert.deepEqual(reloadedRows, originalRows);
    await capture('durable-reload');

    const delayed = input.delayRead();
    await browser(['open', page()]);
    await canvas();
    await Promise.race([delayed.arrival, new Promise<never>((_, no) => setTimeout(() => no(Error('ACTUAL_DELAYED_READ_NOT_REACHED')), 25000))]);
    await browser(['open', page(input.alternateThreadId)]);
    await canvas();
    delayed.release();
    await browser(['wait', '--text', 'Proposed elicitation rule']);
    await browser(['wait', '--fn', "!document.querySelector('section[aria-label=\"Proposed elicitation rule\"] table')"]);
    await browser(['wait', '--text', 'Private values cleared.']);
    assert.equal(await browser(['eval', `document.body.innerText.includes(${JSON.stringify(input.requestId)})`]), false);
    await capture('work-switch-cleared');

    await browser(['open', page()]); await canvas(); await checkedTable();
    await signOut(); await login(input.foreignEmail); await browser(['open', page()]);
    await browser(['wait', '--text', 'conversation_thread_not_found']);
    assert.equal(await browser(['eval', `document.body.innerText.includes('Accepted box upper / unresolved gap')`]), false);
    await capture('foreign-tenant-cleared');
    await signOut(); await login(input.ownerEmail); await browser(['open', page()]); await canvas(); await checkedTable();
    const revision = await input.revise();
    await browser(['wait', '--text', 'INVALIDATED']);
    await browser(['wait', '--fn', "!document.querySelector('section[aria-label=\"Proposed elicitation rule\"] table')"]);
    await capture('revision-cleared');
    return { status: 'PASS', actualBrowser: process.env.AGENT_BROWSER_CDP ? 'ASSIGNED_DESKTOP_PANE' : 'OWNED_BROWSER_SESSION',
      actualWebPid: web.pid, originalRows, reloadedRows, revision, steps,
      authentication: 'REAL_SUPABASE_SDK_SIGNED_BEARER', ownerResponsesIntercepted: false,
      screenshots: screenshotUnavailable ? 'CAPTURE_NOT_REATTEMPTED_AFTER_RETAINED_CDP_TIMEOUTS' : 'CAPTURED',
      initialResponseFloorSeconds: 30 };
  } catch (error) {
    await capture('failure').catch(() => undefined);
    throw error;
  } finally {
    await writeFile(join(input.output, 'browser-steps.json'), JSON.stringify({ steps }, null, 2) + '\n');
    await writeFile(join(input.output, 'web.log'), logs);
    if (web.exitCode === null && web.signalCode === null) {
      await new Promise<void>(yes => { const timer = setTimeout(() => web.kill('SIGKILL'), 10000);
        web.once('exit', () => { clearTimeout(timer); yes() }); web.kill('SIGTERM') });
    }
    if (!process.env.AGENT_BROWSER_CDP) await browser(['close']).catch(() => undefined);
  }
}
