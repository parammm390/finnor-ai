/// <reference path="./node-sqlite.d.ts" />
import { DatabaseSync } from 'node:sqlite';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { decode, fault, FinancingStep, hash } from './contracts';
export interface FixtureState {
  schema: 'finnor.financing-fixture-state.v1'; rows: Array<{ id: string; name: string; feeCents: number; memo: string | null; submitted: boolean }>;
  effects: Array<{ id: string; operation: string; requestDigest: string; response: any }>;
  visits: number; file: string;
}
export const baselineState = (): FixtureState => ({
  schema: 'finnor.financing-fixture-state.v1',
  rows: [{ id: 'C_01', name: 'Same company', feeCents: 20000, memo: 'Original', submitted: false }, { id: 'C_010', name: 'Same company', feeCents: 20000, memo: null, submitted: false }],
  effects: [], visits: 0, file: 'baseline-v1',
});
function validState(s: FixtureState) {
  if (!s || s.schema !== 'finnor.financing-fixture-state.v1' || s.rows.length !== 2 || s.rows.map(r => r.id).sort().join() !== 'C_01,C_010' || s.effects.length > 256 || !Number.isInteger(s.visits) || typeof s.file !== 'string' || s.file.length > 4096) fault('FIXTURE_STATE_INVALID');
  for (const r of s.rows) if (!Number.isInteger(r.feeCents) || r.feeCents < 0 || r.feeCents > 20000 || (r.memo !== null && typeof r.memo !== 'string') || typeof r.submitted !== 'boolean') fault('FIXTURE_STATE_INVALID');
  if (new Set(s.effects.map(e => e.id)).size !== s.effects.length) fault('FIXTURE_EFFECT_DUPLICATE');
}
export interface FixtureApp {
  identity: string; server: Server; port: number; state(): Promise<FixtureState>; close(): Promise<void>;
}
/** Real private SQLite+file application. It is NOT production financing or S6 settlement. */
export async function createFixtureApp(baseline: FixtureState, directory: string, options: { afterCommit?: (effectId: string) => Promise<void> } = {}): Promise<FixtureApp> {
  validState(baseline);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) fault('FIXTURE_DIRECTORY_UNSAFE');
  const dbPath = join(directory, 'financing.sqlite'), filePath = join(directory, 'application.txt');
  try { await lstat(dbPath); fault('FIXTURE_STATE_ALREADY_ASSIGNED'); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE records(id TEXT PRIMARY KEY,name TEXT NOT NULL,fee INTEGER NOT NULL,memo TEXT,submitted INTEGER NOT NULL); CREATE TABLE effects(id TEXT PRIMARY KEY,operation TEXT NOT NULL,digest TEXT NOT NULL,response TEXT NOT NULL); CREATE TABLE meta(visits INTEGER NOT NULL);');
  db.exec('BEGIN IMMEDIATE');
  for (const r of baseline.rows) db.prepare('INSERT INTO records VALUES(?,?,?,?,?)').run(r.id, r.name, r.feeCents, r.memo, Number(r.submitted));
  for (const e of baseline.effects) db.prepare('INSERT INTO effects VALUES(?,?,?,?)').run(e.id, e.operation, e.requestDigest, JSON.stringify(e.response));
  db.prepare('INSERT INTO meta VALUES(?)').run(baseline.visits);
  db.exec('COMMIT');
  await durableFile(filePath, baseline.file);
  const identity = randomUUID();
  let active = 0, closed = false;
  const state = async (): Promise<FixtureState> => {
    if (active) fault('FIXTURE_CAPTURE_NOT_QUIESCENT');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const rows = db.prepare('SELECT id,name,fee AS feeCents,memo,submitted FROM records ORDER BY id').all().map((r: any) => ({ ...r, submitted: Boolean(r.submitted) }));
    const effects = db.prepare('SELECT id,operation,digest AS requestDigest,response FROM effects ORDER BY id').all().map((e: any) => ({ ...e, response: JSON.parse(e.response) }));
    return { schema: 'finnor.financing-fixture-state.v1', rows, effects, visits: (db.prepare('SELECT visits FROM meta').get() as any).visits, file: await readFile(filePath, 'utf8') };
  };
  const server = createServer(async (req, res) => {
    active++;
    try {
      if (req.headers['x-fixture-identity'] !== identity && req.url !== '/') { res.writeHead(403); res.end('Fixture identity unavailable'); return; }
      if (req.url === '/' && req.method === 'GET') {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(`<!doctype html><html lang="en"><title>Private financing fixture</title><body><h1>Private financing fixture</h1><p>No production lender authority</p><label for="fee">C_01 fee cents</label><input id="fee" type="number" value="20000"><button id="navigate">Navigate</button><button id="submit">Submit fixture</button><pre id="status"></pre><script>
const identity=${JSON.stringify(identity)};
async function step(operation,values={}){const r=await fetch('/step',{method:'POST',headers:{'content-type':'application/json','x-fixture-identity':identity},body:JSON.stringify({operation,target:'C_01',effectId:crypto.randomUUID(),...values})});document.querySelector('#status').textContent=await r.text()}
document.querySelector('#fee').onchange=()=>step('autosave',{feeCents:Number(document.querySelector('#fee').value)});
document.querySelector('#navigate').onclick=()=>step('navigate');
document.querySelector('#submit').onclick=()=>step('submit');
setTimeout(()=>fetch('/background',{headers:{'x-fixture-identity':identity}}),50);
</script></body></html>`);
        return;
      }
      if (req.url === '/background' && req.method === 'GET') {
        // A GET with an actual branch-local effect is intentional.
        db.prepare('UPDATE meta SET visits=visits+1').run();
        await tryTripwire('background');
        res.end(JSON.stringify({ fixtureOnly: true })); return;
      }
      if (req.url?.startsWith('/effects/') && req.method === 'GET') {
        const id = req.url.slice('/effects/'.length);
        const e = db.prepare('SELECT response FROM effects WHERE id=?').get(id) as any;
        res.writeHead(e ? 200 : 404); res.end(e ? e.response : '{"status":"UNKNOWN"}'); return;
      }
      if (req.url !== '/step' || req.method !== 'POST') { res.writeHead(404); res.end(); return; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const raw of req) { size += raw.length; if (size > 8192) fault('FIXTURE_INPUT_BOUND', 413); chunks.push(Buffer.from(raw)); }
      const s = decode(FinancingStep, JSON.parse(Buffer.concat(chunks).toString())), digest = hash(s);
      const prior = db.prepare('SELECT digest,response FROM effects WHERE id=?').get(s.effectId) as any;
      if (prior) {
        if (prior.digest !== digest) fault('FIXTURE_IDEMPOTENCY_CONFLICT');
        res.end(prior.response); return;
      }
      db.exec('BEGIN IMMEDIATE');
      let response: any;
      try {
        const r = db.prepare('SELECT * FROM records WHERE id=?').get(s.target) as any;
        if (!r) fault('FIXTURE_TARGET_UNAVAILABLE', 404);
        if (s.operation === 'autosave') {
          if (Object.hasOwn(s, 'feeCents')) db.prepare('UPDATE records SET fee=? WHERE id=?').run(s.feeCents!, s.target);
          if (Object.hasOwn(s, 'memo')) db.prepare('UPDATE records SET memo=? WHERE id=?').run(s.memo!, s.target);
        }
        if (s.operation === 'navigate') db.prepare('UPDATE meta SET visits=visits+1').run();
        if (s.operation === 'submit') db.prepare('UPDATE records SET submitted=1 WHERE id=?').run(s.target);
        response = { effectId: s.effectId, target: s.target, operation: s.operation, outcome: 'FIXTURE_COMMITTED_NOT_S6_SETTLEMENT' };
        db.prepare('INSERT INTO effects VALUES(?,?,?,?)').run(s.effectId, s.operation, digest, JSON.stringify(response));
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      // File projection is consistent only after this write; interruption here is
      // visible as an incomplete capture and must not imply a consistent snapshot.
      await durableFile(filePath, `fixture:${s.target}:${s.operation}:${s.effectId}`);
      await tryTripwire(s.operation);
      await options.afterCommit?.(s.effectId);
      res.end(JSON.stringify(response));
    } catch (e) {
      if (!res.destroyed) { res.writeHead(e instanceof Error && 'status' in e ? Number(e.status) : 400); res.end('{"code":"FIXTURE_REQUEST_REFUSED"}'); }
    } finally { active--; }
  });
  await new Promise<void>((ok, no) => { server.once('error', no); server.listen(0, '127.0.0.1', ok); });
  const address = server.address(); if (!address || typeof address === 'string') fault('FIXTURE_PORT_UNAVAILABLE');
  return {
    identity, server, port: address.port, state,
    async close() { if (closed) return; closed = true; server.closeAllConnections(); await new Promise<void>(ok => server.close(() => ok())); db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); },
  };
}
async function durableFile(path: string, content: string) {
  const fd = await open(path, 'w', 0o600);
  try { await fd.writeFile(content); await fd.sync(); } finally { await fd.close(); }
}
async function tryTripwire(operation: string) {
  // Test-only fixed observer configured by the certifier, never caller-supplied.
  const endpoint = process.env.FINNOR_P3_TRIPWIRE;
  if (!endpoint) return;
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)) fault('TRIPWIRE_NON_DISPOSABLE_REFUSED');
  try { await fetch(url.origin + '/lender/' + operation, { method: operation === 'navigate' || operation === 'background' ? 'GET' : 'POST', signal: AbortSignal.timeout(250), redirect: 'error' }); } catch { /* Denial is observed by the independent tripwire, not claimed here. */ }
}
export async function fixtureRequest(app: FixtureApp, path: string, body?: unknown): Promise<any> {
  return new Promise((yes, no) => {
    const request = httpRequest({ hostname: '127.0.0.1', port: app.port, path, method: body === undefined ? 'GET' : 'POST', headers: { 'x-fixture-identity': app.identity, 'content-type': 'application/json' }, timeout: 1000 }, res => {
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (b: Buffer) => { size += b.length; if (size > 8192) { request.destroy(Error('FIXTURE_RESPONSE_BOUND')); return; } chunks.push(b); });
      res.on('end', () => { try { const v = JSON.parse(Buffer.concat(chunks).toString()); res.statusCode === 200 ? yes(v) : no(Error('FIXTURE_REFUSED')); } catch (e) { no(e); } });
    });
    request.on('error', no); request.on('timeout', () => request.destroy(Error('FIXTURE_ACK_UNKNOWN')));
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
export async function runFinancingFixture(baseline: FixtureState, steps: unknown[], directory: string, restored = false) {
  const app = await createFixtureApp(baseline, directory);
  try {
    const observations = [];
    if (!restored) await fixtureRequest(app, '/background');
    for (const value of steps) {
      const step = decode(FinancingStep, value);
      try { observations.push(await fixtureRequest(app, '/step', step)); }
      catch {
        // Observation only: no second mutation after an unknown acknowledgement.
        const readback = await fixtureRequest(app, '/effects/' + step.effectId);
        if (readback.effectId !== step.effectId) fault('FIXTURE_UNKNOWN_OUTCOME');
        observations.push({ ...readback, acknowledgement: 'LOST_READ_BACK_SAME_EFFECT' });
      }
    }
    const state = await app.state();
    return { result: { schema: 'finnor.financing-fixture-result.v1', identity: app.identity, observations, stateDigest: hash(state), qualification: 'REAL_PRIVATE_SQLITE_FIXTURE_NO_LENDER_ACCEPTANCE_NO_OS_ISOLATION_IN_NATIVE_PROFILE' }, state };
  } finally { await app.close(); }
}
