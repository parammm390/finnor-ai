// Minimal idempotent local seed for the only active product vertical.

import pg from "pg";
import { fileURLToPath } from "node:url";
import { pgConnectionConfig } from "./index";

export const SEED_TENANT_ID = "00000000-0000-4000-8000-000000000001";
export const SEED_OWNER_EMAIL = "owner@private-equity.finnor.local";

export async function seed(databaseUrl = process.env.DATABASE_URL): Promise<void> {
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const client = new pg.Client(pgConnectionConfig(databaseUrl));
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL search_path = finnor_os, public");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [SEED_TENANT_ID]);
    // The canonical development seed owns its explicit product assignment. This
    // also keeps disposable Core fixture triggers from classifying the seed as a
    // generic non-product tenant when a test invokes seed after Vitest setup.
    await client.query("SELECT set_config('app.test_vertical_mode', 'explicit', true)");
    await client.query(
      `INSERT INTO tenants (id,name) VALUES ($1,'Private Equity Development Project')
       ON CONFLICT (id) DO NOTHING`,
      [SEED_TENANT_ID],
    );
    await client.query(
      `INSERT INTO tenant_vertical_assignments
         (tenant_id,vertical_key,version,effective_from,source_system,created_by)
       VALUES ($1,'private_equity',1,now(),'seed:private-equity','system:seed')
       ON CONFLICT (tenant_id) DO NOTHING`,
      [SEED_TENANT_ID],
    );
    const assignment = await client.query<{ vertical_key: string }>(
      "SELECT vertical_key FROM tenant_vertical_assignments WHERE tenant_id=$1",
      [SEED_TENANT_ID],
    );
    if (assignment.rows[0]?.vertical_key !== "private_equity") {
      throw new Error("Seed refused to relabel an existing historical tenant as Private Equity");
    }
    await client.query(
      `INSERT INTO users (tenant_id,email,role,status,display_name)
       VALUES ($1,$2,'owner','active','Development Owner')
       ON CONFLICT (email) DO UPDATE SET status='active',role='owner'`,
      [SEED_TENANT_ID, SEED_OWNER_EMAIL],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  seed()
    .then(() => console.log("Seeded Private Equity development project", SEED_TENANT_ID))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
