import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

export async function createNativeOwnerDatabase() {
  const directory = await mkdtemp(join(tmpdir(), 'finnor-capability-postgres-'));
  const port = await new Promise((resolve, reject) => {
    const server = createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const address = server.address(); server.close(() => resolve(address.port)); });
  });
  const postgres = new EmbeddedPostgres({ databaseDir: directory, user: 'finnor', password: 'finnor', port, persistent: false, onLog() {} });
  let admin, db;
  try {
    await postgres.initialise(); await postgres.start(); await postgres.createDatabase('finnor');
    const url = `postgres://finnor:finnor@127.0.0.1:${port}/finnor`;
    Object.assign(process.env, { NODE_ENV: 'test', AUTH_DEV_BYPASS: '1', SECRETS_PROVIDER: 'env', FINNOR_TEST_MANAGED_EXTENSIONS: 'omit', LOG_LEVEL: 'silent' });
    const { migrate } = await import('../../packages/db/migrate.ts');
    const migrations = await migrate(url);
    admin = new pg.Client({ connectionString: url }); await admin.connect();
    await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'");
    await admin.query("ALTER ROLE finnor_worker LOGIN PASSWORD 'finnor_worker'");
    const appUrl = `postgres://finnor_app:finnor_app@127.0.0.1:${port}/finnor`;
    const workerUrl = `postgres://finnor_worker:finnor_worker@127.0.0.1:${port}/finnor`;
    process.env.FINNOR_CAPABILITY_WORKER_DATABASE_URL = workerUrl;
    process.env.DATABASE_URL = process.env.FINNOR_CAPABILITY_NATIVE_WORKER_ROLE === '1' ? workerUrl : appUrl;
    db = await import('../../packages/db/index.ts');
    return { admin, db, port, migrations, appUrl, workerUrl, async stop() { await db.closePool(); await admin.end(); await postgres.stop(); } };
  } catch (error) { await db?.closePool().catch(() => undefined); await admin?.end().catch(() => undefined); await postgres.stop().catch(() => undefined); throw error; }
}
