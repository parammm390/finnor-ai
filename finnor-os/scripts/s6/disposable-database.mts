/** Test support: real disposable PostgreSQL; never connects to an external target. */
import { mkdtemp, appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { migrate } from '../../packages/db/migrate';

const evidence = resolve(process.env.FINNOR_S6_EVIDENCE_DIR ?? '../scope-6/scope-evidence/database');
await mkdir(evidence, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'finnor-s6-postgres-'));
const port = await new Promise<number>((accept, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') return reject(Error('No port'));
    server.close(() => accept(address.port));
  });
});
const postgres = new EmbeddedPostgres({ databaseDir: directory, user: 'finnor', password: 'finnor', port, persistent: false, onLog: () => undefined });
process.env.FINNOR_TEST_MANAGED_EXTENSIONS = 'omit';
await postgres.initialise();
await appendFile(join(directory, 'postgresql.conf'), '\ntrack_commit_timestamp=on\n');
await postgres.start();
await postgres.createDatabase('s6_e2e');
const url = `postgres://finnor:finnor@127.0.0.1:${port}/s6_e2e`;
const migrations = await migrate(url);
const admin = new pg.Client({ connectionString: url });
await admin.connect();
await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'");
const roles = (await admin.query("SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN ('finnor','finnor_app') ORDER BY rolname")).rows;
const version = (await admin.query('SELECT version() AS version')).rows[0].version;
await admin.end();
await writeFile(join(evidence, 'database.json'), JSON.stringify({ schema: 'finnor.s6.disposable-database.v1', directory, port, url, roles, version, migrations, node: process.version, qualification: 'Disposable test authority, no production identity or protected isolation', rerun: 'FINNOR_S6_EVIDENCE_DIR=<evidence-dir> node --import=tsx scripts/s6/disposable-database.mts' }, null, 2) + '\n');
console.log(JSON.stringify({ status: 'READY', url, port, evidence }));
await new Promise<void>(done => {
  process.once('SIGTERM', done);
  process.once('SIGINT', done);
});
await postgres.stop();
console.log(JSON.stringify({ status: 'STOPPED', port }));
