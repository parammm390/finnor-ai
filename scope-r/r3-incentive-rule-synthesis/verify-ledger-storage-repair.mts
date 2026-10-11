/** Physical faults against the just-completed signed receiver and its original history. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

const repo = resolve(import.meta.dirname, '../..'), input = resolve(process.argv[2]), out = resolve(process.argv[3]);
await mkdir(out, { recursive: false });
const proof = JSON.parse(await readFile(join(input, 'native-ledger/boundaries.json'), 'utf8'));
const diagnosis = JSON.parse(await readFile(join(input, 'native-ledger/receiver-diagnostics.json'), 'utf8'));
const result = JSON.parse(await readFile(join(input, 'results.json'), 'utf8'));
assert(result.cases.some((c: any) => c.id === 'native-experience-delivery' && c.status === 'PASS'));
const root = resolve(dirname(diagnosis.journal.path), '..'), configPath = join(root, 'ledger.json');
const configBytes = await readFile(configPath), config = JSON.parse(configBytes.toString());
const owners = JSON.parse(await readFile(join(root, 'owner.json'), 'utf8')).policy;
const target = proof.events[0], route = owners.routes.find((r: any) => r.semanticOwner === target.event.semanticOwner
  && r.principalId === target.event.principalId && r.tenantId === target.event.tenantId);
assert(route && route.requestTimeoutMs === 2000 && route.leaseMs === 5000);
// The client adds qualification metadata after authenticating these two fields.
// The receiver's wire body contains the exact event and protected receipt.
const expectedWireBody = { event: target.event, receipt: target.receipt };
config.port = Number(new URL(route.ledger.endpoint).port);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const sourceFiles = ['ledger.ts', 'ledger-server.mts', 'protocol.ts', 'request-verifier.ts', 'adapter-contract.ts'];
const cut = async () => Promise.all(sourceFiles.map(async name => ({ name,
  sha256: sha(await readFile(join(repo, 'finnor-os/packages/governed-execution/src', name))) })));
const sourcesBefore = await cut(), startedAt = new Date().toISOString();
let child: ChildProcess | undefined, logs = '', corrupted: { path: string; bytes: Buffer } | undefined;
const observations: any[] = [];
async function request(path: string, body?: unknown) {
  const token = await readFile(route.tokenPath, 'utf8'), begun = performance.now();
  const response = await fetch(route.ledger.endpoint + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(2000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  return { status: response.status, body: value, elapsedMs: performance.now() - begun };
}
try {
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  child = spawn(process.execPath, ['--import=tsx', join(repo, 'finnor-os/packages/governed-execution/src/ledger-server.mts')], {
    cwd: join(repo, 'finnor-os'), env: { PATH: process.env.PATH, HOME: root,
      FINNOR_S6_LEDGER_CONFIG: configPath, FINNOR_S6_LEDGER_RELEASE_ROOT: proof.reviewerPublicKey }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((yes, no) => {
    const timer = setTimeout(() => no(Error('LEDGER_RESTART_BOOT_BOUND')), 15000);
    child!.stdout!.on('data', bytes => {
      logs = (logs + bytes).slice(-16384);
      if (logs.split('\n').some(line => { try { return JSON.parse(line).status === 'READY' } catch { return false } })) {
        clearTimeout(timer); yes();
      }
    });
    child!.stderr!.on('data', bytes => { logs = (logs + bytes).slice(-16384) });
    child!.once('exit', () => { clearTimeout(timer); no(Error('LEDGER_RESTART_EXIT:' + logs)) });
  });
  const eventPath = '/events/' + encodeURIComponent(target.event.eventId);
  const before = await request(eventPath);
  assert.equal(before.status, 200); assert.deepEqual(before.body, expectedWireBody);
  observations.push({ id: 'physical-restart-exact-original-readback', ...before });
  const requestPath = join(root, 'ordinary', target.receipt.contentFile);
  const originalRequest = JSON.parse((await readFile(requestPath)).toString());
  const journalBefore = await readFile(diagnosis.journal.path);
  const unrelated = proof.journal.find((receipt: any) => receipt.contentFile !== target.receipt.contentFile);
  assert(unrelated);
  const path = join(root, 'ordinary', unrelated.contentFile), bytes = await readFile(path);
  corrupted = { path, bytes }; await writeFile(path, '{}');
  const blockedRead = await request(eventPath), blockedReplay = await request('/append', originalRequest);
  assert.equal(blockedRead.status, 503); assert.equal(blockedRead.body.error, 'COMMITTED_CONTENT_CHANGED');
  assert.equal(blockedReplay.status, 503); assert.equal(blockedReplay.body.error, 'COMMITTED_CONTENT_CHANGED');
  assert.equal(sha(await readFile(diagnosis.journal.path)), sha(journalBefore));
  observations.push({ id: 'unrelated-content-tamper-refuses-read-and-append', file: unrelated.contentFile,
    originalSha256: sha(bytes), blockedRead, blockedReplay, journalSha256: sha(journalBefore) });
  await writeFile(path, bytes); corrupted = undefined;
  const restored = await request(eventPath), replay = await request('/append', originalRequest);
  assert.equal(restored.status, 200); assert.deepEqual(restored.body, expectedWireBody);
  assert.equal(replay.status, 200); assert.deepEqual(replay.body.receipt, target.receipt);
  assert.equal(sha(await readFile(diagnosis.journal.path)), sha(journalBefore));
  observations.push({ id: 'restored-original-bytes-and-no-new-replay-commitment', restored, replay });
  assert.deepEqual(await cut(), sourcesBefore);
} catch (error) {
  observations.push({ id: 'ledger-storage-repair', status: 'FAIL', error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally {
  if (corrupted) await writeFile(corrupted.path, corrupted.bytes);
  if (child?.exitCode === null && child.signalCode === null) await new Promise<void>(yes => {
    const timer = setTimeout(() => child!.kill('SIGKILL'), 10000);
    child!.once('exit', () => { clearTimeout(timer); yes() }); child!.kill('SIGTERM');
  });
  await writeFile(configPath, configBytes);
  await writeFile(join(out, 'results.json'), JSON.stringify({ schema: 'finnor.r3.ledger-storage-repair.v1',
    status: process.exitCode ? 'FAIL' : 'PASS', startedAt, finishedAt: new Date().toISOString(), observations,
    sourceCut: sourcesBefore, receiverLogs: logs, originalConfigRestoredSha256: sha(await readFile(configPath)),
    requestTimeoutMs: 2000, leaseMs: 5000, protectedAdmission: false,
    qualification: 'ACTUAL_SIGNED_RECEIVER_ORIGINAL_HISTORY_PHYSICAL_CORRUPTION_AND_RESTART_NOT_PRODUCTION_ADMISSION',
    rerun: 'node --import=tsx scope-r/r3-incentive-rule-synthesis/verify-ledger-storage-repair.mts <completed-owner-run> <new-evidence-dir>',
  }, null, 2) + '\n');
}
