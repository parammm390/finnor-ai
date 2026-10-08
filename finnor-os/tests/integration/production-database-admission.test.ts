import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { expect, it } from "vitest";
import {
  assertProductionDatabaseTarget,
  verifyRestrictedApplicationRole,
} from "../../packages/db/production-database-admission.mjs";

const target = {
  host: "aws-1-ap-northeast-1.pooler.supabase.com",
  supabaseUrl: "https://kpxrnonhnhexutvdywbh.supabase.co",
  schema: "finnor_os",
};

it("rejects a different project on the same pooler and admits only exact owner/app targets", () => {
  const url = (role: string, project: string, port = 5432, database = "postgres") =>
    `postgresql://${role}.${project}:fixture@${target.host}:${port}/${database}`;
  expect(assertProductionDatabaseTarget(url("postgres", "kpxrnonhnhexutvdywbh"), target, "owner"))
    .toMatchObject({ projectRef: "kpxrnonhnhexutvdywbh", role: "postgres" });
  expect(assertProductionDatabaseTarget(url("finnor_app", "kpxrnonhnhexutvdywbh"), target, "application"))
    .toMatchObject({ projectRef: "kpxrnonhnhexutvdywbh", role: "finnor_app" });
  for (const invalid of [
    url("postgres", "anotherproject"),
    url("finnor_app", "kpxrnonhnhexutvdywbh"),
    url("postgres", "kpxrnonhnhexutvdywbh", 6543),
    url("postgres", "kpxrnonhnhexutvdywbh", 5432, "other"),
  ]) expect(() => assertProductionDatabaseTarget(invalid, target, "owner")).toThrow("Canonical production database target required");
  expect(() => assertProductionDatabaseTarget(url("postgres", "kpxrnonhnhexutvdywbh"), target, "application"))
    .toThrow("Canonical production database target required");
});

it("proves the effective non-owner role and tenant RLS using a real disposable PostgreSQL session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "finnor-production-role-"));
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); reject(Error("No fixture port")); return; }
      server.close(() => resolve(address.port));
    });
  });
  const postgres = new EmbeddedPostgres({ databaseDir: directory, user: "finnor", password: "fixture", port, persistent: false });
  let owner: pg.Client | undefined;
  let application: pg.Client | undefined;
  try {
    await postgres.initialise();
    await postgres.start();
    await postgres.createDatabase("finnor");
    owner = new pg.Client({ host: "127.0.0.1", port, user: "finnor", password: "fixture", database: "finnor" });
    await owner.connect();
    await owner.query(`CREATE ROLE finnor_app LOGIN PASSWORD 'fixture' NOSUPERUSER NOBYPASSRLS;
      CREATE SCHEMA finnor_os;
      CREATE TABLE finnor_os.admission_fixture (tenant_id uuid NOT NULL, id uuid);
      ALTER TABLE finnor_os.admission_fixture ENABLE ROW LEVEL SECURITY;
      ALTER TABLE finnor_os.admission_fixture FORCE ROW LEVEL SECURITY;`);
    application = new pg.Client({ host: "127.0.0.1", port, user: "finnor_app", password: "fixture", database: "finnor" });
    await application.connect();
    const accepted = await verifyRestrictedApplicationRole(application, target);
    expect(accepted).toMatchObject({ role: "finnor_app", superuser: false, bypassRls: false, tenantTables: 1 });
    await expect(verifyRestrictedApplicationRole(owner, target)).rejects.toThrow("Restricted application database role required");
    await owner.query("ALTER TABLE finnor_os.admission_fixture DISABLE ROW LEVEL SECURITY");
    await expect(verifyRestrictedApplicationRole(application, target)).rejects.toThrow("Tenant RLS posture required");
    await owner.query("ALTER TABLE finnor_os.admission_fixture ENABLE ROW LEVEL SECURITY; ALTER ROLE finnor_app BYPASSRLS");
    await expect(verifyRestrictedApplicationRole(application, target)).rejects.toThrow("Restricted application database role required");
    const evidence = process.env.FINNOR_PRODUCTION_PREFLIGHT_EVIDENCE_DIR ?? await mkdtemp(join(tmpdir(), "finnor-role-proof-"));
    await mkdir(evidence, { recursive: true });
    await writeFile(join(evidence, "restricted-role-admission.json"), JSON.stringify({
      schema: "finnor.production-role-admission-proof.v1",
      inputs: { fixture: "isolated PostgreSQL", target, tenantTables: 1 },
      steps: ["Create owner and restricted login", "Enable and force tenant RLS", "Observe effective login", "Reject owner, disabled RLS and BYPASSRLS"],
      observed: { accepted, rejected: ["owner", "disabled_rls", "bypass_rls"] },
      rerun: "npm --prefix finnor-os test -- --run tests/integration/production-database-admission.test.ts",
      providerDeploymentProof: false,
    }, null, 2) + "\n");
  } finally {
    await application?.end();
    await owner?.end();
    await postgres.stop().catch(() => undefined);
  }
}, 60_000);
