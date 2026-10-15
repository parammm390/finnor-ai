import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { open, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type pg from 'pg';
import type { ownedHttp } from './owned-http.mts';

type Context = { repo: string; out: string; admin: pg.Client; http: Awaited<ReturnType<typeof ownedHttp>>;
  actors: Record<string, string>; root: { entityType: string; entityId: string }; openA: any; openB: any;
  branchA: any; branchB: any; story: (id: string, run: () => Promise<unknown>) => Promise<void> };

/** The primary Next application, not a test dashboard. The supervising browser
 * driver must retain real native input/DOM observations in browser-proof.json. */
export async function mountedCampaign(c: Context) {
  const port = await new Promise<number>((yes, no) => {
    const server = createServer(); server.once('error', no);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address(); assert(address && typeof address !== 'string');
      server.close(() => yes(address.port));
    });
  });
  const origin = 'http://127.0.0.1:' + port;
  const input = JSON.parse(await readFile(join(c.out, 'registered-original-inputs.json'), 'utf8'));
  const root = c.root;
  const object = { namespace: 'private_equity', owner: '@finnor/private-equity', type: 'pe_deal', id: input.dealA };
  const params = new URLSearchParams({ root: JSON.stringify(root), object: JSON.stringify(object), workId: c.openA.workId });
  const users = (await c.admin.query('SELECT id,email FROM finnor_os.users WHERE id=ANY($1::uuid[])',
    [[c.actors.partner, c.actors.finance]])).rows;
  const log = await open(join(c.out, 'primary-next.log'), 'w', 0o600);
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: c.repo, env: { ...process.env, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1',
      NEXT_PUBLIC_SUPABASE_URL: c.http.authOrigin, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'v5-disposable-browser-key',
      NEXT_PUBLIC_OS_API_URL: c.http.origin, FINNOR_OS_API_URL: c.http.origin },
    stdio: ['ignore', log.fd, log.fd],
  });
  await log.close();
  const sleep = (ms: number) => new Promise<void>(yes => setTimeout(yes, ms));
  let supervisor: ReturnType<typeof spawn> | undefined;
  try {
    const deadline = performance.now() + 60000;
    let ready = false;
    while (performance.now() < deadline && child.exitCode === null) {
      try { ready = (await fetch(origin + '/centropy/login', { signal: AbortSignal.timeout(5000) })).ok; } catch { /* Cold compilation is not an input-latency sample. */ }
      if (ready) break;
      await sleep(250);
    }
    assert(ready, 'PRIMARY_NEXT_START_FAILED');
    const setup = { origin, url: origin + '/centropy/world?' + params, users, actors: c.actors, input,
      profile: 'ACTUAL_PRIMARY_NEXT_HTTP_AND_ORIGINAL_OWNERS_WITH_DISPOSABLE_CRYPTOGRAPHIC_ISSUER',
      hostedSupabaseQualified: false, browserProofPath: join(c.out, 'browser-proof.json'),
      completionSignal: join(c.out, 'browser-finished.json') };
    await writeFile(join(c.out, 'mounted-ready.json'), JSON.stringify(setup, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ mountedReady: join(c.out, 'mounted-ready.json'), frontendPid: child.pid }));
    const supervisorLog = await open(join(c.out, 'browser-supervisor.log'), 'w', 0o600);
    supervisor = spawn(process.execPath, ['--import=tsx', join(c.repo, 'finnor-os/scripts/v5/browser-supervisor.mts'),
      '--ready', join(c.out, 'mounted-ready.json')], { cwd: join(c.repo, 'finnor-os'), env: process.env,
      stdio: ['ignore', supervisorLog.fd, supervisorLog.fd] });
    await supervisorLog.close();
    const until = performance.now() + 600000;
    let finished = false;
    while (performance.now() < until && child.exitCode === null) {
      try { const signal = JSON.parse(await readFile(setup.completionSignal, 'utf8')); finished = signal.finished === true; } catch { /* Supervisor has not finished native input yet. */ }
      if (finished) break;
      await sleep(250);
    }
    assert(finished, 'BOUNDED_PRIMARY_BROWSER_PROOF_NOT_FINISHED');
    await c.story('I-primary-native-pointer-keyboard-and-private-scope', async () => {
      const supervised = JSON.parse(await readFile(join(c.out, 'browser-supervisor-result.json'), 'utf8'));
      assert.equal(supervised.status, 'PASS', 'REGISTERED_BROWSER_SUPERVISOR_FAILED');
      const proof = JSON.parse(await readFile(setup.browserProofPath, 'utf8'));
      assert(proof.pointer?.branchId && proof.keyboard?.branchId && proof.pointer.branchId !== proof.keyboard.branchId,
        'TWO_ACTUAL_PRIMARY_FORM_SUBMISSIONS_REQUIRED');
      const branches = (await c.admin.query(`SELECT b.id,c.principal_id,c.intent FROM finnor_os.v5_branches b
        JOIN finnor_os.v5_branch_custody c ON c.branch_id=b.id WHERE b.id=ANY($1::uuid[])`,
        [[proof.pointer.branchId, proof.keyboard.branchId]])).rows;
      assert.equal(branches.length, 2); assert(branches.every(b => b.principal_id === c.actors.partner));
      assert.deepEqual(branches[0].intent, branches[1].intent);
      assert.equal(proof.offline?.privateControlsCleared, true);
      assert.equal(proof.signOut?.privateControlsCleared, true);
      assert.equal(proof.otherActor?.privateBranchesVisible, false);
      return { proof, canonicalBranches: branches, frontendPid: child.pid, physicalBrowser: 'NATIVE_PRIMARY_PAGE',
        limitation: 'This bounded substory does not qualify every A/I clause or protected team gain.' };
    });
  } finally {
    if (supervisor && supervisor.exitCode === null) supervisor.kill('SIGTERM');
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise<void>(yes => child.once('exit', () => yes())), sleep(5000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
}
