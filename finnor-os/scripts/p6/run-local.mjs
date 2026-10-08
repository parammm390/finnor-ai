import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const [kind, destination, profile] = process.argv.slice(2);
if (!['native', 'transfer'].includes(kind) || !destination?.startsWith('/'))
  throw Error('Usage: node scripts/p6/run-local.mjs native|transfer /absolute/fresh/evidence [induction-crash]');
if(profile && profile!=='induction-crash')throw Error('REGISTERED_P6_DIAGNOSTIC_PROFILE_REQUIRED');
const cwd = resolve(import.meta.dirname, '../..');
await mkdir(destination, { recursive: true });
const command = [process.execPath, '--import=tsx', join(cwd, 'scripts/p6/run-' + kind + '-e2e.mts')];
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
  NODE_ENV: 'test', CI: '1', FINNOR_P4_PROFILE: 'ordinary_disposable',
  FINNOR_P6_EVIDENCE_DIR: destination, FINNOR_TEST_MANAGED_EXTENSIONS: 'omit',
  LOG_LEVEL: 'silent',
  ...(profile ? {FINNOR_P6_CASE_PROFILE:profile} : {}),
};
const startedAt = new Date().toISOString();
const result = spawnSync(command[0], command.slice(1), {
  cwd, env, encoding: 'utf8', timeout: 600000, maxBuffer: 4 * 1024 * 1024,
});
await writeFile(join(destination, 'runner.log'), (result.stdout ?? '') + (result.stderr ?? ''),
  { flag: 'wx', mode: 0o600 });
let report = null;
try { report = JSON.parse(await readFile(join(destination, 'results.json'), 'utf8')); } catch {}
const counts = report && Object.fromEntries(['PASS', 'FAIL', 'UNRUN', 'NOT_RUN'].map(status =>
  [status, report.results.filter(row => row.status === status).length]));
const complete = report?.results.length===16 && counts?.PASS===(profile?4:16)
  && counts?.NOT_RUN===(profile?12:0) && !counts.FAIL && !counts.UNRUN;
const exitCode = result.status === 0 && complete ? 0 : 1;
const receipt = {
  schema: 'finnor.p6.local-driver.v1', command, cwd, startedAt, finishedAt: new Date().toISOString(),
  childExit: result.status, childSignal: result.signal, childError: result.error?.code ?? null,
  counts, exitCode, environmentNames: Object.keys(env),
  selection:profile??'FULL_16_STORIES',completeDeclaredDenominator:complete,
  nodeDigest: createHash('sha256').update(await readFile(process.execPath)).digest('hex'),
  driverDigest: createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'),
  qualification: 'PUBLIC_DISPOSABLE_NATIVE_DEVELOPMENT_NOT_GATE_P6_OR_PROTECTED_ADMISSION',
};
await writeFile(join(destination, 'driver-receipt.json'), JSON.stringify(receipt, null, 2) + '\n',
  { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ destination, ...receipt }));
process.exit(exitCode);
