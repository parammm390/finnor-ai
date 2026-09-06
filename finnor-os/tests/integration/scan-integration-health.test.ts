// A3.T2 acceptance: scan_integration_health updates health/last_check_at/last_error on
// EXISTING tenant_integrations rows only (never invents a row for a capability that's
// still resolving from env/default), agrees with a real open circuit breaker rather
// than an independent stale reading, and reports native/emulator bindings "ok" (no
// external vendor to probe).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { withTenant, closePool, tenants, tenantIntegrations } from "@finnor/db";
import { eq, and } from "drizzle-orm";
import { recordProviderFailure, recordProviderSuccess } from "@finnor/tools";
import { scanIntegrationHealth } from "../../apps/worker/src/handlers/scan-integration-health";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const TENANT = "00000000-0000-4000-8000-0000000000ec";

async function dbUp(): Promise<boolean> {
  const c = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2000 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}
const available = await dbUp();

type Capability = (typeof tenantIntegrations.$inferSelect)["capability"];

async function rowFor(capability: Capability) {
  return withTenant(TENANT, (db) =>
    db
      .select()
      .from(tenantIntegrations)
      .where(and(eq(tenantIntegrations.tenantId, TENANT), eq(tenantIntegrations.capability, capability))),
  ).then((rows) => rows[0]);
}

describe.skipIf(!available)("scan_integration_health (A3.T2)", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    await migrate(DB_URL);
    await withTenant(TENANT, (db) => db.insert(tenants).values({ id: TENANT, name: "Integration Health Test" }).onConflictDoNothing());
    await recordProviderSuccess("vapi", TENANT); // ensure this tenant's breaker is clean before the flapping test below
  });
  afterAll(async () => {
    await withTenant(TENANT, (db) => db.delete(tenantIntegrations).where(eq(tenantIntegrations.tenantId, TENANT)));
    await recordProviderSuccess("vapi", TENANT);
    await closePool();
  });

  it("no-ops for a tenant with zero tenant_integrations rows — never throws", async () => {
    await expect(scanIntegrationHealth({ tenantId: TENANT })).resolves.toBeUndefined();
  });

  it("reports native binding as ok — no external vendor to probe", async () => {
    await withTenant(TENANT, (db) => db.delete(tenantIntegrations).where(and(eq(tenantIntegrations.tenantId, TENANT), eq(tenantIntegrations.capability, "communications"))));
    await withTenant(TENANT, (db) => db.insert(tenantIntegrations).values({ tenantId: TENANT, capability: "communications", binding: "native", mode: "real" }));
    await scanIntegrationHealth({ tenantId: TENANT });
    const row = await rowFor("communications");
    expect(row?.health).toBe("ok");
    expect(row?.lastCheckAt).not.toBeNull();
    expect(row?.lastError).toBeNull();
    await withTenant(TENANT, (db) => db.delete(tenantIntegrations).where(and(eq(tenantIntegrations.tenantId, TENANT), eq(tenantIntegrations.capability, "communications"))));
  });

  it("reports down and the breaker's own reason the instant a circuit is open — never an independent, disagreeing reading", async () => {
    await withTenant(TENANT, (db) =>
      db.insert(tenantIntegrations).values({ tenantId: TENANT, capability: "communications", binding: "vapi", mode: "real" }),
    );
    await recordProviderFailure("vapi", TENANT);
    await recordProviderFailure("vapi", TENANT);
    await recordProviderFailure("vapi", TENANT); // 3 consecutive failures opens this tenant's breaker

    await scanIntegrationHealth({ tenantId: TENANT });
    const row = await rowFor("communications");
    expect(row?.health).toBe("down");
    expect(row?.lastError).toMatch(/circuit breaker open/i);
  });

  it("never creates a row for a capability with no existing tenant_integrations entry", async () => {
    const before = await rowFor("marketing");
    expect(before).toBeUndefined();
    await scanIntegrationHealth({ tenantId: TENANT });
    const after = await rowFor("marketing");
    expect(after).toBeUndefined();
  });
});
