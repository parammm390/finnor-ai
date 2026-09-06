import pg from "pg";

/**
 * Install the pre-Phase-5 Water compatibility seam in a disposable integration
 * database. This function is separate from the Vitest setup wrapper so CI can
 * install it after migrations without evaluating a top-level await file through
 * tsx's CommonJS loader.
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
        DO $fixture$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='finnor') THEN
            ALTER ROLE finnor SET app.test_vertical_mode = 'water';
          END IF;
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='finnor_app') THEN
            ALTER ROLE finnor_app SET app.test_vertical_mode = 'water';
          END IF;
        END $fixture$;

        CREATE OR REPLACE FUNCTION finnor_os.assign_test_water_vertical() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,finnor_os AS $$
        BEGIN
          IF current_setting('app.test_vertical_mode', true) IS DISTINCT FROM 'water' THEN
            RETURN NEW;
          END IF;
          INSERT INTO finnor_os.tenant_vertical_assignments
            (tenant_id,vertical_key,source_system,created_by)
          VALUES (NEW.id,'water','test:legacy-water-compat','system:vitest')
          ON CONFLICT (tenant_id) DO NOTHING;
          RETURN NEW;
        END $$;

        DROP TRIGGER IF EXISTS test_assign_water_vertical ON finnor_os.tenants;
        CREATE TRIGGER test_assign_water_vertical
        AFTER INSERT ON finnor_os.tenants FOR EACH ROW
        EXECUTE FUNCTION finnor_os.assign_test_water_vertical();
      `);
    } finally {
      await client.query("SELECT pg_advisory_unlock(5105105105)");
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}
