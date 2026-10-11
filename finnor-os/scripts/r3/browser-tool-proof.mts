/** Bounded tool-driven browser proof. The product receives no fault/test hooks. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { proveMountedWork } from './browser-proof.mjs';

type BrowserPreparationInput = Pick<Parameters<typeof proveMountedWork>[0],
  'repo' | 'output' | 'apiOrigin' | 'authOrigin' | 'threadId' | 'ownerEmail'> & {prepublication?:boolean};
export async function prepareMountedWorkWithTools(input: BrowserPreparationInput) {
  const started = performance.now();
  const port = await new Promise<number>((yes, no) => {
    const s = createServer(); s.once('error', no); s.listen(0, '127.0.0.1', () => {
      const a = s.address(); if (!a || typeof a === 'string') return no(Error('R3_BROWSER_OWNED_PORT_REQUIRED'));
      s.close(() => yes(a.port));
    });
  });
  const origin = 'http://127.0.0.1:' + port, log = join(input.output, 'web.log');
  const web = spawn(process.execPath, [join(input.repo, 'node_modules/next/dist/bin/next'),
    'dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: input.repo, env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development',
      NEXT_TELEMETRY_DISABLED: '1', FINNOR_OS_API_URL: input.apiOrigin,
      NEXT_PUBLIC_SUPABASE_URL: input.authOrigin, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'r3-disposable-publishable-key',
      AUTH_DEV_BYPASS: '0', CENTROPY_TEST_MODE: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  web.stdout!.on('data', bytes => void appendFile(log, bytes));
  web.stderr!.on('data', bytes => void appendFile(log, bytes));
  async function close() {
    if (web.exitCode === null && web.signalCode === null) await new Promise<void>(yes => {
      const timer = setTimeout(() => web.kill('SIGKILL'), 5000);
      web.once('exit', () => { clearTimeout(timer); yes() }); web.kill('SIGTERM');
    });
  }
  try {
    const until = Date.now() + 240000;
    for (;;) {
      assert(web.exitCode===null&&web.signalCode===null,'R3_BROWSER_WEB_EXITED');
      const response=await fetch(origin+'/centropy/login',{signal:AbortSignal.timeout(120000)}).catch(()=>null);
      if(response?.ok)break;
      assert(Date.now()<until,'R3_BROWSER_WEB_PREPARATION_BOUND');
      await new Promise<void>(yes=>setTimeout(yes,250));
    }
    const page = origin + '/centropy/investigations/' + input.threadId;
    assert((await fetch(page, {signal:AbortSignal.timeout(120000)})).ok);
    if(input.prepublication!==true)return {origin,web,close};
    await writeFile(join(input.output,'preparation-session.json'),JSON.stringify({origin,login:origin+'/centropy/login',page,
      ownerEmail:input.ownerEmail,password:'r3-disposable-local-only',pid:web.pid,
      deadlineAt:new Date(until).toISOString(),phase:'PREPARATION_BEFORE_M3_AND_R3_PUBLICATION',
      operation:'prepared',functionalPass:false},null,2)+'\n');
    for (;;) {
      const command = await readFile(join(input.output,'preparation-command.json'),'utf8').then(JSON.parse).catch(()=>null);
      if(command?.operation==='prepared') {
        assert.equal(command.tableCount,0);
        assert(command.snapshot.includes('Proposed elicitation rule'));
        assert(command.snapshot.includes('Review supplied finite commercial mechanism'));
        await writeFile(join(input.output,'preparation-receipt.json'),JSON.stringify({command,elapsedMs:performance.now()-started,
          originalGrantsExtended:false,publishedM3OrR3AtPreparation:false,usd:null,aggregateMemory:null},null,2)+'\n');
        return {origin,web,close};
      }
      assert(Date.now()<until,'R3_BROWSER_PREPUBLICATION_PREPARATION_BOUND');
      assert(web.exitCode===null&&web.signalCode===null,'R3_BROWSER_WEB_EXITED');
      await new Promise<void>(yes=>setTimeout(yes,100));
    }
  } catch(error) {await close();throw error;}
}
export async function proveMountedWorkWithTools(input: Parameters<typeof proveMountedWork>[0] & {
  prepared?:Awaited<ReturnType<typeof prepareMountedWorkWithTools>>
}) {
  const prepared = input.prepared ?? await prepareMountedWorkWithTools({...input,prepublication:false});
  const {origin,web} = prepared;
  const page = (id: string) => origin + '/centropy/investigations/' + id + '?elicitationRequest=' + input.requestId;
  const observations: any[] = [], started = performance.now();
  let delayed: ReturnType<typeof input.delayRead> | undefined, delayedArrived = false, revision: unknown;
  async function save(name: string, body: unknown) {
    await writeFile(join(input.output, name + '.json'), JSON.stringify(body, null, 2) + '\n');
  }
  try {
    const preparationUntil = Date.now() + 120000;
    for (;;) {
      if (web.exitCode !== null) throw Error('R3_BROWSER_WEB_EXITED');
      const response = await fetch(origin + '/centropy/login').catch(() => null);
      if (response?.ok) break;
      assert(Date.now() < preparationUntil, 'R3_BROWSER_WEB_PREPARATION_BOUND');
      await new Promise<void>(yes => setTimeout(yes, 250));
    }
    assert((await fetch(page(input.threadId), { signal: AbortSignal.timeout(120000) })).ok);
    await save('tool-session', { origin, login: origin + '/centropy/login', page: page(input.threadId),
      alternatePage: page(input.alternateThreadId), ownerEmail: input.ownerEmail, foreignEmail: input.foreignEmail,
      password: 'r3-disposable-local-only', requestId: input.requestId,
      observedInputs: 'Synthetic local credentials; actual LoginForm and SDK; never inject a token',
      commands: ['mounted', 'reload', 'arm-delay', 'await-delay', 'release-delay', 'work-cleared', 'foreign-cleared', 'revise', 'revision-cleared', 'finish'],
      deadlineAt: new Date(Date.now() + 600000).toISOString(), pid: web.pid });
    const until = Date.now() + 600000; let sequence = 0;
    while (Date.now() < until) {
      const command = await readFile(join(input.output, 'tool-command.json'), 'utf8').then(JSON.parse).catch(() => null);
      if (!command || command.sequence !== sequence + 1) { await new Promise<void>(yes => setTimeout(yes, 100)); continue }
      sequence++;
      const operation = command.operation;
      if (operation === 'arm-delay') { assert(!delayed); delayed = input.delayRead() }
      else if (operation === 'await-delay') {
        assert(delayed); await Promise.race([delayed.arrival,
          new Promise<never>((_, no) => setTimeout(() => no(Error('R3_ACTUAL_DELAYED_READ_BOUND')), 25000))]);
        delayedArrived = true;
      } else if (operation === 'release-delay') { assert(delayedArrived); delayed!.release() }
      else if (operation === 'revise') { assert(!revision); revision = await input.revise() }
      else if (['mounted', 'reload'].includes(operation)) {
        assert.equal(command.cells?.length, 243);
        assert(command.snapshot.includes('Accepted box upper / unresolved gap'));
        for (let i = 0; i < 81; i++) {
          const row = input.rule.table[i];
          assert.equal(command.cells[i * 3], row.reports.join(', '));
          assert.equal(command.cells[i * 3 + 1], row.outcomeId);
          for (const s of row.schedule) {
            const amount = s.amount.denominator === '1' ? s.amount.numerator : s.amount.numerator + '/' + s.amount.denominator;
            assert(command.cells[i * 3 + 2].includes(`${s.partyId}: ${amount} ${s.currency} at ${s.dueAt}`));
          }
        }
        if (operation === 'reload') assert.deepEqual(command.cells, observations.find(o => o.operation === 'mounted').cells);
      } else if (['work-cleared', 'foreign-cleared', 'revision-cleared'].includes(operation)) {
        assert.equal(command.tableCount, 0);
        if (operation !== 'revision-cleared') assert(!command.snapshot.includes(input.requestId));
        if (operation === 'work-cleared') { assert(delayedArrived); assert(command.snapshot.includes('Private values cleared.')) }
        if (operation === 'foreign-cleared') assert(command.snapshot.includes('conversation_thread_not_found'));
        if (operation === 'revision-cleared') { assert(revision); assert(command.snapshot.includes('INVALIDATED')) }
      } else if (operation === 'finish') {
        for (const required of ['mounted', 'reload', 'work-cleared', 'foreign-cleared', 'revision-cleared'])
          assert(observations.some(o => o.operation === required), required);
        await save('tool-receipt', { status: 'PASS', observations, actualWebPid: web.pid, elapsedMs: performance.now() - started });
        return { status: 'PASS', actualBrowser: 'CODEX_CONNECTED_BROWSER', observations,
          originalRows: 81, reloadedRows: 81, revision, delayedActualOwnerReply: true,
          authentication: 'REAL_SUPABASE_SDK_SIGNED_BEARER', ownerResponsesIntercepted: false };
      } else throw Error('R3_BROWSER_UNSUPPORTED_COMMAND');
      observations.push({ ...command, at: new Date().toISOString() });
      await save('tool-observations', observations); await save('tool-response', { sequence, operation, status: 'PASS' });
    }
    throw Error('R3_BROWSER_FINITE_DRIVER_BOUND');
  } finally {
    delayed?.release();
    await prepared.close();
  }
}
