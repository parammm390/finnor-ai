import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import type pg from 'pg';

/** Read-only oracle for the isolated, synthetic compatibility fixture. */
export async function fingerprintFixture(client: pg.Client) {
  const identity = (await client.query(`SELECT current_database() name,
    host(inet_server_addr()) address, inet_server_addr()::text originalAddressCast,
    current_user principal`)).rows[0];
  assert.equal(identity.name, 'v5_development');
  assert(['127.0.0.1', '::1'].includes(identity.address), 'Owned loopback fixture only');
  const names = (await client.query<{ name: string }>(`SELECT c.relname name
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='finnor_os' AND c.relkind IN ('r','p')
    AND c.relname<>'_migrations' ORDER BY c.relname`)).rows;
  let bytes = 0;
  const tables = [];
  for (const { name } of names) {
    assert(/^[a-z_][a-z0-9_]*$/.test(name));
    const rows = (await client.query<{ payload: string }>(
      `SELECT to_jsonb(subject)::text payload FROM finnor_os."${name}" subject LIMIT 100001`)).rows;
    assert(rows.length <= 100000, 'Finite compatibility table bound');
    const payloads = rows.map(row => row.payload).sort();
    const hash = createHash('sha256');
    for (const payload of payloads) {
      bytes += Buffer.byteLength(payload);
      assert(bytes <= 64 * 1024 * 1024, 'Finite compatibility oracle byte bound');
      hash.update(payload).update('\n');
    }
    tables.push({ name, rows: rows.length, sha256: hash.digest('hex') });
  }
  return {
    schema: 'finnor.v.compatibility-row-fingerprint.v1',
    database: identity.name, loopbackAddress: identity.address, originalAddressCast: identity.originaladdresscast,
    tables, tableCount: tables.length, canonicalRowBytes: bytes,
    sha256: createHash('sha256').update(JSON.stringify(tables)).digest('hex'),
    excludedTables: ['_migrations'],
    privateRowContentsPublished: false,
  };
}
