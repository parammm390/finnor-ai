/** Re-executes unchanged existing owner tests, using a new disposable cluster. */
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), cwd = join(root, 'finnor-os');
if (process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_URL_NON_POOLING) throw Error('AMBIENT_DATABASE_REFUSED');
const output = join(root, 'scope-pm/phase-03-p3-branch-fabric/scope-evidence/regression-' + new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(output);
const directory = await mkdtemp(join(tmpdir(), 'finnor-p3-owner-regression-')), sha = bytes => createHash('sha256').update(bytes).digest('hex');
const port = await new Promise((ok, no) => {
  const server = createServer(); server.once('error', no);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => ok(port)); });
});
const database = 'finnor_scope3_cert_' + sha(directory).slice(0, 16);
const cluster = new EmbeddedPostgres({ databaseDir: directory, user: 'finnor', password: 'finnor', port, persistent: false, onLog: () => {} });
const names = [
  'defers physical capacity contention without burning the logical attempt',
  'globally fences configured provider permits and recovers a crashed holder after expiry',
  'isolates a saturated provider from another configured provider',
  'aborts a provider invocation when owned permit renewal loses its fence',
  'reserves model capacity for foreground and enforces per-tenant limits',
];
const args = ['node_modules/vitest/vitest.mjs', 'run', 'tests/integration/scope3-compute-plane.test.ts', '--testNamePattern', names.join('|'),
  '--reporter=default', '--reporter=json', '--outputFile=' + join(output, 'vitest-results.json')];
const sourcePaths = ['packages/db/compute-contract.ts', 'packages/db/compute-control.ts', 'packages/db/compute-governor.ts',
  'packages/db/production-target-guard.ts', 'apps/worker/src/queue.ts', 'tests/integration/scope3-compute-plane.test.ts', 'package-lock.json'];
const sourceManifest = await Promise.all(sourcePaths.map(async path => ({ path: 'finnor-os/' + path, sha256: sha(await readFile(join(cwd, path))) })));
const env = {};
for (const key of ['PATH', 'TMPDIR', 'USER', 'LOGNAME']) if (process.env[key]) env[key] = process.env[key];
Object.assign(env, { TMPDIR: '/tmp', NODE_ENV: 'test', CI: '1', LOG_LEVEL: 'silent', FINNOR_TEST_MANAGED_EXTENSIONS: 'omit',
  FINNOR_SCOPE3_CERTIFICATION: '1', FINNOR_SCOPE3_DISPOSABLE_DB: '1', DATABASE_URL: `postgres://finnor:finnor@127.0.0.1:${port}/${database}` });
let started = false, exitCode = null, setupError = null, log = '', databaseVersion = null;
const began = new Date().toISOString();
try {
  await cluster.initialise(); await cluster.start(); started = true;
  const admin = new pg.Client({ connectionString: `postgres://finnor:finnor@127.0.0.1:${port}/postgres` });
  await admin.connect();
  try { databaseVersion = (await admin.query('SELECT version() AS version')).rows[0].version; await admin.query('CREATE DATABASE ' + database); }
  finally { await admin.end(); }
  exitCode = await new Promise((ok, no) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes; process.stdout.write(bytes); });
    child.once('error', no); child.once('exit', code => ok(code));
  });
} catch (e) { setupError = e instanceof Error ? e.message : String(e); }
finally {
  if (started) await cluster.stop();
  await writeFile(join(output, 'stdout.log'), log, { flag: 'wx' });
  const sourceChanged = [];
  for (const pin of sourceManifest) if (sha(await readFile(join(root, pin.path))) !== pin.sha256) sourceChanged.push(pin.path);
  const report = { schema: 'finnor.p3.owner-regression.v1', began, finished: new Date().toISOString(), cwd, node: process.version,
    sourceManifest, sourceChanged, command: [process.execPath, ...args], environmentNames: Object.keys(env), databaseVersion,
    exitCode, setupError, selectedTests: names, expectedPasses: 5, expectedFilterExcluded: 17,
    qualification: 'FIVE_UNCHANGED_SCOPE3_QUEUE_CAPACITY_FENCING_TESTS_LOCAL_CALLBACKS_NOT_P3_CONFINEMENT_OR_PROVIDER_DISPATCH',
    rerun: 'env -u DATABASE_URL -u POSTGRES_URL -u POSTGRES_URL_NON_POOLING node finnor-os/scripts/p3/regression.mjs' };
  await writeFile(join(output, 'run-manifest.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  const files = [];
  for (const name of await readdir(output)) { const bytes = await readFile(join(output, name)); files.push({ path: name, sha256: sha(bytes), bytes: bytes.length }); }
  await writeFile(join(output, 'evidence-manifest.json'), JSON.stringify({ schema: 'finnor.p3.evidence-manifest.v1', files }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output, exitCode, setupError, sourceChanged }));
  process.exitCode = exitCode === 0 && !sourceChanged.length ? 0 : 1;
}
