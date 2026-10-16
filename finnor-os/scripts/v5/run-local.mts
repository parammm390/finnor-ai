/** Registered real-owner campaigns. No auth bypass or candidate-authored oracle. */
import { strict as assert } from 'node:assert';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, readdir, statfs, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const repo = resolve(import.meta.dirname, '../../..');
const cumulative=process.argv.includes('--cumulative');
const selected = process.argv[process.argv.indexOf('--case') + 1];
if (!selected || !['migration', 'owner', 'mounted', 'recovery', 'rights', 'native', 'native-sibling', 'privacy'].includes(selected)) throw Error('EXACT_REGISTERED_CASE_REQUIRED');
// Disposable campaigns must not inherit cloud/provider secrets or background
// integrations from the interactive shell. Only explicit local runtime paths.
const allowedEnvironment = new Set(['PATH','HOME','TMPDIR','TEMP','TMP','LANG','LC_ALL',
  'FINNOR_V5_EVIDENCE_DIR','FINNOR_V5_DATABASE_PASSWORD','FINNOR_S3_PYTHON','FINNOR_S4_PYTHON','FINNOR_S5_PYTHON',
  'FACTORY_DESKTOP_CDP_PORT','AGENT_BROWSER_CDP','AGENT_BROWSER_SESSION']);
for (const name of Object.keys(process.env)) if (!allowedEnvironment.has(name)) delete process.env[name];
const evidenceRoot = join(repo, 'scope-v/v5-living-investment-firm/evidence');
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const out = process.env.FINNOR_V5_EVIDENCE_DIR ?? await mkdtemp(join(evidenceRoot, 'run-'));
await mkdir(out, { recursive: true, mode: 0o700 });
const profile = JSON.parse(await readFile(join(repo, 'scope-v/v5-living-investment-firm/verification-plan.json'), 'utf8'));
const baseline = JSON.parse(await readFile(join(repo, 'scope-v/v5-living-investment-firm/baseline.json'), 'utf8'));
const free = await statfs(repo);
if (free.bavail * free.bsize < Math.max(profile.limits.minimumFreeDiskBytes,cumulative?3*1024**3:0)) throw Error('REGISTERED_FREE_DISK_FLOOR');
const results: unknown[] = [], started = Date.now();
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const migrationDir = join(repo, 'finnor-os/packages/db/migrations');
const historical: Array<{ name: string; sql: string }> = [];
for (const file of baseline.initialMigrations) {
  const sql = await readFile(join(migrationDir, file.name), 'utf8');
  assert.equal(sha(sql), file.sha256, 'IMMUTABLE_HISTORICAL_MIGRATION_PREIMAGE');
  historical.push({ name: file.name, sql });
}
const files = execFileSync('git', ['-C', repo, '-c', 'core.fsmonitor=false', 'ls-files', '-c', '-o', '--exclude-standard', '-z'], { encoding: 'utf8' })
  .split('\0').filter(name => name && !name.includes('/evidence/') && (
    /^(src|finnor-os|scripts|e2e)\//.test(name) && /\.(ts|tsx|mts|mjs|cjs|js|css|scss|py|m|sql|json|ya?ml|md)$/.test(name)
    || /^(package(-lock)?\.json|tsconfig.*\.json|.*\.config\.(ts|mjs)|AGENTS\.md)$/.test(name))).sort();
const source = await Promise.all(files.map(async name => ({ name, sha256: sha(await readFile(join(repo, name))) })));
const runtime = await Promise.all(['next', 'react', 'typescript', 'pg', 'tsx', 'embedded-postgres'].map(async name => {
  const packagePath = join(repo, 'finnor-os/node_modules', name, 'package.json');
  const bytes = await readFile(packagePath); const meta = JSON.parse(bytes.toString());
  return { name, version: meta.version, packageSha256: sha(bytes) };
}));
const python = process.env.FINNOR_S3_PYTHON;
const scientificRuntime = python ? JSON.parse(execFileSync(python, ['-I','-c',
  "import json,sys,numpy,scipy,statsmodels; print(json.dumps({'executable':sys.executable,'version':sys.version,'numpy':numpy.__version__,'scipy':scipy.__version__,'statsmodels':statsmodels.__version__}))"],
  { encoding: 'utf8', env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1', OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1' } })) : null;
await writeFile(join(out, 'freeze.json'), JSON.stringify({ selected, cumulative, node: process.version, base: baseline.B_live,
  source, sourceManifestDigest: sha(JSON.stringify(source)), runtime, scientificRuntime,
  schemaDigest: sha(await readFile(join(repo, 'finnor-os/packages/db/schema.ts'))),
  reconstruction: { rerun: `cd ${repo}/finnor-os && node --import=tsx scripts/v5/run-local.mts --case ${selected}`,
    sourceOverlay: 'Exact candidate hashes retained here; final handoff supplies preimage-bound patches, not a clean-source claim' },
  planDigest: sha(JSON.stringify(profile)), migrations: await Promise.all((await readdir(migrationDir)).filter(f => f.endsWith('.sql')).sort()
    .map(async name => ({ name, sha256: sha(await readFile(join(migrationDir, name))) }))),
  failureModelDigest: sha(await readFile(join(repo, 'scope-v/v5-living-investment-firm/failure-model.md'))),
  qualification: 'SYNTHETIC_LOCAL_ENGINEERING_NOT_PROTECTED_ADMISSION_OR_FIELD_GAIN',
  plannedBoundaries: ['ACTUAL_MIGRATE', 'REAL_RESTRICTED_DATABASE_LOGINS', 'AUTHENTICATED_OWNER_HTTP', 'PRODUCTION_REGISTERED_QUEUE'],
  independentOracle: 'ADMINISTERED_ORIGINAL_INPUTS_AND_POSTGRES_NUMERIC_OWNER_READBACK' }, null, 2), { flag: 'wx', mode: 0o600 });
async function save() {
  await writeFile(join(out, 'results.json'), JSON.stringify({ results, elapsedMs: Date.now() - started,
    selected, B_R: 'UNESTABLISHED', fieldStudy: 'BLOCKED_EXTERNAL', qualification: 'LOCAL_DEVELOPMENT_ONLY' }, null, 2), { mode: 0o600 });
}
async function story(id: string, run: () => Promise<unknown>) {
  const start = Date.now();
  try { results.push({ id, status: 'PASS', observed: await run(), elapsedMs: Date.now() - start }); }
  catch (error) { results.push({ id, status: 'FAIL', predicate: (error as Error).message, elapsedMs: Date.now() - start }); process.exitCode = 1; }
  await save();
}
const directory = await mkdtemp(join(tmpdir(), 'v5-owned-postgres-'));
const port = await new Promise<number>((yes, no) => {
  const server = createServer(); server.once('error', no);
  server.listen(0, '127.0.0.1', () => { const address = server.address();
    if (!address || typeof address === 'string') return no(Error('OWNED_LOOPBACK_PORT_REQUIRED'));
    server.close(() => yes(address.port)); });
});
const databasePassword = process.env.FINNOR_V5_DATABASE_PASSWORD || randomBytes(32).toString('hex');
const postgres = new EmbeddedPostgres({ databaseDir: directory, user: 'finnor', password: databasePassword,
  port, persistent: true, onLog: () => undefined });
let admin: pg.Client | undefined;
let initialized = false;
try {
  process.env.NODE_ENV = 'test'; process.env.FINNOR_TEST_MANAGED_EXTENSIONS = 'omit';
  process.env.AUTH_DEV_BYPASS = '0'; process.env.LOG_LEVEL = 'silent';
  await postgres.initialise();
  await appendFile(join(directory, 'postgresql.conf'), '\ntrack_commit_timestamp=on\n');
  await postgres.start(); initialized = true; await postgres.createDatabase('v5_development');
  const adminUrl = `postgres://finnor:${encodeURIComponent(databasePassword)}@127.0.0.1:${port}/v5_development`;
  admin = new pg.Client({ connectionString: adminUrl }); await admin.connect();
  const { migrate } = await import('../../packages/db/migrate');
  await story(cumulative?'M-exact-main-to-v1-v5-cumulative-migration':'M-exact-main-to-v5-migration', async () => {
    const initial = await migrate(adminUrl, historical);
    assert.equal(initial.length, 173);
    const prefix = (await admin!.query('SELECT name FROM finnor_os._migrations ORDER BY name')).rows;
    assert.equal(prefix.length, 173);
    const applied = await migrate(adminUrl), restart = await migrate(adminUrl);
    assert.deepEqual(applied,cumulative?[
      '0172_v2_primary_diligence.sql','0173_v2_primary_privacy.sql','0173_v3_autonomous_transaction_closure.sql',
      '0174_v2_primary_profile_custody.sql','0175_v4_autonomous_capital_formation.sql',
      '0176_v5_live_institutional_control.sql','0177_v1_bilateral_opportunities.sql',
      '0178_closing_evidence_custody_composition.sql','0179_closing_primary_profile_custody.sql',
    ]:['0176_v5_live_institutional_control.sql']); assert.deepEqual(restart, []);
    const tables = (await admin!.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='finnor_os'
      AND (c.relname LIKE 'v5_%' OR c.relname IN('auth_delivery_sessions','employee_actor_profiles')) AND c.relkind='r'
      ORDER BY c.relname`)).rows;
    assert(tables.length >= 14); assert(tables.every(t => t.relrowsecurity && t.relforcerowsecurity));
    const lineage = (await admin!.query('SELECT name FROM finnor_os._migrations ORDER BY name')).rows;
    return { initialCount: initial.length, applied, restart, tables, exactLineage: lineage.map(r => r.name),
      database: (await admin!.query('SELECT version() version,current_setting(\'track_commit_timestamp\') commitClock')).rows[0],
      peerCollision: cumulative?'SERIAL_CUMULATIVE_SCHEMA_UPGRADE_OBSERVED_NOT_PHASE_ARTIFACT_QUALIFICATION':'V2_V3_0173_SERIAL_RECONCILIATION_STILL_UNESTABLISHED' };
  });
  if (!process.exitCode && selected !== 'migration') {
    const { runOwners } = await import('./owner-campaign.mts');
    await runOwners({ repo, out, directory, port, admin, adminUrl, selected, story });
  }
} catch (error) {
  results.push({ id: 'campaign-runtime', status: 'FAIL', predicate: (error as Error).message, stack: (error as Error).stack });
  process.exitCode = 1; await save();
} finally {
  await admin?.end().catch(() => undefined);
  if (initialized) await postgres.stop().catch(() => undefined);
  await save();
}
const finalCode = results.some(row => (row as { status: string }).status === 'FAIL') ? 1 : 0;
console.log(JSON.stringify({ evidenceDirectory: out, selected, failed: finalCode !== 0, elapsedMs: Date.now() - started,
  ownedTemporaryDatabaseRetainedForReconstruction: directory }));
// All owned resources are stopped above. Embedded dependency exit hooks must not
// overwrite the authoritative status of retained failure rows during idle exit.
process.exit(finalCode);
