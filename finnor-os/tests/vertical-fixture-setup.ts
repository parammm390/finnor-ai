// Integration compatibility fixture for the pre-Phase-5 Water tests.
//
// Phase 5 deliberately removed the production "default Water" tenant trigger:
// a new production tenant must choose a product explicitly.  The older Core
// integration fixtures predate that contract and create generic tenants without
// an assignment, so they would all fail before exercising the behavior under test.
// Install this seam only in the disposable CI/test database. PE certification
// fixtures opt out with `SET app.test_vertical_mode = 'explicit'` and therefore
// continue to prove the missing-assignment boundary.

import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;

if (databaseUrl) {
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    const exists = await client.query<{ exists: boolean }>(
      "SELECT to_regclass('finnor_os.tenant_vertical_assignments') IS NOT NULL AS exists",
    );
    if (exists.rows[0]?.exists) {
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
    }
  } catch {
    // Unit/planner runs can start before the integration schema exists. The
    // actual integration run executes after db:migrate and installs the seam.
  } finally {
    await client.end().catch(() => undefined);
  }
}
