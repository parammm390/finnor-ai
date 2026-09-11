import pg from "pg";

/**
 * Install the post-retirement Core compatibility seam in a disposable integration
 * database. Historical generic fixtures predate explicit vertical selection; they
 * now belong to `none`, never the retired Water runtime. This function is separate
 * from the Vitest setup wrapper so CI can install it after migrations without
 * evaluating a top-level await file through tsx's CommonJS loader.
 */
export async function installVerticalFixtureSeam(databaseUrl = process.env.DATABASE_URL): Promise<void> {
  if (!databaseUrl) return;
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    const exists = await client.query<{ exists: boolean }>(
      "SELECT to_regclass('finnor_os.tenant_vertical_assignments') IS NOT NULL AS exists",
    );
    if (!exists.rows[0]?.exists) return;

    await client.query("SELECT pg_advisory_lock(5105105105)");
    try {
      await client.query(`
        DROP TRIGGER IF EXISTS test_assign_water_vertical ON finnor_os.tenants;
        DROP FUNCTION IF EXISTS finnor_os.assign_test_water_vertical();

        CREATE OR REPLACE FUNCTION finnor_os.assign_test_core_vertical() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
        BEGIN
          -- P6 certification and PE fixtures explicitly own their vertical. Every
          -- other tenant created in this disposable test database is a generic
          -- Core fixture and receives the non-product none boundary. Keeping
          -- this decision local to the database avoids ALTER ROLE leaking into
          -- unrelated developer/test databases.
          IF current_setting('app.test_vertical_mode', true) = 'explicit' THEN
            RETURN NEW;
          END IF;
          INSERT INTO finnor_os.tenant_vertical_assignments
            (tenant_id,vertical_key,source_system,created_by)
          VALUES (NEW.id,'none','test:core-compat','system:vitest')
          ON CONFLICT (tenant_id) DO NOTHING;
          RETURN NEW;
        END $$;

        DROP TRIGGER IF EXISTS test_assign_core_vertical ON finnor_os.tenants;
        CREATE TRIGGER test_assign_core_vertical
        AFTER INSERT ON finnor_os.tenants FOR EACH ROW
        EXECUTE FUNCTION finnor_os.assign_test_core_vertical();
      `);
    } finally {
      await client.query("SELECT pg_advisory_unlock(5105105105)");
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}
